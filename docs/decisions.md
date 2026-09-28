# Architecture decision records

Short form: context → decision → consequence. **Status** is `Accepted` (my recommendation, reversible) or `Needs review` (your call before the next phase).

---

### ADR-001: Invariants live in one place; n8n orchestrates but never bypasses them
**Status:** Accepted in principle · ⚠ mechanism to decide in Phase 2
**Context:** Postgres is the control layer (ADR-006). If n8n writes tables with ad-hoc SQL, validation, idempotency and audit get duplicated in workflow nodes.
**Decision:** n8n never issues raw INSERT/UPDATE against business tables. It invokes one guarded entry point per command.
**Phase 2 choice:**
(a) **Postgres functions** such as `create_project_from_quote(event jsonb)`, called from n8n's Postgres node. The idempotency claim, project creation, task and audit happen in one DB transaction. No API server is needed yet, and the invariants sit next to the constraints they rely on.
(b) **A RoofOps HTTP command API** (Next.js route handlers) called by n8n. This needs the app server.
I recommend (a) for Phase 2, since it matches your flow ("Postgres idempotency check → create Project"), with the same functions later exposed through (b) for the UI.

### ADR-002: Idempotency key = business fact, not event ID
**Status:** Accepted
**Decision:** `quote.accepted:{quote_id}:v{version}`. The event ID is still recorded, for tracing.
**Consequence:** catches semantic duplicates (a double-click, two emitters), not just transport duplicates. Backed by `projects.quote_id UNIQUE`.

### ADR-003: Side effects through a transactional outbox
**Status:** Accepted
**Decision:** Drive, notification and Xero calls are written as `outbox` rows inside the business transaction and dispatched afterwards with their own idempotency keys.
**Consequence:** no orphan folders when the transaction rolls back; no lost notifications when the process crashes after commit. Costs a dispatcher loop (a cron route, or n8n polling).

### ADR-004: Derived facts are views, not columns
**Status:** Accepted
**Decision:** schedule risk, overdue, outstanding and conversion rate are computed.
**Consequence:** they can't go stale (see data-audit P1). There is slight query cost, which is irrelevant at this scale.

### ADR-005: Arithmetic in the database and in code, never in the LLM
**Status:** Accepted
**Decision:** line totals are GENERATED columns; header totals are derived by trigger; values supplied for them are overwritten. Supplier-quote extraction stores the model output *and* the code-computed values side by side.
**Consequence:** a hallucinated total can't persist. Mismatches become visible review items.

### ADR-006: Airtable is the staff-facing operations layer; Postgres is the control layer
**Status:** Accepted (directed by the user, Phase 1). Supersedes "Airtable as a downstream mirror".
**Target architecture:** Airtable → staff-facing operations · Postgres → system/control layer (idempotency, audit, exceptions, derived risk) · n8n → orchestration · Xero → accounting source of truth · Google Drive → document store · AI Copilot → conversational interface over tools.
**Consequence:** staff keep working in Airtable. Airtable changes (e.g. a quote marked Accepted) arrive as events. Postgres enforces what Airtable cannot (uniqueness, idempotency, append-only audit) and writes outcomes back to Airtable, keyed on Airtable record IDs stored in `external_links`, never on names. Nothing is uploaded to Airtable until Phase 2.

### ADR-007: Text + CHECK instead of Postgres ENUM types
**Status:** Accepted. Easier to evolve in forward-only migrations; the same safety at write time.

### ADR-008: RLS on, no policies; all access server-side
**Status:** Accepted
**Consequence:** the browser can never query tables directly, even with the anon key. A real multi-tenant product would need policies; this internal tool doesn't.

### ADR-009: Tests run on PGlite and on real Postgres 17
**Status:** Accepted
**Context:** PGlite runs Postgres 18 in-process (fast, no Docker), but has a single connection. Supabase runs Postgres 17.
**Decision:** every DB suite runs on PGlite by default and, with `TEST_DATABASE_URL` set, also on real Postgres 17 (docker compose). Each Postgres test gets its own throwaway database. The Phase 2 concurrency test ("two workers, same event") will be Postgres-only.

### ADR-010: Canonical bundle, dates normalised to a fixed DEMO_DATE
**Status:** Accepted (directed by the user, Phase 1)
**Decision:** the normalised CSVs in the synthetic data bundle are canonical. IDs, names, amounts, relationships and planted scenarios are never regenerated. Only dates are normalised, by logged rules, relative to the fixed `DEMO_DATE = 2026-09-29`. The database's `app_today()` is pinned to that date (`app_settings.business_date_override`).
**Consequence:** "overdue" and "next week" stay true whenever the demo is presented. Removing the override switches to the real Brisbane date.

### ADR-011: LLM default provider
**Status:** ⚠ Needs review
**Proposed:** `LLM_PROVIDER=anthropic` (model configurable, e.g. `claude-sonnet-5` for speed and cost in live demos), with `openai` supported behind the same interface. `mock` is the default in CI and whenever no key is present.

### ADR-012: Package manager and runtime
**Status:** Accepted. Node 24 LTS + npm 11 (installed). pnpm isn't installed, and adding it gains nothing for a single app.

### ADR-013: GST basis recorded per document (Xero's LineAmountTypes model)
**Status:** ⚠ Needs review
**Context:** the bundle's amounts don't say whether they include GST, and converting inclusive ⇄ exclusive at 10% can shift a cent.
**Decision:** every quote version, PO and invoice stores `line_amount_type` (EXCLUSIVE | INCLUSIVE | NO_TAX). The source amount is stored exactly as the line amount and the database derives the GST split. Customer quotes and invoices are treated as INCLUSIVE (Australian Consumer Law single-price rule for consumers); supplier POs and prices as EXCLUSIVE (trade convention).
**Consequence:** no amount changes by even a cent (tested). Maps directly onto Xero's `LineAmountTypes` in Phase 6. If the business treats amounts differently, the basis changes and the amounts stay the same.

### ADR-014: The Phase 0 schema was amended in place, before its first apply
**Status:** Accepted
**Context:** loading real data exposed design gaps (GST basis, business dates vs row timestamps, source-ID columns, legacy approval metadata).
**Decision:** because the migration had never been applied to any shared environment, it was edited directly rather than patched with ALTERs. From now on migrations are forward-only; `schema_migrations` stores a checksum, and a modified, already-applied migration is refused.

### ADR-015: `record_origin = 'IMPORT'` for legacy records
**Status:** Accepted
**Decision:** imported POs, invoices, exceptions and ledger rows are marked IMPORT and exempted from approval/resolver metadata they cannot have. Records RoofOps creates must satisfy the full CHECKs.
**Consequence:** no fake approvers are invented, and the exemption is visible and queryable rather than silent.

### ADR-016: Staging layer keeps the source verbatim
**Status:** Accepted
**Decision:** `staging.*` holds every source column as text. Columns the core model derives instead of storing (`materials_status`, `schedule_risk`, `edge_case_tags`) remain queryable for lineage.

### ADR-017: TypeScript 6.0 (not 7.0)
**Status:** Accepted. TypeScript 7.0 (the native compiler) is out, but typescript-eslint 8.70 supports `<6.1`. Pinned to 6.0.3 until lint tooling catches up.
