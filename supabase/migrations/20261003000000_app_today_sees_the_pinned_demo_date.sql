-- app_today() returned the real Brisbane date to the dashboard, not the pinned demo date. It was a plain SQL function,
-- so it read app_settings as the caller; every public table has RLS on and no policies, so roofops_dashboard saw no
-- rows (its column grant on app_settings notwithstanding), the business_date_override was invisible, and the fallback
-- to now() won. Once the real date passed 2026-10-01, PRJ-2026-0011 showed "Past the planned finish date" on the
-- dashboard and in the copilot, while the same views read as the owner still said it was on schedule.
--
-- Rule: the business date is the same for every role. app_today() reads the setting as its owner (SECURITY DEFINER,
-- fixed search_path, same idiom as at_link/sm_label); it takes no input and returns one date. CREATE OR REPLACE keeps
-- its owner and grants (EXECUTE for roofops_dashboard only). The dashboard's column grant on app_settings existed
-- only for this read and returned nothing under RLS, so it goes: a direct read now fails loudly instead of silently.

create or replace function app_today() returns date
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select value::date from app_settings where key = 'business_date_override'),
    (now() at time zone 'Australia/Brisbane')::date)
$$;

revoke select (key, value) on app_settings from roofops_dashboard;
