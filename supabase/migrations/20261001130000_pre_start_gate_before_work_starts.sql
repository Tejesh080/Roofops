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

-- 1. Field contract: the two pre-start fields are staff edits applied through the handler; their notes are input.
insert into field_contract (entity, field_key, airtable_table_id, airtable_field_id, airtable_name, canonical, owner, editable_in, change_path, validation, event_generated, downstream, readback, reconcile, ai_visible) values
  ('project','swms_signed','tblvUPIoebC3zoacv','fldM6kgPz6QZagPAC','SWMS Signed','project_checklist_items SWMS_SIGNED .status','AIRTABLE_EDIT','Airtable Projects.SWMS Signed','Airtable webhook → n8n 06 → wf_airtable_change → checklist_apply_change','state_transitions(checklist_item); Done only (checklist.not_waivable); mapped RoofOps employee; locked once work has started or the job is Closed / Cancelled','project.checklist.changed','In Progress gate, dashboard, Copilot','06 read-back; reconciliation','APPLY_VIA_HANDLER',true),
  ('project','swms_signed_note','tblvUPIoebC3zoacv','fldNcsIgH6TfQFfaU','SWMS Signed Note','project_checklist_items SWMS_SIGNED (audit reason)','INPUT','Airtable (read with SWMS Signed)','read by wf_airtable_change with SWMS Signed','free text','(part of project.checklist.changed)','audit','n/a','IGNORE',true),
  ('project','materials_reviewed','tblvUPIoebC3zoacv','fldozWSCU877wEZHq','Materials Reviewed','project_checklist_items MATERIALS_REVIEWED .status','AIRTABLE_EDIT','Airtable Projects.Materials Reviewed','Airtable webhook → n8n 06 → wf_airtable_change → checklist_apply_change','state_transitions(checklist_item); Waived / Not applicable need Materials Reviewed Note; mapped RoofOps employee; locked once work has started or the job is Closed / Cancelled','project.checklist.changed','In Progress gate, dashboard, Copilot','06 read-back; reconciliation','APPLY_VIA_HANDLER',true),
  ('project','materials_reviewed_note','tblvUPIoebC3zoacv','fldEtAmAokIvtzJdn','Materials Reviewed Note','project_checklist_items MATERIALS_REVIEWED .waived_reason','INPUT','Airtable (read with Materials Reviewed)','read by wf_airtable_change with Materials Reviewed','free text; required for Waived / Not applicable','(part of project.checklist.changed)','audit','n/a','IGNORE',true);
update field_contract set editable_in = 'COMPLETION items: Airtable Projects.Completion Photos / Compliance Certificate (AC-13A); PRE_START items: Airtable Projects.SWMS Signed / Materials Reviewed (AC-13B)',
       change_path = 'created by wf_quote_accepted; changed by checklist_apply_change'
 where entity = 'checklist' and field_key = 'items';

insert into app_settings (key, value) values ('checklist.not_waivable', 'SWMS_SIGNED') on conflict (key) do nothing;

