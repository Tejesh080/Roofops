# Release: everything on `main` not yet on hosted (master plan Task 1.1)

One checklist for the whole release. It supersedes `ops/advanced-release-runbook-20261023.md`; that file's §2 notes on
behaviour changes and its §8 owner decisions still apply. Every 🔒 step changes a live system and needs the owner's
approval in chat, for that step, at that time. Read-only steps need none. Hosted commands take `--confirm <project-ref>`.

**Prerequisite:** the hosted credentials are in `~/.roofops/hosted.env` (Task 0.1). Until then every hosted command stops.

## 1. What goes out

**Migrations.** Hosted head `20261017060000` → `20261029120000`; nine files, each with an exact rollback in `ops/rollback/`.

| # | Migration | Defects | Live effect |
|---|---|---|---|
| 1 | `20261022000000_pre_start_gate_before_work_starts` | AC-13B | A job starts only with SWMS Done and materials reviewed |
| 2 | `20261022010000_fully_billed_job_is_not_cancelled` | AC-15 | A fully billed Completed job is not cancelled |
| 3 | `20261022020000_lifecycle_guard_follow_ups` | AC-15B, AC-13C | The same for every state; On Hold resume is gated |
| 4 | `20261022030000_quote_acceptance_is_deterministic` | AC-23, AC-25, AC-18 | Acceptance only from the quote's own record; one outcome per event |
| 5 | `20261022040000_purchase_orders_follow_the_job` | AC-21 | Orders on a cancelled job can only be cancelled |
| 6 | `20261022050000_cancelled_job_frees_its_visits` | OPS-02 | Cancelling a job cancels its booked visits |
| 7 | `20261022060000_pre_start_blocked_read_model` | (Copilot) | New view for the dashboard |
| 8 | `20261022070000_reissue_multi_line_gst_gate` | FIN-08 | A multi-line reissue waits for per-line GST |
| 9 | `20261029120000_airtable_ping_mac` | INT-03, ADR-041 | Ping signatures checked and recorded, **log mode**: no ping is refused |

**n8n.** Each live version was matched to its commit, and the node differences come from each workflow's file at that
commit compared with `main`.

| Workflow | Id | Live version | What changes | Why |
|---|---|---|---|---|
| 06 Airtable Changes | `lD6BOf2dhZZpSoEH` | `9a2eb69e` | `Extract Record Changes` (watches SWMS Signed, Materials Reviewed and their Notes), `Validate Ping`, `Load Payload Cursor`; adds `Ping Verified?` | AC-13B, ADR-041 |
| 03 Project Write-back | `gtUffpzbdGa0vbYj` | `737a7a66` | Adds `Find Existing Project Record`; `Build Project Record`, `Check Upsert`, `Verify Airtable Read-Back` | AC-13B review |
| 01 Quote Accepted | `X7KX9zGrClRbHyD1` | `b30a50c0` | `Validate Ping`, `Load Payload Cursor`, the cursor of `List Airtable Payloads`; adds `Ping Verified?` | INT-03, ADR-041 |
| 04 Approved Project → Xero | `YpmpJxQtSIBGSx6Z` | `fee94016` | The same three nodes as 01; adds `Ping Verified?` | INT-03, ADR-041 |
| 07 Reconcile | `EiBs0AB2NfOua7AM` | `a0ca9e60` | Adds `Store Webhook Secret`, `Build Wake Ping`, `Sign Wake Ping`; `Wake Consumer With Unread Payloads`, `Check Maintenance Result` | ADR-041 |
| 00 Setup & Maintenance | `1e0844GE0OOh7Qyq` | `c392504b` | Adds `Store Webhook Secret`, `Store Invoice Webhook Secret`; both Verify steps | ADR-041 |
| 95 Workflow Failure → Health | new | none | Create from `n8n/95-error-alert.sdk.ts` | Task 1.2 |
| 05 Xero Draft Invoice | `Y2deCFTZzpv1uo8C` | `feab88d9` | `Create DRAFT Invoice` body (per-line GST). **Separate supervised step** (row 13) | FIN-GST-01 |

Unchanged:
- 02, 08 Health and 08 Reissue: their files are identical to their live commits.
- 09 and 10 are inactive and not in this release.

**Dashboard.** `main`'s `web/` goes to the protected Preview, with `STAFF_XERO_DISPATCH` unset. It brings:
- the Copilot guards and the Finance page (AC-22, COP-01, COP-02);
- `/api/healthz`, which lets only itself past sign-in;
- the System Health ping line.

**Airtable.** No schema change. SWMS Signed / Materials Reviewed are set to "To do" on PRJ-2026-0031..0033 (AC-13B).

**Why this order:**
- 01, 04 and 06 call `wf_airtable_ping_cursor`, and 06 and 03 need AC-13B, so the migrations go first.
- 07 and 00 call the new `wf_airtable_*` functions.
- 95 needs nothing new.

## 2. Rehearsed (offline, 30 Oct)

`npx tsx scripts/release-rehearsal.ts D:\Claude\roofops-backups\pre-advanced-release-20261023-232418.dump` (SHA-256 checked
against the 23 Oct evidence). Every check held:

| Step | Result |
|---|---|
| Restore | clean; 56 migrations, head `20261017060000`; integrity 29 PASS / 5 WARNING |
| Apply the 9 | exactly the pending ones, in order; **32 PASS / 5 WARNING / 0 FAIL**; no PUBLIC execute; every table has RLS; the workflow role runs only `wf_*` |
| All 9 rollbacks, newest first | each clean; 56 migrations; integrity 29 / 5; **schema identical to the backup** (15,058 lines) |
| Re-apply | 9 applied; 32 / 5 |

