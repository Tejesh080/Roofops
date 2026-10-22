# AC-13B offline verification (pre-start gate before work starts)

Status: **Fixed offline**. Live verification is pending. Nothing hosted was touched: no migration, deploy, publish,
reconcile, dispatch, Airtable write, Twilio, Xero or Drive call. Everything below ran locally: PGlite, the local Postgres 17
container (throwaway databases), and a restored copy of a hosted backup (§3g). The only live access was read-only (Airtable schema, §4).

Branch `feature/advanced-ac13b-pre-start-gate`. Nothing is committed; the work is in the working tree.

## 1. Red before the migration

The WIP tests were brought in unchanged (`test/pre-start-gate.test.ts`, `test/n8n-pre-start-fields.test.ts`) and run
before any migration or n8n change existed.

```
npx vitest run test/pre-start-gate.test.ts test/n8n-pre-start-fields.test.ts
 Test Files  2 failed (2)
      Tests  18 failed | 2 passed (20)
```

- Gate file, 16 tests: 14 red, as the WIP recorded. Case 15 (invalid orderings) and the imported-project case already
  held before the fix.
- n8n file, 4 tests: 4 of 4 red.

## 2. Rebase table (migration `20261022000000_pre_start_gate_before_work_starts.sql`)

The WIP migration was written against `98729f3`. Its migration number `20261001130000` collides with an applied file
(`20261001130000_xero_verified_void_is_not_an_integrity_failure.sql`), so it is ported as `20261022000000`, after the
head `20261017060000_quote_publish_lifecycle.sql`. For each function the body is the latest definition in
`supabase/migrations` with only the pre-start delta applied. The live definitions at head were checked against these
sources (`prosrc` equality) before any change.

