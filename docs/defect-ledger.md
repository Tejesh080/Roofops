# Defect ledger

We work on one defect at a time, in the order the owner sets. Source hypotheses: [adversarial-test-catalogue.md](adversarial-test-catalogue.md).
A defect is **Fixed** only after its live verification. Until then, a defect that passes every offline check is
**Fixed offline**.

Order: AC-01 → AC-02 → AC-10 → AC-03 → AC-05 → AC-06 → AC-04 → AC-08 → AC-09 → AC-13A → AC-13B (each started only on
instruction).

| ID | Severity | Hypothesis | Reproduced? | Reproduction evidence | Root cause | Violated invariant | Regression test | Fix | Integration verification | Live verification needed? | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| AC-01 | P0 | The reconciler replays an Airtable read that is older than a webhook edit, reverting the staff member's edit | **Yes**, offline (PGlite and Postgres 17) | Probe `ws07/p2_stale_snapshot.mts` plus 2 failing tests (below) | Replays had no observation time and were exempt from the webhook path's stale and compare-and-set checks | An Airtable read is evidence only if canonical has not changed since the read | `test/state-integrity.test.ts:376`, `:396`, plus race tests `:485`, `:520` (two Postgres connections) | Migration `20260930000000_reconcile_never_replays_stale_reads.sql` | Migration chain clean from zero; 314 tests pass on PGlite and Postgres 17; lint, typecheck clean; integrity 0 FAIL on canonical local and hosted; **deployed to hosted**; hosted dry-run 0 drift | Done 2026-10-01 (§12): hosted repair run, then the controlled live test on PRJ-2026-0029, with [evidence/ac01-live-verification.json](../evidence/ac01-live-verification.json) | **FIXED** |
| AC-02 | P0 | A missing or reshaped Airtable field is replayed as a staff edit | **Yes**, offline (PGlite and Postgres 17) | 5 failing tests that emulate real Airtable reads: keys omitted, dates as UTC instants, one field changed on 8 records (below) | The reconciler read an absent key as "blank", compared date instants as text and cast them to their UTC date, and had no notion of a field-level change | A field missing from a whole read is not evidence; a date is the Brisbane business day it denotes; one field changing on many records at once is not N staff edits | `test/state-integrity.test.ts:427`, `:449`, `:458`, `:473`, `:490`, plus bulk-edit tests `:511` (legitimate, via webhook) and `:535` (missed, ambiguous) | Migration `20260930010000_reconcile_field_shape_guards.sql` | Chain from zero on PostgreSQL 17.11; 328 tests pass on PGlite and Postgres 17; red without the fix, green with it; each part ablated turns its own tests red; lint, typecheck clean; local integrity 0 FAIL; grants checked | Done 2026-10-01 (§10–§11): deployed alone; hosted dry-run 0 drift, 0 findings; integrity 0 FAIL; proven cell by cell against an independent read of the real base, with [evidence/ac02-live-verification.json](../evidence/ac02-live-verification.json) | **FIXED** |
| AC-10 | P0 | 06 applies its own stale correction back as a staff edit | **Yes**, offline (PGlite and Postgres 17), with a harness that replays 06's real batch order, Airtable's echo transactions and the cursor | Ping-pong: after one transient read-back failure and a staff edit, every run applied RoofOps's own write, flipping canonical, and the cursor never advanced. Related: a staff member's fix of their own refused edit was refused as a conflict (below) | A correction is computed when 06 processes an item but written after later items; a landed-but-overtaken write never verifies; its echo passes compare-and-set; compare-and-set judged the staff member's `previous` against canonical, not against what Airtable showed | A value RoofOps wrote is never applied back as a staff edit; after the staff member's last edit, Airtable and canonical converge and every run advances the cursor | `test/state-integrity.test.ts:628`, `:650`, `:663`, `:685`, guard `:707`, echo-window tests `:729`, `:747`, retention `:764`; harness `Airtable06` `:62` | Migration `20261001000000_roofops_writes_are_not_staff_edits.sql` (+ one line in n8n 06, not yet deployed) | Chain from zero; 344 tests pass on PGlite and Postgres 17; red without the fix (7 of 8; the guard stays green); each of 7 parts ablated turns its own tests red; lint, typecheck clean; local integrity 0 FAIL; grants and RLS checked | Done 2026-10-01 (§10–§11): deployed alone; dry-run 0 drift, integrity 0 FAIL, security all pass. The live test on PRJ-2026-0029 reproduced the stale write for real and it converged: the fix was applied, the echo ignored, the cursor consumed, 0 drift, the hash chain intact, and the value restored. [evidence/ac10-live-verification.json](../evidence/ac10-live-verification.json). The 06 `origin` line is live and verified (§12) | **FIXED** (origin propagation live 2026-10-01, §12) |
| AC-03 | P0 | Airtable Approve is not bound to the row or preview the approver saw | **Yes**, offline (PGlite and Postgres 17), with events shaped exactly as n8n 04 sends them | 3 failing tests: an Approve approved a Copilot re-prepared preview never shown in Airtable, another project's preview (edited Project Number cell), and a preview prepared after the click | 04's decision names no approval; `wf_invoice_decide` found the project by the editable Project Number text and decided whatever was PENDING at processing time | An Airtable decision applies only to the sending record's project and to the preview a Prepare showed on that row before the decision; other sources must name the approval; a sent hash must match | `test/invoice-approval-binding.test.ts:68`, `:98`, `:117`, `:129`, guards `:85`, `:108` | Migration `20261001010000_invoice_decision_bound_to_row_and_preview.sql` (Postgres only; n8n unchanged) | Chain from zero; 356 tests pass on PGlite and Postgres 17; red without the fix (4 of 6; both guards green); each of 5 rules ablated turns its own test red; lint, typecheck clean; local integrity 0 FAIL; grants and RLS checked | Done 2026-10-01 (§10–§11): deployed alone; dry-run 0 drift, integrity 0 FAIL, security all pass. On PRJ-2026-0005 an Approve of a Copilot preview never shown on the row was refused, with nothing approved; Prepare then showed the same preview; the state was reset and 0 drift remained. [evidence/ac03-live-verification.json](../evidence/ac03-live-verification.json) | **FIXED** |
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

---

## AC-02 evidence package

### 1. Reproduction (offline, before the fix)

The catalogue's probes (`ws07/p1_missing_field.mts`, `ws07/p3_order_and_tz.mts`) were not available in this session, so the
reproduction was rebuilt as regression tests. They feed `wf_reconcile_airtable` reads shaped the way the Airtable API
really returns them. The existing `snapshot()` helper always sends every field id (with `null` for blanks) and only
`YYYY-MM-DD` dates, which is why the suite missed this.

Red on the current code (PGlite; the same on Postgres 17), 2026-10-01:

```
× AC-02: a field missing from every record of the read … is never replayed as "staff blanked it"
    AssertionError: expected [ …(30) ] to deeply equal [ …(30) ]        ← planned dates changed across the project table
× AC-02: a blank cell on one record (the field is present on others) is still a missed staff edit
    AssertionError: expected [] to deeply equal [ Array(1) ]           ← knock-on: the first run had already blanked it
× AC-02: dates returned as instants for the same Brisbane day are not drift, run after run
    AssertionError: expected [ +0, 47, … ] to deeply equal [ +0, +0, [] ]
    "✓ Planned Start: 2026-10-04 → 2026-10-03T14:00:00.000Z applied"   ← 47 phantom drifts; each date moved back one day
× AC-02: a real date change sent as an instant lands on the Brisbane business day …
    expected '2026-11-19' to be '2026-11-20'                           ← the UTC date, not the business day
× AC-02: the same field changed on many records in one read … nothing is replayed
    expected { drift: 0 … } to match { drift: 8, corrections: [] }     ← knock-on from the corrupted dates
Tests  5 failed | 30 skipped (35)
```

