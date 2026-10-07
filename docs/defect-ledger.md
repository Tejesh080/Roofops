# Defect ledger

We work on one defect at a time, in the order the owner sets. Source hypotheses: [adversarial-test-catalogue.md](adversarial-test-catalogue.md).
A defect is **Fixed** only after its live verification. Until then, a defect that passes every offline check is
**Fixed offline**.

Order: AC-01 → AC-02 → AC-10 → AC-03 → AC-05 → AC-06 → AC-04 → AC-08 → AC-09 → AC-13A → AC-14 → AC-13B (each started
only on instruction).

| ID | Severity | Hypothesis | Reproduced? | Reproduction evidence | Root cause | Violated invariant | Regression test | Fix | Integration verification | Live verification needed? | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| AC-01 | P0 | The reconciler replays an Airtable read that is older than a webhook edit, reverting the staff member's edit | **Yes**, offline (PGlite and Postgres 17) | Probe `ws07/p2_stale_snapshot.mts` plus 2 failing tests (below) | Replays had no observation time and were exempt from the webhook path's stale and compare-and-set checks | An Airtable read is evidence only if canonical has not changed since the read | `test/state-integrity.test.ts:376`, `:396`, plus race tests `:485`, `:520` (two Postgres connections) | Migration `20260930000000_reconcile_never_replays_stale_reads.sql` | Migration chain clean from zero; 314 tests pass on PGlite and Postgres 17; lint, typecheck clean; integrity 0 FAIL on canonical local and hosted; **deployed to hosted**; hosted dry-run 0 drift | Done 2026-10-01 (§12): hosted repair run, then the controlled live test on PRJ-2026-0029, with [evidence/ac01-live-verification.json](../evidence/ac01-live-verification.json) | **FIXED** |
| AC-02 | P0 | A missing or reshaped Airtable field is replayed as a staff edit | **Yes**, offline (PGlite and Postgres 17) | 5 failing tests that emulate real Airtable reads: keys omitted, dates as UTC instants, one field changed on 8 records (below) | The reconciler read an absent key as "blank", compared date instants as text and cast them to their UTC date, and had no notion of a field-level change | A field missing from a whole read is not evidence; a date is the Brisbane business day it denotes; one field changing on many records at once is not N staff edits | `test/state-integrity.test.ts:427`, `:449`, `:458`, `:473`, `:490`, plus bulk-edit tests `:511` (legitimate, via webhook) and `:535` (missed, ambiguous) | Migration `20260930010000_reconcile_field_shape_guards.sql` | Chain from zero on PostgreSQL 17.11; 328 tests pass on PGlite and Postgres 17; red without the fix, green with it; each part ablated turns its own tests red; lint, typecheck clean; local integrity 0 FAIL; grants checked | Done 2026-10-01 (§10–§11): deployed alone; hosted dry-run 0 drift, 0 findings; integrity 0 FAIL; proven cell by cell against an independent read of the real base, with [evidence/ac02-live-verification.json](../evidence/ac02-live-verification.json) | **FIXED** |
| AC-10 | P0 | 06 applies its own stale correction back as a staff edit | **Yes**, offline (PGlite and Postgres 17), with a harness that replays 06's real batch order, Airtable's echo transactions and the cursor | Ping-pong: after one transient read-back failure and a staff edit, every run applied RoofOps's own write, flipping canonical, and the cursor never advanced. Related: a staff member's fix of their own refused edit was refused as a conflict (below) | A correction is computed when 06 processes an item but written after later items; a landed-but-overtaken write never verifies; its echo passes compare-and-set; compare-and-set judged the staff member's `previous` against canonical, not against what Airtable showed | A value RoofOps wrote is never applied back as a staff edit; after the staff member's last edit, Airtable and canonical converge and every run advances the cursor | `test/state-integrity.test.ts:628`, `:650`, `:663`, `:685`, guard `:707`, echo-window tests `:729`, `:747`, retention `:764`; harness `Airtable06` `:62` | Migration `20261001000000_roofops_writes_are_not_staff_edits.sql` (+ one line in n8n 06, not yet deployed) | Chain from zero; 344 tests pass on PGlite and Postgres 17; red without the fix (7 of 8; the guard stays green); each of 7 parts ablated turns its own tests red; lint, typecheck clean; local integrity 0 FAIL; grants and RLS checked | Done 2026-10-01 (§10–§11): deployed alone; dry-run 0 drift, integrity 0 FAIL, security all pass. The live test on PRJ-2026-0029 reproduced the stale write for real and it converged: the fix was applied, the echo ignored, the cursor consumed, 0 drift, the hash chain intact, and the value restored. [evidence/ac10-live-verification.json](../evidence/ac10-live-verification.json). The 06 `origin` line is live and verified (§12) | **FIXED** (origin propagation live 2026-10-01, §12) |
| AC-03 | P0 | Airtable Approve is not bound to the row or preview the approver saw | **Yes**, offline (PGlite and Postgres 17), with events shaped exactly as n8n 04 sends them | 3 failing tests: an Approve approved a Copilot re-prepared preview never shown in Airtable, another project's preview (edited Project Number cell), and a preview prepared after the click | 04's decision names no approval; `wf_invoice_decide` found the project by the editable Project Number text and decided whatever was PENDING at processing time | An Airtable decision applies only to the sending record's project and to the preview a Prepare showed on that row before the decision; other sources must name the approval; a sent hash must match | `test/invoice-approval-binding.test.ts:68`, `:98`, `:117`, `:129`, guards `:85`, `:108` | Migration `20261001010000_invoice_decision_bound_to_row_and_preview.sql` (Postgres only; n8n unchanged) | Chain from zero; 356 tests pass on PGlite and Postgres 17; red without the fix (4 of 6; both guards green); each of 5 rules ablated turns its own test red; lint, typecheck clean; local integrity 0 FAIL; grants and RLS checked | Done 2026-10-01 (§10–§11): deployed alone; dry-run 0 drift, integrity 0 FAIL, security all pass. On PRJ-2026-0005 an Approve of a Copilot preview never shown on the row was refused, with nothing approved; Prepare then showed the same preview; the state was reset and 0 drift remained. [evidence/ac03-live-verification.json](../evidence/ac03-live-verification.json) | **FIXED** (exact-preview binding live 2026-10-01, §13) |
| AC-05 | P0 | Voiding an invoice does not cancel its queued Xero write | **Yes**, offline (PGlite and Postgres 17): approve, void, claim, complete | VOIDED + SYNCED, outbox DONE, Xero link; dashboard READY_TO_INVOICE, needs_attention false, integrity 0 FAIL | Nothing tied the outbox to the invoice status; claim and completion ignored it; the preview ignored voided finals | No Xero draft created, pending, ambiguous or linked for a VOIDED invoice; a voided final blocks the project for a person | `test/invoice-void.test.ts:65`, `:76`, `:86`, `:110` | Migration `20261001060000_voided_invoice_never_gets_a_xero_draft.sql` (Postgres only) | Chain from zero; 396 tests pass; red before (8 of 8); 5 ablations each red; lint, typecheck clean; local integrity 0 FAIL; grants checked | Done 2026-10-01 (§9–§10): deployed alone; dry-run 0 drift, integrity 0 FAIL (new check PASS), security all pass. A void of the SYNCED INV-2026-0039 on hosted was refused ("its Xero draft exists (RO-INV-2026-0039). Void or delete it in Xero first"); invoice, project, outbox, exceptions and Xero draft unchanged; 0 drift after. [evidence/ac05-live-verification.json](../evidence/ac05-live-verification.json) | **FIXED** |
| AC-06 | P0 | Unpinning the Xero tenant is not a kill switch | **Yes**, offline (PGlite and Postgres 17): approve under tenant A, then clear or re-point the pin, then claim and complete | With the pin empty, and with it re-pointed to B, the queued job was claimed (`claimed=true`), the proof from the old tenant was RECORDED and the invoice became SYNCED | Claim and completion trusted the tenant copied into the payload at approval and never re-read the pin; nothing stopped the pin moving while a write for it was open | A Xero write runs only against the tenant it was approved for; the pin cannot move while a write for it is unfinished; no pin change leaves a draft recorded as failed | `test/xero-tenant-binding.test.ts:97`, `:108`, `:118`, `:130`, `:146`, `:173`, `:185`, `:195`, `:216`, `:233` | Migration `20261001070000_xero_write_bound_to_its_tenant.sql` (Postgres only): pin guard, one advisory lock for pin changes and claims, claim re-check, fixed tenant, completion re-check | Chain from zero; red before (16 of 18); 14 ablations each red (lock ablations caught only by the two-connection races); AC-05 8 of 8; complete suite 424 passed, 0 failed; lint, typecheck clean; local integrity 0 FAIL; grants checked | Done 2026-10-04 (§10–§11): deployed alone; dry-run 0 drift, integrity 0 FAIL, security all pass. Rollback-only tests on INV-2026-0039: re-pointing its job refused; clearing or deleting the pin allowed only inside rolled-back transactions (its only write is DONE); nothing changed, 0 drift after. [evidence/ac06-live-verification.json](../evidence/ac06-live-verification.json) | **FIXED** |
| AC-04 | P0 | A Xero draft that exists is recorded as never created | **Yes**, offline (PGlite and Postgres 17), fake Xero answers: lost create answer, then 429s, then the dead letter; failures after the create; no reconciliation of uncertain writes | UNKNOWN downgraded to PENDING by a 429, then FAILED at the dead letter; post-create failures FAILED; nothing looked; AC-05 then allowed the void | `wf_fail_side_effect` judged by error class only and every dead letter became FAILED; reconciliation read only linked invoices | A timeout or transport failure after a create is never proof of absence: UNKNOWN until a read of Xero proves presence (link) or absence (then retry or fail safely); nothing guessed | `test/xero-ambiguous-create.test.ts` (cases 1–11, 2b), `test/reconcile-07-uncertain-xero.test.ts` (real 07 orchestration) | Migration `20261001080000_ambiguous_xero_create_stays_unknown.sql` + n8n 07: two read-only lookups (number, reference) per uncertain write in its bound tenant, settled by `wf_reconcile_xero_uncertain` | Chain from zero; red before (20/24 contract, 22/22 orchestration); every ablation red; AC-05 8/8, AC-06 18/18; full suite 470 passed, 0 failed; lint, typecheck clean; local integrity 0 FAIL; grants checked | Done 2026-10-04 (§9): the live lookup probe found RO-INV-2026-0039 once by number and once by reference in the pinned tenant (and exposed the SentToContact omission, fixed first); deployed alone + 07 published; dry-run 0 drift with the new path run (0 targets); INV-2026-0039 untouched; integrity 0 FAIL, security pass. [evidence/ac04-live-verification.json](../evidence/ac04-live-verification.json) | **FIXED** |
| AC-08 | P0 | Over-billed projects are labelled "Fully invoiced", with no flag, and can be closed | **Yes**, offline (PGlite and Postgres 17) and read-only on hosted: PRJ-2026-0006 and PRJ-2026-0008 billed above quote | FULLY_INVOICED, no blocker, needs_attention false (0006); Prepare says "nothing left to invoice"; once paid, CLOSED accepted | The preview lumped amount <= 0 together; the dashboard and the close guard treated that as fully invoiced | Billed <= quote + approved/invoiced variations at every stage; otherwise OVER_BILLED, needs attention, named excess, CLOSED refused until corrected | `test/over-billing.test.ts`; `test/dashboard.test.ts:34` corrected (it enshrined the defect) | Migration `20261001090000_over_billed_project_is_never_fully_invoiced.sql` (one rule `project_over_billing`; preview, close guard, dashboard view) + web label and Copilot refusal | Chain from zero (30); red before (12/16); 6 ablations each red; full suite 490 passed, 0 failed; lint, typecheck clean; local integrity 0 FAIL; grants checked | Done 2026-10-04 (§9–§10): tax basis proven (all GST-inclusive; new test, red on an ex-GST comparison); deployed alone; dry-run 0 drift, integrity 0 FAIL, security pass. Live via the web login and Copilot: PRJ-2026-0006 and PRJ-2026-0008 OVER_BILLED (over by 5,148.12 / 9,947.94), need attention, Prepare and Copilot refuse with the reason, rolled-back CLOSED refused; nothing persisted; duplicates left for a person; INV-2026-0039 untouched. [evidence/ac08-live-verification.json](../evidence/ac08-live-verification.json) | **FIXED** |
| AC-09 | P0 | The final invoice under-bills once a variation is marked INVOICED | **Yes**, offline (PGlite and Postgres 17): PRJ-2026-0004 with a 1,100.00 variation billed then marked INVOICED | Final 14,664.49 -> 13,564.49, exactly the variation short; AC-08 used a different entitlement (APPROVED + INVOICED). No real project affected (no variations local or hosted) | The preview added only APPROVED variations but subtracted every billed invoice incl. the variation's own VARIATION invoice | remaining_billable = (quote + APPROVED/INVOICED variations) - valid billed (APPROVED, ISSUED, PARTIALLY_PAID, PAID), GST-inclusive; final + prior valid invoices = entitlement exactly | `test/billing-entitlement.test.ts` (independent cents oracle; cases 1-13) | Migration `20261001100000_one_canonical_billing_entitlement.sql`: one `project_billing` used by the preview (so dashboard, close guard, Copilot, Prepare/decide), AC-08 over-billing, and a new integrity check | Chain from zero (31); red before (10/24); 9 ablations each red; AC-08/05/04 126/126; full suite 514 passed, 0 failed; lint, typecheck clean; local integrity 0 FAIL; grants checked | Done 2026-10-06 (§7): deployed alone; dry-run 0 drift, integrity 25 PASS / 0 FAIL (new check PASS), security pass. Ready amounts (PRJ-2026-0002 15,155.98, PRJ-2026-0005 17,831.91), OVER_BILLED excesses (5,148.12 / 9,947.94) and the billing view of all 33 projects unchanged; preview, dashboard and Copilot agree via the web login. Rolled-back catalogue case on both ready projects: the final stays whole when the variation moves APPROVED → INVOICED (the old formula: 1,100.00 short); nothing persisted, no Xero invoice; INV-2026-0039 untouched. [evidence/ac09-live-verification.json](../evidence/ac09-live-verification.json) | **FIXED** |
| AC-13A | P1 | Completion checklist has no editing surface, so new jobs can never be final-invoiced | **Yes**, offline (PGlite and Postgres 17): accept Q-2026-0041, walk PRJ-2026-0031 to Completed | Preview and Prepare MISSING_DOCUMENT forever; dashboard NOT_READY; close refused with "the final invoice has not been raised yet"; no function anywhere updates checklist status. Hosted: PRJ-2026-0007 stuck now (Completed, 25,587.26 left to bill); PRJ-2026-0031..0033 latent | The required COMPLETION items had no write path (field contract: "no staff UI; NOT SUPPORTED"); the preview checked paperwork before billing; the close guard judged by the preview's error class | Project and financial lifecycles never contradict: completion items change only through a supported, validated, attributed path; fully billed is billed whatever the paperwork; Closed = settled (project_billing remaining 0), paid, gate satisfied, no Xero write in flight | `test/project-lifecycle.test.ts` (cases 1-13), `test/n8n-completion-fields.test.ts` (06 and 03, real node code) | Airtable Projects: Completion Photos / Compliance Certificate + a Note each (additive); migration `20261001110000_completion_gate_has_a_supported_path.sql` (`checklist_apply_change` behind `wf_airtable_change`; projection; preview order; close guard; dashboard flag; 2 integrity checks); n8n 06 watches the fields, 03 writes them | Red before (13/13 + 5/5); 15 ablations each red; regressions 304/304; full suite 550 passed, 0 failed; lint, typecheck clean; fresh chain (AC-13A alone on AC-09: amounts unchanged); integrity 0 FAIL; grants checked | Done 2026-10-06 (§8): fields created and filled from the canonical checklist, migration alone, 06 + 03 published; dry-run 0 drift, integrity 0 FAIL, security pass; live through real Airtable on PRJ-2026-0031: a refused edit corrected and read back, an attributed Not applicable applied and reverted; billing, checklist, invoices, projects, INV-2026-0039 and fingerprint unchanged. [evidence/ac13a-live-verification.json](../evidence/ac13a-live-verification.json) | **FIXED** |
| AC-13B | P1 | Pre-start checklist (SWMS, material review) is not enforced on Scheduled → In Progress | – | – | – | – | – | – | – | – | Not started |
| AC-14 | P1 | A RoofOps final invoice paid (or voided) in Xero is never read back, so the project can never close | **Yes**, offline (PGlite and Postgres 17), with 07's real nodes and a fake Xero; on hosted read-only: PRJ-2026-0004 | A Xero-PAID final stays APPROVED; money owed never counts it; close refused "not every invoice is paid yet: INV-2026-0039 (approved)"; a Xero void cannot be followed (AC-05 guard says "void it in Xero first", nothing reads it back) | 07 re-read every linked invoice but compared only existence, total and reference; nothing maps Xero status or amounts to RoofOps; the close guard trusted the local status | RoofOps determines from verified Xero state (right tenant, linked invoice, amounts that add up) whether an invoice is not issued, unpaid, partially paid, paid, voided or ambiguous; closing uses only that, never a local flag | `test/xero-settlement.test.ts` (cases 1-14 + identity, arithmetic, DELETED, integrity); AC-13A lifecycle cases 7 and 12 corrected (they trusted a local PAID) | Migration `20261001120000_xero_verified_invoice_settlement.sql` (`xero_invoice_observations`, canonical mapping, `xero_record_settlement` behind `wf_reconcile_external`, verified void past the AC-05 guard, close guard and integrity on `invoice_financial_state`, balances from Xero); 07 reads with error handling and passes the verified fields | Red before (16/16); 16 ablations each red; regressions 315/315; full suite 582 passed, 0 failed; lint, typecheck clean; fresh chain (AC-14 alone: every project and balance unchanged); integrity 0 FAIL; grants checked | Done 2026-10-06 (§7): 07 published, then the migration alone; dry-run read INV-2026-0039 from Xero (DRAFT → NOT_ISSUED, RoofOps APPROVED, 0 drift) in its bound, pinned tenant; integrity 0 FAIL, security pass; PRJ-2026-0004 now blocked by "not issued in Xero yet"; rolled back: verified PAID lets it close, AC-04 UNKNOWN never applied, AC-05 local void refused, AC-06 wrong tenant refused; nothing written to Xero. [evidence/ac14-live-verification.json](../evidence/ac14-live-verification.json) | **FIXED** |
| AC-14B | P1 | AC-14's verified Xero void leaves the AC-05 integrity check red, so the correctness gate fails in a state the fix deliberately creates | **Yes**, offline (PGlite and Postgres 17): `test/xero-settlement.test.ts` case "5 + 13" (the real 07 nodes record a Xero VOIDED, the repair run applies `APPROVED → VOIDED`), then `select * from integrity_check()` | `FAIL voided_invoice_has_no_xero_write → INV-2026-0039` while `xero_invoice_state_verified` PASSes; `scripts/integrity-check.ts` exits 1 on any FAIL. Reproduced before the fix: cases 15, 16, 20 of the file red (3 failed, 19 passed) | AC-05's integrity predicate (`20261001060000:189`, carried verbatim into the wrapper at `20261001120000:381-388`) failed every `VOIDED`, RoofOps-origin invoice whose Xero write exists, may exist or is linked; AC-14 made that a reachable, designed state | A locally or bypass-voided invoice with an active or unexplained Xero side effect is a FAILURE; a RoofOps invoice voided because the exact linked Xero invoice was independently verified VOIDED in its bound tenant is VALID | `test/xero-settlement.test.ts` cases 15-20 (AC-14B); negative (a) stays covered by the `test/invoice-void.test.ts` safety net | Migration `20261001130000_xero_verified_void_is_not_an_integrity_failure.sql`: the same `integrity_check()` wrapper, only the AC-05 predicate and detail text change (an exemption mirroring `invoice_void_guard` - `VERIFIED / VOIDED`, bound tenant, the linked InvoiceID - plus "no later VERIFIED read of that linked invoice says otherwise"). Never an edit of an applied migration | Red before (3 of 22 in the file); 5 ablations each red; AC-05/06/04/14/13A/state-integrity 102 passed, 0 failed; full suite PGlite 314 passed / 35 skipped and PGlite + Postgres 17 594 passed / 35 skipped, 0 failed; lint, typecheck clean; fresh chain 34 migrations, integrity 26 PASS / 5 WARNING / 0 FAIL, `voided_invoice_has_no_xero_write` PASS; privileges unchanged (role sets identical with and without the migration). [evidence/ac14b-offline-verification.md](../evidence/ac14b-offline-verification.md) | Yes - **not deployed**; hosted, Supabase, Xero and Airtable untouched | **Fixed offline** |
| AC-14C | P1 | A Xero draft created and then DELETED in Xero is a dead end: the invoice stays APPROVED/SYNCED, an EXTERNAL_MISSING exception is opened, and the project can never close | **Yes**, offline (PGlite and Postgres 17): `test/xero-settlement.test.ts` case 21 runs 07's real nodes against a fake Xero and reads a VERIFIED DELETED | Red before the fix: cases 21, 22, 25, 26 red (8 failed, 46 passed, 54 tests; both engines) - the invoice stayed APPROVED after a VERIFIED DELETED read, and the only exception opened was `EXTERNAL_MISSING` whether or not money had moved | `xero_settlement_status('DELETED')` returned NULL, so `xero_record_settlement` hit `continue when v_target is null` and changed nothing; AC-05's integrity predicate and `invoice_void_guard` exempted only `settlement = 'VOIDED'` | A verified deletion with no money movement anywhere on the invoice is the same business state as a void and follows the same path (verified-only, repair-only, bound tenant and linked InvoiceID); a deletion that moved money is left to a person | `test/xero-settlement.test.ts` cases 21-26 (AC-14C); the "a person decides" behaviour now lives only in the guard-refusal path (case 22) | Migration `20261001140000_xero_deletion_follows_the_void_path.sql`: `xero_settlement_status('DELETED') -> 'VOIDED'`; the DELETED apply in `xero_record_settlement` with the zero-paid/credited + no-local-payment guard (else REQUIRES_HUMAN + RECONCILIATION_MISMATCH) and `voided_reason` "Deleted in Xero (verified by reconciliation run_key)"; `invoice_financial_state` honest for an applied deletion; `invoice_void_guard` and the AC-05 exemption extended to `settlement in ('VOIDED','DELETED')`, keeping AC-14B's ordering clause. Parts B1 and B2 add the draft-generation ledger with database-enforced one-live (`20261001150000`), the voided-balance read model (`20261001160000`) and the supervised reissue (`20261001170000`: `REISSUE_INVOICE` approvals, `ops_reissue_request`/`ops_reissue_decide`, `invoices_reissue_guard`, `VOIDED -> APPROVED` reachable only through the guard). Part C proves the full end-to-end recovery; all parts complete | Red before (4 of 6 new cases, both engines); 4 ablations each red; AC-05/06/04/13A/14/14B + billing + state integrity 243 passed / 5 skipped, 0 failed; full suite PGlite 319 passed / 35 skipped and PGlite + Postgres 17 604 passed / 35 skipped, 0 failed; lint, typecheck clean; fresh chain 35 migrations, integrity 26 PASS / 5 WARNING / 0 FAIL; privileges unchanged (role sets identical with and without the migration). [evidence/ac14c-partA-offline-verification.md](../evidence/ac14c-partA-offline-verification.md), [evidence/ac14c-partB1-offline-verification.md](../evidence/ac14c-partB1-offline-verification.md), [evidence/ac14c-partB2-offline-verification.md](../evidence/ac14c-partB2-offline-verification.md), [evidence/ac14c-partC-offline-verification.md](../evidence/ac14c-partC-offline-verification.md) (final battery on the frozen tree `3a12de4`: PGlite 370 passed / 36 skipped, PostgreSQL 17 dual 707 passed / 36 skipped, 0 failed; fresh chain 38 migrations + integrity 26 PASS / 5 WARNING / 0 FAIL; two-connection concurrency one-winner; additive-only migrations; local demo database refreshed from a backup) | Yes - **not deployed**; hosted, Supabase, Xero and Airtable untouched; parts A, B1, B2 and C complete | **Fixed offline** |
| LIFE-01 | P3 | The INVOICING checklist item "Final invoice approved" is created OPEN and never set, so the project page shows it "To do" after the final invoice is approved | Yes (found in AC-13A) | wf_quote_accepted inserts it; nothing updates it; no gate reads it | Display only | Checklist shows the invoice state RoofOps holds | – | – | – | – | Not started (tracked separately; cosmetic) |
| FIN-GST-01 | P2 | A multi-line final invoice (one with variation lines) can differ from Xero by one cent of GST | Not yet (found while fixing AC-09; tracked separately, not part of AC-09) | – | RoofOps rounds the final's GST once on the total; Xero may round per line | The GST RoofOps records equals the GST on the Xero draft | – | – | – | – | Not started (today a mismatch is refused at read-back and left UNKNOWN with an exception, AC-04; single-line finals, like the only real one, are unaffected) |
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

