# AC-14C Part A offline verification: a Xero-verified deletion follows the void path

Facts and command output only. Nothing here was run against a hosted system; no deploy, no production credentials, no
Xero, Airtable, n8n or Supabase call. Everything below is local (PGlite and a locally installed PostgreSQL 17.11 at
`127.0.0.1:5432`; no Docker).

- Defect: AC-14C in [docs/defect-ledger.md](../docs/defect-ledger.md) (Part A of A/B/C; Parts B and C follow).
- Fix: `supabase/migrations/20261001140000_xero_deletion_follows_the_void_path.sql` (new migration; no applied
  migration was edited) and `test/xero-settlement.test.ts` (cases 21-26).
- Migration SHA-256 prefix: `ba0252d529d2cbea`.
- Branch: `factory/ac14-integrity-followup`, base `39dab5c` ("AC-14B: a Xero-verified void is not an AC-05 integrity
  failure"). Commit: `AC-14C-A: a Xero-verified deletion follows the void path`.
- Working tree note: `package.json` was already modified before this task (an unrelated `allowScripts` entry). It was
  not touched, reverted, stashed or committed.

## 1. The defect

AC-14 (`20261001120000`) follows a void made in Xero: 07's repair run reads the linked invoice, records
`VERIFIED / VOIDED` in `xero_invoice_observations`, and applies `APPROVED -> VOIDED`. A draft created in Xero and then
**deleted** in Xero was a dead end: `xero_settlement` returns `DELETED`, `xero_settlement_status('DELETED')` returned
NULL, so `xero_record_settlement` hit `continue when v_target is null` and changed nothing. The invoice stayed
`APPROVED / SYNCED` for ever, the external reader opened its usual `EXTERNAL_MISSING` exception, the project could not
close ("not every invoice is paid yet: INV-2026-0039 (deleted in Xero; a person decides)"), and the customer owed
nothing. Reproduced as case 21 red before the fix (see §3).

## 2. The rule (Part A)

A verified deletion with no money movement anywhere on the invoice is the same business state as a void, and follows
the same path.

- **Only a VERIFIED read applies** (repair runs only; an observe run records and changes nothing - the `v_repair`
  gate already in `xero_record_settlement`, `v_run.mode = 'repair'`). The verdict already carries the conditions
  AC-14B's exemption mirrors: the read was made in the tenant the write is bound to (`outbox.payload ->> 'xero_tenant_id'`,
  also the pinned tenant), and `xero.xero.InvoiceID` equals the invoice's linked `external_links` id; a wrong tenant is
  `WRONG_TENANT` and a different `InvoiceID` is `MISMATCH`, neither of which applies.
- **Apply**: `settlement = 'DELETED'`, verdict `VERIFIED`, `sync_status = 'SYNCED'`, `status in ('APPROVED','ISSUED')`
  -> `VOIDED`, with `voided_reason = 'Deleted in Xero (verified by reconciliation <p_run_key>)'`. The identifier is
  `p_run_key`, the same value the void path stamps into the same column.
- **Guard**: the observation's `amount_paid` must be present and 0, `coalesce(amount_credited, 0) = 0`, and the invoice
  must have no local `payments` row. If any of those fails nothing about the invoice changes: a `REQUIRES_HUMAN`
  finding is recorded and, in a repair run, a `RECONCILIATION_MISMATCH` exception is opened (the existing cannot-follow
  escalation). The external reader's `EXTERNAL_MISSING` exception for a missing Xero object is untouched and still
  opens. An observe run records `NONE_OBSERVE_ONLY` and opens nothing.
- **No undo**: a later `LOOKUP_FAILED` read applies nothing and does not undo an applied deletion; a later VERIFIED
  read of that linked invoice that says the invoice is neither voided nor deleted re-fails AC-05 (ordering).
- **Honesty**: `invoice_financial_state` reports an applied deletion as settled, `state = 'DELETED'`, with the deletion
  named. A deletion that did not apply (guard failed, or the invoice is not VOIDED) keeps the old
  `'deleted in Xero; a person decides'`.
- **Consistency**: `xero_settlement_status('DELETED') = 'VOIDED'`; `invoice_void_guard` and the AC-05 integrity
  exemption accept `settlement in ('VOIDED','DELETED')` under the same tenant/link conditions AC-14B used.

