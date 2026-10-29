-- Rollback of 20261029120000_airtable_ping_mac.sql (owner only; one transaction): v_integration_activity exactly as
-- 20260929001400_health_and_webhook_checks.sql defined it, the three ping functions, the secrets and verdict tables, the
-- airtable.ping_mac setting, and the migration's record. Run it only after 00, 01, 04, 06 and 07 are back on their
-- previous versions (they call these functions). The stored secrets go with the table: re-applying the migration needs
-- the webhooks re-created to capture new ones. Audit rows stay (append-only).
-- Run: npx tsx scripts/sql.ts --confirm <project-ref> -f ops/rollback/20261029120000_airtable_ping_mac.down.sql
begin;

create or replace view v_integration_activity as
select source as channel, max(recorded_at) as last_event_at,
       count(*) filter (where recorded_at > now() - interval '24 hours')::int as events_24h,
       count(*) filter (where recorded_at > now() - interval '24 hours' and status in ('FAILED','REJECTED'))::int as problems_24h
from automation_events where source in ('airtable', 'reconciler', 'roofops-dashboard') group by source;

drop function wf_airtable_sign_ping(text, text);
drop function wf_airtable_ping_cursor(text, text, text);
drop function wf_airtable_webhook_created(text, text, text);
drop table airtable_ping_checks;
drop table integration_webhook_secrets;
delete from app_settings where key = 'airtable.ping_mac';

delete from schema_migrations where version = '20261029120000_airtable_ping_mac.sql';
commit;
