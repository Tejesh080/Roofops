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
