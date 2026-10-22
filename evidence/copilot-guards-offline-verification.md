# Copilot read coverage and guards: offline verification (AC-22, COP-01, COP-02; CP-03, CP-09)

Status: **Fixed offline**. Live verification is pending: the hosted dashboard and DeepSeek were not used. Everything below
ran locally on PGlite and the local Postgres 17 container, with the dashboard role's privileges only and a scripted AI
provider.

Branch `feature/advanced-sprint-lifecycle`. Audit findings CP-01, CP-02 (AC-22), CP-03, CP-05 and CP-09 (2026-10-22).

## 1. What was wrong

| Id | Defect | Reproduction |
|---|---|---|
| AC-22 (CP-02) | A second invoice prepare in one Copilot request returned the first project's preview under the second project's name | The demo path's event id was `dashboard:copilot:<requestId>`, the same for every project in one request. The second call replayed the first: card PRJ-2026-0002, preview PRJ-2026-0005, the same approval |
| COP-01 (CP-01) | With staff Xero dispatch off, the Copilot still prepared a final invoice for a signed-in employee. That preview could then only be rejected: the dashboard may not approve while dispatch is off, and Airtable may not approve a named person's preview | `prepare_invoice` passed any staff token to `web_invoice_prepare`; nothing checked the dashboard's dispatch rule (`web/lib/dispatch.ts`) |
| COP-02 (CP-05) | Tool arguments were never enforced: a truncated call ran with `{}`, an unknown group answered "active", and an answer cut off at the length limit was acted on | `agent.ts` swallowed `JSON.parse` failures; `list_projects` mapped any unknown group to `active`; `chat()` ignored `finish_reason` |

**Coverage gaps (not defects):**
- **CP-03:** no read model showed which jobs the AC-13B pre-start gate holds.
- **CP-09:** no tool listed pending quotes, although `v_dashboard_quotes` exists. One tool description wrongly said the
  attention list covered quotes.

## 2. Changes

| Where | Change |
|---|---|
| `supabase/migrations/20261022060000_pre_start_blocked_read_model.sql` (+ rollback) | New view `v_dashboard_pre_start_blocked`, select for `roofops_dashboard` only. It lists jobs not started (no Actual Start; Planning, Materials Pending, Scheduled, On Hold) with a required pre-start item open, and the open items. Nothing existing is redefined |
| `web/lib/queries.ts` | `listPreStartBlocked`, `listPendingQuotes` (drafts and sent quotes from `v_dashboard_quotes`). The demo prepare's event id names the project: `dashboard:copilot:<requestId>:<project>` |
| `web/lib/copilot/tools.ts` | Two GREEN tools: `list_jobs_held_by_pre_start` and `list_pending_quotes`. `list_projects` returns an error naming the allowed groups for an unknown one. `prepare_invoice` refuses a signed-in employee while dispatch is off (`DISPATCH_OFF.copilotPrepare`). A preview for another project never becomes a card. `ToolContext.env` (testable switch). Corrected the `list_projects` description |
| `web/lib/copilot/agent.ts` | `checkArgs`: every call is checked against its declared parameters (JSON object, required keys, declared keys only, string types, enum values). A call that does not fit gets an error message and never runs. An answer with `finish_reason = length` is `bad_answer`, so the read-only fallback answers and nothing is prepared |
| `web/lib/dispatch.ts` | `DISPATCH_OFF.copilotPrepare`. `DISPATCH_OFF.prepare` no longer suggests asking the Copilot, which would refuse a signed-in employee |
| `web/app/(ops)/finance/page.tsx` | While dispatch is off, a signed-in employee who may prepare sees the "prepare in Airtable" note, not a "Prepare with Copilot" button the Copilot would refuse. The demo viewer keeps the button: its previews can be approved in Airtable |

The Copilot still has no approve, send, pay or write tool. `prepare_invoice` remains the only AMBER tool.

## 3. Verification

| Check | Result |
|---|---|
| `test/copilot-guards.test.ts` (new), `copilot-tools`, `copilot-resilience`, `staff-invoice-approval`, `dispatch-policy`, `schema`, PGlite and Postgres 17 | 130 passed |
| Ablation AC-22: event id without the project | 1 red |
| Ablation COP-01: no dispatch check | 1 red |
| Ablation COP-02: arguments not enforced | 1 red |
| Ablation COP-02: `finish_reason` ignored | 1 red |
| Both typechecks (root and `web/`) | clean |
| Full gate, `TEST_DATABASE_URL=… npm run check` (lint, both typechecks, PGlite and Postgres 17) | exit 0; Test Files 62 passed, 3 skipped (65); Tests 1293 passed, 37 skipped (1330) |

**Existing tests changed (intended):**
- `copilot-tools.test.ts`: the pinned tool list adds the two GREEN tools.
- `staff-invoice-approval.test.ts`: the staff Copilot prepare case now passes `env: { STAFF_XERO_DISPATCH: 'on' }`, the
  state it describes. A new case proves that with dispatch off nothing is prepared and no approval row appears.

**Not verified:**
- The Finance page change in a browser (typecheck only).
- The Copilot against the real DeepSeek (Promptfoo `npm run ai:eval` needs the running app and the provider).

## 4. Hosted steps awaiting owner approval

1. 🔒 `npm run db:load -- --hosted` (with the release): applies the read model.
2. 🔒 Deploy the dashboard build (Vercel Preview first). `STAFF_XERO_DISPATCH` stays unset.
3. Read-only check in the Preview: ask the Copilot "Which jobs are blocked by safety checks?" and "Which quotes are still
   pending?". The answers must match `v_dashboard_pre_start_blocked` and `v_dashboard_quotes`. Then `npm run ai:eval`
   against the Preview.
4. Rollback: the previous dashboard build, then the down file.
