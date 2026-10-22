# Project recovery report (2026-10-22)

Read-only recovery of Roofops Lite and Advanced Roofops, then the next Advanced milestone resumed locally. Nothing was
committed, deployed, published, sent, or written to Airtable, Twilio, Xero, Drive, n8n or hosted Supabase.

Verification labels: **LIVE** (read today from the hosted or cloud system), **LOCAL** (run in this repo), **DOC** (from a
dated document or transcript only, not re-read today), **NOT VERIFIED** (could not be checked here).

## 1. Recovered state: what actually exists

**Advanced Roofops (hosted Supabase, n8n Cloud, Airtable, Drive, Xero Demo)**

- Migrations: 56 applied on hosted; head `20261017060000_quote_publish_lifecycle.sql` (LIVE: `schema_migrations` read, read-only).
- `npm run integrity:check` on hosted: 30 PASS, 4 WARNING, 0 FAIL (LIVE). Warnings: PRJ-2026-0001 open PO; Q-2026-0031 accepted with no
  project; four open workflow exceptions; business date SYNTHETIC (2026-09-29, real date 2026-10-22).
- `npm run security:check` on hosted: all 16 privilege checks pass (LIVE).
- n8n: workflows 01–08 active; 09 Staff Xero Dispatch inactive; 10 Airtable Quote Publish inactive with trigger disabled (LIVE).
  Workflow 10 has exactly one execution, 3080, manual and successful, 2026-10-20 (LIVE).
- The first real quotation hand-off happened on 2026-10-20: synthetic quote Q-2026-0066 for CUST-0041 / PROP-0053, one Airtable
  record each, no duplicates, no exceptions, Xero untouched (DOC: `evidence/quote-integration-test-20261020.md`).
- Acceptance-criteria defects: AC-01 to AC-14C are FIXED (live-verified) per `docs/defect-ledger.md`. AC-13B is the next defect in
  the owner's order (the ledger says each defect starts only on instruction; the owner's current instruction resumes development).

**Corrections to the brief's memory**

- "Stage 2/3" is not a roadmap in the repo. Stages name owner-approved deployment steps (AC-14C, STAFF-OPS-01). The roadmap is
  the defect ledger's owner order (`docs/defect-ledger.md` line 7).
- "Workflow 10 installed but inactive" is correct, but it has already run once (execution 3080). The "supervised Airtable quote
  hand-off" milestone is therefore done for one synthetic quote. Its next step, Accepted → project, has no record and needs approval.

## 2. Roofops Lite: verified versus outstanding

**Verified**

- Local: `test/lite.test.ts` 70/70 pass (LOCAL). Lite uses no Supabase or Postgres (LOCAL, grep of `lite/`).
- Cloud, test sink, no SMS: the release-gate runs (3095–3510) are documented in `evidence/lite-*.md` (DOC). Lead Reactivation and
  Google Review Requests are inactive and test-sink builds, consistent with their descriptions (LIVE). Instant Lead Follow-Up and
  Monitor are inactive but do not match their descriptions (see the open state below).
- Real Twilio API, refused before any message: executions 3198, 3209 and 3215 (20 Oct) got HTTP 422, code 572002 (trial account,
  unverified destination), no Message SID, logged Failed. Twilio creates no message for a refused request. **This is the answer to
  "n8n reported an execution but Twilio showed nothing":** the run finished normally because Lite logs a permanent refusal as
  Failed and does not throw (DOC evidence, consistent with the execution data read today).
