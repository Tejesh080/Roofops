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

## Approval queue (hosted / amber; not applied)

| # | Operation | Why | Risk | Verified | Rollback |
|---|---|---|---|---|---|

## Next task

Phase 1 discovery (functional inventory + defect triage), then the local browser environment.