### 2. Classification: a true bug

- **Not a test artifact.** The Airtable REST API omits empty cells from `fields`, and omits every cell of a field that
  was deleted or recreated (new field id). Switching a date field to "include time" returns ISO instants in UTC.
- **Not intended behaviour.** ADR-038 says reconciliation "replays, never picks a winner". A missing field has no
  winner to pick; the replay invented one ("staff blanked it") on every record.
- **When it happens.** The first nightly or on-demand repair run after anyone deletes, recreates or reformats a synced
  Airtable field. For dates it compounds: each run writes the shifted date back, and the next run shifts it again.

### 3. The first incorrect state transition

`projects.planned_completion_date` (and `planned_start_date`, `purchase_orders.expected_delivery_date`,
`supplier_reference`) set to NULL on every eligible record by `project_apply_change` / `po_apply_change`. They were
called from `wf_airtable_change` with `source='reconciler'`, on a replay built from
`a := e.fields -> c.airtable_field_id` (`20260930000000_…sql:89`), where an absent key reads as NULL. For instants, the
same handlers cast with `p_value::date` (`20260929001200_…sql:565`, `:629`), which gives the UTC date.

### 4. Why the architecture permitted it

- The reconciler judged every field record by record. Nothing looked at the read as a whole, so a field absent from
  all 30 projects looked like 30 separate staff edits.
- In the REST API, "absent" means both "blank" and "no such field". Record by record the two can't be told apart;
  across the whole read they can.
- `at_norm` compares values as text. `'2026-10-04T14:00:00.000Z'` never equals `'2026-10-05'`, so every date is drift.
  The handlers then cast it to a UTC date, and the webhook path (06) and the read-back proof
  (`wf_airtable_writeback_verified`) shared the same conversion.
- The field contract had no type, so nothing knew a field held a business day.

### 5. Invariant

> A field id missing from a whole Airtable read is never a staff edit. A date is the Brisbane business day it denotes,
> whatever shape Airtable returns it in. A reconcile run never changes a canonical date that Airtable shows as the same
> business day, so N runs with no staff edits change nothing. The same staff-editable field differing on many records
> in one read is a change to the field, reported once, never replayed record by record.

### 6. Regression tests (written first, watched fail)

`test/state-integrity.test.ts`, reconciliation block, on PGlite and real Postgres 17:

- `:427` **Field missing from every record.** Planned Start and Planned Completion keys are removed from every project in
  the read, plus one genuine missed status edit (PRJ-2026-0025) in the same read. It asserts:
  - every canonical date is unchanged;
  - the status edit is still applied (not a blanket abort);
  - no correction writes to the missing field ids;
  - exactly one `REQUIRES_HUMAN/EXCEPTION_OPENED` finding per field, with a `SCHEMA_MISMATCH` exception;
  - no false drift is recorded for those fields.
- `:449` **Blank cell on one record** (key absent on PRJ-2026-0030 only). Still replayed as a missed staff edit. This
  guards against making guard 1 too broad.
- `:458` **Instants for the same Brisbane day**, in all four project date fields, over **two consecutive runs**. Asserts
  0 drift, no corrections, no findings, and no canonical date changed.
- `:473` **A real change sent as an instant.** Covers three paths:
  - the reconciler applies it as the Brisbane day (2026-11-20, not 2026-11-19);
  - the webhook path applies the next edit the same way, with no correction back to Airtable;
  - the read-back proof accepts an instant for the right day.
- `:490` **Same field on 8 of 30 projects**, shifted by a day. Asserts:
  - nothing is replayed and no correction is written;
  - drift is 8, with one field-level `REQUIRES_HUMAN` finding;
  - the 8 divergences stay visible in `v_state_drift`.

Added in round 2, on the owner's request:

- `:511` **A legitimate bulk edit through the webhook.** Six projects (20% of the read) are moved to the same new finish
  date through `wf_airtable_change`, each `APPLIED`, while a run holds an older read. It asserts:
  - all six values are kept, with no correction;
  - six `STALE_EVENT/NONE` findings (re-checked next run), with **no** field-level alarm and no exception;
  - the next run with a fresh read has 0 drift and 0 findings.
- `:535` **A missed bulk edit (no webhook).** Airtable shows six genuine staff edits RoofOps never received, and the read
  is ambiguous. Over two runs it asserts:
  - nothing is applied to RoofOps, and nothing is reverted in Airtable (no corrections);
  - one `REQUIRES_HUMAN/EXCEPTION_OPENED` finding per run;
  - the six divergences stay visible in `v_state_drift`;
  - **one** exception, reused by the second run (`attempt_count` 2).

### 7. Fix (design, not the example)

New migration `supabase/migrations/20260930010000_reconcile_field_shape_guards.sql`. It changes Postgres only; n8n is
unchanged.

1. **Dates are typed.** `field_contract.value_type` ('text' | 'date') marks the 10 date fields. It is exported to
   `docs/source-of-truth.*`.
2. **One normalisation at every entry point.**
   - `at_business_date()` turns any Airtable date or date-time into the Brisbane business day. Anything unparseable is
     returned unchanged and never guessed.
   - `at_normalize_fields()` applies it to the date fields of a record.
   - It is used by:
     - the reconciler, on the whole read;
     - `wf_airtable_change`, which is now a thin wrapper that normalises `changes.current/previous` and `current`, then
       calls the unchanged handler (renamed `wf_airtable_change_core`);
     - `wf_airtable_writeback_verified`, which is also now a wrapper around `…_core`.
   - The renamed internals are not callable by n8n. n8n and the reconciler keep calling the same names.
3. **Guard 1, a field missing from the whole read.** If a contract field id appears in no record of the read while
   RoofOps holds a value for at least one of them, it is:
   - not compared, observed, replayed or written;
   - reported once as `REQUIRES_HUMAN`, with a `SCHEMA_MISMATCH` exception naming the field and its id.

   A blank cell on some records, with the field present on others, is still evidence.
4. **Guard 2, a field-level change.** If one staff-editable field differs on at least 5 records **and** at least 20% of
   the read, none of those differences are replayed. The drift stays counted and visible, and there is one
   `REQUIRES_HUMAN` finding with a `RECONCILIATION_MISMATCH` exception. Missed edits after a real outage still arrive
   through 07's webhook drain, which carries real payloads with previous values. **Only records unchanged since the
   run started count** (the AC-01 rule, see the round-2 correction below).
5. `wf_reconcile_airtable` returns `suspect_fields`. The existing keys are unchanged, so n8n 07 is unaffected.

**Known trade-off (guard 1):** a sparse field, one blank in almost every record, that a staff member blanks on its
only non-blank record while the webhook is missed is indistinguishable from a deleted field. It is reported to a
person rather than replayed. The webhook path still applies such an edit normally, because 06 carries real previous
values.

**Round-2 correction, found by the legitimate-bulk-edit test.** The first version of guard 2 counted differences over
every record in the read, including records that staff changed through the webhook after the read was taken. A
genuine bulk edit racing a reconciliation run therefore raised a false field-level alarm and exception. The records
themselves were safe, because AC-01's rule skipped them, but the alarm was false. The red run on the first version was
`expected [ …(7) ] to deeply equal [ …(6) ]`: six correct `STALE_EVENT` findings plus the false `REQUIRES_HUMAN`.
Guard 2 now counts only records whose canonical row has not changed since the run started. The migration had not
reached any shared environment (only the local dev DB, which was then rebuilt with `npm run db:reset`), so the fix was
made in the same file.

### 8. Verification, round 1 (superseded by round 2 below)

