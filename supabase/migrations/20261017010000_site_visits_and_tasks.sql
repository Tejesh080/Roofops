-- OPS-01: site visits (crew scheduling) and project tasks, run by signed-in staff in the dashboard.
--
-- jobs, job_assignments and tasks existed in the core schema but nothing let a person use them (hosted: 0 jobs, 0 crew
-- assignments, 3 tasks). They are RoofOps-only records (no Airtable table mirrors them), so the dashboard is their one
-- edit path; nothing here competes with an Airtable-owned field (project status, dates and the completion checklist stay in
-- Airtable through n8n 06).
--
-- Every write is a web_* SECURITY DEFINER function taking the staff session token, like the invoice functions: the database
-- checks the session, the role (app_settings), the state transition, the record version (stale screens are refused) and,
-- for visits, crew double-booking under a lock. A request key makes a repeated submit return the first result. Every change
-- is audited with the project number, so it appears on the project's timeline.

insert into app_settings (key, value) values
  ('schedule.planner_roles', 'ADMIN,OPERATIONS_MANAGER,PROJECT_MANAGER'),
  ('task.manager_roles', 'ADMIN,OPERATIONS_MANAGER,PROJECT_MANAGER,FINANCE'),
  ('schedule.max_visit_days', '14')
on conflict (key) do nothing;

alter table jobs add column if not exists request_key text unique;
alter table jobs add column if not exists notes text check (notes is null or length(notes) <= 2000);
alter table jobs add column if not exists status_reason text check (status_reason is null or length(status_reason) <= 2000);
alter table jobs add column if not exists created_by uuid references employees (id);
create index if not exists job_assignments_employee on job_assignments (employee_id);
create index if not exists jobs_project on jobs (project_id, scheduled_start);

alter table tasks add column if not exists task_number text unique;
alter table tasks add column if not exists created_by uuid references employees (id);
alter table tasks add column if not exists completed_at timestamptz;
alter table tasks add column if not exists completed_by uuid references employees (id);
alter table tasks add column if not exists status_note text check (status_note is null or length(status_note) <= 2000);
do $$
declare t record;
begin
  for t in select id from tasks where task_number is null order by created_at, id loop
    update tasks set task_number = next_friendly_id('TASK') where id = t.id;
  end loop;
end $$;

