# Acceptance criteria

A module is **done** only when every box below is ticked **and** its automated tests pass in CI. A working UI is not enough.
Each phase ends with: `npm run lint` · `npm run typecheck` · the relevant `npm test` suites · fix · update docs · one clean commit · a written report (built / tested / still mocked / limitations / production risks).

## Required test matrix → where it lives

| # | Required test | Phase | Test file (planned) | DB |
|---|---|---|---|---|
| 1 | duplicate webhook | 2 | `quote-to-project.idempotency.test.ts` | PGlite |
| 2 | missing field | 2 | `event-envelope.validation.test.ts` | — |
| 3 | invalid state transition | 1–2 | `state-machines.test.ts` (every illegal edge) | — |
| 4 | 429 retry | 3 | `retry-policy.test.ts` + `reliability-lab.test.ts` | PGlite |
| 5 | 500 retry (bounded) | 3 | same | PGlite |
| 6 | non-retryable 400 | 3 | same | PGlite |
| 7 | external timeout (ambiguous write → reconcile) | 3, 6 | `ambiguous-write.test.ts` | PGlite |
| 8 | two workers processing the same event | 2 | `quote-to-project.concurrency.test.ts` | **real Postgres (Docker)** |
| 9 | duplicate PO attempt | 5 | `purchase-orders.idempotency.test.ts` | PGlite |
| 10 | duplicate invoice attempt | 6 | `xero-sync.idempotency.test.ts` | PGlite |
| 11 | permission denial | 1, 4 | `permissions.test.ts`, `copilot.guard.test.ts` | — / PGlite |
| 12 | AI attempting an unauthorised RED action | 4 | `copilot.guard.test.ts` | PGlite |
| 13 | approval rejected | 4 | `approvals.test.ts` | PGlite |
| 14 | successful approval | 4 | `approvals.test.ts` | PGlite |
| 15 | supplier extraction malformed output | 5 | `supplier-quote.extraction.test.ts` | — |
| 16 | supplier quote arithmetic mismatch | 5 | `supplier-quote.arithmetic.test.ts` | — |

---

## Phase 0: Architecture, schema, acceptance criteria ✅ (this phase)

- [x] Architecture document: context, layers, adapters, events, idempotency, reliability, AI tiers, security, n8n/Airtable roles, testing, deployment, risks
- [x] Schema as a runnable migration covering all 25 required entities
- [x] Schema applies cleanly to Postgres 18 (PGlite); 31 constraint checks pass
- [x] External API claims checked against official docs (Xero limits and idempotency, Airtable rate limits); unverified items marked as such
- [x] Source CSV audited; problems and a remediation plan documented
- [x] `.env.example` with every planned variable; no secrets committed
- [x] Decisions needing review listed (ADR-006, ADR-010, ADR-011)

## Phase 1: Database + canonical data import ✅ (awaiting review)

Scope revised by the user: load the **canonical synthetic data bundle** (no regeneration), normalise **dates only** relative to `DEMO_DATE = 2026-09-29`, and build **no** frontend, Airtable, n8n or Xero.

- [x] TypeScript project (strict, `noUncheckedIndexedAccess`) with `lint`, `typecheck`, `test`, `data:normalise`, `data:check`, `db:up`, `db:load`, `db:reset`
- [x] Bundle unpacked verbatim to `data/raw/`; the per-table CSVs are canonical
- [x] Date normalisation: 11 logged rules, 114 cells changed, 84 → 0 invariant violations; **test proves only date cells changed**
- [x] Deterministic: a fresh run reproduces the committed `data/normalised/` exactly (test + `npm run data:check`)
- [x] Migrations apply to **real Postgres 17** (docker compose, the Supabase major version) **and** PGlite; checksum drift is refused
- [x] Phase 0 schema checks ported to Vitest (`test/schema.test.ts`, 18 checks), run on both engines
- [x] Counts equal the brief: 40 customers · 52 properties · 65 quotes · 30 projects · 6 suppliers · 45 products · 35 POs · 38 invoices · 110 events · 75 site notes · 60 documents (+ 12 exceptions, 81 ledger entries)
- [x] Every source ID, name, email, phone, amount (to the cent) and relationship is preserved (tests compare the DB against the CSVs)
- [x] Views: project risk (with named reasons), invoice balances/overdue, PO status/ack SLA, waiting on materials, missing completion docs, accepted quotes without project, missing measurement, duplicate customers, quote conversion, executive KPIs
- [x] All 14 scenarios are reproduced **from facts** by the views; one test each; scenario IDs come from `scenario-manifest.json`, not hard-coded
- [x] Import is one transaction, all-or-nothing (tested with a corrupted row), refuses files that don't match `MANIFEST.json`, and is idempotent by dataset hash
- [x] Fixtures under `test/fixtures/` (duplicate webhook: transport + semantic, missing field, wrong type, truncated JSON, Xero 429, Airtable 429, 500, timeout before commit, ambiguous timeout after commit), validated against the event envelope contract
- [x] Every email is on a reserved `example.*` domain (test)
- [x] Source discrepancies that are not dates are documented and pinned by tests, not silently fixed (`docs/data-import.md` K1–K8)
- ➡ Moved to **Phase 2**: state-machine unit tests (they belong with the first state-changing command)
- ➡ Moved to **Phase 4**: permission-matrix tests (they belong with the copilot tool guard)
- ➡ Not applicable: Next.js scaffold (no frontend this phase, per the user)

