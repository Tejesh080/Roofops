-- AC-13B (docs/defect-ledger.md): a job could go Scheduled -> In Progress with the required PRE_START items (SWMS signed,
-- materials reviewed) still OPEN. wf_quote_accepted creates them OPEN, nothing could set them, and the transition checked
-- only a Planned Start. Hosted: PRJ-2026-0031..0033 (born from quotes, Planning) could start with no SWMS signed.
--
-- Invariant: a project enters In Progress only if every required PRE_START item is Done, or Waived / Not applicable
-- with a reason where the business rules allow it. Business rule (owner, 2026-10-06): a SWMS can only be Done
-- (setting checklist.not_waivable); materials review may be Done, Waived or Not applicable with a reason.
-- Pre-start items change only through Airtable (SWMS Signed / Materials Reviewed + a Note each). Postgres enforces the
-- checklist state machine, the reason, attribution to a mapped RoofOps employee (a reconciler replay has none), and a
-- lock once work has started (the checklist was the gate) or the job is Closed / Cancelled.
-- Owner decision: imported projects keep their historical shape (they have no PRE_START items; the gate is vacuous).
-- Completion items (AC-13A) are unchanged.
-- Ported from the offline WIP 491f1da onto the latest definitions: each function below is its latest source with only the
-- pre-start delta applied. The prior text of every function and view is in the rollback file.

-- 1. Field contract and settings (WIP 491f1da, unchanged apart from the header).
insert into field_contract (entity, field_key, airtable_table_id, airtable_field_id, airtable_name, canonical, owner, editable_in, change_path, validation, event_generated, downstream, readback, reconcile, ai_visible) values
  ('project','swms_signed','tblvUPIoebC3zoacv','fldM6kgPz6QZagPAC','SWMS Signed','project_checklist_items SWMS_SIGNED .status','AIRTABLE_EDIT','Airtable Projects.SWMS Signed','Airtable webhook → n8n 06 → wf_airtable_change → checklist_apply_change','state_transitions(checklist_item); Done only (checklist.not_waivable); mapped RoofOps employee; locked once work has started or the job is Closed / Cancelled','project.checklist.changed','In Progress gate, dashboard, Copilot','06 read-back; reconciliation','APPLY_VIA_HANDLER',true),
  ('project','swms_signed_note','tblvUPIoebC3zoacv','fldNcsIgH6TfQFfaU','SWMS Signed Note','project_checklist_items SWMS_SIGNED (audit reason)','INPUT','Airtable (read with SWMS Signed)','read by wf_airtable_change with SWMS Signed','free text','(part of project.checklist.changed)','audit','n/a','IGNORE',true),
  ('project','materials_reviewed','tblvUPIoebC3zoacv','fldozWSCU877wEZHq','Materials Reviewed','project_checklist_items MATERIALS_REVIEWED .status','AIRTABLE_EDIT','Airtable Projects.Materials Reviewed','Airtable webhook → n8n 06 → wf_airtable_change → checklist_apply_change','state_transitions(checklist_item); Waived / Not applicable need Materials Reviewed Note; mapped RoofOps employee; locked once work has started or the job is Closed / Cancelled','project.checklist.changed','In Progress gate, dashboard, Copilot','06 read-back; reconciliation','APPLY_VIA_HANDLER',true),
  ('project','materials_reviewed_note','tblvUPIoebC3zoacv','fldEtAmAokIvtzJdn','Materials Reviewed Note','project_checklist_items MATERIALS_REVIEWED .waived_reason','INPUT','Airtable (read with Materials Reviewed)','read by wf_airtable_change with Materials Reviewed','free text; required for Waived / Not applicable','(part of project.checklist.changed)','audit','n/a','IGNORE',true);
update field_contract set editable_in = 'COMPLETION items: Airtable Projects.Completion Photos / Compliance Certificate (AC-13A); PRE_START items: Airtable Projects.SWMS Signed / Materials Reviewed (AC-13B)',
       change_path = 'created by wf_quote_accepted; changed by checklist_apply_change'
 where entity = 'checklist' and field_key = 'items';

insert into app_settings (key, value) values ('checklist.not_waivable', 'SWMS_SIGNED') on conflict (key) do nothing;

