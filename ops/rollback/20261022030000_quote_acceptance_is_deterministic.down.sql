-- Rollback of 20261022030000_quote_acceptance_is_deterministic.sql (owner only; one transaction). It restores wf_quote_accepted as
-- 20260929000700_one_exception_per_rejected_fact.sql defined it and removes the migration's record. No data changes: a rejection's stored
-- 'result' in automation_events.metadata is left in place and is ignored by the restored function.
-- Run: npx tsx scripts/sql.ts -f ops/rollback/20261022030000_quote_acceptance_is_deterministic.down.sql
begin;

-- restore wf_quote_accepted (20260929000700_one_exception_per_rejected_fact.sql)
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
    v_exc := wf_open_quote_rejection(v_event, v_q.id, v_quote_no, v_class, v_msg);
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

delete from schema_migrations where version = '20261022030000_quote_acceptance_is_deterministic.sql';
commit;
