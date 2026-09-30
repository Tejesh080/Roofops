-- Daily 07 Google Drive rate limit (docs/defect-ledger.md, "Daily 07 Drive rate limit"). The scheduled runs of 2026-09-30
-- and 2026-10-01 (n8n 1847, 1899) stopped at Find Drive Root: Google answered HTTP 403 with reason rateLimitExceeded
-- (ErrorInfo RATE_LIMIT_EXCEEDED, quota defaultPerMinutePerProject of the OAuth client's project, no Retry-After). 07
-- threw, after Airtable had reconciled with 0 drift, so the Xero check, webhook supervision and the run's finish never
-- happened. A rate-limited folder read would also have been recorded as "folder could not be read" drift per project.
--
-- Rule: 07 asks Postgres what to do with each Drive answer. A transient answer (429, 403 rateLimitExceeded /
-- userRateLimitExceeded, 5xx, network) is retried after Retry-After if Google sent one, else after a bounded exponential
-- backoff with jitter, up to a capped number of attempts. A refusal (401, 403 permission, daily quota, root missing) is
-- not retried. If Drive stays unavailable the run records that (health, one exception per cause, the run summary) and
-- finishes normally: Airtable and Xero results are kept and nothing is redone. The next successful Drive check records
-- Drive healthy and resolves the exception.

insert into app_settings (key, value) values
  ('drive.retry_max_attempts', '4'), ('drive.retry_base_seconds', '15'), ('drive.retry_max_wait_seconds', '120')
on conflict (key) do nothing;

-- Google's own reason for an error answer: errors[0].reason, else the ErrorInfo reason.
create or replace function drive_error_reason(p_body jsonb)
returns text language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_body #>> '{error,errors,0,reason}',
                  (select d ->> 'reason' from jsonb_array_elements(case when jsonb_typeof(p_body #> '{error,details}') = 'array' then p_body #> '{error,details}' else '[]'::jsonb end) d
                    where d ->> '@type' like '%ErrorInfo' limit 1))
$$;

-- What 07 should do with one Drive answer: ok | retry (after wait_seconds) | fail.
create or replace function wf_drive_call_decision(p_status int, p_headers jsonb, p_body jsonb, p_attempt int)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_max int := coalesce((select value::int from app_settings where key = 'drive.retry_max_attempts'), 4);
  v_base int := coalesce((select value::int from app_settings where key = 'drive.retry_base_seconds'), 15);
  v_cap int := coalesce((select value::int from app_settings where key = 'drive.retry_max_wait_seconds'), 120);
  v_status int := coalesce(p_status, 0); v_reason text := drive_error_reason(p_body); v_class text; v_ra text; v_wait int; v_files int;
begin
  if v_status = 200 then
    v_files := jsonb_array_length(case when jsonb_typeof(p_body -> 'files') = 'array' then p_body -> 'files' else '[]'::jsonb end);
    if v_files = 1 then
      return jsonb_build_object('action', 'ok', 'attempt', p_attempt, 'root_id', p_body #>> '{files,0,id}');
    end if;
    return jsonb_build_object('action', 'fail', 'retry', false, 'retryable', false, 'error_class', 'NOT_FOUND', 'attempts', p_attempt, 'http', v_status,
      'reason', format('The RoofOps root folder was found %s times in Google Drive (expected once): check the folder''s roofops_role=root property', v_files));
  end if;

  v_class := case
    when v_status = 429 or (v_status = 403 and v_reason in ('rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED')) then 'RATE_LIMITED'
    when v_status = 503 then 'SERVICE_UNAVAILABLE'
    when v_status between 500 and 599 then 'UPSTREAM_5XX'
    when v_status = 0 then 'NETWORK' end;

  if v_class is null then   -- a refusal: retrying it within the run cannot help
    return jsonb_build_object('action', 'fail', 'retry', false, 'retryable', v_status = 403 and v_reason in ('dailyLimitExceeded', 'quotaExceeded'),
      'attempts', p_attempt, 'http', v_status, 'google_reason', v_reason,
      'error_class', case when v_status = 401 then 'AUTH_FAILURE' when v_status = 403 and v_reason in ('dailyLimitExceeded', 'quotaExceeded') then 'RATE_LIMITED'
                          when v_status = 403 then 'PERMISSION_DENIED' when v_status = 404 then 'NOT_FOUND' else 'UNKNOWN' end,
      'reason', case
        when v_status = 401 then 'Google Drive refused the RoofOps credential (HTTP 401): reconnect the "RoofOps Google Drive" credential in n8n'
        when v_status = 403 and v_reason in ('dailyLimitExceeded', 'quotaExceeded') then format('Google Drive daily quota is exhausted (HTTP 403 %s): Drive is checked again after the quota resets', v_reason)
        when v_status = 403 then format('Google Drive denied access (HTTP 403 %s): check that the "RoofOps Google Drive" credential can read the RoofOps root folder', coalesce(v_reason, 'forbidden'))
        when v_status = 404 then 'Google Drive answered 404 for the root folder search: check the RoofOps root folder'
        else format('Google Drive answered HTTP %s%s: not retried', v_status, coalesce(' ' || v_reason, '')) end);
  end if;

  if p_attempt >= v_max then
    return jsonb_build_object('action', 'fail', 'retry', false, 'retryable', true, 'error_class', v_class, 'attempts', p_attempt, 'http', v_status, 'google_reason', v_reason,
      'reason', format('Google Drive %s (HTTP %s%s) on all %s attempts; Drive folders were not verified this run and are checked again at the next run. '
                       'If this keeps happening at the scheduled time, give the "RoofOps Google Drive" credential its own Google Cloud OAuth client or move the schedule off the hour',
                       case v_class when 'RATE_LIMITED' then 'kept its rate limit' when 'NETWORK' then 'could not be reached' else 'kept failing' end,
                       v_status, coalesce(' ' || v_reason, ''), p_attempt));
  end if;

  -- Retry-After (seconds or an HTTP date) wins; otherwise base * 2^(attempt-1) plus up to one base of jitter. Both capped.
  select value into v_ra from jsonb_each_text(coalesce(p_headers, '{}'::jsonb)) where lower(key) = 'retry-after' limit 1;
  if v_ra ~ '^\s*\d+\s*$' then
    v_wait := v_ra::int;
  elsif v_ra is not null then
    begin v_wait := ceil(extract(epoch from (v_ra::timestamptz - now())))::int; exception when others then v_wait := null; end;
  end if;
  if v_wait is null then
    v_wait := v_base * (2 ^ (p_attempt - 1))::int + floor(random() * (v_base + 1))::int;
  end if;
  v_wait := least(v_cap, greatest(1, v_wait));
  return jsonb_build_object('action', 'retry', 'error_class', v_class, 'attempt', p_attempt, 'next_attempt', p_attempt + 1, 'wait_seconds', v_wait,
    'http', v_status, 'google_reason', v_reason, 'retry_after', v_ra);
end $$;

-- Drive could not be checked in this run: keep the run, record why, one exception per cause (updated, not duplicated).
create or replace function wf_reconcile_drive_unavailable(p_run_key text, p_decision jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_run reconciliation_runs; v_class text := coalesce(p_decision ->> 'error_class', 'UNKNOWN'); v_msg text; v_exc text;
begin
  select * into v_run from reconciliation_runs where run_key = p_run_key and status = 'RUNNING';
  if v_run.id is null then return jsonb_build_object('ok', false, 'reason', 'no running reconciliation ' || coalesce(p_run_key, '')); end if;
  if not exists (select 1 from error_classes where code = v_class) then v_class := 'UNKNOWN'; end if;
  -- A stable message per cause, so every run with the same cause updates the same exception.
  v_msg := case v_class
    when 'RATE_LIMITED' then 'Reconciliation could not check Google Drive: rate limited after retries. Drive folders were not verified; checked again at the next run'
    when 'SERVICE_UNAVAILABLE' then 'Reconciliation could not check Google Drive: service unavailable after retries. Drive folders were not verified; checked again at the next run'
    when 'UPSTREAM_5XX' then 'Reconciliation could not check Google Drive: server errors after retries. Drive folders were not verified; checked again at the next run'
    when 'NETWORK' then 'Reconciliation could not reach Google Drive after retries. Drive folders were not verified; checked again at the next run'
    else coalesce(p_decision ->> 'reason', 'Reconciliation could not check Google Drive') end;
  v_exc := wf_open_sync_exception('reconciliation', 'integration', null, 'GOOGLE_DRIVE', v_class, v_msg);
  update reconciliation_runs set summary = summary || jsonb_build_object('drive', jsonb_build_object('checked', 0, 'verified', 0, 'drift', 0, 'status', 'UNAVAILABLE',
           'error_class', v_class, 'reason', p_decision ->> 'reason', 'attempts', p_decision -> 'attempts', 'exception', v_exc))
   where id = v_run.id;
  insert into integration_health (service, ok, detail)
  values ('google_drive', false, jsonb_build_object('check', 'reconciliation ' || p_run_key, 'error_class', v_class, 'reason', p_decision ->> 'reason',
                                                    'http', p_decision -> 'http', 'google_reason', p_decision ->> 'google_reason', 'attempts', p_decision -> 'attempts', 'exception', v_exc));
  return jsonb_build_object('ok', true, 'exception_number', v_exc, 'error_class', v_class);
end $$;

-- Drive folder results: rate-limited reads mean Drive was unavailable, not that a folder drifted. A complete check
-- records Drive healthy and resolves what an earlier unavailable check opened.
alter function wf_reconcile_external(text, text, jsonb) rename to wf_reconcile_external_core;
create or replace function wf_reconcile_external(p_run_key text, p_system text, p_results jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_limited jsonb; v_res jsonb; x record;
begin
  if p_system <> 'DRIVE' then return wf_reconcile_external_core(p_run_key, p_system, p_results); end if;
  select coalesce(jsonb_agg(r), '[]'::jsonb) into v_limited from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) r
   where coalesce((r ->> 'http')::int, 0) = 429 or ((r ->> 'http')::int = 403 and r ->> 'reason' in ('rateLimitExceeded', 'userRateLimitExceeded'));
  v_res := wf_reconcile_external_core(p_run_key, p_system,
             (select coalesce(jsonb_agg(r), '[]'::jsonb) from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) r where not (v_limited @> jsonb_build_array(r))));
  if not coalesce((v_res ->> 'ok')::boolean, false) then return v_res; end if;
  if jsonb_array_length(v_limited) > 0 then
    perform wf_reconcile_drive_unavailable(p_run_key, jsonb_build_object('error_class', 'RATE_LIMITED', 'attempts', 1, 'http', v_limited -> 0 -> 'http',
      'reason', format('Google Drive rate-limited %s of the folder reads; those folders were not verified this run and are checked again at the next run', jsonb_array_length(v_limited))));
    return v_res || jsonb_build_object('unavailable', true, 'not_verified', jsonb_array_length(v_limited));
  end if;
  insert into integration_health (service, ok, detail)
  values ('google_drive', true, jsonb_build_object('check', 'reconciliation ' || p_run_key, 'verified', v_res -> 'verified', 'drift', v_res -> 'drift'));
  for x in select id, exception_number from workflow_exceptions
            where workflow_key = 'reconciliation' and business_reference = 'GOOGLE_DRIVE' and resolution_status in ('OPEN', 'RETRY_QUEUED') for update loop
    update workflow_exceptions set resolution_status = 'RESOLVED', resolved_at = now(), resolved_by_system = 'workflow:reconciliation',
           resolution_note = 'Google Drive checked successfully in ' || p_run_key where id = x.id;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
    values ('SYSTEM', 'workflow:reconciliation', 'exception.resolved', 'workflow_exception', x.id, x.exception_number,
            '{"resolution_status":"OPEN"}', '{"resolution_status":"RESOLVED"}', 'Google Drive checked successfully in ' || p_run_key);
  end loop;
  return v_res;
end $$;

revoke execute on all functions in schema public from public;
revoke execute on function drive_error_reason(jsonb), wf_reconcile_external_core(text, text, jsonb) from roofops_workflow, roofops_dashboard;
grant execute on function wf_drive_call_decision(int, jsonb, jsonb, int), wf_reconcile_drive_unavailable(text, jsonb), wf_reconcile_external(text, text, jsonb) to roofops_workflow;