### 13. Follow-up: bound to the exact preview on the row (2026-10-01, owner-instructed)

**Why.** §7's "known limit" was real, and wider than timing. 20261001010000 counted a preview as shown when Postgres
answered the Prepare and never looked at the row itself. Reproduced offline (a temporary shim let the new tests run
against the old code; red run: 6 failed, each `expected { outcome: 'APPROVED' } to match { outcome: 'INVALID_STATE' }`).
Each of these approved:

- **`:147`** a preview 04 never wrote to the row (the Airtable write failed);
- **`:157`** a preview whose text a person edited on the row after it was shown (another amount);
- **`:188`** a preview a later outcome had already replaced on the row ("Not authorised").

**Fix.** Migration `20261001020000_invoice_decision_bound_to_exact_preview.sql`, plus three small n8n 04 changes.

1. **The marker.** `wf_invoice_prepare` returns `preview_marker` = `PREVIEW APR-… · #<first 16 hex of payload_hash>`,
   and 04's Compose writes it as the first words of Invoice Preview.
2. **A showing counts only when 04 proves it.** After the read-back, a new 04 step, "Record Preview Shown In
   Postgres", calls `wf_invoice_preview_verified(event, record, read-back text)`. It records the preview as shown
   (`approval_presentations.verified`, at the verified time) only if all of these hold:
   - the text carries that approval's marker and exact amount line;
   - the approval is PENDING;
   - the row is linked to the approval's project;
   - an Airtable Prepare on that same row returned that approval.

   Nothing is recorded at prepare time any more.
3. **A decision carries what the row shows.** A new 04 step, "Read Row Before Decide", reads the row, and Decide sends
   its Invoice Preview text as `displayed_preview`. `wf_invoice_decide` approves or rejects only if every one of these
   holds:
   - the record maps to the canonical project (§7);
   - the approval is still PENDING;
   - a verified showing exists on that row, earlier than the click;
   - the text shows exactly that approval's marker and amount.

   The refusal names what to do next (Prepare shows it again, no new approval).

**Tests.** `test/invoice-approval-binding.test.ts` has 10 tests, including the 3 above and `:168`: the read-back is
refused for no preview, another amount, another hash, another row, or no such Prepare. The 04 contract is simulated
once, in `test/helpers/airtable04.ts`, and used by the invoice, binding and demo tests. Existing fixtures changed as
follows, with no assertion changed:

- **`test/invoice.test.ts`:**
  - Airtable events go through the 04 simulation;
  - the malformed-event validation calls Postgres directly;
  - after a "not a mapped approver" refusal, which replaces the preview on the row, the approver presses Prepare
    again before approving, as the refusal says.
- **`test/schema.test.ts`:** the new 04 entry point is added to the explicit workflow allow-list.

**Ablations** (`test/invoice-approval-binding.test.ts`):

| Ablation | Red |
|---|---|
| A: no check of the row's text at the decision | `:157`, `:188` |
| B: showing recorded at prepare time | `:168` (`:147` stays refused by the text check: two independent defences) |
| C: read-back not checked for marker and amount | `:168` |
| D: read-back not tied to a Prepare on that row | `:168` |

**Verification.**
- Full suite 364 passed at this commit's stage; lint and typecheck clean.
- Fresh PostgreSQL 17 chain: 22 applied and 0 skipped; a re-run applied 0.
- Repo, local and hosted aligned through AC-03; the version is unique.

**Deploy.** The migration went to hosted alone (checksum `50dc7fdf…`), then 04: active version `fee94016…` replaced
`cd0b7552…`. The fingerprint was unchanged.

**Live, on PRJ-2026-0005** ([evidence/ac03-exact-preview-live-verification.json](../evidence/ac03-exact-preview-live-verification.json)):

| Step | Observed |
|---|---|
| Prepare | APR-2026-0010 prepared at 22:28:35Z. The row shows `PREVIEW APR-2026-0010 · #29299f54aa2fb08a` and $17,831.91. It was recorded as shown at 22:28:37Z, after 04's read-back |
| The preview text is edited on the row to $1,000.00, then Approve | **Refused** "does not show APR-2026-0010 ($17,831.91 inc GST) exactly as prepared". No invoice and no Xero write; the approval still PENDING (EXC-0019) |
| Prepare | `ALREADY_PENDING`: the true preview is back on the row |
| Reject | `REJECTED_BY_APPROVER`. This is the binding's accepting path end to end: marker written, read-back verified, row read before deciding, text sent. It runs without any Xero write; a real Approve would create a Demo draft and was not requested |
| After | Dry-run `RECON-20261001-083334-7076`: 0 drift. Integrity 0 FAIL, with the hash chain intact. Security all pass (the workflow role has 18 functions). Grants: only `roofops_workflow` can call `wf_invoice_preview_verified` |

**Remaining limit.** A decision is bound to the text 04 reads from the row when it processes the decision (seconds
after the click), together with a verified showing before the click. The webhook payload itself does not include the
preview cell (Airtable webhook specs cannot be changed without recreating the webhook). If the row changed between
the click and the read, the decision is refused, never widened: the read text must show exactly the pending approval,
verified before the click.

### 14. Follow-up: `demo:reset` puts the Airtable invoice projection back (2026-10-01, owner-instructed)

**Before.** `demo:reset` withdrew the demo preview in Postgres only. The Airtable row kept "Awaiting approval", the
amount and the preview text, so reconciliation reported drift (`RECON-20261001-075518-c2e2`), and the script printed
"clear it by hand". Local scripts hold no Airtable credential, by design; every Airtable write goes through n8n.

**Fix.** Migration `20261001030000_demo_reset_restores_airtable_projection.sql`, one small n8n 07 change, and the
scripts.

1. **Scoped repair runs.** `wf_reconcile_start` accepts a `scope` of kind `invoice_projection_reset` for one project.
   It is refused unless all of these hold:
   - it is a manual repair run, with the operator token;
   - the project has a linked Airtable row;
   - the project has no pending preview and no non-void FINAL invoice.

   Other scopes are refused. 07 passes the request's `scope` through: Read Request, then Start Reconciliation Run.
2. **The scoped comparison touches one row's invoice fields and nothing else.** It compares that row's Invoice Status,
   Invoice Amount and Invoice Preview with blank, and records a `REPAIRED_AIRTABLE` finding and a blank correction for
   each non-blank one. The correction is recorded as a RoofOps write. It never touches other rows or fields, never
   replays staff edits, and checks no Drive or Xero objects (`wf_reconcile_targets` returns none). 07 PATCHes and
   reads back, and `wf_airtable_writeback_verified` proves it, like any repair.
3. **`npm run demo:reset`.**
   1. It withdraws the preview in Postgres, as before.
   2. It asks 07 for the scoped run (`src/ops/reconcile-run.ts`, shared with `npm run reconcile`), waiting out the
      2-minute quota guard if needed.
   3. It reports what was cleared, read back and proved.

   If the project has an invoice, it leaves Airtable alone. The manual note is gone.

**Tests.** `test/demo-reset-airtable.test.ts`, on PGlite and Postgres 17, is red before the fix (the capability did
not exist). It covers the full offline path:

