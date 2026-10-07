# AC-14C Part C offline verification: the supervised recovery proved end to end — final evidence and mission close

**FIXED OFFLINE, NOT HOSTED/DEPLOYED.**

Facts and command output only. Nothing in this file was run against a hosted system: no deploy, no migration applied
anywhere hosted, no Xero, Airtable, n8n or Supabase call, no `RUN_HOSTED_TESTS=1`, no credential used beyond the
repository's stored git remote credentials for the phase push. Everything below ran locally: PGlite in-process and the
local Docker container `roofops-postgres` (PostgreSQL 17.11) at `127.0.0.1:54322`.

- Defect: AC-14C in [docs/defect-ledger.md](../docs/defect-ledger.md). A RoofOps final invoice whose Xero document was
  legitimately VOIDED or DELETED was a dead end: the invoice stopped being collectible while the customer still owed
  the job, and nothing could bring it back.
- Root cause (all three parts): `xero_settlement_status('DELETED')` returned NULL so a verified deletion changed
  nothing (Part A); `v_invoice_balances` still reported the voided invoice's full total (Part B1b); and there was no
  explicit, audited, human path to make the same canonical invoice collectible again, nor any database guard stopping
  raw SQL from flipping `VOIDED → APPROVED` without evidence (Part B2).
- Invariant added (whole mission): **a voided or deleted final invoice is never collectible, never a dead end, and
  becomes collectible again only through a supervised reissue** — a FINANCE/ADMIN request with a meaningful reason, a
  fresh approval bound to the exact invoice, state, preview hash, record version, target generation and tenant, the
  void proof from the exact linked Xero InvoiceID in its bound tenant, no money moved and no live write — which opens
  exactly one new Xero draft generation for the *same* invoice row (same invoice number, one canonical FINAL invoice
  per project, ever) with new idempotency identity; the old generation stays in the ledger forever. Nothing is
  automatic: only `ops_reissue_decide` creates generation ≥ 2, and no code path writes to Xero in this mission.
