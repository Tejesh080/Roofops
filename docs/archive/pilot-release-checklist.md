# Supervised staff pilot: release checklist (2026-10-09)

## Working now

| Capability | Local (production build, isolated `roofops_pilot`) | Hosted |
|---|---|---|
| Individual staff sign-in, DB-verified sessions, sign-out, expiry, lockout | verified in the browser | functions deployed; **0 logins exist** |
| Reissue: Finance requests, a *different* Finance/Admin approves, exactly one generation-2 write queued | verified, incl. duplicate, concurrent, replay and CSRF attempts | functions deployed; not yet used by a real person |
| Restricted role and demo viewer cannot request, approve or resolve | verified by replaying the real requests | same code |
| Financial exception resolved through the dashboard, audited to the person | verified | deployed |
| Project page: current vs replaced Xero document | verified (queued and created) | **needs migration 20261009040000** |
| Plain error page with a support reference | verified (DB unreachable) | ships with the next dashboard build |
| Dashboard over verified TLS, restricted `roofops_web` role | — | verified: production build against hosted, read-only browser tests 20/20 |
| Invoice and reissue workflows 04 / 05 / 08 / 07 | — | active, versions unchanged; read-only preview ok; live invoice correctly refused for reissue |

## Configuration only you can supply

1. Approval for the hosted migration `20261009040000` (read models only).
2. A Vercel sign-in and project, with the env vars in `ops/pilot-staging-deployment.md`. Use a new `AUTH_SECRET` and the CA as `DASHBOARD_DB_CA_PEM`.
3. Two real people: names, work emails, roles (one FINANCE, one FINANCE or ADMIN). Each types their own password.

## Deploying the dashboard

Follow `ops/pilot-staging-deployment.md`:
- deploy a preview with protection on, in the Sydney region;
- verify it;
- then production.

The local alternative is `npm --prefix web run build` then `npm --prefix web run start`; it is reachable on this machine only.

## Creating the two hosted identities

Follow `ops/pilot-owner-setup.md` §2:
- `npm run staff:add-employee -- EMP-101 …` and `EMP-102 …`;
- then each person sets a password at a hidden `Read-Host` prompt, which runs `npm run staff:set-password`.

No password is ever shown, stored in Git or sent in chat.

## First supervised acceptance test (on the preview, both people present, you watching)

1. Person A (FINANCE) signs in. The menu shows their name and role. Then they sign out.
2. Person B signs in the same way.
3. Five wrong passwords on a **third, throwaway attempt name**: the message never changes. (Do not lock A or B.)
4. A opens Finance → Invoice reissues.
   - Expect "No voided final invoices". Do **not** void a real invoice for this test.
   - The reissue path itself is covered by the local rehearsal. Exercise it on hosted only with an invoice you deliberately void in the Xero **Demo Company**, and only with separate approval.
5. A opens Automation and sees "Mark resolved" on the open exceptions.
   - Resolve one only if it is genuinely done (for example EXC-0003 after checking with the supplier).
   - The Resolved list then shows A's note. `audit_events` names A's employee code.
6. A opens PRJ-2026-0002. The Finance card shows `61e09cad…` as **Current** and `21545f60…` as **Replaced (deleted in Xero)**. This needs migration 040000.
7. Both sign out. Reopening a saved page goes to the sign-in page.
8. Pass, then remove `DEMO_USERNAME`/`DEMO_PASSWORD` and redeploy. The demo login must now be refused.

## Remaining blockers to real production use

- The data and Xero organisation are the **Demo Company** with synthetic records. A real tenant needs its own onboarding, and the pinned-tenant guard re-proven.
- Airtable approvals still come from one shared account (EMP-900). Per-person Airtable approval needs seats and a mapping.
- Creating the Xero draft after an approved reissue is an operator dispatch (`npm run reissue -- dispatch`), not automatic.
- Four-eyes on the owner CLI stays off until two people exist. The dashboard always enforces it.
- Copilot invoice *preparation* records no individual requester (`requested_by_employee_id` is empty).
- Ongoing: the 08-health Drive probe has intermittent 403s; 4 pre-existing open exceptions (EXC-0003, 0013, 0016, 0017).
- No production monitoring or alerting for the dashboard itself, beyond the Vercel logs.
