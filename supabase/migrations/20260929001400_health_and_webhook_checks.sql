-- Phase 6: health and webhook supervision, decided in Postgres so n8n needs no table access.
--  * wf_webhook_check: given Airtable's webhook list, says which RoofOps webhooks are missing, expiring or disabled,
--    which consumers have unread payloads (a missed or lost ping) and must be "drained", and records the result.
--  * wf_record_health: the Xero check only counts as healthy if the PINNED Demo tenant is among the connections;
--    tenant ids are not stored in health details.
--  * v_consistency: Airtable / Drive / Xero ↔ Postgres agreement from the latest reconciliation plus live drift.

insert into app_settings (key, value) values
  ('airtable.expected_webhooks',
   'https://tejesh08.app.n8n.cloud/webhook/roofops/airtable/quote-events,https://tejesh08.app.n8n.cloud/webhook/roofops/airtable/project-invoice-events,https://tejesh08.app.n8n.cloud/webhook/roofops/airtable/changes'),
  ('reconcile.trigger_token_sha256', '')
on conflict (key) do nothing;

create or replace function wf_webhook_check(p_hooks jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_expected text[] := string_to_array((select value from app_settings where key = 'airtable.expected_webhooks'), ',');
  u text; w jsonb; v_status jsonb := '[]'; v_drain jsonb := '[]'; v_refresh jsonb := '[]'; v_missing jsonb := '[]'; v_ok boolean := true;
  v_cursor bigint; v_next bigint; v_hours numeric;
begin
  foreach u in array v_expected loop
    select x into w from jsonb_array_elements(coalesce(p_hooks, '[]'::jsonb)) x where x ->> 'notificationUrl' = u limit 1;
    if w is null then
      v_missing := v_missing || to_jsonb(u); v_ok := false;
      v_status := v_status || jsonb_build_object('url', u, 'state', 'MISSING');
      continue;
    end if;
    v_cursor := wf_airtable_cursor(w ->> 'id');
    v_next := coalesce((w ->> 'cursorForNextPayload')::bigint, v_cursor);
    v_hours := extract(epoch from ((w ->> 'expirationTime')::timestamptz - now())) / 3600;
    if v_next > v_cursor then v_drain := v_drain || jsonb_build_object('id', w ->> 'id', 'url', u, 'unread', v_next - v_cursor); end if;
    if v_hours is null or v_hours < 72 then v_refresh := v_refresh || to_jsonb(w ->> 'id'); end if;
    if not coalesce((w ->> 'isHookEnabled')::boolean, false) or coalesce(v_hours, -1) <= 0
       or coalesce((w -> 'lastNotificationResult' ->> 'success')::boolean, true) = false then v_ok := false; end if;
    v_status := v_status || jsonb_build_object('url', u, 'id', w ->> 'id', 'enabled', (w ->> 'isHookEnabled')::boolean,
      'expires', w ->> 'expirationTime', 'hours_left', round(coalesce(v_hours, 0)), 'unread_payloads', greatest(v_next - v_cursor, 0),
      'last_notification_ok', (w -> 'lastNotificationResult' ->> 'success')::boolean,
      'last_notification_at', w -> 'lastNotificationResult' ->> 'completionTimestamp',
      'state', case when not coalesce((w ->> 'isHookEnabled')::boolean, false) then 'DISABLED' when coalesce(v_hours, -1) <= 0 then 'EXPIRED'
                    when v_next > v_cursor then 'BEHIND' else 'OK' end);
  end loop;
  insert into integration_health (service, ok, detail) values ('airtable_webhooks', v_ok, jsonb_build_object('hooks', v_status));
  return jsonb_build_object('ok', v_ok, 'hooks', v_status, 'drain', v_drain, 'refresh', v_refresh, 'missing', v_missing);
end $$;

create or replace function wf_record_health(p_checks jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; v_tenant text := (select value from app_settings where key = 'xero.demo_tenant_id');
begin
  insert into integration_health (service, ok, latency_ms, detail)
  select x ->> 'service',
         coalesce((x ->> 'ok')::boolean, false)
           and (x ->> 'service' <> 'xero' or (coalesce(v_tenant, '') <> '' and coalesce(x -> 'detail' -> 'tenant_ids', '[]'::jsonb) ? v_tenant)),
         nullif(x ->> 'latency_ms', '')::int,
         case when x ->> 'service' = 'xero'
              then (coalesce(x -> 'detail', '{}'::jsonb) - 'tenant_ids')
                   || jsonb_build_object('pinned_demo_tenant_connected', coalesce(x -> 'detail' -> 'tenant_ids', '[]'::jsonb) ? coalesce(v_tenant, ''))
              else coalesce(x -> 'detail', '{}'::jsonb) end
    from jsonb_array_elements(p_checks) x
   where x ->> 'service' in ('airtable','airtable_webhooks','n8n','google_drive','xero','deepseek');
  get diagnostics n = row_count;
  insert into integration_health (service, ok, latency_ms, detail) values ('postgres', true, 0, '{"check":"wf_record_health write"}');
  delete from integration_health where checked_at < now() - interval '14 days';
  return jsonb_build_object('recorded', n + 1);
end $$;

-- Agreement between Postgres and each external system: what the last reconciliation checked, plus what is known now.
create or replace view v_consistency as
with run as (select * from reconciliation_runs where status = 'COMPLETED' order by finished_at desc limit 1),
f as (select f.* from reconciliation_findings f join run on run.id = f.run_id)
select 'AIRTABLE'::text as system,
       coalesce((select sum((t ->> 'records')::int) from run, jsonb_array_elements(coalesce(run.summary -> 'airtable' -> 'tables', '[]'::jsonb)) t), 0)::int as checked,
       (select count(distinct external_id) from f where system = 'AIRTABLE')::int as drift_found,
       (select count(distinct external_id) from f where system = 'AIRTABLE' and action in ('APPLIED_TO_POSTGRES','REJECTED_AND_REPAIRED','REPAIRED_AIRTABLE'))::int as repaired,
       (select count(*) from f where system = 'AIRTABLE' and classification in ('REQUIRES_HUMAN','EXTERNAL_MISSING','UNKNOWN'))::int as needs_person,
       (select count(distinct record_id) from v_state_drift)::int as drift_now,
       (select count(*) from external_links where provider = 'AIRTABLE' and external_type = 'Record')::int as linked,
       (select finished_at from run) as checked_at
union all
select 'GOOGLE_DRIVE', coalesce((select (summary -> 'drive' ->> 'checked')::int from run), 0),
       coalesce((select (summary -> 'drive' ->> 'drift')::int from run), 0), 0,
       (select count(*) from f where system = 'DRIVE')::int, null,
       (select count(*) from external_links where provider = 'GOOGLE_DRIVE' and entity_type = 'project' and external_type = 'Folder' and verified_at is not null)::int,
       (select finished_at from run)
union all
select 'XERO', coalesce((select (summary -> 'xero' ->> 'checked')::int from run), 0),
       coalesce((select (summary -> 'xero' ->> 'drift')::int from run), 0), 0,
       (select count(*) from f where system = 'XERO')::int, null,
       (select count(*) from external_links where provider = 'XERO' and external_type = 'Invoice' and verified_at is not null)::int,
       (select finished_at from run);

-- Last inbound activity per channel (the webhooks' "last event").
create or replace view v_integration_activity as
select source as channel, max(recorded_at) as last_event_at,
       count(*) filter (where recorded_at > now() - interval '24 hours')::int as events_24h,
       count(*) filter (where recorded_at > now() - interval '24 hours' and status in ('FAILED','REJECTED'))::int as problems_24h
from automation_events where source in ('airtable', 'reconciler', 'roofops-dashboard') group by source;

revoke execute on all functions in schema public from public;
grant execute on function wf_webhook_check(jsonb), wf_record_health(jsonb) to roofops_workflow;
grant select on v_consistency, v_integration_activity to roofops_dashboard;