- Starting SHA (the mission's branch point, Part A): `153d87bc43d30ec54377101c201a234d74248f21`.
- Final SHA (the frozen tree this battery ran on, before this feature's docs commit):
  `3a12de441a0a9d40a9d6a6c727b71873963d08aa` ("AC-14C-C: the end-to-end recovery lifecycle is proved on both engines"),
  branch `factory/ac14-integrity-followup`. This feature adds a docs/evidence commit on top plus the sanctioned
  evidence-only follow-up that records the push (§19).
- Migrations (three new files; no applied migration was edited, deleted or re-ordered — §3):
  - `supabase/migrations/20261001150000_one_live_xero_draft_generation.sql` (B1a), SHA-256 `710a22b5db1e…`
  - `supabase/migrations/20261001160000_voided_invoice_has_no_collectible_balance.sql` (B1b), SHA-256 `59e21084532b…`
  - `supabase/migrations/20261001170000_supervised_final_invoice_reissue.sql` (B2), SHA-256 `7f151f9a206a…`
- Tests (all new, all dual engine): `test/xero-generations.test.ts`, `test/balance-read-model.test.ts`,
  `test/xero-reissue.test.ts`, `test/reissue-cli.test.ts`, `test/xero-reissue-lifecycle.test.ts`, plus the committed
  builder `test/helpers/reissue-scenario.ts`. Part C itself is test-only: commit `3a12de4` touches exactly one file
  (`test/xero-reissue-lifecycle.test.ts`, 571 insertions, no production byte).
- Phase commits: B1a `2f3a13b`, B1b `dd9c4c8` + evidence addendum `2900f44`; B2 facility `a19b3dc` + phase close
  `22805d0` + evidence addenda `9ab8efb`/`97394da`; C `3a12de4`; this close (§20).

## 1. What Part C is

Part A made a verified Xero deletion follow the void path. Part B1 made the schema generation-aware and stopped a
voided invoice being collectible. Part B2 built the supervised reissue facility and its operator CLI. Part C proves the
whole thing end to end and closes the mission:

- `test/xero-reissue-lifecycle.test.ts` (commit `3a12de4`, 6 cases × 2 engines = 12 results) drives the full 24-step
  recovery lifecycle for **both** a Xero DELETED and a Xero VOIDED invoice — build → complete → canonical FINAL
  invoice → approve → draft → tenant + InvoiceID bound → verified void/deletion → RoofOps VOIDED → integrity green →
  close refused while money is owed → operator request → fresh approval → decide → new generation → same invoice
  number → old InvoiceID retained → new outbox identity → new draft + readback → exact new InvoiceID bound → verified
  settlement → PAID only from verified Xero settlement → project closes → reconciliation clean — plus the stale-read
  window, the named integrity rules at every stage, the decide-window collectibility, and the close gate
  (`library/c-lifecycle-proof.md` has the case-by-case map).
- The final battery (§6–§9) re-runs everything on the frozen tree, both engines.
- This file, the defect-ledger update, the regenerated contract docs and the README gate close the mission.

Part C changes no production rule, so it has no ablation of its own; the eight pinned invariants' ablation proofs live
in the B1 and B2 evidence files and are summarised in §10.

## 2. Migration summary (and the additive-only proof)

Three forward-only migrations, all additive, applied by the mission's own chain:

| Migration | Part | What it does (one line) |
|---|---|---|
| `20261001150000_one_live_xero_draft_generation.sql` | B1a | `outbox.generation` + the two partial unique indexes (one row per generation; one live draft per invoice), the `invoice_xero_draft_generations` ledger (backfilled, RLS on, owner-only), generation-aware idempotency keys, `outbox_current()`, generation-aware settlement/void/projection/integrity reads |
| `20261001160000_voided_invoice_has_no_collectible_balance.sql` | B1b | `v_invoice_balances`: a VOIDED invoice reports `outstanding = 0`, never overdue, while `project_billing` keeps the debt billable |
| `20261001170000_supervised_final_invoice_reissue.sql` | B2 | `REISSUE_INVOICE` approvals, `invoice.reissue_roles`, the two new transitions (VOIDED non-terminal), the preview/hash, `ops_reissue_request`/`ops_reissue_decide`, the `invoices_reissue_guard` trigger, proof-gated link movement, the tightened `invoice_void_guard` |

Additive-only check (VAL-DOC-003), exact command and output:

```
git diff --name-status 153d87b..HEAD -- supabase/migrations
A       supabase/migrations/20261001150000_one_live_xero_draft_generation.sql
A       supabase/migrations/20261001160000_voided_invoice_has_no_collectible_balance.sql
A       supabase/migrations/20261001170000_supervised_final_invoice_reissue.sql
```

Three added files, zero modified, zero deleted: no applied migration was touched. The frozen bytes of the three files
were re-hashed at the final battery (`710a22b5db1e…`, `59e21084532b…`, `7f151f9a206a…` — identical to the hashes the
phase files froze).

The full diff of the mission's own work (`git diff --name-status 153d87b..HEAD`): `M README.md`,
`M docs/state-machines.md`, `M package.json`, `M scripts/security-check.ts`, `A` the three migrations, `A` the five
new test files + `test/helpers/reissue-scenario.ts` + `scripts/reissue.ts`, `A` the B1 and B2 evidence files. Nothing
else — no unrelated file, no backup, no `.env*`, no scratch file.

## 3. State transitions

Seeded as data by `20261001170000` (both reachable only through the reissue path):

| Machine | From | To | Reachable only through |
|---|---|---|---|
| `invoice` | `VOIDED` | `APPROVED` | `invoice_reissue_guard` + the decide transaction (fresh matching `REISSUE_INVOICE` approval, void proof, no money, no live write) |
| `invoice_sync` | `SYNCED` | `PENDING` | the decide transaction (supervised re-queue) |

`state_machine_states.is_terminal` for `('invoice','VOIDED')` is `false` — a voided invoice is not a dead end. The
generated doc now shows it (§14): `VOIDED --> APPROVED` with the note "AC-14C B2: supervised reissue only -
invoice_reissue_guard() refuses it without a matching REISSUE_INVOICE approval, the void proof and no money movement",
`invoice` "Terminal: none", and `invoice_sync` `SYNCED --> PENDING`. `test/state-integrity.test.ts` stays green
(242 ordered pairs, no terminal escape) on both engines.

## 4. The frozen tree

- Branch `factory/ac14-integrity-followup`, HEAD `3a12de441a0a9d40a9d6a6c727b71873963d08aa`, `git status --porcelain`
  empty before the battery started and after every run.
- No further implementation change was made: the only files this feature creates are documentation/evidence
  (`evidence/ac14c-partC-offline-verification.md`, `docs/defect-ledger.md`, `README.md`) — `npm run contract:export`
  changed nothing (§14).
- Two throwaway analysis scripts were used and deleted before the commit, never staged: `scripts/ac14c-final-probe.ts`
  (the offline privilege replica, §9) and `scripts/ac14c-final-drift.ts` (§12). `git status` is clean of them.

## 5. The complete final battery (exact commands and output)

All runs on the frozen tree `3a12de4`, host date 2026-10-07, PowerShell 5.1, `roofops-postgres` healthy
(`docker inspect --format "{{.State.Health.Status}}"` → `healthy`, server `PostgreSQL 17.11`).

### 5.1 `npm run lint`

```
> roofops@0.1.0 lint
> eslint .

(no output)   exit 0, 11.5 s
```

### 5.2 `npm run typecheck`

```
> roofops@0.1.0 typecheck
> tsc --noEmit

(no output)   exit 0, 3 s
```

### 5.3 `npm test` — PGlite only (`TEST_DATABASE_URL` unset)

```
Test Files  32 passed | 3 skipped (35)
     Tests  370 passed | 36 skipped (406)
  Duration  137.33 s (tests 99%, import 1%)          exit 0
```

(The 3 skipped files are the hosted-only `test/live-phase2|3|6.test.ts`, 27 tests; the extra skip inside
`test/reissue-cli.test.ts` is its real-child-process case, PostgreSQL-only by design.)

### 5.4 `npm test` — PGlite + PostgreSQL 17 (`TEST_DATABASE_URL` set)

```
$env:TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres'
npm test
Test Files  32 passed | 3 skipped (35)
     Tests  707 passed | 36 skipped (743)
  Duration  254.89 s (tests 99%)                     exit 0
```

Every database suite ran on both engines; each PostgreSQL case built and dropped its own throwaway database.

### 5.5 `npm run check` — lint + typecheck + the full dual-engine suite in one run

```
$env:TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres'
npm run check
> npm run lint && npm run typecheck && npm test
> eslint .            (clean)
> tsc --noEmit        (clean)
Test Files  32 passed | 3 skipped (35)
     Tests  707 passed | 36 skipped (743)           exit 0, 275 s wall
```

### 5.6 Targeted AC-14B and AC-14C-A regression suites (both engines)

```
$env:TEST_DATABASE_URL='…:54322/postgres'
npx vitest run test/xero-settlement.test.ts test/invoice-void.test.ts
Test Files  2 passed (2)
     Tests  62 passed (62)                           exit 0, 118.83 s
```

`test/xero-settlement.test.ts` (54 results) contains the AC-14B cases 15–20 (the verified void is not an integrity
failure) and the AC-14C-A cases 21–26 (a verified deletion follows the void path, including the money-moved refusal
and the wrong-tenant / wrong-InvoiceID negatives); `test/invoice-void.test.ts` (8 results) is the AC-05 safety net
that must keep failing invalid states.

### 5.7 All new B1/B2/C suites (both engines)

```
$env:TEST_DATABASE_URL='…:54322/postgres'
npx vitest run test/xero-generations.test.ts test/balance-read-model.test.ts test/xero-reissue.test.ts \
  test/reissue-cli.test.ts test/xero-reissue-lifecycle.test.ts
Test Files  5 passed (5)
     Tests  103 passed | 1 skipped (104)             exit 0, 118.42 s
```

In the full dual run the same files report: `test/xero-generations.test.ts` 26 tests, `test/balance-read-model.test.ts`
16, `test/xero-reissue.test.ts` 38, `test/reissue-cli.test.ts` 12 (1 skipped on PGlite), `test/xero-reissue-lifecycle.test.ts`
12. Assertion coverage per file: VAL-GEN-001…011 (B1a), VAL-BAL-001…007 + characterization (B1b),
VAL-RIS-001…018 + preview (B2), VAL-CLI-001…003 (B2 close), VAL-CROSS-001…005 + VAL-BAL-006 (C).

### 5.8 The two-connection concurrency case

`VAL-RIS-010` runs on PostgreSQL inside `test/xero-reissue.test.ts`: two genuinely simultaneous `ops_reissue_decide`
calls on two connections of the same database. Observed in the final dual run (both engine variants green):

```
✓ VAL-RIS-010 two simultaneous decisions: exactly one queues, the loser refuses, and no partial state is left
   (pglite: 3018 ms — asserts the single-connection engine and returns; postgres: 2471 ms — the real race)
```

Exactly one `REISSUE_QUEUED`; the loser refuses with `ALREADY_PROCESSED` or `APPROVAL_NOT_PENDING`; one new
generation, one superseded predecessor, one new outbox row, one audit event, one `processed_events` consumer; no
partial state. Its ablation (B2 §19 A4) proves the lock + idempotency claim are what prevent the loser from dying with
a duplicate-key error.

## 6. Fresh migration chain from zero

```
docker exec roofops-postgres dropdb -U postgres --if-exists ac14c_final_zero
docker exec roofops-postgres createdb -U postgres ac14c_final_zero
$env:DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/ac14c_final_zero'
npx tsx scripts/db-load.ts
 → migrations applied: 20260929000000_core_schema.sql … 20261001170000_supervised_final_invoice_reissue.sql (skipped 0)
 → imported batch a4bf80e2-6953-4589-8fa5-f8a7325b53ef (dataset 0dd5b61419f7…)
 → projects 30, invoices 38
 → executive KPIs as of demo date printed; exit 0, 5.3 s total for both runs
npx tsx scripts/db-load.ts          # second run, idempotency
 → migrations applied: none (skipped 38)
 → dataset 0dd5b61419f7… already imported (batch a4bf80e2-…); nothing to do
```

Verification on the fresh database:

```
select count(*) from schema_migrations                                    → 38
select version from schema_migrations order by version desc limit 1       → 20261001170000_supervised_final_invoice_reissue.sql
projects 30 | invoices 38 | invoice_xero_draft_generations 0 | outbox draft writes 0 | xero_invoice_observations 0 | external_links 0
```

Honest note on the ledger backfill: on a from-zero chain the ledger is **0 rows** because the dataset is imported after
the migrations, so there is no pre-migration draft-write history to backfill. The backfill's non-vacuous proof is
VAL-GEN-001 (B1 evidence §5: six fixture writes across every outbox status map exactly, a rerun inserts nothing), and
the migration ran again over a database that *does* have 34 migrations of history in §12 (the persistent demo
database), where it applied cleanly and inserted 0 rows because that dataset has no draft-write outbox rows either —
both facts are stated rather than glossed over.

## 7. Integrity

```
DATABASE_URL=…/ac14c_final_zero npm run integrity:check -- --local
 → 26 PASS, 5 WARNING, 0 FAIL  (local database)     exit 0
```

The five warnings are the dataset's known ones (an accepted quote without a project, unlinked Airtable projects, no
reconciliation yet, one open workflow exception, one completed job whose completion items are still open). The
AC-14C-relevant rules are green on the fresh chain: `voided_invoice_has_no_xero_write` (with the verified-void/deletion
exemption), `done_has_proof` (current generation only), `xero_link_only_when_synced` (superseded generations are
history), `xero_invoice_state_verified`, `final_invoice_settles_entitlement`, `closed_project_settled`,
`one_final_per_project`. The lifecycle suite asserts the same rules at every stage of the recovery
(VAL-CROSS-004). The refreshed persistent demo database reports the same 26 PASS / 5 WARNING / 0 FAIL (§12).

## 8. Security and grants

Two pieces of evidence, both offline (VAL-RIS-014; `npm run security:check` is hosted-only and was never run):

**(a) The extended script's diff** (`git diff 153d87b..HEAD -- scripts/security-check.ts`): 24 insertions, one file
changed, and nothing else — a `REISSUE` name list plus six new read-only assertions (`reissue functions: executable by
an app role / by PUBLIC / pinned search_path / SECURITY DEFINER (except the void trigger)`, `draft-generation ledger:
row level security / readable by an app role`). No existing assertion was changed.

**(b) A throwaway privilege replica** (`scripts/ac14c-final-probe.ts`, run against the fresh chain of §6, deleted
before the commit): the same assertions plus the script's pre-existing privilege checks, against a local database:

```
PASS  dashboard role: readable tables                []
PASS  dashboard role: SECURITY DEFINER functions     ["app_today","at_link","integrity_check","invoice_final_preview","project_left_to_bill_after_final","project_over_billing","sm_label","wf_invoice_prepare"]
PASS  dashboard role: can it write via wf_* (other than prepare)? []
PASS  workflow role: executable functions            21 items
PASS  anon/authenticated: readable or writable objects []
PASS  functions executable by PUBLIC                 []
PASS  tables without row level security              []
PASS  reissue functions: executable by an app role   []
PASS  reissue functions: executable by PUBLIC        []
PASS  reissue functions: pinned search_path          []
PASS  reissue functions: SECURITY DEFINER (except the void trigger) ["invoice_void_guard"]
PASS  draft-generation ledger: row level security    ["invoice_xero_draft_generations:on"]
PASS  draft-generation ledger: readable by an app role []
N/A-LOCALLY (hosted config)  Xero writes pinned to the proven Demo tenant   [""]
N/A-LOCALLY (hosted config)  reconcile trigger token stored only as a hash   ["0"]

all local privilege checks pass                     exit 0
```

The two `N/A-LOCALLY` lines are the hosted script's environment-configuration assertions: the local dataset leaves
`xero.demo_tenant_id` and `reconcile.trigger_token_sha256` empty (both values exist only in the hosted deployment), so
they can be neither satisfied nor violated here; they are reported, not judged. Every privilege assertion passes:
`ops_reissue_request`/`ops_reissue_decide` and the whole reissue surface are owner-only (`SECURITY DEFINER`,
`search_path = public, pg_temp`, revoked from `roofops_workflow`, `roofops_dashboard` and PUBLIC — the 21-function
workflow allow-list is unchanged), and the `invoice_xero_draft_generations` ledger has RLS enabled with no access for
either application role.

## 9. Ablation evidence (the eight pinned invariants)

Each ablation was applied to the *new* (uncommitted) migration, its targeted tests shown red on both engines, the file
restored byte-identical against its frozen SHA-256, and the same tests re-run green. Nothing broken was ever
committed. Part C changes no production rule, so it contributes no new ablation; the eight invariants the brief names
are all covered:

| # | Invariant | Ablation (applied change) | Red test | Where |
|---|---|---|---|---|
| 1 | one-live protection | B1a: unique index → plain index | VAL-GEN-003 (2 failed) | B1 §7 (i) |
| 2 | generation-aware idempotency | B1a: key helper returns the generation-1 key for every generation | VAL-GEN-005 (2 failed) | B1 §7 (ii) |
| 3 | historical Xero ID preservation | B1a: backfill `on conflict do nothing` → `do update set …` | VAL-GEN-001 + VAL-GEN-006 | B1 §7 (iii) |
| 4 | collectible balance on a VOIDED invoice | B1b: the `VOIDED → 0` branch removed | VAL-BAL-001/002/003/004 (8 failed) | B1 §7 (iv) |
| 5 | (the wrong rule) any DELETED read zeroes the row | B1b: `exists (settlement='DELETED')` branch | VAL-BAL-005 + 002/003/004 (10 failed) | B1 §7 (v) |
| 6 | payment/credit refusal | B2: Xero-side money read disabled (`and false`) | VAL-RIS-008 (`REISSUE_REQUESTED` instead of `PAYMENT_EXISTS`) | B2 §9 A1 |
| 7 | fresh-approval binding | B2: the guard accepts any approval status | VAL-RIS-012 (expired probe hit the void-proof branch) | B2 §9 A2 |
| 8 | tenant binding of the void evidence | B2: the latest-read tenant check disabled | VAL-RIS-007 (`REISSUE_REQUESTED` instead of `TENANT_MISMATCH`) | B2 §9 A3 |
| 9 | concurrent reissue | B2: `for update` lock dropped **and** the idempotency claim made unconditional | VAL-RIS-010 on PostgreSQL (loser died with `duplicate key … processed_events_pkey`) | B2 §19 A4 |

Every revert was verified with `Get-FileHash -Algorithm SHA256` against the frozen migration hash; no ablation file was
ever committed (`git status` clean after each).

## 10. Test counts across the mission (both engines, 0 failed at every step)

| Point | Files (passed | skipped) | PGlite tests | Dual-engine tests |
|---|---|---|---|
| Baseline `153d87b` | — | 319 passed / 35 skipped | 604 passed / 35 skipped |
| B1 close (`2900f44`) | 29 | 3 (32) | 340 passed / 35 skipped | 646 passed / 35 skipped |
| B2 close (`97394da`) | 31 | 3 (34) | 364 passed / 36 skipped | 695 passed / 36 skipped |
| **Final battery (`3a12de4`)** | **32 | 3 (35)** | **370 passed / 36 skipped (406)** | **707 passed / 36 skipped (743)** |

Growth is exactly the mission's own test files: B1 +42 results (13×2 generations + 8×2 balance), B2 +51 (19×2 reissue +
6×2 CLI, one a PGlite skip), C +12 (6×2 lifecycle). Nothing was removed, skipped or weakened: the 3 skipped files are
the hosted-only live suites (27 tests) and the 1 PGlite skip is the CLI's real-child-process case.

