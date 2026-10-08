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

  These four (and the release gate's `220000`) redefine functions, change grants and insert one setting
  (`reissue.dispatch_token_sha256 = ''`,
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
3. **Dispatch was global. Fixed at the release gate (`18be673`, §7).** 08 dispatched every due, proven generation ≥ 2
   write, not only the invoice passed to `--invoice`. A dispatch now names exactly one invoice and generation, and
   nothing else can be listed.
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
- **10 migrations:** `130000` (AC-14B), `140000`–`170000` (AC-14C A/B1/B2), `180000`–`210000` (this follow-up) and
  `220000` (the release gate). `150000` and `170000` change schema and data; see §7.1 for each migration's impact and
  rollback.
- **2 workflow changes:** `n8n/05-xero-draft-invoice.sdk.ts` (republish) and `n8n/08-reissue-dispatch.sdk.ts` (new).
- No other n8n file changed.

**Order.** Both orders are safe, because:
- the new 05 behaves exactly as before against the old database (no `generation` key in its claim result means the
  generation-1 path);
- the new database gives an unchanged generation-1 claim result to the old 05;
- no generation ≥ 2 write can exist until `ops_reissue_decide` runs.

The database goes first because AC-14B/C need it too.

0. **Read-only pre-flight:** the ten checks in §7.1, plus the `security:check` and `integrity:check` baselines.
1. **Migrations.** `npm run db:load -- --hosted` applies the 10 in order, each in its own transaction, stopping at the
   first failure. Then:
   - migration checksums 43 of 43;
   - `npm run integrity:check`: 0 FAIL, `reissue_transition_bound` PASS;
   - `npm run security:check`: all pass, including the reissue and dispatch-token checks.
   No repair run.
2. **05.** Update workflow `Y2deCFTZzpv1uo8C` from the repo file and publish. Confirm the live nodes equal the repo.
3. **08.** Create `[RoofOps] 08 Reissue Dispatch` from the repo file with the RoofOps Postgres credential
   (`kWqjtv0gz7ref2EN`, the `roofops_workflow` login) and 05's ID. **Before publishing**, set its execution-saving
   settings to "Do not save" (§7.3), then publish. The webhook path is `roofops/reissue/dispatch`.
4. **Token.** Generate a random token locally and put it in `.env.local` as `REISSUE_DISPATCH_TOKEN`. Store only
   `encode(sha256(convert_to(<token>, 'UTF8')), 'hex')` in hosted `app_settings.reissue.dispatch_token_sha256`. Re-run
   `npm run security:check`.
5. **Smoke test, no Xero write.** Run `npm run reissue -- dispatch --invoice INV-2026-0039 --hosted`. INV-2026-0039 is
   generation 1, so the expected result is `NO_REISSUE_QUEUED` and nothing triggered. A wrong token, or no selection,
   sent by hand to the webhook dispatches nothing. 08's execution list then holds no saved execution data (§7.3).

**Rollback.**
- **Kill switch first:** set `reissue.dispatch_token_sha256 = ''`. Every dispatch is then refused, while 05's claim
  still refuses any unproven generation ≥ 2.
- **Unpublish 08.**
- **05:** restore the recorded previous version in n8n. That is safe for generation 1. With a generation-2 write, the
  old 05 either refuses the same-numbered VOIDED/DELETED document (a person decides) or, if Xero's search does not
  return it, creates the replacement, which Postgres's claim and completion still re-prove.
- **The migrations: corrected at the release gate (§7.1).** `180000`–`220000` change only functions, grants and one
  setting. `150000` and `170000` change schema and data, so their rollback is destructive and is not recommended once
  any reissue exists. Disabling dispatch is the safe lever.
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

## 7. Release-readiness gate (before any hosted step)

**Correction to §5.** §5's rollback said the migrations "change functions, grants and one setting, not tables or rows".
That is true only of `180000`–`210000` (and of `220000` below). It is **false for the deployment as a whole**:
- `150000` and `170000` change schema and data;
- `140000` and `160000` change behaviour that hosted runs and the dashboard already rely on.

The migration-by-migration table below replaces it.

**Release-gate change, `18be673` (`20261001220000_reissue_dispatch_is_explicitly_selected.sql`).**
`wf_reissue_dispatch(token, invoice_number, generation, worker)` replaces the `(token, worker)` form, which is dropped.
- It lists at most the one write the operator named, and only when that write is the invoice's current generation ≥ 2,
  due and proven. Every other case lists nothing.
- 08 reads `{ invoice_number, generation }` from the request body and hands 05 only a write matching it.
- `npm run reissue -- dispatch` sends the selection read from the invoice's current generation.

Proof, both engines:
- With two queued, proven reissues A and B, selecting A lists only A. 08's real nodes hand 05 only A. A is claimed while
  B stays PENDING with 0 attempts.
- Every malformed selection lists nothing.
- A replayed generation-1 approval through 04 (`ALREADY_PROCESSED`) sends only generation 1's DONE key; this is pinned
  with 04's real Normalise code.

5 ablations, all red: generation check removed; selection ignored; 08 dropping the body; the CLI sending no selection;
04 preferring the pending key.

No other path reaches 05: only 04 (generation 1 only) and 08 call it, and nothing sweeps the outbox.

### 7.1 The ten pending hosted migrations

Hosted is at `20261001120000` (33 migrations). The runner (`npm run db:load -- --hosted`, `src/db/migrate.ts`) applies
every pending file in order, each in its own transaction, and stops at the first failure. It then runs the idempotent
bundle import.

| Migration | What it changes on hosted | Data-dependent failure risk | Rollback |
|---|---|---|---|
| `130000` AC-14B | `integrity_check()` only (a verified Xero void is not an AC-05 failure) | none | redefine the previous `integrity_check()` (forward migration); harmless to keep |
| `140000` AC-14C A | Functions: `xero_settlement_status`, `xero_record_settlement`, `invoice_financial_state`, `invoice_void_guard`, `integrity_check`. **Behaviour:** a VERIFIED DELETED read with no money now voids the invoice in a **repair** run (observe runs only record) | none at migration time | forward migration restoring the old bodies; any invoice already voided by it stays voided (a person reissues it) |
| `150000` AC-14C B1 | **Schema:** `outbox.generation` (int not null default 1) and a check; unique indexes `outbox_one_row_per_draft_generation` and `outbox_one_live_draft_per_invoice`; **new table** `invoice_xero_draft_generations` (RLS on), **backfilled from every existing draft write**; **three triggers** (outbox insert, outbox status update, invoices sync_status update) that keep the ledger; `v_airtable_expected` replaced (the invoice number now reads the newest generation; with one write per invoice the output is identical, so no Airtable drift); several functions (`wf_invoice_decide_core`, `xero_record_settlement`, `wf_reconcile_*`, `invoice_void_guard`, `invoice_xero_state`, `integrity_check`) | **Yes.** Index creation fails, rolling the migration back and stopping the deploy, if any invoice has two `xero.create_draft_invoice` rows, or two PENDING/DISPATCHING ones (pre-flight 2–3) | Destructive and **not recommended** once any reissue exists: drop the triggers, the table, the indexes and the column. Before any reissue it is mechanical but loses nothing |
| `160000` AC-14C B1b | `v_invoice_balances` replaced: a VOIDED invoice shows outstanding 0 and is never overdue (dashboard money owed changes for voided invoices only) | none | redefine the previous view |
| `170000` AC-14C B2 | **Data:** setting `invoice.reissue_roles = FINANCE,ADMIN`; 2 `state_transitions` rows; `state_machine_states` VOIDED no longer terminal. **Schema:** the `approvals_action_type_check` CHECK is dropped and re-added (a strict superset, adding `REISSUE_INVOICE`; validated against every approvals row); unique index `approvals_reissue_open_idx`; trigger `invoices_reissue_guard` (before update of status on invoices); functions `ops_reissue_*`, `invoice_reissue_*`, `invoice_void_guard`, `wf_complete_side_effect_core` | **Low.** It fails if the constraint has another name on hosted, or if an `action_type` outside the list exists (pre-flight 4–5) | Forward migration: drop the trigger, index and functions, restore the CHECK, and delete the 2 transition rows and the setting. **Refused if any REISSUE_INVOICE approval exists** |
| `180000` P2-H1 | `invoice_reissue_guard()` and `integrity_check()` only | none | do not roll back (reopens H1) |
| `190000` P2-H2 | Functions: `xero_draft_payload`, `wf_invoice_decide_core` (generation 1 now built by the builder and refused if it differs from the approved preview), `invoice_reissue_preview`, `ops_reissue_decide`, guard, `integrity_check` | none at migration time. **Live behaviour:** a generation-1 approval whose stored preview disagrees with canonical truth is refused (correct, but watch the first live approval) | do not roll back (reopens H2) |
| `200000` P2-D1 | Setting `reissue.dispatch_token_sha256 = ''` (`on conflict do nothing`); `xero_reissue_proof`, `wf_reissue_dispatch(text,text)` (replaced by `220000`); grants | none | the kill switch: keep the setting `''` |
| `210000` P2-D2 | `wf_claim_side_effect`, `wf_complete_side_effect` (generation 1 result unchanged) | none | do not roll back (reopens D2) |
| `220000` gate | drops `wf_reissue_dispatch(text,text)`; creates `wf_reissue_dispatch(text,text,int,text)`; grants | none | n/a |

**Operational rollback.**
- Keep the schema.
- Disable dispatch by leaving `reissue.dispatch_token_sha256 = ''`.
- Unpublish 08.
- Restore 05's recorded version. That is safe both ways (?5): with a generation-2 write, the old 05 either refuses the
  same-numbered VOIDED/DELETED document or creates the replacement that Postgres re-proves. Nothing is duplicated.

**Read-only pre-flight on hosted** (each needs the owner's go-ahead):
1. `schema_migrations` holds 33 rows ending `20261001120000`, with checksums equal to the repo.
2. `select aggregate_id from outbox where topic = 'xero.create_draft_invoice' group by 1 having count(*) > 1` gives 0
   rows.
3. The same with `and status in ('PENDING','DISPATCHING')` gives 0 rows.
4. `approvals_action_type_check` exists on `approvals`.
5. `select distinct action_type from approvals` gives values within the old list.
6. No outbox row is PENDING or DISPATCHING, so nothing is in flight during the deploy.
7. Snapshot `v_invoice_balances` for VOIDED invoices and the integrity and security baselines.
8. `xero.demo_tenant_id = 96643bb0-3a0a-406e-96fb-ab8a933ee6b8` and the reconcile token hash has length 64. **None of
   the ten migrations writes either key** (every reference is a read), so the two hosted-only security checks are
   expected to keep passing; confirm by `npm run security:check` before and after.
9. 05's live nodes compared with the repo at `becd3c1`, the last commit before D2. Only two commits ever touched 05
   (`becd3c1`, `0b9cc23`), and the repo records **no** live n8n version ID for 05. Record the active version ID, which
   is the rollback target.
10. 05's "This workflow can be called by" setting allows 08.

### 7.2 Operator identity (`--by`)

**Today.** `ops_reissue_request` and `ops_reissue_decide` check that `--by` names an active employee in
`invoice.reissue_roles`, and the audit trail records that code. Nothing authenticates the person.
- With `--hosted` the CLI uses `SUPABASE_DB_URL`, the database **owner**.
- Whoever holds that URL can type any employee code.
- As owner they can also bypass triggers outright (`session_replication_role`). No database rule can constrain the
  owner credential, so identity cannot be trusted while reissues run on it.
- There is also no four-eyes rule: the same person may request and decide.

**Minimal trustworthy option, fitting the existing architecture:** per-person database logins.
- One `LOGIN` role per FINANCE/ADMIN person, each a member of a `NOLOGIN` group `roofops_reissue_operator`.
- The group is granted EXECUTE on `ops_reissue_request` / `ops_reissue_decide` and on a SECURITY DEFINER status read,
  and nothing else, so it needs no table access.
- The login is mapped to the employee in `employee_external_identities`. That needs provider `POSTGRES` added to its
  CHECK.
- The functions derive the actor from `session_user` and refuse a mismatched `--by`. The decider may optionally be
  required to differ from the requester.
- The CLI takes the person's own URL (for example `REISSUE_DB_URL`) instead of the owner URL, and the owner credential
  stays with deployment.
- Cost: one migration, the CLI variable, a `security:check` rule and tests.

The alternative is Airtable as the authenticated surface. Airtable already authenticates invoice approvals (AC-03:
the webhook's Airtable user maps to an employee), but extending it to reissues is a larger feature.

**For the supervised Demo test only**, these are acceptable if the owner accepts them explicitly:
- the owner personally runs every command;
- `--by` is the synthetic demo approver EMP-900, already mapped to the owner's Airtable user;
- `SUPABASE_DB_URL` is held by the owner alone;
- the data is synthetic.

**Not acceptable for staff use.**

### 7.3 Token retention in n8n

Since n8n 1.0, every successful, failed and manual execution is saved by default (n8n docs, "Execution data
retention"). 08's webhook trigger output contains the request headers, which include `x-roofops-token`, and Read
Request's output contains the token, so the token is retained in 08's execution history. 07 already does the same with
`RECONCILE_TRIGGER_TOKEN`.

The control is per-workflow and lives in n8n, not in the repo. The repo's recorder shim cannot show whether the real
`@n8n/workflow-sdk` accepts settings. For 08 (and, recommended, 07), set:
- Save successful production executions: **Do not save**
- Save failed production executions: **Do not save**
- Save manual executions: **Do not save**
- Save execution progress: **Do not save**

Then generate the dispatch token. Rotate the reconcile token, because earlier 07 executions may hold it.

Verification is hosted only: after the smoke dispatch, 08's execution list holds no saved execution data. Outcomes
remain visible in Postgres (the outbox, ledger and exceptions) and in 05's own executions, which never receive the
token.

### 7.4 Gate battery (committed code `18be673`; local only)

| Check | Result |
|---|---|
| Full suite, PGlite | exit 0: 37 files passed, 3 skipped (40); **414 passed, 0 failed, 36 skipped** (450) |
| Full suite, PGlite + PostgreSQL 17 | exit 0: 37 files passed, 3 skipped (40); **781 passed, 0 failed, 36 skipped** (817) |
| Lint, typecheck | exit 0, exit 0 |
| Fresh chain | 43 migrations from zero ending with `20261001220000`; second migrate 0 applied / 43 skipped; integrity 27 PASS / 5 WARNING / 0 FAIL, `reissue_transition_bound` PASS |
| Grants | `roofops_workflow` 22 functions (only the 4-argument `wf_reissue_dispatch` exists); `roofops_dashboard` cannot run it; all reissue functions SECURITY DEFINER with a pinned `search_path` |
| `scripts/security-check.ts`, run locally | 14 of 14 local-applicable checks pass; the 2 hosted-only checks read blank values locally (?7.1 item 8) |
| Working tree | clean after each run; local HEAD = `origin/factory/ac14-integrity-followup` |
