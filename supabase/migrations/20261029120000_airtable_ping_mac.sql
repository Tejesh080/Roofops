-- Task 1.5 / ADR-041 (INT-03, second part): Airtable notification pings are verified inside Postgres.
--
-- Airtable signs every ping with X-Airtable-Content-MAC: hmac-sha256=<hex>, an HMAC-SHA256 of the JSON body keyed with
-- the webhook's MAC secret. Airtable returns that secret only once, in the create response; n8n 07 dropped it and
-- 01, 04 and 06 checked only the base id and the webhook-id format. After INT-03's first part a forged ping could
-- still cost an n8n execution plus an Airtable read, and the logs could not tell real pings from forged ones.
--
-- Rule: the secret is stored at creation (00, 07 -> wf_airtable_webhook_created) and never leaves the database: no role
-- can select it, and the check (wf_airtable_ping_cursor) and 07's own wake-ping signature (wf_airtable_sign_ping) both
-- run in here (pgcrypto, already installed for staff sign-in). Every verdict is recorded for 7 days. Rollout is staged
-- by app_settings airtable.ping_mac: 'log' (this migration) records verdicts and lets every ping proceed; 'enforce'
-- returns no cursor for an unverified ping, so the workflow stops before calling Airtable. Any other value is enforce.
-- System Health shows the last 24 hours (v_integration_activity gains the channel 'airtable-pings').
--
-- New objects only, plus v_integration_activity (its only definition, 20260929001400, plus one UNION branch).
-- Rollback: ops/rollback/20261029120000_airtable_ping_mac.down.sql.

create table integration_webhook_secrets (
  id               uuid primary key default gen_random_uuid(),
  provider         text not null check (provider in ('AIRTABLE')),
  webhook_id       text not null,
  notification_url text not null,
  mac_secret       bytea not null,
  created_at       timestamptz not null default now(),
  unique (provider, webhook_id)
);
alter table integration_webhook_secrets enable row level security;
revoke all on integration_webhook_secrets from public;
comment on table integration_webhook_secrets is 'Webhook MAC secrets as returned once at creation (ADR-041). Written only by wf_airtable_webhook_created; read only inside wf_airtable_ping_cursor and wf_airtable_sign_ping. No role may select it.';

create table airtable_ping_checks (
  id         bigserial primary key,
  webhook_id text not null,
  verdict    text not null check (verdict in ('VALID', 'MAC_MISMATCH', 'MAC_MISSING', 'NO_SECRET')),
  mode       text not null check (mode in ('log', 'enforce')),
  accepted   boolean not null,
  checked_at timestamptz not null default now()
);
create index airtable_ping_checks_checked_at on airtable_ping_checks (checked_at);
alter table airtable_ping_checks enable row level security;
revoke all on airtable_ping_checks from public;
comment on table airtable_ping_checks is 'One row per Airtable ping checked by wf_airtable_ping_cursor (ADR-041), kept 7 days. No body and no MAC are stored.';

insert into app_settings (key, value) values ('airtable.ping_mac', 'log') on conflict (key) do nothing;

-- Called by 00 and 07 with the create response. Returns whether it stored, never the secret. A failed create (no id)
-- stores nothing; a URL RoofOps does not expect, or a secret that is not base64 of at least 16 bytes, is refused.
-- One secret per notification URL: a re-created webhook replaces its predecessor's.
create or replace function wf_airtable_webhook_created(p_webhook_id text, p_notification_url text, p_mac_secret_base64 text)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare v_key bytea; v_id uuid;
begin
  if coalesce(p_webhook_id, '') !~ '^ach[A-Za-z0-9]{14}$' then
    return jsonb_build_object('stored', false, 'reason', 'NO_WEBHOOK');
  end if;
  if not exists (select 1 from unnest(string_to_array((select value from app_settings where key = 'airtable.expected_webhooks'), ',')) u
                  where btrim(u) = p_notification_url) then
    raise exception 'unexpected Airtable notification URL for webhook %', p_webhook_id using errcode = 'check_violation';
  end if;
  begin
    v_key := decode(p_mac_secret_base64, 'base64');
  exception when others then
    v_key := null;
  end;
  if v_key is null or length(v_key) < 16 then
    raise exception 'invalid Airtable MAC secret for webhook %', p_webhook_id using errcode = 'check_violation';
  end if;
  delete from integration_webhook_secrets
   where provider = 'AIRTABLE' and (webhook_id = p_webhook_id or notification_url = p_notification_url);
  insert into integration_webhook_secrets (provider, webhook_id, notification_url, mac_secret)
  values ('AIRTABLE', p_webhook_id, p_notification_url, v_key) returning id into v_id;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
  values ('WORKFLOW', 'n8n:webhook-maintenance', 'integration.webhook_secret_stored', 'integration_webhook_secret', v_id, p_webhook_id,
          jsonb_build_object('notification_url', p_notification_url), 'Airtable returned the webhook MAC secret at creation (ADR-041)');
  return jsonb_build_object('stored', true, 'webhook_id', p_webhook_id);
