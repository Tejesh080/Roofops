# AC-15B and AC-13C offline verification (lifecycle guard follow-ups)

Status: **Fixed offline**. Live verification is pending. Nothing hosted was touched. Everything below ran locally: PGlite,
the local Postgres 17 container, and a restored copy of a hosted backup.

Branch `feature/advanced-sprint-lifecycle`, stacked on the AC-15 commit `75b76eb`. Audit items: FIN-01 and CC-01 (AC-15B),
D1-ONHOLD (AC-13C), CC-10 (folded into AC-13C: the same pre-start gate).

## 1. Defects and reproduction

**AC-15B (P1, audit FIN-01 / CC-01).** AC-15 refused a fully billed job only on Completed → Cancelled
(`20261022010000:45-61`), while its own integrity check `cancelled_job_fully_billed` (`:152-158`) FAILs for every
cancelled job that is fully billed. The state machine allows Planning, Materials Pending, Scheduled, In Progress and
On Hold → Cancelled with no billing check. Four imported jobs are billed exactly to their value by one untyped bill:
PRJ-2026-0012 (In Progress, 27,448.76), PRJ-2026-0015 (Scheduled, 23,604.52), PRJ-2026-0022 and PRJ-2026-0030
(Materials Pending, 43,712.84 and 28,517.53). Each could be cancelled from Airtable, and integrity then failed. The guard
allowed a state the integrity check fails (the AC-14B lesson).

**AC-13C (P3, audit D1-ONHOLD).** The AC-13B pre-start gate checked only Scheduled → In Progress. A job given an Actual
Start by a direct write, then put On Hold, could be resumed into In Progress with the SWMS unsigned
(`started_with_pre_start_open` then FAILs). This contradicted the migration's own comment ("a direct update of Actual
Start cannot skip the gate"). No supported path writes Actual Start, so this is defence in depth.

**CC-10 (P3).** `checklist_apply_change` named a missing item with `initcap(...)`, so an imported project (no pre-start
items) answered "PRJ-2026-0011 has no **Swms** Signed item" in RoofOps Sync. The Airtable name is "SWMS Signed".

Reproduced first, through the production path (`wf_airtable_change`, as n8n 06 sends it), in `test/cancel-guard.test.ts`
and `test/pre-start-gate.test.ts`. Without the migration: **18 failed, 94 passed** (112; both engines, 9 per engine):

- AC-15B: Cancelled is APPLIED for PRJ-2026-0012, PRJ-2026-0015, PRJ-2026-0022 and PRJ-2026-0030 (4); for an On Hold job
  that is fully billed; for a Planning job billed to its value by an untyped bill; and the guard returns null for a
  direct UPDATE (7 per engine);
- AC-13C: Actual Start written directly, On Hold, then In Progress with the SWMS open: APPLIED (1 per engine);
- CC-10: "has no Swms Signed item" (1 per engine).

The new tests that hold before and after: a partly billed job may still be cancelled from Scheduled (PRJ-2026-0011),
Planning (PRJ-2026-0013), In Progress (PRJ-2026-0016), Materials Pending (PRJ-2026-0014) and On Hold (PRJ-2026-0016, put
On Hold first); a job that really started, then On Hold, resumes. The Materials Pending and On Hold cases were added after
the independent review (it found partly billed jobs tested only from Scheduled, Planning and In Progress).

## 2. Rules