- a preview is shown on the row and `demoReset` withdraws it;
- a scoped run corrects exactly the three fields of that row, and not PRJ-2026-0009's unrelated missed edit;
- the read-back proves, and the run finishes with 3 `REPAIRED_AIRTABLE` findings;
- an unscoped dry-run is then clean;
- refusals: a preview in flight, no token (schedule), an unknown scope.

Ablations: without the scoped comparison, the first test fails (it runs as a full run); without the "nothing in
flight" rule, the refusal test fails.

**Verification.**
- Full suite 370 passed; lint and typecheck clean.
- Fresh chain: 23 applied, 0 skipped on re-run.
- Parity aligned; the version is unique.

**Deploy.** The migration went to hosted alone (`38314d19…`), then 07 (active version `63ce5cab…`). The fingerprint
was unchanged.

**Live, on PRJ-2026-0005** ([evidence/demo-reset-airtable-live-verification.json](../evidence/demo-reset-airtable-live-verification.json)):

| Step | Observed |
|---|---|
| Airtable Prepare | APR-2026-0011; the row shows "Awaiting approval", $17,831.91 and the preview |
| One `npm run demo:reset` | Withdrew APR-2026-0011 (audited). Then `RECON-20261001-084719-73a5`, a scoped repair: Invoice Amount, Invoice Preview and Invoice Status cleared, read back and proved |
| Airtable read | All three invoice fields blank; Project Number, Status and Planned Completion untouched |
| `demo:reset` again, inside the quota window | Waited 72 s for the guard. `RECON-20261001-085230-dfe4`: "already clear". Idempotent |
| After | Unscoped dry-run through the updated 07 (`RECON-20261001-085021-de9b`): 0 drift across Airtable, Drive and Xero. Integrity 0 FAIL, with the hash chain intact. Security all pass. Dashboard and Copilot: "Ready to invoice". Fingerprint unchanged |

**Found while testing.**
- **Fixed.** `npm run reconcile` misreported a quota-guard refusal as "token refused" when the 2-minute window closed
  during its 30 s wait. The shared helper now judges the guard at request time.
- **Not changed here (pre-existing).** The daily scheduled 07 runs on 2026-09-30 and 2026-10-01 (n8n 1847, 1899)
  stopped at Find Drive Root: Google Drive answered HTTP 403, per-minute rate limit. That was after their Airtable
  comparison (0 drift); the next run supersedes the unfinished one.

### 15. Follow-up: supported, audited exception resolution (2026-10-01, owner-instructed)

**Before.** An exception could only be closed by editing `workflow_exceptions` with SQL (`ops/*.sql` through
`scripts/sql.ts`): no check of who, no required reason, no audit row. EXC-0018 and EXC-0019, the live refusals from
§11 and §13, stayed OPEN, and the Copilot kept reporting them. `test/exception-resolution.test.ts` was red: there was
no supported path.

**Fix.** Migration `20261001040000_supported_exception_resolution.sql`, `scripts/exception.ts` and
`npm run exception:resolve -- EXC-NNNN --by EMP-NNN --note "why"`.

- **`ops_resolve_exception(exception, employee, note)` refuses unless all of these hold:**
  - the note says why (at least 10 characters);
  - the employee is known and active;
  - their role is in `app_settings exception.resolver_roles` (FINANCE, ADMIN, OPERATIONS_MANAGER, PROJECT_MANAGER);
  - the exception exists and is OPEN.
- **What it records.** It moves the exception OPEN → RESOLVED through the existing state machine, recording
  `resolved_by`, `resolved_at` and `resolution_note`. It writes one `exception.resolved` audit row with the before
  and after state and the note.
- **History.** The exception keeps its original failure, class and attempts. Nothing is deleted.
- **Idempotent.** Resolving again changes nothing: "already RESOLVED by …", with no second audit row.
- **Access.** Neither application role can call it or update exceptions; the dashboard stays read-only.

**Tests** (PGlite and Postgres 17):
- **Refusals:** a blank or short note, an unknown, inactive or estimator employee, an unknown exception. Nothing
  changes.
- **The resolution:** OPEN → RESOLVED with who, when and why; the original message kept; the row count unchanged;
  exactly one audit row; idempotent; the hash chain intact.
- **Least privilege** for both roles.

Ablations: without the role check, the audit row, the OPEN-only rule or the note rule, each turns its test red.
Full suite 376 passed; lint and typecheck clean. Fresh chain: 24 applied, 0 skipped on re-run.

**Live** ([evidence/exception-resolution-live-verification.json](../evidence/exception-resolution-live-verification.json)):

| Step | Observed |
|---|---|
| Deploy | Migration alone (`eb6c9a95…`); fingerprint unchanged; neither application role can execute it or update exceptions |
| EMP-002 (Estimator) resolves EXC-0018 | Refused: "EMP-002 (ESTIMATOR) may not resolve exceptions". Still OPEN |
| EMP-900 (Finance) resolves EXC-0018 and EXC-0019, with notes | Both RESOLVED by EMP-900. Two `exception.resolved` audit rows (USER EMP-900, OPEN → RESOLVED, with the note). Original failure text kept |
| Repeat on EXC-0018 | Refused: "already RESOLVED by EMP-900". No second audit row |
| After | 19 exception records, the same as before. Open exceptions back to the four pre-existing ones (EXC-0003, 0013, 0016, 0017). Integrity 0 FAIL, with the hash chain intact. Security all pass. Dry-run `RECON-20261001-090010-e1dd`: 0 drift. The Copilot reports no open issues on PRJ-2026-0005 |

## Operational fix: daily 07 run lost to a Google Drive rate limit (2026-10-01, owner-instructed)

**Diagnosis** (n8n executions 1847 and 1899, both the daily schedule, started 17:00:38Z).
- **Where it failed.** Find Drive Root returned HTTP 403, and Drive Folders To Read threw "Drive root not found exactly
  once (HTTP 403, 0 roots)".
- **Google's answer:**
  - `errors[0]`: `domain usageLimits`, `reason rateLimitExceeded`;
  - ErrorInfo: `RATE_LIMIT_EXCEEDED`, quota `defaultPerMinutePerProject` = 12,000/min, consumer project
    `498586711441`;
  - no `Retry-After` header.
- **What it is.** A true per-minute rate limit on the OAuth client's Google Cloud project. It is not a permission or
  credential problem, despite the `PERMISSION_DENIED` status text.
- **Probable cause.** The run makes one Drive search, so others using the same OAuth client project (most likely a
  shared client) used up the budget at the top of the hour. Ad-hoc runs at other times verify Drive 3/3. The
  project's owner cannot be confirmed from here.
- **What was lost.** Airtable had already reconciled all six tables (0 drift). The Xero check, webhook supervision
  and `wf_reconcile_finish` never ran, so the run stayed RUNNING until superseded.

