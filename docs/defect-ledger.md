# Defect ledger

We work on one defect at a time, in the order the owner sets. Source hypotheses: [adversarial-test-catalogue.md](adversarial-test-catalogue.md).
A defect is **Fixed** only after its live verification. Until then, a defect that passes every offline check is
**Fixed offline**.

Order: AC-01 → AC-02 → AC-10 → AC-03 → AC-05 → AC-06 → AC-04 → AC-08 → AC-09 → AC-13A → AC-13B (each started only on
instruction).

| ID | Severity | Hypothesis | Reproduced? | Reproduction evidence | Root cause | Violated invariant | Regression test | Fix | Integration verification | Live verification needed? | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| AC-01 | P0 | The reconciler replays an Airtable read that is older than a webhook edit, reverting the staff member's edit | **Yes**, offline (PGlite and Postgres 17) | Probe `ws07/p2_stale_snapshot.mts` plus 2 failing tests (below) | Replays had no observation time and were exempt from the webhook path's stale and compare-and-set checks | An Airtable read is evidence only if canonical has not changed since the read | `test/state-integrity.test.ts:376`, `:396`, plus race tests `:485`, `:520` (two Postgres connections) | Migration `20260930000000_reconcile_never_replays_stale_reads.sql` | Migration chain clean from zero; 314 tests pass on PGlite and Postgres 17; lint, typecheck clean; integrity 0 FAIL on canonical local and hosted; **deployed to hosted**; hosted dry-run 0 drift | Done 2026-10-01 (§12): hosted repair run, then the controlled live test on PRJ-2026-0029, with [evidence/ac01-live-verification.json](../evidence/ac01-live-verification.json) | **FIXED** |
| AC-02 | P0 | A missing or reshaped Airtable field is replayed as a staff edit | – | – | – | – | – | – | – | – | Not started |
| AC-10 | P0 | 06 applies its own stale correction back as a staff edit | – | – | – | – | – | – | – | – | Not started |
| AC-03 | P0 | Airtable Approve is not bound to the row or preview the approver saw | – | – | – | – | – | – | – | – | Not started |
| AC-05 | P0 | Voiding an invoice does not cancel its queued Xero write | – | – | – | – | – | – | – | – | Not started |
| AC-06 | P0 | Unpinning the Xero tenant is not a kill switch | – | – | – | – | – | – | – | – | Not started |
| AC-04 | P0 | A Xero draft that exists is recorded as never created | – | – | – | – | – | – | – | – | Not started |
| AC-08 | P0 | Over-billed projects are labelled "Fully invoiced" (`dashboard.test.ts:34` expects this) | – | – | – | – | – | – | – | – | Not started |
| AC-09 | P0 | Final invoice under-bills once a variation is INVOICED | – | – | – | – | – | – | – | – | Not started |
| AC-13A | P1 | Completion checklist has no editing surface, so new jobs can never be final-invoiced | – | – | – | – | – | – | – | – | Not started |
| AC-13B | P1 | Pre-start checklist (SWMS, material review) is not enforced on Scheduled → In Progress | – | – | – | – | – | – | – | – | Not started |
| ENV-01 | P2 | The local dev DB had an unversioned migration, `20260929001700_drift_performance.sql`, that is not in git | Yes | `schema_migrations` row (applied 2026-09-29 12:52 AEST) and schema diff (§10) | Applied locally, never committed | Every applied migration exists in `supabase/migrations` | – | Local DB reset to repo migrations (`npm run db:reset`); its 6 object definitions saved as evidence | Repo = local = 18; hosted = 17 + AC-01 = 18; hosted never had it | No | **Resolved** (whether to re-propose the performance change is the owner's call) |

---

## AC-01 evidence package

### 1. Reproduction (offline, before the fix)

Probe `scratchpad/adv/probes/ws07/p2_stale_snapshot.mts` runs on PGlite with the real migrations and import bundle. It
follows n8n 07's real call order:

1. **Start Reconciliation Run.**
2. **Read Airtable Table**: the Projects read is in sync.
3. Staff edit PRJ-2026-0012 while 07 is still reading, and n8n 06 applies it: Planned Completion 2026-10-01 → 2026-12-18,
   then Status In Progress → On Hold. Both are `APPLIED`.
4. **Reconcile Table In Postgres** is called with the read from step 2.

```
canonical after staff      [ { status: 'ON_HOLD', c: '2026-12-18' } ]
reconcile                  { drift: 2, corrections: '[]' }
canonical after reconcile  [ { status: 'IN_PROGRESS', c: '2026-10-01' } ]        ← staff edit silently reverted
findings                   Status  SAFE_AUTO_REPAIR/APPLIED_TO_POSTGRES "On Hold → In Progress applied"
                           Planned Completion SAFE_AUTO_REPAIR/APPLIED_TO_POSTGRES "2026-12-18 → 2026-10-01 applied"
drift now (v_state_drift)  []                                                    ← divergence hidden
staff edit 3 (12-18→12-22) REJECTED "someone else changed it at the same time"   ← staff blocked
```

Airtable still showed On Hold / 2026-12-18, because no correction was written. So after one run, Airtable and Postgres
disagreed, and every drift signal said they agreed.

### 2. Classification: a true bug

- **Not a test artifact.** The probe uses 07's exact order. `n8n/07-reconcile.sdk.ts:231-232` runs `start` →
  `tables` → `listRecords` → `group` → `reconcileTable`, so an edit applied by 06 between the read and the reconcile
  call is exactly the probe's state.
- **Not intended behaviour.** ADR-038 promises that "a lost webhook costs latency, not data". Reverting a delivered
  edit loses data.
- **When it happens.** Any staff edit that 06 applies during the seconds between 07 reading a table and reconciling it.
  The nightly run is unlikely to hit it; an on-demand `npm run reconcile` during office hours is exposed.

### 3. The first incorrect state transition

`projects.status` ON_HOLD → IN_PROGRESS, together with `planned_completion_date` 2026-12-18 → 2026-10-01. It is written
by `project_apply_change`, called from `wf_airtable_change` with `source='reconciler'` and actor `reconciliation`,
from the replay event built at `supabase/migrations/20260929001500_reconcile_missing_projection.sql:68-71`.

### 4. Why the architecture permitted it

- The webhook path protects freshness twice: the per-field STALE check and compare-and-set against `previous`. Both
  are enabled only for `v_src = 'airtable'` (`20260929001300_airtable_change_writeback.sql:91` and `:97`).
- A reconciler replay has no `previous`, and it is stamped `occurred_at = now()` (`…001500…sql:69`). That is the time of
  the reconcile call, not the time of the read.
- `wf_reconcile_airtable` treated every difference between its read and canonical as a missed staff edit. It never
  asked whether canonical had changed since the read.
- It then recorded the old read as what Airtable shows (`…001500…sql:40`), so `v_state_drift` compared the reverted
  canonical with the old read and found them equal.
- The `now()` stamp also set `external_field_versions.last_source_at` to the reconcile time. A staff edit made after
  the read, whose webhook arrived after the replay, was then judged older and dropped as `STALE` (test 2).

### 5. Invariant

> An Airtable read is evidence about a record only if the record's canonical row has not changed since the read. A
> replay is dated no later than its read. Reconciliation never applies, and never records as observed, a value older
> than the canonical state.

### 6. Regression tests (written first, watched fail)

`test/state-integrity.test.ts`, reconciliation block. Both run on PGlite and real Postgres 17.

- `:374`: *an Airtable read taken before a webhook edit never reverts that edit (re-checked next run instead)*. Uses
  PRJ-2026-0028. It asserts:
  - canonical stays ON_HOLD / 2026-12-18;
  - there is no correction for the record;
  - the findings are `STALE_EVENT/NONE`;
  - `v_state_drift` shows no false drift;
  - the staff member's next edit is `APPLIED`.
- `:394`: *a replayed missed edit is dated by the Airtable read, so a later staff edit is not treated as stale*. Uses
  PRJ-2026-0027. A genuine missed edit is replayed; a later staff edit (run start + 30 s) must be `APPLIED`, not
  `STALE`.

Red before the fix, 03:49:

```
× AC-01: an Airtable read taken before a webhook edit never reverts that edit …
  AssertionError: expected 'IN_PROGRESS 2026-10-01' to be 'ON_HOLD 2026-12-18'
× AC-01: a replayed missed edit is dated by the Airtable read …
  AssertionError: expected 'STALE' to be 'APPLIED'
Tests  2 failed | 26 skipped (28)
```

Red-green re-verified afterwards by temporarily removing the migration:

```
--- FIX REMOVED ---   Tests  2 failed | 26 skipped (28)   (same two assertions)
--- FIX RESTORED ---  Tests  2 passed | 26 skipped (28)
```

### 7. Fix (design, not the example)

New migration `supabase/migrations/20260930000000_reconcile_never_replays_stale_reads.sql`, in Postgres only, with no
n8n change:

1. **A read is valid only for unchanged rows.** For each record, `wf_reconcile_airtable` first locks the canonical row
   (`FOR UPDATE`) and checks `updated_at > run.started_at`. `updated_at` is maintained by the `touch_row` trigger on
   projects, quotes, purchase_orders, customers, properties and suppliers. 07 always starts the run before it reads
   Airtable, so `started_at` is a safe lower bound for the read time. The check therefore works whatever the Airtable
   or n8n clocks say. If the row changed, nothing for that record is replayed or repaired, and the old read is **not**
   recorded as an observation. Each drifting field gets a `STALE_EVENT / NONE` finding ("re-checked next run"), and the
   next run compares a fresh read. The result is a missed edit arriving one run later, never a revert.
2. **Replays are dated by the read, not the call.** A replay event uses `occurred_at = run.started_at`, so it can never
   make a later staff edit look older.
3. **No false drift in the summary.** `v_consistency.drift_found` excludes `STALE_EVENT` findings.
4. `wf_reconcile_airtable` returns `rechecked_next_run`. The existing keys (`records`, `fields_checked`, `drift`,
   `corrections`) are unchanged.

The row lock makes the check and the replay atomic with respect to a concurrent 06 edit. It is defence in depth, and no
dedicated two-connection race test covers it yet. The existing two-connection tests pass on Postgres 17 with the lock
in place: no deadlock, and serialisation is unchanged.

### 8. Verification (all run after the final change)

| Check | Command | Result |
|---|---|---|
| Original, un-minimised probe | `npx tsx …/ws07/p2_stale_snapshot.mts` | Canonical stays `ON_HOLD 2026-12-18`; findings `STALE_EVENT/NONE`; `v_state_drift []`; staff edit 3 `APPLIED` → `2026-12-22` |
| State and reconciliation, both engines | `TEST_DATABASE_URL=…54322/postgres npx vitest run test/state-integrity.test.ts` | **55 passed**, 1 skipped (the two-connection block under PGlite) |
| Full suite, both engines | `TEST_DATABASE_URL=… npx vitest run` | **312 passed, 31 skipped**. Baseline was 308/31; +4 = 2 new tests × 2 engines; the 31 skips are the unchanged live suites |
| Lint / types | `npm run lint`, `npm run typecheck` | Clean |
| Integrity, local Postgres 17 with the migration (`npm run db:load` applied only 1700) | `npm run integrity:check -- --local` | **23 PASS, 3 WARNING, 0 FAIL**. The warnings are existing data states: Q-2026-0031 acceptance, no completed run, EXC-0003 |
| Integrity, hosted (read-only; `integrity_check()` is `STABLE` and never writes; migration **not** deployed) | `npm run integrity:check` | **23 PASS, 3 WARNING, 0 FAIL**, unchanged |
| n8n 07 contract | `n8n/07-reconcile.sdk.ts:81-82` reads `records`, `fields_checked`, `drift`, `corrections` | Unchanged; the new key is ignored |
| Grants survive `create or replace` (local) | `has_function_privilege` / `has_table_privilege` | `roofops_workflow` can execute `wf_reconcile_airtable`; `roofops_dashboard` can select `v_consistency` |

### 9. Still needed before "Fixed"

- **Live:** apply migration 1700 to hosted Supabase (owner approval). Then run `npm run reconcile -- --dry-run`, then
  a repair run, then `npm run integrity:check`. Confirm there are no unexpected `STALE_EVENT` findings and that
  `v_consistency` is unchanged.
- **Optional hardening test:** a two-connection Postgres test proving the `FOR UPDATE` lock serialises a concurrent 06
  edit. Only a real live race (a sandbox copy of the base, never production) would exercise n8n timing end to end.

### ENV-01 (logged, not part of AC-01)

A schema diff of the local dev DB against a fresh throwaway database built from the repo's migrations, both on
Postgres 17, found:

- **6 objects differ:** `at_norm`, `at_matches`, `at_repair_value`, `at_title`, `v_state_drift`,
  `v_dashboard_projects`.
- **Cause:** the migration `20260929001700_drift_performance.sql` is recorded in `schema_migrations`, but no such file
  exists in the working tree or in git history.
- **No collision with AC-01:** its objects don't overlap migration 1700's (`wf_reconcile_airtable`, `v_consistency`).
- **Risk:** local results can differ from the repo's tests.
- **Open question:** whether hosted has it too.

---

## AC-01 round 2 (owner's gating list, 2026-09-30)

### 10. A single migration history

The AC-01 migration was renamed from `20260929001700_…` to **`20260930000000_reconcile_never_replays_stale_reads.sql`**,
later than every version in the repo, local and hosted. The histories were read with `schema_migrations`; the hosted
session was set to `transaction read only`. Supabase CLI's `supabase_migrations` table is absent on hosted.

| Versions | Repo | Local, before | Hosted, before | Now |
|---|---|---|---|---|
| `20260929000000` … `20260929001600` (17 files) | yes | yes, same checksums | yes, same checksums | all three |
| `20260929001700_drift_performance.sql` | **no** (not in git history either) | **yes** | no | nowhere (local reset) |
| `20260929001700_reconcile_never_replays_stale_reads.sql` (old AC-01 name) | – | yes | no | nowhere |
| `20260930000000_reconcile_never_replays_stale_reads.sql` | yes | – | – | repo, local and hosted |

The orphan changed 6 local objects: `at_norm`, `at_matches`, `at_repair_value`, `at_title`, `v_state_drift` and
`v_dashboard_projects`. Their local definitions are saved in `scratchpad/adv/env01-drift_performance-local-objects.sql`.
The local dev DB was then rebuilt from the repo with `npm run db:reset`.

**Chain from zero**, on a throwaway Postgres 17 database:

- 18 migrations applied, 0 skipped; the import succeeded; a second `migrate` applied 0 and skipped 18.
- Diffing 248 schema objects (functions, views, indexes, triggers) against hosted found only `wf_reconcile_airtable`
  and `v_consistency` different, which is exactly this migration. So hosted has no manual schema drift.

### Design correction found by the race test

The first version of the fix passed every PGlite test but **failed the two-connection test**. A PL/pgSQL loop reads
its rows before it waits on a lock. When the staff edit committed while the reconciler was waiting, the record was
correctly skipped, but it was compared against canonical as it was *before* the wait, so the skip was silent (no
`STALE_EVENT` finding). The fix now re-reads the record's canonical state (`v_airtable_expected`) after taking the row
lock, which is the same rule `wf_airtable_change` follows.

### Dedicated two-connection race tests (Postgres 17 only)

Each test first confirms, from a third connection, that the waiting connection really is blocked on a lock
(`pg_stat_activity.wait_event_type = 'Lock'`). Staff timestamps are taken from the Postgres clock, so container clock
skew can't cause flakiness.

- **`:485`, staff edit wins the race.** The staff edit is on PRJ-2026-0023:
  1. A starts a repair run and reads Airtable (finish 2026-10-08).
  2. B applies a staff edit to 2026-10-10 through `wf_airtable_change`, uncommitted.
  3. A calls `wf_reconcile_airtable` with the old read and **waits on the row lock**.
  4. B commits, and A resolves (no deadlock).

  Result:
  - canonical is **2026-10-10**;
  - there is no correction, and one `STALE_EVENT/NONE` finding;
  - `rechecked_next_run: 1`;
  - `v_state_drift` is empty.

  **The next run** compares a fresh read normally. It shows a later missed edit (2026-10-12), which is replayed
  (`SAFE_AUTO_REPAIR/APPLIED_TO_POSTGRES`); `rechecked_next_run: 0`.
- **`:520`, inverse: reconciliation holds the row first.**
  1. A (open transaction) replays a missed edit on PRJ-2026-0021 (2026-10-30) and holds the lock.
  2. B's staff edit, 2026-10-30 → 2026-11-02, is proven to **wait**.
  3. A commits, then B is `APPLIED`.

  Final value 2026-11-02; no drift. **This order is guaranteed:** the replay commits first, the staff edit is then
  checked against it, and the newest value wins with no false conflict.
- **The race test needs the lock.** With `FOR UPDATE` temporarily removed from the guard, `:485` fails
  (`rechecked_next_run` 0). The file was restored byte-for-byte (sha256 `d56c68394b1793df…`). The inverse test is
  unaffected, because the replay itself locks the row; it pins down the ordering rather than the guard.

### Fresh verification (all after the final change)

| Check | Result |
|---|---|
| Red/green, renamed migration, both engines | Removed: **6 failed**. Restored: **6 passed** |
| Full suite, PGlite | **174 passed**, 33 skipped |
| Full suite, PGlite + Postgres 17 | **314 passed**, 33 skipped (+2 race tests, which PGlite skips) |
| Lint / typecheck | Clean |
| `integrity:check -- --local` (canonical local) | **0 FAIL** (22 PASS, 4 WARNING). The new `every_project_linked` warning is expected: a reset local DB has no Airtable record links, which only a live base load creates |

### Hosted deployment

- **Applied migration 1700 alone** (`pending == [20260930000000_…]` was asserted first) at 2026-09-29 18:43:51 UTC.
- **Grants unchanged:** `roofops_workflow` can execute `wf_reconcile_airtable`; `roofops_dashboard` can select
  `v_consistency`; `anon`/`authenticated` have neither.
- **`npm run reconcile -- --dry-run`** gave `RECON-20260930-044411-fced`, observe, COMPLETED:
  - Airtable: 231 checked, **0 drift**, 0 need a person, `drift_now` 0.
  - Drive 3/3 and Xero 1/1, both without drift.
  - Webhooks: all 3 OK, **0 unread**, so no consumer was woken.
  - "No drift found."
- **`npm run integrity:check`** (hosted, after deployment): **23 PASS, 3 WARNING, 0 FAIL**, including
  `hash_chain_intact`. The warnings are the same existing ones: PRJ-2026-0001 open POs, Q-2026-0031, open exceptions.

### 11. Not done: blocked

The next step was one **repair** reconciliation on hosted (`npm run reconcile`), and Claude Code's auto-mode
permission classifier denied it. Nothing was retried or worked around. Still outstanding:

- **Step 5:** the repair run, then `npm run reconcile -- --dry-run` and `npm run integrity:check`.
- **Step 6: the controlled live test.** The proposed plan uses PRJ-2026-0029 (Planning, not in any demo scenario, no
  invoices) and makes a live Airtable edit, so it needs explicit approval:
  1. On hosted, hold `FOR UPDATE` locks on the *other* project rows.
  2. Trigger the real 07 repair run. 07 reads Airtable, and its Projects reconciliation blocks at the new guard.
  3. Change PRJ-2026-0029's Planned Completion in Airtable (2026-11-05 → 2026-11-07), and wait for n8n 06 to apply it.
  4. Release the locks. 07 continues with its older read.
  5. Verify each of these independently:
     - Airtable and Postgres both keep 2026-11-07;
     - the dashboard (`/projects/PRJ-2026-0029`) shows it;
     - the Copilot reports it;
     - the finding is `STALE_EVENT/NONE`;
     - the next run has no finding for this record;
     - `hash_chain_intact` passes.
  6. Restore 2026-11-05 through Airtable, then run the final dry-run and `integrity:check`.

  If 07 happens to reach PRJ-2026-0029 before the locked rows, the run reproduces the inverse timing instead; that is
  still a valid outcome, and it will be reported as such.
- **Commit:** not made. AC-01 is committed only when everything above is green.

(Superseded by §12: the owner approved the steps above, and they were carried out on 2026-10-01.)

### 12. Live verification (2026-10-01): AC-01 FIXED

Performed on hosted Supabase, n8n Cloud and the production Airtable base (synthetic data), as planned in §11, before
any AC-02 change reached hosted. Raw evidence (run rows, the finding, events, audit rows, lock-holder log, value
fingerprints) is in [evidence/ac01-live-verification.json](../evidence/ac01-live-verification.json).

**Step 5: reconciliation checks.** Times are UTC on 2026-09-30, i.e. 1 Oct Brisbane.

| Run | Mode | Result |
|---|---|---|
| `RECON-20261001-051040-4f57` | observe | 231/231, Drive 3/3, Xero 1/1, 0 drift, 0 findings. Run first, because hosted did not yet have the AC-02 guards and a repair run is only safe with no drift. |
| `RECON-20261001-051257-4e82` | **repair** | 0 drift, 0 findings, nothing written. The fingerprint of 173 canonical date and reference values (projects, POs, quotes, customers) is identical before and after: `89d72adf…` |

**Step 6: controlled live test on PRJ-2026-0029** (`recVc7DCnAIOVG3Gm`, Planning, no invoices, in no demo scenario):

1. **19:15:17** A separate hosted session locks the 32 other project rows (`FOR UPDATE`; it later rolls back and writes
   nothing).
2. **19:15:29** The real 07 repair run `RECON-20261001-051529-3d92` starts and reads Airtable: PRJ-2026-0029 shows
   2026-11-05. By 19:15:36, `pg_stat_activity` shows its `wf_reconcile_airtable` waiting on a lock in the Projects
   table.
3. **19:15:46** A staff edit in Airtable (Planned Completion 2026-11-05 → 2026-11-07) is applied by n8n 06:
   - event `airtable:…txn…` `SUCCEEDED/APPLIED`;
   - audit `usr7uCnNO15fCefbH` 11-05 → 11-07.
4. **19:15:59** The locks are released, and 07 continues with its older read.

**Result:** the pre-fix behaviour would have replayed 2026-11-05 over the staff edit. Instead:

| Check | Result |
|---|---|
| 07's finding for the record | `STALE_EVENT / NONE`, expected (canonical, re-read under the lock) **2026-11-07**, actual (07's read) 2026-11-05, "re-checked next run". Its `created_at` 19:15:31 is the transaction start (`now()`), taken before the lock wait |
| Reconciler replays of PRJ-2026-0029 | **0**. Only the staff edit and, later, the restore exist as events and audit rows |
| Postgres | 2026-11-07 |
| Airtable, read back independently | 2026-11-07, and no RoofOps Sync note (nothing was written back) |
| Dashboard `/projects/PRJ-2026-0029` | "7 Nov 2026", with no out-of-sync notice |
| Copilot, "What is the planned completion date of PRJ-2026-0029?" | "planned completion date is **7 November 2026**" (tool `get_project`) |
| Run summary | 231 checked, 0 drift (the stale re-check is not counted as drift), `drift_now` 0, all 3 webhooks OK, 0 unread |
| Next run `RECON-20261001-052016-4ce4` (observe) | **0 findings**, 0 drift |
| `npm run integrity:check` | 23 PASS, 3 WARNING, 0 FAIL, including `hash_chain_intact`. The warnings are the known PRJ-2026-0001 open PO, Q-2026-0031, and open exceptions |

**Step 6.6: restore.**
- **19:20:42** Planned Completion was set back to 2026-11-05 in Airtable and applied by 06 (`APPLIED`).
- The final dry-run `RECON-20261001-052233-a246` found 0 drift and 0 findings; integrity was 23 / 3 / 0.
- The value fingerprint is again `89d72adf…`, so hosted is exactly as it was before the exercise.

Timing note: 07 reached PRJ-2026-0029 after the edit, the case the fix exists for. The inverse order (07 first, then
the staff edit) is covered by the two-connection test `:520`.

**AC-01 is FIXED.**

