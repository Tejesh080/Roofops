# Pilot release: hosted deployment record (2026-10-08 UTC)

Owner approval: operations 1–3 of `ops/pilot-release-runbook.md` at commit `8622414` (migrations; one Airtable repair;
workflow 07 MCP restriction). Global four-eyes is **not** activated. No dashboard deployment. No secret appears in this file.

## Before (13:31 UTC)

- Branch `factory/ac14-integrity-followup` at `8622414`, equal to origin. Hosted: 43 migrations, the 4 new ones pending.
- TLS verified (`SUPABASE_CA_CERT`).
- Nothing in flight: outbox 0, running reconciliation 0, open approvals 0, dispatch hash blank.
- Integrity 28 PASS / 4 WARNING / 0 FAIL.
- **Backup:** `pre-pilot-20261008-230954.dump` (SHA-256 `c2265386…7a8b72`, verified again). Every business table is
  identical to hosted; only `integration_health` gained 10 health-probe rows.

## Stage 1: migrations (13:31:42–13:31:45 UTC)

`npm run db:load -- --hosted` applied exactly `20261009000000`, `…010000`, `…020000`, `…030000`. The data import was
skipped (already imported).

| Check | Result |
|---|---|
| Migrations | 47; all **47 checksums equal** the repo files; no hosted row outside the repo |
| Integrity | 28 PASS / 4 WARNING / 0 FAIL (unchanged) |
| Security | all privilege checks PASS. The dashboard role has 15 SECURITY DEFINER functions (+7 `web_*`). The workflow role's 22 functions are unchanged. Nothing is executable by PUBLIC; RLS is on everywhere |
| Reissue core | `ops_reissue_decide_core` is byte-identical to the previous `ops_reissue_decide` (body MD5 `7e0713cd…`) |
| Settings | `staff.session_hours = 12`, `invoice.reissue_requires_second_person = false` (four-eyes **not** active) |
| Data | 59 of 62 existing tables byte-identical, including invoices, approvals, outbox, the generation ledger, external_links and payments. Changed: `app_settings` (+2), `field_contract` (the Invoice Preview row), `schema_migrations` (+4); new and empty: `staff_accounts`, `staff_sessions` |

## Stage 2: Airtable synchronisation

| Step | Result |
|---|---|
| Observe `RECON-20261008-233232-b7ab` | **1 finding in total:** PRJ-2026-0002 *Invoice Preview* SAFE_AUTO_REPAIR, the generation-1 text (`21545f60…`, APR-2026-0012) → the current identity. Xero 2/2 VERIFIED DRAFT and Drive 3/3, 0 drift; dead letters 0; uncertain Xero writes 0; no Projects row with an Invoice Action set |
| Repair `RECON-20261008-233500-1868` (one run, after the 2-minute guard) | **1 change:** REPAIRED_AIRTABLE, one write `recbBZIwsTX5SgMHH` `fldt9KIOPXh3c3pGU`, read back and verified 13:35:05. 0 invoices, approvals, payments, outbox rows or exceptions changed; the only audit row is `reconciliation.completed` |
| Airtable (independent read) | Invoice Preview: "XERO DRAFT RO-INV-2026-0040 (InvoiceID **61e09cad-38d9-49e5-b537-bba0d185786b**) in Demo Company (AU) / Reissued under **APR-2026-0013**: requested by Demo Finance Approver, approved by Demo Finance Approver / Replaces InvoiceID **21545f60-7aa8-418b-8d8d-635a4c1d08ed** …". Xero Invoice ID `61e09cad…`, number RO-INV-2026-0040, status "Xero draft created", amount 15,155.98 |
| Observe `RECON-20261008-233722-27d8` | **0 drift** (Airtable 231, Drive 3, Xero 2); webhooks OK, 0 unread. The exact-text comparison is stable |

The text records that the Stage 3C demo reissue was requested and approved by the same demo identity. That is
accurate history.

## Stage 3: workflow 07 MCP restriction (13:37:40 UTC)

