# Pilot release: dashboard TLS, staff sign-in, reissue four-eyes, workflow 07 MCP restriction

Release commit: the branch head that contains this file (`factory/ac14-integrity-followup`). Owner-run; every hosted step
below needs the owner's approval. No secret appears in this file.

## Pre-flight results (2026-10-08, no hosted writes)

| Check | Result |
|---|---|
| 1. CA contract | `DASHBOARD_DB_CA_PEM` (escaped PEM text; wins) or `DASHBOARD_DB_CA_CERT` (absolute file path). A remote database without a readable, valid CA is **refused**; localhost is plain TCP; URL ssl parameters are stripped. Docs corrected; 7 tests. **Live, read-only:** `roofops_web` connected with both forms, `rejectUnauthorized=true` |
| 2. Migrations vs hosted | Read-only on hosted: 43 migrations; integrity 28 PASS / 4 WARNING / 0 FAIL; pgcrypto already installed (`extensions`); no name collisions. **Rehearsed on a restored copy of hosted:** both apply cleanly (45). Integrity is unchanged. All security checks pass. The workflow role's 22 functions are identical. Only the 4 `web_*` functions are added to the dashboard role. `ops_reissue_decide_core` is byte-identical to the old `ops_reissue_decide`. Data changes: 2 `app_settings` rows, 2 `schema_migrations` rows and 2 new empty tables; nothing else |
| 3. Security review | No critical or high findings (independent review); its low findings are fixed (one refusal answer, pgcrypto first in `search_path`, 72-byte cap, session purge). Lockout: 5 failures lock that login for 10 minutes; the owner reset unlocks it. Grants: owner-only `ops_staff_set_password`; tables readable by no app role (RLS on). **Rollback rehearsed** on a second restored copy: migrate → `ops/rollback/*.down.sql` → schema state and all 62 tables **identical** to before; re-apply works |
| 4. Backup | `D:\Claude\roofops-backups\pre-pilot-20261008-230954.dump`, SHA-256 `c2265386499d336755c30586df05ffa81fe385d6a420cc68728f1dd3027a8b72`, file access owner + SYSTEM only. Restored locally: **62/62 tables identical to hosted** |
| 5. Shared demo login | It **cannot** resolve exceptions or approve or decide anything: those need a database session token that only a staff password produces, and the database checks it. It **can still** start non-privileged writes: Copilot "Prepare invoice" (`wf_invoice_prepare`) records a PENDING preview approval plus its events. Nothing reaches Xero without a finance approver. The sign-in form also lets anyone *attempt* a staff login, which updates that login's failure counter or lockout |
| 6. Existing flows | n8n uses only `roofops_workflow`, whose functions are unchanged. No `wf_*` function is modified. Airtable and Xero are untouched. The reissue CLI and 08 dispatch work as before (four-eyes ships off). The dashboard sign-in falls back to the demo login if the staff functions are absent. Full suite: 810 passed, 0 failed; hosted read-only Playwright: 20/20 |
| Live n8n settings (read-only) | 07: MCP **on**, saving off, version `a0ca9e60`. 04: MCP on. 05: MCP on (sub-workflow trigger only). 08: MCP off. 08-health: MCP on |

## Deployment sequence (owner, in order)

0. **Before:** `npm run security:check` and `npm run integrity:check` (0 FAIL). If anything was written to hosted since the
   pre-flight, take a fresh backup with the same procedure.
1. **Migrations:** run `npm run db:load -- --hosted`. Expect exactly `20261009000000_staff_sign_in_and_sessions.sql` and
   `20261009010000_reissue_needs_a_second_person.sql`.
   - Verify: 45 migrations; integrity 0 FAIL; `npm run security:check` all PASS; the setting
     `invoice.reissue_requires_second_person = false`.
2. **Staff logins:** for each real person, run
   `STAFF_PASSWORD=<12-72 chars> npm run staff:set-password -- EMP-NNN --login <login>`.
   - Hosted has **one** FINANCE/ADMIN employee (EMP-900). The other employees can sign in, but they cannot resolve
     exceptions unless their role allows it.
   - Verify: sign in on the dashboard as one person; the top bar shows their name.
3. **Dashboard TLS + build:** where the dashboard runs, set `DASHBOARD_DB_CA_PEM` (or `DASHBOARD_DB_CA_CERT` for a
   local server) **before** starting this build. Then `npm --prefix web run build` and start or deploy it.
   - Verify: the dashboard loads (a missing CA makes every page fail, with no unverified connection); staff and demo
     sign-in both work; /automation shows "Mark resolved" only for a resolver role.
4. **Workflow 07 MCP:**
   - Run `npm run n8n:mcp -- disable EiBs0AB2NfOua7AM "[RoofOps] 07 Reconcile & Webhook Supervision"`.
   - Verify that its output says nodes unchanged, still active, `availableInMCP: false`.
   - Then run `npm run reconcile -- --dry-run`: COMPLETED, 0 drift.
   - Optional, same procedure: 04 `YpmpJxQtSIBGSx6Z`, 08-health `e27BO9irmsYfVq6u`.
5. **Four-eyes (later):** only once a second FINANCE or ADMIN person has a login, set
   `update app_settings set value = 'true' where key = 'invoice.reissue_requires_second_person'`.
   - Verify: a reissue requested by A is refused for A (SAME_PERSON) and accepted for B.

## Rollback (each step independently)

| Step | Rollback | Proven |
|---|---|---|
| 1 | Run `npx tsx scripts/sql.ts -f ops/rollback/20261009010000_reissue_needs_a_second_person.down.sql`, then the `…000000_staff_sign_in_and_sessions.down.sql` one. Logins and sessions are deleted; audit rows stay | yes, on a restored copy (identical before and after) |
| 2 | The same as 1, or reset one password with `staff:set-password` (this also signs that person out) | tests |
| 3 | Redeploy the previous dashboard build (it does not need the CA) | — |
| 4 | Run the same command with `availableInMCP: true`, or set it in the n8n UI. If 07's version changed, re-publish `a0ca9e60` from its history | — |
| 5 | Set the value to `false` (takes effect at once) | tests |