-- 2. checklist_apply_change: latest 20261001110000_completion_gate_has_a_supported_path.sql + pre-start delta.
create or replace function checklist_apply_change(p_id uuid, p_item text, p_value text, p_note text, p_actor text, p_event_key text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare p projects; ci project_checklist_items; v_to text; v_emp employees; v_final text;
  v_field text := case p_item when 'COMPLETION_PHOTOS' then 'Completion Photos' when 'COMPLIANCE_CERTIFICATE' then 'Compliance Certificate'
                             when 'SWMS_SIGNED' then 'SWMS Signed' when 'MATERIALS_REVIEWED' then 'Materials Reviewed' else initcap(replace(lower(p_item), '_', ' ')) end;
begin
  -- AC-13B: the project row is locked first, the same lock a project update takes, so a checklist change and a Scheduled -> In
  -- Progress transition on the same job serialise (the gate reads the items the other side has just written).
  select * into p from projects where id = p_id for update;
  v_to := case btrim(coalesce(p_value, '')) when 'To do' then 'OPEN' when 'Done' then 'DONE' when 'Waived' then 'WAIVED' when 'Not applicable' then 'NOT_APPLICABLE' end;
  if v_to is null then return format('"%s" is not a checklist value (use To do, Done, Waived or Not applicable)', coalesce(p_value, 'blank')); end if;
  select * into ci from project_checklist_items where project_id = p_id and item_code = p_item for update;
  if ci.id is null then
    return format('%s has no %s item (not required for this project)', p.project_number, initcap(replace(lower(p_item), '_', ' ')));
  end if;
  if ci.status = v_to then return null; end if;
  if p.status in ('CLOSED', 'CANCELLED') then
    return format('the checklist is locked: %s is %s', p.project_number, lower(sm_label('project', p.status)));
  end if;
  -- AC-13B: the pre-start checklist is the gate into In Progress; once work has started it is history, not editable.
  if ci.stage = 'PRE_START' and (p.actual_start_date is not null or p.status in ('IN_PROGRESS', 'COMPLETED')) then
    return format('the pre-start checklist is locked: work on %s has started (%s)', p.project_number, lower(sm_label('project', p.status)));
  end if;
  select string_agg(invoice_number, ', ') into v_final from invoices where project_id = p_id and invoice_type = 'FINAL' and status <> 'VOIDED';
  if v_final is not null then
    return format('the completion checklist is locked: final invoice %s already exists', v_final);
  end if;
  if exists (select 1 from approvals where entity_id = p_id and action_type = 'CREATE_INVOICE' and status in ('APPROVED', 'EXECUTING')) then
    return 'the completion checklist is locked: the final invoice is being created in Xero right now';
  end if;
  -- AC-13B: a pre-start item may be Done while the job is still Scheduled; every other item keeps the rule it had.
  if v_to = 'DONE' and ci.stage <> 'PRE_START' and p.actual_start_date is null then
    return format('work has not started on %s; a completion item can be Done only once the job is In Progress', p.project_number);
  end if;
  if not state_transition_allowed('checklist_item', ci.status, v_to) then
    return format('%s → %s is not an allowed change; set it back to To do first', checklist_at_label(ci.status), checklist_at_label(v_to));
  end if;
  select e.* into v_emp from employee_external_identities x join employees e on e.id = x.employee_id
   where x.provider = 'AIRTABLE' and x.external_id = p_actor and e.is_active;
  if v_emp.id is null then
    return case when p_actor = 'reconciliation'
      then 'a missed Airtable change has no Airtable user, so it cannot be attributed; set it again in Airtable'
      else format('Airtable user %s is not mapped to a RoofOps employee; checklist changes must be attributable', p_actor) end;
  end if;
  -- AC-13B: some items may never be waived or marked not applicable (business rule; setting checklist.not_waivable).
  if v_to in ('WAIVED', 'NOT_APPLICABLE') and p_item = any (string_to_array(replace(coalesce((select value from app_settings where key = 'checklist.not_waivable'), ''), ' ', ''), ',')) then
    return format('%s cannot be waived or marked not applicable; it must be Done', v_field);
  end if;
  if v_to in ('WAIVED', 'NOT_APPLICABLE') and p_note is null then
    return format('%s needs a reason in %s Note', checklist_at_label(v_to), v_field);
  end if;
  update project_checklist_items set status = v_to,
    completed_on = case when v_to = 'DONE' then app_today() end,
    completed_by = case when v_to = 'DONE' then v_emp.id end,
    waived_reason = case when v_to in ('WAIVED', 'NOT_APPLICABLE') then p_note end
  where id = ci.id;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
  values ('USER', p_actor, 'project.checklist.changed', 'project', p_id, p.project_number,
          jsonb_build_object('item', p_item, 'status', ci.status),
          jsonb_build_object('item', p_item, 'status', v_to, 'employee', v_emp.employee_code, 'reason', p_note),
          coalesce(p_note, v_field || ' set to ' || checklist_at_label(v_to) || ' in Airtable') || ' [' || p_event_key || ']');
  return null;
end $$;

-- 3. project_apply_change: latest 20261001110000_completion_gate_has_a_supported_path.sql + pre-start delta.
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
  elsif p_field in ('swms_signed', 'materials_reviewed') then
    -- AC-13B: the pre-start gate's supported path (Airtable → 06 → here); the note is read with the change.
    return checklist_apply_change(p_id, upper(p_field), p_value,
      nullif(btrim(p_current ->> case p_field when 'swms_signed' then 'fldNcsIgH6TfQFfaU' else 'fldEtAmAokIvtzJdn' end), ''), p_actor, p_event_key);
  elsif p_field in ('completion_photos', 'compliance_certificate') then
    -- AC-13A: the completion gate's supported path (Airtable → 06 → here); the note is read with the change.
    return checklist_apply_change(p_id, upper(p_field), p_value,
      nullif(btrim(p_current ->> case p_field when 'completion_photos' then 'fldA77ad94yUmvnu3' else 'fldLi9FkGDFAbf0QB' end), ''), p_actor, p_event_key);
  end if;
  return 'this field cannot be changed from Airtable';
end $$;

-- 4. v_airtable_expected: latest 20261017000000_airtable_shows_dashboard_approved_invoice.sql + two pre-start fields.
create or replace view v_airtable_expected as
select 'tblvUPIoebC3zoacv'::text as table_id, 'project'::text as entity_type, p.id as entity_id, p.project_number as business_key, l.external_id as record_id,
  jsonb_strip_nulls(jsonb_build_object(
    'fldhhnQXlbuFaveK3', p.project_number, 'fld08eKCeuDCsJLjz', at_link('quote', p.quote_id), 'fldG4mPoV6sUkA9rM', at_link('customer', p.customer_id),
    'fldi2Qwz1dAh2tcTE', sm_label('project', p.status), 'fldc4T0AgU3zCmANC', p.id::text)) ||
  jsonb_build_object(
    'fldnZcRBxG7hTebD5', to_jsonb(e.full_name), 'fld8rf6RZLgfs6Ron', to_jsonb(p.planned_start_date::text), 'fldvZtiassZEgLMAN', to_jsonb(p.planned_completion_date::text),
    'fldIje5e0a72cBfVD', to_jsonb(p.actual_start_date::text), 'fldWKRobTLlOjeN9j', to_jsonb(p.actual_completion_date::text),
    'fldgVDT29UOOOtlqO', to_jsonb((select d.external_url from external_links d where d.provider = 'GOOGLE_DRIVE' and d.entity_type = 'project'
                                     and d.external_type = 'Folder' and d.entity_id = p.id and d.verified_at is not null)),
    -- AC-13A: completion gate (the label staff pick in Airtable; blank where the project has no such item).
    'fldbbksVL3dT6cqyS', to_jsonb((select checklist_at_label(ci.status) from project_checklist_items ci where ci.project_id = p.id and ci.item_code = 'COMPLETION_PHOTOS')),
    'fldf7iJiyHFxOQgUy', to_jsonb((select checklist_at_label(ci.status) from project_checklist_items ci where ci.project_id = p.id and ci.item_code = 'COMPLIANCE_CERTIFICATE')),
    -- AC-13B: pre-start gate (blank where the project has no such item, e.g. imported projects).
    'fldM6kgPz6QZagPAC', to_jsonb((select checklist_at_label(ci.status) from project_checklist_items ci where ci.project_id = p.id and ci.item_code = 'SWMS_SIGNED')),
    'fldozWSCU877wEZHq', to_jsonb((select checklist_at_label(ci.status) from project_checklist_items ci where ci.project_id = p.id and ci.item_code = 'MATERIALS_REVIEWED'))) ||
  -- Invoice projection, only where canonical invoice state is stable (never mid-flight).
  case
    when fi.sync_status = 'SYNCED' then jsonb_build_object('fldPuGgo27oWLKB5R', 'Xero draft created', 'fld5JDnWI3RFehQxA', fi.total_inc_gst,
      -- The current generation's number, written out rather than called: a function inside a view is executed with the
      -- CALLER's privileges (PostgreSQL), and roofops_dashboard reads this view - it must not need outbox_current, a
      -- SECURITY DEFINER function (scripts/security-check.ts pins exactly which of those the dashboard role may run).
      -- Same rule as outbox_current(): greatest generation for the invoice, ties broken by created_at then id.
      'fldgkN0Vm6k1MZLJp', (select o.payload ->> 'xero_invoice_number' from outbox o
                             where o.topic = 'xero.create_draft_invoice' and o.aggregate_id = fi.id
                             order by o.generation desc, o.created_at desc, o.id desc limit 1),
      'fld3sDI9LIX8Voo4u', (select external_id from external_links where provider = 'XERO' and external_type = 'Invoice' and entity_id = fi.id and verified_at is not null))
      -- REISSUE-UI-01: a reissued final (current generation >= 2, created) shows its CURRENT Xero identity in Invoice Preview,
      -- replacing the generation-1 text 04 wrote. Plain SQL only (no SECURITY DEFINER calls: the dashboard role reads this view).
      || coalesce((select jsonb_build_object('fldt9KIOPXh3c3pGU',
           'XERO DRAFT ' || g.xero_invoice_number || ' (InvoiceID ' || g.xero_invoice_id || ') in ' || coalesce(nullif(btrim(ap.action_payload -> 'draft' ->> 'xero_tenant_name'), ''), 'the Xero Demo Company')
           || E'\nReissued under ' || ap.approval_number || ': requested by ' || coalesce(re.full_name, 'unknown') || ', approved by ' || coalesce(de.full_name, 'unknown')
           || E'\nReplaces InvoiceID ' || coalesce(prev.xero_invoice_id, 'unknown') || ', which is no longer a valid invoice in Xero'
           || E'\nProject: ' || p.project_number || '   Invoice: ' || fi.invoice_number
           || E'\nAmount: ' || to_char(fi.total_inc_gst, 'FM$999,999,990.00') || ' inc GST  (GST ' || to_char(fi.gst_amount, 'FM$999,999,990.00') || ')'
           || E'\nDraft only, in the Xero Demo Company: RoofOps never sends or pays it')
         from invoice_xero_draft_generations g
         join approvals ap on ap.id = g.approval_id
         left join employees re on re.id = ap.requested_by_employee_id
         left join employees de on de.id = ap.decided_by
         left join invoice_xero_draft_generations prev on prev.invoice_id = g.invoice_id and prev.generation = g.generation - 1
         where g.invoice_id = fi.id and g.superseded_at is null and g.generation >= 2 and g.status = 'CREATED'
           and g.xero_invoice_id is not null and g.xero_invoice_number is not null),
         -- STAFF-OPS-02: a first-issue final approved in the RoofOps dashboard (sent by n8n 09 -> 05, which never writes Airtable)
         -- shows its Xero identity too, replacing whatever 04 last wrote there (e.g. an earlier "Not eligible" reason). Finals
         -- approved through Airtable keep the text 04 wrote and read back (not compared).
         (select jsonb_build_object('fldt9KIOPXh3c3pGU',
           'XERO DRAFT ' || g.xero_invoice_number || ' (InvoiceID ' || g.xero_invoice_id || ') in ' || coalesce(nullif(btrim(ap.action_payload ->> 'xero_tenant_name'), ''), 'the Xero Demo Company')
           || E'\nApproved in the RoofOps dashboard under ' || ap.approval_number || ': prepared by ' || coalesce(re.full_name, 'unknown') || ', approved by ' || coalesce(de.full_name, 'unknown')
           || E'\nProject: ' || p.project_number || '   Invoice: ' || fi.invoice_number
           || E'\nAmount: ' || to_char(fi.total_inc_gst, 'FM$999,999,990.00') || ' inc GST  (GST ' || to_char(fi.gst_amount, 'FM$999,999,990.00') || ')'
           || E'\nDraft only, in the Xero Demo Company: RoofOps never sends or pays it')
         from invoice_xero_draft_generations g
         join approvals ap on ap.id = g.approval_id
         left join employees re on re.id = ap.requested_by_employee_id
         left join employees de on de.id = ap.decided_by
         where g.invoice_id = fi.id and g.superseded_at is null and g.generation = 1 and g.status = 'CREATED'
           and ap.idempotency_key like 'approval:dashboard:%'
           and g.xero_invoice_id is not null and g.xero_invoice_number is not null), '{}'::jsonb)   -- never a null (blank) preview
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
join external_links l on l.provider = 'AIRTABLE' and l.entity_type = 'supplier' and l.external_type = 'Record' and l.entity_id = s.id;;

-- 5. project_transition_guard: latest 20261001120000_xero_verified_invoice_settlement.sql + pre-start gate.
create or replace function project_transition_guard(p projects, p_to text)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_final text; v_over jsonb; v_bill jsonb; v_open text;
begin
  -- AC-08: an over-billed job is never closed; a person corrects the billing first (no credit-note model).
  if p_to = 'CLOSED' then
    v_over := project_over_billing(p.id);
    if v_over is not null then
      return format('%s cannot be closed: it is over-billed by %s (billed %s against %s: %s). Correct the billing first, for example void the unpaid duplicate invoice',
        p.project_number, v_over ->> 'excess', v_over ->> 'billed', v_over ->> 'entitled', v_over ->> 'invoices');
    end if;
  end if;
  if p_to = 'IN_PROGRESS' and p.status = 'SCHEDULED' and p.planned_start_date is null then
    return 'set a Planned Start before marking the job In Progress';
  end if;
  if p_to = 'IN_PROGRESS' and p.status = 'ON_HOLD' and p.actual_start_date is null then
    return 'this job never started; move it back to Scheduled instead of In Progress';
  end if;
  -- AC-13B: every required pre-start item Done, or Waived / Not applicable with a reason where allowed, before work starts.
  -- Keyed on the status, not on Actual Start, so a direct update of Actual Start cannot skip the gate; resuming an On Hold job
  -- that has started is not a start and is not checked again (its items were satisfied, and are locked, when work began).
  if p_to = 'IN_PROGRESS' and p.status = 'SCHEDULED' then
    select string_agg(label, ', ' order by sort_order) into v_open from project_checklist_items
     where project_id = p.id and stage = 'PRE_START' and is_required and status not in ('DONE', 'WAIVED', 'NOT_APPLICABLE');
    if v_open is not null then
      return format('pre-start items are still open (%s); set them in Airtable (SWMS Signed / Materials Reviewed) before the job starts', v_open);
    end if;
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
    -- AC-14: settled only on verified state (Xero for a Xero-linked invoice; the import's payments for an imported one).
    select string_agg(i.invoice_number || ' (' || (f ->> 'reason') || ')', ', ' order by i.invoice_number) into v_final
      from invoices i cross join lateral (select invoice_financial_state(i.id) f) s
     where i.project_id = p.id and not (f ->> 'settled')::boolean;
    if v_final is not null then return format('not every invoice is paid yet: %s', v_final); end if;
    -- AC-13A: closed means settled: everything entitled is billed (AC-09 project_billing; over-billing is refused above).
    v_bill := project_billing(p.id);
    if (v_bill ->> 'remaining')::numeric > 0 then
      select string_agg(invoice_number, ', ') into v_final from invoices where project_id = p.id and invoice_type = 'FINAL' and status <> 'VOIDED';
      return case when v_final is null then format('%s left to bill: the final invoice has not been raised yet', v_bill ->> 'remaining')
                  else format('%s left to bill after final invoice %s (for example a variation approved later); invoice it before closing', v_bill ->> 'remaining', v_final) end;
    end if;
    select string_agg(label, ', ' order by label) into v_open from v_projects_missing_completion_docs v where v.id = p.id;
    if v_open is not null then
      return format('completion items are still open (%s); set them in Airtable (Completion Photos / Compliance Certificate) before closing', v_open);
    end if;
    if exists (select 1 from approvals where entity_id = p.id and action_type = 'CREATE_INVOICE' and status = 'PENDING') then
      return 'a final invoice preview is awaiting approval; approve or withdraw it first';
    end if;
    -- AC-04 semantics: never close while a Xero write is in flight or uncertain.
    select string_agg(invoice_number || ' (' || lower(sync_status) || ')', ', ' order by invoice_number) into v_final
      from invoices where project_id = p.id and sync_status in ('PENDING', 'UNKNOWN');
    if v_final is not null or exists (select 1 from approvals where entity_id = p.id and action_type = 'CREATE_INVOICE' and status in ('APPROVED', 'EXECUTING')) then
      return format('a Xero write is still in flight or uncertain%s; wait until Xero confirms it', coalesce(': ' || v_final, ''));
    end if;
  end if;
  return null;
end $$;

-- 6. integrity_check: latest 20261017030000_release_blockers.sql + started_with_pre_start_open (FAIL).
create or replace function integrity_check()
returns table (entity text, check_key text, status text, failing int, detail text, refs text[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_refs text[]; v_mode text; v_override text;
begin
  return query select c.* from integrity_check_before_release_blockers() c where c.check_key <> 'done_has_proof';

  -- done_has_proof, now failing closed: a DONE side effect whose topic has no rule here is a FAIL, not a pass.
  select array_agg(o.topic || ':' || coalesce(o.payload ->> 'invoice_number', o.payload ->> 'quote_number', o.payload ->> 'project_number', o.aggregate_id::text))
    into v_refs from outbox o
   where o.status = 'DONE' and not case o.topic
     when 'drive.ensure_project_folder' then exists (select 1 from external_links l where l.provider = 'GOOGLE_DRIVE' and l.entity_type = 'project'
                                                       and l.external_type = 'Folder' and l.entity_id = o.aggregate_id and l.verified_at is not null)
     when 'airtable.project_writeback' then exists (select 1 from external_links l where l.provider = 'AIRTABLE' and l.entity_type = 'project'
                                                      and l.external_type = 'Record' and l.entity_id = o.aggregate_id and l.verified_at is not null)
     when 'xero.create_draft_invoice' then o.id <> (select c.id from outbox_current('xero.create_draft_invoice', o.aggregate_id) c)
                                          or exists (select 1 from invoices i where i.id = o.aggregate_id and i.sync_status = 'SYNCED')
     when 'airtable.quote_publish' then (select count(*) from external_links l
                                          where l.provider = 'AIRTABLE' and l.external_type = 'Record' and l.verified_at is not null
                                            and ((l.entity_type = 'quote' and l.entity_id = o.aggregate_id)
                                              or (l.entity_type = 'customer' and l.entity_id::text = o.payload ->> 'customer_id')
                                              or (l.entity_type = 'property' and l.entity_id::text = o.payload ->> 'property_id'))) = 3
     else false end;
  entity := 'side_effect'; check_key := 'done_has_proof';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every DONE side effect has verified proof (Drive folder, Airtable project or quote/customer/property records, Xero draft for its current generation); a topic without a rule fails'; return next;

  -- A worker claimed it and never reported back (crashed or cut off): nothing else re-drives Drive/Airtable writes.
  select array_agg(o.topic || ':' || coalesce(o.payload ->> 'invoice_number', o.payload ->> 'quote_number', o.payload ->> 'project_number', o.aggregate_id::text) order by o.locked_until)
    into v_refs from outbox o where o.status = 'DISPATCHING' and o.locked_until < now() - interval '15 minutes';
  entity := 'side_effect'; check_key := 'claimed_and_abandoned';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Side effects claimed by a worker whose lease ran out more than 15 minutes ago without a result; re-drive or investigate them'; return next;

  select upper(btrim(coalesce(value, 'REAL'))) into v_mode from app_settings where key = 'business_date_mode';
  v_mode := coalesce(v_mode, 'REAL');
  select btrim(coalesce(value, '')) into v_override from app_settings where key = 'business_date_override';
  entity := 'settings'; check_key := 'business_date';
  if v_mode = 'SYNTHETIC' then
    status := 'WARNING'; failing := 1; refs := array['synthetic ' || coalesce(v_override, '?'), 'real ' || app_date_at(now())::text];
    detail := 'The business date is SYNTHETIC: invoices, quotes, tasks and overdue rules use the configured demo date, not today';
  elsif coalesce(v_override, '') <> '' then
    status := 'WARNING'; failing := 1; refs := array['ignored override ' || v_override];
    detail := 'business_date_override is set but business_date_mode is REAL, so it is ignored; clear it to avoid confusion';
  else
    status := 'PASS'; failing := 0; refs := null;
    detail := 'The business date is the real date in Brisbane';
  end if;
  return next;

  -- AC-13B: a job that has started passed the pre-start gate.
  select array_agg(x.project_number || ' (' || x.items || ')' order by x.project_number) into v_refs
    from (select p.project_number, string_agg(ci.label, ', ' order by ci.sort_order) items from projects p join project_checklist_items ci on ci.project_id = p.id
           where (p.actual_start_date is not null or p.status in ('IN_PROGRESS', 'COMPLETED', 'CLOSED')) and ci.stage = 'PRE_START' and ci.is_required
             and ci.status not in ('DONE', 'WAIVED', 'NOT_APPLICABLE') group by p.project_number) x;
  entity := 'project'; check_key := 'started_with_pre_start_open';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'No started job has a required pre-start item (SWMS signed, materials reviewed) still open'; return next;
end $$;

-- 7. v_dashboard_project_checklist: latest 20261017010000_site_visits_and_tasks.sql + AC-13B delta. "Materials reviewed and
-- approved" follows its material-review task only once work has started. Before that the canonical item decides (the
-- Airtable Materials Reviewed field), because the pre-start gate does; otherwise the card showed Done for a job that could
-- not start. Started and invoiced jobs keep the 20261017010000 display. Same columns, same grant.
create or replace view v_dashboard_project_checklist as
select p.project_number, 'CHECKLIST' as kind, ci.stage, ci.label as title,
       case
         when ci.status <> 'OPEN' then ci.status
         when ci.item_code = 'MATERIALS_REVIEWED' and mr.completed_on is not null and p.actual_start_date is not null then 'DONE'
         when ci.item_code = 'FINAL_INVOICE_APPROVED' and fa.decided_on is not null then 'DONE'
         else ci.status end as status,
       ci.is_required,
       coalesce(ci.completed_on,
                case when ci.item_code = 'MATERIALS_REVIEWED' and p.actual_start_date is not null then mr.completed_on
                     when ci.item_code = 'FINAL_INVOICE_APPROVED' then fa.decided_on end) as done_on,
       null::date as due_on, null::text as assignee, ci.sort_order
from project_checklist_items ci join projects p on p.id = ci.project_id
left join lateral (select max(coalesce(t.completed_at, t.updated_at))::date as completed_on from tasks t
                    where t.project_id = p.id and t.task_type = 'MATERIAL_REVIEW' and t.status = 'DONE'
                      and not exists (select 1 from tasks o where o.project_id = p.id and o.task_type = 'MATERIAL_REVIEW' and o.status in ('OPEN', 'IN_PROGRESS'))) mr on true
left join lateral (select max(a.decided_at)::date as decided_on from invoices i join approvals a on a.id = i.approval_id
                    where i.project_id = p.id and i.invoice_type = 'FINAL' and i.status <> 'VOIDED' and a.status in ('EXECUTING', 'EXECUTED')) fa on true
union all
select p.project_number, 'TASK', t.task_type, t.title, t.status, true, null, t.due_on, e.full_name, 0
from tasks t join projects p on p.id = t.project_id left join employees e on e.id = t.assignee_id;

-- 8. A checklist Note edited on its own (review finding, resolved). n8n 06 now forwards an edit of a Note alone. The
-- handler reads a Note only together with its item (the Notes are INPUT, not compared by reconciliation), so such an
-- edit used to be dropped and the recorded reason could differ from what Airtable showed. A Note is a reason only for a
-- Waived / Not applicable item: there, a Note-only edit replaces the recorded reason under the same locks and
-- attribution as checklist_apply_change, or is refused and Airtable is put back to the recorded reason. For a To do or
-- Done item a Note is not a reason: nothing is recorded and nothing is corrected. This holds for all four checklist
-- Notes (AC-13A's two included); reconciliation still does not compare Notes.
create or replace function checklist_apply_note(p_id uuid, p_item text, p_note text, p_actor text, p_event_key text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare p projects; ci project_checklist_items; v_emp employees; v_final text; v_refuse text;
  v_field text := case p_item when 'COMPLETION_PHOTOS' then 'Completion Photos Note' when 'COMPLIANCE_CERTIFICATE' then 'Compliance Certificate Note'
                              when 'SWMS_SIGNED' then 'SWMS Signed Note' when 'MATERIALS_REVIEWED' then 'Materials Reviewed Note' end;
begin
  -- The same lock order as checklist_apply_change: the project row, then the item.
  select * into p from projects where id = p_id for update;
  select * into ci from project_checklist_items where project_id = p_id and item_code = p_item for update;
  if ci.id is null or ci.status not in ('WAIVED', 'NOT_APPLICABLE') or p_note is not distinct from ci.waived_reason then
    return jsonb_build_object('status', 'IGNORED');
  end if;
  if p.status in ('CLOSED', 'CANCELLED') then
    v_refuse := format('the checklist is locked: %s is %s', p.project_number, lower(sm_label('project', p.status)));
  elsif ci.stage = 'PRE_START' and (p.actual_start_date is not null or p.status in ('IN_PROGRESS', 'COMPLETED')) then
    v_refuse := format('the pre-start checklist is locked: work on %s has started (%s)', p.project_number, lower(sm_label('project', p.status)));
  else
    select string_agg(invoice_number, ', ') into v_final from invoices where project_id = p_id and invoice_type = 'FINAL' and status <> 'VOIDED';
    if v_final is not null then
      v_refuse := format('the completion checklist is locked: final invoice %s already exists', v_final);
    elsif exists (select 1 from approvals where entity_id = p_id and action_type = 'CREATE_INVOICE' and status in ('APPROVED', 'EXECUTING')) then
      v_refuse := 'the completion checklist is locked: the final invoice is being created in Xero right now';
    elsif p_note is null then
      v_refuse := format('%s needs a reason in %s', checklist_at_label(ci.status), v_field);
    else
      select e.* into v_emp from employee_external_identities x join employees e on e.id = x.employee_id
       where x.provider = 'AIRTABLE' and x.external_id = p_actor and e.is_active;
      if v_emp.id is null then
        v_refuse := format('Airtable user %s is not mapped to a RoofOps employee; checklist changes must be attributable', p_actor);
      end if;
    end if;
  end if;
  if v_refuse is not null then
    return jsonb_build_object('status', 'REJECTED', 'field', v_field, 'attempted', p_note, 'kept', ci.waived_reason, 'reason', v_refuse);
  end if;
  update project_checklist_items set waived_reason = p_note where id = ci.id;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
  values ('USER', p_actor, 'project.checklist.changed', 'project', p_id, p.project_number,
          jsonb_build_object('item', p_item, 'status', ci.status, 'reason', ci.waived_reason),
          jsonb_build_object('item', p_item, 'status', ci.status, 'employee', v_emp.employee_code, 'reason', p_note),
          p_note || ' [' || p_event_key || ']');
  return jsonb_build_object('status', 'APPLIED', 'field', v_field, 'from', ci.waived_reason, 'to', p_note);
end $$;

-- The webhook and reconciler entry point gains one thin layer (the wrap-and-rename pattern of 20260930010000 and
-- 20261001000000): the existing function runs first, unchanged; then a Note-only checklist edit is applied and its
-- outcome merged into the same result (outcome, applied / rejected / stale, corrections, note), which is stored for
-- redelivery exactly as the inner function stores its own.
alter function wf_airtable_change(jsonb, text) rename to wf_airtable_change_before_notes;
create or replace function wf_airtable_change(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res jsonb := wf_airtable_change_before_notes(p_event, p_worker);
  v_key text := p_event ->> 'event_id'; v_table text := p_event ->> 'table_id'; v_changes jsonb := p_event -> 'changes';
  v_actor text := coalesce(nullif(p_event ->> 'actor_id', ''), 'unknown'); v_id uuid; v_at timestamptz; n record; r jsonb;
  v_applied jsonb := '[]'; v_rejected jsonb := '[]'; v_stale jsonb := '[]'; v_corr jsonb := '{}'; v_sync text; v_lines text;
  v_all_applied jsonb; v_all_rejected jsonb; v_all_stale jsonb; v_outcome text;
begin
  -- Only a first delivery from Airtable to a Projects record RoofOps knows (the reconciler never sends a Note: Notes are not compared).
  if coalesce(nullif(p_event ->> 'source', ''), 'airtable') <> 'airtable' or v_table is distinct from 'tblvUPIoebC3zoacv'
     or jsonb_typeof(v_changes) <> 'object' or coalesce((v_res ->> 'duplicate')::boolean, false)
     or v_res ->> 'entity' is distinct from 'project' or v_res ->> 'entity_id' is null then
    return v_res;
  end if;
  v_id := (v_res ->> 'entity_id')::uuid;
  begin v_at := coalesce((p_event ->> 'occurred_at')::timestamptz, now()); exception when others then v_at := now(); end;
  for n in select * from (values
             ('fldNcsIgH6TfQFfaU', 'fldM6kgPz6QZagPAC', 'SWMS_SIGNED', 'swms_signed_note', 'SWMS Signed Note'),
             ('fldEtAmAokIvtzJdn', 'fldozWSCU877wEZHq', 'MATERIALS_REVIEWED', 'materials_reviewed_note', 'Materials Reviewed Note'),
             ('fldA77ad94yUmvnu3', 'fldbbksVL3dT6cqyS', 'COMPLETION_PHOTOS', 'completion_photos_note', 'Completion Photos Note'),
             ('fldLi9FkGDFAbf0QB', 'fldf7iJiyHFxOQgUy', 'COMPLIANCE_CERTIFICATE', 'compliance_certificate_note', 'Compliance Certificate Note'))
             as t(note_fid, item_fid, item_code, field_key, field_name)
            -- A Note that changed with its own item was already read with that item by the handler.
            where v_changes ? t.note_fid and not v_changes ? t.item_fid
  loop
    -- An older Note edit delivered after a newer one is ignored (the handler's rule for every field).
    if exists (select 1 from external_field_versions x where x.entity_type = 'project' and x.entity_id = v_id
                 and x.field_key = n.field_key and x.last_source_at > v_at) then
      v_stale := v_stale || jsonb_build_object('field', n.field_name, 'value', v_changes -> n.note_fid -> 'current');
      continue;
    end if;
    r := checklist_apply_note(v_id, n.item_code, nullif(btrim(v_changes -> n.note_fid ->> 'current'), ''), v_actor, v_key);
    if r ->> 'status' = 'APPLIED' then
      v_applied := v_applied || jsonb_build_object('field', r ->> 'field', 'from', r -> 'from', 'to', r -> 'to');
      insert into external_field_versions (entity_type, entity_id, field_key, last_source, last_source_at, last_event_key, last_value)
      values ('project', v_id, n.field_key, 'airtable', v_at, v_key, r ->> 'to')
      on conflict (entity_type, entity_id, field_key) do update set last_source = excluded.last_source,
        last_source_at = greatest(external_field_versions.last_source_at, excluded.last_source_at), last_event_key = excluded.last_event_key,
        last_value = excluded.last_value, applied_at = now();
    elsif r ->> 'status' = 'REJECTED' then
      v_rejected := v_rejected || (r - 'status');
      v_corr := v_corr || jsonb_build_object(n.note_fid, r -> 'kept');                  -- Airtable shows the recorded reason again
    end if;
  end loop;
  if jsonb_array_length(v_applied) + jsonb_array_length(v_rejected) + jsonb_array_length(v_stale) = 0 then
    return v_res;
  end if;

  v_lines := concat_ws(E'\n',
    (select string_agg(format('✓ %s: %s → %s applied', a ->> 'field', coalesce(a ->> 'from', 'blank'), coalesce(a ->> 'to', 'blank')), E'\n') from jsonb_array_elements(v_applied) a),
    (select string_agg(format('✗ %s: "%s" not applied: %s. Kept "%s".', x ->> 'field', coalesce(x ->> 'attempted', 'blank'), x ->> 'reason', coalesce(x ->> 'kept', 'blank')), E'\n') from jsonb_array_elements(v_rejected) x),
    (select string_agg(format('• %s: an older change arrived late and was ignored.', s ->> 'field'), E'\n') from jsonb_array_elements(v_stale) s));
  -- As in the handler: a plain accepted edit needs no Airtable write; a refusal does, and RoofOps Sync says why.
  if jsonb_array_length(v_rejected) > 0 then
    select airtable_field_id into v_sync from field_contract where airtable_table_id = v_table and field_key = 'roofops_sync';
    if v_sync is not null then
      v_corr := v_corr || jsonb_build_object(v_sync, coalesce((v_res -> 'corrections' ->> v_sync) || E'\n',
                                                              to_char(now() at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI') || E'\n') || v_lines);
    end if;
  end if;
  v_all_applied := coalesce(v_res -> 'applied', '[]') || v_applied;
  v_all_rejected := coalesce(v_res -> 'rejected', '[]') || v_rejected;
  v_all_stale := coalesce(v_res -> 'stale', '[]') || v_stale;
  v_outcome := case when jsonb_array_length(v_all_applied) > 0 and jsonb_array_length(v_all_rejected) + jsonb_array_length(coalesce(v_res -> 'reverted', '[]')) = 0 then 'APPLIED'
                    when jsonb_array_length(v_all_applied) > 0 then 'PARTIALLY_APPLIED'
                    when jsonb_array_length(v_all_rejected) > 0 then 'REJECTED'
                    when jsonb_array_length(coalesce(v_res -> 'reverted', '[]')) > 0 then 'REVERTED'
                    when jsonb_array_length(v_all_stale) > 0 then 'STALE'
                    when jsonb_array_length(coalesce(v_res -> 'deferred', '[]')) > 0 then 'DEFERRED'
                    else 'NO_CHANGE' end;
  v_res := v_res || jsonb_build_object('outcome', v_outcome, 'applied', v_all_applied, 'rejected', v_all_rejected, 'stale', v_all_stale,
                                       'corrections', coalesce(v_res -> 'corrections', '{}') || v_corr,
                                       'note', nullif(concat_ws(E'\n', v_res ->> 'note', nullif(v_lines, '')), ''));
  update processed_events set result = v_res
   where consumer = 'airtable_change@1' and idempotency_key = v_key and status = 'COMPLETED' and not coalesce((result ->> 'duplicate')::boolean, false);
  update automation_events set
         status = case when v_outcome in ('REJECTED', 'REVERTED') then 'REJECTED' when v_outcome = 'STALE' then 'DUPLICATE_IGNORED'
                       when v_outcome in ('NO_CHANGE', 'DEFERRED') then 'INFO' else 'SUCCEEDED' end,
         error_class = case when v_outcome = 'REJECTED' then 'ILLEGAL_TRANSITION' when v_outcome = 'REVERTED' then 'UNAUTHORIZED_EDIT'
                            when v_outcome = 'STALE' then 'STALE_EVENT' end,
         metadata = metadata || jsonb_build_object('outcome', v_outcome, 'reason', v_res ->> 'note')
   where event_id = (select first_event_id from processed_events where consumer = 'airtable_change@1' and idempotency_key = v_key);
  -- No airtable_writes row: a Note and RoofOps Sync are not compared fields, so their echoes are no-ops (a Note that
  -- comes back equal to the recorded reason changes nothing).
  return v_res;
end $$;

update field_contract set change_path = change_path || '; a Note edited on its own replaces the recorded reason of a Waived / Not applicable item (checklist_apply_note)'
 where entity = 'project' and field_key in ('completion_photos_note', 'compliance_certificate_note', 'swms_signed_note', 'materials_reviewed_note');

-- Privileges. CREATE OR REPLACE keeps each replaced function's and view's owner and ACL: checklist_apply_change (no execute
-- for roofops_workflow / roofops_dashboard, 20261001110000); integrity_check and app_business_date (execute for
-- roofops_dashboard, 20261017030000). The new functions are set here: the new entry point keeps the old one's grant, the
-- renamed inner function and checklist_apply_note are for no application role. RLS on field_contract is unchanged.
revoke execute on all functions in schema public from public;
revoke execute on function wf_airtable_change_before_notes(jsonb, text) from roofops_workflow;
revoke execute on function checklist_apply_note(uuid, text, text, text, text) from roofops_workflow, roofops_dashboard;
grant execute on function wf_airtable_change(jsonb, text) to roofops_workflow;
