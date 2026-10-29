# AC-21 offline verification (purchase orders follow their job)

Status: **Fixed offline**. Live verification is pending. Nothing hosted was touched. Everything below ran locally: PGlite
and the local Postgres 17 container.

Branch `feature/advanced-sprint-lifecycle`.

## 1. Defect and reproduction

`docs/adversarial-test-catalogue.md` AC-21, confirmed by the 2026-10-22 audit (finding E1-AC21):
- `po_apply_change` (20260929001200, never redefined) did not look at the order's job. After PRJ-2026-0009 was cancelled
  through `wf_airtable_change`, PO-2026-0009 moved Sent → Delivered with no refusal.
- The approver rule applied only to `record_origin = 'ROOFOPS'`. Imported Draft PO-2026-0012 moved to Approved for an
  Airtable user mapped to no RoofOps employee, with `approved_by` left null.

Reproduced first, through the production path, in `test/po-guards.test.ts`. Without the migration: **4 of 6 red**. These
cases failed: the cancelled job, the delivery date on a cancelled job, a closed job, the imported Draft approval. These
held before and after: the reproduction facts, and an order on a live job.

## 2. Rules

1. Once the job is Cancelled or Closed, an order on it may only be cancelled. Its Expected Delivery is locked. The
   supplier reference stays editable: it records and does not order.
2. Approving an order needs an Airtable user mapped to an active RoofOps employee, whatever the order's origin. ADR-015's
   IMPORT exemption covers the historical approvals that came with the import, not an approval made now.

**Owner decisions, not changed here:**
- Goods that physically arrive for a cancelled job are refused as Delivered; a person handles them.
- Which roles may approve an order is not defined anywhere. Any mapped, active employee may approve, as before for
  RoofOps orders.

The existing `cancelled_open_purchase_orders` WARNING still lists open orders on cancelled jobs. On hosted that is
PO-2026-0001 on PRJ-2026-0001 (`docs/phase6-status.md` §15).

## 3. Fix

Migration `20261022040000_purchase_orders_follow_the_job.sql`. `po_apply_change` is its latest definition plus only this
delta, built by script: the only source lines changed are the `declare` line and the approver condition. `CREATE OR
REPLACE` keeps its owner and ACL. Rollback: `ops/rollback/20261022040000_purchase_orders_follow_the_job.down.sql`, with
the exact prior body.

| Path | Before | After |
|---|---|---|
| Status on a Cancelled / Closed job | any allowed transition | only → Cancelled; otherwise "PRJ-… is cancelled: an order for it can only be cancelled", and Airtable is put back |
| Expected Delivery on a Cancelled / Closed job | changeable | "the delivery date is locked: PRJ-… is cancelled" |
| → Approved | needed a mapped employee only for RoofOps-origin orders | needs a mapped, active employee for every order; `approved_by` is recorded |

## 4. Verification

| Check | Result |
|---|---|
| `test/po-guards.test.ts` + `test/state-integrity.test.ts`, PGlite and Postgres 17 | 101 passed, 3 skipped (Postgres-only cases skip on PGlite) |
| Ablation: the cancelled-job check off | 2 red |
| Ablation: the IMPORT exemption back | 1 red |
| Rollback round trip (scratch database) | only `po_apply_change` changes; after the down file, functions with ACLs, views, field contract and settings are identical |
| Full gate, `TEST_DATABASE_URL=… npm run check` (lint, both typechecks, PGlite and Postgres 17) | exit 0; Test Files 60 passed, 3 skipped (63); Tests 1267 passed, 37 skipped (1304) |

**Existing test changed:** `test/state-integrity.test.ts`, the purchase-order case. It picked the first Sent order by
number, an order on PRJ-2026-0011, which an earlier case in the same file cancels. It now picks a Sent order on a job
that is neither cancelled nor closed. Its assertions are unchanged.

## 5. Hosted steps awaiting owner approval

1. Read-only, before:
   - `npx tsx scripts/sql.ts --read-only "select po.po_number, po.status, p.project_number, p.status from purchase_orders po join projects p on p.id = po.project_id where p.status in ('CANCELLED','CLOSED') and po.status not in ('DELIVERED','CANCELLED')"`
     lists the orders that can then only be cancelled.
   - `... where po.status in ('DRAFT','PENDING_APPROVAL') and po.record_origin = 'IMPORT'` lists imported orders that now
     need a mapped approver.
2. 🔒 `npm run db:load -- --hosted`. Expect exactly this migration (after the earlier ones in the release).
3. Read-only after: `npm run integrity:check` (0 FAIL) and `npm run security:check`.
4. 🔒 Optional live check through Airtable on PO-2026-0001 (cancelled PRJ-2026-0001): set Status to Delivered. Expected:
   refused, put back, RoofOps Sync explains.
5. Rollback: `npx tsx scripts/sql.ts -f ops/rollback/20261022040000_purchase_orders_follow_the_job.down.sql` (owner, one
   transaction).
