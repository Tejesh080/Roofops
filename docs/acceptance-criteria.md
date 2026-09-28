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

## Phase 1: Database + seed data

- [ ] Next.js (latest stable) + TypeScript strict + Tailwind + shadcn/ui scaffold; `lint`, `typecheck`, `test` scripts
- [ ] Migration applies to Supabase local **and** PGlite; `scripts/phase0-schema-check.mjs` ported to Vitest
- [ ] Views: project risk, overdue invoices, outstanding balance, quote conversion, open PO value, missing completion docs
- [ ] Seed generator: deterministic from `(SEED, DEMO_ANCHOR_DATE)`; **snapshot-hash test proves two runs produce identical output**
- [ ] Counts within ±0 of the brief: 40 customers · 52 properties · 65 quotes · 30 projects · 6 suppliers · 45 products · 35 POs · 38 invoices · 110 project events · 75 site notes · 60 documents
- [ ] All 14 scenarios are present and looked up via `seed-manifest.json`; one test per scenario asserts it holds (e.g. exactly 2 overdue invoices as of the anchor)
- [ ] Fixtures for duplicate webhook, 429, timeout and invalid payload exist under `src/test/fixtures/`
- [ ] Every email is on a reserved domain (`example.com/.org/.net`); a test scans the seed for any other domain
- [ ] CSV contradictions P2–P6 are repaired; a test re-runs the audit script against generated data and finds zero issues
- [ ] Domain unit tests: money/GST rounding, every state machine (valid and invalid edges), permission matrix

## Phase 2: Module 1, Quote → Project

- [ ] `POST /api/events` validates the envelope (zod); rejects a missing field with 400 `VALIDATION_ERROR` and **no retry**
- [ ] Steps 1–13 implemented; each writes a `workflow_run_steps` row
- [ ] Idempotency key `quote.accepted:{quote}:v{version}`; claim/lease/takeover per architecture §6
- [ ] Same event twice → one project; the second response returns the same `project_id` and logs `webhook.duplicate_ignored`
- [ ] Different event, same business fact → one project
- [ ] Same key, different payload → rejected
- [ ] Two concurrent workers (real Postgres) → exactly one project, one checklist, one task, one outbox row per side effect
- [ ] Crash after claim (lease expiry) → the second worker takes over and completes
- [ ] Drive folder + PM notification via outbox, in mock mode; the UI labels them MOCK
- [ ] Friendly project number issued; customer/property attached (composite FK)
- [ ] Audit chain for the run: `quote.accepted` → `project.create` → `checklist.create` → `task.create` → `drive.folder_created` → `notify.sent`
- [ ] Seeded Q-2026-0031 appears as an open exception; RETRY completes it
- [ ] UI: Quotes list → "Mark accepted" → redirect to the new project (Playwright)

## Phase 3: Reliability laboratory

- [ ] Automation Health page shows, per workflow: last run, status, duration p50/p95, failure rate, retry count, exception count (definitions as in architecture §7)
- [ ] Demo controls: duplicate webhook · HTTP 429 · HTTP 500 · network timeout · invalid JSON · missing required field · external service unavailable · ambiguous write result
- [ ] 429: honours `Retry-After`; otherwise exponential backoff with jitter; the timeline shows each computed delay
- [ ] 500: bounded retries (max 5), then DEAD_LETTERED + exception
- [ ] Validation failures: 0 retries, immediate exception
- [ ] Ambiguous write: reconcile (GET by reference) **before** any retry; tests cover "found → no second POST" and "not found → retry"
- [ ] Exception queue: event ID, workflow, business record, error class, attempt count, created, last attempt, resolution status
- [ ] RETRY / MARK RESOLVED / VIEW EVENT; RETRY pressed twice → one re-run (test)
- [ ] Fault injection is refused when wrapping a REAL provider (test)
- [ ] Circuit breaker: opens after N consecutive failures, half-opens after a cool-down (test with a fake clock)

