-- Quote acceptance is deterministic (audit C1-AC23 = INT-02, C2-AC25, C3-AC18 = part of INT-03). Each was reproduced
-- first as a failing test through the production entry point (wf_quote_accepted, as n8n 01 sends it): test/workflow.test.ts.
--
-- AC-23 (C1, INT-02): an Accepted On typed in Airtable before the quote's Sent On violated quotes_check4 and raised. Nothing
-- was recorded, and n8n 01 (no error output on its Accept node; the cursor advances after it) re-read the same payload on
-- every ping, so every later acceptance stalled behind it. Rule (conservative): such a date is a handled REJECTED outcome,
-- error class VALIDATION_ERROR, one exception for the quote (wf_open_quote_rejection), no project, no raise. Otherwise as
-- before: a date from Sent On to today is kept as given (back-dating in that range is an owner decision); a future date
-- is refused as an invalid event.
--
-- AC-25 (C2): an acceptance from an Airtable record that is not the quote's verified record (Airtable's "Duplicate
-- record" copies Quote Number and RoofOps ID) created the project. Rule: when the quote has a verified Airtable Record
-- link and the event names another record, the acceptance is REJECTED (RECONCILIATION_MISMATCH, one exception naming both
-- records, no project). An event that names no record, or a quote with no verified record, is judged as before.
--
-- AC-18 (C3, INT-03 first part): an acceptance rejected while the quote was Draft created a project when the same
-- event_id was delivered again after the quote moved to Sent (the rejection releases the fact's claim, and the redelivery
-- was judged again). Rule: the first completed outcome of an event_id is final for that event_id. A redelivery of an
-- event whose delivery committed (any outcome) returns the stored outcome with duplicate: true and changes nothing (the
-- delivery is logged as DUPLICATE_IGNORED and counted on its open exception, as before); a new event_id is judged
-- normally; a delivery whose transaction failed was never recorded and is judged again. The existing machinery carries
-- it: the event row in automation_events (one per event_id, unique event_key) and, for a success, processed_events.
-- A rejection now keeps its outcome in its event row's metadata ('result'); one recorded earlier is rebuilt from the row.
--
-- wf_quote_accepted is its latest definition (20260929000700_one_exception_per_rejected_fact.sql) with only this
-- delta. CREATE OR REPLACE keeps its owner and ACL (execute for roofops_workflow only). No view, field contract, setting
-- or data change; no n8n change. The prior text is in the rollback file.

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
  v_first automation_events;
  v_quote_rec text;
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
                                'issues', to_jsonb(v_issues), 'exception_number', v_exc, 'redelivery', true, 'duplicate', true);
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

  -- AC-18: the first completed outcome of an event_id is final for that event_id. Only a delivery that committed left its
  -- event row (one that raised was rolled back, so it is judged again as new). A redelivery of a SUCCEEDED or
  -- DUPLICATE_IGNORED event gets the business fact's stored result below; a REJECTED one gets its own stored rejection
  -- here, without claiming the fact or judging it again against the quote as it is now (a Draft quote since moved to Sent
  -- made the same event_id create a project). A new event_id, a fresh Airtable change, is judged normally.
  if v_redelivery then
    select * into v_first from automation_events where event_key = p_event ->> 'event_id';
    if v_first.status = 'REJECTED' then
      -- A rejection recorded before this rule kept no outcome: it is rebuilt from its event row and its exception.
      v_result := coalesce(v_first.metadata -> 'result', jsonb_strip_nulls(jsonb_build_object('status', 'REJECTED',
        'outcome', case when v_first.metadata ? 'issues' then 'INVALID_EVENT' else 'INVALID_STATE' end, 'error_class', v_first.error_class,
        'retryable', false, 'message', v_first.metadata ->> 'reason', 'issues', v_first.metadata -> 'issues',
        'exception_number', (select x.exception_number from workflow_exceptions x
                              where x.event_id = v_first.event_id
                                 or (x.workflow_key = 'quote_to_project' and x.entity_type = 'quote' and x.business_reference = v_first.business_reference
                                     and x.error_class = v_first.error_class and x.error_message = v_first.metadata ->> 'reason')
                              order by (x.event_id is not distinct from v_first.event_id) desc, x.first_failed_at limit 1))))
        || jsonb_build_object('duplicate', true, 'redelivery', true);
      update automation_events set status = 'DUPLICATE_IGNORED', error_class = 'DUPLICATE_EVENT', causation_id = v_first.event_id,
             metadata = metadata || jsonb_build_object('reason', 'transport redelivery of the same event_id', 'first_outcome', 'REJECTED',
                                                        'exception_number', v_result ->> 'exception_number')
       where event_id = v_event;
      -- The delivery is counted on its open exception (as every rejected delivery is); a resolved one is left alone.
      update workflow_exceptions set attempt_count = attempt_count + 1, last_attempt_at = greatest(last_attempt_at, now())
       where exception_number = v_result ->> 'exception_number' and resolution_status in ('OPEN', 'RETRY_QUEUED');
      return v_result;
    end if;
  end if;

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
    select external_id into v_quote_rec from external_links
     where provider = 'AIRTABLE' and entity_type = 'quote' and entity_id = v_q.id and external_type = 'Record' and verified_at is not null;
    if v_payload ? 'quote_uuid' and (v_payload ->> 'quote_uuid')::uuid <> v_q.id then
      -- The staff-facing record and the control layer disagree about which quote this is: never guess.
      v_class := 'RECONCILIATION_MISMATCH';
      v_msg := format('Event names %s but its RoofOps ID %s is not that quote', v_quote_no, v_payload ->> 'quote_uuid');
    elsif v_quote_rec is not null and coalesce(v_payload ->> 'airtable_record_id', '') not in ('', v_quote_rec) then
      -- AC-25: the acceptance came from another Airtable record than the quote's verified one (a duplicated or copied row
      -- carries the same Quote Number and RoofOps ID). An event that names no record is judged as before.
      v_class := 'RECONCILIATION_MISMATCH';
      v_msg := format('Acceptance came from Airtable record %s, but %s is Airtable record %s: accept the quote on its own record',
                      v_payload ->> 'airtable_record_id', v_quote_no, v_quote_rec);
    elsif v_q.status not in ('SENT', 'ACCEPTED') then
      v_class := 'INVALID_STATE'; v_msg := format('Quote %s is %s; only a SENT quote can be accepted', v_quote_no, v_q.status);
    elsif v_latest.version_number <> v_version then
      v_class := 'INVALID_STATE'; v_msg := format('Accepted version v%s is not the current version v%s of %s', v_version, v_latest.version_number, v_quote_no);
    elsif v_q.status = 'ACCEPTED' and v_q.accepted_version_id <> v_latest.id then
      v_class := 'INVALID_STATE'; v_msg := format('%s was accepted at a different version', v_quote_no);
    elsif v_q.status = 'SENT' and v_accepted_on < v_q.sent_on then
      -- AC-23: checked before the date is written (quotes_check4 raised there, and n8n 01's cursor stalled behind it). A date
      -- from Sent On to today is kept as given (back-dating in that range is an owner decision); a future one was refused
      -- as an invalid event above. The message leaves out the typed date: one open exception per quote for this reason.
      v_class := 'VALIDATION_ERROR';
      v_msg := format('Accepted On is before %s was sent (%s): an acceptance cannot predate its quote', v_quote_no, v_q.sent_on);
    end if;
  end if;
  if v_class is not null then
    -- Release the claim: a corrected event for the same fact may be processed later.
    delete from processed_events where consumer = 'quote_to_project@1' and idempotency_key = v_key;
    update automation_events set status = 'REJECTED', error_class = v_class, metadata = metadata || jsonb_build_object('reason', v_msg) where event_id = v_event;
    v_exc := wf_open_quote_rejection(v_event, v_q.id, v_quote_no, v_class, v_msg);
    v_result := jsonb_build_object('status', 'REJECTED', 'outcome', 'INVALID_STATE', 'error_class', v_class, 'retryable', false, 'message', v_msg, 'exception_number', v_exc);
    -- AC-18: kept on this event, so a redelivery of the same event_id returns this outcome (above).
    update automation_events set metadata = metadata || jsonb_build_object('result', v_result) where event_id = v_event;
    return v_result;
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
