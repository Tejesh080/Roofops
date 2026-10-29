-- AC-14C hosted deployment pre-flight (READ ONLY). One SELECT; it writes nothing and calls only STABLE read functions.
-- Run on the hosted database BEFORE any migration, and only with the owner's go-ahead:
--   npx tsx scripts/sql.ts -f ops/reissue-demo-preflight.sql
-- It references only objects that exist at 20261001120000 (the hosted head): no outbox.generation, no ledger table.
-- Every row is a check: ok = true means "safe to deploy" for checks 1-8; 9 and 10 are information for the demo.
with repo(version, checksum) as (values
    ('20260929000000_core_schema.sql', 'c1f493bc8e68e5eff28e2b496870d9842e92edd8b15d15a2bf3461db9b4ecf04'),
    ('20260929000100_staging_and_import.sql', '1153e02496d5c20b9297b57325280ee68ab99429fbfd666ae4750550603d9873'),
    ('20260929000200_operational_views.sql', '6b891106fde67fe1cf17ca4897176ba7acf8607b55305b3989024b3aad380f58'),
    ('20260929000300_real_integrations_only.sql', '4373db62a660dc05e03c1f0bfce2ec38f543e3c080860cbb1cebfa89acfa5e4f'),
    ('20260929000400_quote_to_project_workflow.sql', 'e0349fda96767d70c4e6f09e2ac2bbc96da9628cc2d84ac230987710c56ae592'),
    ('20260929000500_function_privilege_hardening.sql', 'a84a65f326848ef0a1d2a5e549d9811d1eeb8f7a3c5f7e35e262126770d50f01'),
    ('20260929000600_airtable_trigger_and_verified_side_effects.sql', '663dd5e28b0e1e4a81653d023d31af42c9f698a6d6d950835c1b8cfb61c279f0'),
    ('20260929000700_one_exception_per_rejected_fact.sql', '4e488c12c91561b8eeebacc265716504e53ca01e73029aa53f3f87b586758609'),
    ('20260929000800_xero_draft_invoice.sql', '2593f24fb8af34e4fc77afa741db629434d95ffac52b23b95c695cdbfccc9e0b'),
    ('20260929000900_duplicate_outcomes_report_invoice_state.sql', '6a956c23e947ed8e0c2cc278b051465f12bef8c64cdbf4f76be4ef5b1658433e'),
    ('20260929001000_dashboard_read_models.sql', '5dc4ecffbbe9510d8c867a1612a09f57b92922776e371c955c7e8b2c1139467a'),
    ('20260929001100_dashboard_projects_fixes.sql', 'faa6847364941e4886cdbcbb341c088bf9c496945498d41c0dc70d0b41d2798b'),
    ('20260929001200_state_integrity.sql', '5052404548a0515fd5ec340dc1dea813dfb43a2f6fcf60774f8ad22a97a93f6b'),
    ('20260929001300_airtable_change_writeback.sql', 'e33f55ad56bd82ce9d297583fa89faae3466ea6ad09a64fbd19e614d6764b2c5'),
    ('20260929001400_health_and_webhook_checks.sql', 'be4b93611f480ff46eac8e8dba00c0529f11f0da88ed91fbebbff58b4edd4f92'),
    ('20260929001500_reconcile_missing_projection.sql', '9a1296e60f5c1810d4bb43f74c0097f41b09135a6dd1b863aab0b5ee20d6d963'),
    ('20260929001600_dashboard_health_grants.sql', '3524777ee3d351a5996445a4ede2d6ba023cc8e26b6c2f3bab9655f2de9a071b'),
    ('20260930000000_reconcile_never_replays_stale_reads.sql', 'd56c68394b1793df03c241998bc43f31b26bd605ada4291c68690e65445fe38e'),
    ('20260930010000_reconcile_field_shape_guards.sql', '740e6d4b129026180efe0a33565c257ae3802bb5bc08fb87ec9924494ddeb281'),
    ('20261001000000_roofops_writes_are_not_staff_edits.sql', 'c570be459b061e3900da3bf4605b243a97601976e25d1936d36b99a7b9c8c637'),
    ('20261001010000_invoice_decision_bound_to_row_and_preview.sql', 'b7df8f4a1bf5d16bb2368a20bb94eab948971e5eb9efb0e0095b755d58774287'),
    ('20261001020000_invoice_decision_bound_to_exact_preview.sql', '50dc7fdf538951e1c7674882a07c81c648ecd43e86216bc388894f8b2256053e'),
    ('20261001030000_demo_reset_restores_airtable_projection.sql', '38314d1965a91711f605c038fd3710c88a8c2b53fc05b787f72c4b0b18e00d73'),
    ('20261001040000_supported_exception_resolution.sql', 'eb6c9a95bf613678d6193f679e1a66a2f64d165a5dd559d60d29b32041541b73'),
    ('20261001050000_reconcile_drive_rate_limit_resilience.sql', '9314af5d96509af598fe37ec1e5a9805baf9ba55b87fbb5ca47dbc520ff3d5fa'),
    ('20261001060000_voided_invoice_never_gets_a_xero_draft.sql', '6dea75f60f1b5fa8fe86495fd4abfbe616a3cbdcf10f9d489da02b4a8e5f52c0'),
    ('20261001065000_one_business_date_for_every_caller.sql', '0ca127d29637e867e603ad595d7b32358e85ed566790d5b436e065fb2f3a1c37'),
    ('20261001070000_xero_write_bound_to_its_tenant.sql', 'e84e1dc4c480e51bf078f403f60d5c8b6a4425efb051605a9ebdacb9884a3dfa'),
    ('20261001080000_ambiguous_xero_create_stays_unknown.sql', '52ed3bb410096182adab7a3f8a06f3b68a786d545c252dadd4fecbebb3c048da'),
    ('20261001090000_over_billed_project_is_never_fully_invoiced.sql', 'd938cbb6bfd6c9f74bc03c40cf70177931c1ff546dee9655ccf5bc09f394bab7'),
    ('20261001100000_one_canonical_billing_entitlement.sql', '00194dbf1fad317e7d343366a8d7ee508d87fa4845600b99e15427c54b695e4d'),
    ('20261001110000_completion_gate_has_a_supported_path.sql', 'cb7c7e8efb4e7e6b28330da7b8626ebb8ed5a8cf371741c5a206b52d6afcd80a'),
    ('20261001120000_xero_verified_invoice_settlement.sql', 'ef03aed9d2cf72abed0417c5c937114dba3974175a8504778fbd83168dfbea05')),