## Phase 4: AI Operations Copilot

- [ ] `LlmProvider` with Anthropic, OpenAI and Mock implementations; the Mock is deterministic and used in CI
- [ ] At least 10 GREEN tools, at least 4 AMBER, at least 4 RED, each with a zod schema, tier and required permission
- [ ] Tool list sent to the model is filtered by the user's role; execution re-checks permission (both tested)
- [ ] The model never sees credentials or SQL; tool results are capped and PII-minimised (test asserts no email/phone in results for non-contact tools)
- [ ] RED tool call → PENDING approval only; there is no code path from the model to execution (test: every RED tool handler returns an approval, never a mutation)
- [ ] Unauthorised RED attempt → `DENIED_PERMISSION` logged, no approval created
- [ ] Approve → re-validates state and `record_version` → executes once (idempotency key) → audited
- [ ] Reject → requires a reason → audited → nothing executed
- [ ] Stale approval (target changed after the request) → refused
- [ ] Answers show the underlying result table beside the explanation
- [ ] Demo prompts return sensible, grounded answers: "Which projects are at risk next week and why?" and "Draft a purchase order for the highest-risk project."

## Phase 5: Supplier quote → PO

- [ ] At least 6 synthetic supplier quote fixtures in inconsistent formats, covering: GST-inclusive, GST-exclusive, freight hidden in notes, description variants, 1 deliberate quantity error, 1 missing field
- [ ] Extraction via `LlmProvider` with a JSON schema; malformed model output → `EXTRACTION_FAILED`, no crash (test with a recorded bad output)
- [ ] Normalisation (ex-GST, units, freight) and all arithmetic done in code; mismatches flagged (test)
- [ ] Product matching: SKU → alias → fuzzy *suggestion* (never auto-accepted below the threshold)
- [ ] Comparison view: lowest landed cost · fastest delivery · best option meeting `required_by`
- [ ] Human review is required; the output is a DRAFT PO only; there is no auto-issue path (test)
- [ ] Duplicate "create PO from quote" → one PO (idempotency key)

## Phase 6: Xero integration

- [ ] `AccountingProvider` with `XeroMockProvider` (`MOCK_XERO=true`) and `XeroRealProvider`
- [ ] Real provider built from current official docs: OAuth2 code flow, `xero-tenant-id`, token refresh, `Idempotency-Key`, 429/`Retry-After`
- [ ] Workflow: invoice-ready → validate project → validate approved variations → draft → human approval → send → capture InvoiceID → update → audit → reconcile
- [ ] Over-invoice without an approved variation → blocked (seeded scenario)
- [ ] Integration identity = Xero IDs stored in `external_links`; never matched on names
- [ ] Duplicate send → one Xero invoice (mock test; plus an opt-in real test against the Demo Company)
- [ ] Ambiguous POST → reconcile by Reference before retrying, including when the key is older than 6 minutes (test with a fake clock)
- [ ] The UI clearly shows MOCK vs REAL for every synced invoice

## Phase 7: OpenTakeoff experiment (optional)

- [ ] Investigate `opentakeoff-mcp` (Kentucky-ai/opentakeoff, Apache-2.0, first seen 2026-09) for suitability; report back before building anything
- [ ] Load a public/sample plan; calibrate scale; measure area/length; record provenance (sheet, scale, points, who, when)
- [ ] Estimator approval is mandatory before anything becomes `material_requirements` (source = TAKEOFF)
- [ ] UI and docs state plainly: *assisted measurement, human-reviewed. Not an automatic estimate.*

## Demo readiness (after Phase 4, re-checked after Phase 6)

- [ ] `docs/demo-script.md`: 7 minutes, the 9 steps from the brief, with the exact records to use (from the seed manifest)
- [ ] Playwright runs the whole script end-to-end against a fresh seed in mock mode
- [ ] "SYNTHETIC DEMO DATA" banner on every page; integration mode badges visible