| Check | Result |
|---|---|
| AC-02 tests, fix removed / restored (byte-identical, sha256 `a168e642b835e933…`) | **5 failed** / **5 passed** |
| Ablation, one part disabled at a time | Guard 1 off: `:427` red. Normalisation off: `:458` and `:473` red. Guard 2 off: `:490` red. `:449` stays green throughout (it guards against over-blocking). File restored byte-for-byte |
| Full suite, PGlite + Postgres 17 (every suite builds its database from all migrations) | **324 passed**, 33 skipped. Baseline 314; +10 = 5 tests × 2 engines |
| Lint / typecheck | Clean |
| Local dev DB (`npm run db:load` applied only this migration) | `integrity:check -- --local`: **22 PASS, 4 WARNING, 0 FAIL** (same as after AC-01) |
| Grants (local) | `roofops_workflow` can execute `wf_airtable_change`, `wf_airtable_writeback_verified`, `wf_reconcile_airtable`, but not the two `…_core` functions; `roofops_dashboard` can execute none of them; the schema test's allowed list is unchanged and passes |
| Contract export | Only the 10 date rows gain `value_type: date` / a "Brisbane business day" note; state machines unchanged |

### 9. Pre-deployment checks (round 2, 2026-10-01)

| Check | Result |
|---|---|
| 1. Repo, local and hosted histories aligned through AC-01 | **Yes.** All 18 versions have identical checksums in repo, local (rebuilt with `npm run db:reset`) and hosted |
| 2. `20260930010000_reconcile_field_shape_guards.sql` globally unique and unused | **Yes.** One repo file with that prefix; absent from git history, and absent from hosted. It sorts after every hosted version. The local dev DB holds exactly the repo file (checksum `740e6d4b…`), from the rebuild |
| 3. Fresh PostgreSQL 17.11 database migrated from zero through AC-02 | **Yes.** 19 applied, 0 skipped; import succeeded; a second migrate applied 0 and skipped 19. Checks on it: 10 date fields typed, handler renamed to `_core`, integrity 0 FAIL, and `at_business_date('2026-10-04T14:00:00.000Z')` = `2026-10-05`. The database was then dropped |
| 4. AC-02 regression tests after that | **20 passed** (every AC-01 and AC-02 test; PGlite + Postgres 17) |

### 10. Hosted deployment and dry-run (2026-10-01, no repair run)

- **Applied `20260930010000_…` alone** (18 skipped). The value fingerprint was taken first: 173 values, `89d72adf…`.
  The hosted checksum equals the repo file (`740e6d4b…`).
- **`npm run reconcile -- --dry-run`** gave `RECON-20261001-052724-7729` (observe, COMPLETED):
  - Airtable **231 checked, 0 drift, 0 findings, 0 needing a person, `drift_now` 0**;
  - per table: Customers 40, Suppliers 6, Properties 52, Purchase Orders 35, Projects 33, Quotes 65, all with drift 0;
  - Drive 3/3 and Xero 1/1 without drift;
  - all 3 webhooks OK, 0 unread.
  - So there were no schema warnings, no mass-change warnings and no date drift.
- **`npm run integrity:check`:** 23 PASS, 3 WARNING, 0 FAIL, the same known warnings (PRJ-2026-0001 open PO,
  Q-2026-0031, open exceptions).
- **`npm run security:check` (hosted):** all 9 checks pass. `roofops_workflow` still has exactly 17 executable
  functions (the renamed `…_core` internals are not among them).

### 11. Live proof from the real Airtable read

07 does not store its read, so the base was read again independently through the Airtable connector, right after the
dry-run: Projects (33 records, 4 date fields) and Purchase Orders (35 records: PO Date, ETA, Supplier Reference). The
read is recorded in [evidence/ac02-airtable-read-2026-10-01.json](../evidence/ac02-airtable-read-2026-10-01.json).
A read-only script (hosted session set to read only) checked every cell against hosted canonical state, against what
the dry-run itself recorded from its own REST read, and against the deployed functions. Results are in
[evidence/ac02-live-verification.json](../evidence/ac02-live-verification.json).

| Requirement | Evidence from the real read | Verdict |
|---|---|---|
| Omitted blank cells do not wipe canonical values | The API omitted 48 blank cells (Planned Start 3, Planned Completion 3, Actual Start 20, Actual Completion 25). **All 48 are blank in RoofOps too** (`omitted_with_canonical_value` 0). 0 drift, and the 173-value fingerprint is unchanged | Pass |
| Legitimate blank values can still be distinguished where supported | Every field is present on at least one record (Actual Start: 13 present, 20 blank), so guard 1 is inactive and each blank is per-record evidence. Guard 1 finds **no** field missing from every record | Pass |
| Date-only values remain the same Brisbane business day | All 151 date cells present in the read are `YYYY-MM-DD` (0 in any other format), and every cell, present or blank, equals canonical. On hosted, all 183 distinct real dates (2024-11-15 to 2026-11-05) pass `at_business_date()` unchanged | Pass |
| Airtable date-time values normalise to the correct Brisbane day | The production base has **no** date-time fields (no field was changed to create one). Instead, the deployed function was run on hosted on every one of the 183 real dates, as Brisbane-midnight instants, 23:59:59.999 instants and `+10:00` offset forms (183/183 give the same day), plus the 14:00Z boundary (183/183 give the next Brisbane day) | Pass (constructed values; no destructive schema test) |
| No existing project dates shift | Project, PO, quote and customer dates: fingerprint `89d72adf…` before the deploy = after the dry-run | Pass |
| No supplier reference or ETA unexpectedly cleared | All 35 ETAs and 35 supplier references are present in Airtable and equal canonical | Pass |
| No false mass-change detection | Guard 2's maximum differing records per staff-editable field in this read is **0**. There are 0 `REQUIRES_HUMAN` findings, and 0 open `SCHEMA_MISMATCH` / field-level exceptions | Pass |
| `v_state_drift` remains truthful | `v_state_drift` has 0 rows. Every cell the dry-run recorded from its own read (237/237 cells: 33 × 4 project fields + 35 × 3 PO fields) equals the independent read, and all were refreshed by this run | Pass |

**Not done, by design:**
- No repair run was performed after the AC-02 deployment.
- No production Airtable field was deleted or changed to date-time. Destructive schema tests would need a disposable
  clone of the base; the offline tests feed those exact shapes.

### 12. Verification before completion (fresh, after everything above)

| Check | Result |
|---|---|
| Full suite, PGlite + Postgres 17 | **328 passed**, 0 failed, 33 skipped (vitest exit 0). Baseline 314; +14 = 7 AC-02 tests × 2 engines |
| Lint / typecheck | exit 0 / exit 0. The temporary live-verification helpers were moved out of the repo; they are not part of any commit |
| Red/green on the final migration (sha256 `740e6d4b12902618…`, restored byte-for-byte) | Removed: **7 failed**. Restored: **7 passed**. The blank-cell and legitimate-bulk-edit tests fail when it is removed partly as a knock-on (earlier tests corrupt shared data first). Their specific proofs are the ablation above (guard 1 not over-broad) and the round-2 red run (the false alarm) |
| Hosted checksum = repo file | `740e6d4b…` on both |
| Contract docs current | Regenerating them produced identical files |

**AC-02 is FIXED.**

---

## AC-10 evidence package

### 1. Reproduction (offline, before the fix)

The catalogue's probes (`ws05/p1-pingpong.mts`, `ws04/p3-stale-correction-echo.mts`) were not available, so a probe
replayed n8n 06 exactly (`n8n/06-airtable-changes.sdk.ts:148-153`):

- **Apply Change In Postgres** runs for **every** item of the batch first.
- Then each item's corrections are PATCHed, read back and proved, in item order.
- The cursor advances only if every proof verifies.

Every write to the simulated record (staff or n8n) becomes one webhook transaction with Airtable's real shape. Earlier
live 06 executions (e.g. n8n execution 1805) show that Airtable always sends `previous`, even for blank cells, so the
probe always sets `has_previous`.

