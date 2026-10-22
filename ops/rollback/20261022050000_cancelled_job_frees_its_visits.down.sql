-- Rollback of 20261022050000_cancelled_job_frees_its_visits.sql (owner only; one transaction): project_apply_change (20261022000000), web_visit_update
-- (20261017010000) and integrity_check (20261022010000) exactly as before, and the migration's record. Visits cancelled
-- in the meantime stay cancelled (records are kept).
-- Run: npx tsx scripts/sql.ts -f ops/rollback/20261022050000_cancelled_job_frees_its_visits.down.sql
begin;

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

create or replace function web_visit_update(p_token text, p_job text, p_action text, p_expected_version int, p_reason text,
                                            p_start timestamptz default null, p_end timestamptz default null)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare
  v_emp employees := staff_session_employee(p_token); j jobs; p projects; v_planner boolean; v_crew boolean; v_to text; v_problem jsonb;
  v_ids uuid[]; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_from text;
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT'); end if;
  if coalesce(p_action, '') not in ('start', 'complete', 'weather_delay', 'reschedule', 'cancel') then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'unknown action');
  end if;
  select * into j from jobs where job_number = upper(btrim(coalesce(p_job, ''))) for update;
  if j.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', coalesce(p_job, 'no visit')); end if;
  select * into p from projects where id = j.project_id;
  v_planner := staff_role_allowed(v_emp, 'schedule.planner_roles');
  v_crew := v_emp.is_active and exists (select 1 from job_assignments a where a.job_id = j.id and a.employee_id = v_emp.id);
  if not (v_planner or (v_crew and p_action in ('start', 'complete', 'weather_delay'))) then
    return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED',
      'detail', case when p_action in ('reschedule', 'cancel') then 'only a planner (admin, operations manager, project manager) may do this'
                     else format('%s is not on the crew of %s', v_emp.employee_code, j.job_number) end);
  end if;
  if p_expected_version is distinct from j.record_version then
    return jsonb_build_object('ok', false, 'code', 'STALE', 'detail', format('%s changed since you opened it (now %s); reload and check it again', j.job_number, lower(replace(j.status, '_', ' '))));
  end if;
  v_from := j.status;
  v_to := case
    when p_action = 'start' and j.status = 'SCHEDULED' then 'IN_PROGRESS'
    when p_action = 'complete' and j.status = 'IN_PROGRESS' then 'COMPLETED'
    when p_action = 'weather_delay' and j.status in ('SCHEDULED', 'IN_PROGRESS') then 'WEATHER_DELAYED'
    when p_action = 'reschedule' and j.status in ('SCHEDULED', 'WEATHER_DELAYED') then 'SCHEDULED'
    when p_action = 'cancel' and j.status in ('SCHEDULED', 'WEATHER_DELAYED') then 'CANCELLED' end;
  if v_to is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TRANSITION', 'detail', format('%s is %s: it cannot be %s', j.job_number, lower(replace(j.status, '_', ' ')),
      case p_action when 'start' then 'started' when 'complete' then 'completed (start it first)' when 'weather_delay' then 'delayed'
                    when 'reschedule' then 'rescheduled' else 'cancelled' end));
  end if;
  if p_action in ('weather_delay', 'cancel') and length(coalesce(v_reason, '')) < 5 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'detail', 'say why (a few words), so the office and the customer can be told');
  end if;
  if length(coalesce(v_reason, '')) > 2000 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'the note is too long'); end if;
  if p_action = 'reschedule' then
    v_problem := visit_times_problem(p_start, p_end);
    if v_problem is not null then return jsonb_build_object('ok', false) || v_problem; end if;
    select array_agg(id order by id) into v_ids from (select e.id from employees e join job_assignments a on a.employee_id = e.id
                                                       where a.job_id = j.id order by e.id for update of e) x;
    v_problem := visit_crew_conflict(v_ids, p_start, p_end, j.id);
    if v_problem is not null then
      return jsonb_build_object('ok', false, 'code', 'CREW_CONFLICT', 'conflict', v_problem,
        'detail', format('%s is already on %s at that time', v_problem ->> 'name', v_problem ->> 'job_number'));
    end if;
    update jobs set scheduled_start = p_start, scheduled_end = p_end, actual_start = null, actual_end = null, status = 'SCHEDULED',
                    status_reason = v_reason, record_version = record_version + 1, updated_at = now() where id = j.id returning * into j;
  else
    update jobs set status = v_to, status_reason = coalesce(v_reason, status_reason),
                    actual_start = case when v_to = 'IN_PROGRESS' then now() else actual_start end,
                    actual_end = case when v_to = 'COMPLETED' then now() else actual_end end,
                    record_version = record_version + 1, updated_at = now() where id = j.id returning * into j;
  end if;
  -- A delay or a completion note is also a site note (the job's progress log; the Copilot reads site notes).
  if v_reason is not null and p_action in ('weather_delay', 'complete') then
    insert into site_notes (note_number, project_id, job_id, author_id, note_type, body, noted_at)
    values (next_friendly_id('NOTE'), p.id, j.id, v_emp.id, case when p_action = 'weather_delay' then 'WEATHER' else 'GENERAL' end, v_reason, now());
  end if;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
  values ('USER', v_emp.employee_code, 'job.' || p_action, 'job', j.id, p.project_number, jsonb_build_object('job_number', j.job_number, 'status', v_from),
          jsonb_build_object('job_number', j.job_number, 'status', j.status, 'start', j.scheduled_start, 'end', j.scheduled_end),
          coalesce(v_reason, format('Site visit %s %s', j.job_number, lower(replace(j.status, '_', ' ')))));
  return jsonb_build_object('ok', true, 'job_number', j.job_number, 'status', j.status, 'record_version', j.record_version);
end $$;

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

  -- AC-15: a cancelled job is never fully billed (its bills would be a receivable on a cancelled job).
  select array_agg(p.project_number || ' (billed ' || (x.b ->> 'billed') || ' of ' || (x.b ->> 'entitlement') || ')' order by p.project_number) into v_refs
    from projects p cross join lateral (select project_billing(p.id) b) x
   where p.status = 'CANCELLED' and (x.b ->> 'billed')::numeric > 0 and (x.b ->> 'remaining')::numeric <= 0;
  entity := 'project'; check_key := 'cancelled_job_fully_billed';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'No cancelled job is fully billed (a fully billed job is not cancelled, whatever its invoices are typed)'; return next;
end $$;

delete from schema_migrations where version = '20261022050000_cancelled_job_frees_its_visits.sql';
commit;
