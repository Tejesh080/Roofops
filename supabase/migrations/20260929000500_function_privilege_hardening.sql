-- =============================================================================
-- Function privilege hardening.
--
-- Postgres grants EXECUTE on every new function to PUBLIC by default, and
-- per-schema default privileges can only ADD to the global defaults, never
-- remove from them. So migration 300's
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC
-- was a no-op, and the wf_* entry points created in 400 were executable by
-- PUBLIC (and therefore by Supabase's anon/authenticated roles). Found by the
-- hosted exposure test; fixed here with the GLOBAL default plus explicit revokes.
-- =============================================================================

alter default privileges revoke execute on functions from public;

revoke execute on all functions in schema public from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on all functions in schema public from anon, authenticated';
  end if;
end $$;

-- Re-state the only intended grants: the workflow role may call the four entry points.
grant execute on function wf_quote_accepted(jsonb, text), wf_claim_side_effect(text, text, int),
                          wf_complete_side_effect(text, jsonb), wf_fail_side_effect(text, text, text, int, int)
  to roofops_workflow;