- Live test S7, 21 Oct 15:29:50Z (the owner's manual run of Lead Follow-Up): Airtable Message Log row `LM-20261021152950-XRQA`
  reads Status **Failed**, code **572003**, "The 'from' number isn't assigned to this verified messaging recipient … (not sent)",
  provider twilio, no SID (LIVE, read today). Root cause: the trial build sends no `From`, and Twilio's trial rules now require
  the assigned trial number. **No SMS was sent.** The owner then stopped the test at 15:36Z.
- The "no [Lite] run after 12:51Z" observation does not contradict this: the live Lead Follow-Up was deployed not to store manual
  executions, so the 15:29 run is not in n8n's list. An independent critic marked the 572003 refusal unsupported on the basis of that gap; the inference was wrong, because the Airtable row is direct evidence.

**Open safety state (needs the owner's decision; I did not change any of it)**

1. **`[Lite] Inbound Replies` (3Jeal7RQAhUmgLZ3) is ACTIVE (published) at the production reply webhook** (LIVE, read today).
   Its description still says "Unpublished". The owner approved publishing for about 20 minutes on 21 Oct (13:29Z); the owner's
   standing rule is "Keep every workflow unpublished". Its traffic is not visible in n8n (successful runs are not stored).
2. **`[Lite] Instant Lead Follow-Up` and `[Lite] Monitor` still hold the live one-recipient Twilio configuration** (mode `twilio`,
   one allowlisted number ending 771), while their descriptions say "test sink" (DOC: two readers' config reads). Both are
   inactive. Executing either now would make a real trial send to that number.
3. Whether the Twilio Console "Try out SMS" auto-reply webhook (step S5) was saved is **not verified**; the Twilio tools here can
   search documentation only, not account messages or settings.
4. Lite live acceptance: S1–S4 and S6 passed on 21 Oct; S5 was a console step for the owner; S7 failed (572003); S8–S12 not run.
   Real delivery of one SMS has **not** been proven.
5. Documentation drift to fix: `lite/DELIVERY-CHECKLIST.md` says 49 tests (now 70); `lite/README.md` says no pagination
   (now paginated lookups exist); `evidence/lite-twilio-starter-20261021.md` describes the login in the reply URL and a PREFIX_MATCH
   rule, both superseded by EXACT_MATCH (DOC, reader findings, not all re-checked).
6. Helper workflows that handle credentials: `[Lite] Twilio Account SID` (reads the Account list, which includes the Auth Token;
   execution saving off) and `[Lite] Twilio Webhook Login Setup`. Both inactive. Recommend deleting them after the live test.

## 3. Advanced Roofops: where development resumed

- **Milestone:** AC-13B, the pre-start gate. Work may start (Scheduled → In Progress) only when SWMS Signed and Materials Reviewed
  are satisfied. Before this, nothing could set those items, and PRJ-2026-0031 (born from a quote) could start with both OPEN.
- **Parked work:** the gate was built and tested offline on 2026-10-06 in commit `491f1da` on `backup/pre-factory-local-work`, then
  parked. Its migration number `20261001130000` collides with an applied file, and its functions were written against a schema
  that later migrations changed. So it was ported, not cherry-picked.
- **Branch:** `feature/advanced-ac13b-pre-start-gate`, created from `feature/roofops-lite` HEAD `c941574`. **Nothing committed.**

## 4. Changes implemented (uncommitted, working tree)

| File | Change |
|---|---|
| `supabase/migrations/20261022000000_pre_start_gate_before_work_starts.sql` | New. Field contract rows; setting `checklist.not_waivable`; `checklist_apply_change` (latest 20261001110000 + pre-start delta, project row locked first); `project_apply_change`; `v_airtable_expected`; `project_transition_guard` (gate keyed on status SCHEDULED); `integrity_check` (`started_with_pre_start_open`); `v_dashboard_project_checklist` (review fix). |
| `ops/rollback/20261022000000_pre_start_gate_before_work_starts.down.sql` | New. Restores the latest prior definitions of each changed function and view, plus the field-contract rows and setting. |
| `n8n/06-airtable-changes.sdk.ts`, `n8n/03-airtable-project-writeback.sdk.ts` | Watch and write the two new Airtable fields. Not deployed. |
| `src/integrations/airtable/schema.ts`, `scripts/airtable-payload.ts` | Field IDs for the two fields and their Notes. |
| `test/pre-start-gate.test.ts` (new), `test/n8n-pre-start-fields.test.ts` (new) | 20 and 4 cases. |
| `test/project-lifecycle.test.ts`, `test/xero-reissue-lifecycle.test.ts`, `test/n8n-completion-fields.test.ts` | Add the two pre-start steps before In Progress. No assertion weakened. |
| `docs/defect-ledger.md`, `docs/source-of-truth.md`, `docs/source-of-truth.json` | AC-13B "Fixed offline" with its evidence; contract regenerated. |
| `evidence/ac13b-offline-verification.md` (new) | Red result, rebase table, review findings and fixes, verification, hosted steps, open items. |

Not touched and not part of this change: `ops/staging/` and `test/staging.test.ts` (untracked, an owner decision); screenshots,
`.claude/launch.json`, `web/next-env.d.ts` (pre-existing uncommitted changes).

## 5. Test evidence

| Check | Result |
|---|---|
| Red before the migration (WIP tests, unchanged) | 18 of 20 red (gate 14/16, n8n 4/4) |
| Focused suite after the port and review fixes | 5 files, **48 passed** |
| Ablation 1: gate keyed on Actual Start instead of status | the new bypass test goes red; migration restored byte for byte |
| Ablation 2: dashboard card reverted to the 17 Oct display | the new card test goes red; migration restored byte for byte |
| Rollback round trip (PGlite, scratch script) | applying changes 4 functions and 2 views; after rollback every function, view, field-contract row and setting is identical to before; migrations back to 56 |
| `npm run check` (lint, typecheck, typecheck:web, full suite) | **exit 0**; 58 files passed, 3 skipped; **654 passed, 46 skipped** (700) |

**Not verified:** the two-connection race (checklist change vs. start, Postgres 17; needs TEST_DATABASE_URL); anything on
hosted or in n8n for AC-13B (no hosted writes, no deploy); the Airtable select labels for the two new fields.

## 6. Blockers and approvals needed (none acted on)

1. **Lite:** unpublish `[Lite] Inbound Replies`, or record a scoped approval with an end time.
2. **Lite:** restore the test-sink configuration on Instant Lead Follow-Up and Monitor, or approve one exact live send to the number ending 771.
3. **Lite:** the trial-From correction and a second send (the owner's rule: no second send without explicit approval). Nothing built.
4. **Lite:** Twilio Console check (account type, message log, webhook and auto-reply settings). Only the owner can see this.
5. **AC-13B hosted steps (approval needed):** deploy the migration alone; publish n8n 06 then 03; dry-run (expect 0 drift); integrity and security
   checks; the live test on PRJ-2026-0031 with Airtable writes. Steps are in `evidence/ac13b-offline-verification.md` §5.
6. **Advanced, other approval items:** Accepted → project test on the synthetic quote; seven Airtable select options; real business-date
   switch; `invoice.reissue_requires_second_person`; n8n 05 TaxAmount deploy (per-line GST); real staff logins (A2, still open); pilot
   password rotation (a staff password was pasted in chat earlier); synthetic quote clean-up (Lost or Cancelled).
7. **Commit decision:** whether to commit the AC-13B branch, and what to do with `ops/staging/`.

## 7. Next milestone

- **After AC-13B is approved and live-verified:** the defect ledger's remaining items are LIFE-01 (cosmetic checklist row),
  FIN-GST-01 (per-line GST, needs the n8n 05 deploy) and AC-15 (Completed → Cancelled and untyped imported finals).
- **Sales track (approval-gated):** the Accepted → project supervised test on the synthetic quote.
- **Open risks recorded in the AC-13B evidence:** n8n 03 retry may overwrite a Done in Airtable; Note-only edits are not forwarded
  by 06 (same design as AC-13A).
