-- Hosted configuration change: run RoofOps on the REAL date (needs the owner's approval; not run by any migration).
-- Prerequisite: migration 20261017030000_release_blockers.sql is applied (business_date_mode exists).
-- Effect (rehearsed on the restored hosted copy 2026-10-17): "today" becomes the real Brisbane date. No stored date,
-- amount or status changes. Derived figures move with the calendar: overdue invoices 2 -> 8, projects with risk
-- reasons 6 -> 17, past planned completion 1 -> 15, open tasks overdue 0 -> 3 (the demo data was dated around 29 Sep).
-- New invoices, quotes and tasks are dated with the real date from then on.
-- Undo: the same statements with value 'SYNTHETIC' and the override '2026-09-29'.
-- Run: npx tsx scripts/sql.ts -f ops/business-date-switch-to-real.sql
with before as (
  select (select value from app_settings where key = 'business_date_mode') mode, (select value from app_settings where key = 'business_date_override') override
), m as (
  update app_settings set value = 'REAL', updated_at = now() where key = 'business_date_mode' returning 1
), o as (
  update app_settings set value = '', updated_at = now() where key = 'business_date_override' returning 1
), a as (
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
  select 'USER', 'operator:owner', 'settings.business_date_changed', 'app_setting', gen_random_uuid(), 'business_date_mode',
         jsonb_build_object('business_date_mode', b.mode, 'business_date_override', b.override),
         jsonb_build_object('business_date_mode', 'REAL', 'business_date_override', ''),
         'The pilot runs on the real date (the synthetic demo date is switched off)'
    from before b
  returning seq
)
select (select count(*)::int from m) mode_rows, (select count(*)::int from o) override_rows, (select count(*)::int from a) audited;