end $$;

-- Called by 01, 04 and 06 with the ping body as received (JSON.stringify of the parsed body, as Airtable documents) and
-- the X-Airtable-Content-MAC header. Returns the payload cursor, or null when enforce mode refuses the ping.
create or replace function wf_airtable_ping_cursor(p_webhook_id text, p_body text, p_mac text)
returns bigint language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare
  v_key bytea; v_expected text; v_verdict text; v_accept boolean;
  v_mode text := case (select value from app_settings where key = 'airtable.ping_mac') when 'log' then 'log' else 'enforce' end;
begin
  if coalesce(p_webhook_id, '') !~ '^ach[A-Za-z0-9]{14}$' then
    raise exception 'invalid Airtable webhook id %', p_webhook_id using errcode = 'check_violation';
  end if;
  select mac_secret into v_key from integration_webhook_secrets where provider = 'AIRTABLE' and webhook_id = p_webhook_id;
  if v_key is null then
    v_verdict := 'NO_SECRET';
  elsif coalesce(p_mac, '') = '' then
    v_verdict := 'MAC_MISSING';
  else
    v_expected := 'hmac-sha256=' || encode(hmac(convert_to(coalesce(p_body, ''), 'UTF8'), v_key, 'sha256'), 'hex');
    -- Compare digests of both values, so how long the comparison takes says nothing about the expected MAC.
    v_verdict := case when digest(v_expected, 'sha256') = digest(p_mac, 'sha256') then 'VALID' else 'MAC_MISMATCH' end;
  end if;
  v_accept := v_verdict = 'VALID' or v_mode = 'log';
  insert into airtable_ping_checks (webhook_id, verdict, mode, accepted) values (p_webhook_id, v_verdict, v_mode, v_accept);
  delete from airtable_ping_checks where checked_at < now() - interval '7 days';
  if not v_accept then
    return null;
  end if;
  return wf_airtable_cursor(p_webhook_id);
end $$;

-- 07's wake ping to a consumer that missed Airtable's ping is signed here, so it passes the same check. Only a ping
-- of that webhook is signed; null when no secret is stored for it.
create or replace function wf_airtable_sign_ping(p_webhook_id text, p_body text)
returns text language plpgsql stable security definer set search_path = extensions, public, pg_temp as $$
declare v_ping jsonb; v_key bytea;
begin
  begin
    v_ping := p_body::jsonb;
  exception when others then
    v_ping := null;
  end;
  if coalesce(p_webhook_id, '') !~ '^ach[A-Za-z0-9]{14}$' or v_ping is null or jsonb_typeof(v_ping) <> 'object'
     or (v_ping #>> '{webhook,id}') is distinct from p_webhook_id then
    raise exception 'not a ping for %', coalesce(p_webhook_id, 'no webhook') using errcode = 'check_violation';
  end if;
  select mac_secret into v_key from integration_webhook_secrets where provider = 'AIRTABLE' and webhook_id = p_webhook_id;
  if v_key is null then
    return null;
  end if;
  return 'hmac-sha256=' || encode(hmac(convert_to(p_body, 'UTF8'), v_key, 'sha256'), 'hex');
end $$;

create or replace view v_integration_activity as
select source as channel, max(recorded_at) as last_event_at,
       count(*) filter (where recorded_at > now() - interval '24 hours')::int as events_24h,
       count(*) filter (where recorded_at > now() - interval '24 hours' and status in ('FAILED','REJECTED'))::int as problems_24h
from automation_events where source in ('airtable', 'reconciler', 'roofops-dashboard') group by source
union all
select 'airtable-pings', max(checked_at),
       count(*) filter (where checked_at > now() - interval '24 hours')::int,
       count(*) filter (where checked_at > now() - interval '24 hours' and verdict <> 'VALID')::int
from airtable_ping_checks having count(*) > 0;

revoke execute on all functions in schema public from public;
grant execute on function wf_airtable_webhook_created(text, text, text), wf_airtable_ping_cursor(text, text, text),
  wf_airtable_sign_ping(text, text) to roofops_workflow;
