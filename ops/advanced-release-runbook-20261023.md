# Advanced RoofOps release runbook: the 2026-10-22/23 sprint (8 migrations, n8n 06, 03, 05, dashboard)

Owner-run. Every 🔒 step changes a live system and needs the owner's approval for that step; everything else is
read-only. No secret appears here. Branch `feature/advanced-sprint-lifecycle`, stacked on AC-13B (`3672195`) and AC-15
(`75b76eb`). Nothing in this release has been deployed.

AC-13B detail (Airtable fill, live acceptance, Note cases): [ac13b-deployment-runbook.md](ac13b-deployment-runbook.md).
Per-defect evidence: the `evidence/*-offline-verification.md` file named in each ledger row of
[docs/defect-ledger.md](../docs/defect-ledger.md).

## 1. What is released

| # | Migration (hosted head today: `20261017060000`) | Defects | Live effect |
|---|---|---|---|
| 1 | `20261022000000_pre_start_gate_before_work_starts` | AC-13B | A job starts only with SWMS Done and materials reviewed; Note-only edits; dashboard card |
| 2 | `20261022010000_fully_billed_job_is_not_cancelled` | AC-15 | A fully billed Completed job is not cancelled |
| 3 | `20261022020000_lifecycle_guard_follow_ups` | AC-15B, AC-13C | The same for every state; On Hold resume is gated; SWMS label |
| 4 | `20261022030000_quote_acceptance_is_deterministic` | AC-23, AC-25, AC-18 | A bad Accepted On is rejected, not raised; acceptance only from the quote's own record; one outcome per event |
| 5 | `20261022040000_purchase_orders_follow_the_job` | AC-21 | Orders on a cancelled job can only be cancelled; approvals need a mapped employee |
| 6 | `20261022050000_cancelled_job_frees_its_visits` | OPS-02 | Cancelling a job cancels its booked visits |
| 7 | `20261022060000_pre_start_blocked_read_model` | (Copilot) | New view for the dashboard |
| 8 | `20261022070000_reissue_multi_line_gst_gate` | FIN-08 | A multi-line reissue waits for per-line GST |

| Other component | Change | Defects |
|---|---|---|
| n8n 06 `lD6BOf2dhZZpSoEH` | watches SWMS Signed, Materials Reviewed and the four checklist Notes | AC-13B |
| n8n 03 `gtUffpzbdGa0vbYj` | finds an existing record first; writes the checklist only on creation | AC-13B review |
| n8n 05 `Y2deCFTZzpv1uo8C` | `TaxAmount` only on multi-line drafts | FIN-GST-01 (CC-04) |
| Dashboard (Vercel) | Copilot guards and two read tools; Finance page | AC-22, COP-01, COP-02 |
| Airtable | no schema change; "To do" on PRJ-2026-0031..0033 | AC-13B |

## 2. Rehearsal (done offline, 2026-10-23)

On a restored hosted backup (`pre-synthetic-quote-test-20261020-164125.dump`, in a scratch database, dropped afterwards):

| Step | Result |
|---|---|
| Migrate to hosted head (7) | integrity 28 PASS / 6 WARNING / 0 FAIL |
| Apply the 8 | **31 PASS / 6 WARNING / 0 FAIL**; `started_with_pre_start_open`, `cancelled_job_fully_billed`, `closed_job_has_booked_visit` PASS |
| Rows changed | `field_contract` +4, `app_settings` +1, `schema_migrations` +8; no business data |
| Behaviour changes on real data | the pre-start gate holds PRJ-2026-0031, 0032, 0033. Six fully billed jobs are no longer cancellable: PRJ-2026-0006, 0008, 0012, 0015, 0022, 0030 (four are fully *paid*: see §8). PO-2026-0001 (Sent, on cancelled PRJ-2026-0001) can now only be cancelled. 7 imported draft orders now need a mapped approver |
| All 8 down files, in reverse | functions (with ACLs), views, field contract and settings identical to the hosted head; integrity back to 28 / 6 / 0 |
| Re-apply | 31 / 6 / 0 |

Local gate on the release head: `TEST_DATABASE_URL=… npm run check` exit 0 (PGlite and Postgres 17), including the
two-connection race tests.

## 3. Backup (before any 🔒 step)

1. The hosted dump, with the command block in [ac13b-deployment-runbook.md](ac13b-deployment-runbook.md) §3 (B1), saved
   as `pre-advanced-release-<stamp>.dump`. Record its SHA-256, and confirm Supabase's PITR / daily backup.
2. n8n: download 06, 03, 05 and 07, and record each `versionId` / `activeVersionId`.
3. Airtable: note the SWMS / Materials / Status values of PRJ-2026-0031..0033.
4. Vercel: note the current Production and Preview deployment ids.

## 4. Preflight (read-only)