-- The signed-in employee may do what the setting lists for their role.
create or replace function staff_role_allowed(p_emp employees, p_setting text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_emp.id is not null and p_emp.is_active
     and p_emp.role = any (string_to_array(coalesce((select value from app_settings where key = p_setting), ''), ','))
$$;

-- A visit's crew member who is already on another live visit at an overlapping time (null = free).
create or replace function visit_crew_conflict(p_crew uuid[], p_start timestamptz, p_end timestamptz, p_except uuid default null)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('employee', e.employee_code, 'name', e.full_name, 'job_number', j.job_number,
                            'from', j.scheduled_start, 'to', j.scheduled_end)
    from job_assignments a join jobs j on j.id = a.job_id join employees e on e.id = a.employee_id
   where a.employee_id = any (p_crew) and j.id is distinct from p_except
     and j.status in ('SCHEDULED', 'IN_PROGRESS')
     and j.scheduled_start < p_end and j.scheduled_end > p_start
   order by j.scheduled_start limit 1
$$;

-- Shared checks for a visit's times (the business date is app_today(), as everywhere else).
create or replace function visit_times_problem(p_start timestamptz, p_end timestamptz)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_start is null or p_end is null then jsonb_build_object('code', 'INVALID_TIMES', 'detail', 'a visit needs a start and an end')
    when p_end <= p_start then jsonb_build_object('code', 'INVALID_TIMES', 'detail', 'the end must be after the start')
    when (p_start at time zone 'Australia/Brisbane')::date < app_today() then
      jsonb_build_object('code', 'IN_PAST', 'detail', format('the start is before today (%s)', to_char(app_today(), 'DD Mon YYYY')))
    when p_end - p_start > make_interval(days => coalesce((select value::int from app_settings where key = 'schedule.max_visit_days'), 14)) then
      jsonb_build_object('code', 'TOO_LONG', 'detail', format('a visit can be at most %s days; schedule longer work as several visits',
        coalesce((select value from app_settings where key = 'schedule.max_visit_days'), '14')))
  end
$$;

-- 1. Schedule a site visit with its crew.
create or replace function web_visit_schedule(p_token text, p_project text, p_type text, p_start timestamptz, p_end timestamptz,
                                              p_crew text[], p_leading_hand text, p_note text, p_request_key text)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare
  v_emp employees := staff_session_employee(p_token); p projects; j jobs; v_problem jsonb; v_ids uuid[]; v_codes text[];
  v_lead text; v_bad text; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT'); end if;
  if not staff_role_allowed(v_emp, 'schedule.planner_roles') then
    return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED', 'detail', format('%s (%s) may not schedule site visits', v_emp.employee_code, v_emp.role));
  end if;
  if length(coalesce(p_request_key, '')) not between 8 and 100 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'missing request key'); end if;
  select * into j from jobs where request_key = p_request_key;
  if j.id is not null then   -- the same form submitted twice: the first visit, nothing new
    return jsonb_build_object('ok', true, 'duplicate', true, 'job_number', j.job_number, 'status', j.status);
  end if;
  select * into p from projects where project_number = upper(btrim(coalesce(p_project, ''))) for update;
  if p.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', coalesce(p_project, 'no project')); end if;
  if p.status in ('CLOSED', 'CANCELLED') then
    return jsonb_build_object('ok', false, 'code', 'PROJECT_CLOSED', 'detail', format('%s is %s', p.project_number, lower(sm_label('project', p.status))));
  end if;
  if coalesce(p_type, '') not in ('INSTALL', 'STRIP_AND_REPLACE', 'RESTORATION', 'REPAIR', 'MAKE_SAFE', 'RETURN_VISIT') then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'choose the kind of visit');
  end if;
  if p.status = 'COMPLETED' and p_type not in ('RETURN_VISIT', 'MAKE_SAFE') then
    return jsonb_build_object('ok', false, 'code', 'PROJECT_COMPLETED', 'detail', format('%s is completed: only a return visit or a make-safe can be scheduled', p.project_number));
  end if;
  v_problem := visit_times_problem(p_start, p_end);
  if v_problem is not null then return jsonb_build_object('ok', false) || v_problem; end if;
  if length(coalesce(v_note, '')) > 2000 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'the note is too long'); end if;

  select array_agg(distinct upper(btrim(c))) into v_codes from unnest(coalesce(p_crew, '{}')) c where btrim(coalesce(c, '')) <> '';
  if coalesce(cardinality(v_codes), 0) = 0 then return jsonb_build_object('ok', false, 'code', 'NO_CREW', 'detail', 'pick at least one person'); end if;
  if cardinality(v_codes) > 8 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'at most 8 people on one visit'); end if;
  select string_agg(c, ', ') into v_bad from unnest(v_codes) c
   where not exists (select 1 from employees e where e.employee_code = c and e.is_active and e.role <> 'VIEWER');
  if v_bad is not null then return jsonb_build_object('ok', false, 'code', 'CREW_UNKNOWN', 'detail', format('%s cannot be put on a visit (not an active employee)', v_bad)); end if;
  v_lead := coalesce(nullif(upper(btrim(coalesce(p_leading_hand, ''))), ''), v_codes[1]);
  if not (v_lead = any (v_codes)) then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'the leading hand must be on the crew'); end if;

  -- Lock the crew (in a fixed order) so two planners cannot book the same person into overlapping visits at once.
  select array_agg(id order by id) into v_ids from (select id from employees where employee_code = any (v_codes) order by id for update) x;
  v_problem := visit_crew_conflict(v_ids, p_start, p_end);
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'code', 'CREW_CONFLICT', 'conflict', v_problem,
      'detail', format('%s is already on %s (%s to %s)', v_problem ->> 'name', v_problem ->> 'job_number',
        to_char((v_problem ->> 'from')::timestamptz at time zone 'Australia/Brisbane', 'DD Mon HH24:MI'),
        to_char((v_problem ->> 'to')::timestamptz at time zone 'Australia/Brisbane', 'DD Mon HH24:MI')));
  end if;

  insert into jobs (job_number, project_id, job_type, status, scheduled_start, scheduled_end, request_key, notes, created_by)
  values (next_friendly_id('JOB', extract(year from app_today())::int), p.id, p_type, 'SCHEDULED', p_start, p_end, p_request_key, v_note, v_emp.id)
  returning * into j;
  insert into job_assignments (job_id, employee_id, crew_role)
  select j.id, e.id, case when e.employee_code = v_lead then 'LEADING_HAND' else 'CREW' end from employees e where e.employee_code = any (v_codes);
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
  values ('USER', v_emp.employee_code, 'job.scheduled', 'job', j.id, p.project_number,
          jsonb_build_object('job_number', j.job_number, 'type', p_type, 'start', p_start, 'end', p_end, 'crew', v_codes, 'leading_hand', v_lead),
          format('Site visit %s scheduled', j.job_number));
  return jsonb_build_object('ok', true, 'job_number', j.job_number, 'status', j.status, 'record_version', j.record_version);