Honest consolidation note for the phase files: `evidence/ac14c-partB1-offline-verification.md` recorded the PGlite
close as 340/35 and `evidence/ac14c-partB2-offline-verification.md` as 364/36 and 695/36 dual; those were correct at
their phase closes and are left as the as-captured records, with a pointer note added to each pointing here. The
difference to today's numbers is Part C's one new file (+12 results), not a re-measurement.

## 11. The persistent local demo database (mission item 8)

The `roofops` database was stale: 34 migration rows, head `20261001130000_pre_start_gate_before_work_starts.sql`, none
of the B1/B2 objects, so `npm run integrity:check -- --local` could not exercise the new rules and `npm run reissue`
would have failed there. It was refreshed with the documented idempotent loader, after a read-only safety analysis and
a full backup.

**Safety analysis first** (throwaway script `scripts/ac14c-final-drift.ts`, deleted; output captured):

```
schema_migrations rows: 34
repo migration files:   38
applied and in repo:    33
applied, NOT in repo:   1 ["20261001130000_pre_start_gate_before_work_starts.sql"]
in repo, NOT applied:   5
   would apply: 20261001130000_xero_verified_void_is_not_an_integrity_failure.sql
   would apply: 20261001140000_xero_deletion_follows_the_void_path.sql
   would apply: 20261001150000_one_live_xero_draft_generation.sql
   would apply: 20261001160000_voided_invoice_has_no_collectible_balance.sql
   would apply: 20261001170000_supervised_final_invoice_reissue.sql
checksum drift:         0 []
VERDICT: migrate() would apply the pending files and skip the rest (no drift).
```