**Fix.** Migration `20261001050000_reconcile_drive_rate_limit_resilience.sql` and n8n 07. No business rule changed.
- **`wf_drive_call_decision(status, headers, body, attempt)`** returns ok, retry after `wait_seconds`, or fail:
  - retried: 429, 403 `rateLimitExceeded` / `userRateLimitExceeded` / `RATE_LIMIT_EXCEEDED`, 5xx, network errors;
  - the wait: `Retry-After` (seconds or an HTTP date) when present, else 15 s × 2^(attempt−1) plus 0–15 s jitter,
    capped at 120 s, for at most 4 attempts (`app_settings drive.retry_*`);
  - not retried: 401 ("reconnect the credential"), a 403 permission refusal ("check the credential can read the
    root"), a 403 daily quota, a missing root.
- **The loop, in 07.** Find Drive Root (continues on error) → Decide Drive Answer → Drive Answer:
  - ok: the folder checks;
  - retry: Wait Before Drive Retry, then Find Drive Root again (only that call repeats; Airtable is never re-read);
  - fail: Record Drive Unavailable, then Xero, webhooks and finish as usual.
- **`wf_reconcile_drive_unavailable`** keeps the run. It records `summary.drive` = UNAVAILABLE (error class,
  actionable reason, attempts) and Drive health failed with that reason. It opens one exception per cause
  (`GOOGLE_DRIVE`, with a stable message): a later run with the same cause updates it (`attempt_count`) and never
  duplicates it. It adds no drift finding.
- **`wf_reconcile_external` for DRIVE** (the core is renamed, not changed):
  - folder reads Google rate-limited count as Drive unavailable, never as per-project "could not be read" drift;
  - a complete check records Drive health ok and resolves the open Drive exceptions (`resolved_by_system
    workflow:reconciliation`, audited).

**Tests (offline, first).** `test/reconcile-drive-resilience.test.ts`, on PGlite and Postgres 17, is red before the
fix. It covers:
- Drive success;
- transient 403, 429, 5xx and network errors, then success, including the backoff bounds and `Retry-After` in
  seconds or as a date (capped);
- a rate limit exhausting the capped attempts;
- permission, auth and daily-quota answers not retried;
- a run that completes with its Airtable results while Drive stays unavailable, one exception across two runs, then
  resolved by a successful check;
- rate-limited folder reads recorded as unavailability, not drift.

Ablations: ignoring `Retry-After`, retrying every 403, no attempt cap, no resolve on success, one exception per run,
and rate-limited reads counted as drift each turn their own test red. Full suite 388 passed; lint and typecheck
clean. Fresh chain: 25 applied, 0 skipped on re-run. The n8n validator accepts the Drive loop.

**Live** ([evidence/reconcile-drive-rate-limit-verification.json](../evidence/reconcile-drive-rate-limit-verification.json)).
- **Deploy.** The migration went alone (`9314af5d…`), then 07 (active version `7b94b5df…`). The live Google account
  was not rate-limited on purpose.
- **One controlled run.** `RECON-20261001-092703-2e71` COMPLETED:
  - Airtable 231 checked, 0 drift; Xero 1/1;
  - Drive 3/3, through the new decision path. Drive health is now recorded by 07 ("reconciliation
    RECON-20261001-092703-2e71", 3 verified); no Drive exception.
- **Checks.** Integrity 0 FAIL, with the hash chain intact. Security all pass (the workflow role has 20 functions).
  Fingerprint unchanged.

**Owner recommendation (not changed).** Give the "RoofOps Google Drive" credential its own Google Cloud OAuth client,
which gets its own per-minute quota, and/or move the daily schedule off the top of the hour.

## AC-05 evidence package

### 1. Reproduction (offline, before the fix)

A probe (PGlite, the real `wf_*` path, synthetic Xero proof; the real Xero account was never touched) ran these steps:
1. approve PRJ-2026-0004 through 04's contract;
2. void the invoice the only way possible today (`update invoices set status = 'VOIDED', voided_reason = …`);
3. let 05 claim and complete.

The void was accepted, and the dashboard said **READY_TO_INVOICE** at once. 05 then claimed the job, and the completion
was RECORDED. The end state was **VOIDED + SYNCED**, with the outbox DONE and one Xero link. `needs_attention` was
false and integrity reported 0 FAIL. Preparing again answered ALREADY_INVOICED, so the dashboard's "ready" was a dead
end.

`test/invoice-void.test.ts`, on PGlite and Postgres 17, was red before the fix: 8 failed, each at its first rule
(05 still claims; the void is accepted while claimed or UNKNOWN; …). A first draft of these tests passed for a wrong
reason: it voided without the required `voided_reason`, so `invoices_check4` refused it. That was fixed before the
red run above.

### 2. Classification: a true bug

APPROVED → VOIDED is a legal transition, and nothing tied the outbox row to the invoice's business status. It moves
money: a Xero draft exists for an invoice RoofOps calls voided, and nothing flags it.

### 3–4. First incorrect transition, and why it was possible

The first incorrect transition was `invoices.sync_status` PENDING → SYNCED on a VOIDED invoice, in
`wf_complete_side_effect`. It was possible because:
- the void did not look at the queued write;
- the claim and the completion did not look at the invoice's status;
- `invoice_final_preview` ignored voided finals, although `invoices.idempotency_key` (`invoice:final:<project>`)
  still makes a second FINAL invoice impossible.

### 5. Invariant

> No Xero draft is created, pending, ambiguous or linked for a VOIDED invoice. A voided final invoice leaves its
> project blocked for a person, never "ready to invoice".

### 6. Tests

`test/invoice-void.test.ts`:
- **`:65`** a void is refused while the write is queued, and again once the draft exists; the write itself goes on
  normally;
- **`:76`** a void is refused while 05 is writing (claimed) and after an ambiguous attempt (UNKNOWN);
- **`:86`** once the write failed safely (dead-lettered), the void is allowed. After it:
  - even an operator re-queue gets no claim (`INVOICE_VOIDED`), and a completion is refused and links nothing;
  - the dashboard shows NOT_READY "final invoice … was voided", with needs attention and one OPEN exception;
  - Prepare refuses clearly, instead of Approve crashing;
  - integrity is clean;
- **`:110`** safety net: an invoice voided behind the checks (bypassing triggers) is never claimed or linked, and
  integrity FAILs `voided_invoice_has_no_xero_write`.

### 7. Fix (owner decisions, 2026-10-01: refuse while in flight; after a void, blocked for a person)

Migration `20261001060000_voided_invoice_never_gets_a_xero_draft.sql`. It changes Postgres only; n8n is unchanged.
1. **`invoices_void_guard` (before the status update) refuses a void**, with a reason and the next step, when:
   - the Xero draft is being created (claimed);
   - the draft exists (SYNCED, DONE, or linked): void it in Xero first;
   - an earlier attempt is ambiguous (UNKNOWN): run reconciliation;
   - the write is queued (pending, or a retry is scheduled).

   Only a dead-lettered write, where nothing was created, allows the void.
2. **`invoices_voided_needs_person`** opens one exception when a FINAL invoice is voided. It gives the dashboard's
   needs-attention flag, and it is closed with `npm run exception:resolve`.
3. **Safety net.** `wf_claim_side_effect` returns `INVOICE_VOIDED` without claiming. `wf_complete_side_effect`
   refuses by raising, so 05's existing "Proof Refused By Postgres" path records the failure and 04 never reports a
   draft. Both wrap the unchanged `…_core`.
4. **`invoice_final_preview`** (redefined in place, so the dashboard view keeps using it) answers not ok, "final
   invoice … was voided; a replacement final invoice needs a person". The dashboard shows NOT_READY with that
   blocker, and Prepare refuses cleanly.
5. **`integrity_check`** (wrapping the unchanged core) adds `voided_invoice_has_no_xero_write`: FAIL for a voided
   invoice that is SYNCED, PENDING or UNKNOWN, whose outbox row is DISPATCHING or DONE, or that has a Xero link.

### 8. Verification (offline)

| Check | Result |
|---|---|
| Red, before the fix | 8 failed (4 tests × 2 engines) |
| Ablation A: no void guard | `:65`, `:76`, `:86` red |
| Ablation B+C: no claim or completion safety net | `:86`, `:110` red |
| Ablation D: the preview still says ready after a void | `:86` red |
| Ablation E: no needs-a-person exception | `:86` red |
| Ablation F: integrity does not report it | `:110` red |
| Full suite, PGlite + Postgres 17 | **396 passed**, 33 skipped; lint and typecheck clean |
| Fresh PostgreSQL 17 chain | 26 applied, 0 skipped on re-run; both triggers present; the new check PASS on the imported data |
| Local dev DB | integrity 23 PASS, 4 WARNING, 0 FAIL (the new check PASS) |
| Grants (local) | `roofops_workflow` can execute only the claim and completion entry points; `roofops_dashboard` only `integrity_check`; the `…_core` functions and the trigger functions are executable by neither |

### 9. Hosted deploy (owner approved 2026-10-01, AC-05 only)

- **Parity first.** Repo, local and hosted agreed on all 25 earlier versions; `20261001060000` was used by no other
  file, commit or database.
- **Applied alone.** `migrations applied: 20261001060000_voided_invoice_never_gets_a_xero_draft.sql (skipped 25)`; no
  data import. Hosted checksum matches the repo (`6dea75f6`).
- **Checks, with no repair run:**

| Check | Result |
|---|---|
| `npm run reconcile -- --dry-run` | RECON-20261001-095516-f11e COMPLETED: Airtable 231 / 0 drift, Drive 3/3, Xero 1/1, webhooks OK |
| `npm run integrity:check` | 24 PASS, 3 WARNING (the same 3 as before), 0 FAIL; `voided_invoice_has_no_xero_write` PASS; hash chain intact |
| `npm run security:check` | all privilege checks pass |

### 10. Controlled live test (hosted, 2026-10-01)

One operator void of INV-2026-0039 (PRJ-2026-0004; FINAL, APPROVED, SYNCED; Xero Demo draft RO-INV-2026-0039),
run inside a transaction that is always rolled back, so an unexpected success could not have changed anything.

- **Refused** (SQLSTATE 23514): "INV-2026-0039 cannot be voided: its Xero draft exists (RO-INV-2026-0039). Void or
  delete it in Xero first".
- **Nothing changed.** A snapshot of the invoice, project, the invoice's outbox rows and its links has the same digest
  before and after (`13aba4cd…`):
  - invoice APPROVED / SYNCED, `record_version` 3, `voided_reason` null;
  - project COMPLETED, `record_version` 1;
  - outbox: 7 rows, 1 Xero job (DONE, 1 attempt), 0 open;
  - exceptions: 19 total, 4 open (no new exception);
  - audit: 84 events (the refusal wrote none);
  - dashboard XERO_DRAFT_CREATED.
- **No Xero write.** n8n 05 had no executions after 23:50Z. The next dry-run (RECON-20261001-095746-5b1c) re-read the
  Xero draft: 1/1 verified, 0 drift, and also 0 drift in Airtable and Drive.
- **Integrity after the test:** 24 PASS, 3 WARNING, 0 FAIL; the new check PASS.
- **Canonical fingerprint:** 173 values, `89d72adf…`, unchanged through deploy and test.
- The only changes between deploy and test came from the observe dry-run itself: the Xero link's `last_synced_at`, the
  dashboard's reconciliation timestamps, and its own audit event 115 `reconciliation.completed`.

The queued, claimed, UNKNOWN and dead-letter paths, the claim and completion safety net, the needs-a-person block and
the integrity FAIL stay offline-tested: a live test would need a new Demo invoice, and none was created.

Evidence: [evidence/ac05-live-verification.json](../evidence/ac05-live-verification.json).

### 11. Final verification

Fresh run before commit: full suite **396 passed**, 33 skipped (PGlite and Postgres 17); `test/invoice-void.test.ts`
8 of 8 on both engines; lint and typecheck exit 0.

## Reliability fix: the dashboard and Copilot used the server's real date (2026-10-04, owner-instructed)

**Found** while re-running the full suite for AC-06. `test/copilot-tools.test.ts:35` failed on both engines once the
real date passed PRJ-2026-0011's planned finish (2026-10-01): "Past the planned finish date" appeared. The test fails
identically without the AC-06 migration.

**Reproduced on hosted too** (read-only, through the web app's own login `roofops_web` and the real Copilot tool code):

| Caller | Before | After |
|---|---|---|
| Owner (Postgres workflows run as it, through SECURITY DEFINER functions) | 2026-09-29 | 2026-09-29 |
| Web login: `app_today()` / `v_dashboard_kpis.as_of` | **2026-10-04** / **2026-10-04** | 2026-09-29 / 2026-09-29 |
| Copilot "today" (`what_needs_attention_today`) | **2026-10-04** | 2026-09-29 |
| PRJ-2026-0011 risk reasons: web and Copilot | START_DATE_PASSED, **PAST_PLANNED_COMPLETION**, PM_FLAGGED | START_DATE_PASSED, PM_FLAGGED (the owner's answer) |
| Web login reads `app_settings` | allowed, every row hidden by RLS | denied |

**Root cause.** `app_today()` was a plain SQL function that read `app_settings.business_date_override` as the caller.
`roofops_dashboard` had a column grant on `app_settings`, but RLS is enabled with no policy. The role therefore saw no
row, and the function fell back to the real Brisbane date without any error.

**Invariant.** One RoofOps business date, the same for every caller. Lacking access to the settings never substitutes
another date, and the dashboard needs no access to configuration rows.

**Fix:** migration `20261001065000_one_business_date_for_every_caller.sql`.
- **`app_today()` resolves the date with the owner's rights.** It is now SECURITY DEFINER with a fixed search_path,
  and was already in the security check's allow-list.
  - The setting holds a date (YYYY-MM-DD): that date.
  - The setting is missing or empty: no override is configured, so the real date in Brisbane. This is the documented
    production behaviour.
  - Anything else: an error ("business_date_override … is not a date"), never another date.
- **The dashboard's column grant on `app_settings` is revoked.** The dashboard reads the date only through
  `app_today()`.

**Tests:** `test/business-date.test.ts`, on PGlite and Postgres 17.
1. The dashboard role gets the configured business date.
2. It cannot read ordinary app settings.
3. Missing or empty means the real Brisbane date; three malformed values are refused, by the owner and by the
   dashboard.
4. The workflow role's invoice preview, the dashboard's as-of date and the Copilot's "today" are the same date.
5. PRJ-2026-0011's risk reasons follow the business date (PAST_PLANNED_COMPLETION appears only with a business date
   after 2026-10-01).

| Check | Result |
|---|---|
| Red, before the fix | all 10 failed, plus the Copilot test on both engines |
| Ablation A: not SECURITY DEFINER | tests 1, 3, 4, 5 and the Copilot test red |
| Ablation B: the dashboard keeps its column grant | test 2 red |
| Ablation C: a malformed value falls back to the real date | test 3 red |
| Full suite, PGlite + Postgres 17 (AC-06 parked outside the repo) | **406 passed**, 33 skipped, **0 failed**; lint and typecheck clean |
| Fresh PostgreSQL 17 chain | 27 applied, 0 on re-run; the dashboard gets 2026-09-29 and has no column privilege on `app_settings`; integrity 0 FAIL; workflow role 20 functions, all `wf_*`; nothing executable by PUBLIC; RLS everywhere |
| Local dev DB | applied alone; integrity 23 PASS, 4 WARNING, 0 FAIL |
| Hosted | applied alone (26 skipped); live before/after as above; dry-run `RECON-20261004-042200-a579` 0 drift; integrity 24 PASS, 3 WARNING, 0 FAIL; security all pass; no repair run; fingerprint 173 values `89d72adf…`, unchanged |

Evidence: [evidence/business-date-live-verification.json](../evidence/business-date-live-verification.json).

## AC-06 evidence package

### 1. Reproduction (offline, before the fix)

A probe ran on PGlite and Postgres 17. It used the real `wf_*` path and synthetic Xero proof; the real Xero account
was never touched. It pinned a fake tenant A, approved final invoices through 04's contract, then changed the pin:

| Scenario | Claim | Completion with proof from A | End state |
|---|---|---|---|
| A. Job queued, then the pin cleared (`xero.demo_tenant_id = ''`, the documented "no writes possible" state) | `claimed=true`, payload tenant A | RECORDED | SYNCED, linked, pin empty |
| B. Job queued, then the pin re-pointed to tenant B | `claimed=true`, payload tenant A | RECORDED | SYNCED, linked, pin B |
| C. Job claimed under A, then the pin changed to B | (claimed before) | RECORDED | SYNCED, linked, pin B |

No exception was opened in any of them. Proof from a tenant other than the payload's was already refused.

### 2. Classification: a true bug

The pin is the only kill switch for Xero writes (ADR-030), and it did not stop approved, queued or retrying writes.
Re-pointing it did not move them either: 05 kept writing to the old tenant, and Postgres recorded them as done.

### 3–4. First incorrect transition, and why it was possible

The first incorrect transition was outbox PENDING → DISPATCHING (the claim) while the pin was empty or different from
the job's tenant, in `wf_claim_side_effect`. It was possible because:
- the tenant is copied into the outbox payload at approval, and the claim and the completion compared only against
  that copy, never against the current pin;
- 05 takes the tenant from the claimed payload (`xero-tenant-id` header), so it wrote wherever the payload said;
- nothing stopped the pin from moving while a write for it was queued, running or ambiguous.

### 5. Invariant

> A Xero write is bound for good to the tenant it was approved for. The pin cannot move while a write for the pinned
> tenant can still run or may already have run, and a write never runs while its tenant is not the pinned one. So no
> pin change can leave a draft in Xero that RoofOps records as failed.

### 6. First fix, rejected by the owner (2026-10-04), and why

The first version re-checked the pin at claim and at completion, and flagged stopped writes. It left one unsafe
sequence: a worker claims → the pin changes → the worker still POSTs to the old tenant → the completion refuses to link
→ a draft may exist while RoofOps records a failure. That would also break AC-05's assumption that a dead-lettered
invoice failed safely. The fix below closes it at the database boundary. It was never committed or deployed; the
same migration file was rewritten.

### 7. Fix

Migration `20261001070000_xero_write_bound_to_its_tenant.sql`. It changes Postgres only; n8n is unchanged.
1. **`app_settings_xero_pin_guard`** (`xero_pin_change_guard`, before insert, update or delete). Changing, clearing
   or deleting the pin is refused while a Xero write bound to the pinned tenant is not finished:
   - queued (PENDING);
   - being written (DISPATCHING);
   - retry scheduled (FAILED, not dead-lettered);
   - ambiguous (invoice `sync_status = UNKNOWN`, even if dead-lettered).

   The refusal names each invoice and its state. Finished means DONE, or dead-lettered with nothing created.
   A write held for another tenant can never run, so it does not block; its own tenant can always be pinned again.
   Blocking on it too would deadlock the configuration after race B below.
2. **One advisory lock serializes pin changes and claims.** The guard takes it exclusive; the claim takes it shared
   before reading the pin. A race therefore has two outcomes only:
   - **Worker first:** the claim succeeds, the change waits, and is then refused because the write is open. The worker
     stays bound to, and completes in, the same tenant.
   - **Change first:** the change succeeds, and the claim waits. It then sees the missing or different pin and does
     not claim, so there is no Xero call.

   An advisory lock rather than a row lock also covers deleting and re-inserting the setting.
3. **`wf_claim_side_effect`** (redefined in place, keeping AC-05's voided check). A write whose tenant is not pinned
   is not claimed:
   - it returns `TENANT_NOT_PINNED`, `TENANT_CHANGED` or `TENANT_MISSING`, with the message;
   - it opens or updates one PERMISSION_DENIED exception on the project (needs attention).

   This covers every retry and a re-queued dead letter, because 05 re-claims before each attempt.
4. **`outbox_xero_tenant_fixed`**: a Xero job's tenant (and topic) cannot be changed after approval.
5. **`wf_complete_side_effect`** (redefined in place), as defence in depth. A proof is linked only if the job has a
   tenant and the pin is still that tenant. With the guard in place this is reachable only if triggers are bypassed.
   The unchanged core still refuses proof from another tenant.

The guard, the trigger functions and the helper are executable by neither app role. The claim and the completion keep
their grants.

### 8. Tests

`test/xero-tenant-binding.test.ts` uses fake tenants A, B and C, and synthetic proof. It never runs 05, and no Demo
invoice is created. Numbers follow the owner's list.
- **`:97` 1.** A queued write blocks changing, clearing and deleting the pin. It then runs in its own tenant, and once
  done the pin may move.
- **`:108` 2.** A write being written blocks the pin, and its tenant cannot be edited. It completes in its own tenant.
- **`:118` 3.** An ambiguous (UNKNOWN) write blocks the pin, while its retry is scheduled and even once its outbox row
  is dead-lettered.
- **`:146` 4.** A safely failed write (dead-lettered, `sync_status = FAILED`) lets the pin be cleared, deleted and set
  to B.
  - Re-queued while B is pinned, it is not claimed, and one exception per cause appears.
  - Being held for another tenant, it does not block the pin.
  - Pinning A again lets it be claimed in A, after which the pin is fixed once more.
- **`:216` 5.** (Postgres 17, two connections) The worker claims first: the change waits for the claim, is then
  refused, and the worker completes in the same tenant.
- **`:233` 6.** (Postgres 17, two connections) The pin changes first: a write approved meanwhile, bound to A, is
  claimed only after the change commits. The claim then answers `TENANT_CHANGED` with no attempt counted, and one
  exception appears. Pinning A again lets it run there.
- **`:173` 7.** A retry cannot run under another tenant: the pin cannot move while the retry is scheduled, and the
  retry runs in the same tenant.
- **`:185` 8.** While 05 writes, clearing, re-pointing and deleting the pin are all refused. The draft is recorded
  (SYNCED, linked), and `sync_status` was never FAILED.
- **`:130`** (guard) Proof from a tenant other than the job's is refused, and so is proof with no tenant. This was
  already enforced.
- **`:195`** (defence in depth) With triggers bypassed (`session_replication_role = replica`), the completion still
  refuses to link a draft read back after the pin moved or was cleared.

### 9. Verification (offline)

| Check | Result |
|---|---|
| Red, before the fix | 16 failed; 2 passed (the guard, both engines); 2 skipped (the races, on PGlite) |
| Ablation A: the claim does not check the pin | 4 (both engines), 5, 6 red |
| Ablation B: the claim takes no pin lock | 5, 6 red (two-connection races only) |
| Ablation H: a pin change takes no pin lock | 5, 6 red (two-connection races only) |
| Ablation G1: the guard ignores PENDING | 1 red |
| Ablation G2: the guard ignores DISPATCHING | 2, 4, 8 (both engines), 5, 6 red |
| Ablation G3: the guard ignores UNKNOWN | 3 red |
| Ablation G4: the guard ignores a scheduled retry | 7 red |
| Ablation G5: the guard also counts safe dead letters | 4 red |
| Ablation G6: the guard counts writes held for other tenants | 4, 6 red (then knock-on 7, 8, defence) |
| Ablation G7: the guard ignores DELETE | 1, 2, 3, 7, 8 red |
| Ablation C: the completion does not check the pin | defence red |
| Ablation E: the job's tenant can be edited | 2 red |
| Ablation F: a refused claim opens no exception | 4, 6 red |
| AC-05 re-run (`test/invoice-void.test.ts`) | 8 of 8, PGlite + Postgres 17 |
| Full suite, PGlite + Postgres 17.11 | 412 passed, 2 failed at the time (`test/copilot-tools.test.ts:35`, the business-date defect below); **424 passed, 0 failed** after its fix (§10) |
| Lint, typecheck | exit 0 |
| Fresh PostgreSQL 17 chain | 27 applied, 0 on re-run; both triggers present; integrity 23 PASS, 4 WARNING, 0 FAIL |
| Privileges (fresh chain, `security:check` queries) | See below |
| Local dev DB | The first version's objects removed (local only); the new version applied alone; integrity 23 PASS, 4 WARNING (local only), 0 FAIL |
| Migration parity (read-only) | Repo, local and hosted aligned through AC-05 (26 versions); `20261001070000` unused anywhere else; checksum `e84e1dc4` |
| Hosted Xero writes today (read-only) | One: INV-2026-0039, DONE, bound to the pinned tenant. The guard does not block, and the deploy changes nothing that runs now |

Privileges on the fresh chain:
- The claim, completion and fail entry points are executable by the workflow role only.
- The cores, the guard, the helper, the trigger functions and `wf_open_sync_exception` are executable by neither role.
- The workflow role runs 20 functions, all `wf_*`, the same count as on hosted.
- No function is executable by PUBLIC, and every table has RLS.
- The dashboard role reads no table and runs the same 5 functions.

**The `copilot-tools` failure was a separate defect, not AC-06.** The dashboard role silently used the real date. It failed identically without the AC-06 migration, and it was fixed, deployed and committed separately first (`10bb994`, "Reliability fix" section above).

**Limits (not changed here):**
- **Changing the pin needs every write for the pinned tenant finished first.** An ambiguous one must be reconciled,
  and a stuck one (claimed by a worker that died) must be failed. This is intended: the pin is no longer an instant
  kill switch for writes already queued.
- **A write approved while a pin change is in progress is bound to the tenant it read** (race B). It is held, with an
  exception, until that tenant is pinned again or a person decides.
- **05's note to Airtable for a held claim is generic:** "Held by another worker or waiting for its retry window
  (TENANT_CHANGED)". The exception is exact.
- **Held-write exceptions are not closed automatically;** close them with `npm run exception:resolve`.
- **A re-queued dead-lettered Xero write cannot be completed.** The invoice_sync state machine refuses
  FAILED → SYNCED. This is pre-existing (the re-queue script was written for Drive), outside AC-06; see test 4.

### 10. Pre-deploy gate (owner-required, 2026-10-04, after the business-date fix `10bb994`)

| Check | Result |
|---|---|
| AC-06 tests | 18 of 18 (2 race tests skipped on PGlite, run on Postgres 17) |
| AC-05 tests | 8 of 8, PGlite + Postgres 17 |
| Complete suite, PGlite + Postgres 17 | **424 passed**, 35 skipped (hosted-only and the PGlite race skips), **0 failed** |
| Lint, typecheck | exit 0 |
| Hosted, before deploy | parity aligned through `20261001065000`; integrity 24 PASS, 3 WARNING, 0 FAIL; security all pass |

### 11. Hosted deploy and rollback-only live tests (2026-10-04)

- **Applied alone:** `migrations applied: 20261001070000_xero_write_bound_to_its_tenant.sql (skipped 27)`, with no data
  import. Hosted checksum matches the repo (`e84e1dc4`).
- **Checks after deploy, with no repair run:**
  - dry-run `RECON-20261004-042635-bb75`: Airtable 231 / 0 drift, Drive 3/3, Xero 1/1;
  - integrity 24 PASS, 3 WARNING, 0 FAIL;
  - security all pass (the workflow role still runs 20 `wf_*` functions).
- **Live tests.** Each ran in its own transaction, always rolled back. There was no Xero call and no new invoice.

| Step | Outcome |
|---|---|
| Re-point INV-2026-0039's job to another tenant | **Refused** (23514): "The Xero tenant of xero:invoice:f4e519c4-… is fixed when it is approved (96643bb0…): it cannot be changed to 00000000-…" |
| Clear the pin (its only write is DONE) | Allowed inside the transaction, as designed; that job's claim still answers DONE (not claimed); no exception opened; rolled back |
| Delete the pin (its only write is DONE) | Allowed inside the transaction; rolled back |

- **After:**
  - The pin is still `96643bb0-…` and both triggers are present.
  - A snapshot of INV-2026-0039 (invoice, project, outbox, links) and the counts has the same digest before and after the
    tests (`887bd203…`): 7 outbox rows, 1 Xero job, 19 exceptions with 4 open, and 90 audit events.
  - Between deploy and test, only the observe dry-run touched this data (reconciliation timestamps and its audit event).
- **After the tests:** integrity 24 PASS, 3 WARNING, 0 FAIL. Dry-run `RECON-20261004-042944-572f`: 0 drift in
  Airtable, Drive and Xero. Canonical fingerprint 173 values `89d72adf…`, unchanged throughout.

The guard's refusal, both races and the queued, in-progress, ambiguous and retrying paths stay offline-tested: on
hosted they would need an open Xero write, which means a new Demo invoice. Evidence:
[evidence/ac06-live-verification.json](../evidence/ac06-live-verification.json).

## AC-04 evidence package

### 1. Investigation: the current create, write, retry and reconciliation path

- **05, before every create:** it searches Xero by the deterministic invoice number (`InvoiceNumbers=RO-INV-…`) and by
  `Reference == PRJ-…`.
  - Exactly one matching draft: it is adopted.
  - Anything conflicting: refused with RECONCILIATION_MISMATCH at step `reconcile`.
  - Nothing found: it creates, with `Idempotency-Key: roofops-<invoice uuid>`.
- **The idempotency key.** Xero's API spec says it allows retries "without the risk of duplicate processing". The spec
  states no retention period, so recovery does not rely on it alone.
- **05 reports every failure with its step first** (`<step>: <message>`). For the create step, 05's `fail()` sets
  `http_status` only from the create request's own response. Its `refuse()` (a 200 answer with no InvoiceID) carries
  no HTTP status.
- **`wf_fail_side_effect` judged the invoice by error class only,** and every dead letter became FAILED.
- **Reconciliation read only invoices with a verified Xero link.**

### 2. Reproduction (offline, fake Xero answers; no Xero call)

`test/xero-ambiguous-create.test.ts`, before the fix: 20 of 24 failed on PGlite and Postgres 17. The 4 that passed
(2 tests on 2 engines) were behaviour that was already correct. It showed four problems:
- **The catalogue sequence downgraded the invoice.** A TIMEOUT at create, then RATE_LIMITED ×3, then UPSTREAM_5XX
  went UNKNOWN → PENDING → **FAILED**, with the approval EXECUTION_FAILED.
- **Failures after the create were recorded as failed.** A read-back or verify failure, or a conflicting search, gave
  FAILED although the draft exists.
- **A failure before Xero was even called was marked UNKNOWN.** A network error at a search step had that effect.
- **Nothing ever looked up an uncertain write, and AC-05 then allowed the void.**

### 3–4. First incorrect transition, and why

The first incorrect transition was UNKNOWN → PENDING on a later failure that proved nothing. The damaging one was →
FAILED at the dead letter. Each failure's evidence (where in 05 it happened) was ignored, and no read of Xero was ever
required before leaving UNKNOWN.

### 5. Invariant

> A timeout or transport failure after a Xero create request is never proof that no draft exists. An invoice whose
> draft may exist stays UNKNOWN until a read of Xero proves presence (link it) or absence (only then retry or fail
> safely). Every RoofOps Xero draft maps to exactly one RoofOps invoice, and nothing is guessed.

### 6. Fix

**Postgres:** migration `20261001080000_ambiguous_xero_create_stays_unknown.sql`.
1. **`xero_failure_evidence(class, message, http_status)`** reads 05's step:
   - before the create request: no new evidence;
   - the create explicitly refused by Xero, meaning the create request's own answer carries HTTP 4xx (including 429)
     and the class is not a timeout or network class: absent;
   - anything else at the create, anything after it, a conflicting `reconcile` search, or an unrecognised step: may
     exist. "Anything else" includes a 5xx, a timeout, network, and a 200 with no InvoiceID (05's `refuse()`).
2. **`wf_fail_side_effect` (v1.2).** The invoice stays UNKNOWN while the draft may exist, through retries and the dead
   letter.
   - An uncertain dead letter keeps the approval EXECUTING and gets one AMBIGUOUS_WRITE exception.
   - FAILED only when absence is proven.
3. **`wf_reconcile_targets`** lists `xero_uncertain`: UNKNOWN writes bound to the pinned tenant. A write 05 holds
   (claimed) is left out.
4. **`wf_reconcile_xero_uncertain(run, lookups)`** (workflow role only) settles them. It needs both lookups to have
   answered HTTP 200, and acts in repair mode only.

   | Outcome | When | Effect |
   |---|---|---|
   | RECOVERED | exactly one matching draft | linked, SYNCED, outbox DONE, approval EXECUTED, audit row, exception resolved |
   | PROVEN_ABSENT | nothing in either lookup | a dead letter becomes FAILED (safe), a scheduled retry PENDING |
   | NEEDS_PERSON | conflicting or multiple candidates | one exception; stays UNKNOWN |
   | LOOKUP_FAILED | a failed lookup | no change |
   | WRONG_TENANT | a lookup in another tenant | no change; a PERMISSION_DENIED exception is opened or updated |
   | SKIPPED | already settled, or held by 05 | nothing |

   A missing `SentToContact` counts as not sent: Xero's list endpoint omits it unless true (seen live), and a DRAFT
   cannot have been sent.
5. **Two explicit outbox transitions,** FAILED/PENDING → DONE, only when reconciliation proved the draft exists.

**n8n 07** (`EiBs0AB2NfOua7AM`; active version `1737a07a…`, previous `7b94b5df…`). Five nodes are added after Record
Xero Findings:

```
Record Xero Findings
  → Uncertain Xero Writes To Look Up        (code: targets.xero_uncertain, or a "none" marker)
  → Any Uncertain Xero Writes?
       true  → Look Up Uncertain By Invoice Number   GET /Invoices?InvoiceNumbers=RO-INV-…&Statuses=all
                                                      xero-tenant-id = the write's bound tenant
             → Look Up Uncertain By Reference         GET /Invoices?where=Type=="ACCREC" AND Reference=="PRJ-…"
                                                      same tenant
             → Settle Uncertain Xero Writes In Postgres
       false → Settle Uncertain Xero Writes In Postgres (with [])
  → List Airtable Webhooks → … (unchanged)
```

- Both GETs continue on error, so a timeout, 429 or 5xx reaches Postgres as LOOKUP_FAILED.
- Settle passes the key, tenant, both HTTP statuses, any error, and both result lists.
- Nothing is created or changed in Xero.

### 7. Tests

**`test/xero-ambiguous-create.test.ts`** (Postgres contract), on both engines. Its cases:
- **1:** a pre-request failure gives a safe retry (PENDING).
- **2:** an explicit create refusal gives FAILED, even after ambiguity.
- **2b:** only an explicit 4xx/429 from the create request proves absence. A 200 without an InvoiceID, a 429 with no
  HTTP status, a 5xx, a timeout (even with HTTP 408) and a network error are all "may exist".
- **3:** a normal create gives SYNCED.
- **4:** a lost answer gives UNKNOWN through 429s and the dead letter, with an AMBIGUOUS_WRITE exception.
- **4b/5:** a post-create failure gives UNKNOWN; a dry run changes nothing; a repair links the one draft.
- **6:** nothing found: proven absent; a failed lookup proves nothing.
- **7:** two drafts, another invoice with the reference, a differing total, only a voided one, or one sent to the
  customer: a person decides.
- **8:** idempotent.
- **9:** while UNKNOWN, the same number and key on every attempt; a second draft is refused; no racing with 05.
- **10:** AC-05: the void is refused while uncertain.
- **11:** AC-06: the pin stays fixed; a wrong-tenant lookup opens an exception; recovery works in the bound tenant.

**`test/reconcile-07-uncertain-xero.test.ts`** (the real 07 orchestration):
- **How it runs.** `n8n/07-reconcile.sdk.ts` loads through a test-only recorder for `@n8n/workflow-sdk`
  (`test/helpers/n8n-sdk-shim.ts`; vitest alias). Its real nodes then run in `test/helpers/n8n-runner.ts`:
  - the code nodes' own JavaScript (in `node:vm`);
  - the HTTP nodes' URL, query and header expressions, sent to a fake Xero that records every request;
  - the Postgres nodes' own queries and parameter expressions, against a test database.
  - The path runs from Read Request and Start Reconciliation Run through External Objects To Check and the new nodes to
    Settle, following 07's own connections.
- **Cases:**
  - 07 wiring;
  - zero targets (no Xero request);
  - one exact match: exactly two read-only GETs in the pinned tenant, by number and by reference; SYNCED;
  - no match: proven absent;
  - number and reference disagreement;
  - multiple candidates;
  - lookup failure (429 on the number lookup, 503 on the reference lookup, no answer);
  - wrong tenant: UNKNOWN plus an exception;
  - a write 05 holds: not looked up, untouched;
  - dry run: no invoice, outbox, approval or link change;
  - repeated repair: idempotent, no second Xero request.
- **The fake Xero mirrors the live list response** (probe below): `SentToContact` is omitted.

**Existing tests changed (inputs only, no assertion):**
- `test/invoice-void.test.ts:80`, `:90` and `test/xero-tenant-binding.test.ts:121`, `:149`, `:176` now carry 05's step
  prefix.
- `test/schema.test.ts` allow-lists `wf_reconcile_xero_uncertain`.
- `vitest.config.ts` gains the SDK alias.

### 8. Verification

| Check | Result |
|---|---|
| Red, before the fix | Postgres contract 20 of 24 failed; orchestration 22 of 22 failed against 07 from git |
| Postgres ablations | each red on its own tests: E1–E5 (evidence, including E5, refusal without an explicit HTTP 4xx), D1, T1, R1–R7 (R5 re-run with a corrected pattern) |
| 07 ablations (orchestration) | each red: O1 reference lookup not in the bound tenant; O2 its error ignored; O3 lookups run without targets; O4 number lookup not by number; P1 only the number lookup must answer; P2 targets include writes 05 holds; P3 a wrong tenant opens no exception |
| `SentToContact` fix | with the old default, 6 orchestration tests red; with the fix, 46/46 |
| AC-05 / AC-06 | 8/8, 18/18 |
| Full suite, PGlite + Postgres 17 | **470 passed**, 35 skipped, **0 failed**; lint and typecheck clean |
| Fresh PostgreSQL 17 chain | 29 applied, 0 on re-run; recovery transitions present; integrity 0 FAIL |
| Grants | settle and fail: workflow only; evidence helper: neither role; workflow role 21 `wf_*` functions; dashboard unchanged; nothing executable by PUBLIC; RLS everywhere |
| Local dev DB | re-applied; integrity 23 PASS, 4 WARNING, 0 FAIL |

### 9. Live verification (2026-10-04; no lost-response write was manufactured)

- **Lookup probe.** A temporary, unpublished workflow (`TYZNxiux4orQW78j`, archived after one manual run, execution
  2141) ran 07's two lookup nodes, copied verbatim, against the known Demo invoice RO-INV-2026-0039 / PRJ-2026-0004.
  - The tenant was the bound and pinned 96643bb0…, and Xero echoed `xero-tenant-id: 96643bb0…`.
  - **By number:** HTTP 200, exactly one invoice: 7b74973c… (the InvoiceID RoofOps has linked), DRAFT, ACCREC,
    14664.49 / 1333.14.
  - **By reference:** HTTP 200, the same single invoice.
  - The probe exposed the `SentToContact` omission. It was fixed and proven offline before anything was deployed.
- **Deploy.** The migration was applied alone (`52ed3bb4`), then 07 was updated. The draft's five new nodes were
  parameter-for-parameter identical to the tested SDK, and the draft was published.
- **Dry-run `RECON-20261004-090303-440a`:** Airtable 231 / 0 drift, Drive 3/3, Xero 1/1, webhooks OK. Its summary
  records `xero_uncertain: {checked: 0}`, so the new path ran live (no uncertain targets, no lookups).
- **INV-2026-0039 is untouched.** Its invoice, outbox and approval were unchanged through deploy and dry-run. Only the
  observe run's own timestamps and audit event moved.
- **After:** integrity 24 PASS, 3 WARNING, 0 FAIL; security all pass. Canonical fingerprint 173 values `89d72adf…`,
  unchanged. No repair run.
- **Not run live:** recovery, proven absence, needs-person, lookup failure, wrong tenant, dry-run and idempotency
  would need a manufactured lost-response write. They are proven offline against the real 07 node definitions.

Evidence: [evidence/ac04-live-verification.json](../evidence/ac04-live-verification.json).

**Notes:**
- **The FAILED → SYNCED re-queue limitation is not needed for AC-04 recovery.** An uncertain write never becomes FAILED.
  - **Smallest separate fix (not done):** the re-queue also moves the invoice FAILED → PENDING and the approval back to
    executing. Both transitions already exist.
- **The GST cent difference on multi-line drafts** (catalogue path 2) is not fixed. Such a refusal is now UNKNOWN with
  an exception, never FAILED.

## AC-08 evidence package

### 1. Reproduction (offline probe on the imported data; hosted checked read-only)

| | PRJ-2026-0006 | PRJ-2026-0008 |
|---|---|---|
| Entitled (quote + variations) | 25,740.60 | 49,739.70 |
| Billed | **30,888.72** (INV-2026-0006 paid + INV-2026-0036 issued) | **59,687.64** (INV-2026-0008 paid + INV-2026-0038 issued) |
| Preview | ARITHMETIC_MISMATCH, "−5,148.12; nothing left to invoice" | same, −9,947.94 |
| Dashboard | **FULLY_INVOICED**, no blocker, **needs_attention false** | FULLY_INVOICED, no blocker (attention only from an unrelated supplier timeout) |
| Prepare | an exception saying "nothing left to invoice" | same |
| Invoices paid, then CLOSED (rolled back) | **accepted** | **accepted** |

Hosted (read-only, 2026-10-04) has the same two over-billed projects, in the same state.

`test/dashboard.test.ts:34` asserted PRJ-2026-0006 FULLY_INVOICED with a null blocker: the test enshrined the defect.

### 2–4. Classification, first incorrect transition, why

This is a true bug. `invoice_final_preview` answered "nothing left to invoice" for any amount ≤ 0, so exactly billed and
over-billed looked the same. The dashboard mapped that answer to FULLY_INVOICED, and `project_transition_guard`
accepted it as "no final invoice needed" when closing. The first incorrect transition was COMPLETED → CLOSED with
billed > entitled.

### 5. Invariant

> Billed ≤ entitled, always, at every stage. Entitled is the accepted quote version plus variations the customer
> approved (APPROVED or INVOICED). Billed is invoices APPROVED, ISSUED, PARTIALLY_PAID or PAID. Otherwise the project is
> OVER_BILLED: it needs attention, names the excess and the invoices, and cannot be closed until a person corrects the
> billing.

### 6. Fix (owner decisions 2026-10-04: a new OVER_BILLED status; closing refused until the billing is corrected, with no credit-note model)

Migration `20261001090000_over_billed_project_is_never_fully_invoiced.sql`:
1. **`project_over_billing(project)`** is the one rule. It returns billed, quote, variations, entitled, excess,
   invoices and a message, or null. It is SECURITY DEFINER and read-only, and is executable by the dashboard role (the
   view calls it with the caller's rights, as it does `invoice_final_preview`). The workflow role cannot execute it.
2. **`invoice_final_preview`** (redefined in place from AC-05's definition) answers over-billing with
   `over_billed: true`, `over_billed_by`, the billed and entitled amounts, and the message. It keeps the
   ARITHMETIC_MISMATCH class, so Prepare's existing contract holds. "Nothing left to invoice" now means exactly
   billed.
3. **`project_transition_guard`** (redefined in place) refuses CLOSED while over-billed: "… cannot be closed: it is
   over-billed by … Correct the billing first".
4. **`v_dashboard_projects`** (redefined in place):
   - OVER_BILLED comes first among invoice statuses, at any project stage;
   - the blocker is the over-billing message;
   - `needs_attention` is true.

Web:
- `web/lib/labels.ts` adds "Over-billed: needs attention".
- The Copilot's prepare tool refuses OVER_BILLED up front with the reason, filing nothing.
- `scripts/security-check.ts` allow-lists `project_over_billing` among the dashboard's read functions.

### 7. Tests

`test/over-billing.test.ts`, on PGlite and Postgres 17:
- the preview names billed, entitled, excess and invoices;
- the dashboard shows OVER_BILLED with the reason and needs attention, for exactly PRJ-2026-0006 and PRJ-2026-0008;
- Prepare refuses with the reason (one exception, no approval);
- CLOSED is refused even with every invoice paid, and nothing changes;
- voiding the unpaid duplicate clears it, and closing is then judged on the normal rules (guard);
- exactly billed stays FULLY_INVOICED, and an INVOICED variation is entitlement, not a false alarm (guard);
- over-billing is flagged on a job still in progress;
- the Copilot shows it and its prepare tool refuses, filing nothing.

**Existing assertion changed:** `test/dashboard.test.ts:34` now expects OVER_BILLED with the over-billing blocker. It
had enshrined the defect, as the catalogue noted.

### 8. Verification (offline)

| Check | Result |
|---|---|
| Red, before the fix | 12 of 16 failed (6 behaviours × 2 engines); the 4 passes are the two guards |
| Ablation A: the preview ignores over-billing | preview and Prepare tests red |
| Ablation B: no OVER_BILLED status | dashboard, any-stage, Copilot and `dashboard.test.ts:34` red |
| Ablation C: over-billed needs no attention | dashboard and `dashboard.test.ts:34` red |
| Ablation D: closing ignores over-billing | the CLOSED test red |
| Ablation E: INVOICED variations not entitled | the no-false-alarm test red |
| Ablation F: exactly billed counts as over-billed | the exactly-billed and dashboard tests red |
| Full suite, PGlite + Postgres 17 | **486 passed**, 35 skipped, 0 failed; lint and typecheck clean |
| Fresh PostgreSQL 17 chain | 30 applied, 0 on re-run; OVER_BILLED is exactly PRJ-2026-0006 and PRJ-2026-0008, also as the dashboard role; integrity 0 FAIL |
| Grants | `project_over_billing`: dashboard yes, workflow no; dashboard reads no table; workflow role 21 `wf_*` functions; nothing executable by PUBLIC; RLS everywhere |
| Local dev DB | applied alone; integrity 23 PASS, 4 WARNING, 0 FAIL |
| Migration parity (read-only) | aligned through AC-04; `20261001090000` unused anywhere else |

**Interplay with AC-09 (not fixed here):**
- The final-invoice amount still adds only APPROVED variations; that is AC-09's defect.
- The over-billing rule counts APPROVED and INVOICED variations, so it does not raise a false alarm in AC-09's
  scenario.

### 9. Before deployment: the tax basis (owner-required)

All three compared amounts are GST-inclusive:
- `quote_versions.total_inc_gst`;
- `variations.amount_inc_gst`;
- `invoices.total_inc_gst`, which `derive_invoice_totals` derives from the invoice lines through `gst_split`, whatever
  the line-amount type.

No existing test proved this, so one was added: "quote, variations and invoices are compared on the same basis".
- A GST-exclusive invoice of 16,210.83 ex (17,831.91 inc) exactly completes PRJ-2026-0005: FULLY_INVOICED.
- One of 17,000.00 ex (18,700.00 inc) over-bills it by 868.09: OVER_BILLED, although its ex-GST amount is below the
  17,831.91 left.
- With billed compared ex GST, the test fails (2 of 2), so it detects a basis mismatch.

### 10. Hosted deploy and live verification (2026-10-04; no repair run; the duplicate invoices were not touched)

- **Applied alone** (`d938cbb6`; 29 skipped).
- **Checks after deploy:**
  - dry-run `RECON-20261004-092906-566c`: 0 drift (Airtable 231, Drive 3/3, Xero 1/1);
  - integrity 24 PASS, 3 WARNING, 0 FAIL;
  - security all pass, with `project_over_billing` the only new dashboard function, as approved.
- **Through the web app's own login (`roofops_web`) and the real Copilot tool code:**

  | | PRJ-2026-0006 | PRJ-2026-0008 |
  |---|---|---|
  | Dashboard | OVER_BILLED, needs attention | OVER_BILLED, needs attention |
  | Excess | over by 5,148.12 (billed 30,888.72 against 25,740.60; INV-2026-0006, INV-2026-0036) | over by 9,947.94 (billed 59,687.64 against 49,739.70; INV-2026-0008, INV-2026-0038) |
  | Copilot `get_project` | "Over-billed: needs attention", with the same reason | same |
  | Copilot `prepare_invoice` | refused, with the reason; nothing filed | refused, with the reason; nothing filed |
  | Copilot "what needs attention today" | listed, over by 5,148.12 | listed, over by 9,947.94 |

- **Prepare** (`wf_invoice_prepare`, as n8n 04 calls it) in an always-rolled-back transaction: INVALID_STATE /
  ARITHMETIC_MISMATCH, "… is over-billed …".
- **CLOSED on PRJ-2026-0006** in an always-rolled-back transaction: refused, "PRJ-2026-0006 cannot be closed: it is
  over-billed by 5148.12 … Correct the billing first".
- **Nothing persisted:**
  - exception, approval, event and audit counts were identical before and after;
  - both projects are still COMPLETED;
  - the duplicate invoices are unchanged (INV-2026-0036 and INV-2026-0038 ISSUED). They are left for a person.
- **INV-2026-0039 is untouched.** Only the observe dry-runs' own timestamps and audit events moved.
- **After:** dry-run `RECON-20261004-093533-7f2b` 0 drift; integrity 24 PASS, 3 WARNING, 0 FAIL. Canonical
  fingerprint 173 values `89d72adf…`, unchanged.

**Found during the live check, and fixed before committing (web/lib, tests first):**
- The Copilot's "what needs attention today" and the dashboard's attention list had no over-billed category, so
  PRJ-2026-0006 did not appear in either.
- An over-billing refusal would have been described as "Supplier totals didn't add up".

Now:
- the Copilot lists `over_billed` with `over_by_inc_gst`;
- the attention list has a high-severity "billing" item ("over by $5,148.12");
- `describeIssue` says "Project is over-billed".

The new tests were red before and green after, and both lists were re-verified live through the web login.
Full suite **490 passed**, 0 failed; lint and typecheck clean.

Evidence: [evidence/ac08-live-verification.json](../evidence/ac08-live-verification.json).

## AC-09 evidence package

### 1. How RoofOps calculated billing, before the fix

| Quantity | Where | Rule |
|---|---|---|
| Quote entitlement | `invoice_final_preview` | `quote_versions.total_inc_gst` of the accepted version (GST-inclusive quotes only) |
| Approved variations | `invoice_final_preview` | `variations.amount_inc_gst` with status **APPROVED only** |
| Invoiced variations | `invoice_final_preview` | **not counted** (status INVOICED is set by hand or the import; nothing sets it automatically) |
| Entitlement for over-billing | `project_over_billing` (AC-08) | quote + variations **APPROVED or INVOICED**: a second, different formula |
| Already billed | both | invoices APPROVED, ISSUED, PARTIALLY_PAID, PAID at `total_inc_gst`, VARIATION invoices included; VOIDED excluded; DRAFT/PENDING_APPROVAL block Prepare |
| Progress invoices | both | part of "already billed" |
| Final amount | `invoice_final_preview` | `quote + APPROVED variations − billed`; line 1 = `quote − billed`, plus one line per APPROVED variation |
| GST / rounding | preview, `gst_split` | invoice totals derive from their lines (`gst_split`: inclusive GST = round(total/11, 2), exclusive GST = round(subtotal × 10%, 2)); the final's GST = round(amount × 0.1/1.1, 2) |

Consumers of the preview: Prepare and `wf_invoice_decide` (staleness re-check), the dashboard's readiness and amount,
the close guard, two integrity checks, and the Copilot (via the dashboard).

**The arithmetic defect.** A variation billed on its own VARIATION invoice is subtracted (its invoice is in "billed")
but no longer added once its status is INVOICED. The final invoice is short by exactly that variation. Reproduced on
PRJ-2026-0004 with a $1,100.00 variation:
- with the variation APPROVED and billed: 14,664.49;
- after marking it INVOICED: **13,564.49**.

**Affected real projects: none.** Local and hosted data have no variations at all. Hosted's only FINAL invoice
(INV-2026-0039, PRJ-2026-0004) brings billing to exactly the quote (20,949.27). The defect was latent.

### 2. Canonical formula

`project_billing(project)` is the one calculation:
- `total_entitlement = accepted quote total (inc GST) + variations APPROVED or INVOICED`; PROPOSED and REJECTED never
  count (there is no CANCELLED status);
- `valid_billed = invoices APPROVED, ISSUED, PARTIALLY_PAID or PAID at total_inc_gst`; VOIDED never counts; DRAFT and
  PENDING_APPROVAL block the final invoice;
- `remaining_billable = total_entitlement − valid_billed`: > 0 ready, = 0 fully invoiced, < 0 over-billed (AC-08).

All terms are GST-inclusive cents, so the remaining amount involves no rounding. The final's GST is round(amount/11, 2),
and line 1 (`remaining − not-yet-invoiced approved variations`) plus the variation lines add up to the amount exactly.

### 3. Fix

Migration `20261001100000_one_canonical_billing_entitlement.sql`:
- **`project_billing`** (SECURITY DEFINER, read-only; neither app role executes it directly).
- **`invoice_final_preview`** is redefined in place from AC-08's definition.
  - Amount, billed list, variations (APPROVED + INVOICED) and lines come from `project_billing`.
  - The "variations" figure that 04 and the Copilot show in "quote + variations − already invoiced" now makes that
    sum equal the amount.
  - Line 1's description adds "plus variations already invoiced …" only when there are any.
  - The dashboard, close guard, Copilot, Prepare/decide and integrity read it unchanged.
- **`project_over_billing`** (AC-08) reads `project_billing`; its message and contract are unchanged.
- **`integrity_check`** (AC-05 wrapper, redefined in place) adds `final_invoice_settles_entitlement`: once a final
  invoice exists, `remaining` must be 0. Anything left over (for example a variation approved later) is a WARNING.

### 4. Tests

`test/billing-entitlement.test.ts` checks against an **independent oracle**: integer cents, Postgres half-away-from-zero
rounding, and `gst_split` modelled in the test, never calling RoofOps. Each case checks the preview's amount, GST, billed
total, line sum and the dashboard amount.

| # | Case |
|---|---|
| 1 | no variations |
| 2 | one approved, not yet invoiced variation, with its own line |
| 3 | an already-invoiced variation (VARIATION invoice billed, status INVOICED) |
| 4 + 9 | mixed states: APPROVED and INVOICED count; PROPOSED and REJECTED do not |
| 5 + 13 | progress invoices + a variation + the final invoice through Prepare and approval: final + all prior valid invoices = entitlement exactly; GST per the oracle; then a later variation shows in integrity as WARNING |
| 6 | exactly fully invoiced: FULLY_INVOICED, not over-billed |
| 7 | over-billing stays AC-08's, by exactly the excess |
| 8 | a voided invoice is never billed |
| 10 | GST-inclusive and GST-exclusive invoices: 1,000.05 ex is 1,100.06 inc |
| 11 | one-cent boundaries (0.01 left is ready with GST 0.00; 0 is fully invoiced; 0.01 over is over-billed by 0.01) and half-cent GST rounding |
| 12 | repeated Prepare is idempotent: same approval, same amount, one pending approval |
| — | one rule everywhere: preview, `project_billing` and AC-08 agree |

### 5. Verification (offline)

| Check | Result |
|---|---|
| Red, before the fix | 10 of 24 failed (cases 3, 4+9, 5+13, 12, and the one-rule test, on both engines), each short by exactly the INVOICED variation |
| Ablation A: INVOICED not entitlement | 3, 4+9, 5+13, 6, 12, one rule, AC-08's exact-billing test red |
| Ablation B: PROPOSED counts | 4+9 red |
| Ablation C: REJECTED counts | 4+9 red |
| Ablation D: VOIDED billed | 8 and AC-08 tests red |
| Ablation E: billed ex GST | 18 tests red |
| Ablation F: line 1 ignores variation lines | 2, 4+9, 5+13 red |
| Ablation G: the old final formula | 3, 4+9, 5+13, 12 red |
| Ablation H: over-billing on its own (old) entitlement | 5+13, 6, AC-08's exact-billing test red |
| Ablation I: no settlement check | 5+13 red |
| AC-08, AC-05, AC-04 (+ 07 orchestration), invoice flow, approval binding | 126/126 |
| Full suite, PGlite + Postgres 17 | **514 passed**, 35 skipped, 0 failed; lint and typecheck clean |
| Fresh PostgreSQL 17 chain | 31 applied, 0 on re-run; ready amounts unchanged (PRJ-2026-0004 14,664.49 also as the dashboard role); OVER_BILLED still exactly 0006/0008; new check PASS; integrity 0 FAIL |
| Grants | `project_billing`: neither app role (reached only through the definer functions); dashboard functions unchanged; workflow role 21 `wf_*`; nothing executable by PUBLIC; RLS everywhere |
| Local dev DB | applied alone; integrity 24 PASS, 4 WARNING, 0 FAIL (new check PASS) |
| Migration parity (read-only) | aligned through AC-08; `20261001100000` unused anywhere else |

**Not changed (noted):**
- The final's GST is rounded once on the total, as before. Xero may round per line on a multi-line draft (one with
  variation lines) and differ by a cent. That would be refused at read-back and left UNKNOWN with an exception
  (AC-04), never mis-recorded. Single-line finals, like the only real one so far, are unaffected.

### 6. Proposed hosted verification (approved by the owner 2026-10-06)

1. **Deploy** the migration alone, then run the dry-run, integrity and security checks, with no repair run.
2. **Read-only, through the web login:**
   - the ready-to-invoice amounts and statuses are unchanged (hosted has no variations, so the canonical formula equals
     the old one everywhere);
   - PRJ-2026-0006/0008 are still OVER_BILLED with the same excess;
   - `final_invoice_settles_entitlement` PASSes (PRJ-2026-0004 is settled).
3. **In an always-rolled-back transaction** on a ready project, run the catalogue case: add a $1,100.00 variation and
   its VARIATION invoice, mark it INVOICED, and read the preview. Expected: the amount is unchanged (not $1,100.00
   short), and the lines add up to it.
4. **Confirm** INV-2026-0039 is untouched and the fingerprint is unchanged.

### 7. Hosted verification (2026-10-06)

Evidence: [evidence/ac09-live-verification.json](../evidence/ac09-live-verification.json). No repair run; no Xero invoice created.

| Check | Result |
|---|---|
| Deploy | `20261001100000_one_canonical_billing_entitlement.sql` alone (30 skipped); dataset already imported, nothing else changed |
| Reconciliation dry-run (after deploy, after live checks) | observe, COMPLETED; Airtable 231, Google Drive 3, Xero 1 all in sync, 0 drift |
| Integrity | before 24 PASS, 3 WARNING, 0 FAIL; after 25 PASS, 3 WARNING, 0 FAIL (the same three warnings); `final_invoice_settles_entitlement` PASS |
| Security / grants | all privilege checks pass; dashboard functions unchanged; workflow role 21; nothing executable by PUBLIC; `project_billing` refused to the web login (permission denied) |
| Ready-to-invoice amounts | unchanged: PRJ-2026-0002 15,155.98, PRJ-2026-0005 17,831.91 |
| Over-billed | unchanged: PRJ-2026-0006 over by 5,148.12, PRJ-2026-0008 over by 9,947.94; Copilot's attention list names both with the same excess |
| Billing view of all 33 projects (preview + dashboard status, amount, blocker, needs-attention) | digest identical before, after deploy and after the live checks |
| Web login (`roofops_web`, read-only) | preview, dashboard and Copilot `get_project` agree on every project (0 disagreements); every ready preview's lines add up to its amount |
| PRJ-2026-0004 | project row and its billing unchanged (XERO_DRAFT_CREATED, 14,664.49; remaining 0, so the new check passes) |
| INV-2026-0039 | invoice row, lines and outbox identical; only the Xero link's `last_synced_at` moved (set by the observe dry-runs, as in AC-08) |
| Fingerprint | 173 date values: same sha256 throughout; counts unchanged except the two dry-runs (+2 reconciliation runs, +2 audit events); audit sequence skipped 129–130, ids taken by the rolled-back rows |

**Rolled-back catalogue case** (owner connection, one transaction per ready project, always ROLLBACK):

| Step | PRJ-2026-0005 final | PRJ-2026-0002 final | Old formula would give |
|---|---|---|---|
| As is | 17,831.91 | 15,155.98 | same |
| + variation 1,100.00 APPROVED | 18,931.91 (2 lines) | 16,255.98 (2 lines) | same |
| + its VARIATION invoice 1,100.00 PAID | 17,831.91 | 15,155.98 | same |
| Variation marked INVOICED | **17,831.91** (1 line) | **15,155.98** (1 line) | 16,731.91 / 14,055.98 (**1,100.00 short**) |

- At every step `total_entitlement − valid_billed = remaining_billable` (for example 45,679.78 − 27,847.87 = 17,831.91),
  and the preview's lines add up to its amount.
- In the same transaction, the dashboard, Copilot `get_project` and Copilot `prepare_invoice` agree (17,831.91, GST
  1,621.08; basis "quote 44579.78 + variations 1100 - already invoiced 27847.87").
- Integrity in the transaction: PASS.
- After the rollback nothing is left: 0 variations, 0 test invoices, 0 events, approvals or outbox rows from the run.

**Follow-up, tracked separately:** FIN-GST-01 (per-line GST rounding in Xero on multi-line finals). Not part of AC-09.

## AC-13A evidence package

### 1. The project lifecycle, before the fix

| Step | How it happens | What checks it |
|---|---|---|
| Quote accepted → project | `wf_quote_accepted` (Airtable Status → 01): project PLANNING, checklist (2 PRE_START, 2 COMPLETION, 1 INVOICING item, all OPEN), material-review task, Drive + Airtable write-backs | idempotency key per quote version |
| Planning → Scheduled → In Progress | Airtable Status → 06 → `wf_airtable_change` → `project_apply_change` | `state_transitions(project)`; Planned Start required; Actual Start set |
| In Progress → Completed | same path | state machine; Actual Completion set; nothing else |
| Final invoice eligibility | `invoice_final_preview`: Completed; **completion documents**; no final (AC-05); nothing unapproved; not over-billed (AC-08); remaining > 0 (AC-09) | Prepare, approval re-check, dashboard, Copilot |
| Fully invoiced | the preview's ARITHMETIC_MISMATCH | dashboard FULLY_INVOICED |
| Paid | invoice status PAID (import only; RoofOps finals stay APPROVED: AC-14) | money owed views |
| Closed | Completed → Closed: not over-billed; every invoice PAID or VOIDED; a final invoice, or the preview says ARITHMETIC_MISMATCH | `project_transition_guard` |
| Cancelled | any active status, or Completed while no final invoice exists | `project_transition_guard` |

**The lifecycle defect.** The two required COMPLETION items (Completion Photos, Compliance Certificate) gate the final
invoice, but nothing could set them: the field contract said "no staff UI; NOT SUPPORTED" and no function updates
checklist status. Every project born from quote acceptance therefore stops at Completed: Prepare and the dashboard say
"missing completion documents; invoice after they are uploaded" (no upload is read anywhere), and Closed is refused
with "the final invoice has not been raised yet". Two related contradictions:
- a fully billed project with paperwork open was shown as "invoice after the documents" instead of fully invoiced;
- the close guard trusted the preview's error class, so its reason was wrong whenever the paperwork check fired
  first, and a project whose final existed could close with entitlement left over (a variation approved later).

**Affected real projects (hosted, read-only survey).**
- **Stuck now:** PRJ-2026-0007. It was imported Completed with Completion Photos never marked and has 25,587.26 left
  to bill. It was NOT_READY with no supported path.
- **Latent:** PRJ-2026-0031, PRJ-2026-0032 and PRJ-2026-0033. They were born from quote acceptance, are still in
  Planning, and have both items OPEN, so they would be stuck once completed.
- **Would contradict once completed:** PRJ-2026-0012, 0015, 0022 and 0030. They are fully billed while not completed
  and have photos OPEN.

The fix changes none of their canonical data. PRJ-2026-0007 now names the action, and a person sets Completion Photos
in Airtable.

### 2. The invariant: when a project may…

- **become COMPLETED**: only from In Progress (state machine). A completion item may be Done only once work started.
- **prepare a final invoice**: Completed; every required COMPLETION item Done, Waived or Not applicable; no final yet
  (AC-05); nothing unapproved; not over-billed (AC-08); `remaining_billable` > 0 (AC-09 `project_billing`).
- **be fully invoiced**: `remaining_billable` = 0, whatever the paperwork says.
- **be CLOSED**: Completed; `remaining_billable` = 0; every invoice PAID or VOIDED; completion gate satisfied; no
  preview awaiting approval; no Xero write in flight or uncertain (AC-04 semantics).

Completion items change only through Airtable. Postgres enforces:
- the checklist state machine (Done → Waived needs To do first);
- a reason in the item's Note for Waived or Not applicable;
- an Airtable user mapped to a RoofOps employee (a reconciler replay has no user, so it is refused and a person sets it
  again);
- a lock once a final invoice exists or is being created, or the job is Closed or Cancelled.

### 3. Fix

- **Airtable (additive)**: Projects gains Completion Photos and Compliance Certificate (To do / Done / Waived / Not
  applicable), plus a Note for each.
- **Migration `20261001110000_completion_gate_has_a_supported_path.sql`**:
  - field contract rows (status fields `AIRTABLE_EDIT` via the handler; Notes `INPUT`);
  - `checklist_apply_change`, reached only from `project_apply_change` inside `wf_airtable_change`; neither app role
    can call it;
  - the projection in `v_airtable_expected` (06 corrections and reconciliation compare it);
  - `invoice_final_preview` checks paperwork after billing, and its message names the Airtable action;
  - `project_transition_guard` closes only a settled project (`project_billing`), with an exact reason;
  - `v_dashboard_projects` flags entitlement left over after the final (needs attention, via a narrow
    `project_left_to_bill_after_final` granted to the dashboard);
  - integrity adds `closed_project_settled` (FAIL) and `completed_awaiting_completion_items` (WARNING).
- **n8n**: 06 watches the two fields (their Notes travel in "current"); 03 writes both To do on a new project and
  verifies them on read-back.
- **Other**: the source schema map, the initial-load payload, the Copilot/dashboard explanation, and the security
  allow-list.

### 4. Tests and ablations

`test/project-lifecycle.test.ts` covers the 13 cases on a project born from quote acceptance and on imported projects:
1. creation and projection;
2. no work started;
3. in progress (attribution, reason, state machine, undo);
4. completed but not fully invoiced (PRJ-2026-0007 too);
5. and 6. the final raised, then fully invoiced but unpaid;
7. fully paid, then Closed;
8. cancelled;
9. a variation after completion;
10. an UNKNOWN Xero write and an in-flight approval;
11. over-billed;
12. entitlement growing after the final;
13. duplicate, out-of-order and unattributed events.

It also has an integrity test with a negative case. `test/n8n-completion-fields.test.ts` runs the real 06 and 03 code.

| Check | Result |
|---|---|
| Red, before the fix | 13 of 13 lifecycle tests; 5 of 5 n8n tests |
| Ablations | 15, each red on its own tests: no Airtable path, no attribution, no reason, Done before work started, no final-invoice lock, no in-flight lock, no Closed/Cancelled lock, no state-machine check, paperwork before billing, close ignores remaining / gate / Xero in flight, dashboard hides left-over, no closed-settled check, no projection |
| Regressions (AC-09, AC-08, AC-05, AC-06, AC-04 + 07, invoice flow, approval binding, state integrity, quote workflow) | 304 passed, 0 failed |
| Full suite, PGlite + Postgres 17 | **550 passed**, 35 skipped, 0 failed; lint and typecheck clean |
| Fresh chain | through AC-09 (31), then AC-13A alone: every ready amount, status and OVER_BILLED unchanged; only PRJ-2026-0007's blocker and two close reasons became exact; integrity 0 FAIL; as the dashboard role too |
| Grants | `checklist_apply_change` and `project_billing`: no app role; the dashboard gains only `project_left_to_bill_after_final`; workflow role 21; nothing executable by PUBLIC; RLS everywhere |

### 5. Hosted deployment (2026-10-06)

1. The four Airtable fields were created (additive).
2. Their values were written once from the canonical checklist (33 records, one call), so no reconciliation ever saw a
   blank field while RoofOps held a value.
3. The migration was deployed alone (checksum `cb7c7e8e`).
4. 06 was published (`4cc8d1d3` → `9a2eb69e`), then 03 (`f69177d9` → `737a7a66`).

| Check | Result |
|---|---|
| Reconciliation dry-run (after deploy, after live checks) | observe, COMPLETED; Airtable 231, Drive 3, Xero 1; 0 drift (the new fields included) |
| Integrity | before 25 PASS, 3 WARNING, 0 FAIL; after 26 PASS, 4 WARNING, 0 FAIL (new WARNING: PRJ-2026-0007 waiting on Completion Photos) |
| Security | all privilege checks pass; `checklist_apply_change` and `project_billing` refused to the web login |
| Billing view, checklist, invoices, projects, INV-2026-0039 | digests identical before, after deploy and at the end |
| Ready / over-billed | PRJ-2026-0002 15,155.98, PRJ-2026-0005 17,831.91; PRJ-2026-0006 / 0008 OVER_BILLED, unchanged |
| Fingerprint | 173 date values, same sha256 throughout |
| Counts | +2 reconciliation runs with 2 audit events (dry-runs); +2 attributed checklist audits (the live set-and-revert) |

**Live, through real Airtable, on PRJ-2026-0031 (Planning).**

| Edit | Result |
|---|---|
| Completion Photos = Done | Postgres refused it ("work has not started"). 06 wrote To do and a RoofOps Sync note back and read them back (verified). The echo of 06's own write was NO_CHANGE. |
| Compliance Certificate = Not applicable + Note | Applied, attributed to `usr7uCnNO15fCefbH` → EMP-900, and the Note was stored as the reason. |
| Back to To do, Note cleared | Applied. Net canonical change: none. |

Through the web login, read-only:
- the dashboard and the Copilot give PRJ-2026-0007 the same reason and name the Airtable action;
- the Copilot refuses to prepare it;
- the new integrity checks are as above.

**Not changed (tracked separately):**
- AC-14: RoofOps final invoices never move past APPROVED, so a RoofOps-born project cannot reach Closed. Hosted
  PRJ-2026-0004 is refused with "not every invoice is paid yet: INV-2026-0039 (approved)".
- AC-15: imported, untyped final bills and cancellation.
- AC-13B: PRE_START items and the Scheduled → In Progress gate.
- LIFE-01: the "Final invoice approved" checklist row never updates (cosmetic).

## AC-14 evidence package

### 1. Map, before the fix

| Piece | What it does |
|---|---|
| RoofOps invoice states | DRAFT → PENDING_APPROVAL → APPROVED → ISSUED → PARTIALLY_PAID → PAID; VOIDED. A RoofOps FINAL is created APPROVED with sync PENDING (`wf_invoice_decide`); nothing ever moved it further (only the import sets ISSUED/PAID). PAID was terminal. |
| Xero invoice states | DRAFT, SUBMITTED, AUTHORISED, PAID, VOIDED, DELETED (Xero OpenAPI); Total, AmountDue, AmountPaid, AmountCredited, FullyPaidOnDate, UpdatedDateUTC, Payments[]. A payment can be removed, so PAID can go back to AUTHORISED. |
| Amounts | `v_invoice_balances`: paid = sum(payments) (import only), outstanding = total − paid; money owed counts ISSUED / PARTIALLY_PAID only. |
| 05 (write) | Creates the ACCREC DRAFT in the pinned Demo tenant, reads it back (DRAFT, AmountPaid 0, total, tax, contact, number, reference), and Postgres links it (`external_links` XERO Invoice) and marks it SYNCED. AmountDue is never read. |
| 07 (reconcile) | Reads every linked invoice (`GET /Invoices/{InvoiceID}`, current pin); `wf_reconcile_external` compared existence, total and reference only, not status, amounts or tenant. The read had no error handling. No Xero webhook exists. |
| Close guard | Completed → Closed: every invoice status PAID or VOIDED (a local flag), plus AC-08 / AC-09 / AC-13A rules. |
| AC-05 void guard | Refuses a local void of an invoice with a Xero draft: "Void or delete it in Xero first", but nothing read a Xero void back. |

**The lifecycle dead end.** Once a RoofOps final is in Xero, its RoofOps status is APPROVED for ever, whatever happens in
Xero (authorised, part paid, paid, voided), so a project with a RoofOps final can never satisfy "every invoice PAID" and
never closes; money owed never counts it. **Affected real project:** PRJ-2026-0004 (INV-2026-0039 is the only Xero-linked
invoice on hosted; it was created as a DRAFT and is still APPROVED). Hosted's 27 PAID invoices are all imported, and
their imported payments cover them, so the stricter rule below changes no other outcome.

### 2. Canonical mapping (Xero → RoofOps)

Only from a VERIFIED read: the linked InvoiceID, read in the write's bound tenant (which is also the pinned one), ACCREC,
the expected invoice number and total, and AmountPaid + AmountCredited + AmountDue = Total.

| Xero | Financial state | RoofOps status |
|---|---|---|
| DRAFT / SUBMITTED, nothing paid | NOT_ISSUED | APPROVED |
| AUTHORISED, nothing paid or credited | UNPAID | ISSUED |
| AUTHORISED, 0 < AmountDue < Total | PARTIALLY_PAID | PARTIALLY_PAID |
| PAID, AmountDue 0 | PAID | PAID |
| VOIDED | VOIDED | VOIDED (the only void allowed past AC-05's guard) |
| DELETED | DELETED | unchanged; a person decides (EXTERNAL_MISSING exception, as before) |
| lookup failed / wrong tenant / identity mismatch / amounts that do not add up | ambiguous | unchanged; recorded, never inferred |

- **Record and apply.** 07 records every read in `xero_invoice_observations` (append-only, one per invoice per run). A
  repair run (the daily one) applies the verified state through the invoice state machine; a dry run only records it.
- **Reversal.** A reversed payment regresses the invoice (PAID → ISSUED / PARTIALLY_PAID; new transitions; PAID is no
  longer terminal) and opens an exception. On a Closed project it is also an integrity FAIL.
- **AC-04.** Only a SYNCED write is ever applied; UNKNOWN or PENDING never is.
- **Money owed.** For a Xero-linked invoice it is what Xero says is due.

### 3. The invariant: when an invoice counts as settled (closing)

- **Xero-linked**: the latest read is VERIFIED, says PAID or VOIDED, RoofOps shows the same, and the read is younger
  than `xero.settlement_max_age_hours` (36).
- **Not settled (Xero-linked)**: a failed, wrong-tenant or mismatched read; no read at all; an UNKNOWN or PENDING write.
- **Imported**: PAID with the import's payments covering the total.
- **Other**: VOIDED (a local void, AC-05-guarded).
- **Never enough**: a local PAID flag alone.

Closed requires every invoice settled, plus AC-08, AC-09 and AC-13A.

### 4. Tests and ablations

`test/xero-settlement.test.ts` runs 07's real nodes (Read Request through Record Xero Findings) against a fake Xero:
1. draft;
2. authorised and unpaid (a dry run records but changes nothing);
3. partially paid;
4. and 11. fully paid, and the project closes;
5. and 13. voided in Xero, and a local void still refused;
6. a payment reversed;
6b. a reversal on a Closed project (integrity FAIL);
7. HTTP 500 and a network error;
8. and 14. a read in another tenant, and the pin moved after the write;
9. repeated runs (one transition, one audit);
10. paid after RoofOps last looked;
11. a local PAID flag, and a stale verification;
12. an UNKNOWN write.

Plus identity mismatch, amounts that do not add up, DELETED, and the integrity check.

**AC-13A lifecycle cases 7 and 12 corrected.** They forced an invoice PAID locally and expected that to settle it, which
is the trust AC-14 removes. They now settle through a verified Xero read (`settleInXero`), and case 7 also proves a
local PAID alone is refused. Their intent is unchanged.

| Check | Result |
|---|---|
| Red, before the fix | 16 of 16 (a Xero-PAID final stayed APPROVED; close: "not every invoice is paid yet: … (approved)"; no observations) |
| Ablations | 16, each red on its own tests: nothing recorded, no tenant check, lookup failure unchecked, no identity check, no arithmetic check, dry run applies, applies to an unsettled write, close trusts local PAID, no freshness, void guard accepts any verified read, no exception on reversal, no reversal transitions, balances ignore Xero, no state-verified check, 07 read aborts on error, 07 drops the Xero fields |
| Regressions (AC-14, AC-13A, AC-09, AC-08, AC-05, AC-06, AC-04 + 07, invoice flow, approval binding, state integrity) | 315 passed, 0 failed (3 consecutive runs; one earlier run had 2 failures that did not reproduce and whose detail was not captured) |
| Full suite, PGlite + Postgres 17 | **582 passed**, 35 skipped, 0 failed; lint and typecheck clean |
| Fresh chain | through AC-13A (32), then AC-14 alone: every project's dashboard status, amount, money owed and close reason, and every invoice balance, unchanged; integrity 0 FAIL (both new checks PASS); as the dashboard role too |
| Grants | `xero_record_settlement`, `invoice_financial_state` and `xero_invoice_observations`: no app role (reached through `wf_reconcile_external` and the views); dashboard functions unchanged; workflow role 21; nothing executable by PUBLIC; RLS everywhere |
| Local dev DB | applied alone; integrity 26 PASS, 5 WARNING, 0 FAIL |

### 5. Not changed (noted)

- **No Xero webhook.** Payments are seen at the next 07 run, daily, or on demand with `npm run reconcile`. Until
  then closing waits, by design.
- **Payments are not mirrored row by row.** The verified amounts and the payment list are kept on each observation.
- **AC-15** (Completed → Cancelled and untyped imported finals) and **AC-13B** are separate.

### 6. Proposed hosted verification (approved by the owner 2026-10-06)

1. **Deploy** the migration alone and publish 07 (the read gets error handling; Record Xero Findings passes the read
   tenant and the verified fields). Run the dry-run, integrity and security checks. No repair run.
2. **The dry-run** reads INV-2026-0039 in the pinned Demo tenant (read-only GET). Expected: VERIFIED NOT_ISSUED (it is a
   DRAFT), RoofOps stays APPROVED, 0 drift; `xero_invoice_state_verified` PASS. PRJ-2026-0004's close reason becomes
   "not issued in Xero yet".
3. **Read-only through the web login**: money owed and dashboard unchanged.
4. **Rolled-back proof on hosted**: a synthetic verified PAID observation in a transaction that is always rolled back
   shows the close guard would accept PRJ-2026-0004. INV-2026-0039 in Xero is not touched (no authorise, no payment).

### 7. Hosted verification (2026-10-06)

Evidence: [evidence/ac14-live-verification.json](../evidence/ac14-live-verification.json). No repair run; nothing written to
Xero.

- **Before**: the working tree equalled `6b90dbe` (HEAD = origin/main, migration byte-identical); AC-14 and the
  AC-04/05/06 tests re-run: 130 passed.
- **Order**: 07 was published first (`1737a07a` → `a0ca9e60`), because the new 07 is harmless against the old
  Postgres. The reverse order would have let a scheduled 07 run file a false wrong-tenant read. Then the migration went
  alone (`ef03aed9`; 32 skipped). Hosted and repo match: 33 of 33 migration checksums; live 07 nodes equal the repo.

| Check | Result |
|---|---|
| Reconciliation dry-run | observe, COMPLETED; Airtable 231, Drive 3, Xero 1; 0 drift |
| Live read of INV-2026-0039 | VERIFIED: Xero DRAFT, total 14,664.49, due 14,664.49, paid 0, credited 0; read in the bound tenant, which is the pinned one, on the linked InvoiceID → NOT_ISSUED → RoofOps APPROVED (unchanged, matches) |
| PRJ-2026-0004 close blocker | was "INV-2026-0039 (approved)"; now "INV-2026-0039 (not issued in Xero yet (verified …))" |
| Integrity | before 26 PASS, 4 WARNING, 0 FAIL; after 27 PASS, 4 WARNING, 0 FAIL (`xero_invoice_state_verified` PASS; same warnings) |
| Security | all privilege checks pass; web login refused `xero_record_settlement`, `invoice_financial_state` and the observations table |
| Unchanged | invoices, projects, dashboard, INV-2026-0039 (row, outbox, links) and the 173-value fingerprint; balances differ only in formatting (0 → 0.00 for INV-2026-0039's amount paid) |
| Counts | one dry-run: +1 reconciliation run, +1 audit event |

**Rolled-back proofs on hosted** (each in its own always-rolled-back transaction; synthetic Xero answers passed to
`wf_reconcile_external` exactly as 07 does; no Xero call):

| Proof | Result |
|---|---|
| A verified PAID read | applied APPROVED → ISSUED → PAID (2 audits); PRJ-2026-0004 close guard: no blocker |
| AC-04: the same read while the write is UNKNOWN | recorded, not applied (APPROVED); close: "in flight or uncertain" |
| AC-05: a local void of INV-2026-0039 | refused: "Void or delete it in Xero first" |
| AC-06: a read in another tenant / after the pin moved | WRONG_TENANT, nothing applied, PERMISSION_DENIED exception; close refused |
| Afterwards | nothing left: 0 runs, 0 observations from the proofs; INV-2026-0039 still VERIFIED NOT_ISSUED |

## AC-14B evidence package

Offline only (PGlite and a locally installed PostgreSQL 17). Nothing hosted: no deploy, no dry-run, no repair run, no
Xero/Airtable/n8n/Supabase call. Fix: migration `20261001130000_xero_verified_void_is_not_an_integrity_failure.sql`
(checksum `24f343eb`) plus `test/xero-settlement.test.ts` cases 15-20.
Evidence: [evidence/ac14b-offline-verification.md](../evidence/ac14b-offline-verification.md).

**The contradiction.** AC-14 (`20261001120000`) follows a Xero void: 07 records `VERIFIED / VOIDED` and a repair run
applies `APPROVED → VOIDED`. AC-05's predicate (`20261001120000:381-388`) still failed every `VOIDED`, RoofOps-origin
invoice with a Xero write or link, so a designed state left the gate red (`FAIL voided_invoice_has_no_xero_write →
INV-2026-0039` while `xero_invoice_state_verified` PASSed; `scripts/integrity-check.ts` exits 1 on any FAIL).

**The rule.** Unchanged for everything but a verified void: a locally or bypass-voided invoice with an active or
unexplained Xero side effect still FAILs. It is VALID only when the exact linked Xero invoice was read
`VERIFIED / VOIDED` in the tenant its write is bound to - the condition `invoice_void_guard` already trusts. The
exemption asks whether such an observation **exists** (not "is latest": a void is irreversible, so a transient
`LOOKUP_FAILED` read must not flicker the check, and repeated repair runs must stay stable) **and** no later `VERIFIED`
observation of that same linked `InvoiceID` says something else (case 20). Only the predicate and its detail text
changed; the rest of the wrapper is `20261001120000`'s.

| Check | Result |
|---|---|
| Red, before the fix | cases 15, 16, 20 red (`Tests 3 failed, 19 passed (22)`); the three negatives pass before and after, as they must |
| Ablations (applied, run, reverted) | whole exemption → 15, 16, 20; tenant condition → 18; linked-invoice condition → 19; `settlement = 'VOIDED'` → 17, 20; "no later VERIFIED different settlement" → 20 |
| Regressions (AC-05, AC-06, AC-04, AC-14, AC-13A, state integrity) | 102 passed, 5 skipped, 0 failed |
| Full suite | PGlite 314 passed / 35 skipped; PGlite + PostgreSQL 17 594 passed / 35 skipped; 0 failed; lint and typecheck clean |
| Fresh chain | 34 migrations from zero; integrity 26 PASS, 5 WARNING, 0 FAIL; `voided_invoice_has_no_xero_write` PASS on the untouched dataset |
| Grants | all `scripts/security-check.ts` assertions pass locally; the `roofops_dashboard` (16) and `roofops_workflow` (21) role sets are identical with and without the migration, so the blanket revoke needs only the restated `integrity_check()` grant |
| AC-05 | not weakened: negatives (a) `test/invoice-void.test.ts` safety net, (b) case 17, (c) case 18, (d) case 19 all still FAIL |
| Status | **Fixed offline**; live verification not done |

## AC-14C evidence package (Parts A, B1, B2 and C — complete, **Fixed offline**)

Offline only (PGlite and a locally installed PostgreSQL 17.11). Nothing hosted: no deploy, no dry-run, no repair run, no
Xero/Airtable/n8n/Supabase call. Part A (the deletion follows the void path) is migration
`20261001140000_xero_deletion_follows_the_void_path.sql` (checksum `ba0252d5`) plus `test/xero-settlement.test.ts`
cases 21-26. Part B1 (single-live draft generations, voided balance) is
`20261001150000_one_live_xero_draft_generation.sql` + `20261001160000_voided_invoice_has_no_collectible_balance.sql`
with `test/xero-generations.test.ts` and `test/balance-read-model.test.ts`. Part B2 (the supervised reissue and the
operator CLI) is `20261001170000_supervised_final_invoice_reissue.sql` with `test/xero-reissue.test.ts`,
`test/reissue-cli.test.ts`, `scripts/reissue.ts` and the extended `scripts/security-check.ts`. Part C is the
end-to-end recovery proof (`test/xero-reissue-lifecycle.test.ts`, both engines) and the final battery.
Evidence: [evidence/ac14c-partA-offline-verification.md](../evidence/ac14c-partA-offline-verification.md),
[evidence/ac14c-partB1-offline-verification.md](../evidence/ac14c-partB1-offline-verification.md),
[evidence/ac14c-partB2-offline-verification.md](../evidence/ac14c-partB2-offline-verification.md),
[evidence/ac14c-partC-offline-verification.md](../evidence/ac14c-partC-offline-verification.md).

**The dead end.** A draft created in Xero and then DELETED in Xero: `xero_settlement` returns `DELETED`, but
`xero_settlement_status('DELETED')` returned NULL, so `xero_record_settlement` (`continue when v_target is null`)
changed nothing. The invoice stayed `APPROVED / SYNCED` for ever, the external reader opened its usual
`EXTERNAL_MISSING` exception, and the project could not close ("not every invoice is paid yet: INV-2026-0039 (deleted in
Xero; a person decides)") although the customer owed nothing. Reproduced as case 21 red before the fix.

**The rule.** A verified deletion with no money movement anywhere on the invoice is the same business state as a void
and follows the same path. Only a VERIFIED read applies (repair runs only), which already means the bound tenant and the
linked InvoiceID (`WRONG_TENANT`, `MISMATCH` otherwise). `APPROVED | ISSUED -> VOIDED` with
`voided_reason = 'Deleted in Xero (verified by reconciliation <run_key>)'`. Guard: the observation's `amount_paid` is
present and 0, `coalesce(amount_credited, 0) = 0`, and there is no local `payments` row; otherwise nothing changes and a
`REQUIRES_HUMAN` finding plus a `RECONCILIATION_MISMATCH` exception is raised (the existing cannot-follow escalation;
`EXTERNAL_MISSING` from the external reader is untouched). A later `LOOKUP_FAILED` read applies nothing and undoes
nothing; a later VERIFIED read that is neither voided nor deleted re-fails AC-05 (ordering). `invoice_financial_state`
reports an applied deletion as settled with the deletion named; an unapplied one keeps "a person decides".

| Check | Result |
|---|---|
| Red, before the fix | cases 21, 22, 25, 26 red (8 failed, 46 passed, 54 tests; both engines). Cases 23 (wrong tenant) and 24 (different Xero invoice) assert "nothing changes", so they are proved by ablation instead |
| Ablations (applied, run, reverted) | whole DELETED apply/exemption -> 21; money guard -> 22; tenant condition -> 23; linked-InvoiceID condition -> 24 |
| Regressions (AC-05, AC-06, AC-04, AC-14, AC-14B, AC-13A, billing, state integrity) | 243 passed, 5 skipped, 0 failed |
| Full suite | PGlite 319 passed / 35 skipped; PGlite + PostgreSQL 17 604 passed / 35 skipped; 0 failed; lint and typecheck clean |
| Fresh chain | 35 migrations from zero (ending with this one), import IMPORTED, second migrate 0 applied / 35 skipped; `integrity:check --local` 26 PASS, 5 WARNING, 0 FAIL; `voided_invoice_has_no_xero_write` PASS |
| Grants | all `scripts/security-check.ts` assertions pass locally; `roofops_dashboard` (16) and `roofops_workflow` (21) role sets byte-identical with and without the migration |
| Contract docs | `npm run contract:export` changed nothing (no new transition or field) |
| Known follow-up (resolved by Part B1b) | `v_invoice_balances` reported a deletion-voided invoice's full total outstanding while the dashboard's money-owed ignored VOIDED rows (measured at Part A: balance 0 paid / 14,664.49 outstanding; dashboard `outstanding_inc_gst` 0). `20261001160000_voided_invoice_has_no_collectible_balance.sql` now reports `outstanding = 0` and never overdue for every void path while `project_billing` keeps the debt billable (VAL-BAL-001…007) |
| Status | **Fixed offline** (Parts A, B1, B2 and C complete): final battery on the frozen tree `3a12de4` — lint and typecheck exit 0, PGlite 370 passed / 36 skipped, PostgreSQL 17 dual 707 passed / 36 skipped, 0 failed; fresh chain 38 migrations with integrity 26 PASS / 5 WARNING / 0 FAIL; 13/13 local privilege assertions; two-connection concurrency one-winner; nine ablations; additive-only migrations. Live verification not done; not deployed |

