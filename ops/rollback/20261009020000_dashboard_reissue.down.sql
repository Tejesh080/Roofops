-- Rollback of 20261009020000_dashboard_reissue.sql (owner only; one transaction).
-- Removes the three dashboard reissue functions. Reissue requests and decisions already made stay (they are ordinary
-- REISSUE_INVOICE approvals and generations); the owner's CLI keeps working. The dashboard's reissue section then
-- shows that reissue is not available. Roll back 20261009030000 first if both are rolled back.
-- Run: npx tsx scripts/sql.ts -f ops/rollback/20261009020000_dashboard_reissue.down.sql
begin;
drop function web_reissue_decide(text, text, text);
drop function web_reissue_request(text, text, text);
drop function web_reissue_overview(text);
delete from schema_migrations where version = '20261009020000_dashboard_reissue.sql';
commit;
