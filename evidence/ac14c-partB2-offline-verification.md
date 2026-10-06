# AC-14C Part B2 offline verification: the supervised final-invoice reissue (facility)

**FIXED OFFLINE, NOT HOSTED/DEPLOYED.**

Facts and command output only. Nothing here was run against a hosted system; no deploy, no production credentials, no
Xero, Airtable, n8n or Supabase call. Everything below is local: PGlite and a locally installed PostgreSQL 17 container
(`roofops-postgres`) at `127.0.0.1:54322`.

- Defect: AC-14C in [docs/defect-ledger.md](../docs/defect-ledger.md) (Part B2 of A/B1/B2/C; Part A shipped at
  `153d87b`, B1 closed at `2900f44a`). Root cause: B1b made a VOIDED final invoice non-collectible (`outstanding = 0`)
  but left the debt owed on the project — and gave no way back. There was no explicit, audited, human path to make the
  same canonical invoice collectible again after a legitimate Xero VOIDED/DELETED read, and no guard prevented raw SQL
  from flipping `VOIDED → APPROVED` without evidence.
- Invariant added: **a voided final invoice becomes collectible again only through a supervised reissue** — a
  FINANCE/ADMIN request with a meaningful reason, a fresh bound approval, the void proof in the bound tenant, no money
  moved, and no live write — which opens exactly one new Xero draft generation for the *same* invoice row (same invoice
  number, one canonical FINAL invoice per project, ever) with new idempotency identity; the old generation stays in the
  ledger forever. No automatic reissue exists: only `ops_reissue_decide` creates generation ≥ 2.
- Migration (new file; no applied migration was edited and `git status` shows no modified migration):
  `supabase/migrations/20261001170000_supervised_final_invoice_reissue.sql`, SHA-256
  `7f151f9a206acbc672f9df23cc42980f5b7e46d373e6a408a2f843fc70cedd88` (prefix `7f151f9a`).
- Test: `test/xero-reissue.test.ts` (new), SHA-256 `1ff9b7d896a44f1df84f8fdd75f44bed5d214704721c059e167fc83f574ff2cb`
  (prefix `1ff9b7d8`), 19 cases × 2 engines = 38 results. Both files' bytes were frozen with these hashes before the
  ablations and verified identical after every revert (§9).
- One existing file is touched, exactly as the milestone note requires: `test/xero-generations.test.ts` — the two B1
  assertions that pinned the intermediate B1 behaviour are updated to the decided B2 semantics (§7.3). No other change
  to that file (24 insertions / 6 deletions, all inside those two cases).