Two facts this exposed, stated plainly:

1. **The demo database was migrated from the parked local branch `backup/pre-factory-local-work`** (commit `491f1da`,
   local and on origin): its `20261001130000` is a local-only WIP pre-start gate, a *different file at the same version
   number* as the repo's `20261001130000_xero_verified_void_is_not_an_integrity_failure.sql`. There was no checksum
   drift (all 33 shared files byte-match the repo), so the loader applies the repo's five pending files and leaves the
   local-only row recorded (39 rows after; two rows share the `20261001130000` prefix, by filename).
2. **A full backup was taken before touching anything**:
   `docker exec roofops-postgres pg_dump -U postgres -d roofops -Fc -f /tmp/roofops-pre-ac14c-final.dump` (exit 0) and
   copied to `%TEMP%\roofops-pre-ac14c-final.dump` (721,340 bytes). The pre-refresh state was restored from it into a
   throwaway database (`roofops_pre_ac14c_before`) purely to read the exact before/after integrity key sets; that
   throwaway was dropped afterwards. The dump remains the restore path.

**Before → after:**

| | Before (stale) | After (refreshed) |
|---|---|---|
| `schema_migrations` rows | 34 | **39** (34 + the 5 applied; the local-only WIP row is retained) |
| Head | `20261001130000_pre_start_gate_before_work_starts.sql` (local-only) | `20261001170000_supervised_final_invoice_reissue.sql` |
| B1/B2 objects | none | ledger table + `ops_reissue_*` + the new transitions, `invoice.reissue_roles = FINANCE,ADMIN` |
| `npm run integrity:check -- --local` | 27 PASS / 5 WARNING / 0 FAIL (32 checks) | 26 PASS / 5 WARNING / 0 FAIL (31 checks), exit 0 |
| Data | 30 projects, 38 invoices | unchanged: 30 projects, 38 invoices, 0 approvals, 0 outbox draft writes, ledger 0 rows |

