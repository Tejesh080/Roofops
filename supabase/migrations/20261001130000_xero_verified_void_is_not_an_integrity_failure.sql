-- AC-14B (docs/defect-ledger.md): AC-14 (20261001120000) legitimately follows a void made in Xero: 07's repair run
-- reads the linked invoice, records VERIFIED VOIDED, and applies APPROVED -> VOIDED (invoice.xero_settlement_applied).
-- But AC-05's integrity check was carried over verbatim and still treated every voided RoofOps invoice with a linked
-- Xero draft as a failure. So a designed state - the accountant voids the invoice in Xero, reconciliation verifies it -
-- left the correctness gate red: FAIL voided_invoice_has_no_xero_write -> INV-2026-0039 while xero_invoice_state_verified
-- PASSed, and scripts/integrity-check.ts exits 1 on any FAIL.
--
-- The rule (AC-05 is not weakened): a RoofOps-origin invoice that is VOIDED while its Xero write is pending, in
-- flight, ambiguous or linked and UNEXPLAINED is still a FAILURE. It is VALID only when the exact linked Xero invoice
-- (external_links XERO Invoice external_id) was independently read VERIFIED VOIDED in the tenant its write is bound to
-- (the outbox payload's xero_tenant_id) - exactly the condition invoice_void_guard already trusts (20261001120000:290).
--
-- Ordering, why not "the latest observation" as the guard uses: a Xero void is irreversible, so the exemption is
-- "such an observation EXISTS, and no later VERIFIED observation of that same linked InvoiceID says something else".
-- A latest-observation predicate would let a transient LOOKUP_FAILED read of the now-voided invoice flip a
-- legitimately voided invoice back to an integrity FAIL, and repeated repair runs (each recording VERIFIED VOIDED
-- again) must stay stable. A later VERIFIED read that contradicts the void (a different settlement for the same
-- linked InvoiceID) is not explained: it fails again, and a person looks.
--
-- Only the AC-05 predicate and its detail text change here; the rest of integrity_check() is the wrapper from
-- 20261001120000 (its AC-09, AC-13A and AC-14 checks) unchanged. A new migration, never an edit of an applied one.

create or replace function integrity_check()
returns table (entity text, check_key text, status text, failing int, detail text, refs text[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_refs text[];
begin
  return query select * from integrity_check_core();
  select array_agg(i.invoice_number order by i.invoice_number) into v_refs from invoices i
    left join outbox o on o.topic = 'xero.create_draft_invoice' and o.aggregate_id = i.id
   where i.status = 'VOIDED' and i.record_origin = 'ROOFOPS'
     and (i.sync_status in ('PENDING', 'UNKNOWN', 'SYNCED') or o.status in ('DISPATCHING', 'DONE')
          or exists (select 1 from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id))
     and not exists (select 1 from xero_invoice_observations x
                      where x.invoice_id = i.id and x.verdict = 'VERIFIED' and x.settlement = 'VOIDED'
                        and x.tenant_id = o.payload ->> 'xero_tenant_id'
                        and x.xero_invoice_id = (select l.external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id)
                        and not exists (select 1 from xero_invoice_observations y
                                         where y.invoice_id = x.invoice_id and y.verdict = 'VERIFIED' and y.xero_invoice_id = x.xero_invoice_id
                                           and y.settlement is distinct from 'VOIDED' and (y.observed_at, y.id) > (x.observed_at, x.id)));
  entity := 'invoice'; check_key := 'voided_invoice_has_no_xero_write';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'No Xero draft is created, pending, ambiguous or linked for a voided invoice, unless the exact linked Xero invoice was verified VOIDED in the tenant its write is bound to'; return next;
  -- AC-09: once a final invoice exists, everything validly billed equals the entitlement (short = under-billed).
  select array_agg(x.project_number || ' (' || (x.b ->> 'remaining') || ' left)' order by x.project_number) into v_refs
    from (select p.project_number, project_billing(p.id) b from projects p
           where exists (select 1 from invoices i where i.project_id = p.id and i.invoice_type = 'FINAL' and i.status not in ('VOIDED', 'DRAFT', 'PENDING_APPROVAL'))) x
   where (x.b ->> 'remaining')::numeric > 0;
  entity := 'invoice'; check_key := 'final_invoice_settles_entitlement';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'After the final invoice, quote + approved/invoiced variations - everything billed = 0 (left over means under-billed; a variation approved later needs its own invoice)'; return next;
  -- AC-13A: a CLOSED project is settled: nothing left to bill, nothing over-billed, everything paid, completion gate satisfied.
  select array_agg(p.project_number order by p.project_number) into v_refs from projects p
   where p.status = 'CLOSED' and ((project_billing(p.id) ->> 'remaining')::numeric <> 0
      or exists (select 1 from invoices i where i.project_id = p.id and not (invoice_financial_state(i.id, false) ->> 'settled')::boolean)
      or exists (select 1 from v_projects_missing_completion_docs v where v.id = p.id));
  entity := 'project'; check_key := 'closed_project_settled';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Closed projects have nothing left to bill, nothing over-billed, every invoice paid or voided, and their completion items done or waived'; return next;
  -- AC-13A: completed jobs held only by open completion items (staff set them in Airtable: Completion Photos / Compliance Certificate).
  select array_agg(x.project_number || ' (' || x.items || ')' order by x.project_number) into v_refs
    from (select v.project_number, string_agg(v.label, ', ' order by v.label) items from v_projects_missing_completion_docs v join projects p on p.id = v.id
           where p.status = 'COMPLETED' group by v.project_number) x;
  entity := 'project'; check_key := 'completed_awaiting_completion_items';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Completed jobs whose completion items are still To do in Airtable (Completion Photos / Compliance Certificate); no final invoice until they are Done, Waived or Not applicable'; return next;
  -- AC-14: every Xero-linked invoice was last read successfully, and RoofOps shows the state Xero verified.
  select array_agg(i.invoice_number || ' (' || case when x.id is null then 'never read from Xero'
                                                   when x.verdict <> 'VERIFIED' then 'last Xero check: ' || lower(replace(x.verdict, '_', ' '))
                                                   else 'Xero ' || lower(replace(x.settlement, '_', ' ')) || ', RoofOps ' || lower(i.status) end || ')' order by i.invoice_number) into v_refs
    from invoices i join external_links l on l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id and l.verified_at is not null
    left join lateral (select * from xero_invoice_observations o where o.invoice_id = i.id order by o.observed_at desc, o.id desc limit 1) x on true
   where i.sync_status = 'SYNCED' and (x.id is null or x.verdict <> 'VERIFIED' or i.status is distinct from xero_settlement_status(x.settlement));
  entity := 'invoice'; check_key := 'xero_invoice_state_verified';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every Xero-linked invoice was last read from its own Xero tenant and RoofOps shows the state Xero verified (a repair run applies it)'; return next;
end $$;

revoke execute on all functions in schema public from public;
grant execute on function integrity_check() to roofops_dashboard;