- **AC-15B.** A job whose valid bills reach its AC-09 entitlement (`project_billing`: billed > 0 and remaining <= 0) is
  never cancelled, whatever its state or its invoices' types. The refusal and its message are AC-15's ("PRJ-… is fully
  billed (billed … against …: invoices); a fully billed job is not cancelled: void the final bill first, then cancel").
  A partly billed job stays cancellable from any state. The typed-final and in-flight checks of Completed → Cancelled are
  unchanged and still come first. This is option (a) of CC-01, the one that matches the AC-15 header and the integrity
  check; option (b), narrowing the check so prepaid jobs stay cancellable, is not applied. For the four jobs in §1 the
  message's advice cannot be followed: their only bills are Paid, and a Paid bill has no void path (§5, step 5).
- **AC-13C.** The pre-start gate applies to Scheduled → In Progress and On Hold → In Progress. A job that really started
  passed the gate when it started, and its pre-start items are locked from then on (`checklist_apply_change`), so it
  resumes. Imported jobs have no pre-start items, so the gate is vacuous for them (AC-13B owner decision).
- **CC-10.** A checklist refusal names the item as Airtable does (`v_field`).

## 3. Fix

Migration `20261022020000_lifecycle_guard_follow_ups.sql`. Each function is its latest definition with only this delta.
A script (scratch, not in the repo) extracted both bodies, applied the deltas with function replacements that must match
exactly once, and checked the result: every source line kept, in order, apart from the replaced lines listed below. The
rollback bodies are byte-identical to the source; no `$` was lost.

| Object | Latest source | Delta |
|---|---|---|
| `project_transition_guard` | `20261022010000_fully_billed_job_is_not_cancelled.sql` | AC-15B: the Completed-only block closes after its typed-final and in-flight checks; the AC-15 lines, unchanged and in order, move into `if p_to = 'CANCELLED'` (4 inserted lines: `end if;`, 2 comment lines, the new `if`). AC-13C: `p.status = 'SCHEDULED'` → `p.status in ('SCHEDULED', 'ON_HOLD')` on the pre-start gate, and its 2 comment lines corrected (3 replaced lines). 74 → 78 lines, 71 kept in order |
| `checklist_apply_change` | `20261022000000_pre_start_gate_before_work_starts.sql` | CC-10: the "has no … item" `format()` uses `v_field` instead of `initcap(replace(lower(p_item), '_', ' '))` (1 replaced line; `v_field` still falls back to that `initcap` for other items). 63 lines, 62 kept |

Both paths are covered: the Airtable handler (`project_apply_change` calls the guard) and a direct UPDATE (the
state-machine trigger calls it). No view, field contract, setting, n8n, Airtable or dashboard change, so
`npm run contract:export` is not needed. `CREATE OR REPLACE` keeps both functions' owner and ACL. Rollback:
`ops/rollback/20261022020000_lifecycle_guard_follow_ups.down.sql`.

Tests changed: none. Tests added: 12 in `test/cancel-guard.test.ts`, 3 in `test/pre-start-gate.test.ts` (per engine).
Migration sha256 `f9fcff6b752431dd9ffa7f95abb08bf4602e0ae21379c2369ba3854ecb0c0e6d` (unchanged by the review fixes,
which touched only tests and documentation).

## 4. Verification

| Check | Result |
|---|---|
| Red, without the migration (both engines) | 18 failed, 94 passed (112) |
| Green, `test/cancel-guard.test.ts` + `test/pre-start-gate.test.ts` (PGlite and Postgres 17) | **112 passed (112)**: cancel-guard 23 per engine, pre-start-gate 31 per engine plus 4 two-connection race tests |
| Ablation AC-15B (`if p_to = 'CANCELLED'` back to `if p.status = 'COMPLETED' and p_to = 'CANCELLED'`, in place) | 14 failed, 98 passed (the 7 AC-15B refusals, both engines); restored, `cmp` identical |
| Ablation AC-13C (`p.status = 'SCHEDULED'` again) | 2 failed, 110 passed (the resume test, both engines); restored, `cmp` identical |
| Ablation CC-10 (`initcap` again) | 2 failed, 110 passed (the label test, both engines); restored, `cmp` identical |
| Rollback round trip (fresh PGlite: every migration before M1, then M1, then the down file) | M1 changes exactly `checklist_apply_change` and `project_transition_guard`; no view, field contract or setting; after the down file functions with ACLs, views, field contract and settings identical; migrations 58 → 58. Owner, ACL (`{postgres=X/postgres}`), SECURITY DEFINER, search_path and volatility of both functions identical before and after M1; no GRANT, REVOKE or RLS statement |
| Full gate | see §4a |
| Rehearsal on a restored hosted copy | see §4b |

### 4a. Full gate

`TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run check` (lint, typecheck, typecheck:web,
PGlite and Postgres 17): **exit 0**; Test Files 59 passed, 3 skipped (62); Tests **1238 passed**, 36 skipped (1274); 467 s
(re-run after the review fixes; before them, 1234 passed, 36 skipped (1270)).
The 36 skipped need the hosted database. No existing test was changed: the existing cancellation suites
(`state-integrity`, `project-lifecycle`) cancel only partly billed jobs (PRJ-2026-0001, 0002, 0004, 0005, 0011, 0013, 0019,
0020), and no existing test resumes an On Hold job with open pre-start items.

### 4b. Rehearsal on a restored copy of hosted

`pre-synthetic-quote-test-20261020-164125.dump` (sha256 checked), restored into a scratch database in the local container,
dropped afterwards:

| Step | Result |
|---|---|
| To the state before M1 (hosted head plus 9 migrations, AC-13B and AC-15 included) | integrity 30 PASS / 6 WARNING / 0 FAIL |
| Non-completed fully billed jobs on the copy | PRJ-2026-0012 (In Progress), PRJ-2026-0015 (Scheduled), PRJ-2026-0022 and PRJ-2026-0030 (Materials Pending), each billed exactly to its value: the same four as the bundle |
| On Hold jobs with an Actual Start and an open pre-start item | none; the only jobs with pre-start items are PRJ-2026-0031..0033 (Planning, both items OPEN) |
| Apply M1 | integrity **30 PASS / 6 WARNING / 0 FAIL** |
| Guard answers that change (Cancelled and In Progress, all 33 projects) | only those four jobs, for Cancelled: null → "PRJ-… is fully billed (billed … against …: INV-…); a fully billed job is not cancelled: void the final bill first, then cancel". No In Progress answer changes |
| Rows changed | `schema_migrations` +1 only |
| Down file | functions with ACLs, views, field contract, settings identical; integrity back to 30 / 6 / 0; every guard answer back to before; re-apply works |

## 5. Hosted steps awaiting owner approval

M1 changes only Postgres. Deploy it after AC-13B and AC-15 (`ops/ac13b-deployment-runbook.md`, then
`evidence/ac15-offline-verification.md` §5) or in the same window, as its own migration. The owner decision in step 5
comes first: nothing is deployed until it is made.

1. Read-only, before step 2, and keep the output:
   `npx tsx scripts/sql.ts --read-only "select project_number, status, project_transition_guard(p, 'CANCELLED') c, project_transition_guard(p, 'IN_PROGRESS') i from projects p order by 1"`,
   and the bills of the jobs that will answer "fully billed":
   `npx tsx scripts/sql.ts --read-only "select p.project_number, p.status, i.invoice_number, i.status, state_transition_allowed('invoice', i.status, 'VOIDED') can_void from projects p join invoices i on i.project_id = p.id where p.status not in ('COMPLETED', 'CLOSED', 'CANCELLED') and (project_billing(p.id) ->> 'remaining')::numeric <= 0 and (project_billing(p.id) ->> 'billed')::numeric > 0 order by 1, 3"`.
2. 🔒 `npm run db:load -- --hosted`. Expect exactly `20261022020000_lifecycle_guard_follow_ups.sql`.
3. Read-only:
   - `npm run integrity:check`: 0 FAIL, `cancelled_job_fully_billed` and `started_with_pre_start_open` PASS;
   - `npm run security:check`: all pass;
   - the step 1 query again: only the non-completed fully billed jobs (§4b) now answer "fully billed" for Cancelled;
     no other answer changed.
4. 🔒 Optional live check through Airtable: set PRJ-2026-0012 Status = Cancelled. Expected: refused, Status put back to
   In Progress by 06, and RoofOps Sync explains. Net change: none.
5. **Owner decision, before step 2 (blocking).** After M1, a job fully billed before completion cannot be cancelled by
   any supported path. In the bundle each of the four jobs (§1) is billed by a single imported bill that is **Paid**
   (INV-2026-0012, INV-2026-0015, INV-2026-0022, INV-2026-0030), and a Paid bill cannot be voided:
   - the invoice state machine has no Paid → Voided or Partly paid → Voided transition
     (`20260929001200_state_integrity.sql:100-101`); `state_transition_allowed('invoice', 'PAID', 'VOIDED')` is false, and
     a direct void of each of the four bills is refused ("illegal invoice transition PAID -> VOIDED");
   - Paid → Issued / Partly paid exists only for a payment reversal that reconciliation verifies in Xero
     (AC-14, `20261001120000_xero_verified_invoice_settlement.sql:52-59`), and there is no credit-note model (AC-08).

   So the refusal's advice, "void the final bill first, then cancel" (AC-15's message, kept as the brief requires), cannot
   be followed for these jobs. AC-15's own cases differ: PRJ-2026-0006 and PRJ-2026-0008 each also have an Issued bill
   (INV-2026-0036, INV-2026-0038), which the state machine lets be voided. The owner chooses:
   - **(a)** deploy M1: a prepaid job is never cancelled; a prepaid termination stays in its state, and its refund or
     credit is handled outside RoofOps (no supported path exists today);
   - **(b)** prepaid terminations must stay cancellable: narrow `cancelled_job_fully_billed` instead (CC-01 option (b)).
     The AC-15B part of M1 is then not deployed, and M1 is split first: AC-13C and CC-10 do not depend on this decision.

   Step 1's second query shows, on hosted, which jobs this concerns and whether any of their bills can be voided.

## 6. Rollback

`npx tsx scripts/sql.ts -f ops/rollback/20261022020000_lifecycle_guard_follow_ups.down.sql` (owner, one transaction).
It restores `project_transition_guard` as `20261022010000` defined it and `checklist_apply_change` as `20261022000000`
defined it, and removes the migration's record. No data changes.

A note on AC-13C: the state it refuses (an Actual Start written directly, pre-start items open) has no supported way
out. The items are locked once Actual Start is set, so the job can neither be signed off nor started, and the refusal's
"set them in Airtable (SWMS Signed / Materials Reviewed) before the job starts" cannot be followed there (the same is true
of the Scheduled path since AC-13B; the review noted it as LOW). Only a direct correction that clears the bad Actual
Start repairs it. That is deliberate and left unchanged: the state is reachable only by bypassing RoofOps (no supported
path writes Actual Start), and the integrity check `started_with_pre_start_open` reports it.