| Check | Expect |
|---|---|
| `npm run integrity:check`, `npm run security:check` | 0 FAIL; all privilege checks pass |
| `schema_migrations` | 56, head `20261017060000` |
| Started jobs with open pre-start items (runbook AC-13B P3) | 0 rows |
| Booked visits on cancelled / closed jobs | 0 rows (`evidence/ops-02-offline-verification.md` §5) |
| Orders on cancelled / closed jobs; imported draft orders | the lists in §2; the owner knows them |
| n8n | 01–08 active; 09 and 10 inactive; no 06 error executions today |

## 5. Deployment sequence

| # | Step | Verify |
|---|---|---|
| 1 | 🔒 Pause n8n 07 | inactive |
| 2 | 🔒 Airtable: SWMS Signed / Materials Reviewed = To do on PRJ-2026-0031..0033 | read back |
| 3 | 🔒 `npm run db:load -- --hosted --confirm <project-ref>` | exactly the 8 files, in order; "already imported" |
| 4 | Post-migration (read-only) | integrity 0 FAIL (expect 31 PASS on today's data, give or take the warnings); security all pass; 64 migrations |
| 5 | 🔒 Resume 07; `npm run reconcile -- --dry-run` | 0 drift |
| 6 | 🔒 Publish n8n 06, then 03 (node for node equal to the files) | 06 change webhook OK |
| 7 | 🔒 Deploy the dashboard to a protected Preview, `STAFF_XERO_DISPATCH` unset | sign-in; Finance; the Copilot answers "which jobs are blocked by safety checks?" and "which quotes are pending?" from the views |
| 8 | 🔒 Live acceptance (§6) | each row as expected |
| 9 | 🔒 n8n 05, only when the owner schedules the FIN-GST-01 Xero Demo check | single-line request unchanged |
| 10 | Evidence: `evidence/advanced-release-<date>.md` | ledger rows move to **FIXED** only for defects whose live check passed |

## 6. Live acceptance (each 🔒, synthetic records, net change none)

1. **AC-13B:** the PRJ-2026-0031 sequence in [ac13b-deployment-runbook.md](ac13b-deployment-runbook.md) §5, including the
   Note-only and blank-Note rows.
2. **AC-15 / AC-15B:** set PRJ-2026-0008 Status = Cancelled in Airtable. Expected: refused, put back, RoofOps Sync explains.
3. **AC-21:** set PO-2026-0001 Status = Delivered. Expected: refused, put back.
4. **AC-23 / AC-25:** none live (they need a deliberately broken acceptance); proven offline.
5. **OPS-02:** none live unless a synthetic job is cancelled (owner's choice).
6. **Copilot:** the two read questions in the Preview; then `npm run ai:eval` against it.
7. **Optional Sales step:** accept synthetic Q-2026-0066 in Airtable. Expected: one project, its Drive folder, and the new
   03 creating the Airtable project with the four checklist fields To do (separate approval,
   `ops/ops-sales-release-plan.md`).

## 7. Monitoring (first week)

- `/health` daily: integrity 0 FAIL; no new open exceptions of class VALIDATION_ERROR / RECONCILIATION_MISMATCH for
  quotes beyond the expected ones.
- n8n 06: no error executions; 07's nightly run 0 drift.
- n8n 01: its cursor keeps advancing (AC-23 removed the stall).
- The Copilot: tool errors (`invalid arguments`) in the dashboard server log are rare.

## 8. Rollback triggers and procedures

**Triggers:**
- any integrity FAIL;
- 06 error executions;
- a real job wrongly held by the gate;
- reconciliation drift that the release explains.

**Procedure (layer by layer, newest first; nothing deletes data):**
1. Dashboard: promote the previous Vercel deployment.
2. n8n 05, 03, 06: restore the recorded previous versions.
3. 🔒 Pause 07. Run the down files newest first, each in one transaction:
   `npx tsx scripts/sql.ts -f ops/rollback/<migration>.down.sql` for 070000, 060000, 050000, 040000, 030000, 020000,
   010000, 000000. Rehearsed: the result equals the hosted head.
4. Re-run §4. Last resort: restore the §3 dump; this loses hosted changes made after it.

**Owner decisions surfaced by this release (none blocks the migrations):**
- **Fully paid jobs cannot be cancelled.** Four of the six (bills INV-2026-0012, 0015, 0022, 0030 are Paid) can no
  longer be cancelled by any supported path: a Paid bill cannot be voided, and there is no credit-note model. Decide
  whether a fully paid job may ever be cancelled, and how a refund is recorded.
- **The catalogue's wider AC-15 rule.** Any open invoice would block cancellation (not applied).
- **Back-dating Accepted On.** A date between Sent On and today is accepted as typed (AC-23).
- **Purchase orders.** Approver roles, and goods that arrive for a cancelled job (AC-21).
- **Site visits.** Whether a visit in progress at cancellation is stopped (OPS-02); whether a site visit may start while
  the pre-start items are open.
