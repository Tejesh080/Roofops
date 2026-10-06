-- =============================================================================
-- AC-14C Part B1b (docs/defect-ledger.md): a VOIDED invoice has no collectible balance.
--
-- Part A (20261001140000) and Part B1a (20261001150000) make a Xero-verified DELETED or VOIDED final invoice VOIDED
-- in RoofOps while the customer still owes the work, and prepare the way back (the supervised reissue, Part B2). The
-- invoice is VOIDED, but v_invoice_balances still presented it as money owed, in all three void paths:
--   * the deletion path (AC-14C-A): the DELETED read is deliberately excluded from the Xero lateral - so a deletion
--     that moved money can never zero a live debt - which leaves the local total-minus-payments fallback: a deleted
--     final showed its whole total as outstanding (measured in Part A: 0.00 paid / 14,664.49 outstanding on a row
--     that was already VOIDED);
--   * the Xero void path (AC-14B): the void is applied from Xero's Status alone (xero_settlement), so a voided
--     document that still carries its original amounts drove the same full outstanding (amount_due as stored on the
--     observation);
--   * the local dead-letter void (AC-05): no Xero document exists and no read applies, so the fallback showed the
--     whole total again.
-- A voided invoice is not collectible: the dashboard and the executive KPIs kept counting a written-off invoice as
-- money owed. (is_overdue was already false for a VOIDED row - the predicate below now states that explicitly, so
-- the rule cannot be broken by a later change to the status test.)
--
-- The rule: v_invoice_balances keeps one row per invoice - the row, its amounts and its history stay visible - but a
-- VOIDED invoice reports outstanding = 0 and is_overdue = false. Every other invoice keeps exactly today's
-- semantics: the latest VERIFIED Xero read of the linked InvoiceID with settlement <> 'DELETED' (amounts as Xero
-- holds them) when one exists, otherwise the local total - payments fallback. A money-moved DELETED read is still
-- excluded from that lateral and changes nothing, so a live debt can never be silently zeroed by a deletion read.
--
-- Entitlement is deliberately untouched: project_billing, project_left_to_bill_after_final, invoice_final_preview
-- and the close gate are not changed, so the debt stays "left to bill" (VOIDED is never counted as billed) and the
-- supervised reissue (Part B2) can make it collectible again through the new generation's normal settlement states.
-- v_executive_kpis keeps driving its overdue figures from is_overdue, which a voided invoice no longer satisfies.
--
-- v_dashboard_projects is not changed: its final_invoice CTE selects only `i.status <> 'VOIDED'`, so a voided
-- generation cannot surface as XERO_DRAFT_CREATED / CREATING_IN_XERO / CHECKING_WITH_XERO, and its xero_invoice_id /
-- final_invoice_sync columns stay null for it. test/balance-read-model.test.ts pins that (a live draft still shows
-- XERO_DRAFT_CREATED, a voided one shows the project's truthful NOT_READY state).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The read model: one row per invoice; a voided invoice owes nothing.
-- -----------------------------------------------------------------------------
-- The Xero lateral is unchanged (it is what keeps a money-moved DELETED read from zeroing a live debt, and what
-- makes the Xero-verified amounts win for every other invoice); only the VOIDED row's two computed columns change.
create or replace view v_invoice_balances as
select i.id, i.invoice_number, i.project_id, p.project_number, i.customer_id, c.display_name as customer_name,
       i.status, i.sync_status, i.issue_date, i.due_date, i.total_inc_gst,
       coalesce(xv.paid, pay.paid, 0)::numeric as amount_paid,
       -- AC-14C B1b: a voided invoice is not collectible, whatever it used to owe and whatever its last read said.
       case when i.status = 'VOIDED' then 0::numeric
            else coalesce(xv.due, i.total_inc_gst - coalesce(pay.paid, 0))::numeric end as outstanding,
       -- ... and it is never overdue. Non-voided rows keep today's rule byte for byte.
       (i.status <> 'VOIDED' and i.status in ('ISSUED','PARTIALLY_PAID') and i.due_date < app_today()
        and coalesce(xv.due, i.total_inc_gst - coalesce(pay.paid, 0)) > 0) as is_overdue,
       greatest(app_today() - i.due_date, 0) as days_past_due
from invoices i
join projects p on p.id = i.project_id
join customers c on c.id = i.customer_id
left join (select invoice_id, sum(amount) paid from payments group by invoice_id) pay on pay.invoice_id = i.id
-- AC-14: the latest verified Xero read of a linked invoice (amounts as Xero holds them). settlement <> 'DELETED':
-- a deletion read is never the amounts of a live debt.
left join lateral (select o.amount_paid + o.amount_credited as paid, o.amount_due as due from xero_invoice_observations o
                    where o.invoice_id = i.id and o.verdict = 'VERIFIED' and o.settlement <> 'DELETED'
                      and o.xero_invoice_id = (select l.external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id)
                    order by o.observed_at desc, o.id desc limit 1) xv on true;

-- -----------------------------------------------------------------------------
-- 2. Privileges.
-- -----------------------------------------------------------------------------
-- No new function or table: create or replace view keeps the view's owner and its grants, so the dashboard's SELECT
-- on v_invoice_balances is untouched. The blanket revoke and the role grants are restated exactly as the previous
-- migration left them (a no-op here, kept so every migration's tail reads the same).
revoke execute on all functions in schema public from public;
grant execute on function integrity_check() to roofops_dashboard;
grant execute on function wf_reconcile_targets(text), wf_reconcile_xero_uncertain(text, jsonb) to roofops_workflow;
