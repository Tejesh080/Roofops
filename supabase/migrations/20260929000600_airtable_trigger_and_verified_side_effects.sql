-- =============================================================================
-- Phase 2, live wiring: Airtable webhook trigger + stronger read-back proof.
--
--   integration_cursors            durable Airtable webhook payload cursor (n8n keeps no state)
--   wf_airtable_cursor(_advance)   read / monotonically advance it
--   wf_quote_accepted (v1.1)       + payload.quote_uuid cross-check against Postgres
--                                  + `outcome` (CREATED | ALREADY_PROCESSED | INVALID_EVENT | INVALID_STATE)
--                                  + write-back payload carries everything n8n needs (n8n cannot read tables)
--   wf_claim_side_effect (v1.1)    Airtable write-back waits for a verified Drive folder and receives it
--   wf_complete_side_effect (v1.1) Drive: root parent + all five subfolders proven; Airtable: quote link
--                                  and folder URL proven; subfolders recorded as external_links
-- =============================================================================

create table if not exists integration_cursors (
  provider     text not null,
  cursor_key   text not null,
  cursor_value bigint not null check (cursor_value >= 1),
  updated_at   timestamptz not null default now(),
  primary key (provider, cursor_key)
);
alter table integration_cursors enable row level security;
revoke all on integration_cursors from public;

create or replace function wf_airtable_cursor(p_webhook_id text)
returns bigint language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select cursor_value from integration_cursors where provider = 'AIRTABLE' and cursor_key = p_webhook_id), 1)
$$;

-- Monotonic: a slower, older execution can never move the cursor backwards.
create or replace function wf_airtable_cursor_advance(p_webhook_id text, p_cursor bigint)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare v bigint;
begin
  if coalesce(p_webhook_id, '') !~ '^ach[A-Za-z0-9]{14}$' then
    raise exception 'invalid Airtable webhook id %', p_webhook_id using errcode = 'check_violation';
  end if;
  insert into integration_cursors (provider, cursor_key, cursor_value) values ('AIRTABLE', p_webhook_id, p_cursor)
  on conflict (provider, cursor_key) do update
    set cursor_value = greatest(integration_cursors.cursor_value, excluded.cursor_value), updated_at = now()
  returning cursor_value into v;
  return v;
end $$;

update app_settings set value = '1.1.0' where key = 'wf.quote_to_project.version';