## Phase 2: Real n8n + Airtable + Google Drive, Quote Accepted → Project ✅ (awaiting review)

Real services only (ADR-018). Each side effect: **create, then read back, then verify**. Evidence: docs/phase2-status.md.

- [x] Hosted Postgres 17 (Supabase): schema + data; migrations 000–700; hosted verification suite (63 checks) incl. live Phase 2 evidence
- [x] Supabase Data API surface closed (`anon` / `authenticated`: 0 tables, 0 functions)
- [x] Four n8n credentials verified against the real services (Airtable PAT, Postgres least-privilege role, Google Drive, DeepSeek)
- [x] Airtable webhook (push, Quotes.Status only) with a durable Postgres cursor; refreshed daily; no polling
- [x] `[RoofOps] 01 Quote Accepted → Project` published in the Roofops project; business logic only in Postgres functions; secrets only in n8n credentials
- [x] Real Drive root + per-project folder with 01–05 subfolders; every create read back; IDs/URLs stored as verified `external_links` and in Airtable
- [x] Airtable Project upserted on RoofOps ID, linked to Quote and Customer, Drive URL written; project, quote back-link and uniqueness read back
- [x] E2E: Airtable Sent → Accepted → exactly one Postgres project, task, checklist, Drive folder, Airtable project; audit chain explains it
- [x] Transport duplicate (same event id) and semantic duplicate (new event id, same fact), incl. overlapping executions: still 1 of everything, in all three systems
- [x] Validation failure: rejected, no side effects, one exception (after the ADR-026 fix), no retry, staff-visible reason
- [x] Transient failure: bounded, logged retries; recovery; exhaustion → exception; operator re-queue → recovery → auto-resolve (ADR-027)
- [x] Bugs found by live testing fixed at the design level and pinned by tests (ADR-025/026/027)
- [ ] Carried to Phase 3: exception-queue UI (re-queue button), scheduled sweeper for crashed runs, final-attempt run step

## Phase 3: Reliability / failure handling with real workflow behaviour
- [ ] Exception queue actions (retry / resolve / view event) operate on real runs; retry is idempotent
- [ ] Real rate-limit handling (Airtable 429 → 30 s wait; Xero `Retry-After`), timeouts and ambiguous writes reconciled by read-back
- [ ] Automation Health metrics from real `workflow_runs` + n8n execution history

## Phase 4: Operations Dashboard + Operations Copilot (see [phase4-status.md](phase4-status.md))
- [x] Next.js dashboard over the hosted DB through a least-privilege role and read-only views (ADR-032); Demo mode banner; no business state in the frontend
- [x] Headline numbers (active, at risk, awaiting materials, ready to invoice, open issues) that agree with the existing KPIs (tested)
- [x] Project table (number, customer, stage, scheduled date, materials, invoice, risk + reason) and project detail (customer, quote, status, checklist/material review, Drive link, POs, Xero status + ID, history, issues)
- [x] Business language: no automation jargon in UI or copilot output (tested)
- [x] DeepSeek copilot, server-side, tiered tools (ADR-033); answers the five example questions from tools (live smoke 6/6 ×3)
- [x] "Prepare invoice for <project>" returns the preview and requires approval; nothing reaches Xero (proven live on PRJ-2026-0005)
- [x] Login: signed session, verified in proxy and in every page/API (ADR-034); Vercel-ready (deploy needs `vercel login`)
- [x] Design system, app shell, copilot drawer, grouped automation history, business-first issues, demo guide (Phase 5)
- [x] `npm run demo:status` / `demo:reset`: audited, idempotent, internal-only (ADR-035)
- [x] Playwright end-user tests (real login, real data, real DeepSeek)
- [ ] Integration health panel (LIVE/BLOCKED)

## Phase 5: Real Xero Demo Company (delivered early as "Phase 3": see [phase3-status.md](phase3-status.md))
- [x] Xero OAuth2 credential `RoofOps Xero`, one connection, Demo Company (AU) proven `Class=DEMO` before the tenant was pinned; a real org was detected and refused (ADR-030)
- [x] Contact find/create, invoice lookup, one DRAFT invoice; after create: GET → exists once, amount/tax/reference/contact match, InvoiceID + ContactID persisted as verified `external_links`
- [x] Explicit approval of a hashed preview (project, customer, amount, reference, Xero organisation); no approval → nothing in Xero (proven by Xero inventory)
- [x] Same event resent and new event for the same project → still one Xero invoice; Airtable keeps showing the real state (ADR-031)
- [x] Search Xero by number and reference before every create; timeout → `UNKNOWN`, reconciled before retry; persistent idempotency in Postgres (ADR-029)
- [x] Invalid project state rejected with a named exception and no approval; audit chain explains every step
- [ ] Exception-queue UI for a dead-lettered Xero write (operator SQL today)

## Phase 6: Real DeepSeek Operations Copilot
- [ ] Server-side DeepSeek (`DEEPSEEK_MODEL`), tool calling with GREEN/AMBER/RED tiers; the model never holds DB or external credentials
- [ ] "Which projects are at risk next week?" → tool selected → answer matches `v_project_risk`
- [ ] "Create the invoice for this completed job." → approval required → after approval a real Xero action → verified → audited

## Phase 7: Supplier quote intelligence + optional OpenTakeoff
- [ ] Extraction by DeepSeek, arithmetic in code, SKU-based matching (K8), human review, draft PO only
