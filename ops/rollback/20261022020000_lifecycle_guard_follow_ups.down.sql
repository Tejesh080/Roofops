-- Rollback of 20261022020000_lifecycle_guard_follow_ups.sql (owner only; one transaction). It restores project_transition_guard as
-- 20261022010000_fully_billed_job_is_not_cancelled.sql defined it and checklist_apply_change as 20261022000000_pre_start_gate_before_work_starts.sql defined it,
-- and removes the migration's record. No data changes.
-- Run: npx tsx scripts/sql.ts -f ops/rollback/20261022020000_lifecycle_guard_follow_ups.down.sql
begin;

-- restore project_transition_guard (20261022010000_fully_billed_job_is_not_cancelled.sql)
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
    -- AC-15: imported invoices carry no type, so whether the job was finally billed is also read from its bills. A job
    -- whose valid bills reach what it is entitled to (AC-09 project_billing) was billed in full and is not cancelled:
    -- fully billed is billed, whatever the paperwork (as AC-13A reads it for closing). A partly billed job still may be.
    v_bill := project_billing(p.id);
    if (v_bill ->> 'billed')::numeric > 0 and (v_bill ->> 'remaining')::numeric <= 0 then
      return format('%s is fully billed (billed %s against %s: %s); a fully billed job is not cancelled: void the final bill first, then cancel',
        p.project_number, v_bill ->> 'billed', v_bill ->> 'entitlement', v_bill ->> 'invoices');
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

-- restore checklist_apply_change (20261022000000_pre_start_gate_before_work_starts.sql)
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

delete from schema_migrations where version = '20261022020000_lifecycle_guard_follow_ups.sql';
commit;
