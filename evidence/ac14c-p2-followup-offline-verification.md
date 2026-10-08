# AC-14C audit follow-up (P2-H1, H2, D1, D2, D3) offline verification, with the hosted deployment and Xero Demo plan

**FIXED OFFLINE, NOT HOSTED/DEPLOYED.**

Facts and command output only. Nothing here was run against a hosted system: no deploy, no migration applied anywhere
hosted, no Xero, Airtable, n8n Cloud, Google Drive or hosted Supabase call. Everything ran locally: PGlite in-process
and the local Docker container `roofops-postgres` (PostgreSQL 17) at `127.0.0.1:54322`. Xero's public API
specification was read as documentation only (§6, D4).

- Branch `factory/ac14-integrity-followup`. Starting HEAD `262e348` (clean tree, verified). Not merged to `main`.
- Commits, one per independently verified defect or phase:

| Commit | Item | What changed |
|---|---|---|
| `8dbdd0a` | P2-H1 | `VOIDED -> APPROVED` happens only inside `ops_reissue_decide` |
| `785606d` | P2-H2 | generation 2's Xero draft is the approved preview, built from canonical truth |
| `a6ca6b2` | P2-D1 | a queued generation-2 draft write has a supported dispatcher (n8n 08) |
| `0b9cc23` | P2-D2 | 05 and its claim/completion are generation-aware; stale Xero ids never control a reissue |
| `68b22aa` | P2-D3 | the Finance/Admin operator path: `npm run reissue -- status` / `dispatch --hosted` |
| `3bc6102` | Phase 5 | two-connection claim race; the workflow-role pin names `wf_reissue_dispatch` |

- Migrations (all new, additive; no applied migration was edited, deleted or re-ordered):

| File | SHA-256 (first 12) |
|---|---|
| `20261001180000_reissue_only_inside_decide.sql` (H1) | `41090d65e113` |
| `20261001190000_reissue_draft_is_the_approved_preview.sql` (H2) | `1b3a43bb3dc1` |
| `20261001200000_reissue_generation_dispatch.sql` (D1) | `81e42b315a3e` |
| `20261001210000_reissue_claim_and_completion_are_generation_aware.sql` (D2) | `fbcd02fc074e` |

  They redefine functions, change grants and insert one setting (`reissue.dispatch_token_sha256 = ''`,
  `on conflict do nothing`). Every other `insert`/`update`/`delete` in them is inside a function body. No table, column,
  constraint or existing row is changed.

## 1. What each item fixed

**P2-H1 (approval).** The reissue guard accepted a merely PENDING reissue approval, so privileged raw SQL carrying a
fresh request plus the void evidence could set a voided final invoice back to APPROVED. No replacement generation was
opened and the approval was never consumed. The guard keeps every existing check and also binds the transition to
`ops_reissue_decide`'s own in-flight state:
- the approval is EXECUTING and its consumption claim is still PROCESSING;
- the predecessor generation is SUPERSEDED;
- the next generation's ledger row and draft write are PENDING and bound to that approval.

The integrity check adds `reissue_transition_bound` (FAIL).

**P2-H2 (financial).** Generation 2's payload was copied from generation 1's outbox payload; the approved preview
contributed only a hash.
- One deterministic builder, `xero_draft_payload(invoice, tenant)`, now builds every Xero-facing value from canonical
  rows and the bound tenant.
- Generation 1 uses it, and refuses if it ever disagrees with the approved preview.
- The reissue preview embeds it as `draft`, so it is covered by the approval's hash.
- `ops_reissue_decide` queues exactly that draft and refuses `INVOICE_NUMBER_CHANGED`.
- The H1 guard and the integrity check also require the queued payload to contain the approved draft under the
  approval's hash.

**P2-D1 (dispatch).** Nothing dispatched a generation-2 write: 04 dispatches only a first issue.
- `xero_reissue_proof(outbox)` is the single statement of "this generation ≥ 2 write is the supervised reissue":
  - the ledger row is live and bound to an EXECUTED reissue approval;
  - the payload contains that approval's draft under its hash;
  - the predecessor is superseded;
  - the invoice is APPROVED on that approval.
