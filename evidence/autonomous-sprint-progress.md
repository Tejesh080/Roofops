# Autonomous sprint: progress checkpoint

Started 2026-10-08 after the Stage 3D closeout. Branch `factory/ac14-integrity-followup`; start HEAD `707e1c3`.
No secrets in this file.

## Environment and rules

- **Dashboard** (`web/`, Next.js): server-rendered. It reads the database as the least-privilege `roofops_web` role.
  Staff act in Airtable; n8n moves changes into Postgres.
- **Testing:** browser and functional tests run against a **local** database. `roofops_sprint` holds the repo's 45
  migrations plus the synthetic bundle; the dashboard runs on 127.0.0.1:3100 through a scratch launcher that holds
  the local-only role and test logins. Hosted access is read-only.
- **Owner approval required:** hosted writes, migrations, workflow publishing, and Airtable or Xero mutations go to
  the approval queue (below).
- **Process limits:** at most 2 agents (owner instruction). One permission refusal is recorded at item 11.

## Tracker (status: VERIFIED LIVE / VERIFIED LOCAL / TESTED / NOT VERIFIED)

| # | Item | Pri | Status | Evidence / commit |
|---|---|---|---|---|
| 1 | Local test environment: `roofops_sprint`, `roofops_web_local`, dashboard on :3100 | — | done | login, every page and every control exercised in the browser |
| 2 | **The dashboard production build failed** (`next build` TS2741: the AttentionPanel label for AC-08's `billing` kind was missing). Screen readers heard ", high priority:". Root `check` never type-checked `web/` | P1 | fixed `6d81f16` | `next build` exit 1 → 0; `npm run check` runs `typecheck:web` |
| 3 | Invoice next steps: "Ready to invoice" offered no action. "Approve in Airtable" fails for a Copilot-prepared preview until Prepare shows it on the row (AC-03) | P2 | fixed `f6ac805` | VERIFIED LOCAL: Finance card, Finance page and Copilot card |
| 4 | The Attention page omitted overdue customer payments (the `payment` kind was declared but never produced) | P2 | fixed `204bb3f` | test red → green; /attention lists PRJ-0025 and PRJ-0002 |
| 5 | Phones had no navigation (sidebar hidden, nothing replaced it); Finance rows overflowed | P2 | fixed `dfc3aa4` | VERIFIED LOCAL at 375 px and at 1440 px |
| 6 | Copilot safety: "approve and send" was refused; a second prepare did not duplicate (1 approval); its approval advice now gives the working steps | P2 | fixed `04ce494` | VERIFIED LOCAL with the real model |
| 7 | **Security:** the dashboard used unverified TLS to the hosted DB unless a CA env was set; now it verifies the certificate or refuses to connect | P1 | fixed `82903e0` | 5 tests; LIVE read-only: CA verified, a wrong CA refused, no CA refused |
| 8 | provision-dashboard-role wiped the sign-in and CA settings from web/.env.local; it now merges only its own keys | P2 | fixed `26360bb` | 3 tests (not run against hosted) |
| 9 | Sign-in: the username was cleared after a failed attempt; sign-out, redirect and API 401 verified | P3 | fixed `33ffd61` | VERIFIED LOCAL |
| 10 | **Per-person staff sign-in:** bcrypt checked in Postgres, DB sessions revalidated per request, lockout. Exceptions are resolved from the dashboard as the signed-in employee. Owner CLI `npm run staff:set-password` | P1 | done locally `1b97da2`, `3e1c5ed` | 12 tests on both engines; VERIFIED LOCAL (finance resolves; the estimator and the demo viewer cannot); independent review: 0 critical or high |
| 11 | **Four-eyes for reissues:** setting `invoice.reissue_requires_second_person`; the requester is refused (SAME_PERSON) | P1 | done, **shipped OFF** `adb5ed5` | 8 tests on both engines; the existing reissue suites are unchanged (82). Switching the existing tests' deciders was blocked as security-test removal, so the owner turns the rule on |
| 12 | The demo login's capability is stated accurately (cannot approve or resolve) | P3 | fixed `2a2077a` | — |
| 14 | Copilot prepares are attributed to the database-verified staff member (actor dashboard:copilot:EMP-NNN); the demo viewer stays dashboard:copilot. The approval itself still has no employee id (that needs a DB change) | P2 | done | VERIFIED LOCAL: APR-2026-0001 for PRJ-2026-0005, event actor dashboard:copilot:EMP-900 |
| 16 | Amounts in database explanations shown as money on the Finance card (the over-billing message read "billed 30888.72") | P3 | fixed | test (references, dates and formatted amounts untouched); VERIFIED LOCAL on PRJ-2026-0006 |
| 15 | Checkpoint: the full suite on **PGlite + PostgreSQL 17** | — | **810 passed, 0 failed** (36 hosted-only skipped) | after items 1-12 |
| 13 | Regression run against the **hosted** dashboard: the read-only Playwright smoke and state-sync specs | — | 20/20 passed | VERIFIED LIVE (read-only); the screens spec was skipped because it prepares a real preview |
| 17 | Pilot pre-flight: the CA contract was made consistent (PEM wins, absolute CERT path, clear failures; docs corrected), verified live with both forms; a fresh hosted backup was restored locally (62/62 identical); migrations were rehearsed on hosted copies; rollback scripts were proven exact; tooling: `npm run n8n:mcp` | — | done `de305e5`, `3aa932f`, `37cfe6b` | ops/pilot-release-runbook.md |
| 18 | **Reissue from the dashboard:** staff request and approve as themselves; the requester can never approve; the existing reissue rules apply | P1 | done locally `409ed0d`, `b34fd26` | 14 tests (both engines); VERIFIED LOCAL in the browser (finance requests, admin approves, the demo viewer sees nothing); independent review: 0 critical or high |
| 20 | Checkpoint: full suite PGlite + PostgreSQL 17 **827 passed, 0 failed** (at 409ed0d); after the review fixes, PGlite at b34fd26 443 passed, 0 failed; the dashboard production build, lint and both type-checks pass | — | green | — |
| 19 | **Airtable shows the reissued invoice:** Invoice Preview is a PROJECTION for reissued finals, so the reconciler repairs it | P2 | done locally `409ed0d` | real-reconciler test plus ablation; on a hosted copy only PRJ-2026-0002 is affected, with the expected text |

## Approval queue (hosted; not applied)

| # | Operation | Why | Risk | Verified | Rollback |
|---|---|---|---|---|---|
| A1 | Before deploying the dashboard from `82903e0` onwards, set `DASHBOARD_DB_CA_PEM` (the Supabase root CA, newlines escaped) | The dashboard now refuses unverified database TLS | Without it the hosted dashboard cannot connect; no data risk | proven live with roofops_web | unset it and redeploy the previous build |
| A2 | Apply `20261009000000_staff_sign_in_and_sessions.sql` (`npm run db:load -- --hosted`); then run `staff:set-password` for each real person | Per-person sign-in; resolve exceptions as yourself | Additive: 2 tables, 6 functions, pgcrypto (already on Supabase); dashboard grants only | both engines; full suite; browser | drop the functions and tables, delete the schema_migrations row |
| A3 | Apply `20261009010000_reissue_needs_a_second_person.sql`; turn on `invoice.reissue_requires_second_person` once a second FINANCE or ADMIN login exists | No one replaces a final invoice alone | The migration is neutral (ships off). Turning it on blocks the one-person reissue path | 8 tests; suites unchanged | set the value to false |
| A4 | n8n 07: set `availableInMCP` false (public API PUT with the same nodes, as done for 08) | An MCP client could start a repair-mode reconciliation | Low; deployment and inspection use the public API | the same change was proven on 08 in Stage 2A | set it back to true |

## Deployment checklist (dashboard)

1. Set A1 in the hosting environment.
2. Apply A2 (optionally A3), then create logins.
3. Build: `npm --prefix web run build` (it passes from `6d81f16`).
4. Smoke test: sign in as a staff member and as the demo viewer, open every page, resolve one test exception, sign out.

## Known open items (not fixed)

- **`voided_reason` survives a reissue**: by design (20261001170000:56, it records how the invoice came back); the dashboard never shows it on an approved invoice. Not a defect.
- **Approvals created by a Copilot prepare** carry no requested_by_employee_id (the event actor is attributed since item 14).
- **One shared Airtable account** for staff edits and RoofOps writes; it needs Airtable seats.
- **Untested live:** Xero payments read back, the void of an issued invoice, real uncertain creates, variations.