-- 2. create or replace function checklist_apply_change(p_id uuid, p_item text, p_value text, p_note text, p_actor text, p_event_key text)
create or replace function checklist_apply_change(p_id uuid, p_item text, p_value text, p_note text, p_actor text, p_event_key text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare p projects; ci project_checklist_items; v_to text; v_emp employees; v_final text;
  v_field text := case p_item when 'COMPLETION_PHOTOS' then 'Completion Photos' when 'COMPLIANCE_CERTIFICATE' then 'Compliance Certificate'
                             when 'SWMS_SIGNED' then 'SWMS Signed' when 'MATERIALS_REVIEWED' then 'Materials Reviewed' else initcap(replace(lower(p_item), '_', ' ')) end;
begin
  select * into p from projects where id = p_id;
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
  if v_to = 'DONE' and ci.stage = 'COMPLETION' and p.actual_start_date is null then
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

-- 3. create or replace function project_apply_change(p_id uuid, p_field text, p_value text, p_current jsonb, p_actor text, p_event_key text)
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

-- 4. create or replace view v_airtable_expected as
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

-- 5. create or replace function project_transition_guard(p projects, p_to text)
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
  if p_to = 'IN_PROGRESS' and p.actual_start_date is null then
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

-- 6. create or replace function integrity_check()
create or replace function integrity_check()
returns table (entity text, check_key text, status text, failing int, detail text, refs text[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_refs text[];
begin
  return query select * from integrity_check_core();
  select array_agg(i.invoice_number order by i.invoice_number) into v_refs from invoices i
    left join outbox o on o.topic = 'xero.create_draft_invoice' and o.aggregate_id = i.id
   where i.status = 'VOIDED' and i.record_origin = 'ROOFOPS'
     and (i.sync_status in ('PENDING', 'UNKNOWN', 'SYNCED') or o.status in ('DISPATCHING', 'DONE')
          or exists (select 1 from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id));
  entity := 'invoice'; check_key := 'voided_invoice_has_no_xero_write';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'No Xero draft is created, pending, ambiguous or linked for a voided invoice'; return next;
  -- AC-09: once a final invoice exists, everything validly billed equals the entitlement (short = under-billed).
  select array_agg(x.project_number || ' (' || (x.b ->> 'remaining') || ' left)' order by x.project_number) into v_refs
    from (select p.project_number, project_billing(p.id) b from projects p
           where exists (select 1 from invoices i where i.project_id = p.id and i.invoice_type = 'FINAL' and i.status not in ('VOIDED', 'DRAFT', 'PENDING_APPROVAL'))) x
   where (x.b ->> 'remaining')::numeric > 0;
  entity := 'invoice'; check_key := 'final_invoice_settles_entitlement';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'After the final invoice, quote + approved/invoiced variations - everything billed = 0 (left over means under-billed; a variation approved later needs its own invoice)'; return next;
  -- AC-13A: a CLOSED project is settled: nothing left to bill, nothing over-billed, everything paid, completion gate satisfied.
  select array_agg(p.project_number order by p.project_number) into v_refs from projects p
   where p.status = 'CLOSED' and ((project_billing(p.id) ->> 'remaining')::numeric <> 0
      or exists (select 1 from invoices i where i.project_id = p.id and not (invoice_financial_state(i.id, false) ->> 'settled')::boolean)
      or exists (select 1 from v_projects_missing_completion_docs v where v.id = p.id));
  entity := 'project'; check_key := 'closed_project_settled';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Closed projects have nothing left to bill, nothing over-billed, every invoice paid or voided, and their completion items done or waived'; return next;
  -- AC-13A: completed jobs held only by open completion items (staff set them in Airtable: Completion Photos / Compliance Certificate).
  select array_agg(x.project_number || ' (' || x.items || ')' order by x.project_number) into v_refs
    from (select v.project_number, string_agg(v.label, ', ' order by v.label) items from v_projects_missing_completion_docs v join projects p on p.id = v.id
           where p.status = 'COMPLETED' group by v.project_number) x;
  entity := 'project'; check_key := 'completed_awaiting_completion_items';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Completed jobs whose completion items are still To do in Airtable (Completion Photos / Compliance Certificate); no final invoice until they are Done, Waived or Not applicable'; return next;
  -- AC-14: every Xero-linked invoice was last read successfully, and RoofOps shows the state Xero verified.
  select array_agg(i.invoice_number || ' (' || case when x.id is null then 'never read from Xero'
                                                   when x.verdict <> 'VERIFIED' then 'last Xero check: ' || lower(replace(x.verdict, '_', ' '))
                                                   else 'Xero ' || lower(replace(x.settlement, '_', ' ')) || ', RoofOps ' || lower(i.status) end || ')' order by i.invoice_number) into v_refs
    from invoices i join external_links l on l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id and l.verified_at is not null
    left join lateral (select * from xero_invoice_observations o where o.invoice_id = i.id order by o.observed_at desc, o.id desc limit 1) x on true
   where i.sync_status = 'SYNCED' and (x.id is null or x.verdict <> 'VERIFIED' or i.status is distinct from xero_settlement_status(x.settlement));
  entity := 'invoice'; check_key := 'xero_invoice_state_verified';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every Xero-linked invoice was last read from its own Xero tenant and RoofOps shows the state Xero verified (a repair run applies it)'; return next;
  -- AC-13B: a job that has started passed the pre-start gate.
  select array_agg(x.project_number || ' (' || x.items || ')' order by x.project_number) into v_refs
    from (select p.project_number, string_agg(ci.label, ', ' order by ci.sort_order) items from projects p join project_checklist_items ci on ci.project_id = p.id
           where (p.actual_start_date is not null or p.status in ('IN_PROGRESS', 'COMPLETED', 'CLOSED')) and ci.stage = 'PRE_START' and ci.is_required
             and ci.status not in ('DONE', 'WAIVED', 'NOT_APPLICABLE') group by p.project_number) x;
  entity := 'project'; check_key := 'started_with_pre_start_open';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'No started job has a required pre-start item (SWMS signed, materials reviewed) still open'; return next;
end $$;

revoke execute on all functions in schema public from public;
revoke execute on function checklist_apply_change(uuid, text, text, text, text, text) from roofops_workflow, roofops_dashboard;
grant execute on function integrity_check() to roofops_dashboard;