- Starting SHA (this feature): `2900f44a68d15eb79126ddfb6d70c8f80ae2230f` ("AC-14C-B1: the phase commit is recorded on
  origin"), branch `factory/ac14c-integrity-followup`, clean tree. Phase close (push) belongs to the next feature
  (`b2-operator-cli`); this file is started here and completed there.

## 1. What Part B2 is

B1 made the database generation-aware and made a voided invoice non-collectible. B2 adds the *only* way back, entirely
inside Postgres (the database rule is the source of truth; the operator CLI of the closing feature never re-implements
it):

1. `app_settings.invoice.reissue_roles = 'FINANCE,ADMIN'` (idempotent).
2. `approvals.action_type` gains `REISSUE_INVOICE` (full CHECK restated, all seven values preserved).
3. Two legal transitions seeded as data and `invoice`/`VOIDED` made non-terminal, so a voided invoice is not a dead
   end: `('invoice','VOIDED','APPROVED')` and `('invoice_sync','SYNCED','PENDING')`.
4. `invoice_reissue_preview()` + `invoice_reissue_preview_hash()`: the canonical act preview (invoice, project, void
   evidence, generations, tenant, reason) and the sha256 of its canonical jsonb text excluding
   `invoice_record_version` (which binds separately through `expected_record_version`).
5. `ops_reissue_request(p_invoice, p_employee_code, p_reason)`: authority, mandatory meaningful reason, the full
   battery in the pinned order, one bound `REISSUE_INVOICE` approval, at most one open request per invoice (partial
   unique index), expired-request recovery (never a dead end), one audit event.
6. `ops_reissue_decide(p_approval_number, p_employee_code, p_note)`: `processed_events` consumer
   `invoice.reissue:<approval_number>` (a replay is inert), drift checks (generation → record version → preview hash),
   then in one ordered transaction: supersede the old generation with the reason → open the new generation → queue the
   new write with generation-aware keys and the copied payload → one single-statement invoice update
   (`VOIDED → APPROVED`, `SYNCED → PENDING`, `approval_id = the reissue approval`) → approval EXECUTED with result →
   one audit event.
7. `invoice_reissue_guard()` (BEFORE UPDATE OF status, fires before `invoices_state_machine` by name order): the
   transition is data-legal but the guard is what makes it safe — a matching `REISSUE_INVOICE` approval, void-family
   proof of the linked InvoiceID in the bound tenant, no payment/credit, no live write other than the one the reissue
   itself is opening (its target generation); a live write of an older generation still refuses.
8. Proof-gated link movement in `wf_complete_side_effect_core`: a generation ≥ 2 completion whose predecessor is
   superseded may move the single current `external_links` Xero row to the new InvoiceID — same proofs as before, old
   ID never lost, never a second link.
9. `invoice_void_guard` tightened (architecture item 13, the B1 finding): the AC-14B/AC-14C-A verified-void/deletion
   exemption applies only while the invoice's draft writes are terminal, so a local void during the reissue window is
   refused exactly as any queued write — no voided invoice can ever have a live replacement generation writing a draft.
10. Owner-only surface: every new function is `SECURITY DEFINER set search_path = public, pg_temp`, revoked from
    public / `roofops_workflow` / `roofops_dashboard`; the ledger table keeps RLS enabled; the grant tail replicates
    the convention and grants nothing new to the workflow role (the 21-function workflow allow-list is unchanged).

## 2. The migration, clause by clause

| # | Architecture clause (§4.2) | Where in the file | Proof |
|---|---|---|---|
| 1 | `invoice.reissue_roles = 'FINANCE,ADMIN'` | section 1 | `app_settings` row; VAL-RIS-004 (only active FINANCE/ADMIN) |
| 2 | `REISSUE_INVOICE` in the approvals CHECK | section 2 | `pg_get_constraintdef` shows all seven values; VAL-RIS-003 |
| 3 | two new transitions + VOIDED non-terminal | section 3 | `state_transitions` + `state_machine_states`; `test/state-integrity.test.ts` green |
| 4 | preview + hash rule | sections 4–5 | preview case (payload, hash excludes record version, follows the invoice) |
| 5 | request semantics | section 6 | VAL-RIS-003/004/005/006/007/008/009/011/015/017 |
| 6 | decide transaction and order | section 7 | VAL-RIS-001/002/010/011 |
| 7 | the guard | section 8 | VAL-RIS-012 |
| 8 | link movement | `wf_complete_side_effect_core` | VAL-RIS-013, updated VAL-GEN-010 |
| 9 | void-guard tightening | `invoice_void_guard` | VAL-RIS-018, updated VAL-GEN-007 |
| 10 | privileges / RLS / grant tail | tail | VAL-RIS-014 |
| 11 | one open request per invoice | partial unique index `approvals_reissue_open_idx` | VAL-RIS-009(d), VAL-RIS-011 |
| 12 | no automatic reissue | nothing else inserts a generation ≥ 2 | VAL-RIS-016 |
| 13 | tenant never caller-supplied | no function takes a tenant argument | VAL-RIS-015 |

### 2.1 Decisions taken while implementing (all pinned by tests)

- **The approval is bound to the invoice** (`entity_type='invoice'`, `entity_id = invoice_id`) rather than to the
  project with the invoice id in the payload: the approvals table allows it, the partial unique index can then enforce
  "one open request per invoice" directly on `entity_id`, and the guard's `NEW.approval_id` lookup is exact. The
  project is carried in the payload (`project_id`, `project_number`, `project_status`).
- **The guard also accepts a fresh PENDING request** (status `PENDING` and `expires_at > now()`), not only
  APPROVED/EXECUTING: VAL-RIS-012 pins that a raw `UPDATE` carrying a valid pending approval plus the evidence
  succeeds, and the request already ran the whole battery. An expired PENDING request does not authorise anything (the
  new probe in VAL-RIS-012, ablation A2 in §9).
- **A non-consumed refusal releases its claim**: the decide deletes its `processed_events` claim on every refusal that
  is not `ALREADY_PROCESSED`, so a corrected retry (the payment removed, the drift repaired) can proceed — pinned by
  VAL-RIS-008's decide case.
- **`invoice_reissue_preview_hash()` is `SECURITY DEFINER`** like the rest of the reissue surface (the existing
  `invoice_preview_hash()` is not): the hash is what an approval is bound to, so it is owner-only too (VAL-RIS-014).

## 3. State transitions

| Machine | From | To | Seeded by | Reachable only through |
|---|---|---|---|---|
| `invoice` | `VOIDED` | `APPROVED` | `20261001170000` | `invoice_reissue_guard` + the decide transaction |
| `invoice_sync` | `SYNCED` | `PENDING` | `20261001170000` | the decide transaction (supervised re-queue) |

`state_machine_states.is_terminal` for `('invoice','VOIDED')` is now `false` (a state with an outgoing edge is not a
dead end). The invoice machine has 16 legal edges; `test/state-integrity.test.ts` stays green: 242 ordered pairs
enforced, no terminal state has an escape, the generated probe summary is unchanged at 56 rows.

## 4. Red before, green after

The facility is new, so "red before" is the migration not being applied at all. The harness migrates a fresh database
per test, so the before state is the B1 chain: the migration file was temporarily renamed to `.sql.hold` (the loader
reads `readdirSync(dir).filter(f => f.endsWith('.sql'))`, `src/db/migrate.ts:20`), the suite was run, and the file was
renamed back and verified byte-identical.

```
# WITHOUT 20261001170000 (HEAD 2900f44a, B1 chain only; the file renamed .sql.hold)
npx vitest run test/xero-reissue.test.ts
 → Test Files 1 failed (1) | Tests 19 failed (19), 45.78 s
   representative errors: "function ops_reissue_request(unknown, unknown, unknown) does not exist",
   "function invoice_reissue_generation(uuid) does not exist",
   "state machine check failed: illegal invoice transition VOIDED -> APPROVED"
   (the raw-SQL probe fails at the state machine because the new edge is not seeded and the guard does not exist)
 → file restored: SHA-256 7f151f9a206acbc672f9df23cc42980f5b7e46d373e6a408a2f843fc70cedd88 (identical)

# WITH 20261001170000
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest run test/xero-reissue.test.ts
 → Test Files 1 passed (1) | Tests 38 passed (38)   (19 cases × pglite + postgres)
```

## 5. The refusal catalogue (24 codes, pinned precedence)

Request and decide return `{ok,false,code,detail}` with the first failing condition in this order (the exact order the
architecture pins, verified by the tests that put two refusals in one fixture and assert which one wins):

authority → reason → reference (`NOT_FOUND`, `NOT_FINAL_INVOICE`) → project state (`PROJECT_NOT_COMPLETED`,
`PROJECT_CLOSED`, `PROJECT_CANCELLED`) → tenancy (`TENANT_NOT_PINNED`, `TENANT_MISMATCH`, including a void recorded in
another tenant) → invoice state (`INVOICE_NOT_VOIDED`) → observation semantics (`OBSERVATION_AMBIGUOUS`,
`OBSERVATION_CONTRADICTED`, `VOID_NOT_VERIFIED`) → money (`PAYMENT_EXISTS`, `CREDIT_EXISTS`) → write state
(`WRITE_IN_FLIGHT`, `PRIOR_WRITE_UNKNOWN`) → approval state for decide (`REISSUE_PENDING`, `APPROVAL_NOT_PENDING`,
`APPROVAL_EXPIRED`, `PREVIEW_CHANGED`, `RECORD_VERSION_CHANGED`, `GENERATION_CHANGED`, `ALREADY_PROCESSED`).
Success codes: `REISSUE_REQUESTED`, `REISSUE_QUEUED`.

Every one of the 26 codes appears in both the migration and the test file (checked mechanically, §10.1), and every
refusal case asserts *no state change* (one ledger row, one write, the invoice unchanged).

## 6. The happy paths, end to end

- **AC-14C-A deletion path** (VAL-RIS-001): a verified DELETED of the linked draft → request → approval bound to
  invoice, state, preview hash, record version, target generation, tenant and void evidence → decide → old generation
  SUPERSEDED with the reason, generation 2 PENDING, a new outbox write with new keys and the copied payload (same
  tenant, same invoice number, `reissued_from_generation`, `reissued_by`), the invoice APPROVED / sync PENDING with the
  reissue approval attached, the approval EXECUTED with the generation and key, one audit event, one invoice row, the
  same invoice number, `billing.remaining = 0` (billed again) and a collectible outstanding through normal settlement.
- **Verified Xero VOIDED path** (VAL-RIS-002): the same, with the void reason the reconciliation wrote
  (`Voided in Xero (verified by reconciliation …)`) kept on the invoice and the money owed throughout.
- **Recovery is never a dead end** (VAL-RIS-011): an expired open request is CANCELLED and replaced by a fresh one with
  a deterministic per-cycle idempotency key (`reissue:request:<invoice>:<cycle>`); the cancelled one can never be
  decided.
- **Replay and double-click** (VAL-RIS-010/011): a replayed decide returns `ALREADY_PROCESSED` (duplicate: true,
  generation 2) and changes no row count; two simultaneous decides on two PostgreSQL connections produce exactly one
  `REISSUE_QUEUED` and one refusal (`ALREADY_PROCESSED` or `APPROVAL_NOT_PENDING`), exactly one new generation, one
  superseded predecessor, one new outbox row, one audit event, one `processed_events` consumer.
- **Nothing is automatic** (VAL-RIS-016): applying a verified void/deletion queues nothing and opens no generation;
  only a decision does.

## 7. The guard, the link move, and the two updated B1 assertions

### 7.1 Raw SQL cannot bypass the guard (VAL-RIS-012)

`UPDATE invoices SET status='APPROVED'` from VOIDED is refused (a) with no reissue approval, (b) with an approval of
the wrong action type, (c) with money moved, (d) without void proof, and (e) with an *expired* pending approval; with a
valid pending approval plus the evidence it succeeds and the approval is not consumed (raw SQL is not a recovery path:
no generation is opened). The guard excludes the write the reissue itself opens (a live write at the target generation
passes) and still refuses a live write of an older generation. The guard is a separate trigger and fires before
`invoices_state_machine` (pinned by trigger-name order), so the generated state-integrity probe stays valid.

### 7.2 The link moves only with proofs (VAL-RIS-013)

A generation ≥ 2 completion without the proofs (wrong total, wrong tenant, non-DRAFT, not exactly one matching
invoice) is refused and the link never moves; with every proof the single current link moves to the new InvoiceID
(`verified_at` refreshed) and the old InvoiceID stays queryable in the ledger and its observations. A generation 1
completion still refuses a second link, and so does a generation 2 whose predecessor was never superseded. A
completion whose new InvoiceID belongs to another invoice still hits the unique constraint and moves nothing.

### 7.3 The two B1 assertions that had to change (and nothing else)

The milestone note requires exactly these two updates and no other change to `test/xero-generations.test.ts`
(`git diff` = 24 insertions / 6 deletions, all inside VAL-GEN-007 and VAL-GEN-010):

- **VAL-GEN-007** pinned the old exemption-fires-while-queued behaviour (a local void of an invoice whose replacement
  write was queued). Architecture §4.2 item 13 decided the refinement, so the case now asserts the refusal
  (`cannot be voided: its Xero draft is queued`) while the replacement is live, and then completes the replacement,
  verifies its document deleted in the pinned tenant, and asserts the exemption applies as before (the local void
  succeeds, the history keeps both generations, the old InvoiceID is intact).
- **VAL-GEN-010** pinned "B1 cannot move the link yet". The proof-carrying generation 2 completion now moves it, so the
  case asserts `RECORDED`, sync SYNCED, the moved link, the ledger (`1 SUPERSEDED`, `2 CREATED` with the new
  InvoiceID) and integrity green.

No other assertion in that file was weakened; the whole file passes on both engines (§10.2).

## 8. Concurrency (two PostgreSQL connections)

VAL-RIS-010 opens a second connection to the same test database (`openPostgres(db.url)`), starts both decides with
`Promise.all`, and asserts: exactly one `REISSUE_QUEUED`; the loser refuses with `ALREADY_PROCESSED` or
`APPROVAL_NOT_PENDING`; the ledger is exactly `[1 SUPERSEDED, 2 PENDING]`; two outbox rows; the approval EXECUTED; the
invoice APPROVED / sync PENDING; exactly one audit event and exactly one `processed_events` consumer. On PGlite the case
asserts the engine is the single-connection one and returns (a genuine two-connection race is a PostgreSQL property);
on PostgreSQL it runs the race.

## 9. Ablation proofs (applied to the new migration, run, reverted byte-identical)

Each ablation is one targeted edit to `20261001170000_supervised_final_invoice_reissue.sql` (SHA-256 before
`7f151f9a…`), a targeted PGlite run of the test that pins the rule, then an exact inverse edit verified byte-identical
against the frozen hash, then the same run green.

| Ablation | Change made | Test red (observed) | Revert |
|---|---|---|---|
| A1 payment/credit refusal | `invoice_reissue_check`: the Xero-side money read disabled (`… coalesce(x.amount_paid, 0) > 0 and false`) | VAL-RIS-008: the verified `PARTIALLY_PAID` Xero read returned `REISSUE_REQUESTED` instead of `PAYMENT_EXISTS` | SHA-256 `7f151f9a…` identical, VAL-RIS-008 green |
| A2 fresh-approval binding | `invoice_reissue_guard`: freshness ignored (`a.status in ('APPROVED','EXECUTING','PENDING','CANCELLED','EXPIRED')`) | VAL-RIS-012: the expired-approval probe reached the void-proof branch instead of being refused for the approval | SHA-256 `7f151f9a…` identical, VAL-RIS-012 green |
| A3 tenant binding | `invoice_reissue_check`: the latest-read tenant check disabled (`v_last.tenant_id is distinct from v_bound` → `false`) | VAL-RIS-007: the void evidence recorded in another tenant returned `REISSUE_REQUESTED` instead of `TENANT_MISMATCH` | SHA-256 `7f151f9a…` identical, VAL-RIS-007 green |

The first attempt at A1 (a `where false` appended after the statement's own `where`) failed as a *syntax* error rather
than a behavioural red; it was discarded and re-run as the valid `and false` above, so every red in the table is a
behavioural red. All three were re-confirmed red against the final frozen bytes of both files (migration `7f151f9a…`,
test `1ff9b7d8…`) and the three targeted runs were green again after the final revert; no ablation was committed and
`git status` shows only the four deliverable files (§12).

## 10. Validation runs (this feature)

### 10.1 Static and mechanical

| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` | exit 0, no problems |
| Typecheck | `npm run typecheck` | exit 0, no errors |
| Code catalogue | every code in both files (26 codes) | all present in the migration and in the test file |
| SHA-256 freeze | `Get-FileHash … -Algorithm SHA256` | migration `7f151f9a…`, test `1ff9b7d8…` (verified again after every ablation revert) |

### 10.2 The dual-engine battery

| Run | Command | Result |
|---|---|---|
| New suite, PGlite | `npx vitest run test/xero-reissue.test.ts` (no `TEST_DATABASE_URL`) | `Test Files 1 passed (1)`, `Tests 19 passed (19)` |
| New suite, both engines | `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest run test/xero-reissue.test.ts` | `Tests 38 passed (38)` (19 × pglite + postgres) |
| B1 suites, both engines | `… npx vitest run test/xero-reissue.test.ts test/xero-generations.test.ts` | `Test Files 2 passed (2)`, `Tests 64 passed (64)` |
| Affected suites, PGlite | `npx vitest run test/balance-read-model.test.ts test/invoice-void.test.ts test/xero-settlement.test.ts test/invoice-approval-binding.test.ts test/billing-entitlement.test.ts test/state-integrity.test.ts test/schema.test.ts test/xero-tenant-binding.test.ts test/reconcile-07-uncertain-xero.test.ts` | `Test Files 9 passed (9)`, `Tests 143 passed \| 5 skipped (148)` |
| **Full suite, PGlite + PostgreSQL 17** | `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test` | **`Test Files 30 passed \| 3 skipped (33)`, `Tests 684 passed \| 35 skipped (719)`, 0 failed, exit 0, 254.81 s** |

Baseline for comparison: the B1 phase close recorded `Test Files 29 passed | 3 skipped (32)`, `Tests 646 passed | 35
skipped (681)`. This feature adds one file and 38 results (19 cases × 2 engines); nothing was removed or skipped.

### 10.3 Integrity

| Database | Command | Result |
|---|---|---|
| Local demo database (`roofops`) | `DATABASE_URL=…:54322/roofops npm run integrity:check -- --local` | `27 PASS, 5 WARNING, 0 FAIL` |
| Fresh chain from zero (`ac14c_b2_zero`) | `DATABASE_URL=…:54322/ac14c_b2_zero npm run integrity:check -- --local` | `26 PASS, 5 WARNING, 0 FAIL` (the B1 phase close's fresh-chain figure) |
| Second fresh database (`ac14c_b2_fresh`) | same | `26 PASS, 5 WARNING, 0 FAIL` |

The Xero-draft rules that matter here are green on every database: `voided_invoice_has_no_xero_write`,
`done_has_proof` (current generation only), `xero_invoice_state_verified`, `final_invoice_settles_entitlement`,
`closed_project_settled`.

### 10.4 Fresh chain from zero

```
docker exec roofops-postgres createdb -U postgres ac14c_b2_zero
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/ac14c_b2_zero npx tsx scripts/db-load.ts
 → migrations applied: 20260929000000_core_schema.sql … 20261001170000_supervised_final_invoice_reissue.sql (skipped 0)
 → imported batch 2262b1b2-0326-499c-81be-8de94eb8a3df (dataset 0dd5b61419f7…)
 → projects 30, invoices 38, invoice_xero_draft_generations 0
 → schema_migrations: 38 rows, head 20261001170000_supervised_final_invoice_reissue.sql
# second run (ac14c_b2_fresh)
 → migrations applied: none (skipped 38); dataset 0dd5b61419f7… already imported (batch 58067538-…); nothing to do
```

### 10.5 Privileges and the security posture (VAL-RIS-014)

All seven new functions are `SECURITY DEFINER` with `search_path=public, pg_temp`; none is executable by
`roofops_workflow` or `roofops_dashboard`; no function in `public` grants EXECUTE to PUBLIC; the
`roofops_workflow` allow-list is still exactly 21 functions (the new surface is not reachable from the workflow role);
`wf_complete_side_effect` remains workflow-callable; the ledger table has RLS enabled and neither application role can
SELECT it.

## 11. What the new tests assert (VAL-RIS-001 … 018)

| Assertion | Case in `test/xero-reissue.test.ts` |
|---|---|
| VAL-RIS-001 | the deletion path end to end: bound approval, decide, generation 2, one audit event, same invoice row/number, billed again and collectible, close gate refuses while unpaid |
| VAL-RIS-002 | the verified Xero VOIDED path end to end, the void reason kept, the money still owed |
| VAL-RIS-003 | reason refused (empty, short, whitespace) and the real reason recorded in the approval, the audit event and the payload |
| VAL-RIS-004 | only an active FINANCE/ADMIN employee may request or decide (inactive, wrong role, unknown code, decide by an unauthorised actor) |
| VAL-RIS-005 | fresh, undecided, drift-free approval: expiry, cancellation, preview drift (cancelled), record-version drift, generation drift; each leaves one generation |
| VAL-RIS-006 | project must be COMPLETED; IN_PROGRESS / CLOSED / CANCELLED refused (with `cancellation_reason`), the money and close-gate facts re-asserted |
| VAL-RIS-007 | void evidence: not voided, pin missing, pin ≠ bound, a void in another tenant, a local void with nothing in Xero, a void of a different InvoiceID, a non-void-family read, a failed read after the void (ambiguous), a later verified contradiction |
| VAL-RIS-008 | money: a verified payment read, a credit read, a local payment row — refused at request and at decide; nothing queued; the claim released for a corrected retry |
| VAL-RIS-009 | write state: a live write, a retry-scheduled failure, an UNKNOWN write (and the ledger's UNKNOWN), an open request — refused, no duplicate generation |
| VAL-RIS-010 | two simultaneous decides on two PostgreSQL connections: exactly one winner, no partial state (PGlite returns after asserting the engine) |
| VAL-RIS-011 | replay inert (`ALREADY_PROCESSED`, counts equal), a second request refused, an expired request cancelled and replaced by a working one |
| VAL-RIS-012 | raw SQL probes: no approval, wrong action type, money moved, no void proof, expired approval, the valid pending case, the self-opened write excluded, an older generation refused, trigger ordering |
| VAL-RIS-013 | link movement proof gating, generation 1 refusal, a non-superseded predecessor, another invoice's InvoiceID |
| VAL-RIS-014 | owner-only SECURITY DEFINER functions, no PUBLIC execute, the 21-function workflow allow-list, RLS on the ledger |
| VAL-RIS-015 | the tenant is derived (no function takes one), the pin/bound mismatch refuses, the queued write keeps the pinned tenant (the tenant-fix trigger still refuses a change) |
| VAL-RIS-016 | applying a verified void queues nothing; only a decision creates generation ≥ 2 |
| VAL-RIS-017 | unknown invoice/approval, an IMPORT invoice, a non-final invoice, a tampered canonical key — `NOT_FOUND` / `NOT_FINAL_INVOICE`, nothing created |
| VAL-RIS-018 | a local void during the reissue window is refused (queued and in-flight), and the exemption is back once the replacement completed and its document is verified voided/deleted |
| (preview) | the preview's fields, the hash excluding `invoice_record_version`, a changed reason changing the hash, `NOT_FOUND` for an unknown invoice |

## 12. Git status

```
git status --porcelain
 M test/xero-generations.test.ts
?? evidence/ac14c-partB2-offline-verification.md
?? supabase/migrations/20261001170000_supervised_final_invoice_reissue.sql
?? test/xero-reissue.test.ts
```

No applied migration was modified, nothing under `backups/`, `.env*` or `.vscode/` is staged, no scratch file is in
the tree, and the two engine runs left no artifact. The commit for this feature is `AC-14C-B2: …`; the phase commit's
push is the closing feature's step (`b2-operator-cli`), per the mission brief ("push only when a phase's closing
feature instructs it").

## 13. SKIPPED (and why)

- The operator CLI (`scripts/reissue.ts`), the committed scenario builder and the security-check extension: the next
  feature (`b2-operator-cli`), which also closes the phase (push) and completes this file's closing sections.
- The end-to-end 24-step lifecycle proof, the 35-case adversarial matrix and the remaining ablation set (one-live
  protection, generation-aware idempotency, historical Xero ID preservation, collectible balance, concurrent reissue):
  Part C (`c-end-to-end-recovery`), whose `c-final-evidence` closes the mission and updates the defect ledger and the
  generated docs.
- Hosted verification of any kind: out of scope for this mission by design (`FIXED OFFLINE, NOT HOSTED/DEPLOYED`).
