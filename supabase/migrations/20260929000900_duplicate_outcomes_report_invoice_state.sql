-- Phase 3 fix (found in the live PRJ-2026-0004 run): a duplicate Prepare/Approve for an already-invoiced project was
-- reported to Airtable as "Duplicate ignored", overwriting "Xero draft created". The duplicate was correctly ignored, but
-- the project's Invoice Status then no longer described the invoice. Duplicate outcomes now carry the invoice's verified
-- Xero state, so [RoofOps] 04 can keep reporting the real state (and say the duplicate was ignored in the preview text).
--
-- The decision logic itself is unchanged: the migration-800 functions are renamed to *_core (no longer callable by the
-- workflow role) and wrapped by functions with the same signatures that only add `xero_state` to duplicate outcomes.

-- Verified Xero state of one RoofOps invoice (null when it has none). Xero IDs come only from verified external_links,
-- written by wf_complete_side_effect after read-back proof, never from the request.
create or replace function invoice_xero_state(p_invoice uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
           'invoice_id', i.id, 'invoice_number', i.invoice_number, 'status', i.status, 'sync_status', i.sync_status,
           'total_inc_gst', i.total_inc_gst,
           'xero_invoice_id', (select external_id from external_links where provider = 'XERO' and entity_type = 'invoice'
                                  and external_type = 'Invoice' and entity_id = i.id and verified_at is not null),
           'xero_invoice_number', (select payload ->> 'xero_invoice_number' from outbox
                                    where topic = 'xero.create_draft_invoice' and aggregate_id = i.id),
           'xero_contact_id', (select external_id from external_links where provider = 'XERO' and entity_type = 'customer'
                                  and external_type = 'Contact' and entity_id = i.customer_id and verified_at is not null),
           'xero_tenant_name', (select value from app_settings where key = 'xero.demo_tenant_name'))
  from invoices i where i.id = p_invoice
$$;
revoke execute on function invoice_xero_state(uuid) from public;

alter function wf_invoice_prepare(jsonb, text) rename to wf_invoice_prepare_core;
alter function wf_invoice_decide(jsonb, text) rename to wf_invoice_decide_core;
revoke execute on function wf_invoice_prepare_core(jsonb, text), wf_invoice_decide_core(jsonb, text) from public, roofops_workflow;

create or replace function wf_invoice_prepare(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res jsonb := wf_invoice_prepare_core(p_event, p_worker);
  v_inv uuid;
begin
  if v_res ->> 'outcome' = 'ALREADY_INVOICED' then
    select i.id into v_inv from invoices i join approvals a on a.id = i.approval_id where a.approval_number = v_res ->> 'approval_number';
    if v_inv is null then   -- already invoiced outside this approval flow (e.g. a FINAL invoice with no approval row)
      select i.id into v_inv from invoices i where i.invoice_type = 'FINAL'
         and i.project_id = (select id from projects where project_number = p_event -> 'payload' ->> 'project_number');
    end if;
    if v_inv is not null then v_res := v_res || jsonb_build_object('xero_state', invoice_xero_state(v_inv)); end if;
  end if;
  return v_res;
end $$;

create or replace function wf_invoice_decide(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res jsonb := wf_invoice_decide_core(p_event, p_worker);
begin
  if v_res ->> 'outcome' = 'ALREADY_PROCESSED' and v_res ? 'invoice_id' then
    v_res := v_res || jsonb_build_object('xero_state', invoice_xero_state((v_res ->> 'invoice_id')::uuid));
  end if;
  return v_res;
end $$;

revoke execute on function wf_invoice_prepare(jsonb, text), wf_invoice_decide(jsonb, text) from public;
grant execute on function wf_invoice_prepare(jsonb, text), wf_invoice_decide(jsonb, text) to roofops_workflow;