Loader output (exact):

```
$env:DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/roofops'
npx tsx scripts/db-load.ts
 → migrations applied: 20261001130000_xero_verified_void_is_not_an_integrity_failure.sql, 20261001140000_xero_deletion_follows_the_void_path.sql, 20261001150000_one_live_xero_draft_generation.sql, 20261001160000_voided_invoice_has_no_collectible_balance.sql, 20261001170000_supervised_final_invoice_reissue.sql (skipped 33)
 → dataset 0dd5b61419f7… already imported (batch 734c8bd7-…); nothing to do
   exit 0, 1.8 s
```

The before/after integrity key sets differ by exactly one line: `PASS started_with_pre_start_open` (the local-only WIP
migration's check inside `integrity_check()`) is no longer present, because the repo chain's
`20261001130000_xero_verified_void_is_not_an_integrity_failure.sql` replaces `integrity_check()` and the repo chain
does not define that check (AC-13B is not started). The WIP work itself is untouched and preserved in git (commit
`491f1da` on `backup/pre-factory-local-work`, local and origin) and in the backup dump above; the ledger's ENV-01
precedent (repo migrations win; local-only work preserved as evidence) is followed. The ledger-row count after the
refresh is 0 because the imported dataset has no `xero.create_draft_invoice` outbox rows to backfill — the backfill's
non-vacuous proof is VAL-GEN-001.

CLI smoke on the refreshed database (proves the operator path now works there, and that refusals change nothing):

```
$env:DATABASE_URL='…/roofops'
npm run reissue -- request --invoice INV-2026-0004 --by EMP-900 --reason "checking the refreshed demo database"
 → {"ok":false,"code":"NOT_FINAL_INVOICE","detail":"INV-2026-0004 is not the canonical RoofOps-origin FINAL invoice of its project (IMPORT, , key none); …"}   exit 2
npm run reissue -- request --invoice INV-2026-0004 --by EMP-001 --reason "checking the refreshed demo database"
 → {"ok":false,"code":"ACTOR_UNAUTHORIZED","detail":"EMP-001 is not an active RoofOps employee in a role that may reissue a final invoice (FINANCE,ADMIN)"}   exit 2
npm run reissue -- request --invoice INV-2026-0039 --by EMP-900 --reason "checking the refreshed demo database"
 → {"ok":false,"code":"NOT_FOUND","detail":"00000000-0000-0000-0000-000000000000 does not exist"}   exit 2
```

(INV-2026-0039 is not part of the imported dataset — the demo invoice numbers are INV-2026-0001…0038 — so the CLI's
number lookup refuses; approvals and ledger rows stayed 0 through all three refusals.) The refreshed database now
satisfies the README's documented `DATABASE_URL` default and can be used for `npm run reissue` and
`npm run integrity:check -- --local` as documented.

## 12. The supervised reissue path and the README gate (VAL-DOC-005)

`README.md` (as of the B2 close) already documents the two-step supervised reissue and the CLI, and this feature adds
the AC-14C status. Current state of the documentation an operator sees:

- §"🧾 The supervised reissue CLI": what it does (a final invoice whose Xero document was legitimately voided or
  deleted is not collectible but the customer still owes the job; a FINANCE or ADMIN employee brings the *same* invoice
  back with two explicit, audited steps), the exact commands
  `npm run reissue -- request --invoice INV-2026-0004 --by EMP-900 --reason "…"` and
  `npm run reissue -- decide --approval APR-2026-0009 --by EMP-900 --note "…"`, the local `DATABASE_URL` default and
  the non-local-host refusal, the JSON output, the exit codes (0 success, 2 refusal with the canonical code, 1 usage or
  connection), and the safety statement that the CLI holds no rules, writes nothing itself and never calls Xero.
- §"Adversarial testing and a defect ledger" + the Project-status table: updated by this feature to state the AC-14C
  status — a voided/deleted final invoice is fixed offline through the supervised reissue, with the ledger and the
  evidence pointers, and no hosted-verification claim.

`test/reissue-cli.test.ts` pins the documentation contract mechanically (the README and the script usage text must
document both subcommands, the flags and the exit codes; the script must contain no rule logic and no
insert/update/delete/fetch/URL).

## 13. Generated contract docs (VAL-DOC-004)

```
npm run contract:export
 → contract: 98 fields; 10 machines, 105 legal transitions
git status --porcelain
 → (empty)      # no generated file changed
```

The docs were regenerated after the final schema and did not change — B2 had already committed the regenerated
`docs/state-machines.md` (the only generated file that changed in this mission; `docs/source-of-truth.json` and
`.md` are unchanged since `153d87b`). The new transitions are present and verified in the generated file:

```
docs/state-machines.md:103   VOIDED --> APPROVED
docs/state-machines.md:125   | VOIDED | APPROVED | — | AC-14C B2: supervised reissue only - invoice_reissue_guard() refuses it without a matching REISSUE_INVOICE approval, the void proof and no money movement |
docs/state-machines.md:106   Terminal: none. Every pair not listed below is refused (26 of 42 possible changes).   # the invoice machine
docs/state-machines.md       invoice_sync: SYNCED --> PENDING
```

## 14. Git status, remote confirmation and hygiene

Captured after the phase commit and push (§19 has the exact push output and the final refs):

- `git status --porcelain` → empty; branch `factory/ac14-integrity-followup` tracks
  `origin/factory/ac14-integrity-followup`.
- No backup, scratch, `.env*` or credential file is tracked or committed:
  `git ls-files | rg "backups/|\.env|credential|secret|\.dump|\.patch|\.bak"` → only the pre-existing
  `.env.example`, `web/.env.example` and `n8n/99-credential-check.sdk.ts` (templates and a credential *check* script,
  all tracked long before this mission); `git ls-files .env .env.local backups/` → empty.
- No hosted credential is used or stored anywhere in the mission's work; no secret value appears in any evidence file
  (only key names and the empty local values of §8).
- No external system was touched: the only network traffic in the whole mission was the sanctioned `git push` to the
  repository's own remote and localhost sockets (`127.0.0.1:54322`). No Xero, Airtable, n8n, Drive, Supabase or
  deployment call was made at any point; `RUN_HOSTED_TESTS` was never set; `npm run security:check`, `npm run
  reconcile`, `npm run demo:*` and `npm run ai:eval` were never run.
- The container `roofops-postgres` was already running and healthy at the start of this feature and was left running;
  no other container was started, stopped or touched.

## 15. The parked alias branch (final git hygiene)

The user's directive: delete the parked alias `factory/ac14c-integrity-followup` at the final cleanup, only after
confirming nothing depends on it. Checks performed before deleting (exact commands):

```
git ls-remote origin "refs/heads/factory/*"
  97394daa…  refs/heads/factory/ac14-integrity-followup        # canonical
  2900f44a…  refs/heads/factory/ac14c-integrity-followup       # the parked alias (B1's head)
git ls-remote origin "refs/pull/*"
  (no output)                       # no pull-request refs exist on the remote at all
git merge-base --is-ancestor 2900f44a68d15eb79126ddfb6d70c8f80ae2230f HEAD
  → exit 0                          # the alias's head is an ancestor of the canonical branch: nothing unique is lost
```

- **No open PR/review reference**: `refs/pull/*` is empty on the remote, so no pull request can reference the alias;
  the only references to the alias anywhere are historical records in the B1 and B2 evidence files (as-of-their-phase
  statements) and `library/user-testing.md` (mission artifact, updated by this feature).
- **Nothing in validation/evidence breaks**: the alias's head `2900f44` is fully contained in the canonical branch
  (containment proved above), so deleting the ref destroys no commit; `validation-contract.md` VAL-DOC-001 checks the
  canonical spelling only; the B1/B2 evidence statements remain true as as-captured records and are annotated by this
  file (§15) and the phase files' pointer notes.
- **The alias is not at the canonical branch's current commit** (it is parked at B1's head and never advances) — so
  the literal third condition was met in its safety sense (its content is contained in the canonical branch, no unique
  commit), not literally (it does not point at the current tip). That reading is recorded here explicitly.

