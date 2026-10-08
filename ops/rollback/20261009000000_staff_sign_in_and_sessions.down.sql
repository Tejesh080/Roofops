-- Rollback of 20261009000000_staff_sign_in_and_sessions.sql (owner only; one transaction).
-- Removes staff sign-in: the 6 functions, both tables (accounts and sessions are deleted: everyone is signed out and
-- logins must be re-created after a re-apply), the setting and the migration record. Audit rows written while it was
-- live (staff.signed_in, staff.password_set, exception.resolved by a person) stay: history is never deleted.
-- pgcrypto stays installed (Supabase ships it in the extensions schema).
-- The dashboard keeps working: its staff sign-in fails closed and the shared demo login remains.
-- Run: npx tsx scripts/sql.ts -f ops/rollback/20261009000000_staff_sign_in_and_sessions.down.sql
begin;
drop function web_resolve_exception(text, text, text);
drop function web_staff_sign_out(text);
drop function web_staff_session(text);
drop function web_staff_sign_in(text, text);
drop function staff_session_employee(text);
drop function ops_staff_set_password(text, text, text);
drop table staff_sessions;
drop table staff_accounts;
delete from app_settings where key = 'staff.session_hours';
delete from schema_migrations where version = '20261009000000_staff_sign_in_and_sessions.sql';
commit;