- `wf_reissue_dispatch(token, worker)` sits behind an operator token stored only as a SHA-256 hash (empty means
  refused). It is a pure read of the due, proven writes; unproven writes are reported, never listed.
- n8n `[RoofOps] 08 Reissue Dispatch` (operator webhook) runs the unchanged 05 for each write, exactly as 04 does.

**P2-D2 (duplicate invoice / tenant / stale id).** 05 refused the VOIDED/DELETED predecessor that a reissue requires,
and nothing told it which documents were superseded.
- `wf_claim_side_effect` claims a generation ≥ 2 write only when the proof holds. Otherwise:
  - it returns `REISSUE_NOT_PROVEN`;
  - nothing is sent and the write stays queued;
  - a RECONCILIATION_MISMATCH exception is opened.
- A proven claim hands 05 the superseded InvoiceIDs.
- `wf_complete_side_effect` re-proves the write and refuses a superseded InvoiceID.
- 05's Reconcile Before Create, for generation ≥ 2:
  - requires the superseded list;
  - tolerates the superseded documents only while they stay VOIDED/DELETED, and never adopts them;
  - sends any other dead document with the number to a person;
  - otherwise applies the unchanged generation-1 rules (adopt only a fresh matching DRAFT).
- Verify Xero Read-Back refuses a superseded InvoiceID.
- Generation 1's claim result and checks are unchanged. The AC-04 (UNKNOWN), AC-05 (voided) and AC-06 (tenant) checks
  stay in place.

**P2-D3 (operator path).** No new UI. `npm run reissue` gains:
- `status --invoice`: a read-only view of the one current generation, its write and the open exceptions. More than one
  current generation is reported as an error, never guessed between.
- `dispatch --invoice --hosted`: POSTs 08's webhook with `REISSUE_DISPATCH_TOKEN` and waits. It reports
  `REISSUE_CREATED` (exit 0), or `NO_REISSUE_QUEUED` / `REISSUE_NOT_CREATED` / `STILL_PENDING` (exit 2).
- `--hosted` runs any subcommand against `SUPABASE_DB_URL`, like `db:load --hosted`. Without it the CLI stays
  local-only, and `dispatch` is refused.
- The webhook call and the status read live in `src/ops/reissue-dispatch.ts`. `scripts/reissue.ts` still writes nothing
  and calls nothing itself.

## 2. Tests and ablations

Every ablation was applied from a saved genuine copy, run, restored byte-identically and SHA-256 verified, then the
targeted suite was re-run green.