Functions changed (all `create or replace`): `xero_settlement_status`, `xero_record_settlement`,
`invoice_financial_state`, `invoice_void_guard`, `integrity_check`. Grant tail replicated from
`20261001130000` (`revoke execute on all functions in schema public from public;` + `grant execute on function
integrity_check() to roofops_dashboard;`).

## 3. Red before, green after

Command: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres npx vitest run test/xero-settlement.test.ts`,
first with the new migration moved aside (`/tmp/20261001140000.sql`), then restored (SHA-256 `ba0252d5…`, verified
identical).

```
# WITHOUT 20261001140000
 FAIL  ... [pglite]  > 21. AC-14C: a Xero-verified DELETED final invoice follows the void path ...
 FAIL  ... [pglite]  > 22. AC-14C: a DELETED invoice that moved money is never written off ...
 FAIL  ... [pglite]  > 25. AC-14C: a later failed read neither applies nor undoes an applied deletion (stability)
 FAIL  ... [pglite]  > 26. AC-14C: a later verified PAID re-fails integrity after DELETED -> VOIDED (ordering)
 FAIL  ... [postgres] > (the same four cases)
 Test Files  1 failed (1)
      Tests  8 failed | 46 passed (54)          Duration 74.55s

# WITH 20261001140000
 Test Files  1 passed (1)
      Tests  54 passed (54)                     Duration 74.23s
