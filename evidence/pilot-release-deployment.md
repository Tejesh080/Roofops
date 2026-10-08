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
