-- Rollback of 20261022060000_pre_start_blocked_read_model.sql (owner only; one transaction): drops the read model and the
-- migration's record. Deploy the previous dashboard build first, so nothing reads the view.
-- Run: npx tsx scripts/sql.ts -f ops/rollback/20261022060000_pre_start_blocked_read_model.down.sql
begin;

drop view if exists v_dashboard_pre_start_blocked;

delete from schema_migrations where version = '20261022060000_pre_start_blocked_read_model.sql';
commit;
