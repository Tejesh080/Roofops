# AC-15 offline verification (a fully billed job is not cancelled, whatever its invoices are typed)

Status: **Fixed offline**. Live verification is pending. Nothing hosted was touched. Everything below ran locally: PGlite,
the local Postgres 17 container, and a restored copy of a hosted backup.

Branch `feature/advanced-ac15-cancel-guard`, stacked on the AC-13B commit `3672195`.

## 1. Defect and reproduction

`docs/adversarial-test-catalogue.md` AC-15 (P1): the Completed → Cancelled guard looked only for an invoice typed FINAL, and
every imported invoice is untyped. PRJ-2026-0008 is Completed with two untyped imported bills: INV-2026-0008 Paid
9,947.94 and INV-2026-0038 Issued 49,739.70, against a value of 49,739.70. It could be cancelled from Airtable, leaving
INV-2026-0038's receivable on a Cancelled job.

Reproduced first, through the production path (`wf_airtable_change`, as n8n 06 sends it), in `test/cancel-guard.test.ts`.
Without the migration: **4 of 8 red**:
- the over-billed job: APPLIED (the defect);
- the job billed exactly to its value;
- the guard on a direct UPDATE;
- the integrity check.

The 4 that hold before and after:
- the reproduction facts;
- a partly billed job may be cancelled;
- after voiding the excess bill the job may be cancelled;
- a typed final invoice refuses with its own message.

## 2. Rule

Owner rule (`docs/phase6-status.md` §4): Completed → Cancelled is allowed until a non-void final invoice exists, and
earlier invoices are kept.

Invariant: a job whose valid bills (Approved, Issued, Partly paid, Paid) reach what it is entitled to (AC-09
`project_billing`: accepted quote plus approved and invoiced variations) has been finally billed in substance,
whatever its invoices' type. It is not cancelled: void the final bill first. This is the reading AC-13A already uses for
closing ("fully billed is billed, whatever the paperwork").

**Not applied, owner decision:** the catalogue's wider rule, that any Issued or Partly paid invoice blocks cancellation.
It would overturn the Phase 6 rule that a partly billed job may be cancelled and keep its earlier invoices.

## 3. Fix

Migration `20261022010000_fully_billed_job_is_not_cancelled.sql`. Each function is its latest definition
(`20261022000000_pre_start_gate_before_work_starts.sql`) with only the AC-15 delta. A script extracted both bodies and
checked the result: every source line kept, in order, plus 8 added lines each; the rollback bodies are byte-identical to
the source.

| Object | Delta |
|---|---|
| `project_transition_guard` | after the typed-final and in-flight checks (unchanged), Completed → Cancelled is refused when `billed > 0` and `remaining <= 0`: "PRJ-… is fully billed (billed … against …: invoices); a fully billed job is not cancelled: void the final bill first, then cancel". It covers every path: the Airtable handler and a direct UPDATE (state-machine trigger) |
| `integrity_check` | `cancelled_job_fully_billed` (FAIL): no cancelled job is fully billed |

No n8n, Airtable, dashboard or field-contract change. `CREATE OR REPLACE` keeps both functions' owner and ACL. Rollback:
`ops/rollback/20261022010000_fully_billed_job_is_not_cancelled.down.sql`.

## 4. Verification

| Check | Result |
|---|---|
| `test/cancel-guard.test.ts` after the fix | 11 of 11 per engine (PGlite and Postgres 17: 22 passed) |
| Edge cases added after the first pass | a partly paid final bill still counts as billed (refused); a draft that is not billed yet does not count (the job is partly billed: cancellable); approved variations raise the entitlement, so work still to bill keeps the job cancellable (PRJ-2026-0008 plus an approved 10,000.00 variation: 52.06 left); no credit-note model exists (AC-08), so voiding is the only way down, also covered |
| Ablation: the guard clause off (integrity kept) | 3 red (over-billed, exact, direct UPDATE); file restored byte for byte |
| Existing suites `state-integrity`, `project-lifecycle` (cancellation, close, lifecycle) | green (63 passed, 3 skipped Postgres-only on PGlite) |
| Full suite, both engines | see §4a |

**Rehearsal on a restored copy of hosted** (`pre-synthetic-quote-test-20261020-164125.dump`, scratch database, dropped
afterwards):

| Step | Result |
|---|---|
| To today's hosted head plus AC-13B (8 migrations) | integrity 29 PASS / 6 WARNING / 0 FAIL |
| Apply AC-15 | integrity **30 PASS / 6 WARNING / 0 FAIL**; `cancelled_job_fully_billed` PASS |
| The only cancelled job | PRJ-2026-0001, billed 7,721.52 with 30,886.06 left: partly billed, so it was rightly cancellable |
| Completed jobs whose answer changes | **PRJ-2026-0006** (billed 30,888.72 against 25,740.60) and **PRJ-2026-0008** (59,687.64 against 49,739.70), both over-billed (AC-08); now refused. The new check runs after the existing ones and only adds a refusal, so no other job's answer changes |
| Rows changed | `schema_migrations` +1 only |
| Down file | functions with ACLs, views, field contract, settings identical; integrity back to 29 / 6 / 0; re-apply works |

### 4a. Full suite

`TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run check` (lint, typecheck, typecheck:web,
PGlite and Postgres 17): **exit 0**; Test Files 59 passed, 3 skipped (62); Tests **1202 passed**, 36 skipped (1238); 459 s.
The 36 skipped need the hosted database. `npm run contract:export` leaves the contract docs unchanged (no field-contract change).

## 5. Hosted steps awaiting owner approval

AC-15 changes only Postgres. Deploy it after AC-13B (`ops/ac13b-deployment-runbook.md`) or in the same window, as its
own migration:

1. 🔒 `npm run db:load -- --hosted`. Expect exactly `20261022010000_fully_billed_job_is_not_cancelled.sql`.
2. Read-only:
   - `npm run integrity:check`: 0 FAIL, `cancelled_job_fully_billed` PASS;
   - `npm run security:check`: all pass;
   - `npx tsx scripts/sql.ts --read-only "select project_number, project_transition_guard(p, 'CANCELLED') from projects p where status = 'COMPLETED' order by 1"`:
     PRJ-2026-0006 and PRJ-2026-0008 answer "fully billed", and no other job's answer changed from before step 1
     (run the same query before step 1 and keep the output).
3. 🔒 Optional live check through Airtable: set PRJ-2026-0008 Status = Cancelled. Expected: refused, Status put back to
   Completed by 06, and RoofOps Sync explains. Net change: none.
4. Rollback: `npx tsx scripts/sql.ts -f ops/rollback/20261022010000_fully_billed_job_is_not_cancelled.down.sql` (owner,
   one transaction).