| Scenario | Before the fix |
|---|---|
| S1: a staff member types an invalid finish (10-10), then fixes it (10-25) before 06 runs | The fix was **refused**: "someone else changed it at the same time". Airtable and Postgres settled on 10-19, so the staff member's last edit was lost (the catalogue's related symptom) |
| S2: a refused start, then a valid finish edit | Converged correctly |
| S3: two legal status changes in one batch | Converged correctly |
| S4: a correction lands but its read-back fails once (transient Airtable/n8n error), then the staff member moves the finish | **Ping-pong** (below) |

S4, before the fix (PRJ-2026-0017):

```
run1 txn1 (staff 10-22→10-01) → REJECTED corr 10-22 | read-back fails → execution fails, cursor 0/2
run2 txn1 (dup) → corr re-issued 10-22 (computed before txn3) · txn2 (n8n echo) NO_CHANGE · txn3 (staff 10-22→10-30) APPLIED
     the stale 10-22 is written over the staff edit; its read-back ≠ canonical → NOT verified → cursor 0/4
run3 txn4 (n8n: 10-30→10-22) → APPLIED        ← RoofOps's own write applied as a staff edit; canonical 10-22
run4 txn5 (n8n: 10-22→10-30) → APPLIED        ← and back again …
run5 txn6 (n8n: 10-30→10-22) → APPLIED   run6 txn7 → APPLIED   run7 txn8 → APPLIED     cursor 0/9, forever
```

Regression tests, red on the code before the fix (PGlite; the same on Postgres 17):

```
× a correction that landed but whose read-back failed, then a staff edit: no ping-pong …
    expected [ { n: 4, who: 'n8n', … }, … ] to deeply equal []          ← own writes applied
× a staff member who fixes their own refused edit before the correction lands is not told someone else changed it
    expected [ 'REJECTED', 'REJECTED' ] to deeply equal [ 'REJECTED', 'APPLIED' ]
× reconciliation never replays a RoofOps write that Airtable still shows before its echo was processed
    expected '2026-10-19' to be '2026-11-09'                             ← the reconciler replayed RoofOps's stale write
Tests  3 failed | 1 passed (the guard)
```

### 2. Classification: a true bug

- **Not a test artifact.** The harness uses 06's real node order and Airtable's real payload shape. The trigger is
  ordinary: one transient failure after a PATCH landed (an Airtable 5xx on the GET, an n8n restart), followed by a
  staff edit to the corrected field, is enough.
- **Not intended behaviour.** ADR-037 says Airtable is "an editing surface, never a second source of truth" and that
  unverified corrections are re-issued "recomputed from canonical state". The re-issue was recomputed at the wrong
  moment, before later items in the same batch.
- **Impact.** Canonical flips on every execution, the audit trail fills with edits attributed to the staff account,
  and the cursor never advances, so every later Airtable edit to any record is delayed until someone intervenes.

### 3. The first incorrect state transition

`projects.planned_completion_date` 2026-10-30 → 2026-10-22 in run 3, written by `project_apply_change` for
`txn4`. That transaction is n8n's own PATCH (the re-issued correction for `txn1`), judged by `wf_airtable_change_core`
as a staff edit: its `previous` (10-30) equalled canonical, so compare-and-set passed
(`20260929001300_…sql:97`).

### 4. Why the architecture permitted it

- **Corrections are computed at Apply time and written later.** 06 applies all items, then writes. A correction for an
  earlier item (here, re-issued for a duplicate) can be written after a later item has moved canonical.
- **Proof compared the read-back with canonical *now*.** A write that landed correctly but was overtaken could never
  verify, so the cursor never advanced and the same batch was redelivered, re-issuing more stale corrections.
- **RoofOps did not know its own writes.** Nothing recorded what it had asked n8n to write, so the echo of its own PATCH
  was indistinguishable from a staff edit, and compare-and-set could not tell them apart.
