# AC-14C Part B2 offline verification: the supervised final-invoice reissue (facility + operator tooling)

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
- Starting SHA (facility feature): `2900f44a68d15eb79126ddfb6d70c8f80ae2230f` ("AC-14C-B1: the phase commit is recorded
  on origin"), branch `factory/ac14c-integrity-followup`, clean tree. The facility was committed by `b2-reissue-facility`
  as `a19b3dcd00479763340c8bb42cd6a790c00792e6` ("AC-14C-B2: a voided final invoice is reissued only through a
  supervised, evidence-bound decision") and independently re-verified by the runner's adoption session (same hashes,
  red-before, three ablations, concurrency, full dual-engine 684/35/0) before the phase was handed to the closing
  feature `b2-operator-cli`, which adds the operator CLI, the committed scenario builder, the security-check extension
  and the closing sections below and publishes the phase (§20).

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

The facility feature's tree at its commit `a19b3dc` (recorded here as the facility left it):

```
git status --porcelain
 M test/xero-generations.test.ts
?? evidence/ac14c-partB2-offline-verification.md
?? supabase/migrations/20261001170000_supervised_final_invoice_reissue.sql
?? test/xero-reissue.test.ts
```

No applied migration was modified, nothing under `backups/`, `.env*` or `.vscode/` is staged, no scratch file is in
the tree, and the two engine runs left no artifact. The closing feature's tree and commit are §20.

## 13. What this phase does not include (and where it lands)

- The end-to-end 24-step lifecycle proof, the 35-case adversarial matrix and the remaining ablation set (one-live
  protection, generation-aware idempotency, historical Xero ID preservation, collectible balance, concurrent reissue):
  Part C (`c-end-to-end-recovery`), whose `c-final-evidence` closes the mission and updates the defect ledger and the
  generated docs.
- A hosted run of any kind, including the extended `npm run security:check`: out of scope for this mission by design
  (`FIXED OFFLINE, NOT HOSTED/DEPLOYED`). §17 records the offline replica of the six new assertions against a freshly
  migrated local database.

## 14. The operator CLI (`scripts/reissue.ts`, npm `reissue`)

The database owns the rule; the CLI is a thin, local, two-step surface over it. It contains no rule logic of its own
(no status, tenant, money, reason or approval semantics), writes nothing itself, and never calls Xero or any network
endpoint: its only statements are the two `select ops_reissue_*(...)` calls plus one read-only invoice lookup that turns
an invoice number into its id.

- Usage (also in `README.md` §"🧾 The supervised reissue CLI" and in the script's `--help`/usage text):
  `npm run reissue -- request --invoice <INV-…|uuid> --by <EMP-…> --reason "<why>"` and
  `npm run reissue -- decide --approval <APR-…> --by <EMP-…> [--note "<what you checked>"]`.
- Connection: `openPostgres(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/roofops')`
  (`src/db/db.ts`); a non-local host is refused before connecting, so the CLI cannot be pointed at a hosted database by
  accident.
- Output: exactly the JSON the database function returns, one line, on stdout. Exit codes: `0` success
  (`REISSUE_REQUESTED` / `REISSUE_QUEUED`), `2` a database refusal (the canonical code is printed), `1` a usage or
  connection error.

### 14.1 Manual runs against a throwaway local database (`ac14c_b2c_cli`, created and dropped for this)

```
docker exec roofops-postgres createdb -U postgres ac14c_b2c_cli
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/ac14c_b2c_cli npx tsx scripts/db-load.ts
 → migrations applied: … 20261001170000_supervised_final_invoice_reissue.sql (skipped 0)
 → imported batch acab0e3c-b642-4787-92a0-1b298e76bc4d (dataset 0dd5b61419f7…)
# seeded through the committed scenario builder (deletedReissueScenario, §15): INV-2026-0039 VOIDED / SYNCED,
# outstanding 0.00, linked Xero invoice …a4, verified DELETED read applied

DATABASE_URL=…/ac14c_b2c_cli npm run reissue -- request --invoice INV-2026-0039 --by EMP-900 \
  --reason "Xero deleted the draft; the customer still owes the job"
 → {"ok":true,"code":"REISSUE_REQUESTED","detail":"APR-2026-0002: reissue of INV-2026-0039 requested, target generation
   2 (voided DELETED, verified by observation 9c23022c-… )","expires_at":"2026-10-14T08:27:16.170533+10:00",
   "invoice_id":"9f1df791-…","payload_hash":"f127e18a…","invoice_number":"INV-2026-0039","approval_number":
   "APR-2026-0002","target_generation":2}                                                              exit 0

DATABASE_URL=…/ac14c_b2c_cli npm run reissue -- decide --approval APR-2026-0010 --by EMP-900 --note "checked the customer account"
 → {"ok":false,"code":"NOT_FOUND","detail":"APR-2026-0010 is not a reissue request"}                  exit 2

DATABASE_URL=…/ac14c_b2c_cli npm run reissue -- decide --approval APR-2026-0002 --by EMP-900 --note "checked the customer account"
 → {"ok":true,"code":"REISSUE_QUEUED","detail":"APR-2026-0002: xero:invoice:9f1df791-…:g2 queued generation 2 for
   INV-2026-0039 (superseded generation 1, Xero invoice aaaaaaaa-bbbb-cccc-dddd-0000000000a4)","generation":2,
   "invoice_number":"INV-2026-0039","approval_number":"APR-2026-0002","xero_idempotency_key":
   "roofops-9f1df791-…-g2","superseded_generation":1,"outbox_idempotency_key":"xero:invoice:9f1df791-…:g2"} exit 0

DATABASE_URL=…/ac14c_b2c_cli npm run reissue -- decide --approval APR-2026-0002 --by EMP-900        # replay
 → {"ok":false,"code":"ALREADY_PROCESSED","detail":"APR-2026-0002 was already decided; nothing was created",
   "duplicate":true,"generation":2,"delivery_count":2}                                               exit 2

DATABASE_URL=…/ac14c_b2c_cli npm run reissue -- request --invoice INV-2026-0039 --by EMP-001 --reason "the customer still owes the job"
 → {"ok":false,"code":"ACTOR_UNAUTHORIZED","detail":"EMP-001 is not an active RoofOps employee in a role that may
   reissue a final invoice (FINANCE,ADMIN)"}                                                          exit 2

DATABASE_URL=…/ac14c_b2c_cli npm run reissue -- request --invoice INV-2026-0039 --by EMP-900        # no reason
 → {"ok":false,"code":"REASON_REQUIRED","detail":"a reissue needs a reason saying why (at least 10 characters)"} exit 2

DATABASE_URL=…/ac14c_b2c_cli npm run reissue -- decide --by EMP-900                                # missing flag
 → reissue: decide needs --approval  + the usage text                                                exit 1
```

The state the two successful calls left, read back with `psql` (the same rows the facility's SQL tests assert):

```
invoice_xero_draft_generations  1 | SUPERSEDED | xero:invoice:…:…fa9c     | aaaaaaaa-…-0000000000a4 | opened_by workflow        | reason t
                                2 | PENDING    | xero:invoice:…:…fa9c:g2  | (none)                  | opened_by operator:EMP-900 | reason f
outbox (xero.create_draft_invoice)  1 | DONE    | tenant 11111111-… | reissued_from_generation — | reissued_by —
                                    2 | PENDING | tenant 11111111-… | reissued_from_generation 1 | reissued_by EMP-900
invoices        INV-2026-0039 | APPROVED | PENDING | approval bound: t
approvals       APR-2026-0002 | EXECUTED | REISSUE_INVOICE | payload_hash: t | decision_reason "checked the customer account"
audit_events    invoice.reissue_requested (EMP-900); invoice.reissued (EMP-900)
```

`ac14c_b2c_cli` was dropped after the runs; the persistent `roofops` database was never used for this feature.

## 15. The committed scenario builder (`test/helpers/reissue-scenario.ts`)

A deterministic, network-free builder that turns *any* freshly migrated local database (PGlite or PostgreSQL, or a `Db`
the caller already owns) into the state the facility's workflows expect — "an approved final invoice whose linked Xero
invoice was verified DELETED or VOIDED in the bound tenant, with the money still owed" — using the real workflow
functions only (`InvoiceRows.send` → `wf_invoice_prepare` → `wf_invoice_approve` → `wf_claim_side_effect` →
`wf_complete_side_effect` with read-back proofs → `xero_record_settlement` with observation payloads). It reimplements
no rule and fakes no table write that the workflows would make themselves.

- `buildReissueScenario(target, family, opts?)` where `target` is `'pglite' | 'postgres'` (it opens, migrates, imports
  and later `close()`s a database of its own) or an existing `Db`; `family` is `'DELETED' | 'VOIDED' | 'APPROVED'`.
- Named entry points `deletedReissueScenario`, `voidedReissueScenario`, `approvedReissueScenario`.
- The returned object exposes `project`, `invoice` (id, number, xid, key, payload, total), `state()`, `ledger()`,
  `outbox()`, `link()`, `latestObservation()`, `balance()`, `integrityFails()`, `request(by, reason?)`,
  `decide(approval, by, note?)` and `close()`.
- Fixtures are pinned and idempotent (the finance approver `EMP-900`, an ADMIN `EMP-901`, a PROJECT_MANAGER `EMP-001`,
  an inactive employee, the pinned tenant, the Airtable project links), so two runs build byte-identical state and the
  builder is safe to use from the CLI tests, the lifecycle tests and ad-hoc operator work.

## 16. The new tests (`test/reissue-cli.test.ts`, dual engine)

| Case | Pins |
|---|---|
| VAL-CLI-001 | `request` + `decide` through `runReissue` leave exactly the state a direct SQL call leaves: same approval, same ledger (`1 SUPERSEDED`, `2 PENDING`), same outbox row, same invoice/approval/audit state, same billing and collectible balance |
| VAL-CLI-002 | refusals (`ACTOR_UNAUTHORIZED`, `REASON_REQUIRED`, `NOT_FOUND`, `INVOICE_NOT_VOIDED`, `ALREADY_PROCESSED`) surface the canonical code with exit 2 **and no writes at all** (row counts identical before/after), and the CLI is a pass-through: every flag it accepts is what it sends, every refusal is the database's |
| builder (DELETED/VOIDED) | `deletedReissueScenario` / `voidedReissueScenario` build the states the facility needs (VOIDED + SYNCED, outstanding 0.00, a verified void-family observation, a DONE generation 1, integrity green) on both engines, and `approvedReissueScenario` leaves a pre-decision state |
| builder (ownership) | the builder opens, migrates, imports and drops a database of its own when handed a target name |
| real process (postgres) | `npm run reissue`'s real path — `node node_modules/tsx/dist/cli.mjs scripts/reissue.ts …` as a child process against a throwaway database — drives request, decide, replay and a refusal with the documented exit codes |
| documented/packaged/rule-free | the script contains only the two `ops_reissue_*` calls and three read-only `select`s, no insert/update/delete/fetch/URL, `package.json` has `"reissue": "tsx scripts/reissue.ts"`, and the README plus the usage text document both subcommands and the exit codes |

## 17. `scripts/security-check.ts` (extended) and the offline privilege replica

`npm run security:check` is hosted-only (it reads `hostedDbConfig()`), so the extension is verified offline by running
its six new assertions against a freshly migrated local database — the repo's convention for privilege checks.

The six new read-only assertions (existing style, names and counts only):

1. `reissue functions: executable by an app role` → none of the nine B2 names (`ops_reissue_request`,
   `ops_reissue_decide`, `invoice_reissue_generation`, `invoice_reissue_preview`, `invoice_reissue_preview_hash`,
   `invoice_reissue_check`, `invoice_reissue_guard`, `invoice_void_guard`, `wf_complete_side_effect_core`) is executable
   by `roofops_workflow` or `roofops_dashboard`.
2. `reissue functions: executable by PUBLIC` → no `EXECUTE` grant to PUBLIC on any of them.
3. `reissue functions: pinned search_path` → every one has `search_path=public, pg_temp`.
4. `reissue functions: SECURITY DEFINER (except the void trigger)` → all are `SECURITY DEFINER` except
   `invoice_void_guard`, the AC-05 trigger that B2 replaced and that keeps the repo's invoker-rights trigger style.
5. `draft-generation ledger: row level security` → `invoice_xero_draft_generations` has RLS enabled.
6. `draft-generation ledger: readable by an app role` → neither application role can SELECT or INSERT it.

Offline replica output (throwaway script, same SQL, run against the fresh chain of §18.4 and then deleted):

```
PASS  reissue functions: executable by an app role         []
PASS  reissue functions: executable by PUBLIC              []
PASS  reissue functions: pinned search_path                []
PASS  reissue functions: SECURITY DEFINER (except the void trigger) ["invoice_void_guard"]
PASS  draft-generation ledger: row level security          ["invoice_xero_draft_generations:on"]
PASS  draft-generation ledger: readable by an app role     []

all B2 privilege checks pass
```

## 18. The closing battery (final frozen tree)

### 18.1 Static

| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` | exit 0, no problems |
| Typecheck | `npm run typecheck` | exit 0, no errors |
| Generated docs | `npm run contract:export` | `contract: 98 fields; 10 machines, 105 legal transitions`; `docs/state-machines.md` regenerated to the B2 reality (`VOIDED → APPROVED` and `SYNCED → PENDING` with the AC-14C B2 notes; "Terminal: none") and committed |

### 18.2 Full dual-engine battery

```
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test
 → Test Files 31 passed | 3 skipped (34)
 → Tests 695 passed | 36 skipped (731), 0 failed, exit 0, 290.22 s
 → test/reissue-cli.test.ts (12 tests | 1 skipped)   # the skip is the real-child-process case on PGlite
 → test/xero-reissue.test.ts (38 passed)             # 19 cases × both engines
```

Baseline: the facility recorded `30 passed | 3 skipped (33)`, `684 passed | 35 skipped (719)`; this feature adds one
file and 12 results (6 cases × 2 engines, one of which is a PGlite skip by design), nothing removed or skipped.

### 18.3 Concurrency (re-confirmed in the closing run)

`VAL-RIS-010` on PostgreSQL: two decides on two connections produce exactly one `REISSUE_QUEUED` and one refusal
(`ALREADY_PROCESSED` / `APPROVAL_NOT_PENDING`), one new generation, one superseded predecessor, one new outbox row, one
audit event, one `processed_events` consumer, no partial state. The same case passed in the closing full run on both
engines, and §19 A4 is its ablation.

### 18.4 Fresh chain from zero and integrity

```
docker exec roofops-postgres dropdb -U postgres --if-exists ac14c_b2c_fresh; docker exec roofops-postgres createdb -U postgres ac14c_b2c_fresh
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/ac14c_b2c_fresh npx tsx scripts/db-load.ts
 → migrations applied: 20260929000000_core_schema.sql … 20261001170000_supervised_final_invoice_reissue.sql (skipped 0)
 → imported batch 289f146b-ceb1-4464-941e-13f977776f87 (dataset 0dd5b61419f7…), 38 tables loaded, executive KPIs as of demo date
DATABASE_URL=…/ac14c_b2c_fresh npx tsx scripts/integrity-check.ts --local
 → 26 PASS, 5 WARNING, 0 FAIL  (local database)
```

The five warnings are the dataset's known ones (an accepted quote without a project, unlinked Airtable projects, no
reconciliation yet, one open workflow exception, one completed job whose completion items are still open) — unchanged
from the B1 close and the facility run.

## 19. The four B2 ablation proofs

A1–A3 are the facility's (§9): money read, fresh-approval binding, tenant binding — each red, each reverted
byte-identical to `7f151f9a…`. The fourth is the concurrency protection of the decide transaction:

| Ablation | Change made | Test red (observed) | Revert |
|---|---|---|---|
| A4 concurrent reissue | `ops_reissue_decide`: the approval row lock dropped (`select … for update` → `select …`) **and** the idempotency claim made unconditional (`on conflict do nothing returning true` → `returning true`) | `VAL-RIS-010` on PostgreSQL: the loser did not refuse but died with `duplicate key value violates unique constraint "processed_events_pkey"` — exactly the partial state the lock + `on conflict` prevent; the PGlite variant (single connection) stayed green, as designed | SHA-256 `7f151f9a…` identical, `VAL-RIS-010` green again on both engines |

## 20. Phase commit and publication

- The phase commit is `AC-14C-B2: the operator CLI, the scenario builder and the phase close` on
  `factory/ac14-integrity-followup`, on top of the facility commit `a19b3dc`. It contains: `scripts/reissue.ts`,
  `test/helpers/reissue-scenario.ts`, `test/reissue-cli.test.ts`, the extended `scripts/security-check.ts`, the
  `reissue` npm script, the README section, the regenerated `docs/state-machines.md` and this file.
- Publication is the single push `git push origin factory/ac14-integrity-followup`, which publishes `a19b3dc` plus the
  phase commit. The parked alias branch `factory/ac14c-integrity-followup` is never pushed.
- The push result (origin ref, equality with the local HEAD, clean tree, and the commit hashes) is recorded in the
  follow-up commit that closes the phase record, exactly as at the B1 close (`2900f44a`).

## 21. Offline statement

**FIXED OFFLINE, NOT HOSTED/DEPLOYED.** Every command in this file ran against local PGlite or the local PostgreSQL 17
container at `127.0.0.1:54322` (databases `ac14c_b2c_fresh`, `ac14c_b2c_cli`, and the harness's per-test databases). No
hosted Supabase, Xero, Airtable, n8n or Drive call was made, no credential was used, no deploy and no migration was
applied anywhere hosted, and the only network traffic was npm/vitest localhost sockets. Nothing in this phase depends on
being online: the CLI, the builder, the tests, the security assertions and the evidence are reproducible with the repo,
Node and a local PostgreSQL.
