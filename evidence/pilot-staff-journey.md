# Pilot readiness: environment check, security review and local staff journey (2026-10-09)

No hosted writes. No Xero or Airtable calls, except the dashboard's read-only Copilot and smoke checks against hosted data.

## Phase 1: environment (read-only on hosted)

| Check | Result |
|---|---|
| Git | `factory/ac14-integrity-followup` at `3d0755a`, equal to origin |
| Migrations | hosted 47; all 47 checksums equal the repo files; no hosted row outside the repo |
| Integrity / security | 28 PASS / 4 WARNING / 0 FAIL; every privilege check PASS |
| Staff on hosted | `staff_accounts` 0, `staff_sessions` 0, no staff audit rows. FINANCE/ADMIN employees: only EMP-900 "Demo Finance Approver" (the demo identity). The earlier report's "two staff accounts" were the two the **owner still has to create**; none exist |
| Settings | `invoice.reissue_requires_second_person=false`, `invoice.reissue_roles=FINANCE,ADMIN`, `staff.session_hours=12`. Pending approvals 0, open outbox 0 |
| Workflows | 04 `fee94016`, 05 `feab88d9`, 08 `facd57c8`, 08-health `c6f531fd`: all active, versions unchanged. 07 `a0ca9e60` active, MCP off, saves no execution data |
| No-document checks | first-issue preview PRJ-2026-0005 `ok`; reissue check of the live INV-2026-0040 → `INVOICE_NOT_VOIDED`; INV-2026-0040's current Xero draft is generation 2 CREATED `61e09cad…` |
| 07 schedule | the last scheduled run was 2026-10-07 16:30 UTC (9 scheduled repair runs in total). Its next run, 16:30 UTC on 10-08, had not happened at the check (13:53 UTC) |
| Dashboard | `next build` passes. The production build against hosted over verified TLS passed the read-only Playwright smoke and state-sync tests 20/20, with no server errors |
| Hosting | no Vercel project linked (`.vercel/` absent, no `vercel.json`); the Vercel CLI on this machine is not signed in; no other hosting config |

## Phase 2: security fixes

- **Login throttle:** it counted against the *first* `x-forwarded-for` entry, which the client controls behind an appending proxy. It now uses the last entry (`web/lib/client-address.ts`), and the throttle map is bounded.
- **Copilot API:** it now refuses anything but same-origin `application/json` (`web/lib/same-origin.ts`).
- **Tests:** 4 unit tests in `test/web-request-guards.test.ts`, plus the browser throttle test.

The full review is in `ops/pilot-staging-deployment.md`.

## Phase 3: the staff journey, local production build, isolated database

Setup: `scripts/pilot-rehearsal.ts --reset` builds `roofops_pilot` (48 migrations):
- two voided synthetic finals: INV-2026-0039 deleted in Xero, INV-2026-0040 voided in Xero;
- EMP-801 Synthetic Finance Requester, EMP-802 Synthetic Admin Approver and EMP-803 Synthetic Estimator, added through the owner CLI (`--local`) with random test passwords.

`web/e2e/staff-journey.spec.ts` (opt-in `E2E_PILOT=1`): **2/2 passed**. It checks the database after every step:

| Step | Outcome |
|---|---|
| Finance signs in (menu shows name and role), requests the reissue of INV-2026-0039 | APR PENDING, requested by EMP-801. The requester sees "You requested this…" and no Approve control |
| Repeat request; too-short reason (bypassing the browser check); cross-site replay | refused / refused / "Invalid Server Actions request". Still one request |
| Estimator; demo viewer: no controls; their replays of the real request | "Your role cannot…" / "the shared demo login cannot". No request |
| Admin sees the exact draft (number, amount, customer, requester, APR); approves without ticking "I checked" | refused by the server |
| Requester, Estimator and demo replay the approval with the box ticked | SAME_PERSON / role / demo refusals; approval still PENDING; 0 generation-2 writes |
| Admin approves | approval EXECUTED, decided by EMP-802. Ledger generation 2: 1 row; `xero.create_draft_invoice` generation 2: **exactly 1 write, PENDING**. The UI shows "requested by …, approved by …" and the supervised-dispatch next step |
| Repeat approval | "already decided"; still 1 write |
| Two concurrent requests, then two concurrent approvals (INV-2026-0040) | exactly 1 request and 1 approval succeed; exactly 1 generation-2 write |
| Project page PRJ-2026-0005 while queued | "Replacement queued"; replaced InvoiceID "voided in Xero: no longer a valid invoice"; status "Creating in Xero"; **no** "Open in Xero" link |
| Financial exception (the void) resolved by Finance on Automation | RESOLVED, audited to EMP-801. The repeat, Estimator and demo replays are refused; the other exception stays OPEN |
| Sign-out, then the old cookie replayed | redirected to sign-in; the action says "Your sign-in has ended" |
| Session expired in the database | next request goes to sign-in |
| Unknown login vs wrong password; 5 wrong from 5 different addresses; right password while locked; 6th attempt from one address with a forged first `x-forwarded-for` | identical generic answer; locked; refused; "Too many attempts" |

## Phase 4: defects found and fixed

1. **P1: a voided document was shown as current.** Between a reissue's approval and the dispatch, the project page
   showed the superseded (voided or deleted) Xero document as "Draft in Xero", and "Open in Xero" opened it.
   - Fix: migration `20261009040000`. `v_dashboard_projects` shows a Xero ID only for the current CREATED generation; the new `v_dashboard_invoice_xero_history` lists each document as Current, Replacement queued or Replaced, with Xero's verified status and who requested and approved it.
   - Tests: `test/dashboard-xero-history.test.ts`, 4 per engine. Red-green: without the condition, both engines fail.
   - Rollback: restores the view's exact definition (hash `fb22457c…`).
   - Rehearsed on a restored hosted copy: every project row identical, integrity 28/4/0, all privilege checks PASS.
2. **P2: database outage page.** A database outage or missing CA showed Next's generic "Application error". `app/error.tsx` now gives plain words, a retry and a reference that matches the server log. Verified with an unreachable database.
