# Autonomous sprint: progress checkpoint

Started 2026-10-08 after the Stage 3D closeout. Branch `factory/ac14-integrity-followup`; start HEAD `707e1c3` (clean,
equal to origin). No secrets in this file.

## Starting state (verified)

- **AC-14C hosted rollout complete** (Stages 1–3D): INV-2026-0040 reissued in Xero Demo. Final state:
  - 0 drift across Airtable, Drive and Xero;
  - integrity 28 PASS / 4 WARNING / 0 FAIL;
  - security all PASS;
  - dispatch hash blank.
- **Open from Stage 3D:**
  - the stale Airtable *Invoice Preview* text after a reissue;
  - `voided_reason` kept after a reissue;
  - 07 `availableInMCP` on;
  - no per-person authentication or second approver;
  - the 08-health Drive probe returns intermittent 403s.
- **Environment:**
  - The web dashboard (`web/`, Next.js) uses one demo login and reads the **hosted** DB as `roofops_web`.
  - Staff act in Airtable.
  - Local Docker Postgres `roofops-postgres` holds the demo data.

## Rules for this sprint

- Browser and functional testing run against the **local** database. Hosted access is read-only.
- Hosted writes, workflow publishing and Airtable/Xero mutations go to the approval queue (below).

## Tracker

| # | Item | Pri | Status | Evidence / commit |
|---|---|---|---|---|
| 0 | Phase 0: state confirmed, tracker created | — | done | this file |
| 1 | Local test env: fresh DB `roofops_sprint` (43 migrations + bundle), least-privilege `roofops_web_local`, dashboard on 127.0.0.1:3100 | — | done | VERIFIED LOCAL (login, overview, search, filters, project page) |
| 2 | **Dashboard production build failed** (`next build`: TS2741, `AttentionPanel` KIND lacked `billing`, added by AC-08). Screen readers also heard ", high priority:" with no category on over-billed items. Root `check` never type-checked `web/` | P1 | fixed | `next build` exit 1 → 0; Attention page reads "Billing problem, high priority:"; `npm run check` now runs `typecheck:web` |
| 3 | Invoice next steps: a "Ready to invoice" project page offered no action. "Awaiting approval" said "approve in Airtable", but an Airtable Approve of a Copilot-prepared preview is always refused until Prepare shows it on the row (AC-03). Shared INVOICE_NEXT_STEP guidance now appears on the Finance card, the Finance page and the Copilot card | P2 | fixed | VERIFIED LOCAL: Copilot prepared APR-2026-0001 for PRJ-2026-0002 (local DB, no outbox, preview not on the row); guidance shown on PRJ-0004, PRJ-0002 and /finance |
| 4 | The Attention page ("everything that needs a person") never listed overdue customer payments. The `payment` kind was declared but never produced, so PRJ-2026-0025 (flagged needs_attention) was invisible there | P2 | fixed | ui-logic test red → green (every needs_attention project is listed); VERIFIED LOCAL: /attention shows PRJ-0025 $3,518.67 and PRJ-0002 | 3 | Invoice next steps: a "Ready to invoice" project page offered no action. "Awaiting approval" said "approve in Airtable", but an Airtable Approve of a Copilot-prepared preview is always refused until Prepare shows it on the row (AC-03). Shared INVOICE_NEXT_STEP guidance now appears on the Finance card, the Finance page and the Copilot card | P2 | fixed | VERIFIED LOCAL: Copilot prepared APR-2026-0001 for PRJ-2026-0002 (local DB, no outbox, preview not on the row); guidance shown on PRJ-0004, PRJ-0002 and /finance |
| 5 | Phones (≤720px) had no navigation: the sidebar was `display:none` with nothing replacing it. Also, Finance rows overflowed their card when the right-hand text was long (`.row-right` could not shrink) | P2 | fixed | VERIFIED LOCAL at 375px: a scrollable nav strip lists all 8 destinations and tapping Finance navigates; 0 elements overflow; desktop (1440) unchanged |
| 6 | Copilot financial safety (VERIFIED LOCAL, real DeepSeek): "approve and send PRJ-0002" was refused with nothing changed; a second prepare returned the existing APR-2026-0001 with no duplicate (approvals 1/1 pending). Its approval advice was still the bare "approve in Airtable" (system prompt rule), so the prompt now requires the Prepare, check, Approve steps | P2 | fixed | fresh chat answer gives the steps |
| 7 | **Security:** the dashboard connected to the hosted DB with `rejectUnauthorized:false` unless DASHBOARD_DB_CA_PEM was set (the local setup did not set it), so the roofops_web password crossed an unverified TLS connection. Now remote connections are verified (PEM or file) or refused; local hosts use plain TCP; URL ssl params are stripped | P1 | fixed (code); deploy needs the CA env | 5 unit tests; LIVE read-only: roofops_web connected with the CA verified; wrong CA refused; no CA refused before connecting; local dev server still serves |
0,103.98 |

## Approval queue (hosted / amber; not applied)

| # | Operation | Why | Risk | Verified | Rollback |
|---|---|---|---|---|---|
| A1 | Any hosted dashboard deployment (e.g. Vercel): set DASHBOARD_DB_CA_PEM (the Supabase root CA, 
-escaped) **before** deploying commit 7+ | Otherwise the dashboard now refuses to connect (fail closed) | Outage until the env is set; no data risk | the CA connection was proven live with roofops_web | unset the env and redeploy the previous commit |

## Next task

Phase 1 discovery (functional inventory + defect triage), then the local browser environment.
