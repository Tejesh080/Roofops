-- Operator action: pin the ONE Xero tenant RoofOps may write to, after [RoofOps] 96 Xero Read-Only Check proved it is a
-- Demo Company (Organisation.Class = 'DEMO', IsDemoCompany = true). Until this is pinned, wf_invoice_decide refuses to queue
-- any Xero write, and wf_complete_side_effect refuses proof from any other tenant.
-- Only pins when the setting is still empty (never silently re-points an existing pin). Tenant IDs are not secrets.
--   npx tsx scripts/sql.ts -f ops/pin-xero-demo-tenant.sql
with target as (
  select '96643bb0-3a0a-406e-96fb-ab8a933ee6b8'::text as tenant_id, 'Demo Company (AU)'::text as tenant_name,
         'n8n execution 1785 of [RoofOps] 96 Xero Read-Only Check: one connection, Class=DEMO, IsDemoCompany=true, AU/AUD'::text as evidence
), s as (
  update app_settings set value = case key when 'xero.demo_tenant_id' then t.tenant_id else t.tenant_name end, updated_at = now()
    from target t
   where key in ('xero.demo_tenant_id', 'xero.demo_tenant_name')
     and (select value from app_settings where key = 'xero.demo_tenant_id') = ''
  returning key
), a as (
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, external_reference, reason)
  select 'USER', 'operator:phase3', 'xero.demo_tenant.pin', 'xero_tenant', t.tenant_id::uuid, t.tenant_name,
         jsonb_build_object('xero.demo_tenant_id', ''),
         jsonb_build_object('xero.demo_tenant_id', t.tenant_id, 'xero.demo_tenant_name', t.tenant_name, 'organisation_class', 'DEMO', 'is_demo_company', true),
         'xero:tenant:' || t.tenant_id, t.evidence
  from target t where exists (select 1 from s)
  returning seq
)
select (select count(*) from s) as settings_pinned, (select count(*) from a) as audited;