| Item | New/changed tests | Ablations (all red) |
|---|---|---|
| H1 | `test/xero-reissue-hardening.test.ts` (H1 part); VAL-RIS-012 (e)/(g) corrected | 6 |
| H2 | `test/xero-reissue-hardening.test.ts` (H2 part) | 4 |
| D1 | `test/xero-reissue-dispatch.test.ts`; VAL-RIS-014 pin 21 → 22 | 8 |
| D2 | `test/xero-reissue-claim.test.ts`, `test/n8n-05-generation.test.ts` (05's real node code) | 8 |
| D3 | `test/reissue-dispatch-cli.test.ts` | 4 (a fifth candidate, "status includes superseded rows", first stayed green; `reissueStatus` now refuses more than one current generation and the ablation is red) |

**Existing tests changed by D2**, each change documented in its file:
- B1 VAL-GEN-007, 008 and 010 build a hand-made two-generation fixture with no executed reissue approval.
  - 05's real claim now refuses it, and the tests assert `REISSUE_NOT_PROVEN`.
  - The generation mechanics they cover are driven through the owner-only core functions.
- VAL-RIS-013 forges an unproven generation 2. Its completion is still refused and the link still unmoved, but the
  refusal now comes earlier, from the proof.

**Concurrency** (PostgreSQL, two connections): two simultaneous 05 claims of one proven generation-2 write. Exactly one
claims it, with `attempts = 1`, the ledger DISPATCHING and the superseded IDs handed over. Green in 5 of 5 repeated
runs. VAL-RIS-010, two simultaneous decisions with one winner, stays green.

## 3. Final battery

The full suites ran on the tree of `68b22aa` plus the race test, which was later committed in `3bc6102`:

| Run | Exit | Files | Tests |
|---|---|---|---|
| `npx vitest run` (PGlite) | 1 | 36 passed, 1 failed, 3 skipped (40) | 411 passed, **1 failed**, 36 skipped (448) |
| `TEST_DATABASE_URL=… npx vitest run` (PGlite + PostgreSQL 17) | 1 | 36 passed, 1 failed, 3 skipped (40) | 775 passed, **2 failed**, 36 skipped (813) |

**The only failure.** It is the same assertion on each engine: `test/schema.test.ts:188`, the exact list of functions
the workflow role may execute. It omitted `wf_reissue_dispatch`, which P2-D1 grants on purpose
(`20261001200000`, line 70) so that 08 can call it through n8n's Postgres credential.
- The PUBLIC-execute assertion beside it (line 185) passed on both engines.
- VAL-RIS-014 already pinned the same 22 functions.
- It is a missed test expectation from D1, not a defect.

The pin was corrected in `3bc6102`. `test/schema.test.ts` was then re-run on both engines: **40 passed, 0 failed**.
Every other file was green in the full runs, and only that one test file changed afterwards. The full suites were not
re-run after the one-line fix.

| Check | Result |
|---|---|
| Lint, typecheck | exit 0, exit 0 (tree of `3bc6102`) |
| Fresh chain (throwaway PostgreSQL 17 database, then dropped) | 42 migrations from zero ending with `20261001210000`; import IMPORTED; second migrate 0 applied / 42 skipped |
| Integrity | 27 PASS, 5 WARNING (`accepted_has_project`, `completed_awaiting_completion_items`, `every_project_linked`, `open`, `recent`), **0 FAIL**; `reissue_transition_bound` PASS |
| Grants | `roofops_workflow` runs 22 functions, all `wf_*`, including `wf_reissue_dispatch`; `roofops_dashboard` cannot run it; the dashboard definer list is unchanged (8); no function executable by PUBLIC; no table without RLS. `wf_claim_side_effect`, `wf_complete_side_effect`, `wf_reissue_dispatch`, `xero_reissue_proof`, `xero_draft_payload` are SECURITY DEFINER with `search_path=public, pg_temp` |
| `scripts/security-check.ts`, run locally on the fresh database | A scratch copy whose only change is the connection line, never pointed at the hosted URL. **14 of 14 local-applicable checks pass**, including "reissue functions: executable by an app role / PUBLIC" (none), pinned `search_path`, SECURITY DEFINER, and "reissue dispatch token stored only as a hash (or unset)". 2 checks fail only because they read hosted-only configuration that a fresh database leaves blank: "Xero writes pinned to the proven Demo tenant" (`""`) and "reconcile trigger token stored only as a hash" (`"0"`). Both passed hosted at the AC-14 deploy and must be re-confirmed there |
| Working tree | Only the intended files changed; local HEAD = `origin/factory/ac14-integrity-followup` after each push |

## 4. Review findings (integration and security), no code change made

1. **No four-eyes rule (owner decision; pre-existing B2 design).** One FINANCE or ADMIN employee may both request and
   decide a reissue; the B2 tests rely on it. With `--hosted`, `--by` is self-asserted, so the real trust boundary is
   possession of the hosted owner database credentials. Requiring a different decider would be a small change to
   `ops_reissue_decide`. It is not made here, because it is a policy decision.
2. **The token appears in n8n execution data.** 08's webhook node output (its headers) and its Read Request output hold
   the token in plain text in n8n's execution history. 07's reconcile trigger behaves the same way, so this is not new.
   Hosted step: review the execution-data saving setting for 08 (and 07), and rotate the token after the Demo proof.
3. **Dispatch is global.** 08 dispatches every due, proven generation ≥ 2 write, not only the invoice passed to
   `--invoice` (that is the one the CLI waits for). Each write is still re-proven by 05's claim. For the Demo proof
   there is one.
4. **Two workflows numbered 08.** `[RoofOps] 08 Health Checks` (`roofops-health`) and `[RoofOps] 08 Reissue Dispatch`
   (`roofops-reissue-dispatch`) have distinct keys and names, so nothing collides technically, but operators may
   confuse them. Renaming to 09 would leave migration `20261001200000`'s comment ("n8n 08") stale, and an applied
   migration must not be edited. Left as is; the owner may choose to rename.
5. **05's caller policy lives in n8n, not in the repo.** 05's trigger is passthrough and takes `{ xero_key }`. If 05's
   n8n setting "This workflow can be called by" is restricted to 04's ID, 08's calls will be refused. Hosted
   pre-check.
6. **Uncertain generation-2 recovery.** `wf_reconcile_xero_uncertain` (B1, `20261001150000`, lines 735/740) excludes
   superseded InvoiceIDs.
   - A lookup that finds only the superseded document gives PROVEN_ABSENT and the write fails safely; VAL-GEN-008
     proves this.
   - A superseded document that is live again, or an unknown document with the number, gives NEEDS_PERSON.
   - What a person does after a generation-2 PROVEN_ABSENT follows the generation-1 (AC-04) path. It is not exercised
     end to end for generation 2 here.
7. **Configuration.** `.env.local` has `SUPABASE_DB_URL`, `N8N_BASE_URL`, `N8N_API_KEY` and `RECONCILE_TRIGGER_TOKEN`.
   It does **not** have `REISSUE_DISPATCH_TOKEN` (placeholder added to `.env.example`) or `SUPABASE_CA_CERT`, so hosted
   TLS is encrypted but the certificate is not verified, as in earlier hosted runs. Key presence was checked without
   printing values.

## 5. Hosted deployment (not done; each step needs the owner's go-ahead)

The hosted database has 33 migrations: through `20261001120000`, verified at the AC-14 deploy, `6b90dbe`. Pending
since then:
- **9 migrations:** `130000` (AC-14B), `140000`–`170000` (AC-14C A/B1/B2) and `180000`–`210000` (this follow-up).
- **2 workflow changes:** `n8n/05-xero-draft-invoice.sdk.ts` (republish) and `n8n/08-reissue-dispatch.sdk.ts` (new).
- No other n8n file changed.

**Order.** Both orders are safe, because:
- the new 05 behaves exactly as before against the old database (no `generation` key in its claim result means the
  generation-1 path);
- the new database gives an unchanged generation-1 claim result to the old 05;
- no generation ≥ 2 write can exist until `ops_reissue_decide` runs.

The database goes first because AC-14B/C need it too.

0. **Read-only pre-flight.**
   - `npm run security:check` and `npm run integrity:check`: baseline.
   - Hosted migration list = 33, checksums match the repo.
   - The live 05 nodes equal the repo at `6b90dbe`. Record 05's current n8n version ID for rollback.
   - 05's caller policy (§4.5).
   - No `REISSUE_INVOICE` approval or generation ≥ 2 outbox row exists (none can before `170000`).
1. **Migrations.** Apply the 9 in order, alone, with the mechanism used for AC-14. Then:
   - migration checksums 42 of 42;
   - `npm run integrity:check`: 0 FAIL, `reissue_transition_bound` PASS;
   - `npm run security:check`: all pass, including the reissue and dispatch-token checks.
   No repair run.
2. **05.** Update workflow `Y2deCFTZzpv1uo8C` from the repo file and publish. Confirm the live nodes equal the repo.
3. **08.** Create `[RoofOps] 08 Reissue Dispatch` from the repo file with the RoofOps Postgres credential
   (`kWqjtv0gz7ref2EN`, the `roofops_workflow` login) and 05's ID, then publish. The webhook path is
   `roofops/reissue/dispatch`.
4. **Token.** Generate a random token locally and put it in `.env.local` as `REISSUE_DISPATCH_TOKEN`. Store only
   `encode(sha256(convert_to(<token>, 'UTF8')), 'hex')` in hosted `app_settings.reissue.dispatch_token_sha256`. Re-run
   `npm run security:check`.
5. **Smoke test, no Xero write.** Run `npm run reissue -- dispatch --invoice INV-2026-0039 --hosted`. INV-2026-0039 is
   generation 1, so the expected result is `NO_REISSUE_QUEUED` and nothing triggered. A wrong token sent by hand to the
   webhook leaves 08's execution showing `TOKEN_REFUSED` and nothing dispatched.

**Rollback.**
- **Kill switch first:** set `reissue.dispatch_token_sha256 = ''`. Every dispatch is then refused, while 05's claim
  still refuses any unproven generation ≥ 2.
- **Unpublish 08.**
- **05:** restore the recorded previous version in n8n. Safe against the new database for generation 1.
- **The migrations** change functions, grants and one setting, not tables or rows. Rolling them back would mean a new
  forward migration restoring the earlier function bodies, and that reopens H1/H2/D2, so it is not recommended.
  Disabling dispatch is the safe lever.
- **Partial state:** a reissue decided but not dispatched is visible with `npm run reissue -- status --hosted` and stays
  queued; nothing reaches Xero.

## 6. Xero Demo proof, P2-D4 (not done; needs the owner's approval for each Xero action)

Purpose: prove, in the pinned Xero **Demo Company (AU)** tenant only, that a voided or deleted final can be replaced
with the **same invoice number** and a new InvoiceID, and that the stale document never controls it. Two facts are
unknown and are checked here. The public Xero API specification lists DELETED and VOIDED statuses and returns them by
ID, but does not state:
- whether a number search returns them;
- whether Xero accepts a new ACCREC invoice whose number equals a voided or deleted one.

05 is fail-safe either way:
- a missing predecessor is skipped;
- a present predecessor is filtered as superseded;
- if Xero rejects the number, the write fails and is reported `REISSUE_NOT_CREATED` with Xero's error; nothing is
  linked.

**Subject (owner decision).** Recommended: a disposable synthetic final for a test project, created through the normal
approval → 04 → 05 path, so that INV-2026-0039 (PRJ-2026-0004's real Demo draft) is not touched. The alternative is
INV-2026-0039 itself.

**Steps.**
1. The subject's generation 1 exists in Xero Demo as a DRAFT, linked and SYNCED. Note its InvoiceID and number.
2. **Xero action (approval needed):** delete the DRAFT in Xero Demo, or void it if it has been authorised.
3. `npm run reconcile` (repair, one run; counts against the Airtable quota) records a VERIFIED DELETED/VOIDED read. The
   invoice becomes VOIDED with no money moved.
4. `npm run reissue -- request --invoice <INV> --by <FINANCE> --reason "…" --hosted` gives `REISSUE_REQUESTED`. Then
   `decide --approval <APR> --by <FINANCE> --hosted` gives `REISSUE_QUEUED`, generation 2. `status --hosted` shows
   generation 2 PENDING, link = the old InvoiceID.
5. `npm run reissue -- dispatch --invoice <INV> --hosted`, then 08 → 05.
   - **Pass:** `REISSUE_CREATED`. Xero Demo has a new DRAFT with the **same number**, a new InvoiceID, the same
     reference and contact, the same totals as the approved draft, in the pinned tenant. The old document stays
     DELETED/VOIDED.
   - RoofOps shows the link moved to the new InvoiceID, the ledger `[1 SUPERSEDED, 2 CREATED]`, the invoice
     APPROVED/SYNCED.
6. `npm run reconcile -- --dry-run` gives 0 drift for the subject, and the read is of the generation-2 InvoiceID. Then
   `npm run integrity:check` (0 FAIL) and `npm run security:check`.
7. **Negative checks, no Xero write:**
   - a second `dispatch` gives `REISSUE_CREATED` without triggering;
   - `decide` replay gives `ALREADY_PROCESSED`;
   - the old InvoiceID can never be completed for generation 2 (proved offline; observed live only if it arises).
8. **If Xero rejects the duplicate number:** the expected result is `REISSUE_NOT_CREATED`, with Xero's validation
   message in `last_error` / `open_exceptions` and nothing linked. Confirm with `status --hosted`. Stop and take it to the owner, because a same-number
   replacement would not be possible in Xero and the design decision (a suffixed number, or a credit note) belongs to
   the owner.
9. **Clean-up (owner decides):** keep the Demo documents as evidence. Rotate `REISSUE_DISPATCH_TOKEN` afterwards
   (§4.2).
