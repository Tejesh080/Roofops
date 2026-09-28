# Architecture decision records

Short form: context → decision → consequence. **Status** is `Accepted` (my recommendation, reversible) or `Needs review` (your call before Phase 1).

---

### ADR-001: Postgres is the system of record; n8n orchestrates but never writes the DB
**Status:** Accepted
**Context:** n8n can talk to Postgres directly, but then validation, idempotency and audit would be duplicated across the Next.js app and n8n.
**Decision:** n8n calls signed RoofOps command endpoints. Business invariants live in one codebase.
**Consequence:** n8n workflows stay thin and replaceable. The demo runs without n8n (`WORKFLOW_RUNNER=local`).

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

### ADR-006: Airtable is a downstream mirror
**Status:** ⚠ Needs review
**Context:** Many growing trades businesses already run operations in Airtable. If the target company does, "Postgres as the system of record" may look like it ignores their reality.
**Decision (proposed):** a one-way mirror (RoofOps → Airtable), keyed on a hidden `roofops_id`. For the interview story: *"Stage 1: keep Airtable as the team's UI and mirror into it. Stage 2: move the invariants that Airtable can't enforce (uniqueness, idempotency, audit) into a real database behind the same Airtable views."*
**Alternative:** implement an `AirtableRepository` so Airtable *is* the store. This is weaker on constraints and much slower to build.

### ADR-007: Text + CHECK instead of Postgres ENUM types
**Status:** Accepted. Easier to evolve in forward-only migrations; the same safety at write time.

### ADR-008: RLS on, no policies; all access server-side
**Status:** Accepted
**Consequence:** the browser can never query tables directly, even with the anon key. A real multi-tenant product would need policies; this internal tool doesn't.

### ADR-009: Test DB = PGlite by default, real Postgres for concurrency tests
**Status:** Accepted
**Context:** PGlite runs Postgres 18 in-process (fast, no Docker), but has a single connection.
**Decision:** most integration tests run on PGlite. The "two workers, same event" test runs against Supabase local in Docker (Docker 29 is available on this machine).

### ADR-010: Demo dates re-anchored to the day the seed runs
**Status:** ⚠ Needs review (D-1 in data-audit)
**Decision (proposed):** keep CSV identities and scenarios; regenerate dates relative to `DEMO_ANCHOR_DATE`.
**Consequence:** "at risk next week" is true on the day of the interview. Tests pin the anchor, so they stay deterministic.

### ADR-011: LLM default provider
**Status:** ⚠ Needs review
**Proposed:** `LLM_PROVIDER=anthropic` (model configurable, e.g. `claude-sonnet-5` for speed and cost in live demos), with `openai` supported behind the same interface. `mock` is the default in CI and whenever no key is present.

### ADR-012: Package manager and runtime
**Status:** Accepted. Node 24 LTS + npm 11 (installed). pnpm isn't installed, and adding it gains nothing for a single app.
