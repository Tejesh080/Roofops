-- Reliability defect (found while verifying AC-06, 2026-10-04): the dashboard role silently used the server's real date.
-- app_today() was a plain SQL function reading app_settings.business_date_override as the CALLER. roofops_dashboard had
-- a column grant on app_settings, but RLS is on with no policy, so it saw no row and fell back to the real Brisbane date:
-- the dashboard and the Copilot ran on a different "today" from every Postgres workflow.
--
-- Rule: one RoofOps business date, resolved by app_today() with the owner's rights for every caller.
--  * business_date_override set to a date (YYYY-MM-DD): that date.
--  * Missing or empty: no override configured, the real date in Brisbane (documented production behaviour).
--  * Anything else: refused with an error, never replaced by another date.
-- The dashboard reads the date only through app_today() (already in its allow-list of SECURITY DEFINER functions);
-- its column grant on app_settings is revoked, so it has no access to configuration rows.

create or replace function app_today()
returns date language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text; d date;
begin
  select value into v from app_settings where key = 'business_date_override';
  if v is null or btrim(v) = '' then
    return (now() at time zone 'Australia/Brisbane')::date;
  end if;
  if btrim(v) !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'app_settings business_date_override "%" is not a date (YYYY-MM-DD): refusing to guess the business date', v
      using errcode = 'invalid_datetime_format';
  end if;
  begin
    d := btrim(v)::date;
  exception when others then
    raise exception 'app_settings business_date_override "%" is not a date (YYYY-MM-DD): refusing to guess the business date', v
      using errcode = 'invalid_datetime_format';
  end;
  return d;
end $$;

revoke select (key, value) on app_settings from roofops_dashboard;
revoke execute on all functions in schema public from public;
grant execute on function app_today() to roofops_dashboard;