Deletion and confirmation:

```
git push origin --delete factory/ac14c-integrity-followup
 → - [deleted]  factory/ac14c-integrity-followup
git ls-remote origin "refs/heads/factory/*"
 → 97394daa… (canonical, unchanged) …  # the alias is gone
```

The alias is deleted; the canonical branch is untouched; the commit `2900f44` remains reachable from the canonical
branch and could recreate the alias in one command if ever needed.

## 16. Completion-report data (the brief's 18 points)

1. **Defect**: AC-14C — a Xero-VOIDED/DELETED final invoice was a dead end (not collectible, no way back, no guard
   against raw SQL). Status: **Fixed offline**; parts A, B1, B2 and C complete.
2. **Starting SHA**: `153d87bc43d30ec54377101c201a234d74248f21`; **final SHA**: `3a12de44…` + this feature's docs
   commit (§19).
3. **Commits**: `2f3a13b` (B1a), `dd9c4c8`+`2900f44` (B1b + addendum), `a19b3dc` (B2 facility), `22805d0`+`9ab8efb`
   +`97394da` (B2 close + addenda), `3a12de4` (C lifecycle), this docs/evidence commit (§20).
4. **Files**: 3 additive migrations; 5 new test files + 1 committed builder; `scripts/reissue.ts`; the extended
   `scripts/security-check.ts`; `package.json` (the `reissue` script); README; regenerated `docs/state-machines.md`;
   3 evidence files; the defect ledger.