end $$;

-- 2. Move a visit on: start, complete, weather delay (crew or planner); reschedule, cancel (planner).
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

-- 3. Create a task (optionally on a project), assigned to someone, due on a date.
create or replace function web_task_create(p_token text, p_project text, p_type text, p_title text, p_assignee text, p_due date,
                                           p_description text, p_request_key text)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare
  v_emp employees := staff_session_employee(p_token); p projects; a employees; t tasks;
  v_title text := btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g')); v_desc text := nullif(btrim(coalesce(p_description, '')), '');
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT'); end if;
  if not staff_role_allowed(v_emp, 'task.manager_roles') then
    return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED', 'detail', format('%s (%s) may not create tasks', v_emp.employee_code, v_emp.role));
  end if;
  if length(coalesce(p_request_key, '')) not between 8 and 100 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'missing request key'); end if;
  select * into t from tasks where dedupe_key = 'web:' || p_request_key;
  if t.id is not null then return jsonb_build_object('ok', true, 'duplicate', true, 'task_number', t.task_number); end if;
  if length(v_title) not between 3 and 200 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'give the task a short title (3 to 200 characters)'); end if;
  if length(coalesce(v_desc, '')) > 2000 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'the description is too long'); end if;
  if coalesce(p_type, '') not in ('MATERIAL_REVIEW', 'SCHEDULE_JOB', 'SUPPLIER_FOLLOW_UP', 'COMPLIANCE_DOCS', 'CUSTOMER_FOLLOW_UP', 'INVOICE_REVIEW', 'EXCEPTION_REVIEW', 'GENERAL') then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'choose the kind of task');
  end if;
  if nullif(btrim(coalesce(p_project, '')), '') is not null then
    select * into p from projects where project_number = upper(btrim(p_project)) for update;
    if p.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', p_project); end if;
    if p.status in ('CLOSED', 'CANCELLED') then
      return jsonb_build_object('ok', false, 'code', 'PROJECT_CLOSED', 'detail', format('%s is %s', p.project_number, lower(sm_label('project', p.status))));
    end if;
  end if;
  if nullif(btrim(coalesce(p_assignee, '')), '') is not null then
    select * into a from employees where employee_code = upper(btrim(p_assignee)) and is_active and role <> 'VIEWER';
    if a.id is null then return jsonb_build_object('ok', false, 'code', 'ASSIGNEE_UNKNOWN', 'detail', format('%s is not an active employee', p_assignee)); end if;
  end if;
  if p_due is not null and p_due < app_today() then
    return jsonb_build_object('ok', false, 'code', 'IN_PAST', 'detail', format('the due date is before today (%s)', to_char(app_today(), 'DD Mon YYYY')));
  end if;
  if exists (select 1 from tasks x where x.project_id is not distinct from p.id and lower(x.title) = lower(v_title) and x.status in ('OPEN', 'IN_PROGRESS')) then
    return jsonb_build_object('ok', false, 'code', 'DUPLICATE_OPEN_TASK', 'detail', format('an open task "%s" already exists%s', v_title, coalesce(' on ' || p.project_number, '')));
  end if;
  insert into tasks (project_id, task_type, title, description, assignee_id, status, due_on, dedupe_key, task_number, created_by)
  values (p.id, p_type, v_title, v_desc, a.id, 'OPEN', p_due, 'web:' || p_request_key, next_friendly_id('TASK'), v_emp.id)
  returning * into t;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
  values ('USER', v_emp.employee_code, 'task.created', 'task', t.id, coalesce(p.project_number, t.task_number),
          jsonb_build_object('task_number', t.task_number, 'title', v_title, 'assignee', a.employee_code, 'due_on', p_due),
          format('Task %s: %s', t.task_number, v_title));
  return jsonb_build_object('ok', true, 'task_number', t.task_number, 'status', t.status, 'record_version', t.record_version);