billing as (
  select p.project_number, p.status, invoice_final_preview(p.id) as pv, project_billing(p.id) ->> 'remaining' as remaining,
         exists (select 1 from external_links l where l.provider = 'AIRTABLE' and l.entity_type = 'project' and l.external_type = 'Record' and l.entity_id = p.id) as airtable_linked,
         (select string_agg(i.invoice_number || ':' || i.status || '/' || i.sync_status, ', ' order by i.invoice_number)
            from invoices i where i.project_id = p.id and i.invoice_type = 'FINAL') as finals
    from projects p)
select '01 migrations: 33 applied, head 20261001120000' as check_name,
       (select count(*) = 33 and max(version) = '20261001120000_xero_verified_invoice_settlement.sql' from schema_migrations) as ok,
       (select count(*)::text || ' applied, head ' || max(version) from schema_migrations) as detail
union all
select '01b migrations: hosted checksums equal the repo (33 of 33)',
       (select count(*) = 33 from repo r join schema_migrations m on m.version = r.version and m.checksum = r.checksum),
       (select count(*)::text || ' mismatched or missing' || coalesce(': ' || string_agg(r.version, ', '), '')
          from repo r left join schema_migrations m on m.version = r.version where m.checksum is distinct from r.checksum)
union all
select '02 [150000 index] no invoice has two Xero draft writes',
       not exists (select 1 from outbox where topic = 'xero.create_draft_invoice' group by aggregate_id having count(*) > 1),
       (select count(*)::text || ' invoices with more than one draft write' from
          (select aggregate_id from outbox where topic = 'xero.create_draft_invoice' group by aggregate_id having count(*) > 1) d)
