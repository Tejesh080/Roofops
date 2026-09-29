-- =============================================================================
-- Phase 6: state integrity.
--   1. State machines as data (state_machine_states / state_transitions), enforced by triggers, so an illegal
--      transition is refused even if application code is bypassed.
--   2. A machine-readable ownership contract for every Airtable field (field_contract).
--   3. One validated entry point for every Airtable edit (wf_airtable_change): identity by RoofOps ID / record link,
--      idempotent per event, stale-event and compare-and-set conflict detection, legal-transition validation,
--      canonical update + audit, and the exact Airtable corrections needed so Airtable shows canonical truth.
--   4. Reconciliation (Airtable / Drive / Xero ↔ Postgres) that replays missed edits through the same validation,
--      repairs drift on RoofOps-owned fields and raises actionable exceptions for everything ambiguous.
--   5. Health recording, drift/freshness read models and integrity_check().
-- Found by the audit: PRJ-2026-0001 was set to Cancelled in Airtable but stayed COMPLETED here, because no webhook
-- watched Projects.Status (and Quote statuses other than Accepted were silently ignored too).
-- =============================================================================

insert into error_classes (code, retryable, description) values
  ('ILLEGAL_TRANSITION', false, 'The requested status change is not allowed from the current status'),
  ('STALE_EVENT',        false, 'An older change arrived after a newer one was applied; ignored'),
  ('UNAUTHORIZED_EDIT',  false, 'A field owned by RoofOps was edited in another system; reverted'),
  ('EXTERNAL_MISSING',   false, 'An external object RoofOps relies on no longer exists'),
  ('DRIFT',              false, 'External state differs from canonical state')
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- 1. State machines
-- -----------------------------------------------------------------------------
create table state_machine_states (
  machine     text not null,
  state       text not null,
  label       text not null,          -- how Airtable / the UI names it
  is_terminal boolean not null default false,
  primary key (machine, state)
);
create table state_transitions (
  machine    text not null,
  from_state text not null,
  to_state   text not null,
  guard      text,                     -- extra condition, enforced by <machine>_transition_guard()
  note       text,
  primary key (machine, from_state, to_state),
  foreign key (machine, from_state) references state_machine_states (machine, state),
  foreign key (machine, to_state) references state_machine_states (machine, state),
  check (from_state <> to_state)
);

insert into state_machine_states (machine, state, label, is_terminal) values
  ('project','PLANNING','Planning',false), ('project','MATERIALS_PENDING','Materials Pending',false), ('project','SCHEDULED','Scheduled',false),
  ('project','IN_PROGRESS','In Progress',false), ('project','ON_HOLD','On Hold',false), ('project','COMPLETED','Completed',false),
  ('project','CLOSED','Closed',true), ('project','CANCELLED','Cancelled',true),
  ('quote','DRAFT','Draft',false), ('quote','SENT','Sent',false), ('quote','ACCEPTED','Accepted',true), ('quote','LOST','Lost',true), ('quote','EXPIRED','Expired',true),
  ('purchase_order','DRAFT','Draft',false), ('purchase_order','PENDING_APPROVAL','Pending Approval',false), ('purchase_order','APPROVED','Approved',false),
  ('purchase_order','SENT','Sent',false), ('purchase_order','ACKNOWLEDGED','Acknowledged',false), ('purchase_order','PARTIALLY_DELIVERED','Partially Delivered',false),
  ('purchase_order','DELIVERED','Delivered',true), ('purchase_order','CANCELLED','Cancelled',true),
  ('invoice','DRAFT','Draft',false), ('invoice','PENDING_APPROVAL','Pending approval',false), ('invoice','APPROVED','Approved',false), ('invoice','ISSUED','Issued',false),
  ('invoice','PARTIALLY_PAID','Partially paid',false), ('invoice','PAID','Paid',true), ('invoice','VOIDED','Voided',true),
  ('invoice_sync','NOT_SYNCED','Not synced',false), ('invoice_sync','PENDING','Pending',false), ('invoice_sync','SYNCED','Synced',false),
  ('invoice_sync','UNKNOWN','Unknown',false), ('invoice_sync','FAILED','Failed',false),
  ('approval','PENDING','Pending',false), ('approval','APPROVED','Approved',false), ('approval','EXECUTING','Executing',false),
  ('approval','EXECUTED','Executed',true), ('approval','EXECUTION_FAILED','Execution failed',false), ('approval','REJECTED','Rejected',true),
  ('approval','EXPIRED','Expired',true), ('approval','CANCELLED','Cancelled',true),
  ('workflow_exception','OPEN','Needs attention',false), ('workflow_exception','RETRY_QUEUED','Retry in progress',false),
  ('workflow_exception','RESOLVED','Resolved',true), ('workflow_exception','IGNORED','Dismissed',true),
  ('task','OPEN','To do',false), ('task','IN_PROGRESS','In progress',false), ('task','DONE','Done',true), ('task','CANCELLED','Cancelled',true),
  ('checklist_item','OPEN','To do',false), ('checklist_item','DONE','Done',false), ('checklist_item','WAIVED','Waived',false), ('checklist_item','NOT_APPLICABLE','Not needed',false),
  ('outbox','PENDING','Pending',false), ('outbox','DISPATCHING','Dispatching',false), ('outbox','DONE','Done',true), ('outbox','FAILED','Failed / waiting to retry',false);

insert into state_transitions (machine, from_state, to_state, guard, note) values
  -- Projects: forward through the job, sideways into On Hold, cancellation until a final invoice exists.
  ('project','PLANNING','MATERIALS_PENDING',null,null), ('project','PLANNING','SCHEDULED',null,null), ('project','PLANNING','ON_HOLD',null,'needs a reason (default supplied)'),
  ('project','PLANNING','CANCELLED',null,'needs a reason (default supplied)'),
  ('project','MATERIALS_PENDING','PLANNING',null,null), ('project','MATERIALS_PENDING','SCHEDULED',null,null), ('project','MATERIALS_PENDING','ON_HOLD',null,null),
  ('project','MATERIALS_PENDING','CANCELLED',null,null),
  ('project','SCHEDULED','PLANNING',null,'re-plan'), ('project','SCHEDULED','MATERIALS_PENDING',null,null),
  ('project','SCHEDULED','IN_PROGRESS','needs_planned_start','sets Actual Start = business date if blank'),
  ('project','SCHEDULED','ON_HOLD',null,null), ('project','SCHEDULED','CANCELLED',null,null),
  ('project','IN_PROGRESS','COMPLETED',null,'sets Actual Completion = business date if blank'), ('project','IN_PROGRESS','ON_HOLD',null,null),
  ('project','IN_PROGRESS','CANCELLED',null,'mid-job termination; historical invoices are kept'),
  ('project','ON_HOLD','PLANNING',null,null), ('project','ON_HOLD','MATERIALS_PENDING',null,null), ('project','ON_HOLD','SCHEDULED',null,null),
  ('project','ON_HOLD','IN_PROGRESS','resume_started_job','only for a job that had already started'), ('project','ON_HOLD','CANCELLED',null,null),
  ('project','COMPLETED','CLOSED','nothing_left_to_bill','only when every invoice is paid and the final invoice has been raised'),
  ('project','COMPLETED','CANCELLED','no_final_invoice','only while no final invoice exists; pending previews are withdrawn'),
  -- Quotes: acceptance goes through the Quote → Project workflow.
  ('quote','DRAFT','SENT',null,'sets Sent On = business date if blank'), ('quote','SENT','ACCEPTED',null,'Quote Accepted → Project workflow only'),
  ('quote','SENT','LOST',null,'needs a lost reason (default supplied)'), ('quote','SENT','EXPIRED',null,null),
  -- Purchase orders: forward only; cancellation until delivered.
  ('purchase_order','DRAFT','PENDING_APPROVAL',null,null), ('purchase_order','DRAFT','APPROVED','approver_required',null),
  ('purchase_order','DRAFT','CANCELLED',null,null),
  ('purchase_order','PENDING_APPROVAL','APPROVED','approver_required',null), ('purchase_order','PENDING_APPROVAL','DRAFT',null,'sent back for changes'),
  ('purchase_order','PENDING_APPROVAL','CANCELLED',null,null),
  ('purchase_order','APPROVED','SENT',null,'sets Sent timestamp'), ('purchase_order','APPROVED','CANCELLED',null,null),
  ('purchase_order','SENT','ACKNOWLEDGED',null,'supplier confirmed; sets Acknowledged timestamp'), ('purchase_order','SENT','PARTIALLY_DELIVERED',null,null),
  ('purchase_order','SENT','DELIVERED',null,null), ('purchase_order','SENT','CANCELLED',null,null),
  ('purchase_order','ACKNOWLEDGED','PARTIALLY_DELIVERED',null,null), ('purchase_order','ACKNOWLEDGED','DELIVERED',null,null),
  ('purchase_order','ACKNOWLEDGED','CANCELLED',null,null),
  ('purchase_order','PARTIALLY_DELIVERED','DELIVERED',null,null),
  -- Invoices (business state).
  ('invoice','DRAFT','PENDING_APPROVAL',null,null), ('invoice','DRAFT','APPROVED',null,null), ('invoice','DRAFT','VOIDED',null,null),
  ('invoice','PENDING_APPROVAL','APPROVED',null,null), ('invoice','PENDING_APPROVAL','DRAFT',null,null), ('invoice','PENDING_APPROVAL','VOIDED',null,null),
  ('invoice','APPROVED','ISSUED',null,null), ('invoice','APPROVED','VOIDED',null,null),
  ('invoice','ISSUED','PARTIALLY_PAID',null,null), ('invoice','ISSUED','PAID',null,null), ('invoice','ISSUED','VOIDED',null,null),
  ('invoice','PARTIALLY_PAID','PAID',null,null),
  -- Invoice accounting sync (UNKNOWN = ambiguous write; reconcile before retry).
  ('invoice_sync','NOT_SYNCED','PENDING',null,null), ('invoice_sync','PENDING','SYNCED',null,'only with read-back proof'),
  ('invoice_sync','PENDING','UNKNOWN',null,null), ('invoice_sync','PENDING','FAILED',null,null),
  ('invoice_sync','UNKNOWN','SYNCED',null,'only with read-back proof'), ('invoice_sync','UNKNOWN','PENDING',null,null), ('invoice_sync','UNKNOWN','FAILED',null,null),
  ('invoice_sync','FAILED','PENDING',null,'operator re-queue'), ('invoice_sync','SYNCED','UNKNOWN',null,'reconciliation found the Xero object changed or missing'),
  -- Approvals.
  ('approval','PENDING','APPROVED',null,null), ('approval','PENDING','EXECUTING',null,'approved and queued'), ('approval','PENDING','REJECTED',null,null),
  ('approval','PENDING','EXPIRED',null,null), ('approval','PENDING','CANCELLED',null,'stale preview, project cancelled, or demo reset'),
  ('approval','APPROVED','EXECUTING',null,null), ('approval','APPROVED','CANCELLED',null,null),
  ('approval','EXECUTING','EXECUTED',null,'only with read-back proof'), ('approval','EXECUTING','EXECUTION_FAILED',null,null),
  ('approval','EXECUTION_FAILED','EXECUTING',null,'operator retry'),
  -- Workflow exceptions.
  ('workflow_exception','OPEN','RETRY_QUEUED',null,null), ('workflow_exception','OPEN','RESOLVED',null,null), ('workflow_exception','OPEN','IGNORED',null,null),
  ('workflow_exception','RETRY_QUEUED','OPEN',null,'retry failed again'), ('workflow_exception','RETRY_QUEUED','RESOLVED',null,null),
  ('workflow_exception','RETRY_QUEUED','IGNORED',null,null),
  -- Tasks and checklist.
  ('task','OPEN','IN_PROGRESS',null,null), ('task','OPEN','DONE',null,null), ('task','OPEN','CANCELLED',null,null),
  ('task','IN_PROGRESS','OPEN',null,null), ('task','IN_PROGRESS','DONE',null,null), ('task','IN_PROGRESS','CANCELLED',null,null),
  ('checklist_item','OPEN','DONE',null,null), ('checklist_item','OPEN','WAIVED',null,null), ('checklist_item','OPEN','NOT_APPLICABLE',null,null),
  ('checklist_item','DONE','OPEN',null,'undo'), ('checklist_item','WAIVED','OPEN',null,'undo'), ('checklist_item','NOT_APPLICABLE','OPEN',null,'undo'),
  -- Outbox (side effects): claim, complete with proof, fail with backoff or dead-letter, operator re-queue.
  ('outbox','PENDING','DISPATCHING',null,null), ('outbox','DISPATCHING','DONE',null,'only with read-back proof'),
  ('outbox','DISPATCHING','FAILED',null,null), ('outbox','DISPATCHING','PENDING',null,null),
  ('outbox','FAILED','DISPATCHING',null,'retry after backoff'), ('outbox','FAILED','PENDING',null,'operator re-queue');

create or replace function state_transition_allowed(p_machine text, p_from text, p_to text)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select p_from is not distinct from p_to
      or exists (select 1 from state_transitions where machine = p_machine and from_state = p_from and to_state = p_to)
$$;

create or replace function sm_label(p_machine text, p_state text)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select label from state_machine_states where machine = p_machine and state = p_state), p_state)
$$;

create or replace function sm_state(p_machine text, p_label text)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select state from state_machine_states where machine = p_machine and (lower(label) = lower(btrim(p_label)) or state = upper(btrim(p_label)))
$$;

-- Extra conditions on some project transitions. Returns null when allowed, else a reason a person can act on.
create or replace function project_transition_guard(p projects, p_to text)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_final text; v_prev jsonb;
begin
  if p_to = 'IN_PROGRESS' and p.status = 'SCHEDULED' and p.planned_start_date is null then
    return 'set a Planned Start before marking the job In Progress';
  end if;
  if p_to = 'IN_PROGRESS' and p.status = 'ON_HOLD' and p.actual_start_date is null then
    return 'this job never started; move it back to Scheduled instead of In Progress';
  end if;
  if p.status = 'COMPLETED' and p_to = 'CANCELLED' then
    select string_agg(invoice_number, ', ') into v_final from invoices where project_id = p.id and invoice_type = 'FINAL' and status <> 'VOIDED';
    if v_final is not null then
      return format('a final invoice (%s) already exists; void it first, then cancel', v_final);
    end if;
    if exists (select 1 from approvals where entity_id = p.id and action_type = 'CREATE_INVOICE' and status in ('EXECUTING', 'APPROVED')) then
      return 'a final invoice is being created in Xero right now; wait for it to finish';
    end if;
  end if;
  if p.status = 'COMPLETED' and p_to = 'CLOSED' then
    select string_agg(invoice_number || ' (' || lower(status) || ')', ', ' order by invoice_number) into v_final
      from invoices where project_id = p.id and status not in ('PAID', 'VOIDED');
    if v_final is not null then return format('not every invoice is paid yet: %s', v_final); end if;
    if not exists (select 1 from invoices where project_id = p.id and invoice_type = 'FINAL' and status <> 'VOIDED') then
      v_prev := invoice_final_preview(p.id);
      if coalesce(v_prev ->> 'error_class', '') <> 'ARITHMETIC_MISMATCH' then return 'the final invoice has not been raised yet'; end if;
    end if;
  end if;
  return null;
end $$;

-- One trigger function for every machine. TG_ARGV[0] = machine, TG_ARGV[1] = column.
create or replace function enforce_state_machine()
returns trigger language plpgsql as $$
declare v_from text := to_jsonb(old) ->> tg_argv[1]; v_to text := to_jsonb(new) ->> tg_argv[1]; v_reason text;
begin
  if v_from is distinct from v_to then
    if not state_transition_allowed(tg_argv[0], v_from, v_to) then
      raise exception 'state machine check failed: illegal % transition % -> %', tg_argv[0], v_from, v_to using errcode = 'check_violation';
    end if;
    if tg_argv[0] = 'project' then
      v_reason := project_transition_guard(old, v_to);
      if v_reason is not null then
        raise exception 'state machine check failed: project % -> % refused: %', v_from, v_to, v_reason using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end $$;