```

The four red cases are exactly the positive ones (the deletion path and its integrity exemption are absent). Cases 23
(wrong tenant) and 24 (different Xero invoice) assert "nothing changes", which is the pre-fix behaviour, so they pass
before the fix and are proved by ablation instead (§4). AC-14B cases 15-20 are green before and after, as they must be.

First failure detail (case 21, pglite): `expected 'APPROVED' to be 'VOIDED'` - the repair run recorded
`VERIFIED / DELETED` and left the invoice APPROVED. Case 22's pre-fix failure: the only exception opened was
`EXTERNAL_MISSING` (`expected [ 'EXTERNAL_MISSING' ] to include 'RECONCILIATION_MISMATCH'`), i.e. before the fix a
deletion that had moved money and a deletion that had not were treated identically - nothing happened.

## 4. Ablation proofs (applied to the new migration, run, reverted)

Each clause was neutralised in turn and its test run (`TEST_DATABASE_URL=… npx vitest run test/xero-settlement.test.ts
-t '<case>'`, both targets). After every ablation the migration was restored from `/tmp/ac14c-pristine.sql` and
`diff` + SHA-256 `ba0252d529d2cbea…` confirmed it byte-identical.

| Ablation | Change made | Test red |
|---|---|---|
| (i) whole DELETED apply/exemption removed | `xero_settlement_status` DELETED arm deleted; both `settlement in ('VOIDED','DELETED')` predicates reverted to `= 'VOIDED'` | **21** (`Tests 2 failed | 52 skipped (54)`) |
| (ii) money guard dropped | the `amount_paid is null or … <> 0 or … credited … or exists (payments …)` condition replaced by `if false then` | **22** (`2 failed | 52 skipped`) |
| (iii) tenant condition dropped | `x ->> 'tenant_id' <> v_bound` removed from the WRONG_TENANT check | **23** (`2 failed | 52 skipped`) |
| (iv) linked-InvoiceID condition dropped | `d ->> 'InvoiceID' is distinct from v_link` removed from the MISMATCH check | **24** (`2 failed | 52 skipped`) |

Ablations (iii) and (iv) target the two conditions that make a read VERIFIED (the same conditions AC-14B's exemption
mirrors); the DELETED apply path needs no second copy of them because nothing reaches the apply block without them.

## 5. Validation runs

| Check | Exact command | Result |
|---|---|---|
| Targeted regressions | `TEST_DATABASE_URL=… npx vitest run test/xero-settlement.test.ts test/invoice-void.test.ts test/state-integrity.test.ts test/project-lifecycle.test.ts test/billing-entitlement.test.ts test/xero-tenant-binding.test.ts test/xero-ambiguous-create.test.ts` | `Test Files 7 passed (7)`, `Tests 243 passed | 5 skipped (248)`, 0 failed |
| Full suite, PGlite | `npm test` | `Test Files 27 passed | 3 skipped (30)`, `Tests 319 passed | 35 skipped (354)` |
| Full suite, PGlite + PostgreSQL 17 | `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres npm test` | `Test Files 27 passed | 3 skipped (30)`, `Tests 604 passed | 35 skipped (639)` |
| Lint / types | `npm run lint`, `npm run typecheck` | exit 0, no output |
| Fresh chain from zero | `createdb … ac14c_fresh`; `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/ac14c_fresh npx tsx scripts/db-load.ts` | 35 migrations applied, 0 skipped, ending `20261001140000_xero_deletion_follows_the_void_path.sql`; import `IMPORTED`; second run: `migrations applied: none (skipped 35)`; `select count(*) from schema_migrations` = 35 |
| Integrity on the fresh DB | `DATABASE_URL=… npx tsx scripts/integrity-check.ts --local` | **26 PASS, 5 WARNING, 0 FAIL**; `voided_invoice_has_no_xero_write` PASS; detail text now reads "…unless the exact linked Xero invoice was verified VOIDED or DELETED in the tenant its write is bound to" |
| Contract docs | `npm run contract:export` | `contract: 98 fields; 10 machines, 103 legal transitions`; `git diff` on `docs/` empty (no new state transition or field, so the generated docs are unchanged) |
| Privileges (offline replica of `scripts/security-check.ts`) | `npx tsx /tmp/ac14c-check.mts` (PGlite, migrate from zero + import) | all 11 assertions pass; `dashboard can execute integrity_check()` = `["integrity_check"]`; `dashboard cannot execute xero_record_settlement(text, jsonb)` and `invoice_financial_state(uuid, boolean)`; no function executable by PUBLIC; no table without RLS |
| Grants unchanged by the blanket revoke | same script with the migration moved aside | `ROLE-SET roofops_dashboard (16)` and `ROLE-SET roofops_workflow (21)` byte-identical with and without the migration (`diff` empty) |
| Mapping | same script | `xero_settlement_status('DELETED') = VOIDED` |

The 35 skipped tests are `test/live-phase2|3|6.test.ts`, gated by `RUN_HOSTED_TESTS` (not set).

## 6. What the new tests assert (cases 21-26)

1. **21** - a verified `DELETED` read with zero paid/credited and no local payments, in the right tenant and for the
   linked InvoiceID: an observe run records it and applies nothing; a repair run moves `APPROVED -> VOIDED` with
   `voided_reason` `Deleted in Xero (verified by reconciliation …)`, exactly one
   `invoice.xero_settlement_applied` audit whose reason reads "Xero verified deleted", `invoice_financial_state` is
   `{settled: true, state: 'DELETED'}` with the deletion named, and `voided_invoice_has_no_xero_write`,
   `xero_invoice_state_verified` and `closed_project_settled` all PASS; the project is refused with "left to bill"
   (the deleted final no longer bills the customer).
2. **22** - money moved: `AmountPaid 5000`, then `AmountCredited 100`, then a local `payments` row. Each run leaves the
   invoice APPROVED, opens `RECONCILIATION_MISMATCH`, and `invoice_financial_state` stays
   `{settled: false, state: 'DELETED', reason: 'deleted in Xero; a person decides…'}`; the project is refused with the
   deletion reason; `voided_invoice_has_no_xero_write` PASSes (nothing was voided).
3. **23** - the same read in tenant B: `WRONG_TENANT`, invoice APPROVED, `PERMISSION_DENIED`, nothing voided.
4. **24** - the response carries a different `InvoiceID`: `MISMATCH`, invoice APPROVED, nothing voided.
5. **25** - after an applied deletion, an HTTP 500 run records `LOOKUP_FAILED`, leaves the invoice VOIDED, and
   `voided_invoice_has_no_xero_write` still PASSes; an inserted later `LOOKUP_FAILED` observation also leaves it PASS.
6. **26** - a later VERIFIED `PAID` observation of the same linked invoice puts the invoice back in the FAIL list
   (`FAIL voided_invoice_has_no_xero_write -> INV-2026-0039`).

Case 21 also covers the brief's item 7: the old `DELETED in Xero: a person decides; nothing changes` case was rewritten
in place, and the "a person decides" behaviour now lives only in the guard-refusal path (case 22).

## 7. Observed, deliberately untouched (Part B/C follow-up)

Measured inside case 21 (temporary probe, removed before the commit): after a deletion-voided invoice,

```
v_invoice_balances        { "paid": "0", "outstanding": "14664.49" }
v_dashboard_projects      { "invoice_status": "NOT_READY", "outstanding_inc_gst": "0", "needs_attention": true }
```

`v_invoice_balances`' lateral still excludes `settlement = 'DELETED'` (it was written by AC-14 for exactly that reason),
so the per-invoice row shows the full total as outstanding even though the invoice is VOIDED. Nothing user-facing is
wrong from it: the dashboard's money-owed and overdue sums filter to `ISSUED / PARTIALLY_PAID` (so `outstanding_inc_gst`
is 0), and the invoice is settled for closing. Changing the balances lateral is out of Part A's scope (D1-D5 do not
mention it) and is reserved for Part B/C, which rewrites the draft generations and the balances lateral together.

## 8. SKIPPED (and why)

- `npm run security:check`: it is hard-wired to the hosted database (`hostedDbConfig()` requires `SUPABASE_DB_URL`), so
  it needs hosted access and was skipped. Its assertions were replicated offline against PGlite instead (§5) and the
  role sets were proved identical with and without the migration.
- `npm run integrity:check` (hosted): skipped, no hosted access and no hosted database touched. The equivalent
  `-- --local` run was made against a throwaway PostgreSQL 17 database built from zero (§5).
- No deploy, no migration applied to Supabase, no dry run, no repair run, no Xero/Airtable/n8n call. AC-14C is
  **In progress (offline)**, not Fixed; live verification is still needed, and Parts B (replacement/reissue) and C
  (integration sweep) follow.
- The Xero invoice-number reuse, the reissue facility, the `outbox.generation` model and the state transitions for a
  replacement invoice are Part B and were not built here.

## 9. Deviations from the brief (and why)

1. **No duplicated tenant/linked-InvoiceID conditions inside the apply block.** The brief asked the apply to satisfy
   "same `tenant_id` as the linked Xero write and same linked Xero InvoiceID, mirroring exactly the conditions AC-14B
   used". Those conditions are enforced by the VERIFIED verdict (`WRONG_TENANT`, `MISMATCH`), which is the only route
   into the apply block; a second copy would be unreachable code and would make ablations (iii)/(iv) need two edits
   instead of one. Tests 23 and 24 plus ablations (iii)/(iv) prove each condition is load-bearing.
2. **The AC-05 ordering clause is written `y.settlement not in ('VOIDED','DELETED')`** instead of AC-14B's
   `y.settlement is distinct from 'VOIDED'`. Semantics: the exemption holds while no later VERIFIED observation of that
   linked invoice says the invoice is anything other than voided or deleted. A later VERIFIED `PAID` re-fails (case 26,
   and AC-14B case 20), and a deletion followed by a void read (or the reverse) stays valid because the later
   void-family observation itself satisfies the predicate.
3. **`invoice_financial_state` keeps the freshness rule for an applied deletion**, exactly as it does for a verified
   void: a deletion observation older than `xero.settlement_max_age_hours` reports `STALE` rather than settled, so
   closing waits for the next verification. This mirrors the void path; the brief did not say to exempt deletions.
4. **The money guard runs before the path is computed**, so a deletion that moved money is escalated even when the
   invoice is in a state the void path could not follow (e.g. `PAID`). The alternative (let the cannot-follow path
   report it) would lose the "money moved" reason.
5. **Case 21 also asserts the observe-run behaviour** (records the deletion, applies nothing). The brief's D1 requires
   the repair-mode distinction; the existing file proves it for `UNPAID` (case 2) and this makes it explicit for
   `DELETED`.
6. **`v_invoice_balances` was left alone** (§7). The brief's D1-D5 do not mention it and the orchestrator's own Part B
   hazard list already flags the balances lateral.
