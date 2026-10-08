# Pilot: staging deployment of the dashboard (owner-run, needs approval)

Nothing here has been run against hosting. No Vercel project is linked (no `.vercel/`); the Vercel CLI on this machine
is not signed in. No secret belongs in this file, Git or chat.

## Security review for internet exposure (2026-10-09, branch `factory/ac14-integrity-followup`)

| Area | Result |
|---|---|
| Database role | The web server connects only as `roofops_web` (`DASHBOARD_DATABASE_URL`). That role is not superuser and has no BYPASSRLS, CREATEROLE or CREATEDB. Its only membership is `roofops_dashboard`, and its connection limit is 10. It reads no table directly, only `v_dashboard_*` views and 15 SECURITY DEFINER functions (`npm run security:check`: all PASS). The owner URL (`SUPABASE_DB_URL`) is never read by `web/` |
| TLS to the database | A remote database without a verified CA is refused (`web/lib/db-tls.ts`); there is no unverified fallback |
| Sessions | HMAC-signed cookie (`AUTH_SECRET`, at least 32 characters; 64 today), 12 hours. Cookie flags: `HttpOnly`, `SameSite=Lax`, `Secure` in production. A staff session is a random 32-byte token whose SHA-256 is in Postgres. It is re-checked on **every** request, so sign-out, a password reset, deactivation and expiry end it at once (journey steps 12–13) |
| Authorisation | Every write goes through a `web_*` function that resolves the session token to the employee in the database. Each of these was replayed in the browser and refused: requester approving (SAME_PERSON), Estimator (role), shared demo viewer (no token), duplicate, concurrent |
| CSRF | Server actions: Next's Origin/Host check. A cross-site replay was rejected ("Invalid Server Actions request"). The Copilot API also refuses unless it gets same-origin `application/json` (`web/lib/same-origin.ts`) |
| Login abuse | bcrypt in Postgres. One generic refusal; an unknown login does the same work, so timing reveals nothing. 5 wrong passwords lock that login for 10 minutes whatever the address (tested with 5 different addresses). Per server instance, an address is throttled after 5 failures. The address is now the **last** `x-forwarded-for` entry (the one the proxy sets), so a forged first entry no longer resets the throttle |
| Headers | HSTS, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `noindex`, and a strict referrer policy |
| Errors | A database outage shows a plain page with a support reference, also logged server-side with its cause. No stack trace reaches the browser |

**Accepted for a supervised pilot (not blockers):**
- The shared demo login cannot be revoked per person (only by rotating `AUTH_SECRET`). It can still prepare an invoice *preview* through the Copilot; nothing reaches Xero without a Finance approver. Remove it once individual logins are proven.
- The per-address throttle lives in memory per instance. The database lockout covers staff logins whatever instance served the attempt.
- Someone who knows a login name can lock that person out for 10 minutes. `staff:set-password` unlocks it.
- No content-security policy for scripts (Next would need nonces).

## Procedure (Vercel, region Sydney next to Supabase `ap-southeast-2`)

1. **Prerequisite:** the hosted migration `20261009040000` (see the approval request) is applied. The dashboard also
   works without it: the project page then just omits the Xero document history.
2. Sign in: `cd web`, `npx vercel login`, then `npx vercel link` (new project, root directory `web`, framework Next.js).
   In Project → Settings → Functions, set the region to **Sydney (syd1)**.
3. **Environment variables** (Production and Preview, all marked Sensitive):
   - `DASHBOARD_DATABASE_URL`: the `roofops_web` URL from `web/.env.local`. **Never** `SUPABASE_DB_URL`.
   - `DASHBOARD_DB_CA_PEM`: see `ops/pilot-owner-setup.md` §1B (a clipboard one-liner).
   - `DASHBOARD_DB_POOL_MAX=1`.
   - `AUTH_SECRET`: a **new** random value of 48+ characters. Do not reuse the local one; that also invalidates any local cookie.
   - `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL` (Copilot; optional).
   - `DEMO_USERNAME` and `DEMO_PASSWORD`: set them for the first staging check only; remove them once two individual logins work.
4. Deploy a **preview** first (`npx vercel deploy`). Turn on Vercel deployment protection (Vercel Authentication) for it.
5. **Verify on the preview:**
   - every page redirects to `/login` without a session;
   - the demo login shows data;
   - `/health` loads;
   - response headers include `strict-transport-security`;
   - a page with the CA variable removed shows "RoofOps cannot load right now" (then put it back).
6. Production (`npx vercel deploy --prod`) only after the first supervised acceptance test passes on the preview.

**Rollback:** Vercel → Deployments → promote the previous deployment, or delete the project. The database is unaffected.

## Local rehearsal (repeatable, no hosted access)

```bash
npx tsx scripts/pilot-rehearsal.ts --reset
```

```bash
npm --prefix web run build
```

```bash
node --env-file=web/e2e/.auth/pilot.env web/node_modules/next/dist/bin/next start web -H 127.0.0.1 -p 3100
```

In `web/` (opt-in, local database only):

```bash
E2E_PILOT=1 E2E_BASE_URL=http://127.0.0.1:3100 npx playwright test --project=staff-journey
```