union all
select '03 [150000 index] no invoice has two live (PENDING/DISPATCHING) draft writes',
       not exists (select 1 from outbox where topic = 'xero.create_draft_invoice' and status in ('PENDING','DISPATCHING') group by aggregate_id having count(*) > 1),
       (select count(*)::text || ' draft writes PENDING/DISPATCHING in total' from outbox where topic = 'xero.create_draft_invoice' and status in ('PENDING','DISPATCHING'))
union all
select '04 [170000] constraint approvals_action_type_check exists',
       exists (select 1 from pg_constraint where conrelid = 'public.approvals'::regclass and conname = 'approvals_action_type_check'),
       (select coalesce(string_agg(conname, ', '), 'none') from pg_constraint where conrelid = 'public.approvals'::regclass and contype = 'c')
union all
select '05 [170000] every approvals.action_type is in the old list',
       not exists (select 1 from approvals where action_type not in ('SEND_PURCHASE_ORDER','APPROVE_PURCHASE_ORDER','CREATE_INVOICE',
                   'SYNC_INVOICE_TO_XERO','CANCEL_PROJECT','CHANGE_APPROVED_MATERIALS')),
       (select string_agg(action_type || ' x' || n, ', ' order by action_type) from (select action_type, count(*) n from approvals group by 1) a)
union all
select '06 nothing in flight: no outbox row PENDING or DISPATCHING',
       not exists (select 1 from outbox where status in ('PENDING','DISPATCHING')),
       (select coalesce(string_agg(topic || ':' || status || ' x' || n, ', '), 'none') from
          (select topic, status, count(*) n from outbox where status in ('PENDING','DISPATCHING') group by 1, 2) o)
union all
select '07 baseline: VOIDED invoices (160000 sets their outstanding to 0)', true,
       (select count(*)::text || ' VOIDED; outstanding before = ' || coalesce(sum(b.outstanding), 0)::text
          from invoices i left join v_invoice_balances b on b.id = i.id where i.status = 'VOIDED')
union all
select '08 settings: Demo tenant pinned, reconcile token hashed, no dispatch-token key yet',
       (select value = '96643bb0-3a0a-406e-96fb-ab8a933ee6b8' from app_settings where key = 'xero.demo_tenant_id')
         and (select length(value) = 64 from app_settings where key = 'reconcile.trigger_token_sha256')
         and not exists (select 1 from app_settings where key in ('reissue.dispatch_token_sha256', 'invoice.reissue_roles')),
       'tenant pinned: ' || coalesce((select (value = '96643bb0-3a0a-406e-96fb-ab8a933ee6b8')::text from app_settings where key = 'xero.demo_tenant_id'), 'missing')
         || '; reconcile hash length: ' || coalesce((select length(value)::text from app_settings where key = 'reconcile.trigger_token_sha256'), 'missing')
union all
select '09 info: the demo approver EMP-900 is an active FINANCE employee mapped to the Airtable approver',
       exists (select 1 from employees e join employee_external_identities x on x.employee_id = e.id
                where e.employee_code = 'EMP-900' and e.role = 'FINANCE' and e.is_active and x.provider = 'AIRTABLE'),
       (select coalesce(string_agg(e.employee_code || ' ' || e.role || case when e.is_active then '' else ' (inactive)' end, ', '), 'none')
          from employees e where e.role in ('FINANCE','ADMIN'))
union all
select '10 info: demo candidate ' || b.project_number, (b.pv ->> 'ok')::boolean and b.airtable_linked,
       'status ' || b.status || '; final preview: ' || coalesce(b.pv ->> 'ok', '?') || coalesce(' ' || (b.pv ->> 'error_class'), '')
         || coalesce(' (' || left(b.pv ->> 'message', 80) || ')', '') || '; remaining ' || coalesce(b.remaining, '?')
         || '; finals: ' || coalesce(b.finals, 'none') || '; airtable linked: ' || b.airtable_linked
  from billing b where b.status = 'COMPLETED'
order by 1;