| Check | Result |
|---|---|
| `npm run n8n:mcp -- disable EiBs0AB2NfOua7AM …` | `availableInMCP` true → **false**, the only setting changed. Nodes and connections unchanged; still active; published version `a0ca9e60` unchanged |
| Snapshots | `D:\Claude\roofops-backups\n8n-07-EiBs0AB2NfOua7AM-{pre,post}-mcp-off.json` (owner + SYSTEM only). Identical: the 42 nodes (deep-equal), connections, the 4 credential ids, and the schedule "Daily 02:30". n8n recorded a re-activation of the **same** version (trigger re-registration) |
| Execution data | success and error saving none, manual false, progress false (unchanged); **0 saved executions** after a run |
| Still works | observe `RECON-20261008-233943-d380` through 07's operator webhook: COMPLETED, 0 drift. The schedule node is unchanged and the workflow active; the next scheduled run is 16:30 UTC (not yet observed) |

## Afterwards

- Integrity 28 PASS / 4 WARNING / 0 FAIL; security all PASS (tenant pinned; dispatch hash blank).
- **Invoice creation and reissue configuration intact, with no document created:**
  - 04 `fee94016…`, 05 `feab88d9…` and 08 `facd57c8…` are active with unchanged versions;
  - a read-only first-issue preview for PRJ-2026-0005 returns `ok`;
  - a reissue of the live INV-2026-0040 is refused (`INVOICE_NOT_VOIDED`);
  - reissue roles FINANCE, ADMIN.
- The read-only Playwright smoke and state-sync specs against the migrated hosted database: **20/20**.
- Staff accounts on hosted: **0**. The only FINANCE or ADMIN employee is EMP-900 "Demo Finance Approver", the demo
  identity mapped to the shared Airtable account. It is **not** a real staff member and has no dashboard login.

## Not done (by instruction or blocked)