- **Compare-and-set judged `previous` against canonical.** A staff member editing the value Airtable visibly showed
  (their refused edit, before RoofOps's correction landed) looked like a concurrent edit.
- **The reconciler had the same blind spot.** It would replay a RoofOps write still showing in Airtable as a missed
  staff edit.

### 5. Invariant

> A value RoofOps wrote to Airtable is never applied back as a staff edit, by the webhook path or by reconciliation.
> After a staff member's last edit, Airtable and canonical converge on it, and every 06 execution consumes its batch
> (the cursor advances). A staff edit made against the value Airtable visibly showed is judged on its merits, not
> refused as a conflict.

### 6. Regression tests (written first, watched fail)

`test/state-integrity.test.ts`, block `AC-10`, on PGlite and real Postgres 17. The `Airtable06` harness (`:62`)
replays 06's node order (Apply for every item, then every PATCH, then every read-back and proof), Airtable's echo
transactions, the cursor, and a distinct worker per execution (06 passes `'n8n:' + $execution.id`). Its transactions
are stamped with real time, never before a change already applied to the record.

- `:628` **The ping-pong (S4).** A correction lands, its read-back fails once, then a staff edit follows. It asserts:
  - none of RoofOps's own writes is ever applied;
  - canonical is the staff value after every one of the next three executions;
  - **every execution consumes its whole batch** (the cursor reaches the last transaction each time);
  - Airtable agrees;
  - exactly one audit row (the staff edit).
- `:650` **Fixing your own refused edit (S1)**, both edits in one batch. The fix is `APPLIED`, and none of RoofOps's own
  writes is applied. Canonical and Airtable both hold the fix, and the cursor is at the end.
- `:663` **Reconciliation** meets a stale RoofOps write still showing in Airtable, with 06 down. It is not replayed:
  canonical keeps the staff value, and Airtable is corrected back to it.
- `:685` **A reconciliation repair overtaken** by a webhook status change before 07 reads it back. The proof reports
  `verified: true` with `overtaken_fields`, and the repair's echo converges Airtable to canonical.
- `:707` **Guard:** a staff member deliberately choosing a value RoofOps wrote earlier, after its echo was seen, is
  `APPLIED`. This stays green with or without the fix; it pins down that the fix does not over-block. Its transactions
  are seconds apart, so they fall inside the echo window, but the write had already been consumed by its echo. It
  therefore does **not** cover an unconsumed write. The two tests below do.
- `:729` **Echo window, same batch** (no `origin`, as the current 06 sends). The staff member types an invalid finish,
  then a valid one, then goes back to exactly the value RoofOps's pending correction will write, all before 06 runs.
  The test asserts that the last edit is stamped inside the window (−5 / +30 minutes) of the still-unconsumed write.
  Result: `REJECTED`, `APPLIED`, `APPLIED`; canonical and Airtable hold that value; two audit rows, both staff edits.
- `:747` **Echo window, later execution** (with `origin`). Same start, so RoofOps's correction lands on a cell that
  already shows its value and never echoes. The staff member then moves the finish and, minutes later in another
  execution, chooses that value again in the Airtable UI (inside the window of the unconsumed write). Result: `APPLIED`.
- `:764` **Retention.** Old rows are inserted beside a real pending write (its read-back failed): settled 10 days,
  echoed 40 days, verified 40 days, unsettled 40 days, unsettled 100 days. Ordinary 06 runs prune as they record
  writes. The test asserts:
  - exactly the settled 10-day row and the unsettled 40-day row remain;
  - the pending write is kept, and is still recognised (none of RoofOps's own writes is applied, the staff edit
    stands, the cursor is at the end);
  - no row beyond the retention bounds is left.

### 7. Fix (design, not the example)

New migration `supabase/migrations/20261001000000_roofops_writes_are_not_staff_edits.sql`. n8n still calls the same
three function names. One line in n8n 06 passes Airtable's `actionMetadata.source` as `origin` (point 8). It is
optional for the rest of the fix, and it is not yet deployed (§11).

1. **A ledger of RoofOps's own writes.** `airtable_writes` holds every value RoofOps asks n8n to write to Airtable:
   corrections from the webhook path, including re-issues, and repairs from reconciliation. Each row records the field,
   the value, the value it replaces, the issuing event and the issue time. A value equal to what Airtable already shows
   is not recorded, because it produces no echo. The table is RLS-protected, and no role outside the definer functions
   can read or write it.
2. **Echo recognition** (in `wf_airtable_change`, before the unchanged handler, now `wf_airtable_change_core`):
   - **What counts as an echo.** A change whose value equals an outstanding RoofOps write for that field.
   - **Timing window.** For the webhook, the transaction must be stamped from 5 minutes before to 30 minutes after the
     write was issued. For the reconciler, the write must be at most 7 days old.
   - **What happens to it.** It is RoofOps's own write, so it is never applied or compared. If canonical has moved on,
     Airtable is corrected to canonical, with a RoofOps Sync note: "an earlier RoofOps correction arrived after a newer
     edit; "…" is kept".
   - **Consumption.** A webhook echo consumes the write, and any older outstanding write for the field, so it can't
     match a later genuine edit.
3. **An edit made before a correction landed.** A staff change whose `previous` is exactly the value an outstanding
   RoofOps correction is replacing was made against what Airtable showed. Compare-and-set accepts it, and it is still
   fully validated. A genuine concurrent edit (any other `previous`) is still refused.
4. **An overtaken write is verified as landed.** `wf_airtable_writeback_verified` accepts a field whose read-back is
   either canonical or exactly the value this event (or reconciliation run) asked to write. The result lists it in
   `overtaken_fields`. Its echo then converges Airtable, and the cursor advances.
5. **Reconciliation records its repairs.** `wf_reconcile_airtable` wraps the unchanged AC-02 function (now `…_core`).
6. **The same lock order as the handler.** The canonical row is locked before any decision, so a concurrent change
   can't slip between the echo check and the handler.
7. **Nothing in the issuing execution's batch is its echo.** Each write records the worker that issued it
   (`n8n:<execution id>`). 06 PATCHes only after Apply has run for its whole batch, so a transaction in that batch whose
   value equals the pending write is a person choosing that value. It is judged as a staff edit, never as an echo.
   This found and fixed a real hole: an invalid edit, a fix, then a return to the original value, all typed before 06
   ran, lost the last edit (Airtable was put back with a misleading "↺" note). `:729` pins it.
8. **An edit made in the Airtable UI is never an echo.** RoofOps writes only through the API. Airtable labels each
   payload with `actionMetadata.source`, confirmed on live 06 execution 1911: an API write shows `publicApi`, and a
   person in the UI shows `client`. When 06 passes it as `origin`, only `publicApi` changes (and events without
   `origin`) are checked for echoes. `:747` pins it.
9. **Bounded ledger.** Every rule reads only writes issued in the last 7 days. That is the widest window: the
   reconciler's; the webhook's is 30 minutes, and Airtable keeps payloads for 7 days. The edit-before-landed rule and
   the landed-write proof are now bounded the same way, so older rows cannot change any decision.
   `airtable_writes_prune()` deletes settled writes (echo seen, or read back) after 30 days and unsettled ones after
   90 days. That is 4× and 13× the widest window. It runs whenever writes are recorded, so no scheduler is needed; an
   index on `issued_at` keeps it cheap. A pending write is inside the 7-day window by definition, so it is never
   deleted. `:764` pins it, and ablation D shows what deleting pending writes would break.

**What remains ambiguous without `origin`.** Consider an API client other than RoofOps (a script, or the Airtable
connector) that writes exactly the value of a still-unconsumed RoofOps write, within 30 minutes. If that write never
echoed, the change is treated as RoofOps's echo. A RoofOps write never echoes only when Airtable already showed its
value at PATCH time, which is point 7's case. With `origin`, people editing in Airtable are exact; until the 06 line
is deployed, the ambiguity also covers them in that same narrow case (`:747` fails without `origin`: ablation B).

**Convergence.** With n8n unchanged, a write overtaken inside one batch still lands briefly. Its echo arrives in the
next 06 execution (triggered by Airtable's own ping, seconds later), where it is recognised and corrected. The
following execution sees Airtable agree. Every execution advances the cursor. A change to n8n 06 (recompute
corrections immediately before each PATCH) would avoid the brief overtaken value altogether. It is optional hardening,
not needed for the invariant.

**The window was widened after a probe finding.** The first version allowed ±1/15 minutes. The original probe, which
stamps transactions at a fixed past time, still showed echoes applied, because they fell outside the window. Airtable
stamps transactions with real time, so the tests (real time) passed. Still, the window was widened to 5 minutes of
clock skew and 30 minutes of PATCH delay (06's own retries take under a minute), and the probe was re-run with real
timestamps.

### 8. Verification (first version, before points 7–9; kept for the record, superseded by §9)

| Check | Result |
|---|---|
| Probe re-run (real timestamps), all four scenarios | S1: the fix is `APPLIED`; the overtaken correction's echo is `NO_CHANGE` with a correction back to 10-25; converged. S2 and S3 unchanged. S4: the staff edit is `APPLIED`; echoes are `NO_CHANGE`; converged at 10-30; cursor 4/4, then 5/5. No RoofOps write is applied in any scenario |
| Red / green, fix removed / restored byte-for-byte (sha256 `c85b76455d2c424a…`) | Removed: **4 failed**, 1 passed (the guard). Restored: **5 passed** |
| Ablation, one part at a time | Echo recognition off: `:616`, `:638`, `:651` red. Edit-before-correction rule off: `:638` red. Overtaken-write verification off: `:616` (the cursor stalls: `[0, 0]` for `[0, 3]`) and `:673` red. Reconciler recording off: `:673` red |
| Full suite, PGlite + Postgres 17 | **338 passed**, 33 skipped. Baseline 328; +10 = 5 tests × 2 engines |
| Lint / typecheck | exit 0 / exit 0 |
| Fresh PostgreSQL 17 database, migrated from zero | 20 applied, 0 skipped; import OK; a re-run applied 0 and skipped 20; integrity 0 FAIL |
| Migration histories | Repo, local and hosted aligned through AC-02 (19 versions, identical checksums). `20261001000000` is unused in git history and on hosted |
| Local dev DB (`npm run db:load` applied only this migration) | `integrity:check -- --local`: 22 PASS, 4 WARNING, 0 FAIL (unchanged) |
| Grants and RLS (local) | `roofops_workflow` can execute `wf_airtable_change`, `wf_airtable_writeback_verified` and `wf_reconcile_airtable`, but none of the three `…_core` functions or `airtable_record_writes`. `roofops_dashboard` can execute none of them. `airtable_writes` has RLS on and cannot be read by either role |

### 9. Verification of the final migration (sha256 `c570be45…`), 2026-10-01

| Check | Result |
|---|---|
| Red, whole fix removed (test harness in its final form) | **7 failed**, 1 passed (the guard) |
| Ablation A: no same-execution rule | Only `:729` red (both engines) |
| Ablation B: no `origin` rule | Only `:747` red |
| Ablation C: no pruning | Only `:764` red |
| Ablation D: pruning also deletes pending writes | **7 of 8 red**: every test that relies on a pending write |
| Ablation E: pruning keeps everything | Only `:764` red |
| Full suite, PGlite + Postgres 17 | **344 passed**, 33 skipped (baseline 328; +16 = 8 tests × 2 engines) |
| Lint / typecheck | exit 0 / exit 0 |
| Fresh PostgreSQL 17 database, migrated from zero | 20 applied, 0 skipped; import OK; a re-run applied 0 and skipped 20. Checks: integrity 0 FAIL, `airtable_writes` RLS on and empty, `…_core` functions and `airtable_writes_prune()` present. The database was then dropped |
| Local dev DB, rebuilt (`db:reset`) | `integrity:check -- --local`: 22 PASS, 4 WARNING, 0 FAIL |
| Grants (local and hosted, identical) | `roofops_workflow` can execute exactly the three entry points. The internal functions (`wf_airtable_change_core`, `wf_airtable_writeback_verified_core`, `wf_reconcile_airtable_core`), `airtable_record_writes` and `airtable_writes_prune` are executable by neither application role. `airtable_writes`: RLS on, and neither role can select or insert |

### 10. Hosted deployment and checks (2026-10-01, no repair run)

- **Before the deploy.**
  - Repo, local and hosted aligned through AC-02: 19 versions, identical checksums.
  - `20261001000000` has exactly one repo file, is absent from git history and hosted, and is later than every
    applied version.
  - Value fingerprint: 173 values, `89d72adf…`.
- **`npm run db:load -- --hosted`** applied `20261001000000_roofops_writes_are_not_staff_edits.sql` alone (skipped 19).
  - The dataset was already imported, so nothing else ran.
  - The hosted checksum equals the repo file (`c570be45…`).
  - The fingerprint afterwards is unchanged (`89d72adf…`).
- **`npm run reconcile -- --dry-run`** gave `RECON-20261001-062752-d8e0` (observe, COMPLETED):
  - Airtable **231 checked, 0 drift, 0 repaired, 0 needing a person, `drift_now` 0**, 231 linked;
  - Drive 3/3 and Xero 1/1, both without drift;
  - all 3 webhooks OK, 0 unread.
- **`npm run integrity:check`** (hosted): **23 PASS, 3 WARNING, 0 FAIL**. The warnings are the known open items:
  - cancelled PRJ-2026-0001 with an open PO;
  - Q-2026-0031 accepted without a project;
  - four open exceptions.
- **`npm run security:check`**: every check passes.
  - Dashboard role: no readable tables, and no `wf_*` write other than prepare.
  - Workflow role: 17 functions.
  - Nothing is readable or executable by anon, authenticated or PUBLIC.
  - Every table has RLS.
  - Xero is pinned to the Demo tenant.
  - The trigger token is stored only as a hash.

### 11. Controlled live verification (2026-10-01, PRJ-2026-0029, approved by the owner)

This used the S1 path with both edits in one batch. No failure was injected in production: the ping-pong's transient
read-back failure stays an offline test (`:628`).

1. n8n 06 was unpublished.
2. In Airtable, Planned Completion was set to 2026-11-05 → **2026-10-30** (txn82; before the 2026-10-31 start, so
   invalid), then to 2026-10-30 → **2026-11-12** (txn83).
3. 06 was re-published on the same version (`d80e92d9`), and Airtable's ping retry triggered it.

What happened (n8n executions 1918–1921, all `success`; full record in the evidence file):

| Proof | Observed |
|---|---|
| The invalid staff edit is refused correctly | txn82 `REJECTED`: "Planned Completion 2026-10-30 would be before Planned Start 2026-10-31. Kept 2026-11-05" |
| The staff member's later valid correction is accepted | txn83 `APPLIED` 11-05 → 11-12, with `edited_before_correction_landed`. Before AC-10 this was refused as a conflict |
| RoofOps's own correction echo is not treated as a staff edit | 06 wrote txn82's correction (11-05) **after** txn83 was applied: the stale write AC-10 is about, occurring for real. Its read-back returned `verified: true, overtaken_fields: [Planned Completion]`. Its echo, txn84, was `NO_CHANGE` with `own_writes_ignored`, and Airtable was corrected back to 11-12. txn85, the echo of that correction, was `NO_CHANGE`. No RoofOps write was applied |
| The cursor advances fully | 13 → 15 (1918) → 16 (1919) → 18 (1920/1921) → 19 (the restore). Every webhook shows 0 unread |
| No infinite redelivery | 5 executions in total: 4 for the test batch, all within 12 s, then quiet; 1 for the restore. Overlapping executions delivered txn82/83 three times, and every duplicate was recognised |
| Airtable and Postgres converge | Both show 2026-11-12. `airtable_writes`: 3 rows, all echoed and verified, none open |
| The dashboard shows canonical state | `/projects/PRJ-2026-0029` shows 2026-11-12, with no out-of-sync notice |
| The Copilot reports canonical state | `get_project`: "planned to finish on **2026-11-12**" |
| Reconciliation is clean afterwards | `RECON-20261001-064623-bcc8`: 231 checked, 0 drift, 0 needing a person |
| The audit chain remains valid | `hash_chain_intact` PASS. Exactly one audit row (USER, 11-05 → 11-12); none for the refused edit or any RoofOps write. No new exception |
| The original value is restored through the normal Airtable path | Airtable 11-12 → 11-05 (txn87, execution 1923): `APPLIED`, one audit row, cursor 19. Airtable, Postgres, the dashboard and the Copilot all show 2026-11-05. Final dry-run `RECON-20261001-064840-f3a5`: 0 drift. Integrity 23 PASS, 3 WARNING (unchanged), 0 FAIL, with the hash chain intact. Value fingerprint `89d72adf…`, identical to before the deploy |

**Observation (not a defect of AC-10's invariant).** 1919 wrote the RoofOps Sync note "↺ Planned Completion: an
earlier RoofOps correction arrived after a newer edit; "2026-11-12" is kept." A re-issued duplicate correction cleared
it within seconds, because the existing re-issue logic recomputes the note as blank. Values were never affected;
only the explanation is lost. Worth a follow-up so the note persists.

### 12. Follow-up: origin propagation, live (2026-10-01, closed)

**Deploy.** The 06 `origin` line (`n8n/06-airtable-changes.sdk.ts`, Extract Record Changes:
`origin: (p.actionMetadata || {}).source || null`) was deployed on the owner's instruction. Active version
`4cc8d1d3…` replaced `d80e92d9…`. Point 8 of §7 is now active in production.

**Before.** Every earlier 06 event for PRJ-2026-0029 (txn82–87) reached Postgres with `origin` null
(`automation_events.payload`).

**Offline.** `test/state-integrity.test.ts:794` adds "origin publicApi alone never makes a change an echo". An API
client that is not RoofOps edits the field three times: once with nothing recorded for it (`APPLIED`), once invalid
(`REJECTED`), and once more (`APPLIED`). Between the last two, RoofOps's correction echo, also `publicApi`, is the only
`NO_CHANGE`. Postgres stores the origin on every event. Ablation "any `publicApi` change is an echo" turns only this
test red, on both engines.

**Live, on PRJ-2026-0029** ([evidence/ac10-origin-live-verification.json](../evidence/ac10-origin-live-verification.json)):

| Proof | Observed |
|---|---|
| RoofOps and API writes arrive as `publicApi` | txn93 (connector, invalid 10-30), txn94 (RoofOps's correction echo) and txn96 (connector, 11-06) all arrived as `publicApi` |
| Airtable UI edits arrive as `client` | txn97, the owner's edit in the Airtable UI to 11-05 at 22:09:50Z, arrived as `client` |
| `publicApi` alone is never enough | txn96 (`publicApi`, matching no recorded write) was `APPLIED`. Only txn94, which matched RoofOps's recorded 11-05 write, was treated as an echo (`NO_CHANGE`, consumed) |
| The ambiguity is closed | A duplicate re-issue left an unconsumed 11-05 write (issued 22:06:38Z) that never echoes. The owner's UI edit to exactly 11-05 came 3 m 12 s later, inside its window, and was `APPLIED`. Without `origin` it would have been reverted to 11-06 with a "↺" note |
| The existing AC-10 behaviour is unchanged | txn93 was `REJECTED`, its correction was verified and its echo ignored; every execution advanced the cursor (26 → 29); executions 1942–1946 all succeeded, and 06 was quiet afterwards |
| Everything agrees | Postgres, Airtable, the dashboard and the Copilot all show 2026-11-05, the original value, so the record ended as it began. Dry-run `RECON-20261001-081203-f7ea`: 0 drift, webhooks 0 unread. Integrity 0 FAIL, with `hash_chain_intact` passing. Security all pass. Fingerprint `89d72adf…` unchanged |

**AC-10 is fully closed.** Its remaining known limit is narrow. Another API client (not a person in the UI) writing
exactly the value of an unconsumed RoofOps write within 30 minutes is still taken for an echo, and reverted visibly
with a note. That is inherent: the two are indistinguishable in Airtable's payload.

### 13. (Historical) owner action that was outstanding before §12

The plan below was carried out as §11.

2. **Controlled live test of the fix-your-own-refused-edit path (S1)**, on a record in no demo scenario (e.g.
   PRJ-2026-0029, Planned Completion 2026-11-05). This is the realistic live trigger, and it needs a live Airtable edit
   and a brief 06 unpublish, so it needs approval.
   1. Unpublish n8n 06 briefly (as in the Phase 6 outage test), so both edits arrive in one batch.
   2. In Airtable, set Planned Completion before the Planned Start (refused), then fix it to 2026-11-12.
   3. Re-publish 06. Airtable's retry delivers both edits together.
   4. Verify each of these:
      - the fix is `APPLIED`, not a conflict;
      - no `n8n`-caused transaction is applied;
      - Airtable and Postgres both show 2026-11-12;
      - the cursor is consumed, and dashboard and Copilot agree;
      - the next dry-run is clean, and `hash_chain_intact` passes.
   5. Restore 2026-11-05 through Airtable, then run a final dry-run and integrity check.
3. The ping-pong itself needs a transient read-back failure. That can only be induced safely offline (the tests above),
   never by breaking production n8n.
4. **Commit:** migration, tests, the 06 source line, ledger and evidence, as one commit separate from other defects.

## AC-03 evidence package

### 1. Reproduction (offline, before the fix)

`test/invoice-approval-binding.test.ts` sends events shaped exactly as n8n 04 sends them
(`n8n/04-approved-project-to-xero-draft-invoice.sdk.ts`, Extract Invoice Actions):

- `payload` holds the row's Project Number cell, its record id and its RoofOps ID cell;
- there is no approval number or hash;
- `occurred_at` is Airtable's transaction time.

04 writes "PREVIEW APR-…" on a row only after an Airtable Prepare on that row returns `PREVIEW_READY` or
`ALREADY_PENDING`; every other outcome overwrites that text. The dashboard and the Copilot prepare through the same
function but never write Airtable (`web/lib/queries.ts` `prepareInvoice`).

Before the fix (PGlite; the same on Postgres 17), each of these approved an invoice (`expected 'APPROVED' not to be
'APPROVED'`):

| Test | Scenario | Before the fix |
|---|---|---|
| `:68` | PRJ-2026-0005 is prepared in Airtable ($17,831.91 shown). A variation makes it stale, so Approve cancels it and the row says "stale". The Copilot prepares again ($18,821.91, never shown in Airtable). The approver presses Approve again | **APPROVED $18,821.91**: a FINAL invoice and a queued Xero draft for an amount never shown |
| `:98` | PRJ-2026-0004's row shows its preview. On PRJ-2026-0002's row, the Project Number cell is edited to PRJ-2026-0004, then Approve | **PRJ-2026-0004's invoice approved** from another project's row |
| `:117` | The approver's click is at T. A Prepare on the same row is processed afterwards (04 runs every Prepare of a batch before any Decide), then the Approve | **APPROVED** a preview created after the click |
| `:129` | A decision from a non-Airtable source naming no approval, and one with a wrong payload hash | Approved (the second never ran: the first consumed the approval) |

The guards `:85` (a Copilot preview shown on the row by an Airtable Prepare, then approved) and `:108` (prepared
and approved from its own row) passed before the fix and pass after it.

### 2. Classification: a true bug

- **Not a test artifact.** The events are 04's real shape, and the Copilot path is the real `prepareInvoice`. Each
  trigger is ordinary: re-preparing in the Copilot after a stale preview, a mis-typed Project Number, or two quick
  actions on one row.
- **Not intended behaviour.** The approval model (`approvals.payload_hash`) exists so that what a person approved is
  exactly what executes. A decision that picks "whatever is pending now" defeats it, and it moves money: a FINAL
  invoice and a Xero draft.

### 3. The first incorrect state transition

`approvals.status` PENDING → EXECUTING for an approval the approver never saw, in `wf_invoice_decide_core`
(`supabase/migrations/20260929000800_xero_draft_invoice.sql:344-348`):

- the project is looked up by `payload.project_number`;
- the approval chosen is `order by (a.status = 'PENDING') desc, a.created_at desc limit 1`.

The FINAL invoice and the `xero.create_draft_invoice` outbox row follow in the same transaction.

### 4. Why the architecture permitted it

- **The decision named nothing.** 04 sends no approval number or hash. The only binding was "the newest pending
  approval for the project named in a text cell".
- **The project came from an editable cell.** The record id, the one field Airtable cannot let a user change, was in
  the payload but unused by the decision. `project_uuid` (the RoofOps ID cell) was checked on prepare but not on
  decide.
- **Nothing recorded what an approver was shown.** Postgres knew which approvals existed, not which one a person had
  seen on which row, or when.
- **Two surfaces prepare, one decides.** The Copilot prepares, but only Airtable can approve, and Airtable never
  shows what the Copilot prepared.

### 5. Invariant

> An approval executes only when the decision identifies what the approver was shown. From Airtable, that means the
> preview a Prepare displayed on the sending row, before the decision, for the project that row is linked to. From
> any other source, it means the approval number, plus the payload hash when one is sent.

### 6. Regression tests (written first, watched fail)

`test/invoice-approval-binding.test.ts`, on PGlite and real Postgres 17. The setup links every project to a
well-formed Airtable record id. Each defect test asserts the specific refusal:

- `nothing_approved: true`;
- no FINAL invoice and no Xero outbox row;
- the pending approval untouched.

The test-only `withdraw` helper resets a project's approvals, bypassing triggers the same way `force` does in
`test/state-integrity.test.ts`, so each guard starts clean.

Existing tests changed their event fixtures only, with no assertion changed:

- **`test/invoice.test.ts`** now sends decisions from the project's own linked record, stamped after the preview
  was shown. It had used one fake record id for every project and a fixed past time.
- **`test/demo.test.ts`** now shows the Copilot's preview on the row with an Airtable Prepare before approving. That
  is the new demo flow.

### 7. Fix (design, not the example)

New migration `supabase/migrations/20261001010000_invoice_decision_bound_to_row_and_preview.sql`. It changes
Postgres only; n8n is unchanged.

1. **`approval_presentations`.** It records where each preview was shown: the Airtable row and the time an Airtable
   Prepare returned it (`PREVIEW_READY` or `ALREADY_PENDING`, redeliveries included; the first showing counts). It is
   recorded only when the row is linked to the approval's project. RLS is on, and neither role can read or write it.
2. **Decisions bind to the sending record.** `wf_invoice_decide` resolves the project from `airtable_record_id`
   through `external_links`, and locks that row. It refuses and approves nothing:
   - an unlinked record: `NOT_FOUND`;
   - a Project Number cell that disagrees with the row: `RECONCILIATION_MISMATCH`;
   - a RoofOps ID cell that disagrees: `RECONCILIATION_MISMATCH`.
3. **Decisions bind to what was shown.** A pending approval can be decided from Airtable only if it was shown on
   that row, and before `occurred_at`. Otherwise the reason 04 writes on the row explains the next step:
   - "…was prepared in the RoofOps dashboard and has not been shown on this row… set Invoice Action = Prepare… to
     show it";
   - or "…was shown on this row only after this decision was made…".
4. **Other sources must name the approval, and a sent `payload_hash` must match.**
5. **The handler is bound.** The chosen approval number and the row's project number are passed to the unchanged
   `wf_invoice_decide_core`, so it cannot pick another approval. Decided (non-pending) approvals still get the
   handler's own idempotent answers.
6. **The field contract** for `approval.status` now states the binding, and `docs/source-of-truth.*` is regenerated.
7. **Copy.** The Copilot's `how_it_gets_approved` text and the demo script (`docs/phase5-status.md`, 5:30) describe
   the two-step Airtable flow: Prepare shows the same preview (no new approval), then Approve.

**Owner decision (2026-10-01).** The fix is Postgres-only, chosen over having n8n 04 pass the displayed approval
number, or having the Copilot write previews to Airtable. Both of those need production n8n changes.

**Known limit.** "Shown" is recorded when Postgres answers the Prepare, while 04 writes the text to the row a second
or two later. A different person's Approve clicked in that window would pass. This needs two people acting on one row
within seconds, and it approves exactly the preview that is now on the row. Closing it fully needs 04 to pass the
displayed approval number (optional hardening).

### 8. Verification (offline)

| Check | Result |
|---|---|
| Red, fix removed | **8 failed**, 4 passed (the two guards on both engines) |
| Ablation A: no record binding | Only `:98` red |
| Ablation B: no "shown on this row" check | Only `:68` red |
| Ablation C: no "shown before the click" check | `:117` red, and `:129`, because the approval `:117` wrongly consumed is gone |
| Ablation D: other sources need not name the approval | Only `:129` red |
| Ablation E: no hash check | Only `:129` red |
| Full suite, PGlite + Postgres 17 | **356 passed**, 33 skipped (baseline 344; +12 = 6 tests × 2 engines) |
| Lint / typecheck | exit 0 / exit 0 |
| Fresh PostgreSQL 17 database, migrated from zero | 21 applied, 0 skipped; import OK; a re-run applied 0 and skipped 21. Checks: integrity 0 FAIL, `approval_presentations` RLS on, contract text updated. The database was then dropped |
| Migration histories | Repo, local and hosted aligned through AC-10 (20 versions). `20261001010000` is unused in git history and on hosted |
| Local dev DB (`npm run db:load` applied only this migration) | `integrity:check -- --local`: 22 PASS, 4 WARNING, 0 FAIL (unchanged) |
| Grants (local) | `roofops_workflow` can execute `wf_invoice_prepare` and `wf_invoice_decide` only. `roofops_dashboard` can execute `wf_invoice_prepare` only. Neither role can execute `…_core`, `airtable_project_for_record` or `invoice_decision_refused`, or read or write `approval_presentations` (RLS on) |

### 10. Hosted deployment and checks (2026-10-01, owner-approved, no repair run)

- **Before the deploy.**
  - Repo, local and hosted aligned through AC-10: 20 versions, identical checksums.
  - `20261001010000` has one repo file, is absent from git history and hosted, and is later than every applied
    version.
  - Value fingerprint: 173 values, `89d72adf…`.
- **`npm run db:load -- --hosted`** applied `20261001010000_invoice_decision_bound_to_row_and_preview.sql` alone
  (skipped 20).
  - The hosted checksum equals the repo file (`b7df8f4a…`).
  - The fingerprint is unchanged.
  - Grants on hosted are identical to local (§8).
- **Dry-run** `RECON-20261001-075036-0c4e`: Airtable 231 checked, 0 drift; Drive 3/3 and Xero 1/1 without drift; all
  webhooks 0 unread.
- **Integrity:** 23 PASS, 3 WARNING (unchanged), 0 FAIL, with `hash_chain_intact` passing.
- **Security:** every check passes. `wf_invoice_prepare` is still the dashboard's only write entry point.

### 11. Controlled live verification (PRJ-2026-0005, refusal paths)

| Step | Observed |
|---|---|
| Baseline | COMPLETED, no pending preview, demo 04 READY. The Airtable row's Invoice Status, Amount and Preview were all blank |
| The Copilot (the real web app `/api/copilot`): "Prepare invoice for PRJ-2026-0005" | `prepare_invoice` created **APR-2026-0009** (PENDING, $17,831.91, source `roofops-dashboard`). No presentation was recorded; the Airtable row stayed blank |
| Airtable: Invoice Action → Approve on that row (txn88; 04 execution 1929) | **Refused.** `INVALID_STATE`: "APR-2026-0009 ($17,831.91 inc GST) was prepared in the RoofOps dashboard and has not been shown on this row. Nothing was approved; set Invoice Action = Prepare…". There was no FINAL invoice and no Xero outbox row, and APR-2026-0009 stayed PENDING. Exception EXC-0018 was opened. 04 wrote "Not eligible" and the reason on the row. Before AC-03, this Approve would have created an invoice and a Xero draft for a preview the approver never saw |
| Airtable: Invoice Action → Prepare (txn90; 04 execution 1934) | `ALREADY_PENDING`. The row shows "PREVIEW APR-2026-0009", "Awaiting approval", $17,831.91: the Copilot's preview, with **no new approval**. A presentation was recorded (`recyDSiQ5Ot1tdbVu`, 21:54:23Z) |
| Approve after that (optional) | **Not done.** It would create a real Xero Demo Company draft, and the owner did not ask for one. The guard `:85` covers it offline |
| `npm run demo:reset` | Withdrew APR-2026-0009 (audited). Demo 04 READY |
| Dry-run `RECON-20261001-075518-c2e2` | 1 drift: Invoice Status "Awaiting approval", expected blank. `demo:reset` withdraws in Postgres only, which is pre-existing behaviour, not AC-03. The row was put back to its pre-test blanks through the Airtable API, with no repair run; 06 applied nothing (execution 1938) |
| The dashboard and the Copilot | "Ready to invoice", nothing awaiting approval, no out-of-sync notice |
| Final | Dry-run `RECON-20261001-075720-4f7b`: 0 drift, all webhooks 0 unread. Integrity 0 FAIL, with the hash chain intact. Fingerprint `89d72adf…`, unchanged. Audit since the test: the preview prepared, then withdrawn; **no `approval.approve`**. All 9 n8n executions succeeded |

**Open items (owner).**
- **EXC-0018** (the live refusal) is still OPEN. It truthfully records a refused decision, and there is no
  staff-facing path to resolve invoice-rejection exceptions, so it was not edited directly.
- **`demo:reset`** should also clear, or let reconciliation repair, the Airtable invoice projection it leaves stale.
  This is a follow-up.

### 12. Plan as approved (carried out as §10–§11)

1. **Deploy.** Apply `20261001010000_…` alone to hosted. Then run `npm run reconcile -- --dry-run`,
   `npm run integrity:check` and `npm run security:check`, with no repair run.
2. **Controlled live test, refusal paths only** (approving creates a real Demo Company draft, so that step is the
   owner's choice). On the demo project PRJ-2026-0005:
   1. Copilot: "Prepare invoice for PRJ-2026-0005" (a pending preview; Airtable does not show it).
   2. Airtable: Invoice Action → Approve on the PRJ-2026-0005 row. Expected:
      - refused "…has not been shown on this row…";
      - no FINAL invoice and no outbox row;
      - the approval still PENDING;
      - the row shows the reason.
   3. Airtable: Invoice Action → Prepare. Expected: `ALREADY_PENDING`; the row shows the same APR number and amount;
      a presentation is recorded.
   4. Optional, owner's call: Approve. This creates one Demo Company draft, exactly the shown preview.
   5. Otherwise `npm run demo:reset` withdraws the pending preview. Then run the dry-run and integrity checks
      (`hash_chain_intact`).
3. **Commit:** migration, tests, contract docs, Copilot text, demo script and ledger, separately from other defects.