5. **Migrations**: three added, zero modified/deleted (`git diff --name-status 153d87b..HEAD -- supabase/migrations`).
6. **State transitions**: `invoice VOIDED → APPROVED` (guard-only), `invoice_sync SYNCED → PENDING`, VOIDED
   non-terminal; visible in the generated doc.
7. **Test counts (final)**: PGlite 370 passed / 36 skipped (406), 32 files passed / 3 skipped (35); PostgreSQL 17 dual
   707 passed / 36 skipped (743); 0 failed; lint and typecheck exit 0; `npm run check` (both engines) exit 0.
8. **New suites**: generations 26, balance 16, reissue 38, CLI 12 (1 skip), lifecycle 12 — all green on both engines;
   targeted AC-14B/AC-14C-A regressions 62 green.
9. **Concurrency**: VAL-RIS-010, two real connections, exactly one winner, no partial state (§5.8), re-confirmed in
   the final dual run; ablation A4 proves the protection.
10. **Ablations**: nine applied → red → byte-identical revert → green across the mission (§9); none committed.
11. **Fresh chain**: 38 migrations from zero, idempotent rerun, integrity 26/5/0 (§6).
12. **Integrity**: fresh chain and refreshed demo database both 26 PASS / 5 WARNING / 0 FAIL; the lifecycle asserts
    the named rules at every stage.