create trigger projects_state_machine before update of status on projects for each row execute function enforce_state_machine('project', 'status');
create trigger quotes_state_machine before update of status on quotes for each row execute function enforce_state_machine('quote', 'status');
create trigger purchase_orders_state_machine before update of status on purchase_orders for each row execute function enforce_state_machine('purchase_order', 'status');
create trigger invoices_state_machine before update of status on invoices for each row execute function enforce_state_machine('invoice', 'status');
create trigger invoices_sync_state_machine before update of sync_status on invoices for each row execute function enforce_state_machine('invoice_sync', 'sync_status');
create trigger approvals_state_machine before update of status on approvals for each row execute function enforce_state_machine('approval', 'status');
create trigger workflow_exceptions_state_machine before update of resolution_status on workflow_exceptions
  for each row execute function enforce_state_machine('workflow_exception', 'resolution_status');
create trigger tasks_state_machine before update of status on tasks for each row execute function enforce_state_machine('task', 'status');
create trigger checklist_state_machine before update of status on project_checklist_items for each row execute function enforce_state_machine('checklist_item', 'status');
create trigger outbox_state_machine before update of status on outbox for each row execute function enforce_state_machine('outbox', 'status');

-- -----------------------------------------------------------------------------
-- 2. Ownership contract (drives change capture and reconciliation; exported to docs/source-of-truth.*)
-- -----------------------------------------------------------------------------
create table field_contract (
  entity            text not null,
  field_key         text not null,
  airtable_table_id text,
  airtable_field_id text unique,
  airtable_name     text,
  canonical         text not null,          -- where the truth lives
  owner             text not null check (owner in ('POSTGRES','AIRTABLE_EDIT','INPUT','ACTION','WORKFLOW','DRIVE','XERO')),
  editable_in       text not null,
  change_path       text not null,
  validation        text not null,
  event_generated   text,
  downstream        text,
  readback          text,
  reconcile         text not null check (reconcile in ('APPLY_VIA_HANDLER','REPAIR_AIRTABLE','PROJECTION','VERIFY_EXTERNAL','IGNORE')),
  ai_visible        boolean not null default true,
  primary key (entity, field_key)
);

insert into field_contract (entity, field_key, airtable_table_id, airtable_field_id, airtable_name, canonical, owner, editable_in, change_path, validation, event_generated, downstream, readback, reconcile, ai_visible) values
  -- Projects
  ('project','project_number','tblvUPIoebC3zoacv','fldhhnQXlbuFaveK3','Project Number','projects.project_number','POSTGRES','none','created by wf_quote_accepted','unique PRJ-YYYY-NNNN','project.created','Airtable, Drive folder name, Xero reference','03 read-back','REPAIR_AIRTABLE',true),
  ('project','quote_link','tblvUPIoebC3zoacv','fld08eKCeuDCsJLjz','Quote','projects.quote_id','POSTGRES','none','created by wf_quote_accepted','one project per quote','project.created','Airtable','03 read-back','REPAIR_AIRTABLE',true),
  ('project','customer_link','tblvUPIoebC3zoacv','fldG4mPoV6sUkA9rM','Customer','projects.customer_id','POSTGRES','none','created by wf_quote_accepted','must equal the quote customer','project.created','Airtable','03 read-back','REPAIR_AIRTABLE',true),
  ('project','status','tblvUPIoebC3zoacv','fldi2Qwz1dAh2tcTE','Status','projects.status','AIRTABLE_EDIT','Airtable Projects.Status','Airtable webhook → n8n 06 → wf_airtable_change → project transition','state_transitions(project) + project_transition_guard','project.status.changed','dashboard, Copilot, invoice eligibility, risk views, tasks/approvals on cancel','06 PATCH + read-back; reconciliation','APPLY_VIA_HANDLER',true),
  ('project','project_manager','tblvUPIoebC3zoacv','fldnZcRBxG7hTebD5','Project Manager','projects.project_manager_id','AIRTABLE_EDIT','Airtable Projects.Project Manager','06 → wf_airtable_change','must be an active PROJECT_MANAGER by full name','project.project_manager.changed','dashboard, Copilot','06 read-back; reconciliation','APPLY_VIA_HANDLER',true),
  ('project','planned_start_date','tblvUPIoebC3zoacv','fld8rf6RZLgfs6Ron','Planned Start','projects.planned_start_date','AIRTABLE_EDIT','Airtable Projects.Planned Start','06 → wf_airtable_change','date; ≤ Planned Completion; locked once Completed/Closed/Cancelled','project.planned_start_date.changed','risk views, dashboard, Copilot','06 read-back; reconciliation','APPLY_VIA_HANDLER',true),
  ('project','planned_completion_date','tblvUPIoebC3zoacv','fldvZtiassZEgLMAN','Planned Completion','projects.planned_completion_date','AIRTABLE_EDIT','Airtable Projects.Planned Completion','06 → wf_airtable_change','date; ≥ Planned Start; locked once Completed/Closed/Cancelled','project.planned_completion_date.changed','risk views, dashboard, Copilot','06 read-back; reconciliation','APPLY_VIA_HANDLER',true),
  ('project','actual_start_date','tblvUPIoebC3zoacv','fldIje5e0a72cBfVD','Actual Start','projects.actual_start_date','POSTGRES','none (set by Status → In Progress)','derived by the project transition','required from In Progress onwards','project.status.changed','dashboard, Copilot','06 correction; reconciliation','REPAIR_AIRTABLE',true),
  ('project','actual_completion_date','tblvUPIoebC3zoacv','fldWKRobTLlOjeN9j','Actual Completion','projects.actual_completion_date','POSTGRES','none (set by Status → Completed)','derived by the project transition','required for Completed/Closed','project.status.changed','invoice eligibility, dashboard','06 correction; reconciliation','REPAIR_AIRTABLE',true),
  ('project','status_reason','tblvUPIoebC3zoacv','fld5MhzMBtA4CBUHo','Status Reason','projects.on_hold_reason / cancellation_reason','INPUT','Airtable (read with a Status change)','read by wf_airtable_change with Status','free text','(part of project.status.changed)','audit','n/a','IGNORE',true),
  ('project','material_review_task','tblvUPIoebC3zoacv','fld93YzhrpOVIviRY','Material Review Task','tasks (MATERIAL_REVIEW)','WORKFLOW','none','written by 03 at project creation','n/a','task.create','Airtable only','03 read-back','IGNORE',true),
  ('project','drive_folder','tblvUPIoebC3zoacv','fldgVDT29UOOOtlqO','Drive Folder','external_links GOOGLE_DRIVE Folder (verified)','DRIVE','none','02 creates, 03 writes after read-back','must equal the verified folder URL','drive.project_folder.verified','dashboard, Copilot','03 read-back; reconciliation (Drive + Airtable)','REPAIR_AIRTABLE',true),
  ('project','roofops_id','tblvUPIoebC3zoacv','fldc4T0AgU3zCmANC','RoofOps ID','projects.id','POSTGRES','none','03 write-back','uuid; integration identity','—','all integrations','03 read-back; reconciliation','REPAIR_AIRTABLE',false),
  ('project','invoice_action','tblvUPIoebC3zoacv','fldYnINTdtOckOzK4','Invoice Action','approvals / invoices (via 04)','ACTION','Airtable Projects.Invoice Action','webhook → n8n 04 → wf_invoice_prepare / wf_invoice_decide','mapped approver for Approve','invoice.prepare_requested / invoice.approved','approvals, invoices, Xero','04 clears + read-back','IGNORE',true),
  ('project','invoice_status','tblvUPIoebC3zoacv','fldPuGgo27oWLKB5R','Invoice Status','approvals + invoices (derived)','WORKFLOW','none','written by 04; repaired by reconciliation when canonical state is stable','projection of canonical invoice state','—','Airtable only','04 read-back; reconciliation','PROJECTION',true),
  ('project','invoice_preview','tblvUPIoebC3zoacv','fldt9KIOPXh3c3pGU','Invoice Preview','approvals.action_payload','WORKFLOW','none','written by 04','text','—','Airtable only','04 read-back','IGNORE',true),
  ('project','invoice_amount','tblvUPIoebC3zoacv','fld5JDnWI3RFehQxA','Invoice Amount (inc GST)','invoices.total_inc_gst / preview amount','WORKFLOW','none','written by 04','projection','—','Airtable only','04 read-back; reconciliation','PROJECTION',true),
  ('project','xero_invoice_number','tblvUPIoebC3zoacv','fldgkN0Vm6k1MZLJp','Xero Invoice Number','outbox payload xero_invoice_number (verified)','XERO','none','04 after 05 read-back','must equal the verified Xero number','xero.invoice.draft_created','dashboard, Copilot','04 read-back; reconciliation','PROJECTION',true),
  ('project','xero_invoice_id','tblvUPIoebC3zoacv','fld3sDI9LIX8Voo4u','Xero Invoice ID','external_links XERO Invoice (verified)','XERO','none','04 after 05 read-back','must equal the verified InvoiceID','xero.invoice.draft_created','dashboard, Copilot','04 read-back; reconciliation (Xero + Airtable)','PROJECTION',true),
  ('project','roofops_sync','tblvUPIoebC3zoacv','fldVrJOuyhbNtxnVh','RoofOps Sync','—','WORKFLOW','none','written by 06/07','text','—','Airtable only','—','IGNORE',false),
  ('project','purchase_orders_link','tblvUPIoebC3zoacv','fldjou7MbzHsu2Xb8','Purchase Orders','purchase_orders.project_id','POSTGRES','none','inverse link','n/a','—','Airtable only','—','IGNORE',true),
  -- Quotes
  ('quote','quote_number','tblzenPRNVV5O7lZP','fldyP20HNafS614d5','Quote Number','quotes.quote_number','POSTGRES','none','import','unique','—','Airtable','import read-back','REPAIR_AIRTABLE',true),
  ('quote','customer_link','tblzenPRNVV5O7lZP','fld4LsEu8c9EMFj0h','Customer','quotes.customer_id','POSTGRES','none','import','—','—','Airtable','—','REPAIR_AIRTABLE',true),
  ('quote','property_link','tblzenPRNVV5O7lZP','fldisUv1ckHz2Detv','Property','quotes.property_id','POSTGRES','none','import','—','—','Airtable','—','REPAIR_AIRTABLE',true),
  ('quote','status','tblzenPRNVV5O7lZP','fldQpTa5tvrzlNg1h','Status','quotes.status','AIRTABLE_EDIT','Airtable Quotes.Status','Accepted: webhook → n8n 01 → wf_quote_accepted. Sent/Lost/Expired: webhook → n8n 06 → wf_airtable_change','state_transitions(quote)','quote.accepted / quote.status.changed','projects, Drive, dashboard, Copilot','01/06 read-back; reconciliation','APPLY_VIA_HANDLER',true),
  ('quote','version','tblzenPRNVV5O7lZP','fldEjEqlzE8Y0M1nf','Version','quote_versions (latest)','POSTGRES','none','import','—','—','acceptance','—','REPAIR_AIRTABLE',true),
  ('quote','amount','tblzenPRNVV5O7lZP','fldbfUE8DVh1Dwjfs','Amount (inc GST)','quote_versions.total_inc_gst (latest)','POSTGRES','none','import (derived from lines)','derived total','—','invoicing','—','REPAIR_AIRTABLE',true),
  ('quote','job_type','tblzenPRNVV5O7lZP','fldOaXGsOgYHuWFYg','Job Type','quotes.job_type','POSTGRES','none','import','enum','—','dashboard','—','REPAIR_AIRTABLE',true),
  ('quote','roof_type','tblzenPRNVV5O7lZP','fldhY6d0ikMnsc7D3','Roof Type','inspections.roof_type','POSTGRES','none','import','enum','—','—','—','REPAIR_AIRTABLE',true),
  ('quote','roof_area','tblzenPRNVV5O7lZP','fldLjvBaV1EFB5RMG','Roof Area (m2)','inspections.roof_area_sqm','POSTGRES','none','import','number','—','—','—','REPAIR_AIRTABLE',true),
  ('quote','estimator','tblzenPRNVV5O7lZP','fld5Bz9FDhJSPibPk','Estimator','quotes.estimator_id','POSTGRES','none','import','employee','—','—','—','REPAIR_AIRTABLE',true),
  ('quote','lead_source','tblzenPRNVV5O7lZP','flduF4QFGUWbkuR2d','Lead Source','quotes.lead_source','POSTGRES','none','import','enum','—','conversion KPIs','—','REPAIR_AIRTABLE',true),
  ('quote','created_on','tblzenPRNVV5O7lZP','fldHSFkvwuVLfAS7J','Created On','quotes.created_on','POSTGRES','none','import','date','—','—','—','REPAIR_AIRTABLE',true),
  ('quote','sent_on','tblzenPRNVV5O7lZP','fldMnoHiondm5jBWv','Sent On','quotes.sent_on','POSTGRES','none (set by Status → Sent)','derived by the quote transition','date','quote.status.changed','—','06 correction','REPAIR_AIRTABLE',true),
  ('quote','accepted_on','tblzenPRNVV5O7lZP','fldfhsHggkGd8GKVq','Accepted On','quotes.accepted_on','POSTGRES','none (set by acceptance)','wf_quote_accepted','date','quote.accepted','projects','01 read-back','REPAIR_AIRTABLE',true),
  ('quote','lost_reason','tblzenPRNVV5O7lZP','fld1sZibwdMVnI4Hd','Lost Reason','quotes.lost_reason','AIRTABLE_EDIT','Airtable Quotes.Lost Reason','06 → wf_airtable_change','required while Lost','quote.lost_reason.changed','conversion KPIs','06 read-back','APPLY_VIA_HANDLER',true),
  ('quote','automation_status','tblzenPRNVV5O7lZP','fldVc9vw112vrP33n','Automation Status','processed_events / outbox (01)','WORKFLOW','none','written by 01','—','—','Airtable only','01 read-back','IGNORE',true),
  ('quote','automation_message','tblzenPRNVV5O7lZP','fldC70PHs4gQh8M42','Automation Message','—','WORKFLOW','none','written by 01','—','—','Airtable only','01 read-back','IGNORE',false),
  ('quote','roofops_id','tblzenPRNVV5O7lZP','fldVUpqZkVKid3Fyy','RoofOps ID','quotes.id','POSTGRES','none','import','uuid','—','01 identity cross-check','—','REPAIR_AIRTABLE',false),
  ('quote','roofops_sync','tblzenPRNVV5O7lZP','fldKjdNBqdBYBdlUo','RoofOps Sync','—','WORKFLOW','none','06/07','text','—','Airtable only','—','IGNORE',false),
  ('quote','projects_link','tblzenPRNVV5O7lZP','flduJm0iR7pBb157b','Projects','projects.quote_id','POSTGRES','none','inverse link (03)','—','—','Airtable only','03 read-back','IGNORE',true),
  -- Purchase orders
  ('purchase_order','po_number','tbluIbl4zpMiAlMVw','fld1yW7kd8vY975Tj','PO Number','purchase_orders.po_number','POSTGRES','none','import','unique','—','Airtable','—','REPAIR_AIRTABLE',true),
  ('purchase_order','project_link','tbluIbl4zpMiAlMVw','fldDVMu2hgtSVuJyR','Project','purchase_orders.project_id','POSTGRES','none','import','—','—','materials views','—','REPAIR_AIRTABLE',true),
  ('purchase_order','supplier_link','tbluIbl4zpMiAlMVw','fldnYTAgdcNXWUMfP','Supplier','purchase_orders.supplier_id','POSTGRES','none','import','—','—','materials views','—','REPAIR_AIRTABLE',true),
  ('purchase_order','status','tbluIbl4zpMiAlMVw','fldMtDddp1Rm4tDHf','Status','purchase_orders.status','AIRTABLE_EDIT','Airtable Purchase Orders.Status','06 → wf_airtable_change','state_transitions(purchase_order); approver for Approved','purchase_order.status.changed','materials status, risk views, dashboard, Copilot','06 read-back; reconciliation','APPLY_VIA_HANDLER',true),
  ('purchase_order','po_date','tbluIbl4zpMiAlMVw','fldqNNcA85jAC9FxM','PO Date','purchase_orders.po_date','POSTGRES','none','import','date','—','ack SLA','—','REPAIR_AIRTABLE',true),
  ('purchase_order','expected_delivery_date','tbluIbl4zpMiAlMVw','fldqkJourPRGAcJya','Expected Delivery','purchase_orders.expected_delivery_date','AIRTABLE_EDIT','Airtable Purchase Orders.Expected Delivery','06 → wf_airtable_change','date ≥ PO Date; locked once Delivered/Cancelled','purchase_order.expected_delivery_date.changed','risk views (materials after start), dashboard, Copilot','06 read-back; reconciliation','APPLY_VIA_HANDLER',true),
  ('purchase_order','subtotal','tbluIbl4zpMiAlMVw','fld8Muyf7XVB91CjK','Subtotal (ex GST)','purchase_orders.subtotal_ex_gst (derived from lines)','POSTGRES','none','derived','derived total','—','open PO value','—','REPAIR_AIRTABLE',true),
  ('purchase_order','supplier_reference','tbluIbl4zpMiAlMVw','fldJ4Z5Rg5adnEFU0','Supplier Reference','purchase_orders.supplier_reference','AIRTABLE_EDIT','Airtable Purchase Orders.Supplier Reference','06 → wf_airtable_change','free text','purchase_order.supplier_reference.changed','dashboard','06 read-back','APPLY_VIA_HANDLER',true),
  ('purchase_order','roofops_id','tbluIbl4zpMiAlMVw','fldnzaXx4TTTjCakj','RoofOps ID','purchase_orders.id','POSTGRES','none','import','uuid','—','identity','—','REPAIR_AIRTABLE',false),
  ('purchase_order','roofops_sync','tbluIbl4zpMiAlMVw','fldfgSKUm3YNm6Bdw','RoofOps Sync','—','WORKFLOW','none','06/07','text','—','Airtable only','—','IGNORE',false),
  -- Customers (reference data owned by RoofOps)
  ('customer','customer_number','tblHKX79FJFHn5FDc','fldzmWSHtLVZ4OTmZ','Customer ID','customers.customer_number','POSTGRES','none','import','unique','—','Xero contact number','—','REPAIR_AIRTABLE',true),
  ('customer','name','tblHKX79FJFHn5FDc','fldI46VewtlNRnwui','Name','customers.display_name','POSTGRES','none (managed in RoofOps)','import','—','—','Xero contact name, dashboard','—','REPAIR_AIRTABLE',true),
  ('customer','email','tblHKX79FJFHn5FDc','fldNcSkEiFnb8m4XP','Email','customers.email','POSTGRES','none (managed in RoofOps)','import','email','—','Xero contact','—','REPAIR_AIRTABLE',false),
  ('customer','phone','tblHKX79FJFHn5FDc','fldvBKPgd3UeIDYO4','Phone','customers.phone','POSTGRES','none (managed in RoofOps)','import','phone','—','—','—','REPAIR_AIRTABLE',false),
  ('customer','type','tblHKX79FJFHn5FDc','fldisVgB2WysksjwW','Type','customers.customer_type','POSTGRES','none','import','enum','—','dashboard','—','REPAIR_AIRTABLE',true),
  ('customer','preferred_contact','tblHKX79FJFHn5FDc','fldfNc5n8m2kjiRcB','Preferred Contact','customers.preferred_contact','POSTGRES','none','import','enum','—','—','—','REPAIR_AIRTABLE',false),
  ('customer','customer_since','tblHKX79FJFHn5FDc','fldNu4bbDXjMbwmZ8','Customer Since','customers.customer_since','POSTGRES','none','import','date','—','—','—','REPAIR_AIRTABLE',false),
  ('customer','possible_duplicate_of','tblHKX79FJFHn5FDc','fldPXNXPyYie2kKQk','Possible Duplicate Of','customer_match_candidates','POSTGRES','none','import','—','—','—','—','REPAIR_AIRTABLE',false),
  ('customer','roofops_id','tblHKX79FJFHn5FDc','fldDClu1e0ffwnojn','RoofOps ID','customers.id','POSTGRES','none','import','uuid','—','identity','—','REPAIR_AIRTABLE',false),
  ('customer','roofops_sync','tblHKX79FJFHn5FDc','fldKBpfr56GEp2OPn','RoofOps Sync','—','WORKFLOW','none','06/07','text','—','—','—','IGNORE',false),
  ('customer','links','tblHKX79FJFHn5FDc','fldKPwUjWtW2jpEEF','Properties','customer_properties','POSTGRES','none','inverse link','—','—','—','—','IGNORE',false),
  ('customer','quotes_link','tblHKX79FJFHn5FDc','fld2qjfGtxTzqx7X2','Quotes','quotes.customer_id','POSTGRES','none','inverse link','—','—','—','—','IGNORE',false),
  ('customer','projects_link','tblHKX79FJFHn5FDc','fld9OhWgBX2HK5mVn','Projects','projects.customer_id','POSTGRES','none','inverse link','—','—','—','—','IGNORE',false),
  -- Properties
  ('property','property_number','tblSYcCqId9wTMg3c','fldIy8ab7Ky67jL31','Property ID','properties.property_number','POSTGRES','none','import','unique','—','—','—','REPAIR_AIRTABLE',true),
  ('property','address','tblSYcCqId9wTMg3c','fldu0CsGG5uPOVbRN','Address','properties.address_line1','POSTGRES','none (managed in RoofOps)','import','—','—','Drive folder name, dashboard','—','REPAIR_AIRTABLE',true),
  ('property','suburb','tblSYcCqId9wTMg3c','fldl6gKbKuZSF9MJG','Suburb','properties.suburb','POSTGRES','none','import','—','—','dashboard','—','REPAIR_AIRTABLE',true),
  ('property','state','tblSYcCqId9wTMg3c','fldYjfr3STs04XDZr','State','properties.state','POSTGRES','none','import','AU state','—','—','—','REPAIR_AIRTABLE',false),
  ('property','postcode','tblSYcCqId9wTMg3c','flduw5J4VyRoOqEE2','Postcode','properties.postcode','POSTGRES','none','import','4 digits','—','—','—','REPAIR_AIRTABLE',false),
  ('property','property_type','tblSYcCqId9wTMg3c','fldMH8wYXmkAYXCxe','Property Type','properties.property_type','POSTGRES','none','import','enum','—','—','—','REPAIR_AIRTABLE',false),
  ('property','storeys','tblSYcCqId9wTMg3c','fldhsHUPCZ0pMbXeV','Storeys','properties.storeys','POSTGRES','none','import','number','—','—','—','REPAIR_AIRTABLE',false),
  ('property','access_notes','tblSYcCqId9wTMg3c','fldP4PWGxdLZrA5ge','Access Notes','properties.access_notes','POSTGRES','none','import','—','—','—','—','REPAIR_AIRTABLE',false),
  ('property','owner_link','tblSYcCqId9wTMg3c','fldVpX0MOcA8TnGvo','Owner','customer_properties (OWNER)','POSTGRES','none','import','—','—','—','—','REPAIR_AIRTABLE',false),
  ('property','roofops_id','tblSYcCqId9wTMg3c','fldm6rtleyV6yp8ZS','RoofOps ID','properties.id','POSTGRES','none','import','uuid','—','identity','—','REPAIR_AIRTABLE',false),
  ('property','roofops_sync','tblSYcCqId9wTMg3c','fldvs2ikhz50FBZ0q','RoofOps Sync','—','WORKFLOW','none','06/07','text','—','—','—','IGNORE',false),
  ('property','quotes_link','tblSYcCqId9wTMg3c','fldexEliwlr8ZWmS6','Quotes','quotes.property_id','POSTGRES','none','inverse link','—','—','—','—','IGNORE',false),
  -- Suppliers
  ('supplier','supplier_code','tbloPJwCIcdIZQFVK','fldNy5hhua9oCbrge','Supplier ID','suppliers.supplier_code','POSTGRES','none','import','unique','—','—','—','REPAIR_AIRTABLE',true),
  ('supplier','name','tbloPJwCIcdIZQFVK','fldmyVulHN1hsCE8f','Name','suppliers.name','POSTGRES','none (managed in RoofOps)','import','—','—','dashboard','—','REPAIR_AIRTABLE',true),
  ('supplier','orders_email','tbloPJwCIcdIZQFVK','fldPtnT9heTBGTFEM','Orders Email','suppliers.orders_email','POSTGRES','none (managed in RoofOps)','import','email','—','—','—','REPAIR_AIRTABLE',false),
  ('supplier','phone','tbloPJwCIcdIZQFVK','fldtNq7DluPgIM1rn','Phone','suppliers.phone','POSTGRES','none','import','phone','—','—','—','REPAIR_AIRTABLE',false),
  ('supplier','lead_time','tbloPJwCIcdIZQFVK','fldfXKzmQJYzbzgZY','Default Lead Time (days)','suppliers.default_lead_time_days','POSTGRES','none','import','integer','—','—','—','REPAIR_AIRTABLE',false),
  ('supplier','roofops_id','tbloPJwCIcdIZQFVK','fldLNYP5FsVaR6TFk','RoofOps ID','suppliers.id','POSTGRES','none','import','uuid','—','identity','—','REPAIR_AIRTABLE',false),
  ('supplier','roofops_sync','tbloPJwCIcdIZQFVK','fld7lrS3OGHjeLnBQ','RoofOps Sync','—','WORKFLOW','none','06/07','text','—','—','—','IGNORE',false),
  ('supplier','purchase_orders_link','tbloPJwCIcdIZQFVK','fld16s1GpFxE0jNcj','Purchase Orders','purchase_orders.supplier_id','POSTGRES','none','inverse link','—','—','—','—','IGNORE',false),
  -- Canonical-only facts (no Airtable field): owners, paths and reconciliation, for the contract's completeness.
  ('task','material_review',null,null,null,'tasks (MATERIAL_REVIEW)','POSTGRES','none (no staff UI; NOT SUPPORTED)','created by wf_quote_accepted','state_transitions(task)','task.create','dashboard, Copilot','—','IGNORE',true),
  ('checklist','items',null,null,null,'project_checklist_items','POSTGRES','none (no staff UI; NOT SUPPORTED)','created by wf_quote_accepted','state_transitions(checklist_item)','—','invoice eligibility (completion docs), dashboard','—','IGNORE',true),
  ('invoice','status',null,null,null,'invoices.status','POSTGRES','none','wf_invoice_decide (FINAL); import','state_transitions(invoice)','invoice.created','dashboard, Copilot, Airtable projection','—','IGNORE',true),
  ('invoice','sync_status',null,null,null,'invoices.sync_status','POSTGRES','none','05 via wf_complete/fail_side_effect','state_transitions(invoice_sync); SYNCED only with proof','xero.invoice.draft_created','dashboard, Copilot','Xero read-back','VERIFY_EXTERNAL',true),
  ('approval','status',null,null,null,'approvals.status','POSTGRES','Airtable Invoice Action (04) / dashboard prepare','wf_invoice_prepare / wf_invoice_decide','state_transitions(approval); mapped approver; current hash','approval.approve','invoices, Xero','—','IGNORE',true),
  ('xero','contact',null,null,null,'external_links XERO Contact (verified)','XERO','none','05 find/create + read-back','ContactNumber RO-CUST-NNNN','xero.invoice.draft_created','—','Xero read-back; reconciliation','VERIFY_EXTERNAL',false),
  ('xero','invoice',null,null,null,'external_links XERO Invoice (verified)','XERO','Xero (by the accountant after the draft exists)','05 create DRAFT + read-back','pinned DEMO tenant, DRAFT, exact totals','xero.invoice.draft_created','dashboard, Copilot','Xero read-back; reconciliation','VERIFY_EXTERNAL',true),
  ('drive','project_folder',null,null,null,'external_links GOOGLE_DRIVE Folder (verified)','DRIVE','Google Drive (files inside only)','02 create + read-back','parent = RoofOps root, 5 subfolders','drive.project_folder.verified','Airtable Drive Folder, dashboard','Drive read-back; reconciliation','VERIFY_EXTERNAL',true),
  ('workflow_exception','resolution_status',null,null,null,'workflow_exceptions.resolution_status','POSTGRES','ops SQL (re-queue) / automatic resolve','wf_* functions','state_transitions(workflow_exception)','exception.*','dashboard, Copilot','—','IGNORE',true),
  ('automation','status',null,null,null,'automation_events / outbox / workflow_runs','POSTGRES','none','n8n + wf_* functions','state_transitions(outbox)','automation.*','System Health, dashboard, Copilot','—','IGNORE',true);