- No dashboard deployment; no staff logins (they need the owner's own passwords); four-eyes setting left off.
- The scheduled 07 run at 16:30 UTC is not yet observed.

## Migration 20261009040000 (approved; applied 2026-10-08 ~14:45 UTC)

- **Before:**
  - `19009ca`, equal to origin.
  - TLS verified.
  - Fresh backup `pre-040000-20261009-010740.dump` (SHA-256 `ebe31444…274e`; owner and SYSTEM only).
  - Nothing in flight (outbox 0, reconciliation 0, open approvals 0, dispatch hash blank).
  - Integrity 28/4/0.
  - The file holds only two `create … view` statements and one `grant select` to `roofops_dashboard`.
- **After:**
  - 48/48 checksums equal.
  - Integrity 28 PASS / 4 WARNING / 0 FAIL.
  - All privilege checks PASS.
  - Of 64 tables, only `schema_migrations` changed (+1).
  - PRJ-2026-0002: generation 2 `61e09cad…` current; generation 1 `21545f60…` replaced (Xero: DELETED).
  - n8n 04/05/07/08/08-health active, versions unchanged.
- **07 since:** 7 nightly scheduled repair runs (to 2026-10-14 16:30 UTC), all COMPLETED, 0 Xero/Drive drift. One Drive rate-limit exception (EXC-0022) was auto-resolved by the next run.

## Protected Vercel preview (2026-10-15)

- **Project:** `tejesh1/roofops-dashboard`. Next.js, Node 24.x, functions in `syd1`. Not Git-connected (no auto-deploys). Vercel Authentication on **all** deployments.
- **Environment:** 9 variables, Preview only, Sensitive. Names checked against the source (`DASHBOARD_DB_CA_CERT`, a local path, is not used).
  - `DASHBOARD_DATABASE_URL` is the `roofops_web` login (asserted by the upload script).
  - The CA is supplied as `DASHBOARD_DB_CA_PEM`.
  - `AUTH_SECRET` is newly generated (64 characters).
  - The DeepSeek settings and the temporary demo login complete the set.
- `web/.vercelignore` keeps `.env*`, `e2e/` (local test logins) and test artefacts out of the upload.
- **Incident:** the project's first CLI deployment (`ds14a9ig8`) was created with target **production** despite `--target preview`.
  - It was never reachable: Vercel Authentication redirected every request, and it had no environment variables.
  - It was removed after a real preview was created. The production domain now returns 404, and the project has no production deployment.
- **Preview:** `roofops-dashboard-du3h1zvdr-tejesh1.vercel.app`, target preview.
  - Unauthenticated requests: 302 to Vercel sign-in.
  - Testing went through a temporary automation-bypass secret, **revoked** afterwards (0 bypass secrets remain).
- **Results:**
  - Playwright smoke and state-sync: 18/20. The 2 Copilot tests failed because DeepSeek returned HTTP 503 "Service is too busy", reproduced from this machine too; the dashboard shows its "copilot unavailable" message.
  - Without an app session, pages redirect to `/login`, and the API returns 401 (also with a forged cookie).
  - Headers: HSTS, `X-Frame-Options: DENY`, `noindex`.
  - Overview, PRJ-2026-0002, Finance, Automation and Health load from hosted over verified TLS, with no horizontal overflow at 1440 px or 390 px.
  - PRJ-2026-0002 shows Current `61e09cad…` and Replaced `21545f60…` (deleted in Xero).
  - The demo viewer has no reissue or resolve controls.
- **No financial mutation:** invoices, approvals, outbox, payments and the generation ledger are byte-identical to just after the migration; every other change came from the nightly reconciliation.

## Staging release STAFF-OPS-01 (approved; 2026-10-16)

**Stage 1: hosted migration `20261016000000`**
- Before:
  - `5516f88`, equal to origin; TLS verified.
  - Backup `pre-20261016-20261016-115355.dump` (SHA-256 `33337383…77ec`; owner and SYSTEM only).
  - Nothing in flight; integrity 28/4/0.
  - The file is byte-identical to the version tested on the restored hosted copy (`f5403089…`).
  - The hosted decision core was the exact base it was built from (`9213db08…`).
- Applied with `npm run db:load -- --hosted`. After:
  - 49/49 checksums equal; integrity 28/4/0; all privilege checks pass (dashboard SECURITY DEFINER functions 19, workflow functions 23, Demo tenant pinned).
  - The decision core equals the tested copy (`7a210ea5…`).
  - Data changes: `app_settings` +3, `schema_migrations` +1, new empty `xero_dispatch_requests`; every other table byte-identical.
  - A probe in a transaction that was always rolled back showed `wf_invoice_decide` (04's path) still answers through the new core, and `wf_xero_dispatch_next` returns no writes. No persistent change.

**Stage 2: n8n 09.**
- `[RoofOps] 09 Staff Xero Dispatch`, id `YLdvY49T3RKCt3K4`, version `2e34b2ce`, team project Roofops.
- **Inactive**; its schedule trigger node is **disabled**.
- Nodes: Next Staff Request (credential RoofOps Postgres `kWqjtv0gz7ref2EN`, the one 04 and 08 use), Write To Dispatch (at most one), Any Write?, Run Xero Draft Invoice (05 `Y2deCFTZzpv1uo8C`, unchanged `feab88d9`).
- Settings: MCP off, no saved executions (success, error, manual, progress), caller policy same owner.
- Never executed. Pending staff requests on hosted: 0.

**Stage 3: protected preview** `roofops-dashboard-qsf0c8m66-tejesh1.vercel.app` (`dpl_Eiks9fSTXaeDqCaN56b8dRUqJz4m`, code `3ec2cb8`, target preview).
- Vercel Authentication covers all deployments (checked before deploying).
- The previous preview `roofops-dashboard-du3h1zvdr-tejesh1.vercel.app` is kept for rollback; there is no production deployment.
- `STAFF_XERO_DISPATCH` is not set, so dashboard approve and Send to Xero are **off** (server-side). Preparing and rejecting stay available; nothing can be queued for the inactive 09.
- Read-only hosted browser tests through a temporary bypass, revoked afterwards (0 left): smoke, state-sync and interactions 29/29.
- Demo viewer: no staff controls. Operations shows reconciliation and health OK and 4 issues to look at. PRJ-2026-0002 shows current and replaced Xero documents.

**Stage 4.**
- Invoices, invoice lines, approvals, outbox, payments, the generation ledger, external links, requests, staff and settings are unchanged since the migration.
- 04 `fee94016`, 05 `feab88d9`, 07 `a0ca9e60`, 08 `facd57c8` and 08-health `c6f531fd` are active; 09 is inactive.
- Scheduled reconciliation `RECON-20261016-023041-9ca7` COMPLETED.

**Rollback (any order):**
- point staff back at the previous preview;
- delete 09 or leave it inactive;
- `npx tsx scripts/sql.ts -f ops/rollback/20261016000000_staff_invoice_approval_and_xero_dispatch.down.sql` (rehearsed: the decision core returns byte-identical).

## Hosted staff pilot acceptance test (2026-10-16, preview `qsf0c8m66`, dispatch switch off)

- Synthetic staff added on hosted with `staff:add-employee` (verified TLS): EMP-801 "Pilot Finance (synthetic)" FINANCE
  `pilot.finance@example.test`, EMP-802 "Pilot Admin (synthetic)" ADMIN `pilot.admin@example.test`. Passwords typed by the
  owner at the hidden prompt (`staff:set-password`, logins `pilot.finance`, `pilot.admin`); never seen or stored by the operator.
- Finance (EMP-801, own session) prepared PRJ-2026-0005 once: APR-2026-0014, requester EMP-801 via the dashboard,
  $17,831.91 inc GST (quote $44,579.78 less $26,747.87 invoiced: INV-2026-0005 + INV-2026-0035), GST $1,621.08,
  $16,210.83 ex GST, one line, account 200, OUTPUT, customer Jack Walker CUST-0005. No Approve for the requester.
- Admin (EMP-802, separate session; Finance's session revoked on sign-out): Approve, the confirmation checkbox and Send
  replaced by the pending-activation note; only Reject offered. Rejected with a reason: APR-2026-0014 REJECTED,
  decided_by EMP-802, requester EMP-801.
- Audit: employee.created ×2, staff.password_set ×2, staff.signed_in (EMP-801, EMP-802), invoice.preview_prepared (EMP-801),
  approval.reject (EMP-802). Automation events: prepare_requested, preview_prepared, rejected (all SUCCEEDED).
- Table diff before/after (65 tables): only approvals +1, audit_events +8, automation_events +3, processed_events +2,
  employees +2, staff_accounts +2, staff_sessions +2, id_counters (APR counter), integration_health (scheduled 08 health).
  Outbox 9 (all DONE), xero_dispatch_requests 0, invoices 40, external_links 253, payments 27: unchanged. Integrity 28/4/0.
- n8n 09 inactive (unchanged since creation, never triggered); `STAFF_XERO_DISPATCH` unset; no Xero document created.

## First supervised Xero Demo invoice via the staff path (2026-10-16, owner-authorised steps 1-4)

- Preview switch: `STAFF_XERO_DISPATCH` added for Preview only. The first save (piped from PowerShell) did not read as `on`
  (preview `i9plwxmgr` stayed gated, harmless); re-added as a Config value, bytes verified as exactly `on`, redeployed:
  `https://roofops-dashboard-lc1bw3xd9-tejesh1.vercel.app` (dpl_HqNDDL1fYyP3dSXBRSyo1jWDR77V, Vercel Authentication).
  Switched-off rollback preview `qsf0c8m66` kept. Production untouched.
- Finance EMP-801 prepared PRJ-2026-0005 once: APR-2026-0015 (same payload hash as APR-2026-0014). Owner confirmed the figures;
  Admin EMP-802 approved: INV-2026-0041 FINAL, $17,831.91 inc GST, GST $1,621.08, issue 2026-09-29, due 2026-10-13, one line,
  account 200. Exactly one QUEUED request (payload hash matched, xero_dispatch_problem none) before 09 ran.
- n8n 09: only the "Every Minute" node enabled (plus MCP access and saving of manual runs, temporarily), workflow kept INACTIVE;
  one manual execution 2832 -> 05 execution 2833, both success; then node disabled and the restrictive settings restored
  (availableInMCP false, saveManualExecutions false). Still inactive, never activated.
- Xero Demo Company (AU), Class DEMO (read back independently by read-only 96, execution 2834): one new contact
  RO-CUST-0005 "Jack Walker [CUST-0005]" (e59e6773-7dcc-47f3-b49a-6f2c78d50fa9) and one DRAFT RO-INV-2026-0041
  (f062fa4d-fa78-4cdf-9470-6352cd51daa8), reference PRJ-2026-0005, total 17831.91, tax 1621.08, subtotal 16210.83, account 200,
  OUTPUT. Other RoofOps Xero invoices unchanged.
- Hosted: APR-2026-0015 EXECUTED, INV-2026-0041 APPROVED/SYNCED, outbox 10 all DONE, 2 new Xero links, payments 27 unchanged.
  Audit: approval.approve (EMP-802), invoice.create, xero.dispatch_requested (EMP-802), xero.dispatch_started (n8n:09:2832),
  xero.invoice.draft_created. Ops status all ok (4 pre-existing exceptions). Integrity 26 pass / 6 warning / 0 fail: the two new
  warnings (Airtable invoice fields not yet written for PRJ-2026-0005; INV-2026-0041 not yet read back by reconciliation) are
  expected on the staff path and are repaired by the nightly 07 reconciliation.

## Post-test cleanup (2026-10-16)

- Queue: 0 unsent Xero writes, 0 uncertain, 0 open approvals; the one staff request (INV-2026-0041) is CLAIMED with its write
  DONE; it settles to HANDED_OVER at the start of the next 09 run (no data change made by hand).
- n8n 09 re-read via the public API: inactive, "Every Minute" disabled, availableInMCP false, saveManualExecutions false,
  saveDataSuccess/Error none, callerPolicy workflowsFromSameOwner. Saved runs from the test (09 #2832, 05 #2833, 96 #2830/2834/2836)
  scanned: no tokens, keys, passwords or connection strings (only synthetic example.com addresses, Xero ids and the Demo
  Company's sample data).
- Fixes (3033685): the requester can withdraw (Reject with a reason) but never approve; a CLAIMED request whose write 05 has
  taken reads "handed over to the automation". Tests: vitest dual PGlite+Postgres 899 passed / 0 failed; lint, both
  typechecks; browser invoice-approval 3/3 (new withdraw + wording checks), staff-journey 2/2, dispatch-gate 1/1.
- `STAFF_XERO_DISPATCH` removed from Preview (not set in any environment); new protected preview
  `https://roofops-dashboard-lgrp0ep2k-tejesh1.vercel.app` (dpl_GohKgHcjqud2By6gGWCbD6XMnfkt, code 4b23915).
  Kept for rollback: `lc1bw3xd9` (switch on, used for the supervised test) and `qsf0c8m66` (switch off).
- Xero re-read (96 #2836): RO-INV-2026-0041 exactly once (DRAFT, PRJ-2026-0005, 17831.91, tax 1621.08, Jack Walker [CUST-0005]);
  one RO-CUST-0005 contact. Integrity 26/6/0: the two new warnings (Airtable invoice fields for PRJ-2026-0005; INV-2026-0041 not
  yet read from Xero) are both covered by the nightly repair-mode reconciliation (16:30 UTC); no manual repair made.

## Old approval-enabled preview removed (2026-10-16 ~03:25 UTC)

- Inventory (vercel inspect + `/v2/deployments/{id}/aliases`): five preview deployments, none with aliases, no production
  deployment. `lc1bw3xd9` (dpl_HqNDDL1fYyP3dSXBRSyo1jWDR77V, target preview, built with `STAFF_XERO_DISPATCH=on`) was the only one
  able to approve or queue. Removed with `vercel remove roofops-dashboard-lc1bw3xd9-tejesh1.vercel.app` (1 deployment); the URL
  now returns 404 "deployment could not be found" and the API no longer knows the id. Project and other deployments untouched.
- Remaining previews, all dispatch-off: `lgrp0ep2k` (current, 4b23915, switch absent at build), `i9plwxmgr` (value not exactly
  `on`; Admin saw the pending note, no Approve), `qsf0c8m66` (switch absent; verified in the hosted acceptance test),
  `du3h1zvdr` (built from 19009ca, before the dashboard approve/send code existed). All redirect signed-out requests (302).
- Lingering CLAIMED request (INV-2026-0041): outbox DONE, invoice SYNCED, 0 QUEUED. `wf_xero_dispatch_next` only takes QUEUED
  requests and first settles this one to HANDED_OVER; any new request is refused ALREADY_CREATED; 05's claim of the key returns
  the recorded DONE result with `claimed: false`. Shown by read-only queries plus one always-rolled-back probe of those exact calls;
  all 65 tables identical before and after (scheduled health rows excluded).
- n8n 09: inactive, "Every Minute" disabled, MCP off, run saving off. Integrity 26/6/0; the next scheduled reconciliation
  (16:30 UTC 16 Oct) has not run yet. Remaining check: after it, integrity should return to 28/4/0 with only PRJ-2026-0005's
  four Airtable invoice fields written and INV-2026-0041 read back from Xero.

## Operator reconciliation for PRJ-2026-0005 / INV-2026-0041 (2026-10-16 ~03:40-03:46 UTC)

- Preflight: 07 active (version a0ca9e60, schedule Daily 02:30 unchanged), no run in progress, 0 dead letters, 0 uncertain;
  Xero (96) one RO-INV-2026-0041 DRAFT in Demo Company (AU), Class DEMO. The 07 scope option (invoice_projection_reset) refuses a
  project with a final invoice, so a normal run was used.
- Observe RECON-20261016-134023-35ec: Airtable 4 findings, all PRJ-2026-0005 (Invoice Amount, Invoice Status, Xero Invoice ID,
  Xero Invoice Number), SAFE_AUTO_REPAIR; Drive and Xero 0 drift; webhooks OK. It recorded the Xero read-back of INV-2026-0041
  (xero_invoice_observations; integrity 27/5/0). Database changes: run, findings and observation rows and link sync timestamps only.
- Repair RECON-20261016-134246-587a (one start refused first by the 2-minute quota guard): exactly 4 airtable_writes on
  recyDSiQ5Ot1tdbVu, each verified; no invoice, payment, outbox, approval or Xero change. Airtable read directly afterwards:
  RO-INV-2026-0041, "Xero draft created", 17831.91, f062fa4d-fa78-4cdf-9470-6352cd51daa8.
- Follow-up observe RECON-20261016-134530-8cb2: no drift (Airtable 231, Drive 3, Xero 3). Integrity 28/4/0 (baseline warnings
  only). Xero (96 #2843): RO-INV-2026-0041 exactly once, DRAFT, 17831.91. n8n 09 inactive, trigger disabled; previews
  lgrp0ep2k, i9plwxmgr, qsf0c8m66, du3h1zvdr all dispatch-off.

## First controlled unattended (scheduled) Xero Demo dispatch: PRJ-2026-0007 (2026-10-16, owner-authorised A-G)

- Eligibility: owner set Airtable Completion Photos = Waived with a note (no synthetic photo evidence exists); audited as
  project.checklist.changed by EMP-900 (Airtable user usr7uCnNO15fCefbH); project READY_TO_INVOICE, $25,587.26.
- A: `STAFF_XERO_DISPATCH=on` (Config, bytes verified) -> preview `rhs3lu5g3` (dpl_H18yjrQN1DrrELJ9maWQ4DJkkeEf); variable removed
  from Preview immediately after the build.
- B: Finance EMP-801 prepared APR-2026-0016 (Henry Hughes, $25,587.26 inc GST, GST $2,326.11, 1 line, account 200, OUTPUT,
  29 Sep / 13 Oct); owner confirmed the figures; Admin EMP-802 approved -> INV-2026-0042. Exactly one QUEUED request
  (INV-2026-0042 gen 1, payload hash matched, no problem); old INV-2026-0041 request CLAIMED, new request refused ALREADY_CREATED.
- C: `rhs3lu5g3` removed (404, no aliases); 4 remaining previews dispatch-off; `xero.dispatch_roles` set blank.
- D/E: 09 trigger enabled and activated (scheduled, not manual); its first scheduled run (n8n:09:2850, ~30 s) settled the old
  request to HANDED_OVER and claimed INV-2026-0042; 09 deactivated and trigger disabled 2 s later. 05 execution 2851 (integrated)
  finished: outbox DONE (1 attempt), invoice SYNCED, approval EXECUTED. One xero.dispatch_started audit row only.
- F: Xero (96 #2852): one new DRAFT RO-INV-2026-0042 (4befb014-1cba-43ed-8432-ac649d4ed373, PRJ-2026-0007, 25587.26, tax 2326.11,
  subtotal 23261.15) and one new contact RO-CUST-0007 "Henry Hughes [CUST-0007]" (1d8f2678-b7c0-421c-90cf-68361ee22fb7);
  05 read-back: matching_invoices 1, adopted_existing_draft false, Class DEMO. Earlier RoofOps Xero documents unchanged.
  Table diff: only approvals, audit, automation/processed events, invoices/lines, draft generations, outbox, external_links
  (+2), staff_sessions, workflow runs/steps and xero_dispatch_requests changed; payments 27 unchanged.
- G: `xero.dispatch_roles` restored to FINANCE,ADMIN. Observe RECON-20261016-144609-f81f: only PRJ-2026-0007's four Airtable invoice
  fields (incl. Invoice Status "Not eligible" -> "Xero draft created"); repair RECON-20261016-144856-a278 wrote exactly those 4
  (verified in Airtable); follow-up observe RECON-20261016-145138-d5be: zero drift (Airtable 231, Drive 3, Xero 4).
  Integrity 29/3/0. n8n 09: inactive, trigger disabled, MCP off, run saving off (version 7e124e9e).
- Outstanding (reported, not changed): EXC-0016 still OPEN (cause resolved by the waiver; a person should mark it resolved with a
  note); PRJ-2026-0007's Airtable "Invoice Result" text still shows the old "missing completion documents" message (not a
  reconciled field). Pilot passwords not yet rotated.