create or replace function wf_quote_accepted(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_issues text[] := '{}';
  v_event_key text := p_event ->> 'event_id';
  v_payload jsonb := p_event -> 'payload';
  v_quote_no text := v_payload ->> 'quote_id';
  v_version int;
  v_accepted_on date;
  v_corr uuid;
  v_event uuid;
  v_first_event uuid;
  v_key text;
  v_hash text;
  v_claimed boolean;
  v_pe processed_events;
  v_q quotes;
  v_latest quote_versions;
  v_project uuid;
  v_project_no text;
  v_pm uuid;
  v_task uuid;
  v_run uuid;
  v_exc text;
  v_result jsonb;
  v_class text;
  v_msg text;
  v_redelivery boolean := false;
begin
  -- ---------- 1. schema validation (non-retryable) ----------
  if coalesce(v_event_key, '') = '' or length(v_event_key) > 200 then v_issues := array_append(v_issues, 'event_id: required, <=200 chars'::text); end if;
  if coalesce(p_event ->> 'event_type', '') <> 'quote.accepted' then v_issues := array_append(v_issues, 'event_type: must be quote.accepted'::text); end if;
  if coalesce(p_event ->> 'source', '') = '' then v_issues := array_append(v_issues, 'source: required'::text); end if;
  if jsonb_typeof(v_payload) is distinct from 'object' then v_issues := array_append(v_issues, 'payload: required object'::text); end if;
  if coalesce(v_quote_no, '') !~ '^Q-[0-9]{4}-[0-9]{4}$' then v_issues := array_append(v_issues, 'payload.quote_id: required, format Q-YYYY-NNNN'::text); end if;
  if jsonb_typeof(v_payload -> 'accepted_version') is distinct from 'number'
     or (v_payload ->> 'accepted_version') !~ '^[1-9][0-9]{0,3}$' then
    v_issues := array_append(v_issues, 'payload.accepted_version: required positive integer'::text);
  else
    v_version := (v_payload ->> 'accepted_version')::int;
  end if;
  if v_payload ? 'quote_uuid' and coalesce(v_payload ->> 'quote_uuid', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_issues := array_append(v_issues, 'payload.quote_uuid: must be a UUID when present'::text);
  end if;
  begin
    v_accepted_on := coalesce((v_payload ->> 'accepted_on')::date, app_today());
    if v_accepted_on > app_today() then v_issues := array_append(v_issues, 'payload.accepted_on: cannot be in the future'::text); end if;
  exception when others then v_issues := array_append(v_issues, 'payload.accepted_on: must be YYYY-MM-DD'::text);
  end;
  begin
    perform (p_event ->> 'occurred_at')::timestamptz;
    if p_event ->> 'occurred_at' is null then v_issues := array_append(v_issues, 'occurred_at: required'::text); end if;
  exception when others then v_issues := array_append(v_issues, 'occurred_at: must be an ISO-8601 timestamp'::text);
  end;

  v_corr := stable_uuid('correlation', coalesce(nullif(p_event ->> 'correlation_id', ''), v_event_key, gen_random_uuid()::text));

  if array_length(v_issues, 1) > 0 then
    v_event_key := coalesce(nullif(v_event_key, ''), 'invalid:' || md5(p_event::text));
    -- A redelivered invalid event is still just one rejection.
    if exists (select 1 from automation_events where event_key = v_event_key) then
      select exception_number into v_exc from workflow_exceptions where event_id = stable_uuid('event', v_event_key) limit 1;
      return jsonb_build_object('status', 'REJECTED', 'outcome', 'INVALID_EVENT', 'error_class', 'VALIDATION_ERROR', 'retryable', false,
                                'issues', to_jsonb(v_issues), 'exception_number', v_exc, 'redelivery', true);
    end if;
    v_event := wf_log_event(v_event_key, v_corr, null, 'quote.accepted', 'quote', null, v_quote_no, 'INTEGRATION',
      p_event ->> 'actor_id', coalesce(p_event ->> 'source', 'unknown'), 'REJECTED', 'VALIDATION_ERROR',
      jsonb_build_object('issues', to_jsonb(v_issues), 'worker', p_worker), p_event);
    v_exc := wf_open_exception(null, v_event, 'quote', null, v_quote_no, 'VALIDATION_ERROR',
      'Invalid quote.accepted event: ' || array_to_string(v_issues, '; '), 1);
    return jsonb_build_object('status', 'REJECTED', 'outcome', 'INVALID_EVENT', 'error_class', 'VALIDATION_ERROR', 'retryable', false,
                              'issues', to_jsonb(v_issues), 'exception_number', v_exc);
  end if;

  -- ---------- 2. idempotency key = the business fact (ADR-002) ----------
  v_key := 'quote.accepted:' || v_quote_no || ':v' || v_version;
  v_hash := encode(sha256(convert_to(jsonb_build_object('quote_id', v_quote_no, 'accepted_version', v_version)::text, 'UTF8')), 'hex');

  -- Log the delivery. The unique event_key is the arbiter: if this event_id was already
  -- recorded (a transport redelivery, even a concurrent one), log it under a derived key
  -- instead, so the original event row is never relabelled.
  declare v_base text := v_event_key; v_n int;
  begin
    loop
      insert into automation_events (event_id, event_key, correlation_id, causation_id, event_type, entity_type, entity_id,
        business_reference, actor_type, actor_id, source, workflow_version, occurred_at, status, metadata, payload)
      values (stable_uuid('event', v_event_key), v_event_key, v_corr, v_first_event, 'quote.accepted', 'quote',
        (select id from quotes where quote_number = v_quote_no), v_quote_no, 'INTEGRATION', p_event ->> 'actor_id',
        p_event ->> 'source', (select value from app_settings where key = 'wf.quote_to_project.version'), now(), 'RECEIVED',
        jsonb_build_object('idempotency_key', v_key, 'worker', p_worker, 'airtable_record_id', v_payload ->> 'airtable_record_id',
                           'transport_redelivery', v_redelivery), p_event)
      on conflict do nothing   -- event_id is derived from event_key: a clash on either unique index means "already recorded"
      returning event_id into v_event;
      exit when v_event is not null;
      v_redelivery := true;
      v_first_event := stable_uuid('event', v_base);
      select count(*) + 1 into v_n from automation_events where event_key like v_base || ':redelivery:%';
      v_event_key := v_base || ':redelivery:' || v_n;
    end loop;
  end;

  insert into processed_events (consumer, idempotency_key, first_event_id, request_hash, status, locked_by, lease_expires_at)
  values ('quote_to_project@1', v_key, v_event, v_hash, 'PROCESSING', p_worker, now() + interval '5 minutes')
  on conflict do nothing
  returning true into v_claimed;

  if v_claimed is null then
    -- Someone already processed this business fact (their transaction has committed:
    -- a concurrent claimer blocks on the unique index until then).
    select * into v_pe from processed_events where consumer = 'quote_to_project@1' and idempotency_key = v_key for update;
    update processed_events set delivery_count = delivery_count + 1, last_seen_at = now() where consumer = v_pe.consumer and idempotency_key = v_key;
    update automation_events set status = 'DUPLICATE_IGNORED', error_class = 'DUPLICATE_EVENT', causation_id = v_pe.first_event_id,
           metadata = metadata || jsonb_build_object(
             'reason', case when v_redelivery then 'transport redelivery of the same event_id' else 'semantic duplicate: same quote and version already processed' end,
             'existing_project_number', v_pe.result ->> 'project_number', 'delivery_count', v_pe.delivery_count + 1)
     where event_id = v_event;
    return v_pe.result || jsonb_build_object('status', 'DUPLICATE', 'outcome', 'ALREADY_PROCESSED', 'duplicate', true, 'idempotency_key', v_key,
      'delivery_count', v_pe.delivery_count + 1,
      'pending_side_effects', (select coalesce(jsonb_agg(jsonb_build_object('topic', topic, 'key', idempotency_key, 'status', status) order by topic), '[]')
                                 from outbox where aggregate_id = (v_pe.result ->> 'project_id')::uuid and status <> 'DONE'));
  end if;

  -- ---------- 3. business validation ----------
  select * into v_q from quotes where quote_number = v_quote_no for update;
  if not found then
    v_class := 'NOT_FOUND'; v_msg := format('Quote %s does not exist', v_quote_no);
  else
    select * into v_latest from quote_versions where quote_id = v_q.id order by version_number desc limit 1;
    if v_payload ? 'quote_uuid' and (v_payload ->> 'quote_uuid')::uuid <> v_q.id then
      -- The staff-facing record and the control layer disagree about which quote this is: never guess.
      v_class := 'RECONCILIATION_MISMATCH';
      v_msg := format('Event names %s but its RoofOps ID %s is not that quote', v_quote_no, v_payload ->> 'quote_uuid');
    elsif v_q.status not in ('SENT', 'ACCEPTED') then
      v_class := 'INVALID_STATE'; v_msg := format('Quote %s is %s; only a SENT quote can be accepted', v_quote_no, v_q.status);
    elsif v_latest.version_number <> v_version then
      v_class := 'INVALID_STATE'; v_msg := format('Accepted version v%s is not the current version v%s of %s', v_version, v_latest.version_number, v_quote_no);
    elsif v_q.status = 'ACCEPTED' and v_q.accepted_version_id <> v_latest.id then
      v_class := 'INVALID_STATE'; v_msg := format('%s was accepted at a different version', v_quote_no);
    end if;
  end if;
  if v_class is not null then
    -- Release the claim: a corrected event for the same fact may be processed later.
    delete from processed_events where consumer = 'quote_to_project@1' and idempotency_key = v_key;
    update automation_events set status = 'REJECTED', error_class = v_class, metadata = metadata || jsonb_build_object('reason', v_msg) where event_id = v_event;
    v_exc := wf_open_exception(null, v_event, 'quote', v_q.id, v_quote_no, v_class, v_msg, 1);
    return jsonb_build_object('status', 'REJECTED', 'outcome', 'INVALID_STATE', 'error_class', v_class, 'retryable', false, 'message', v_msg, 'exception_number', v_exc);
  end if;

  -- ---------- 4. accept the quote (state transition, audited) ----------
  if v_q.status = 'SENT' then
    update quotes set status = 'ACCEPTED', accepted_version_id = v_latest.id, accepted_on = v_accepted_on where id = v_q.id;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason, correlation_id)
    values ('INTEGRATION', coalesce(p_event ->> 'actor_id', p_event ->> 'source'), 'quote.accept', 'quote', v_q.id, v_quote_no,
            jsonb_build_object('status', v_q.status), jsonb_build_object('status', 'ACCEPTED', 'accepted_version', v_version, 'accepted_on', v_accepted_on),
            'Accepted in ' || (p_event ->> 'source'), v_corr);
  end if;

  -- ---------- 5. project, checklist, material-review task ----------
  -- PM with the fewest active projects (deterministic tie-break)
  select e.id into v_pm from employees e
    left join projects p on p.project_manager_id = e.id and p.status not in ('COMPLETED','CLOSED','CANCELLED')
   where e.role = 'PROJECT_MANAGER' and e.is_active
   group by e.id, e.employee_code order by count(p.id), e.employee_code limit 1;

  v_project_no := next_friendly_id('PRJ', extract(year from app_today())::int);
  insert into projects (project_number, quote_id, accepted_quote_version_id, customer_id, property_id, project_manager_id, status, created_by_event_id)
  values (v_project_no, v_q.id, v_latest.id, v_q.customer_id, v_q.property_id, v_pm, 'PLANNING', v_event)
  returning id into v_project;

  insert into workflow_runs (workflow_key, workflow_version, runner, trigger_event_id, correlation_id, idempotency_key,
                             entity_type, entity_id, business_reference, status, attempt_count, started_at)
  values ('quote_to_project', (select value from app_settings where key = 'wf.quote_to_project.version'), 'N8N', v_event, v_corr, v_key,
          'project', v_project, v_project_no, 'RUNNING', 1, now())
  returning id into v_run;

  insert into project_checklist_items (project_id, item_code, label, stage, sort_order) values
    (v_project, 'MATERIALS_REVIEWED',     'Materials reviewed and approved',            'PRE_START', 10),
    (v_project, 'SWMS_SIGNED',            'Safe Work Method Statement signed',          'PRE_START', 20),
    (v_project, 'COMPLETION_PHOTOS',      'Completion / compliance photos uploaded',    'COMPLETION', 30),
    (v_project, 'COMPLIANCE_CERTIFICATE', 'Compliance certificate issued',              'COMPLETION', 40),
    (v_project, 'FINAL_INVOICE_APPROVED', 'Final invoice approved',                     'INVOICING', 50);

  insert into tasks (project_id, task_type, title, description, assignee_id, due_on, dedupe_key, created_by_workflow_run_id)
  values (v_project, 'MATERIAL_REVIEW', 'Review materials for ' || v_project_no,
          'Confirm quantities against the accepted quote ' || v_quote_no || ' v' || v_version || ' and raise POs.',
          v_pm, app_today() + 2, 'material_review:' || v_project, v_run)
  returning id into v_task;

  -- ---------- 6. external side effects: queued, performed by n8n, recorded only with read-back proof ----------
  insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload) values
    ('drive.ensure_project_folder', 'project', v_project, v_corr, 'drive:project-folder:' || v_project,
      jsonb_build_object('project_id', v_project, 'project_number', v_project_no, 'quote_number', v_quote_no,
                         'folder_name', v_project_no || ' - ' || (select btrim(display_name) from customers where id = v_q.customer_id),
                         'root_folder_name', 'RoofOps Demo',
                         'subfolders', jsonb_build_array('01 Quote', '02 Site', '03 Materials', '04 Supplier', '05 Completion'))),
    ('airtable.project_writeback', 'project', v_project, v_corr, 'airtable:project-writeback:' || v_project,
      jsonb_build_object('project_id', v_project, 'project_number', v_project_no, 'quote_number', v_quote_no,
                         'status', 'Planning',
                         'project_manager', (select full_name from employees where id = v_pm),
                         'material_task', 'Review materials for ' || v_project_no || ' (due ' || (app_today() + 2)::text || ')',
                         -- Airtable record IDs come from verified links, never from names; the event's own record ID is the fallback.
                         'quote_airtable_record_id', coalesce(
                            (select external_id from external_links where provider = 'AIRTABLE' and entity_type = 'quote' and entity_id = v_q.id and verified_at is not null),
                            v_payload ->> 'airtable_record_id'),
                         'customer_airtable_record_id',
                            (select external_id from external_links where provider = 'AIRTABLE' and entity_type = 'customer' and entity_id = v_q.customer_id and verified_at is not null)));

  -- ---------- 7. event + audit records ----------
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason, correlation_id, workflow_run_id)
  values ('WORKFLOW', 'quote_to_project@1', 'project.create', 'project', v_project, v_project_no,
          jsonb_build_object('project_number', v_project_no, 'quote', v_quote_no, 'version', v_version, 'status', 'PLANNING',
                             'project_manager', (select full_name from employees where id = v_pm)),
          'Quote ' || v_quote_no || ' accepted', v_corr, v_run),
         ('WORKFLOW', 'quote_to_project@1', 'task.create', 'task', v_task, v_project_no,
          jsonb_build_object('task_type', 'MATERIAL_REVIEW', 'due_on', app_today() + 2), 'Material review requested', v_corr, v_run);

  update automation_events set status = 'SUCCEEDED', entity_id = v_q.id where event_id = v_event;
  perform wf_log_event(v_event_key || ':project.created', v_corr, v_event, 'project.created', 'project', v_project, v_project_no,
    'WORKFLOW', 'quote_to_project@1', 'postgres', 'SUCCEEDED', null, jsonb_build_object('quote', v_quote_no), null);
  perform wf_log_event(v_event_key || ':materials.review_requested', v_corr, v_event, 'materials.review_requested', 'project', v_project, v_project_no,
    'WORKFLOW', 'quote_to_project@1', 'postgres', 'SUCCEEDED', null, jsonb_build_object('task_id', v_task), null);

  insert into workflow_run_steps (run_id, attempt, seq, step_key, status, finished_at, detail) values
    (v_run, 1, 1, 'validate_event', 'SUCCEEDED', now(), '{}'),
    (v_run, 1, 2, 'claim_idempotency', 'SUCCEEDED', now(), jsonb_build_object('key', v_key)),
    (v_run, 1, 3, 'accept_quote', 'SUCCEEDED', now(), jsonb_build_object('previous_status', v_q.status)),
    (v_run, 1, 4, 'create_project', 'SUCCEEDED', now(), jsonb_build_object('project_number', v_project_no)),
    (v_run, 1, 5, 'create_checklist_and_task', 'SUCCEEDED', now(), jsonb_build_object('task_id', v_task)),
    (v_run, 1, 6, 'queue_side_effects', 'SUCCEEDED', now(), jsonb_build_object('topics', array['drive.ensure_project_folder','airtable.project_writeback']));

  v_result := jsonb_build_object('status', 'CREATED', 'outcome', 'CREATED', 'duplicate', false, 'project_id', v_project, 'project_number', v_project_no,
    'quote_number', v_quote_no, 'task_id', v_task, 'workflow_run_id', v_run, 'correlation_id', v_corr, 'idempotency_key', v_key,
    'side_effects', jsonb_build_array(
      jsonb_build_object('topic', 'drive.ensure_project_folder', 'key', 'drive:project-folder:' || v_project),
      jsonb_build_object('topic', 'airtable.project_writeback', 'key', 'airtable:project-writeback:' || v_project)));
  update processed_events set status = 'COMPLETED', completed_at = now(), result = v_result, lease_expires_at = null
   where consumer = 'quote_to_project@1' and idempotency_key = v_key;
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- wf_claim_side_effect v1.1: the Airtable write-back depends on the Drive folder
-- (it writes the folder URL). It cannot be claimed until the folder is verified,
-- and the claim hands n8n the verified folder so it never has to look it up.
-- ---------------------------------------------------------------------------
create or replace function wf_claim_side_effect(p_key text, p_worker text, p_lease_seconds int default 120)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare o outbox; v_dep outbox;
begin
  select * into o from outbox where idempotency_key = p_key;
  if not found then
    return jsonb_build_object('claimed', false, 'status', 'UNKNOWN_KEY');
  end if;
  if o.topic = 'airtable.project_writeback' then
    select * into v_dep from outbox where aggregate_id = o.aggregate_id and topic = 'drive.ensure_project_folder';
    if found and v_dep.status <> 'DONE' then
      return jsonb_build_object('claimed', false, 'key', o.idempotency_key, 'topic', o.topic, 'status', 'WAITING_ON_DEPENDENCY',
        'depends_on', v_dep.idempotency_key, 'dependency_status', v_dep.status);
    end if;
  end if;

  update outbox set status = 'DISPATCHING', attempts = attempts + 1, locked_until = now() + make_interval(secs => p_lease_seconds),
         last_error = null
   where idempotency_key = p_key
     and ((status in ('PENDING','FAILED') and next_attempt_at <= now()) or (status = 'DISPATCHING' and locked_until < now()))
  returning * into o;
  if found then
    return jsonb_build_object('claimed', true, 'key', o.idempotency_key, 'topic', o.topic, 'attempt', o.attempts, 'worker', p_worker,
      'payload', o.payload || case when v_dep.idempotency_key is not null then jsonb_build_object('drive_folder', v_dep.result) else '{}'::jsonb end);
  end if;
  select * into o from outbox where idempotency_key = p_key;
  return jsonb_build_object('claimed', false, 'key', o.idempotency_key, 'topic', o.topic, 'status', o.status,
    'result', o.result, 'retry_at', case when o.status = 'FAILED' then o.next_attempt_at end, 'locked_until', o.locked_until,
    'attempts', o.attempts, 'last_error', o.last_error);