The 23 Oct preflight saw 30 PASS / 4 WARNING on hosted. Some integrity rules depend on the date (how recent the last
reconciliation is), so compare **FAIL** counts across days, not PASS.

## 3. Before (no hosted write)

- [ ] **B1. Backup:** `npm run backup:hosted`. Read-only on hosted. Record the file and its SHA-256.
- [ ] **B2. Rehearse on that backup:** `npx tsx scripts/release-rehearsal.ts <B1 file>`. Expect `RESULT: every check held`, with 0 FAIL after applying.
- [ ] **B3. Rollback points:**
  - the n8n `versionId` of 00, 01, 03, 04, 05, 06 and 07 (read-only);
  - the Vercel Preview deployment id (owner);
  - the Supabase PITR or daily backup status (owner).
- [ ] **B4. Airtable** (read-only): the SWMS Signed / Materials Reviewed / Status of PRJ-2026-0031..0033.
- [ ] **B5. Preflight** (read-only):
  - `npm run integrity:check`: 0 FAIL.
  - `npm run security:check`: all pass. The ping-mode check passes while the setting is absent.
  - `npx tsx scripts/sql.ts --read-only -f ops/release-preflight.sql`. Expect:
    - `migrations 56 / head 20261017060000`;
    - `started_with_open_pre_start (none)`;
    - `held_by_gate_after_deploy` PRJ-2026-0031, 0032, 0033;
    - `booked_visits_on_cancelled_closed (none)`;
    - `orders_on_cancelled_closed` PO-2026-0001 only;
    - `imported_draft_orders` 7;
    - `airtable_ping_mac (absent …)`.
  - n8n: 01–08 active, 09 and 10 inactive, no error executions today.

## 4. Steps (in this order; stop at the first verify that does not hold)

| # | Step | Verify |
|---|---|---|
| 1 | 🔒 Pause 07 | inactive |
| 2 | 🔒 Airtable: SWMS Signed / Materials Reviewed = To do on PRJ-2026-0031..0033 | read back |
| 3 | 🔒 `npm run db:load -- --hosted --confirm <ref>` | exactly the 9 files, in order; "already imported" |
| 4 | Read-only: integrity, security, `ops/release-preflight.sql` | 0 FAIL; all pass, with ping mode `log`; `migrations 65 / head 20261029120000`; `started_with_open_pre_start (none)` |
| 5 | 🔒 n8n settings, 00 and 07: Save successful production executions = Do not save | read back |
| 6 | 🔒 Publish 06, then 03, from their files (node edits to the draft, then publish) | read each back; it matches its file node for node; one real Airtable edit applies |
| 7 | 🔒 Publish 01, then 04 | read back, node for node |
| 8 | 🔒 Publish 07 (this resumes it); `npm run reconcile -- --dry-run --confirm <ref>` | 0 drift; webhooks OK |
| 9 | 🔒 Publish 00 | read back, node for node |
| 10 | 🔒 Create and publish 95. Set it as the error workflow of 00, 01, 02, 03, 04, 05, 06, 07, 08 Health and 08 Reissue | `settings.errorWorkflow` read back on each |
| 11 | 🔒 Deploy `web/` to the protected Preview (`cd web && npx vercel deploy`), `STAFF_XERO_DISPATCH` unset | sign-in works; `/api/healthz` answers 200, or 503 with reasons that can be explained; System Health loads; the Copilot answers "which jobs are blocked by safety checks?" and "which quotes are pending?" |
| 12 | 🔒 Live acceptance, on synthetic records with no net change | see the four checks below |
| 13 | 🔒 05, only when the owner schedules the FIN-GST-01 Xero Demo check | a single-line request is unchanged |
| 14 | Evidence: `evidence/release-phase1-<date>.md` | ledger rows move to FIXED only where their live check passed |

Step 12, the live acceptance:
1. **AC-13B:** the PRJ-2026-0031 sequence in `ops/ac13b-deployment-runbook.md` §5.
2. **AC-15 / 15B:** set PRJ-2026-0008 to Cancelled. It is refused and put back.
3. **AC-21:** set PO-2026-0001 to Delivered. It is refused and put back.
4. **ADR-041:** after a real edit, `airtable_ping_checks` has rows. `NO_SECRET` is expected until the webhooks are re-created.

**Next, after this release:**
- Task 1.2: the uptime monitor on `/api/healthz`, and the alert proof.
- Task 1.5: `ops/airtable-ping-mac-rollout.md` from its step 4 (watch, re-create the webhooks, enforce).
- Task 1.6: schedule `backup:hosted`.

## 5. First week

- System Health or `/api/healthz` daily:
  - 0 FAIL;
  - no new VALIDATION_ERROR or RECONCILIATION_MISMATCH quote exceptions beyond the expected ones;
  - the ping line counts verdicts.
- n8n: no error executions. Any that happen show on System Health's n8n row (95).
- 07: the nightly run shows 0 drift. 01's cursor keeps advancing.

## 6. Rollback (newest layer first; nothing deletes data)

**Triggers:** any of
- an integrity FAIL;
- error executions in 06, 01 or 04 after their publish;
- a real job wrongly held by the gate;
- reconciliation drift the release explains.

**Procedure:**
1. Dashboard: promote the B3 deployment.
2. n8n:
   - restore the B3 versions of 00, 07, 04, 01, 03 and 06;
   - clear `errorWorkflow` on each;
   - unpublish 95.
3. 🔒 Database:
   - pause 07;
   - run the down files newest first: `20261029120000`, `20261022070000`, …, `20261022000000`, each with `npx tsx scripts/sql.ts --confirm <ref> -f ops/rollback/<file>`.

   Rehearsed: the result is identical to the backup.
4. Last resort: restore the B1 dump. This loses hosted changes made after it.