end $$;

-- 4. Move a task on: start, done (its assignee or a manager); cancel, reassign, change the due date (a manager). Done and
--    Cancelled are final (state_transitions('task'), enforced by the tasks_state_machine trigger).
create or replace function web_task_update(p_token text, p_task text, p_action text, p_expected_version int, p_assignee text, p_due date, p_note text)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare
  v_emp employees := staff_session_employee(p_token); t tasks; a employees; v_manager boolean; v_mine boolean; v_to text; v_from text;
  v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_ref text;
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT'); end if;
  if coalesce(p_action, '') not in ('start', 'done', 'cancel', 'reassign', 'due') then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'unknown action');
  end if;
  select * into t from tasks where task_number = upper(btrim(coalesce(p_task, ''))) for update;
  if t.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', coalesce(p_task, 'no task')); end if;
  v_manager := staff_role_allowed(v_emp, 'task.manager_roles');
  v_mine := v_emp.is_active and t.assignee_id = v_emp.id;
  if not (v_manager or (v_mine and p_action in ('start', 'done'))) then
    return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED',
      'detail', case when v_mine then 'only a manager may do this' else format('%s is not assigned to %s', v_emp.employee_code, t.task_number) end);
  end if;
  if p_expected_version is distinct from t.record_version then
    return jsonb_build_object('ok', false, 'code', 'STALE', 'detail', format('%s changed since you opened it (now %s); reload and check it again', t.task_number, lower(replace(t.status, '_', ' '))));
  end if;
  if length(coalesce(v_note, '')) > 2000 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'the note is too long'); end if;
  v_from := t.status;
  v_to := case
    when p_action = 'start' and t.status = 'OPEN' then 'IN_PROGRESS'
    when p_action = 'done' and t.status in ('OPEN', 'IN_PROGRESS') then 'DONE'
    when p_action = 'cancel' and t.status in ('OPEN', 'IN_PROGRESS') then 'CANCELLED'
    when p_action in ('reassign', 'due') and t.status in ('OPEN', 'IN_PROGRESS') then t.status end;
  if v_to is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TRANSITION', 'detail', format('%s is %s', t.task_number, lower(replace(t.status, '_', ' '))));
  end if;
  if p_action = 'cancel' and length(coalesce(v_note, '')) < 5 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'detail', 'say why it is no longer needed (a few words)');
  end if;
  if p_action = 'reassign' then
    select * into a from employees where employee_code = upper(btrim(coalesce(p_assignee, ''))) and is_active and role <> 'VIEWER';
    if a.id is null then return jsonb_build_object('ok', false, 'code', 'ASSIGNEE_UNKNOWN', 'detail', format('%s is not an active employee', coalesce(nullif(p_assignee, ''), 'nobody'))); end if;
  end if;
  if p_action = 'due' and (p_due is null or p_due < app_today()) then
    return jsonb_build_object('ok', false, 'code', 'IN_PAST', 'detail', format('pick a due date from today (%s)', to_char(app_today(), 'DD Mon YYYY')));
  end if;
  update tasks set status = v_to,
         assignee_id = case when p_action = 'reassign' then a.id else assignee_id end,
         due_on = case when p_action = 'due' then p_due else due_on end,
         completed_at = case when v_to = 'DONE' then now() else completed_at end,
         completed_by = case when v_to = 'DONE' then v_emp.id else completed_by end,
         status_note = coalesce(v_note, status_note), record_version = record_version + 1, updated_at = now()
   where id = t.id returning * into t;
  select project_number into v_ref from projects where id = t.project_id;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
  values ('USER', v_emp.employee_code, 'task.' || p_action, 'task', t.id, coalesce(v_ref, t.task_number), jsonb_build_object('task_number', t.task_number, 'status', v_from),
          jsonb_build_object('task_number', t.task_number, 'status', t.status, 'assignee', (select employee_code from employees where id = t.assignee_id), 'due_on', t.due_on),
          coalesce(v_note, format('Task %s %s', t.task_number, lower(replace(t.status, '_', ' ')))));
  return jsonb_build_object('ok', true, 'task_number', t.task_number, 'status', t.status, 'record_version', t.record_version);