end $$;

-- ---------------------------------------------------------------------------
-- wf_complete_side_effect v1.1: only accepts results that carry read-back proof,
-- and checks that proof against what the control layer asked for.
-- ---------------------------------------------------------------------------
create or replace function wf_complete_side_effect(p_key text, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o outbox;
  v_existing text;
  v_run uuid;
  v_left int;
  v_ref text;
  v_expected jsonb;
  v_got jsonb;
  v_sub jsonb;
  v_drive_url text;
begin
  select * into o from outbox where idempotency_key = p_key for update;
  if not found then raise exception 'unknown side effect %', p_key using errcode = 'no_data_found'; end if;
  if o.status = 'DONE' then
    return jsonb_build_object('status', 'ALREADY_DONE', 'result', o.result);
  end if;
  if o.status <> 'DISPATCHING' then
    raise exception 'side effect % is %, not claimed', p_key, o.status using errcode = 'check_violation';
  end if;
  if coalesce((p_result ->> 'verified')::boolean, false) is not true then
    raise exception 'refusing to record % without read-back verification (verified=true)', p_key using errcode = 'check_violation';
  end if;
  v_ref := o.payload ->> 'project_number';

  if o.topic = 'drive.ensure_project_folder' then
    if coalesce(p_result ->> 'folder_id', '') = '' or coalesce(p_result ->> 'mime_type', '') <> 'application/vnd.google-apps.folder' then
      raise exception 'drive result needs folder_id and mime_type=application/vnd.google-apps.folder' using errcode = 'check_violation';
    end if;
    if coalesce(p_result ->> 'parent_id', '') = '' or coalesce((p_result ->> 'trashed')::boolean, true) then
      raise exception 'drive result needs parent_id and trashed=false from the read-back' using errcode = 'check_violation';
    end if;
    if p_result ->> 'name' is distinct from o.payload ->> 'folder_name' then
      raise exception 'drive folder name % does not match %', p_result ->> 'name', o.payload ->> 'folder_name' using errcode = 'check_violation';
    end if;
    if p_result -> 'app_properties' ->> 'roofops_project_id' is distinct from o.aggregate_id::text then
      raise exception 'drive folder is not tagged with project %', o.aggregate_id using errcode = 'check_violation';
    end if;
    -- Every requested subfolder, exactly once, each read back as a live folder inside the project folder.
    v_expected := coalesce(o.payload -> 'subfolders', '[]'::jsonb);
    select coalesce(jsonb_agg(s ->> 'name' order by s ->> 'name'), '[]') into v_got
      from jsonb_array_elements(coalesce(p_result -> 'subfolders', '[]'::jsonb)) s
     where coalesce(s ->> 'id', '') <> '' and s ->> 'parent_id' = p_result ->> 'folder_id'
       and s ->> 'mime_type' = 'application/vnd.google-apps.folder' and not coalesce((s ->> 'trashed')::boolean, true);
    if v_got <> (select coalesce(jsonb_agg(e order by e), '[]') from jsonb_array_elements_text(v_expected) e) then
      raise exception 'drive subfolders read back % do not match the required %', v_got, v_expected using errcode = 'check_violation';
    end if;

    select external_id into v_existing from external_links
     where provider = 'GOOGLE_DRIVE' and entity_type = 'project' and entity_id = o.aggregate_id and external_type = 'Folder';
    if v_existing is not null and v_existing <> p_result ->> 'folder_id' then
      raise exception 'project % already linked to Drive folder %, refusing a second folder %', v_ref, v_existing, p_result ->> 'folder_id'
        using errcode = 'unique_violation';
    end if;
    insert into external_links (provider, entity_type, entity_id, external_type, external_id, external_url, last_synced_at, verified_at)
    values ('GOOGLE_DRIVE', 'project', o.aggregate_id, 'Folder', p_result ->> 'folder_id', p_result ->> 'web_view_link', now(), now())
    on conflict (provider, entity_type, entity_id, external_type) do update set verified_at = now(), last_synced_at = now();
    for v_sub in select * from jsonb_array_elements(p_result -> 'subfolders') loop
      insert into external_links (provider, entity_type, entity_id, external_type, external_id, external_url, last_synced_at, verified_at)
      values ('GOOGLE_DRIVE', 'project', o.aggregate_id, 'Folder:' || (v_sub ->> 'name'), v_sub ->> 'id', v_sub ->> 'web_view_link', now(), now())
      on conflict (provider, entity_type, entity_id, external_type) do update set verified_at = now(), last_synced_at = now();
    end loop;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, external_reference, reason, correlation_id)
    values ('INTEGRATION', 'google-drive', 'drive.folder.link', 'project', o.aggregate_id, v_ref,
            p_result - 'verified', p_result ->> 'folder_id', 'Project folder and subfolders created and read back from Google Drive', o.correlation_id);

  elsif o.topic = 'airtable.project_writeback' then
    if coalesce(p_result ->> 'project_record_id', '') !~ '^rec[A-Za-z0-9]{14}$' then
      raise exception 'airtable result needs project_record_id (recXXXXXXXXXXXXXX)' using errcode = 'check_violation';
    end if;
    if p_result ->> 'roofops_id' is distinct from o.aggregate_id::text or p_result ->> 'project_number' is distinct from v_ref then
      raise exception 'airtable record read back does not carry project % / %', v_ref, o.aggregate_id using errcode = 'check_violation';
    end if;
    if o.payload ->> 'quote_airtable_record_id' is not null
       and not coalesce(p_result -> 'linked_quote_record_ids' ? (o.payload ->> 'quote_airtable_record_id'), false) then
      raise exception 'airtable project is not linked to quote record %', o.payload ->> 'quote_airtable_record_id' using errcode = 'check_violation';
    end if;
    select external_url into v_drive_url from external_links
     where provider = 'GOOGLE_DRIVE' and entity_type = 'project' and entity_id = o.aggregate_id and external_type = 'Folder';
    if v_drive_url is not null and p_result ->> 'drive_folder_url' is distinct from v_drive_url then
      raise exception 'airtable Drive Folder % does not match the verified folder %', p_result ->> 'drive_folder_url', v_drive_url using errcode = 'check_violation';
    end if;
    select external_id into v_existing from external_links
     where provider = 'AIRTABLE' and entity_type = 'project' and entity_id = o.aggregate_id and external_type = 'Record';
    if v_existing is not null and v_existing <> p_result ->> 'project_record_id' then
      raise exception 'project % already linked to Airtable record %, refusing a second record %', v_ref, v_existing, p_result ->> 'project_record_id'
        using errcode = 'unique_violation';
    end if;
    insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
    values ('AIRTABLE', 'project', o.aggregate_id, 'Record', p_result ->> 'project_record_id', now(), now())
    on conflict (provider, entity_type, entity_id, external_type) do update set verified_at = now(), last_synced_at = now();
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, external_reference, reason, correlation_id)
    values ('INTEGRATION', 'airtable', 'airtable.project.writeback', 'project', o.aggregate_id, v_ref,
            p_result - 'verified', p_result ->> 'project_record_id', 'Project record written to Airtable, linked to its quote and read back', o.correlation_id);
  else
    raise exception 'unknown side-effect topic %', o.topic;
  end if;

  update outbox set status = 'DONE', dispatched_at = now(), locked_until = null, result = p_result where idempotency_key = p_key;
  perform wf_log_event(p_key || ':done:' || o.attempts, o.correlation_id, null, replace(o.topic, 'ensure_', '') || '.verified',
    'project', o.aggregate_id, v_ref, 'INTEGRATION', o.topic, 'n8n', 'SUCCEEDED', null,
    jsonb_build_object('attempt', o.attempts, 'external_id', coalesce(p_result ->> 'folder_id', p_result ->> 'project_record_id')), null);

  select id into v_run from workflow_runs where entity_id = o.aggregate_id and workflow_key = 'quote_to_project';
  insert into workflow_run_steps (run_id, attempt, seq, step_key, status, finished_at, detail)
  values (v_run, o.attempts, (select coalesce(max(seq), 0) + 1 from workflow_run_steps where run_id = v_run), o.topic, 'SUCCEEDED', now(),
          jsonb_build_object('attempt', o.attempts, 'external_id', coalesce(p_result ->> 'folder_id', p_result ->> 'project_record_id')));
  select count(*) into v_left from outbox where aggregate_id = o.aggregate_id and status <> 'DONE';
  if v_left = 0 then
    update workflow_runs set status = 'SUCCEEDED', finished_at = now() where id = v_run;
    update workflow_exceptions set resolution_status = 'RESOLVED', resolved_at = now(),
           resolution_note = 'Auto-resolved: side effect succeeded on retry'
     where workflow_run_id = v_run and resolution_status in ('OPEN','RETRY_QUEUED');
  end if;
  return jsonb_build_object('status', 'RECORDED', 'key', p_key, 'remaining_side_effects', v_left);
end $$;

-- ---------------------------------------------------------------------------
-- Least privilege: the n8n role gets the two cursor functions, nothing else.
-- ---------------------------------------------------------------------------
revoke execute on function wf_airtable_cursor(text), wf_airtable_cursor_advance(text, bigint) from public;
grant execute on function wf_airtable_cursor(text), wf_airtable_cursor_advance(text, bigint) to roofops_workflow;