-- -----------------------------------------------------------------------------
-- 3. Change capture: bookkeeping tables
-- -----------------------------------------------------------------------------
-- Last applied external change per field: out-of-order / delayed events older than this are STALE.
create table external_field_versions (
  entity_type    text not null,
  entity_id      uuid not null,
  field_key      text not null,
  last_source    text not null,
  last_source_at timestamptz not null,
  last_event_key text not null,
  last_value     text,
  applied_at     timestamptz not null default now(),
  primary key (entity_type, entity_id, field_key)
);

-- Last value RoofOps observed in Airtable per checked field (webhooks and reconciliation), for drift display.
create table airtable_observations (
  table_id    text not null,
  record_id   text not null,
  field_id    text not null,
  value       text,
  observed_at timestamptz not null,
  source      text not null,
  primary key (table_id, record_id, field_id)
);

create table reconciliation_runs (
  id          uuid primary key default gen_random_uuid(),
  run_key     text not null unique,
  trigger     text not null check (trigger in ('schedule','manual','test')),
  mode        text not null check (mode in ('observe','repair')),
  status      text not null default 'RUNNING' check (status in ('RUNNING','COMPLETED','FAILED')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  summary     jsonb not null default '{}'::jsonb
);

create table reconciliation_findings (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references reconciliation_runs(id),
  system         text not null check (system in ('AIRTABLE','DRIVE','XERO','WEBHOOK')),
  entity_type    text,
  entity_ref     text,
  external_id    text,
  field          text,
  expected       text,
  actual         text,
  classification text not null check (classification in ('SAFE_AUTO_REPAIR','REQUIRES_HUMAN','EXTERNAL_MISSING','STALE_EVENT','UNAUTHORIZED_STATE','UNKNOWN')),
  action         text not null check (action in ('APPLIED_TO_POSTGRES','REJECTED_AND_REPAIRED','REPAIRED_AIRTABLE','EXCEPTION_OPENED','NONE_OBSERVE_ONLY','NONE')),
  detail         text,
  created_at     timestamptz not null default now()
);
create index reconciliation_findings_run_idx on reconciliation_findings (run_id);

create table integration_health (
  id          bigserial primary key,
  service     text not null check (service in ('postgres','airtable','airtable_webhooks','n8n','google_drive','xero','deepseek')),
  ok          boolean not null,
  latency_ms  integer,
  detail      jsonb not null default '{}'::jsonb,
  checked_at  timestamptz not null default now()
);
create index integration_health_service_idx on integration_health (service, checked_at desc);

-- -----------------------------------------------------------------------------
-- 4. Airtable value normalisation and the expected (canonical) Airtable view
-- -----------------------------------------------------------------------------
-- Compare Airtable cells regardless of representation: select objects vs names, numbers vs strings, link order.
create or replace function at_norm(v jsonb)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case
    when v is null or v = 'null'::jsonb then null
    when jsonb_typeof(v) = 'string' then nullif(btrim(v #>> '{}'), '')
    when jsonb_typeof(v) = 'number' then trim_scale((v #>> '{}')::numeric)::text
    when jsonb_typeof(v) = 'boolean' then v #>> '{}'
    when jsonb_typeof(v) = 'object' then coalesce(nullif(btrim(v ->> 'name'), ''), v ->> 'id', v::text)
    when jsonb_typeof(v) = 'array' then nullif((select string_agg(x, ',' order by x) from (
           select coalesce(e ->> 'id', e ->> 'name', e #>> '{}') x from jsonb_array_elements(v) e) s), '')
    else v::text end
$$;

create or replace function at_title(p text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case when p is null then null else
    (select string_agg(upper(left(w, 1)) || substr(w, 2), ' ' order by o) from unnest(string_to_array(lower(p), '_')) with ordinality t(w, o)) end
$$;

create or replace function at_link(p_entity_type text, p_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select jsonb_agg(external_id) from external_links where provider = 'AIRTABLE' and entity_type = p_entity_type
                     and external_type = 'Record' and entity_id = p_id), 'null'::jsonb)
$$;

-- One row per canonical record that has an Airtable twin; `expected` holds every CHECKED field (field id → JSON value).
-- Values mirror scripts/airtable-payload.ts (the original load) and the workflows' write-backs.
create or replace view v_airtable_expected as
select 'tblvUPIoebC3zoacv'::text as table_id, 'project'::text as entity_type, p.id as entity_id, p.project_number as business_key, l.external_id as record_id,
  jsonb_strip_nulls(jsonb_build_object(
    'fldhhnQXlbuFaveK3', p.project_number, 'fld08eKCeuDCsJLjz', at_link('quote', p.quote_id), 'fldG4mPoV6sUkA9rM', at_link('customer', p.customer_id),
    'fldi2Qwz1dAh2tcTE', sm_label('project', p.status), 'fldc4T0AgU3zCmANC', p.id::text)) ||
  jsonb_build_object(
    'fldnZcRBxG7hTebD5', to_jsonb(e.full_name), 'fld8rf6RZLgfs6Ron', to_jsonb(p.planned_start_date::text), 'fldvZtiassZEgLMAN', to_jsonb(p.planned_completion_date::text),
    'fldIje5e0a72cBfVD', to_jsonb(p.actual_start_date::text), 'fldWKRobTLlOjeN9j', to_jsonb(p.actual_completion_date::text),
    'fldgVDT29UOOOtlqO', to_jsonb((select d.external_url from external_links d where d.provider = 'GOOGLE_DRIVE' and d.entity_type = 'project'
                                     and d.external_type = 'Folder' and d.entity_id = p.id and d.verified_at is not null))) ||
  -- Invoice projection, only where canonical invoice state is stable (never mid-flight).
  case
    when fi.sync_status = 'SYNCED' then jsonb_build_object('fldPuGgo27oWLKB5R', 'Xero draft created', 'fld5JDnWI3RFehQxA', fi.total_inc_gst,
      'fldgkN0Vm6k1MZLJp', (select payload ->> 'xero_invoice_number' from outbox where topic = 'xero.create_draft_invoice' and aggregate_id = fi.id),
      'fld3sDI9LIX8Voo4u', (select external_id from external_links where provider = 'XERO' and external_type = 'Invoice' and entity_id = fi.id and verified_at is not null))
    when fi.id is not null then '{}'::jsonb
    when pa.id is not null and pa.created_at < now() - interval '2 minutes' then jsonb_build_object('fldPuGgo27oWLKB5R', 'Awaiting approval',
      'fld5JDnWI3RFehQxA', (pa.action_payload ->> 'amount_inc_gst')::numeric, 'fldgkN0Vm6k1MZLJp', null, 'fld3sDI9LIX8Voo4u', null)
    when pa.id is not null then '{}'::jsonb
    else jsonb_build_object('fldPuGgo27oWLKB5R', jsonb_build_object('$not_in', jsonb_build_array('Awaiting approval', 'Xero draft created', 'Approved - creating in Xero'), '$repair', null),
                            'fldgkN0Vm6k1MZLJp', null, 'fld3sDI9LIX8Voo4u', null)
  end as expected
from projects p
join external_links l on l.provider = 'AIRTABLE' and l.entity_type = 'project' and l.external_type = 'Record' and l.entity_id = p.id
left join employees e on e.id = p.project_manager_id
left join lateral (select * from invoices i where i.project_id = p.id and i.invoice_type = 'FINAL' and i.status <> 'VOIDED' order by created_at desc limit 1) fi on true
left join lateral (select * from approvals a where a.entity_id = p.id and a.action_type = 'CREATE_INVOICE' and a.status = 'PENDING' order by created_at desc limit 1) pa on true
union all
select 'tblzenPRNVV5O7lZP', 'quote', q.id, q.quote_number, l.external_id,
  jsonb_build_object(
    'fldyP20HNafS614d5', q.quote_number, 'fld4LsEu8c9EMFj0h', at_link('customer', q.customer_id), 'fldisUv1ckHz2Detv', at_link('property', q.property_id),
    'fldQpTa5tvrzlNg1h', sm_label('quote', q.status), 'fldEjEqlzE8Y0M1nf', qv.version_number, 'fldbfUE8DVh1Dwjfs', qv.total_inc_gst,
    'fldOaXGsOgYHuWFYg', case q.job_type when 'FULL_REROOF' then 'Full Re-roof' else at_title(q.job_type) end,
    'fldhY6d0ikMnsc7D3', at_title(i.roof_type), 'fldLjvBaV1EFB5RMG', i.roof_area_sqm, 'fld5Bz9FDhJSPibPk', est.full_name,
    'flduF4QFGUWbkuR2d', at_title(q.lead_source), 'fldHSFkvwuVLfAS7J', q.created_on::text, 'fldMnoHiondm5jBWv', q.sent_on::text,
    'fldfhsHggkGd8GKVq', q.accepted_on::text, 'fld1sZibwdMVnI4Hd', q.lost_reason, 'fldVUpqZkVKid3Fyy', q.id::text)
from quotes q
join external_links l on l.provider = 'AIRTABLE' and l.entity_type = 'quote' and l.external_type = 'Record' and l.entity_id = q.id
join lateral (select * from quote_versions v where v.quote_id = q.id order by version_number desc limit 1) qv on true
left join inspections i on i.id = q.inspection_id
left join employees est on est.id = q.estimator_id
union all
select 'tbluIbl4zpMiAlMVw', 'purchase_order', po.id, po.po_number, l.external_id,
  jsonb_build_object(
    'fld1yW7kd8vY975Tj', po.po_number, 'fldDVMu2hgtSVuJyR', at_link('project', po.project_id), 'fldnYTAgdcNXWUMfP', at_link('supplier', po.supplier_id),
    'fldMtDddp1Rm4tDHf', sm_label('purchase_order', po.status), 'fldqNNcA85jAC9FxM', po.po_date::text, 'fldqkJourPRGAcJya', po.expected_delivery_date::text,
    'fld8Muyf7XVB91CjK', po.subtotal_ex_gst, 'fldJ4Z5Rg5adnEFU0', po.supplier_reference, 'fldnzaXx4TTTjCakj', po.id::text)
from purchase_orders po
join external_links l on l.provider = 'AIRTABLE' and l.entity_type = 'purchase_order' and l.external_type = 'Record' and l.entity_id = po.id
union all
select 'tblHKX79FJFHn5FDc', 'customer', c.id, c.customer_number, l.external_id,
  jsonb_build_object(
    'fldzmWSHtLVZ4OTmZ', c.customer_number, 'fldI46VewtlNRnwui', c.display_name, 'fldNcSkEiFnb8m4XP', c.email, 'fldvBKPgd3UeIDYO4', c.phone,
    'fldisVgB2WysksjwW', at_title(c.customer_type), 'fldfNc5n8m2kjiRcB', case when c.preferred_contact = 'SMS' then 'SMS' else at_title(c.preferred_contact) end,
    'fldNu4bbDXjMbwmZ8', c.customer_since::text,
    'fldPXNXPyYie2kKQk', (select b.customer_number from customer_match_candidates m join customers b on b.id = case when m.customer_id = c.id then m.candidate_customer_id else m.customer_id end
                           where c.id in (m.customer_id, m.candidate_customer_id) and c.customer_number > b.customer_number limit 1),
    'fldDClu1e0ffwnojn', c.id::text)
from customers c
join external_links l on l.provider = 'AIRTABLE' and l.entity_type = 'customer' and l.external_type = 'Record' and l.entity_id = c.id
union all
select 'tblSYcCqId9wTMg3c', 'property', pr.id, pr.property_number, l.external_id,
  jsonb_build_object(
    'fldIy8ab7Ky67jL31', pr.property_number, 'fldu0CsGG5uPOVbRN', pr.address_line1, 'fldl6gKbKuZSF9MJG', pr.suburb, 'fldYjfr3STs04XDZr', pr.state,
    'flduw5J4VyRoOqEE2', pr.postcode, 'fldMH8wYXmkAYXCxe', at_title(pr.property_type), 'fldhsHUPCZ0pMbXeV', pr.storeys, 'fldP4PWGxdLZrA5ge', pr.access_notes,
    'fldVpX0MOcA8TnGvo', (select at_link('customer', cp.customer_id) from customer_properties cp where cp.property_id = pr.id and cp.relationship = 'OWNER' limit 1),
    'fldm6rtleyV6yp8ZS', pr.id::text)
from properties pr
join external_links l on l.provider = 'AIRTABLE' and l.entity_type = 'property' and l.external_type = 'Record' and l.entity_id = pr.id
union all
select 'tbloPJwCIcdIZQFVK', 'supplier', s.id, s.supplier_code, l.external_id,
  jsonb_build_object(
    'fldNy5hhua9oCbrge', s.supplier_code, 'fldmyVulHN1hsCE8f', s.name, 'fldPtnT9heTBGTFEM', s.orders_email, 'fldtNq7DluPgIM1rn', s.phone,
    'fldfXKzmQJYzbzgZY', s.default_lead_time_days, 'fldLNYP5FsVaR6TFk', s.id::text)
from suppliers s
join external_links l on l.provider = 'AIRTABLE' and l.entity_type = 'supplier' and l.external_type = 'Record' and l.entity_id = s.id;

-- Does an actual Airtable cell satisfy the expected value? Supports {"$not_in": [...]} for projections.
create or replace function at_matches(p_expected jsonb, p_actual jsonb)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select case
    when jsonb_typeof(p_expected) = 'object' and p_expected ? '$not_in'
      then coalesce(at_norm(p_actual), '') not in (select jsonb_array_elements_text(p_expected -> '$not_in'))
    else at_norm(p_expected) is not distinct from at_norm(p_actual) end
$$;

-- The value to write to Airtable to make it canonical again.
create or replace function at_repair_value(p_expected jsonb)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select case when jsonb_typeof(p_expected) = 'object' and p_expected ? '$not_in' then coalesce(p_expected -> '$repair', 'null'::jsonb)
              else coalesce(p_expected, 'null'::jsonb) end
$$;

-- -----------------------------------------------------------------------------
-- 5. Per-entity change handlers. Return NULL when applied, 'DEFERRED', or a reason a person can act on.
--    Callers hold the row lock. The state-machine triggers remain the backstop.
-- -----------------------------------------------------------------------------
create or replace function project_apply_change(p_id uuid, p_field text, p_value text, p_current jsonb, p_actor text, p_event_key text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare p projects; v_to text; v_reason text; v_date date; v_emp employees; v_note text; v_n int;
begin
  select * into p from projects where id = p_id;
  if p_field = 'status' then
    v_to := sm_state('project', p_value);
    if v_to is null then return format('"%s" is not a project status RoofOps knows', p_value); end if;
    if not state_transition_allowed('project', p.status, v_to) then
      return format('%s → %s is not an allowed status change%s', sm_label('project', p.status), sm_label('project', v_to),
                    case when p.status in ('CANCELLED', 'CLOSED') then ' (' || sm_label('project', p.status) || ' is final)' else '' end);
    end if;
    v_reason := project_transition_guard(p, v_to);
    if v_reason is not null then return v_reason; end if;
    v_note := nullif(btrim(p_current ->> 'fld5MhzMBtA4CBUHo'), '');
    update projects set status = v_to,
      actual_start_date = case when v_to = 'IN_PROGRESS' then coalesce(actual_start_date, app_today()) else actual_start_date end,
      actual_completion_date = case when v_to = 'COMPLETED' then greatest(coalesce(actual_completion_date, app_today()), actual_start_date) else actual_completion_date end,
      on_hold_reason = case when v_to = 'ON_HOLD' then coalesce(v_note, 'Put on hold in Airtable by ' || p_actor) else on_hold_reason end,
      cancellation_reason = case when v_to = 'CANCELLED' then coalesce(v_note, 'Cancelled in Airtable by ' || p_actor) else cancellation_reason end
    where id = p_id;
    if v_to = 'CANCELLED' then
      -- Nothing may be invoiced or worked on for a cancelled job: withdraw pending previews, cancel open tasks.
      with w as (update approvals set status = 'CANCELLED', decision_reason = 'Project cancelled'
                  where entity_id = p_id and action_type = 'CREATE_INVOICE' and status = 'PENDING' returning id, approval_number)
      insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, approval_id, before_state, after_state, reason)
      select 'SYSTEM', 'project_transition', 'approval.withdrawn', 'approval', w.id, w.approval_number, w.id, '{"status":"PENDING"}', '{"status":"CANCELLED"}',
             p.project_number || ' was cancelled' from w;
      update tasks set status = 'CANCELLED' where project_id = p_id and status in ('OPEN', 'IN_PROGRESS');
      get diagnostics v_n = row_count;
    end if;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
    values ('USER', p_actor, 'project.status.changed', 'project', p_id, p.project_number,
            jsonb_build_object('status', p.status), jsonb_build_object('status', v_to, 'tasks_cancelled', coalesce(v_n, 0)),
            coalesce(v_note, 'Changed in Airtable') || ' [' || p_event_key || ']');
    return null;
  elsif p_field in ('planned_start_date', 'planned_completion_date') then
    if p.status in ('COMPLETED', 'CLOSED', 'CANCELLED') then
      return 'the schedule is locked once a job is ' || lower(sm_label('project', p.status));
    end if;
    begin v_date := p_value::date; exception when others then return format('"%s" is not a date', p_value); end;
    if v_date is null and p.status in ('SCHEDULED', 'IN_PROGRESS', 'ON_HOLD') and p_field = 'planned_start_date' then
      return 'a scheduled job needs a Planned Start';
    end if;
    if p_field = 'planned_start_date' and v_date is not null and p.planned_completion_date is not null and v_date > p.planned_completion_date then
      return format('Planned Start %s would be after Planned Completion %s', v_date, p.planned_completion_date);
    end if;
    if p_field = 'planned_completion_date' and v_date is not null and p.planned_start_date is not null and v_date < p.planned_start_date then
      return format('Planned Completion %s would be before Planned Start %s', v_date, p.planned_start_date);
    end if;
    if p_field = 'planned_start_date' then update projects set planned_start_date = v_date where id = p_id;
    else update projects set planned_completion_date = v_date where id = p_id; end if;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
    values ('USER', p_actor, 'project.' || p_field || '.changed', 'project', p_id, p.project_number,
            jsonb_build_object(p_field, case when p_field = 'planned_start_date' then p.planned_start_date else p.planned_completion_date end),
            jsonb_build_object(p_field, v_date), 'Changed in Airtable [' || p_event_key || ']');
    return null;
  elsif p_field = 'project_manager' then
    select * into v_emp from employees where lower(full_name) = lower(btrim(coalesce(p_value, ''))) and role = 'PROJECT_MANAGER' and is_active;
    if v_emp.id is null then
      return format('"%s" is not an active project manager (use: %s)', coalesce(p_value, ''),
                    (select string_agg(full_name, ', ' order by full_name) from employees where role = 'PROJECT_MANAGER' and is_active));
    end if;
    update projects set project_manager_id = v_emp.id where id = p_id;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
    values ('USER', p_actor, 'project.project_manager.changed', 'project', p_id, p.project_number,
            jsonb_build_object('project_manager', (select full_name from employees where id = p.project_manager_id)),
            jsonb_build_object('project_manager', v_emp.full_name), 'Changed in Airtable [' || p_event_key || ']');
    return null;
  end if;
  return 'this field cannot be changed from Airtable';
end $$;

create or replace function po_apply_change(p_id uuid, p_field text, p_value text, p_current jsonb, p_actor text, p_event_key text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare po purchase_orders; v_to text; v_emp uuid; v_date date;
begin
  select * into po from purchase_orders where id = p_id;
  if p_field = 'status' then
    v_to := sm_state('purchase_order', p_value);
    if v_to is null then return format('"%s" is not a purchase-order status RoofOps knows', p_value); end if;
    if not state_transition_allowed('purchase_order', po.status, v_to) then
      return format('%s → %s is not an allowed purchase-order change%s', sm_label('purchase_order', po.status), sm_label('purchase_order', v_to),
                    case when po.status in ('DELIVERED', 'CANCELLED') then ' (' || sm_label('purchase_order', po.status) || ' is final)' else '' end);
    end if;
    select ei.employee_id into v_emp from employee_external_identities ei join employees e on e.id = ei.employee_id
     where ei.provider = 'AIRTABLE' and ei.external_id = p_actor and e.is_active;
    if v_to = 'APPROVED' and po.record_origin = 'ROOFOPS' and v_emp is null then
      return 'only a RoofOps approver can approve a purchase order';
    end if;
    update purchase_orders set status = v_to,
      approved_at = case when v_to in ('APPROVED','SENT','ACKNOWLEDGED','PARTIALLY_DELIVERED','DELIVERED') then coalesce(approved_at, now()) else approved_at end,
      approved_by = case when v_to in ('APPROVED','SENT','ACKNOWLEDGED','PARTIALLY_DELIVERED','DELIVERED') then coalesce(approved_by, v_emp) else approved_by end,
      sent_at = case when v_to in ('SENT','ACKNOWLEDGED','PARTIALLY_DELIVERED','DELIVERED') then coalesce(sent_at, now()) else sent_at end,
      acknowledged_at = case when v_to in ('ACKNOWLEDGED','PARTIALLY_DELIVERED','DELIVERED') and po.status in ('SENT','ACKNOWLEDGED')
                             then coalesce(acknowledged_at, now()) else acknowledged_at end,
      cancelled_reason = case when v_to = 'CANCELLED' then coalesce(cancelled_reason, 'Cancelled in Airtable by ' || p_actor) else cancelled_reason end
    where id = p_id;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
    values ('USER', p_actor, 'purchase_order.status.changed', 'purchase_order', p_id, po.po_number,
            jsonb_build_object('status', po.status), jsonb_build_object('status', v_to), 'Changed in Airtable [' || p_event_key || ']');
    return null;
  elsif p_field = 'expected_delivery_date' then
    if po.status in ('DELIVERED', 'CANCELLED') then return 'the delivery date is locked once an order is ' || lower(sm_label('purchase_order', po.status)); end if;
    begin v_date := p_value::date; exception when others then return format('"%s" is not a date', p_value); end;
    if v_date is not null and v_date < po.po_date then return format('Expected Delivery %s would be before the PO Date %s', v_date, po.po_date); end if;
    update purchase_orders set expected_delivery_date = v_date where id = p_id;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
    values ('USER', p_actor, 'purchase_order.expected_delivery_date.changed', 'purchase_order', p_id, po.po_number,
            jsonb_build_object('expected_delivery_date', po.expected_delivery_date), jsonb_build_object('expected_delivery_date', v_date), 'Changed in Airtable [' || p_event_key || ']');
    return null;
  elsif p_field = 'supplier_reference' then
    update purchase_orders set supplier_reference = nullif(btrim(coalesce(p_value, '')), '') where id = p_id;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
    values ('USER', p_actor, 'purchase_order.supplier_reference.changed', 'purchase_order', p_id, po.po_number,
            jsonb_build_object('supplier_reference', po.supplier_reference), jsonb_build_object('supplier_reference', p_value), 'Changed in Airtable [' || p_event_key || ']');
    return null;
  end if;
  return 'this field cannot be changed from Airtable';
end $$;

create or replace function quote_apply_change(p_id uuid, p_field text, p_value text, p_current jsonb, p_actor text, p_event_key text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare q quotes; v_to text; v_lost text := nullif(btrim(p_current ->> 'fld1sZibwdMVnI4Hd'), '');
begin
  select * into q from quotes where id = p_id;
  if p_field = 'status' then
    v_to := sm_state('quote', p_value);
    if v_to is null then return format('"%s" is not a quote status RoofOps knows', p_value); end if;
    if v_to = 'ACCEPTED' and q.status = 'SENT' then return 'DEFERRED'; end if;   -- the Quote Accepted → Project workflow owns acceptance
    if not state_transition_allowed('quote', q.status, v_to) then
      return format('%s → %s is not an allowed quote change%s', sm_label('quote', q.status), sm_label('quote', v_to),
                    case when q.status in ('ACCEPTED', 'LOST', 'EXPIRED') then ' (' || sm_label('quote', q.status) || ' is final)' else '' end);
    end if;
    update quotes set status = v_to,
      sent_on = case when v_to = 'SENT' then coalesce(sent_on, greatest(app_today(), created_on)) else sent_on end,
      lost_reason = case when v_to = 'LOST' then coalesce(v_lost, lost_reason, 'Marked lost in Airtable by ' || p_actor) else lost_reason end
    where id = p_id;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
    values ('USER', p_actor, 'quote.status.changed', 'quote', p_id, q.quote_number, jsonb_build_object('status', q.status),
            jsonb_build_object('status', v_to), 'Changed in Airtable [' || p_event_key || ']');
    return null;
  elsif p_field = 'lost_reason' then
    if q.status = 'LOST' and nullif(btrim(coalesce(p_value, '')), '') is null then return 'a lost quote needs a Lost Reason'; end if;
    update quotes set lost_reason = nullif(btrim(coalesce(p_value, '')), '') where id = p_id;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
    values ('USER', p_actor, 'quote.lost_reason.changed', 'quote', p_id, q.quote_number, jsonb_build_object('lost_reason', q.lost_reason),
            jsonb_build_object('lost_reason', p_value), 'Changed in Airtable [' || p_event_key || ']');
    return null;
  end if;
  return 'this field cannot be changed from Airtable';
end $$;

-- Open (or reuse) one exception per fact that needs a person.
create or replace function wf_open_sync_exception(p_workflow text, p_entity_type text, p_entity_id uuid, p_ref text, p_class text, p_message text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_num text;
begin
  perform pg_advisory_xact_lock(hashtext('sync-exception:' || coalesce(p_ref, '') || ':' || p_class || ':' || p_message));
  select exception_number into v_num from workflow_exceptions
   where workflow_key = p_workflow and business_reference is not distinct from p_ref and error_class = p_class and error_message = p_message
     and resolution_status in ('OPEN', 'RETRY_QUEUED') limit 1;
  if v_num is not null then
    update workflow_exceptions set attempt_count = attempt_count + 1, last_attempt_at = now() where exception_number = v_num;
    return v_num;
  end if;
  v_num := next_friendly_id('EXC');
  insert into workflow_exceptions (exception_number, workflow_key, entity_type, entity_id, business_reference, error_class, error_message,
                                   retryable, attempt_count, first_failed_at, last_attempt_at)
  select v_num, p_workflow, p_entity_type, p_entity_id, p_ref, p_class, p_message, ec.retryable, 1, now(), now() from error_classes ec where ec.code = p_class;
  return v_num;
end $$;
revoke execute on function wf_open_sync_exception(text, text, uuid, text, text, text) from public;

-- -----------------------------------------------------------------------------
-- 6. The single entry point for Airtable edits (webhook consumer n8n 06, and reconciliation replays).
--    event: { event_id, source: airtable|reconciler, actor_id, occurred_at, table_id, record_id,
--             changes: { fieldId: { current, previous?, has_previous? } }, current: { fieldId: value } }
-- -----------------------------------------------------------------------------
create or replace function wf_airtable_change(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key text := p_event ->> 'event_id'; v_table text := p_event ->> 'table_id'; v_rec text := p_event ->> 'record_id';
  v_src text := coalesce(nullif(p_event ->> 'source', ''), 'airtable'); v_actor text := coalesce(nullif(p_event ->> 'actor_id', ''), 'unknown');
  v_changes jsonb := coalesce(p_event -> 'changes', '{}'::jsonb); v_current jsonb := coalesce(p_event -> 'current', '{}'::jsonb);
  v_at timestamptz; v_entity text; v_id uuid; v_ref text; v_evid uuid; v_claimed boolean; v_pe processed_events;
  f record; v_new text; v_prev text; v_canon text; v_reason text; v_exp jsonb; v_exp_after jsonb; v_status_applied boolean := false;
  v_applied jsonb := '[]'; v_rejected jsonb := '[]'; v_reverted jsonb := '[]'; v_stale jsonb := '[]'; v_deferred jsonb := '[]';
  v_corr jsonb := '{}'::jsonb; v_note text := ''; v_res jsonb; v_outcome text; v_exc text; v_sync_field text;
begin
  -- 1. Validate the envelope.
  if coalesce(v_key, '') = '' or length(v_key) > 300 or coalesce(v_table, '') !~ '^tbl[A-Za-z0-9]{14}$' or coalesce(v_rec, '') !~ '^rec[A-Za-z0-9]{14}$'
     or jsonb_typeof(v_changes) <> 'object' then
    return jsonb_build_object('outcome', 'INVALID_EVENT', 'message', 'event_id, table_id, record_id and changes are required');
  end if;
  begin v_at := coalesce((p_event ->> 'occurred_at')::timestamptz, now());
  exception when others then return jsonb_build_object('outcome', 'INVALID_EVENT', 'message', 'occurred_at must be an ISO timestamp'); end;
  select min(entity) into v_entity from field_contract where airtable_table_id = v_table;
  if v_entity is null then return jsonb_build_object('outcome', 'INVALID_EVENT', 'message', 'table is not managed by RoofOps'); end if;
  select airtable_field_id into v_sync_field from field_contract where airtable_table_id = v_table and field_key = 'roofops_sync';

  -- 2. Transport idempotency: the same Airtable transaction is processed once, whatever the delivery count.
  v_evid := wf_log_event(v_key, stable_uuid('correlation', v_key), null, 'airtable.record_changed', v_entity, null, null,
                         case when v_src = 'reconciler' then 'SYSTEM' else 'USER' end, v_actor, v_src, 'RECEIVED', null,
                         jsonb_build_object('record_id', v_rec, 'table_id', v_table, 'worker', p_worker), p_event);
  insert into processed_events (consumer, idempotency_key, first_event_id, request_hash, status, locked_by, lease_expires_at)
  values ('airtable_change@1', v_key, v_evid, md5(p_event::text), 'PROCESSING', p_worker, now() + interval '5 minutes')
  on conflict do nothing returning true into v_claimed;
  if v_claimed is null then
    select * into v_pe from processed_events where consumer = 'airtable_change@1' and idempotency_key = v_key for update;
    update processed_events set delivery_count = delivery_count + 1, last_seen_at = now() where consumer = v_pe.consumer and idempotency_key = v_key;
    return coalesce(v_pe.result, '{}'::jsonb) || jsonb_build_object('duplicate', true, 'delivery_count', v_pe.delivery_count + 1,
                                                                    'corrections', '{}'::jsonb);   -- corrections were applied the first time
  end if;

  -- 3. Identity: the record link recorded by RoofOps (never names).
  select entity_id into v_id from external_links where provider = 'AIRTABLE' and entity_type = v_entity and external_type = 'Record' and external_id = v_rec;
  if v_id is null then
    v_exc := wf_open_sync_exception('airtable_sync', v_entity, null, v_rec, 'NOT_FOUND',
               format('Airtable %s record %s is not linked to any RoofOps record (created directly in Airtable?). RoofOps ignored its changes.', v_entity, v_rec));
    v_res := jsonb_build_object('outcome', 'UNKNOWN_RECORD', 'record_id', v_rec, 'exception_number', v_exc, 'corrections', '{}'::jsonb);
    update automation_events set status = 'REJECTED', error_class = 'NOT_FOUND', metadata = metadata || jsonb_build_object('reason', 'unknown record') where event_id = v_evid;
    update processed_events set status = 'COMPLETED', completed_at = now(), result = v_res, lease_expires_at = null where consumer = 'airtable_change@1' and idempotency_key = v_key;
    return v_res;
  end if;

  -- 4. One writer per record: everything below is evaluated against the row as it is *after* any concurrent change commits.
  case v_entity
    when 'project' then select project_number into v_ref from projects where id = v_id for update;
    when 'quote' then select quote_number into v_ref from quotes where id = v_id for update;
    when 'purchase_order' then select po_number into v_ref from purchase_orders where id = v_id for update;
    when 'customer' then select customer_number into v_ref from customers where id = v_id for update;
    when 'property' then select property_number into v_ref from properties where id = v_id for update;
    when 'supplier' then select supplier_code into v_ref from suppliers where id = v_id for update;
  end case;
  select expected into v_exp from v_airtable_expected where table_id = v_table and entity_id = v_id;
  v_current := v_current || (select coalesce(jsonb_object_agg(k, v -> 'current'), '{}'::jsonb) from jsonb_each(v_changes) as x(k, v));

  -- 5. Each changed field, by its owner.
  for f in select c.*, ch.key as fid, ch.value as chv from jsonb_each(v_changes) ch
             join field_contract c on c.airtable_table_id = v_table and c.airtable_field_id = ch.key
            where c.reconcile in ('APPLY_VIA_HANDLER', 'REPAIR_AIRTABLE') order by (c.field_key = 'status') desc, c.field_key
  loop
    v_new := at_norm(f.chv -> 'current');
    v_canon := at_norm(v_exp -> f.fid);
    if v_new is not distinct from v_canon then continue; end if;          -- no change, or our own write echoing back
    if f.owner <> 'AIRTABLE_EDIT' then
      v_reverted := v_reverted || jsonb_build_object('field', f.airtable_name, 'attempted', v_new, 'kept', v_canon);
      insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
      values ('SYSTEM', 'airtable_sync', 'airtable.edit_reverted', v_entity, v_id, v_ref, jsonb_build_object(f.field_key, v_new),
              jsonb_build_object(f.field_key, v_canon), f.airtable_name || ' is managed by RoofOps [' || v_key || ']');
      continue;
    end if;
    -- Delayed / out-of-order delivery: a newer change to this field was already applied.
    if v_src = 'airtable' and exists (select 1 from external_field_versions x where x.entity_type = v_entity and x.entity_id = v_id
                                        and x.field_key = f.field_key and x.last_source_at > v_at) then
      v_stale := v_stale || jsonb_build_object('field', f.airtable_name, 'value', v_new);
      continue;
    end if;
    -- Compare-and-set: the edit was made against a value RoofOps no longer holds (concurrent change) → refuse, do not guess.
    if v_src = 'airtable' and coalesce((f.chv ->> 'has_previous')::boolean, f.chv ? 'previous')
       and at_norm(f.chv -> 'previous') is distinct from v_canon then
      v_rejected := v_rejected || jsonb_build_object('field', f.airtable_name, 'attempted', v_new, 'kept', v_canon,
        'reason', format('it was changed from "%s", but RoofOps already had "%s" (someone else changed it at the same time); please re-apply if still intended',
                         coalesce(at_norm(f.chv -> 'previous'), 'blank'), coalesce(v_canon, 'blank')), 'conflict', true);
      continue;
    end if;
    v_reason := case v_entity
      when 'project' then project_apply_change(v_id, f.field_key, v_new, v_current, v_actor, v_key)
      when 'purchase_order' then po_apply_change(v_id, f.field_key, v_new, v_current, v_actor, v_key)
      when 'quote' then quote_apply_change(v_id, f.field_key, v_new, v_current, v_actor, v_key)
      else 'this field cannot be changed from Airtable' end;
    if v_reason is null then
      v_applied := v_applied || jsonb_build_object('field', f.airtable_name, 'from', v_canon, 'to', v_new);
      if f.field_key = 'status' then v_status_applied := true; end if;
      insert into external_field_versions (entity_type, entity_id, field_key, last_source, last_source_at, last_event_key, last_value)
      values (v_entity, v_id, f.field_key, v_src, v_at, v_key, v_new)
      on conflict (entity_type, entity_id, field_key) do update set last_source = excluded.last_source,
        last_source_at = greatest(external_field_versions.last_source_at, excluded.last_source_at), last_event_key = excluded.last_event_key,
        last_value = excluded.last_value, applied_at = now();
    elsif v_reason = 'DEFERRED' then
      v_deferred := v_deferred || jsonb_build_object('field', f.airtable_name, 'to', v_new, 'handled_by', 'Quote Accepted → Project workflow');
    else
      v_rejected := v_rejected || jsonb_build_object('field', f.airtable_name, 'attempted', v_new, 'kept', v_canon, 'reason', v_reason);
    end if;
  end loop;

  -- 6. Corrections: every checked field Airtable now shows differently from canonical (except deferred acceptance).
  select expected into v_exp_after from v_airtable_expected where table_id = v_table and entity_id = v_id;
  select coalesce(jsonb_object_agg(e.key, at_repair_value(e.value)), '{}'::jsonb) into v_corr
    from jsonb_each(v_exp_after) e
    join field_contract c on c.airtable_table_id = v_table and c.airtable_field_id = e.key and c.reconcile in ('APPLY_VIA_HANDLER', 'REPAIR_AIRTABLE')
   where (v_changes ? e.key or (v_status_applied and c.field_key in ('actual_start_date', 'actual_completion_date', 'sent_on')))
     and not at_matches(e.value, v_current -> e.key)
     and not exists (select 1 from jsonb_array_elements(v_deferred || v_stale) d where d ->> 'field' = c.airtable_name);

  v_note := concat_ws(E'\n',
    (select string_agg(format('✓ %s: %s → %s applied', a ->> 'field', coalesce(a ->> 'from', 'blank'), coalesce(a ->> 'to', 'blank')), E'\n') from jsonb_array_elements(v_applied) a),
    (select string_agg(format('✗ %s: "%s" not applied: %s. Kept "%s".', r ->> 'field', coalesce(r ->> 'attempted', 'blank'), r ->> 'reason', coalesce(r ->> 'kept', 'blank')), E'\n') from jsonb_array_elements(v_rejected) r),
    (select string_agg(format('↺ %s is managed by RoofOps; "%s" was reverted to "%s".', r ->> 'field', coalesce(r ->> 'attempted', 'blank'), coalesce(r ->> 'kept', 'blank')), E'\n') from jsonb_array_elements(v_reverted) r),
    (select string_agg(format('• %s: an older change arrived late and was ignored.', s ->> 'field'), E'\n') from jsonb_array_elements(v_stale) s));
  if v_note <> '' and v_sync_field is not null then
    v_corr := v_corr || jsonb_build_object(v_sync_field, to_char(now() at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI') || E'\n' || v_note);
  end if;

  v_outcome := case when jsonb_array_length(v_applied) > 0 and jsonb_array_length(v_rejected) + jsonb_array_length(v_reverted) = 0 then 'APPLIED'
                    when jsonb_array_length(v_applied) > 0 then 'PARTIALLY_APPLIED'
                    when jsonb_array_length(v_rejected) > 0 then 'REJECTED'
                    when jsonb_array_length(v_reverted) > 0 then 'REVERTED'
                    when jsonb_array_length(v_stale) > 0 then 'STALE'
                    when jsonb_array_length(v_deferred) > 0 then 'DEFERRED'
                    else 'NO_CHANGE' end;
  v_res := jsonb_build_object('outcome', v_outcome, 'entity', v_entity, 'business_key', v_ref, 'entity_id', v_id, 'record_id', v_rec, 'table_id', v_table,
                              'applied', v_applied, 'rejected', v_rejected, 'reverted', v_reverted, 'stale', v_stale, 'deferred', v_deferred,
                              'corrections', v_corr, 'note', nullif(v_note, ''));
  update automation_events set entity_id = v_id, business_reference = v_ref,
         status = case when v_outcome in ('REJECTED', 'REVERTED') then 'REJECTED' when v_outcome = 'STALE' then 'DUPLICATE_IGNORED' else 'SUCCEEDED' end,
         error_class = case when v_outcome = 'REJECTED' then 'ILLEGAL_TRANSITION' when v_outcome = 'REVERTED' then 'UNAUTHORIZED_EDIT'
                            when v_outcome = 'STALE' then 'STALE_EVENT' end,
         metadata = metadata || jsonb_build_object('outcome', v_outcome, 'reason', nullif(v_note, ''))
   where event_id = v_evid;
  update processed_events set status = 'COMPLETED', completed_at = now(), result = v_res, lease_expires_at = null
   where consumer = 'airtable_change@1' and idempotency_key = v_key;
  -- What RoofOps now believes Airtable shows (after the corrections n8n is about to write).
  insert into airtable_observations (table_id, record_id, field_id, value, observed_at, source)
  select v_table, v_rec, k, at_norm(coalesce(v_corr -> k, v_current -> k)), now(), v_src
    from jsonb_object_keys(v_current) k where exists (select 1 from field_contract c where c.airtable_field_id = k and c.reconcile <> 'IGNORE'
                                                        and not exists (select 1 from jsonb_array_elements(v_stale) st where st ->> 'field' = c.airtable_name))
  on conflict (table_id, record_id, field_id) do update set value = excluded.value, observed_at = excluded.observed_at, source = excluded.source;
  return v_res;
end $$;

-- n8n reports that the corrections were written and read back from Airtable (proof).
create or replace function wf_airtable_writeback_verified(p_event_key text, p_table_id text, p_record_id text, p_readback jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_exp jsonb; v_bad jsonb;
begin
  select expected into v_exp from v_airtable_expected where table_id = p_table_id and record_id = p_record_id;
  select coalesce(jsonb_agg(e.key), '[]'::jsonb) into v_bad from jsonb_each(coalesce(v_exp, '{}'::jsonb)) e
   join field_contract c on c.airtable_field_id = e.key and c.reconcile in ('APPLY_VIA_HANDLER', 'REPAIR_AIRTABLE')
   where p_readback ? e.key and not at_matches(e.value, p_readback -> e.key);
  perform wf_log_event(p_event_key || ':writeback', stable_uuid('correlation', p_event_key), stable_uuid('event', p_event_key), 'airtable.writeback.verified',
                       null, null, p_record_id, 'INTEGRATION', 'airtable', 'airtable', case when jsonb_array_length(v_bad) = 0 then 'SUCCEEDED' else 'FAILED' end,
                       case when jsonb_array_length(v_bad) = 0 then null else 'RECONCILIATION_MISMATCH' end, jsonb_build_object('mismatched_fields', v_bad), null);
  insert into airtable_observations (table_id, record_id, field_id, value, observed_at, source)
  select p_table_id, p_record_id, k, at_norm(p_readback -> k), now(), 'readback' from jsonb_object_keys(p_readback) k
   where exists (select 1 from field_contract c where c.airtable_field_id = k and c.reconcile <> 'IGNORE')
  on conflict (table_id, record_id, field_id) do update set value = excluded.value, observed_at = excluded.observed_at, source = excluded.source;
  return jsonb_build_object('verified', jsonb_array_length(v_bad) = 0, 'mismatched_fields', v_bad);
end $$;

-- -----------------------------------------------------------------------------
-- 7. Reconciliation
-- -----------------------------------------------------------------------------
create or replace function wf_reconcile_start(p_trigger text, p_mode text default 'repair', p_token text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_run reconciliation_runs; v_hash text := (select value from app_settings where key = 'reconcile.trigger_token_sha256');
begin
  if p_trigger not in ('schedule', 'manual') or p_mode not in ('observe', 'repair') then
    return jsonb_build_object('started', false, 'reason', 'trigger must be schedule|manual and mode observe|repair');
  end if;
  if p_trigger = 'manual' and (coalesce(v_hash, '') = '' or encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') <> v_hash) then
    return jsonb_build_object('started', false, 'reason', 'manual reconciliation needs the operator trigger token');
  end if;
  perform pg_advisory_xact_lock(hashtext('reconcile-start'));
  -- Protect the Airtable monthly quota: at most one run every 2 minutes.
  if exists (select 1 from reconciliation_runs where started_at > now() - interval '2 minutes') then
    return jsonb_build_object('started', false, 'reason', 'a reconciliation ran less than 2 minutes ago');
  end if;
  update reconciliation_runs set status = 'FAILED', finished_at = now(), summary = summary || '{"reason":"superseded (never finished)"}'
   where status = 'RUNNING';
  insert into reconciliation_runs (run_key, trigger, mode) values ('RECON-' || to_char(clock_timestamp() at time zone 'Australia/Brisbane', 'YYYYMMDD-HH24MISS') || '-' || substr(md5(random()::text), 1, 4), p_trigger, p_mode) returning * into v_run;
  return jsonb_build_object('started', true, 'run_key', v_run.run_key, 'mode', p_mode,
    'tables', (select jsonb_agg(distinct airtable_table_id) from field_contract where airtable_table_id is not null));
end $$;

-- Compare one Airtable table snapshot with canonical state; apply / repair per ownership.
create or replace function wf_reconcile_airtable(p_run_key text, p_table_id text, p_records jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run reconciliation_runs; r record; e record; c field_contract; a jsonb; v_res jsonb; v_corr jsonb := '{}'::jsonb;
  v_checked int := 0; v_drift int := 0; v_records int := 0; v_ev jsonb; v_exc text; v_entity text;
begin
  select * into v_run from reconciliation_runs where run_key = p_run_key and status = 'RUNNING';
  if v_run.id is null then return jsonb_build_object('ok', false, 'reason', 'no running reconciliation ' || coalesce(p_run_key, '')); end if;
  select min(entity) into v_entity from field_contract where airtable_table_id = p_table_id;

  -- Airtable records RoofOps does not know (created in Airtable) → a person decides.
  for r in select x ->> 'id' as rec from jsonb_array_elements(p_records) x
            where not exists (select 1 from external_links l where l.provider = 'AIRTABLE' and l.external_type = 'Record' and l.external_id = x ->> 'id')
  loop
    v_exc := case when v_run.mode = 'repair' then wf_open_sync_exception('reconciliation', v_entity, null, r.rec, 'RECONCILIATION_MISMATCH',
      format('Airtable %s record %s exists only in Airtable; RoofOps does not create records from Airtable. Delete it or recreate it through the supported flow.', v_entity, r.rec)) end;
    insert into reconciliation_findings (run_id, system, entity_type, external_id, classification, action, detail)
    values (v_run.id, 'AIRTABLE', v_entity, r.rec, 'UNKNOWN', case when v_exc is null then 'NONE_OBSERVE_ONLY' else 'EXCEPTION_OPENED' end, v_exc);
  end loop;

  -- Canonical records whose Airtable twin is gone.
  for e in select x.* from v_airtable_expected x where x.table_id = p_table_id
            and not exists (select 1 from jsonb_array_elements(p_records) y where y ->> 'id' = x.record_id)
  loop
    v_exc := case when v_run.mode = 'repair' then wf_open_sync_exception('reconciliation', e.entity_type, e.entity_id, e.business_key, 'EXTERNAL_MISSING',
      format('%s has no Airtable record any more (%s was deleted or moved). Staff cannot see it in Airtable.', e.business_key, e.record_id)) end;
    insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
    values (v_run.id, 'AIRTABLE', e.entity_type, e.business_key, e.record_id, 'EXTERNAL_MISSING', case when v_exc is null then 'NONE_OBSERVE_ONLY' else 'EXCEPTION_OPENED' end, v_exc);
  end loop;

  for e in select x.*, y -> 'fields' as fields from v_airtable_expected x
             join jsonb_array_elements(p_records) y on y ->> 'id' = x.record_id where x.table_id = p_table_id
  loop
    v_records := v_records + 1;
    -- Record what Airtable showed (drives drift display and the Copilot's sync warnings).
    insert into airtable_observations (table_id, record_id, field_id, value, observed_at, source)
    select p_table_id, e.record_id, k.key, at_norm(e.fields -> k.key), now(), 'reconciliation' from jsonb_each(e.expected) k
    on conflict (table_id, record_id, field_id) do update set value = excluded.value, observed_at = excluded.observed_at, source = excluded.source;

    for c in select * from field_contract where airtable_table_id = p_table_id and airtable_field_id in (select jsonb_object_keys(e.expected))
                 and reconcile in ('APPLY_VIA_HANDLER', 'REPAIR_AIRTABLE', 'PROJECTION') order by (field_key = 'status') desc
    loop
      v_checked := v_checked + 1;
      a := e.fields -> c.airtable_field_id;
      if at_matches(e.expected -> c.airtable_field_id, a) then continue; end if;
      v_drift := v_drift + 1;
      if c.owner = 'AIRTABLE_EDIT' then
        if e.entity_type = 'quote' and c.field_key = 'status' and at_norm(a) = 'Accepted' then
          -- A missed acceptance cannot be replayed without the Drive + Airtable side effects: a person re-triggers it.
          v_exc := case when v_run.mode = 'repair' then wf_open_sync_exception('reconciliation', 'quote', e.entity_id, e.business_key, 'RECONCILIATION_MISMATCH',
            format('%s is Accepted in Airtable but RoofOps never received the acceptance. Set Status back to Sent, then to Accepted, to run the Quote → Project workflow.', e.business_key)) end;
          insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, field, expected, actual, classification, action, detail)
          values (v_run.id, 'AIRTABLE', 'quote', e.business_key, e.record_id, c.airtable_name, at_norm(e.expected -> c.airtable_field_id), at_norm(a),
                  'REQUIRES_HUMAN', case when v_exc is null then 'NONE_OBSERVE_ONLY' else 'EXCEPTION_OPENED' end, v_exc);
          continue;
        end if;
        if v_run.mode = 'observe' then
          insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, field, expected, actual, classification, action, detail)
          values (v_run.id, 'AIRTABLE', e.entity_type, e.business_key, e.record_id, c.airtable_name, at_norm(e.expected -> c.airtable_field_id), at_norm(a),
                  'SAFE_AUTO_REPAIR', 'NONE_OBSERVE_ONLY', 'Missed Airtable edit; a repair run replays it through the same validation');
          continue;
        end if;
        -- A missed human edit: replay it through the exact same validation as the webhook path.
        v_ev := jsonb_build_object('event_id', 'reconcile:' || p_run_key || ':' || e.record_id || ':' || c.airtable_field_id, 'source', 'reconciler',
                  'actor_id', 'reconciliation', 'occurred_at', now(), 'table_id', p_table_id, 'record_id', e.record_id,
                  'changes', jsonb_build_object(c.airtable_field_id, jsonb_build_object('current', a)), 'current', e.fields);
        v_res := wf_airtable_change(v_ev, 'reconciler');
        v_corr := v_corr || jsonb_build_object(e.record_id, coalesce(v_corr -> e.record_id, '{}'::jsonb) || coalesce(v_res -> 'corrections', '{}'::jsonb));
        insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, field, expected, actual, classification, action, detail)
        values (v_run.id, 'AIRTABLE', e.entity_type, e.business_key, e.record_id, c.airtable_name, at_norm(e.expected -> c.airtable_field_id), at_norm(a),
                'SAFE_AUTO_REPAIR', case when jsonb_array_length(coalesce(v_res -> 'applied', '[]')) > 0 then 'APPLIED_TO_POSTGRES' else 'REJECTED_AND_REPAIRED' end,
                coalesce(v_res ->> 'note', v_res ->> 'outcome'));
      else
        insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, field, expected, actual, classification, action, detail)
        values (v_run.id, 'AIRTABLE', e.entity_type, e.business_key, e.record_id, c.airtable_name, at_norm(at_repair_value(e.expected -> c.airtable_field_id)), at_norm(a),
                case when c.reconcile = 'PROJECTION' then 'SAFE_AUTO_REPAIR' else 'UNAUTHORIZED_STATE' end,
                case when v_run.mode = 'repair' then 'REPAIRED_AIRTABLE' else 'NONE_OBSERVE_ONLY' end,
                case when c.reconcile = 'PROJECTION' then 'Airtable projection of canonical invoice state was stale' else c.airtable_name || ' is managed by RoofOps' end);
        if v_run.mode = 'repair' then
          v_corr := v_corr || jsonb_build_object(e.record_id, coalesce(v_corr -> e.record_id, '{}'::jsonb)
                     || jsonb_build_object(c.airtable_field_id, at_repair_value(e.expected -> c.airtable_field_id))
                     || coalesce((select jsonb_build_object(s.airtable_field_id, to_char(now() at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI')
                                   || E'\n↺ ' || c.airtable_name || case when c.reconcile = 'PROJECTION' then ' refreshed from RoofOps.' else ' is managed by RoofOps; reverted by reconciliation.' end)
                                  from field_contract s where s.airtable_table_id = p_table_id and s.field_key = 'roofops_sync'), '{}'::jsonb));
        end if;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('ok', true, 'table_id', p_table_id, 'records', v_records, 'fields_checked', v_checked, 'drift', v_drift,
    'corrections', (select coalesce(jsonb_agg(jsonb_build_object('id', k, 'fields', v)), '[]'::jsonb) from jsonb_each(v_corr) as t(k, v) where v <> '{}'::jsonb));
end $$;

-- What n8n must read back from Drive and Xero this run.
create or replace function wf_reconcile_targets(p_run_key text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'drive', coalesce((select jsonb_agg(jsonb_build_object('project_number', p.project_number, 'folder_id', l.external_id))
                       from external_links l join projects p on p.id = l.entity_id
                       where l.provider = 'GOOGLE_DRIVE' and l.entity_type = 'project' and l.external_type = 'Folder' and l.verified_at is not null), '[]'::jsonb),
    'xero', coalesce((select jsonb_agg(jsonb_build_object('invoice_number', i.invoice_number, 'project_number', p.project_number, 'invoice_id', l.external_id,
                        'tenant_id', (select value from app_settings where key = 'xero.demo_tenant_id'),
                        'xero_invoice_number', (select payload ->> 'xero_invoice_number' from outbox where topic = 'xero.create_draft_invoice' and aggregate_id = i.id),
                        'total', i.total_inc_gst, 'reference', p.project_number))
                      from external_links l join invoices i on i.id = l.entity_id join projects p on p.id = i.project_id
                      where l.provider = 'XERO' and l.external_type = 'Invoice' and l.verified_at is not null), '[]'::jsonb))
  where exists (select 1 from reconciliation_runs where run_key = p_run_key and status = 'RUNNING')
$$;

-- Drive / Xero read-back results → findings. Never "fixes" an external object; a person decides.
create or replace function wf_reconcile_external(p_run_key text, p_system text, p_results jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_run reconciliation_runs; x jsonb; v_class text; v_detail text; v_exc text; v_ok int := 0; v_bad int := 0;
begin
  select * into v_run from reconciliation_runs where run_key = p_run_key and status = 'RUNNING';
  if v_run.id is null or p_system not in ('DRIVE', 'XERO') then return jsonb_build_object('ok', false); end if;
  for x in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    v_class := null;
    if p_system = 'DRIVE' then
      if coalesce((x ->> 'http')::int, 0) = 404 or (x ->> 'trashed')::boolean then
        v_class := 'EXTERNAL_MISSING'; v_detail := format('Drive folder for %s is %s', x ->> 'project_number', case when (x ->> 'trashed')::boolean then 'in the trash' else 'deleted' end);
      elsif coalesce((x ->> 'http')::int, 0) <> 200 then
        v_class := 'UNKNOWN'; v_detail := format('Drive folder for %s could not be read (HTTP %s)', x ->> 'project_number', x ->> 'http');
      elsif x ->> 'expected_parent' is not null and not coalesce((x -> 'parents') ? (x ->> 'expected_parent'), false) then
        v_class := 'REQUIRES_HUMAN'; v_detail := format('Drive folder for %s was moved out of the RoofOps root folder', x ->> 'project_number');
      end if;
    else
      if coalesce((x ->> 'http')::int, 0) = 404 or x ->> 'status' in ('DELETED', 'VOIDED') then
        v_class := 'EXTERNAL_MISSING'; v_detail := format('Xero invoice %s is %s', x ->> 'xero_invoice_number', coalesce(lower(x ->> 'status'), 'missing'));
      elsif coalesce((x ->> 'http')::int, 0) <> 200 then
        v_class := 'UNKNOWN'; v_detail := format('Xero invoice %s could not be read (HTTP %s)', x ->> 'xero_invoice_number', x ->> 'http');
      elsif (x ->> 'total')::numeric is distinct from (x ->> 'expected_total')::numeric or x ->> 'reference' is distinct from x ->> 'expected_reference' then
        v_class := 'REQUIRES_HUMAN'; v_detail := format('Xero invoice %s was edited in Xero (total %s vs approved %s, reference %s)',
                     x ->> 'xero_invoice_number', x ->> 'total', x ->> 'expected_total', x ->> 'reference');
      end if;
    end if;
    if v_class is null then
      v_ok := v_ok + 1;
      update external_links set last_synced_at = now()
       where provider = case p_system when 'DRIVE' then 'GOOGLE_DRIVE' else 'XERO' end and external_id = coalesce(x ->> 'folder_id', x ->> 'invoice_id');
    else
      v_bad := v_bad + 1;
      v_exc := case when v_run.mode = 'repair' then wf_open_sync_exception('reconciliation', case p_system when 'DRIVE' then 'project' else 'invoice' end, null,
                 coalesce(x ->> 'project_number', x ->> 'invoice_number'), case when v_class = 'EXTERNAL_MISSING' then 'EXTERNAL_MISSING' else 'RECONCILIATION_MISMATCH' end, v_detail) end;
      insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
      values (v_run.id, p_system, case p_system when 'DRIVE' then 'project' else 'invoice' end, coalesce(x ->> 'project_number', x ->> 'invoice_number'),
              coalesce(x ->> 'folder_id', x ->> 'invoice_id'), v_class, case when v_exc is null then 'NONE_OBSERVE_ONLY' else 'EXCEPTION_OPENED' end, v_detail);
    end if;
  end loop;
  update reconciliation_runs set summary = summary || jsonb_build_object(lower(p_system), jsonb_build_object('checked', v_ok + v_bad, 'verified', v_ok, 'drift', v_bad))
   where id = v_run.id;
  return jsonb_build_object('ok', true, 'verified', v_ok, 'drift', v_bad);
end $$;

create or replace function wf_reconcile_finish(p_run_key text, p_airtable jsonb default '{}'::jsonb, p_webhooks jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_run reconciliation_runs; v_sum jsonb;
begin
  select * into v_run from reconciliation_runs where run_key = p_run_key and status = 'RUNNING';
  if v_run.id is null then return jsonb_build_object('ok', false, 'reason', 'no running reconciliation ' || coalesce(p_run_key, '')); end if;
  v_sum := v_run.summary || jsonb_build_object(
    'airtable', coalesce(p_airtable, '{}'::jsonb), 'webhooks', coalesce(p_webhooks, '[]'::jsonb),
    'findings', (select coalesce(jsonb_object_agg(classification || '/' || action, n), '{}'::jsonb)
                   from (select classification, action, count(*) n from reconciliation_findings where run_id = v_run.id group by 1, 2) s),
    'open_exceptions', (select count(*) from workflow_exceptions where resolution_status in ('OPEN', 'RETRY_QUEUED')),
    'dead_letters', (select count(*) from outbox where status = 'FAILED' and next_attempt_at = 'infinity'));
  update reconciliation_runs set status = 'COMPLETED', finished_at = now(), summary = v_sum where id = v_run.id;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
  values ('SYSTEM', 'reconciliation', 'reconciliation.completed', 'reconciliation_run', v_run.id, v_run.run_key, v_sum, v_run.mode || ' run (' || v_run.trigger || ')');
  return jsonb_build_object('ok', true, 'run_key', v_run.run_key, 'mode', v_run.mode, 'summary', v_sum);
end $$;

-- -----------------------------------------------------------------------------
-- 8. Health: synthetic checks from n8n 08 (safe reads only).
-- -----------------------------------------------------------------------------
create or replace function wf_record_health(p_checks jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  insert into integration_health (service, ok, latency_ms, detail)
  select x ->> 'service', coalesce((x ->> 'ok')::boolean, false), nullif(x ->> 'latency_ms', '')::int, coalesce(x -> 'detail', '{}'::jsonb)
    from jsonb_array_elements(p_checks) x where x ->> 'service' in ('postgres','airtable','airtable_webhooks','n8n','google_drive','xero','deepseek');
  get diagnostics n = row_count;
  insert into integration_health (service, ok, latency_ms, detail) values ('postgres', true, 0, '{"check":"wf_record_health"}');
  delete from integration_health where checked_at < now() - interval '14 days';
  return jsonb_build_object('recorded', n + 1);
end $$;

-- -----------------------------------------------------------------------------
-- 9. Read models: health, drift, freshness
-- -----------------------------------------------------------------------------
create or replace view v_system_health as
with latest as (
  select distinct on (service) service, ok, latency_ms, detail, checked_at from integration_health order by service, checked_at desc
), last_ok as (select service, max(checked_at) as last_ok_at from integration_health where ok group by service),
fails as (select h.service, count(*) as consecutive_failures from integration_health h
            where not h.ok and h.checked_at > coalesce((select max(checked_at) from integration_health o where o.service = h.service and o.ok), '-infinity')
            group by h.service)
select s.service, l.ok, l.latency_ms, l.detail, l.checked_at, o.last_ok_at, coalesce(f.consecutive_failures, 0) as consecutive_failures,
       extract(epoch from now() - l.checked_at)::int as age_seconds
from (values ('postgres'),('airtable'),('airtable_webhooks'),('n8n'),('google_drive'),('xero'),('deepseek')) s(service)
left join latest l on l.service = s.service left join last_ok o on o.service = s.service left join fails f on f.service = s.service;

create or replace view v_reconciliation_latest as
select r.run_key, r.trigger, r.mode, r.status, r.started_at, r.finished_at, r.summary,
       (select count(*) from reconciliation_findings f where f.run_id = r.id) as findings,
       (select count(*) from reconciliation_findings f where f.run_id = r.id and f.classification in ('REQUIRES_HUMAN','EXTERNAL_MISSING','UNKNOWN')) as needs_person
from reconciliation_runs r where r.status = 'COMPLETED' order by r.finished_at desc limit 1;

create or replace view v_reconciliation_findings_latest as
select f.system, f.entity_type, f.entity_ref, f.external_id, f.field, f.expected, f.actual, f.classification, f.action, f.detail, f.created_at
from reconciliation_findings f where f.run_id = (select id from reconciliation_runs where status = 'COMPLETED' order by finished_at desc limit 1);

-- Current state drift RoofOps knows about right now (observed Airtable value ≠ canonical), per record/field.
create or replace view v_state_drift as
select x.table_id, x.entity_type, x.entity_id, x.business_key, x.record_id, c.airtable_name as field, c.owner,
       at_norm(at_repair_value(x.expected -> c.airtable_field_id)) as canonical_value, o.value as airtable_value, o.observed_at, o.source
from v_airtable_expected x
join field_contract c on c.airtable_table_id = x.table_id and x.expected ? c.airtable_field_id and c.reconcile in ('APPLY_VIA_HANDLER','REPAIR_AIRTABLE','PROJECTION')
join airtable_observations o on o.table_id = x.table_id and o.record_id = x.record_id and o.field_id = c.airtable_field_id
where not at_matches(x.expected -> c.airtable_field_id, to_jsonb(o.value));

-- Dashboard projects: the migration 1100 definition, unchanged, plus freshness / sync columns appended at the end.
create or replace view v_dashboard_projects as
with final_inv as (
  select distinct on (i.project_id) i.project_id, i.id as invoice_id, i.invoice_number, i.status, i.sync_status, i.total_inc_gst
  from invoices i where i.invoice_type = 'FINAL' and i.status <> 'VOIDED'
  order by i.project_id, i.created_at desc
), pending_approval as (
  select distinct on (a.entity_id) a.entity_id as project_id, a.approval_number,
         (a.action_payload ->> 'amount_inc_gst')::numeric(12,2) as amount_inc_gst, a.expires_at
  from approvals a where a.action_type = 'CREATE_INVOICE' and a.status = 'PENDING' and a.expires_at > now()
  order by a.entity_id, a.created_at desc
), readiness as (
  select p.id as project_id, invoice_final_preview(p.id) as x from projects p where p.status = 'COMPLETED'
), po as (
  select v.project_id, count(*) as n,
         count(*) filter (where v.status = 'DELIVERED') as delivered,
         count(*) filter (where v.status = 'PARTIALLY_DELIVERED') as part_delivered,
         count(*) filter (where v.status = 'ACKNOWLEDGED') as confirmed,
         count(*) filter (where v.status = 'SENT') as sent,
         count(*) filter (where v.status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED')) as in_preparation,
         bool_or(v.ack_overdue) as ack_overdue,
         max(v.expected_delivery_date) filter (where v.status not in ('DELIVERED', 'CANCELLED')) as latest_open_eta
  from v_purchase_order_status v where v.project_id is not null and v.status <> 'CANCELLED'
  group by v.project_id
), bal as (
  select project_id, count(*) as invoices, bool_or(is_overdue) as has_overdue,
         coalesce(sum(outstanding) filter (where status in ('ISSUED', 'PARTIALLY_PAID')), 0) as outstanding
  from v_invoice_balances group by project_id
), exc as (
  select p.id as project_id, count(*) as open_exceptions
  from projects p join quotes q on q.id = p.quote_id
  join workflow_exceptions w on w.resolution_status in ('OPEN', 'RETRY_QUEUED')
   and (w.entity_id = p.id or w.business_reference in (p.project_number, q.quote_number))
  group by p.id
)
select p.id, p.project_number, p.status, r.is_active,
       c.customer_number, btrim(c.display_name) as customer_name, c.customer_type,
       r.site_address, r.project_manager,
       q.quote_number, qv.version_number as quote_version, qv.total_inc_gst as quote_total_inc_gst, q.job_type, q.accepted_on,
       p.planned_start_date, p.planned_completion_date, p.actual_start_date, p.actual_completion_date,
       r.risk_level, r.risk_reasons, p.delay_reason,
       case
         when not r.is_active then 'JOB_COMPLETE'
         when po.n is null then case when exists (select 1 from tasks t where t.project_id = p.id and t.task_type = 'MATERIAL_REVIEW' and t.status = 'OPEN')
                                     then 'REVIEW_PENDING' else 'NOT_ORDERED' end
         when po.ack_overdue then 'CONFIRMATION_OVERDUE'
         when po.delivered = po.n then 'DELIVERED'
         when po.part_delivered > 0 then 'PART_DELIVERED'
         when po.sent > 0 then 'AWAITING_CONFIRMATION'
         when po.in_preparation > 0 then 'ORDER_IN_PREPARATION'
         else 'CONFIRMED'
       end as material_status,
       exists (select 1 from v_projects_waiting_on_materials w where w.project_number = p.project_number) as waiting_on_materials,
       po.latest_open_eta as material_eta, coalesce(po.n, 0) as purchase_orders,
       case
         when fi.invoice_id is not null then case fi.sync_status
                                               when 'SYNCED' then 'XERO_DRAFT_CREATED' when 'PENDING' then 'CREATING_IN_XERO'
                                               when 'UNKNOWN' then 'CHECKING_WITH_XERO' when 'FAILED' then 'XERO_FAILED_SAFELY'
                                               else 'FINAL_INVOICED' end
         when pa.approval_number is not null then 'AWAITING_APPROVAL'
         when (rd.x ->> 'ok')::boolean then 'READY_TO_INVOICE'
         when rd.x ->> 'error_class' = 'ARITHMETIC_MISMATCH' then 'FULLY_INVOICED'
         when rd.x is not null then 'NOT_READY'
         when bal.has_overdue then 'PAYMENT_OVERDUE'
         when bal.invoices > 0 then 'PROGRESS_INVOICED'
         else 'NOT_YET_DUE'
       end as invoice_status,
       case when rd.x is not null and not (rd.x ->> 'ok')::boolean and rd.x ->> 'error_class' <> 'ARITHMETIC_MISMATCH' and fi.invoice_id is null
            then rd.x ->> 'message' end as invoice_blocker,
       coalesce(fi.total_inc_gst, pa.amount_inc_gst, (rd.x -> 'preview' ->> 'amount_inc_gst')::numeric(12,2)) as invoice_amount_inc_gst,
       fi.invoice_number as final_invoice_number, fi.sync_status as final_invoice_sync,
       xi.external_id as xero_invoice_id,
       case when xi.external_id is not null then (select value from app_settings where key = 'xero.invoice_number_prefix') || fi.invoice_number end as xero_invoice_number,
       pa.approval_number as pending_approval_number,
       coalesce(bal.outstanding, 0) as outstanding_inc_gst, coalesce(bal.has_overdue, false) as has_overdue_invoice,
       coalesce(exc.open_exceptions, 0) as open_exceptions,
       drive.external_url as drive_folder_url,
       at.external_id as airtable_record_id,
       coalesce((r.is_active and r.risk_level = 'HIGH') or coalesce(exc.open_exceptions, 0) > 0 or coalesce(bal.has_overdue, false)
         or pa.approval_number is not null or fi.sync_status in ('UNKNOWN', 'FAILED'), false) as needs_attention
       ,
       coalesce((select x.last_source_at from external_field_versions x where x.entity_type = 'project' and x.entity_id = p.id and x.field_key = 'status'),
                p.updated_at) as status_changed_at,
       ao.value as airtable_status_seen, ao.observed_at as airtable_status_seen_at,
       (select count(*) from v_state_drift s where s.entity_type = 'project' and s.entity_id = p.id)::int as drift_fields,
       (select max(finished_at) from reconciliation_runs where status = 'COMPLETED') as last_reconciled_at
from projects p
join v_project_risk r on r.id = p.id
join customers c on c.id = p.customer_id
join quotes q on q.id = p.quote_id
left join quote_versions qv on qv.id = p.accepted_quote_version_id
left join po on po.project_id = p.id
left join final_inv fi on fi.project_id = p.id
left join pending_approval pa on pa.project_id = p.id
left join readiness rd on rd.project_id = p.id
left join bal on bal.project_id = p.id
left join exc on exc.project_id = p.id
left join external_links xi on xi.provider = 'XERO' and xi.entity_type = 'invoice' and xi.external_type = 'Invoice'
                           and xi.entity_id = fi.invoice_id and xi.verified_at is not null
left join external_links drive on drive.provider = 'GOOGLE_DRIVE' and drive.entity_type = 'project' and drive.external_type = 'Folder'
                              and drive.entity_id = p.id and drive.verified_at is not null
left join external_links at on at.provider = 'AIRTABLE' and at.entity_type = 'project' and at.external_type = 'Record' and at.entity_id = p.id
left join airtable_observations ao on ao.table_id = 'tblvUPIoebC3zoacv' and ao.record_id = at.external_id and ao.field_id = 'fldi2Qwz1dAh2tcTE';

-- -----------------------------------------------------------------------------
-- 9b. Bug found by the concurrency audit: an invoice approval did not lock the project row, so it could interleave with a
--     cancellation (both read COMPLETED). Every project-changing entry point now serialises on the project row:
--     wf_invoice_prepare (already did), wf_invoice_decide (now), wf_airtable_change (new). Business logic is unchanged.
-- -----------------------------------------------------------------------------
create or replace function wf_invoice_decide(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_res jsonb;
begin
  perform 1 from projects where project_number = p_event -> 'payload' ->> 'project_number' for update;
  v_res := wf_invoice_decide_core(p_event, p_worker);
  if v_res ->> 'outcome' = 'ALREADY_PROCESSED' and v_res ? 'invoice_id' then
    v_res := v_res || jsonb_build_object('xero_state', invoice_xero_state((v_res ->> 'invoice_id')::uuid));
  end if;
  return v_res;
end $$;
grant execute on function wf_invoice_decide(jsonb, text) to roofops_workflow;

-- -----------------------------------------------------------------------------
-- 10. Executable invariants (npm run integrity:check). FAIL = a rule is broken; WARNING = needs a look.
-- -----------------------------------------------------------------------------
create or replace function integrity_check()
returns table (entity text, check_key text, status text, failing int, detail text, refs text[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_refs text[]; v_n bigint;
begin
  entity := 'project'; check_key := 'cancelled_never_ready_to_invoice';
  select array_agg(d.project_number order by d.project_number) into v_refs from v_dashboard_projects d
   where d.status in ('CANCELLED', 'CLOSED') and d.invoice_status in ('READY_TO_INVOICE', 'AWAITING_APPROVAL');
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'A cancelled or closed project is never ready to invoice and has no invoice awaiting approval'; return next;

  check_key := 'only_completed_can_be_prepared';
  select array_agg(p.project_number order by p.project_number) into v_refs from projects p
   where p.status <> 'COMPLETED' and (invoice_final_preview(p.id) ->> 'ok')::boolean;
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Only a COMPLETED project yields an invoice preview (cancelled ones cannot be prepared)'; return next;

  check_key := 'completed_has_finish_date';
  select array_agg(p.project_number order by p.project_number) into v_refs from projects p
   where p.status in ('COMPLETED', 'CLOSED') and p.actual_completion_date is null;
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Completed/closed projects have an actual completion date'; return next;

  check_key := 'started_has_start_date';
  select array_agg(p.project_number order by p.project_number) into v_refs from projects p
   where p.status in ('IN_PROGRESS', 'COMPLETED', 'CLOSED') and p.actual_start_date is null;
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Started projects have an actual start date'; return next;

  check_key := 'reason_recorded';
  select array_agg(p.project_number order by p.project_number) into v_refs from projects p
   where (p.status = 'CANCELLED' and p.cancellation_reason is null) or (p.status = 'ON_HOLD' and p.on_hold_reason is null);
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Cancelled / on-hold projects carry a reason'; return next;

  check_key := 'created_from_accepted_quote';
  select array_agg(p.project_number order by p.project_number) into v_refs from projects p join quotes q on q.id = p.quote_id where q.status <> 'ACCEPTED';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every project comes from an ACCEPTED quote'; return next;

  check_key := 'cancelled_has_no_open_work';
  select array_agg(distinct p.project_number) into v_refs from projects p
   where p.status = 'CANCELLED' and (exists (select 1 from tasks t where t.project_id = p.id and t.status in ('OPEN', 'IN_PROGRESS'))
      or exists (select 1 from approvals a where a.entity_id = p.id and a.action_type = 'CREATE_INVOICE' and a.status in ('PENDING', 'APPROVED')));
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'A cancelled project has no open tasks and no pending invoice approval'; return next;

  check_key := 'cancelled_open_purchase_orders';
  select array_agg(distinct p.project_number) into v_refs from projects p join purchase_orders po on po.project_id = p.id
   where p.status = 'CANCELLED' and po.status in ('APPROVED', 'SENT', 'ACKNOWLEDGED', 'PARTIALLY_DELIVERED');
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Cancelled projects with supplier orders still open (cancel or re-assign them)'; return next;

  check_key := 'dashboard_status_is_canonical';
  select array_agg(d.project_number) into v_refs from v_dashboard_projects d join projects p on p.id = d.id where d.status is distinct from p.status;
  select count(*) into v_n from projects p where not exists (select 1 from v_dashboard_projects d where d.id = p.id);
  status := case when v_refs is null and v_n = 0 then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0) + v_n::int; refs := v_refs;
  detail := 'Dashboard status is read from canonical projects.status for every project'; return next;

  entity := 'quote'; check_key := 'accepted_at_most_one_project';
  select array_agg(q.quote_number) into v_refs from quotes q where (select count(*) from projects p where p.quote_id = q.id) > 1;
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'An accepted quote has at most one project'; return next;

  check_key := 'accepted_has_project';
  select array_agg(q.quote_number order by q.quote_number) into v_refs from quotes q
   where q.status = 'ACCEPTED' and not exists (select 1 from projects p where p.quote_id = q.id);
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Accepted quotes without a project (acceptance not yet processed)'; return next;

  entity := 'invoice'; check_key := 'one_final_per_project';
  select array_agg(p.project_number) into v_refs from projects p
   where (select count(*) from invoices i where i.project_id = p.id and i.invoice_type = 'FINAL' and i.status <> 'VOIDED') > 1;
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'At most one non-void FINAL invoice per project'; return next;

  check_key := 'xero_synced_has_verified_link';
  select array_agg(i.invoice_number) into v_refs from invoices i where i.sync_status = 'SYNCED'
     and not exists (select 1 from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id and l.verified_at is not null);
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Xero sync DONE only with a read-back-verified Xero invoice link'; return next;

  check_key := 'xero_link_only_when_synced';
  select array_agg(i.invoice_number) into v_refs from invoices i join external_links l on l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id
   where i.sync_status <> 'SYNCED';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'No Xero link on an invoice RoofOps does not consider synced'; return next;

  check_key := 'xero_synced_approval_executed';
  select array_agg(i.invoice_number) into v_refs from invoices i left join approvals a on a.id = i.approval_id
   where i.record_origin = 'ROOFOPS' and i.sync_status = 'SYNCED' and a.status is distinct from 'EXECUTED';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every invoice in Xero came from an EXECUTED human approval'; return next;

  entity := 'approval'; check_key := 'executed_by_valid_approver';
  select array_agg(a.approval_number) into v_refs from approvals a left join employees e on e.id = a.decided_by
   where a.status in ('EXECUTING', 'EXECUTED', 'EXECUTION_FAILED', 'APPROVED') and a.action_type = 'CREATE_INVOICE'
     and (e.id is null or not (e.role = any (string_to_array((select value from app_settings where key = 'invoice.approver_roles'), ','))));
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Approved/executed invoice approvals were decided by an authorised approver'; return next;

  check_key := 'pending_preview_current';
  select array_agg(a.approval_number) into v_refs from approvals a
   cross join lateral (select invoice_final_preview(a.entity_id) as x) pv
   where a.status = 'PENDING' and a.action_type = 'CREATE_INVOICE' and a.expires_at > now()
     and (case when (pv.x ->> 'ok')::boolean then invoice_preview_hash(pv.x -> 'preview') end) is distinct from a.payload_hash;
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Pending previews still match the invoice RoofOps would create (a stale one is refused at approval)'; return next;

  entity := 'side_effect'; check_key := 'done_has_proof';
  select array_agg(o.topic || ':' || o.aggregate_id) into v_refs from outbox o
   where o.status = 'DONE' and not case o.topic
     when 'drive.ensure_project_folder' then exists (select 1 from external_links l where l.provider = 'GOOGLE_DRIVE' and l.entity_type = 'project'
                                                       and l.external_type = 'Folder' and l.entity_id = o.aggregate_id and l.verified_at is not null)
     when 'airtable.project_writeback' then exists (select 1 from external_links l where l.provider = 'AIRTABLE' and l.entity_type = 'project'
                                                      and l.external_type = 'Record' and l.entity_id = o.aggregate_id and l.verified_at is not null)
     when 'xero.create_draft_invoice' then exists (select 1 from invoices i where i.id = o.aggregate_id and i.sync_status = 'SYNCED')
     else true end;
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every DONE side effect (Drive folder, Airtable write-back, Xero draft) has verified proof'; return next;

  check_key := 'dead_letters';
  select array_agg(o.topic || ':' || o.aggregate_id) into v_refs from outbox o where o.status = 'FAILED' and o.next_attempt_at = 'infinity';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Side effects that stopped after their retry budget (each has an open exception)'; return next;

  entity := 'state_machine'; check_key := 'every_status_is_a_known_state';
  select array_agg(u.x) into v_refs from (
    select 'project:' || t.status as x from projects t where not exists (select 1 from state_machine_states s where s.machine = 'project' and s.state = t.status)
    union all select 'quote:' || t.status from quotes t where not exists (select 1 from state_machine_states s where s.machine = 'quote' and s.state = t.status)
    union all select 'po:' || t.status from purchase_orders t where not exists (select 1 from state_machine_states s where s.machine = 'purchase_order' and s.state = t.status)
    union all select 'invoice:' || t.status from invoices t where not exists (select 1 from state_machine_states s where s.machine = 'invoice' and s.state = t.status)
    union all select 'approval:' || t.status from approvals t where not exists (select 1 from state_machine_states s where s.machine = 'approval' and s.state = t.status)) u;
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every stored status is a state of its machine'; return next;

  check_key := 'transition_enforcement_installed';
  select array_agg(t.n) into v_refs from unnest(array['projects_state_machine','quotes_state_machine','purchase_orders_state_machine','invoices_state_machine',
      'invoices_sync_state_machine','approvals_state_machine','workflow_exceptions_state_machine','tasks_state_machine','checklist_state_machine',
      'outbox_state_machine']) as t(n)
   where not exists (select 1 from pg_trigger g where g.tgname = t.n and g.tgenabled <> 'D');
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'State-machine triggers are installed and enabled'; return next;

  entity := 'audit'; check_key := 'hash_chain_intact';
  v_n := verify_audit_chain();
  status := case when v_n is null then 'PASS' else 'FAIL' end; failing := case when v_n is null then 0 else 1 end;
  refs := case when v_n is null then null else array['seq ' || v_n] end;
  detail := 'The audit trail hash chain verifies end to end'; return next;

  entity := 'airtable'; check_key := 'drift';
  select array_agg(distinct d.business_key || ' ' || d.field || ': Airtable "' || coalesce(d.airtable_value, 'blank') || '" vs RoofOps "'
                   || coalesce(d.canonical_value, 'blank') || '"') into v_refs from v_state_drift d;
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Last observed Airtable values match canonical state'; return next;

  check_key := 'every_project_linked';
  select array_agg(p.project_number) into v_refs from projects p
   where not exists (select 1 from external_links l where l.provider = 'AIRTABLE' and l.entity_type = 'project' and l.external_type = 'Record' and l.entity_id = p.id);
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every project has its Airtable record'; return next;

  entity := 'reconciliation'; check_key := 'recent';
  select extract(epoch from now() - max(r.finished_at))::bigint into v_n from reconciliation_runs r where r.status = 'COMPLETED';
  status := case when v_n is null or v_n > 26 * 3600 then 'WARNING' else 'PASS' end; failing := case when status = 'PASS' then 0 else 1 end;
  refs := null; detail := case when v_n is null then 'No reconciliation has completed yet' else format('Last reconciliation finished %s minutes ago', v_n / 60) end;
  return next;

  entity := 'workflow_exception'; check_key := 'open';
  select array_agg(w.exception_number || ' ' || coalesce(w.business_reference, '') order by w.exception_number) into v_refs from workflow_exceptions w
   where w.resolution_status in ('OPEN', 'RETRY_QUEUED');
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Open exceptions waiting for a person'; return next;
end $$;

-- -----------------------------------------------------------------------------
-- 11. Security: RLS on new tables, no PUBLIC execute, explicit grants only.
-- -----------------------------------------------------------------------------
alter table state_machine_states enable row level security;
alter table state_transitions enable row level security;
alter table field_contract enable row level security;
alter table external_field_versions enable row level security;
alter table airtable_observations enable row level security;
alter table reconciliation_runs enable row level security;
alter table reconciliation_findings enable row level security;
alter table integration_health enable row level security;
revoke all on state_machine_states, state_transitions, field_contract, external_field_versions, airtable_observations,
              reconciliation_runs, reconciliation_findings, integration_health from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on state_machine_states, state_transitions, field_contract, external_field_versions, airtable_observations, '
         || 'reconciliation_runs, reconciliation_findings, integration_health from anon, authenticated';
  end if;
end $$;
revoke execute on all functions in schema public from public;

-- n8n (06 change capture, 07 reconciliation, 08 health) calls only these entry points.
grant execute on function wf_airtable_change(jsonb, text), wf_airtable_writeback_verified(text, text, text, jsonb),
  wf_reconcile_start(text, text, text), wf_reconcile_airtable(text, text, jsonb), wf_reconcile_targets(text),
  wf_reconcile_external(text, text, jsonb), wf_reconcile_finish(text, jsonb, jsonb), wf_record_health(jsonb) to roofops_workflow;

-- The dashboard reads health, drift and freshness; it cannot write any of it. The pure helpers below are what those views evaluate.
grant execute on function at_norm(jsonb), at_title(text), at_link(text, uuid), at_matches(jsonb, jsonb), at_repair_value(jsonb), sm_label(text, text)
  to roofops_dashboard;
grant select on v_dashboard_projects, v_system_health, v_reconciliation_latest, v_reconciliation_findings_latest, v_state_drift to roofops_dashboard;