| Function / object | Latest source (highest version that defines it) | Pre-start delta |
|---|---|---|
| `checklist_apply_change` | `20261001110000_completion_gate_has_a_supported_path.sql` | SWMS / Materials labels; the project row is locked `FOR UPDATE` first (review fix, §2b); PRE_START locked once work started (or On Hold / Completed); "Done only once work has started" now applies to every item except PRE_START (was COMPLETION only before review, §2b); `checklist.not_waivable` refuses Waived / Not applicable for SWMS |
| `project_apply_change` | `20261001110000_completion_gate_has_a_supported_path.sql` | new branch for `swms_signed` and `materials_reviewed`, note read from `fldNcsIgH6TfQFfaU` / `fldEtAmAokIvtzJdn` |
| `v_airtable_expected` (view) | `20261017000000_airtable_shows_dashboard_approved_invoice.sql` | two projection lines, SWMS Signed `fldM6kgPz6QZagPAC` and Materials Reviewed `fldozWSCU877wEZHq` (blank where the project has no such item) |
| `v_dashboard_project_checklist` (view) | `20261017010000_site_visits_and_tasks.sql` | review fix (§2b): "Materials reviewed and approved" follows its completed material-review task only once work has started; before that the canonical item decides. Same columns and grant |
| `project_transition_guard` | `20261001120000_xero_verified_invoice_settlement.sql` | `IN_PROGRESS` from `SCHEDULED` (the old row's status, not Actual Start: review fix, §2b): every required PRE_START item Done / Waived / Not applicable, else refused |
| `integrity_check` | `20261017030000_release_blockers.sql` | new row `started_with_pre_start_open` (FAIL) appended to the release-blockers wrapper |
| `field_contract` (4 rows) and `checklist` / `items` text | `20261001110000` for the checklist row | rows for `swms_signed`, `swms_signed_note`, `materials_reviewed`, `materials_reviewed_note`; checklist row text updated |
| `app_settings` `checklist.not_waivable` | none (new key) | `SWMS_SIGNED` |

Why `integrity_check` is not the WIP body: the WIP copied an older wrapper that calls `integrity_check_core()` directly.
The release-blockers migration renamed that wrapper and added `done_has_proof`, `claimed_and_abandoned` and
`business_date`. A WIP copy would have silently dropped those three checks. The port takes the latest wrapper and adds
the one new check.

Grants: `CREATE OR REPLACE` keeps each function's and view's existing owner and ACL (checked against `pg_proc.proacl`
at head). The migration restates no grant. The WIP's blanket `revoke execute on all functions ... from public` was not
carried over: it is not needed and the latest migrations do not re-issue it per change.

### 2b. Independent review of the port, and what was fixed

Two reviewers read the migration against the latest definitions, and the rules against the tests and n8n. No finding was
CRITICAL or HIGH. Each MEDIUM or LOW finding was checked on the code before any change:

| Severity | Finding | Disposition |
|---|---|---|
| MEDIUM | The dashboard card showed "Materials reviewed and approved" Done from a completed material-review task while the canonical item was OPEN, and the gate then refused the start. The 17 October view made the task count as Done. | **Fixed.** `v_dashboard_project_checklist` is redefined (§2): the task counts only once work has started. Started and invoiced jobs keep the 17 October display. Test "the dashboard card follows the canonical item", red when reverted (ablation). |
| LOW | `checklist_apply_change` applied "Done only once work has started" to COMPLETION items only, so an INVOICING item (FINAL_INVOICE_APPROVED) could be Done on a Scheduled job. Unreachable from Airtable today. | **Fixed.** The rule is `stage <> 'PRE_START'`, so every other item keeps its previous rule. Test "only a pre-start item may be Done while Scheduled". |
| LOW | The gate read Actual Start, so a direct update of `actual_start_date` on a Scheduled job, then `status = IN_PROGRESS`, skipped it. Needs owner or operator rights. | **Fixed.** The gate keys on the old row's status `SCHEDULED`. Test "an Actual Start written directly cannot skip the gate", red when reverted (ablation). |
| LOW | Race: a checklist change and a Scheduled → In Progress transition on the same job could both commit (the item lock and the project update did not meet). | **Fixed and proven on Postgres 17** (§3h). Through Airtable both sides already lock the project row in the handler (`wf_airtable_change_core` step 4). Directly (owner SQL, or any future caller of `checklist_apply_change`), they did not: `checklist_apply_change` now locks the project row `FOR UPDATE` first, the lock a project UPDATE takes. Four two-connection tests; removing the lock turns the two direct ones red. |
| LOW | No test for "Not applicable" on Materials Reviewed without a reason. | **Fixed.** Test "6b". |
| LOW | n8n 06 does not forward a Note-only edit (the Note fields are not watched, and the handler reads a Note only with its item). The recorded reason can then differ from Airtable's Note. Same for AC-13A's two Notes. | **Fixed** (§2c): 06 watches the four checklist Notes; a thin `wf_airtable_change` layer applies a Note edited on its own through `checklist_apply_note`. Tests: 8 database cases and 3 n8n cases (one replaces the AC-13A case that pinned the old behaviour). Ablations: 06 without the Notes, and the layer disabled, each turn their tests red. |
| LOW → real | n8n 03 retry: an upsert of an existing record wrote "To do" to the checklist fields. 03's writes are not RoofOps-recorded writes, so the echo came back to 06 as a `publicApi` change by the token owner, who is mapped to EMP-900: it could be applied as an attributed staff edit, turning a staff member's DONE back to OPEN. AC-13B made it reachable: a pre-start item can be Done while the job is still Planning, inside 03's retry window (completion items cannot be Done before work starts). | **Fixed** (§2c): 03 looks the record up first (*Find Existing Project Record*) and writes the four checklist fields only when it creates the record; *Verify* checks them only then. Tests: lookup wiring, a retry onto an existing record writes no checklist value, a failed lookup is a recorded failure, Verify accepts staff values on an existing record. Ablation: always writing turns the retry test red. |

Also checked by the rollback round trip (§3f): the rollback restores every function, view, field-contract row and setting
it changes, byte for byte.

### 2c. The two documented LOW risks, resolved (2026-10-22, second pass)

**Note-only edits (migration section 8, n8n 06).**
- 06 now also watches the four checklist Notes: `fldA77ad94yUmvnu3`, `fldLi9FkGDFAbf0QB`, `fldNcsIgH6TfQFfaU`,
  `fldEtAmAokIvtzJdn`.
- The handler is not redefined. `wf_airtable_change` is renamed `wf_airtable_change_before_notes` and wrapped by a new
  `wf_airtable_change`, the same wrap-and-rename pattern as 20260930010000 and 20261001000000. The inner function runs
  unchanged.
- When a Note changed and its item did not, the layer calls `checklist_apply_note`:
  - **Waived / Not applicable item:** the reason is replaced, with the project row locked, a mapped employee required,
    and the same locks as `checklist_apply_change` (Closed / Cancelled; pre-start once work started; final invoice or one
    in flight). The change is audited (`project.checklist.changed`, before and after reason).
  - **Refused** (blank, locked, unattributable): Airtable gets the recorded reason back, and RoofOps Sync says why.
  - **To do / Done item:** a Note is not a reason. Nothing is recorded and nothing is corrected.
  - **Older edit delivered late:** STALE (`external_field_versions` on the Note's field key).
  - **Duplicate delivery:** the stored, merged result is returned.
- The merged outcome is stored in `processed_events`, so a redelivery returns it. `automation_events` follows the
  outcome.
- Privileges: the new entry point keeps the old grant (`roofops_workflow`). The renamed inner function and
  `checklist_apply_note` are for no application role, so the workflow role's executable set is unchanged
  (`test/schema.test.ts`).
- Reconciliation still does not compare Notes: they stay INPUT / IGNORE in the contract.

**03 retries (n8n 03).**
- New node *Find Existing Project Record*, on *Claimed?* case 0, before *Build Project Record*. It is a GET with
  `{RoofOps ID}=<id>`, the field the upsert merges on.
- *Build* writes Completion Photos, Compliance Certificate, SWMS Signed and Materials Reviewed = "To do" only when no
  record exists. On an existing record they are left to staff.
- A failed lookup goes to the existing failure path (retry with backoff). It never writes blind.
- *Verify* checks the four "To do" values only when this attempt wrote them.

## 3. Verification

### 3a. Targeted tests after the port and the review fixes

```
npx vitest run test/pre-start-gate.test.ts test/n8n-pre-start-fields.test.ts test/project-lifecycle.test.ts test/n8n-completion-fields.test.ts test/xero-reissue-lifecycle.test.ts
 Test Files  5 passed (5)
      Tests  48 passed (48)
```

The gate file has 20 cases (16 from the WIP, 6b and three review regressions); the ablations in §2b each turn their own
case red, and the migration was restored byte for byte after each ablation.

Second pass (§2c, §3h), on both engines (`TEST_DATABASE_URL` = the local Postgres 17 container; each suite makes and drops
its own throwaway database):

```
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest run test/pre-start-gate.test.ts test/n8n-pre-start-fields.test.ts test/n8n-completion-fields.test.ts
 Test Files  3 passed (3)
      Tests  90 passed (90)
```

The gate file now has 28 cases per engine (the 20 above plus 8 Note-only cases) and the four Postgres-only race cases.

| Ablation (file restored byte for byte after each) | Red |
|---|---|
| A1: `checklist_apply_change` without `FOR UPDATE` on the project | both direct race cases (2 of 4) |
| A2: 06 without the pre-start Note fields | both n8n Note-only cases (2 per engine) |
| A3: 03 Build always writes the checklist | the retry case (1 per engine) |
| A4: the Note layer returns before handling Notes | all 8 Note-only database cases |

### 3b. Definitions on a fresh database (PGlite)

A fresh PGlite database was migrated to the head (56 migrations), then to the new head (57). The touched definitions
were dumped and compared:

- each of the four functions and the view differs from head only by the intended delta (the diff is the pre-start lines
  listed in §2 and nothing else);
- the rollback file was run on the same database and every function's `prosrc` and the view's `pg_get_viewdef` are then
  identical to head; the field contract text is restored, the four rows and the setting are removed, and
  `schema_migrations` returns to 56;
- after the migration the integrity rules are all present, including `done_has_proof`, `claimed_and_abandoned` and
  `business_date` (the WIP port would have lost them).

### 3c. Contract docs

`npm run contract:export` printed `contract: 102 fields; 10 machines, 105 legal transitions`. The diff against the
committed docs contains the four new PRE_START field rows, the changed `items` row, and two hunks that are **not**
from this change: the *Invoice Preview* row (from `20261017000000`, reconcile `PROJECTION`) and the *material_review*
row (from `20261017010000`, editable in the dashboard). Both migrations were already at head and the committed docs had
not been regenerated since. They were kept because the file is generated and must match the generator. `docs/state-machines.md`
is unchanged.

### 3d. Lint, typecheck, full suite

| Check | Result |
|---|---|
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run typecheck:web` | exit 0 |
| `npm run check` (lint, typecheck, typecheck:web, full suite on PGlite), first pass after the review fixes | exit 0; Test Files 58 passed, 3 skipped (61); Tests 654 passed, 46 skipped (700); 248 s |
| `TEST_DATABASE_URL=… npm run check` (lint, typecheck, typecheck:web, full suite on **PGlite and Postgres 17**), final run after the second pass | exit 0; Test Files 58 passed, 3 skipped (61); Tests **1186 passed**, 36 skipped (1222); 478 s. The 36 skipped need the hosted database (`RUN_HOSTED_TESTS`) |

The full suite before the review fixes was 650 passed (the writer's run). The four cases added in §2b make 654. The 46
skipped are the hosted and live suites, and the Postgres 17 two-connection suites that need TEST_DATABASE_URL.

Earlier in the port, the first full run had 2 failures, both in `test/xero-reissue-lifecycle.test.ts` (VAL-CROSS-001 and
VAL-CROSS-002): the quote-born project PRJ-2026-0031 was refused In Progress, which is the new rule working. Fixed as in §3e.

### 3f. Rollback round trip (PGlite, after the review fixes)

A scratch script (outside the repo) migrated a database to 20261017060000 and snapshotted every public function (definition),
every view (definition), the `field_contract` rows for checklist and project, the `checklist.*` settings and the migration
count. It applied the new migration, then ran the down file, and compared:

- applying the migration changes exactly four functions (`checklist_apply_change`, `integrity_check`,
  `project_apply_change`, `project_transition_guard`) and two views (`v_airtable_expected`, `v_dashboard_project_checklist`),
  plus the field-contract rows and the setting;
- after the down file: functions identical, views identical, field-contract rows identical, settings identical, and the
  migration count is back to 56. The rollback restores exactly the pre-migration state.

Second pass: the snapshot also compares each function's ACL. Applying the migration changes seven functions
(the four above, plus `checklist_apply_note`, the new `wf_airtable_change` and the renamed `wf_airtable_change_before_notes`)
and the same two views; no other function's ACL changes. After the down file everything, ACLs included, is identical.

### 3g. Rehearsal on a restored copy of hosted (local container, scratch database, dropped afterwards)

Source: `D:/Claude/roofops-backups/pre-synthetic-quote-test-20261020-164125.dump` (SHA-256 file checks OK). It holds 49
migrations, hosted as it was before the 17 October migrations. The only restore error is "schema public already exists".

| Step | Result |
|---|---|
| Migrate to today's hosted head (the 7 migrations of 17 October) | applied 7; integrity 28 PASS / 6 WARNING / 0 FAIL |
| Apply `20261022000000` | applied; integrity **29 PASS / 6 WARNING / 0 FAIL**; `started_with_pre_start_open` PASS (0 failing) |
| Jobs the gate holds | exactly PRJ-2026-0031, 0032, 0033 (Planning, both items OPEN) |
| Imported Scheduled jobs (PRJ-2026-0011, 0015, 0019, 0023, 0027) | `project_transition_guard(p, 'IN_PROGRESS')` = null for all: not blocked (no pre-start items) |
| Rows changed by the migration | `app_settings` +1, `field_contract` +4, `schema_migrations` +1; nothing else |
| Down file | functions with ACLs, views, field contract and settings identical to before; 56 migrations; integrity back to 28 / 6 / 0 |
| Re-apply after rollback | applies; integrity 29 / 6 / 0 |

The scratch database and the copied dump were removed from the container afterwards. Hosted live today reads
30 PASS / 4 WARNING (the restored copy predates the 20 October repair and synthetic quote).

### 3h. The checklist / start race on real Postgres 17 (two connections)

`describe.runIf(postgres)` in `test/pre-start-gate.test.ts`. Each case commits for real in its own throwaway database,
on an imported Scheduled project given both pre-start items (signed off through the real Airtable path). Connection A
opens a transaction and acts; connection B acts on the same job; a third connection proves B is waiting on a lock
(`pg_stat_activity.wait_event_type = 'Lock'`); then A commits.

| Case | First (A) | Second (B) | Result |
|---|---|---|---|
| Airtable, checklist first | SWMS → To do | Status → In Progress | B waited; B REJECTED "pre-start items are still open"; SCHEDULED, SWMS OPEN |
| Airtable, start first | Status → In Progress | SWMS → To do | B waited; B REJECTED "the pre-start checklist is locked"; IN_PROGRESS, SWMS DONE |
| Direct, start first | `update projects set status = 'IN_PROGRESS'` | `checklist_apply_change(…, 'To do')` | B waited (the new lock); B refused "locked"; integrity `started_with_pre_start_open` PASS |
| Direct, checklist first | `checklist_apply_change(…, 'To do')` | `update projects set status = 'IN_PROGRESS'` | B waited; B's UPDATE raised "pre-start items are still open"; SCHEDULED, SWMS OPEN |

Without the lock (ablation A1), both direct cases fail at their first assertion: B does not wait for A. The two
Airtable cases stay green, because the handler's own project lock serialises them.

### 3e. Existing tests changed

Only where the change is the intended new rule. Nothing was weakened or deleted.

- `test/project-lifecycle.test.ts`, case 3 (in progress): sets SWMS Signed = Done and Materials Reviewed = Done before
  Scheduled → In Progress. It previously relied on the bypass.
- `test/xero-reissue-lifecycle.test.ts`, `acceptedProject`: adds SWMS Signed = Done and Materials Reviewed = Done between
  Scheduled and In Progress, and the two field IDs to `F`. The project then reaches COMPLETED as before.
- `test/n8n-completion-fields.test.ts`, the 03 read-back `good` record: now includes SWMS Signed and Materials Reviewed
  = To do, because 03 now verifies them (without this the AC-13A test fails for the new reason).

Second pass:
- `test/n8n-completion-fields.test.ts`, "a Note-only edit is not a checklist change (nothing is sent)" pinned the
  dropped-Note behaviour that this pass fixes. It now asserts the new rule: the event is forwarded, the outcome is NO_CHANGE
  with no corrections, and the item (Done, no reason) is unchanged. Its 03 helper seeds the new lookup (no record yet,
  the case it tested before).
- `test/n8n-pre-start-fields.test.ts`: the same seeds in its 03 helper.

No test asserted a count that changed (no integrity-rule count, migration count or PASS count was in the failing set).
The `started_with_pre_start_open` row is PASS on the fresh PGlite database checked in §3b. Live state is not checked here.

## 4. Contract of the n8n port

- `n8n/06-airtable-changes.sdk.ts`: watches `fldM6kgPz6QZagPAC` (SWMS Signed) and `fldozWSCU877wEZHq` (Materials Reviewed);
  their Note fields travel in "current" as for AC-13A. Second pass: also the four checklist Notes (§2c).
- `n8n/03-airtable-project-writeback.sdk.ts`: writes both fields "To do" on a new record and verifies both on read-back.
  Second pass: *Find Existing Project Record* first; the four checklist fields only on creation (§2c).
- `src/integrations/airtable/schema.ts`, `scripts/airtable-payload.ts`: field IDs and the initial-load payload.

**Airtable, read-only, 2026-10-22** (Airtable connector: `get_table_schema` and a by-name record read on Projects
`tblvUPIoebC3zoacv` in `appMc8V0Wm29tEeHQ`):

| Field | ID | Type | Options |
|---|---|---|---|
| SWMS Signed | `fldM6kgPz6QZagPAC` | single select | To do, Done (no Waived / Not applicable: Airtable itself cannot offer a SWMS waiver) |
| SWMS Signed Note | `fldNcsIgH6TfQFfaU` | long text | — |
| Materials Reviewed | `fldozWSCU877wEZHq` | single select | To do, Done, Waived, Not applicable |
| Materials Reviewed Note | `fldEtAmAokIvtzJdn` | long text | — |
| Completion Photos / Compliance Certificate (AC-13A, for comparison) | `fldbbksVL3dT6cqyS` / `fldf7iJiyHFxOQgUy` | single select | To do, Done, Waived, Not applicable |

The four names resolve exactly (a read by field name succeeds). The labels equal `checklist_at_label` and the values
`checklist_apply_change` accepts. No Projects record has SWMS Signed filled yet (the fields are inert until 06 is
republished), so PRJ-2026-0031..0033 still need the "To do" fill (runbook step 2).

## 5. Hosted steps awaiting owner approval

Nothing below has been done. Each step needs the owner's go-ahead. The full procedure (backups, order, verification,
live acceptance including the Note cases, rollback by layer) is `ops/ac13b-deployment-runbook.md`; the list below is the
first-pass summary.

1. Fill SWMS Signed and Materials Reviewed = To do on PRJ-2026-0031, PRJ-2026-0032 and PRJ-2026-0033 (one Airtable
   call; imported projects stay blank). Confirm the choice labels in Airtable first.
2. Deploy the migration `20261022000000_pre_start_gate_before_work_starts.sql` alone. Publish n8n 06, then n8n 03.
   Run the dry-run and expect 0 drift, then run integrity and security checks. No repair run.
3. Live test through Airtable on PRJ-2026-0031 (Planning) only after approval:
   - set a Planned Start and Scheduled;
   - try In Progress, which must be refused, and 06 must correct Status back to Scheduled;
   - set SWMS Signed = Done and Materials Reviewed = Not applicable (with a reason), each attributed to a mapped employee;
   - set both back to To do and the status back to Planning, for a net canonical change of none.
   Whether to really start a job is the owner's call, so the live test does not start one.
4. Rollback path if needed: `ops/rollback/20261022000000_pre_start_gate_before_work_starts.down.sql`, owner only. Restore
   n8n 06 to its prior version first, so it stops forwarding the two fields; then run the rollback in one transaction.

## 6. Hosted read-only survey (from the WIP, not re-run)

PRJ-2026-0031..0033: Planning, both items OPEN (latent). No started project has an open pre-start item. 17 imported
projects have no PRE_START items and keep their historical shape (owner decision).

## 7. Open items (not done here)

Resolved in the second pass: the two-connection race test (§3h), Note-only edits (§2c), the 03 retry (§2c), and the
Airtable select labels (§4).

- **Reconciliation does not compare Notes.** A Note-only edit whose webhook payload is lost would not be repaired. Airtable
  keeps payloads for 7 days behind 06's cursor and 07 wakes 06 for unread payloads, so this needs a payload lost for
  longer than that.
- **Hosted:** every step in §5 / the runbook (approval).
- **Contract docs:** `docs/source-of-truth.*` regenerated from the local chain. Its diff also carries two rows from
  earlier migrations (Invoice Preview; material_review), because the committed docs had not been regenerated since.
- **Material-review task** does not satisfy the gate. That follows the owner's rule that Airtable is the editing surface
  for Materials Reviewed. It is a business rule to confirm, not a defect.
