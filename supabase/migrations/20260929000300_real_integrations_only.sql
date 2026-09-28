-- =============================================================================
-- Real integrations only (architecture change after Phase 1)
--
-- RoofOps no longer has mock providers. An external_links row must only ever
-- point at an object that really exists in the external system. The bundle's
-- placeholder identities (DEMO-XERO-nnnn invoice IDs, "mock-drive:" folders,
-- "Mock Drive" document paths) exist nowhere, so they are removed from the
-- core model. They remain verbatim in staging.* for lineage.
-- =============================================================================

do $$
declare n_links int; n_inv int; n_docs int;
begin
  delete from external_links where is_mock;
  get diagnostics n_links = row_count;

  update invoices set sync_status = 'NOT_SYNCED' where record_origin = 'IMPORT' and sync_status <> 'NOT_SYNCED';
  get diagnostics n_inv = row_count;

  alter table documents drop constraint if exists documents_storage_provider_check;
  update documents set storage_provider = 'NOT_STORED' where storage_provider = 'MOCK_DRIVE';
  get diagnostics n_docs = row_count;

  if n_links + n_inv + n_docs > 0 then
    insert into audit_events (actor_type, actor_id, actor_display, action, entity_type, entity_id, after_state, reason)
    values ('SYSTEM', 'migration:20260929000300', 'Schema migration', 'data.correction', 'database',
            stable_uuid('migration', '20260929000300'),
            jsonb_build_object('placeholder_external_links_deleted', n_links,
                               'imported_invoices_set_not_synced', n_inv,
                               'bundle_documents_marked_not_stored', n_docs),
            'Architecture change: real integrations only. Placeholder Xero/Drive identities from the synthetic bundle do not exist in any external system and were removed from the core model (kept in staging).');
  end if;
end $$;

-- Metadata-only documents are explicit; a file is either really stored somewhere or NOT_STORED.
alter table documents add constraint documents_storage_provider_check
  check (storage_provider in ('GOOGLE_DRIVE','SUPABASE_STORAGE','NOT_STORED'));

-- No mock flag: every external link is a real object in a real system.
alter table external_links drop column is_mock;
alter table external_links add column verified_at timestamptz;   -- set only after a read-back confirms the object exists

-- -----------------------------------------------------------------------------
-- Close the Supabase Data API surface completely. Supabase's default privileges
-- grant new tables/views/functions to anon + authenticated, so objects created
-- after the core migration (views, import_batches, schema_migrations, functions)
-- were reachable. Revoke existing grants AND change the defaults for future objects.
-- Workflow access will use a dedicated role with explicit EXECUTE grants only.
-- -----------------------------------------------------------------------------
do $$
begin
  execute 'revoke execute on all functions in schema public from public';
  execute 'alter default privileges in schema public revoke execute on functions from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'revoke all on all sequences in schema public from anon, authenticated';
    execute 'revoke all on all functions in schema public from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on tables from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on sequences from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on functions from anon, authenticated';
    execute 'revoke all on schema staging from anon, authenticated';
  end if;
end $$;