13. **Security/grants**: the security-check extension diff is additive-only; the offline replica passes all privilege
    assertions; the reissue surface is owner-only, the ledger RLS-closed (§8).
14. **Demo database**: refreshed with the documented loader after a no-drift analysis and a backup; before 34 rows /
    27 PASS, after 39 rows / 26 PASS, data unchanged; the one difference (the local-only WIP pre-start check) is
    documented with its preserved sources (§11).
15. **Docs**: contract export run after the final schema (no change needed); README gate met; ledger AC-14C row and
    detail section updated to Fixed offline with the three evidence pointers.
16. **Git**: tree clean; branch tracks origin; remote ref equals the local HEAD after the push (§19); alias deleted
    (§15); no backups/.env/credentials committed; no external system touched.
17. **Evidence**: `evidence/ac14c-partC-offline-verification.md` (this file), `ac14c-partB1-offline-verification.md`,
    `ac14c-partB2-offline-verification.md`, `ac14c-partA-offline-verification.md`, `ac14b-offline-verification.md`.
18. **Unresolved items**: hosted verification is not done and is out of scope by design (nothing was deployed);
    `npm run security:check` remains hosted-only; AC-13B (the pre-start gate) is not started — its local WIP lives on
    the parked `backup/pre-factory-local-work` branch, not in the repo chain.

## 17. Not done / skipped (and why)

- **Hosted verification of any kind**: out of scope by mission boundary. Nothing is deployed; the explicit statement
  below stands.
- `npm run security:check` (hosted-only), `npm run reconcile`, `npm run demo:*`, `npm run ai:eval`: never run.
- The hosted-only live suites `test/live-phase2|3|6.test.ts` (27 tests) are skipped by design (`RUN_HOSTED_TESTS`
  unset).
- No browser surface exists for this mission; the dashboard read models were validated at the SQL/view level.
- `npm run db:reset` was not used on the persistent demo database (it would re-import the dataset destructively); the
  documented idempotent loader was used instead, with a backup taken first.

## 18. Offline statement

**FIXED OFFLINE, NOT HOSTED/DEPLOYED.** Every command in this file ran against local PGlite or the local PostgreSQL
17 container at `127.0.0.1:54322`. No hosted Supabase, Xero, Airtable, n8n or Drive call was made, no credential was
used (beyond the repository's stored git remote credentials for the sanctioned phase push), no deploy and no migration
was applied anywhere hosted, and the only network traffic was the phase push to the repository's own remote. The
whole recovery path — request, fresh approval, decide, new generation, new draft, settlement, close — is reproducible
locally with the repository, Node and a local PostgreSQL; it has never been exercised against a real Xero tenant.

## 19. The phase record on origin (added by the follow-up commit)

The phase commit is `76951d4956ecbaf8dfd0ae25ece603aed5b3ad47` ("AC-14C: the supervised recovery is proved offline and
the mission closes"), on top of the C lifecycle commit `3a12de441a0a9d40a9d6a6c727b71873963d08aa`. It contains this
file plus the defect-ledger, README and B1/B2 pointer-note updates — 5 files changed, 624 insertions(+), 8
deletions(-) — and nothing else.

Alias deletion (per §15, before the commit):

```
git push origin --delete factory/ac14c-integrity-followup
 → - [deleted]         factory/ac14c-integrity-followup                                       exit 0
git ls-remote origin "refs/heads/factory/*"     # immediately after the deletion
 → 97394daa6a65e44d0a02aeb49c05ef82ae9fb845  refs/heads/factory/ac14-integrity-followup
```

The phase push and the confirmation:

```
git push origin factory/ac14-integrity-followup
 → 97394da..76951d4  factory/ac14-integrity-followup -> factory/ac14-integrity-followup       exit 0
git ls-remote origin "refs/heads/factory/*"
 → 76951d4956ecbaf8dfd0ae25ece603aed5b3ad47  refs/heads/factory/ac14-integrity-followup
git rev-parse HEAD
 → 76951d4956ecbaf8dfd0ae25ece603aed5b3ad47     # the remote ref equals the local HEAD
git status -sb
 → ## factory/ac14-integrity-followup...origin/factory/ac14-integrity-followup    # clean, in sync
```

Final hygiene checks on the committed tree:

```
git status --porcelain                          → (empty)
git ls-files .env .env.local backups/           → (empty; .gitignore covers .env/.env.local, .git/info/exclude covers backups/)
git ls-files | rg "backups/|\.env|credential|secret|\.dump|\.patch|\.bak"
 → .env.example, web/.env.example, n8n/99-credential-check.sdk.ts    # pre-existing templates/check script, tracked long before this mission
```

The parked alias is gone from origin; the canonical branch is the only `factory/*` ref and carries the whole mission
(`97394da..76951d4` published the C lifecycle commit and this close). No hosted system was touched at any point
(`FIXED OFFLINE, NOT HOSTED/DEPLOYED`); the only network traffic was this push to the repository's own remote.

The follow-up commit that carries this section (`AC-14C: the phase commit is recorded on origin`) advances the branch
tip to `5392f8625b2c782cc7a1df588c9965499ca21352`, and the remote ref equals it after the follow-up push
(`76951d4..5392f86`). The transcripts above are as-captured at the phase push, before this addendum.
