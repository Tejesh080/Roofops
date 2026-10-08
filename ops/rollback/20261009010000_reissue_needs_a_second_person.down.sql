-- Rollback of 20261009010000_reissue_needs_a_second_person.sql (owner only; one transaction).
-- Puts ops_reissue_decide back exactly as it was (the renamed original keeps its body and privileges), removes the
-- setting and the migration record. Faster alternative that keeps the code: set invoice.reissue_requires_second_person
-- to 'false' (the rule is then off; nothing else changes).
-- Run: npx tsx scripts/sql.ts -f ops/rollback/20261009010000_reissue_needs_a_second_person.down.sql
-- Roll back this one BEFORE 20261009000000 if both are rolled back.
begin;
drop function ops_reissue_decide(text, text, text);
alter function ops_reissue_decide_core(text, text, text) rename to ops_reissue_decide;
delete from app_settings where key = 'invoice.reissue_requires_second_person';
delete from schema_migrations where version = '20261009010000_reissue_needs_a_second_person.sql';
commit;