end $$;

-- Read models for the dashboard (names and roles only; no contact details).
create or replace view v_dashboard_staff as
select employee_code, full_name, role from employees where is_active and role <> 'VIEWER';

create or replace view v_dashboard_site_visits as
select j.job_number, p.project_number, c.display_name as customer_name,
       concat_ws(', ', pr.address_line1, pr.suburb) as site, pm.full_name as project_manager,
       j.job_type, j.status, j.scheduled_start, j.scheduled_end, j.actual_start, j.actual_end, j.notes, j.status_reason, j.record_version,
       (j.scheduled_start at time zone 'Australia/Brisbane')::date as visit_date,
       coalesce((select jsonb_agg(jsonb_build_object('code', e.employee_code, 'name', e.full_name, 'crew_role', a.crew_role)
                                  order by a.crew_role = 'LEADING_HAND' desc, e.full_name)
                   from job_assignments a join employees e on e.id = a.employee_id where a.job_id = j.id), '[]'::jsonb) as crew
from jobs j join projects p on p.id = j.project_id join customers c on c.id = p.customer_id
left join quotes q on q.id = p.quote_id left join properties pr on pr.id = q.property_id
left join employees pm on pm.id = p.project_manager_id;

create or replace view v_dashboard_tasks as
select t.task_number, p.project_number, t.task_type, t.title, t.description, t.status, t.due_on, t.status_note, t.record_version,
       ae.employee_code as assignee_code, ae.full_name as assignee_name, ce.full_name as created_by_name, t.created_at, t.completed_at,
       (t.status in ('OPEN', 'IN_PROGRESS') and t.due_on < app_today()) as overdue
from tasks t left join projects p on p.id = t.project_id
left join employees ae on ae.id = t.assignee_id left join employees ce on ce.id = t.created_by
where t.task_number is not null;

revoke execute on all functions in schema public from public;
revoke execute on function staff_role_allowed(employees, text), visit_crew_conflict(uuid[], timestamptz, timestamptz, uuid),
  visit_times_problem(timestamptz, timestamptz) from roofops_workflow, roofops_dashboard;
grant execute on function web_visit_schedule(text, text, text, timestamptz, timestamptz, text[], text, text, text),
  web_visit_update(text, text, text, int, text, timestamptz, timestamptz),
  web_task_create(text, text, text, text, text, date, text, text),
  web_task_update(text, text, text, int, text, date, text) to roofops_dashboard;
grant select on v_dashboard_staff, v_dashboard_site_visits, v_dashboard_tasks to roofops_dashboard;

update field_contract set editable_in = 'RoofOps dashboard (project Tasks card, My work): the assignee or a task manager',
       change_path = 'web_task_create / web_task_update (state_transitions(task))'
 where entity = 'task' and field_key = 'material_review';
