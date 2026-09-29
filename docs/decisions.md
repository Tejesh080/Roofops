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

### ADR-018: Real integrations only; no mock providers
**Status:** Accepted (user direction, after Phase 1)
**Decision:** every integration calls the real service. There are no mock providers or simulated success responses. If a service is unavailable, the capability is reported **BLOCKED**. Every external side effect is created, then read back independently, then verified before anything records it (`wf_complete_side_effect` requires `verified: true`; `external_links.verified_at`).
**Consequence:** the Phase 0 mock-adapter design (§4 of the old architecture) is withdrawn. Placeholder IDs from the bundle were removed from the core model (migration 300). Tests of external behaviour are end-to-end against live services.

### ADR-019: Hosted control layer on Supabase; n8n Cloud; local Docker for development only
**Status:** Accepted (user direction)
**Decision:** the live environment is Supabase Postgres 17 (Sydney, session pooler, TLS) plus a dedicated n8n Cloud workspace. Local Docker Postgres is used only for development and automated tests. The local database is never exposed via tunnels.

### ADR-020: n8n reaches Postgres only through SECURITY DEFINER entry points (resolves ADR-001)
**Status:** Accepted
**Decision:** n8n's database login (`roofops_n8n`) is a member of `roofops_workflow`, which holds EXECUTE on exactly four functions and no table privileges. The functions have a pinned `search_path` and do all validation, idempotency and audit writing in one transaction.
**Consequence:** a leaked n8n DB credential cannot read customer data or forge audit rows (verified by connecting as the role).

### ADR-021: Global default privileges for functions
**Status:** Accepted (found by the hosted exposure test)
**Context:** Postgres grants EXECUTE on new functions to PUBLIC, and per-schema `ALTER DEFAULT PRIVILEGES … REVOKE` cannot remove a global default. So the Supabase `anon` role could execute new functions.
**Decision:** revoke globally (`ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`) and assert in every environment that no public-schema function grants EXECUTE to PUBLIC.

### ADR-022: Airtable webhook + durable Postgres cursor, not polling
**Status:** Accepted (Phase 2)
**Decision:** Airtable pushes a data-less ping; n8n fetches the payloads itself with its own credential, starting from a cursor kept in Postgres (`integration_cursors`, advanced monotonically by `wf_airtable_cursor_advance`). The webhook watches `Quotes.Status` only, so the workflow's own Automation Status writes never re-trigger it. `00 Setup` refreshes the webhook daily (Airtable expires webhooks after 7 days).
**Consequence:** ~5 Airtable calls per acceptance and none while idle (the free plan allows 1,000 a month). Pings are not HMAC-verified: a forged ping can only cause an extra read. Overlapping pings read overlapping payloads, and idempotency absorbs that (proven live, ADR-025).

### ADR-023: Event id comes from the Airtable transaction
**Status:** Accepted
**Decision:** `event_id = airtable:{webhook}:txn{baseTransactionNumber}:{recordId}`. A redelivery or replay of the same Airtable change is a transport duplicate; a new status change is a new event, and the business key `quote.accepted:Q:vN` catches it as a semantic duplicate.

### ADR-024: Side effects are sub-workflows with a Postgres-owned retry loop
**Status:** Accepted
**Decision:** `02 Drive` and `03 Airtable` each process one project: claim → act → read back → prove. Failures are classified in n8n (HTTP status → error class) and handed to `wf_fail_side_effect`, which owns the backoff (1, 2, 4, 8 s, or Retry-After) and the attempt limit. The Airtable write-back cannot be claimed until the Drive folder is verified, and the claim hands it the verified folder.
**Consequence:** retry policy lives in one place (Postgres); n8n holds no retry state. The final attempt is recorded as an event and an exception, not as a run step (known gap).

### ADR-025: Status write-back tolerates concurrent deliveries (found live)
**Status:** Accepted
**Context:** two overlapping pings delivered the same fact; each wrote a message with its own delivery count, and the loser's read-back failed.
**Decision:** the quote status message is deterministic per business fact. The read-back accepts a different value only if it is a non-failure state about the same project, and says so (`superseded_by_concurrent_delivery`). A mismatch involving Rejected or Failed still fails the execution.

### ADR-026: One exception per rejected business fact (found live)
**Status:** Accepted (migration 700)
**Decision:** a rejection for the same quote, class and reason reuses the open exception (`attempt_count` increases) instead of opening a new one per delivery. Duplicates created before the fix were folded into the original with an audit row; nothing was deleted.

### ADR-027: Machine resolutions name a system actor
**Status:** Accepted (migration 700)
**Context:** the CHECK on `workflow_exceptions` demanded an employee on every RESOLVED exception, so the workflow's auto-resolve (side effect succeeds after an exception) would have aborted completion. Found while fixing ADR-026, before it could happen live.
**Decision:** `resolved_by_system` (e.g. `workflow:quote_to_project`). A resolution names an employee or a system actor, never neither. Proven live on EXC-0015.

### ADR-028: Real, reversible fault injection for retry tests
**Status:** Accepted (test tooling)
**Decision:** transient failures are produced by moving the real Drive root to trash (`[RoofOps] 97`, manual only, never published) rather than by mocks, flags in production code, or breaking credentials. The Drive step gets a genuine "not available" answer and the system's real retry path runs. `00 Setup` never re-creates a root that is only in the trash.

### ADR-029: Xero draft invoices need an approved, hashed preview and are idempotent in Postgres
**Status:** Accepted (migration 800)
**Decision:** invoicing is two events. *Prepare* computes the amount in SQL (quote inc GST + approved variations − already billed, GST = amount/11, INCLUSIVE) and stores the preview with a hash in `approvals`. *Approve* re-derives the preview and refuses it if the hash changed (stale → `CANCELLED`), if the approver is not a mapped FINANCE/ADMIN/OPERATIONS_MANAGER employee, or if no Demo tenant is pinned. It then creates the one FINAL invoice (UNIQUE `invoice:final:<project>`) and one outbox row in the same transaction. The decision is keyed `invoice.decision:<APR>`, so a redelivered or new Approve event for the same approval is a duplicate. `05` searches Xero by invoice number and by reference **before** every create; it adopts a matching DRAFT from an earlier ambiguous attempt and refuses anything else. A timeout marks the invoice `UNKNOWN`, never "failed, try again". Xero's `Idempotency-Key` is only a second line of defence.
**Consequence:** a project can never produce two RoofOps invoices, and a lost Xero response cannot produce two Xero invoices. Postgres records Xero IDs only from read-back proof (pinned tenant, DEMO class, DRAFT, ACCREC, unpaid, unsent, exact total/tax/reference/contact, exactly one match).

### ADR-030: Xero writes are pinned to one proven Demo Company tenant
**Status:** Accepted
**Context:** the first `RoofOps Xero` connection was to a real organisation. The read-only check caught it before anything was read or written.
**Decision:** `xero.demo_tenant_id` is empty by default (no writes possible). An operator pins it with `ops/pin-xero-demo-tenant.sql` only after `[RoofOps] 96` proves the single connection is `Class=DEMO`. The pin is audited, and the script refuses to re-point an existing pin. `05` re-checks the connection and `Class=DEMO` on every run, and `wf_complete_side_effect` rejects proof from any other tenant.

### ADR-031: Duplicate outcomes report the invoice's verified state (found live)
**Status:** Accepted (migration 900)
**Context:** replaying the Approve event for PRJ-2026-0004 was correctly ignored, but `04` wrote Invoice Status "Duplicate ignored", overwriting "Xero draft created".
**Decision:** `wf_invoice_prepare`/`wf_invoice_decide` wrap the unchanged migration-800 logic (renamed `*_core`, not callable by n8n) and add `xero_state` (verified external links, sync status, Xero number) to `ALREADY_INVOICED`/`ALREADY_PROCESSED`. `04` then keeps "Xero draft created" with the real IDs and says the duplicate was ignored in the preview text.

### ADR-032: The dashboard reads curated views through its own least-privilege role
**Status:** Accepted (migrations 1000, 1100)
**Decision:** the web server connects as `roofops_web` (member of `roofops_dashboard`). It has `SELECT` on the `v_dashboard_*` views plus `v_purchase_order_status` and `v_invoice_balances`, and `EXECUTE` on `wf_invoice_prepare` (the preview-only entry point n8n uses). It has no table access and no other workflow function. Business rules stay in SQL: "ready to invoice" is `invoice_final_preview`'s own verdict, and "awaiting materials" and "at risk" come from the existing views, so the table, headline numbers and copilot always agree.
**Consequence:** the frontend holds no business state and can't drift from the workflows. A compromised web server could read the dashboard and ask for a preview, but could never approve, invoice or write.

### ADR-033: Copilot tools are named, tiered and server-side
**Status:** Accepted
**Decision:** DeepSeek gets only tool results from seven named functions, never SQL or credentials. GREEN tools read. AMBER `prepare_invoice` creates a preview only, and only when the user explicitly asks. RED actions (approve, send, pay) are not exposed: approval stays with a finance approver in the existing Airtable → n8n → Xero flow. The invoice preview shown to the user is a structured card from the database, not model text.

### ADR-034: Interview-demo authentication: signed session, verified everywhere
**Status:** Accepted
**Decision:** a single demo login (`DEMO_USERNAME`/`DEMO_PASSWORD`, constant-time comparison, throttled) issues an HMAC-signed, HttpOnly session cookie (`AUTH_SECRET`). The proxy gates every route, and each page and the copilot API re-verify the session themselves, so a proxy bypass exposes nothing. Missing configuration fails closed.
**Consequence:** safe enough to put the demo on a public URL. Not a user system: per-person accounts would replace it for real use.

### ADR-035: Demo reset only reverses what is fully internal
**Status:** Accepted
**Decision:** `npm run demo:reset` only withdraws *pending* invoice previews on the designated demo project (PENDING → CANCELLED, audited, idempotent). Anything that reached an external system (Airtable records, Drive folders, Xero drafts) is never deleted: those scenarios are reported as ALREADY RUN, or rehearsed with the next unused synthetic quote, by `npm run demo:status`.

### ADR-036: State machines are data in Postgres, enforced by triggers
**Status:** Accepted (migration 1200)
**Context:** legal status changes were implicit in each `wf_*` function; a direct SQL update could set anything (PRJ-2026-0001 showed how far Airtable and RoofOps could drift apart).
**Decision:** `state_machine_states` / `state_transitions` define 10 machines (project, quote, purchase order, invoice, invoice sync, approval, workflow exception, task, checklist item, outbox). One trigger function, `enforce_state_machine()`, refuses any other change on the real tables with a `check_violation`; `project_transition_guard()` adds business guards (e.g. Completed → Cancelled only while no final invoice exists). Tests are generated from the same rows. XState was evaluated and rejected: a second definition in TypeScript could disagree with the one the database enforces.
**Consequence:** Cancelled and Closed are terminal; reopening means a new job. Even an operator's SQL can't create an illegal state.

### ADR-037: One validated entry point for every Airtable edit, driven by an ownership contract
**Status:** Accepted (migrations 1200, 1300; n8n 06)
**Decision:** a base-wide Airtable webhook (all cell values plus previous values) feeds n8n 06, which calls `wf_airtable_change` once per changed record, in transaction order. The function:
- identifies the record by its recorded Airtable link, never by name, and locks the row;
- is idempotent per Airtable transaction;
- ignores changes older than the last applied one (stale);
- refuses an edit made against a value RoofOps no longer holds (compare-and-set: no last-write-wins);
- then acts by the field's owner in `field_contract`: apply through the entity handler (state machine and guards), revert, or defer (quote acceptance stays with n8n 01).

It returns the exact Airtable corrections (including a RoofOps Sync note). n8n writes them, reads them back, and records the proof. Unverified corrections are re-issued on redelivery, recomputed from canonical state.
**Consequence:** Airtable is an editing surface, never a second source of truth. 01 and 04 are unchanged.

### ADR-038: Reconciliation replays, never picks a winner
**Status:** Accepted (migrations 1200, 1500; n8n 07)
**Decision:** nightly, and on demand (`npm run reconcile`, token-gated, hash stored in Postgres), n8n 07 reads every Airtable table and checks every verified Drive folder and Xero draft (read-only, pinned Demo tenant). Drift is handled by ownership:
- a missed staff edit is replayed through `wf_airtable_change`, so the same rules apply;
- RoofOps-owned drift is written back and verified;
- anything ambiguous or missing becomes a named exception (`REQUIRES_HUMAN`, `EXTERNAL_MISSING`, `UNKNOWN`).

Observe mode records findings without changing anything. The same run refreshes expiring webhooks, re-creates a missing one, and wakes any consumer with unread payloads.
**Consequence:** a lost webhook costs latency, not data. Airtable Free-plan cost is about 8 API calls per run.

### ADR-039: Health and freshness come only from recorded checks
**Status:** Accepted (migrations 1200, 1400, 1600; n8n 08)
**Decision:**
- n8n 08, every 30 minutes, runs safe reads against Drive, Xero and DeepSeek. Xero only counts as healthy when the pinned Demo tenant is connected.
- 07 records Airtable and webhook health nightly.
- `/health` derives states from those records. A service that hasn't been checked within its interval is **Unknown**, never Healthy.
- Every Copilot tool result carries `_meta` (canonical source, read time, last reconciliation, verified). When Airtable was last seen disagreeing, the Copilot states both values, RoofOps first, and doesn't choose.

### ADR-040: AI regression is deterministic and grounded in the database
**Status:** Accepted
**Decision:** Promptfoo (dev-only, pinned, telemetry and sharing off) runs the real `/api/copilot`. JavaScript assertions check the structured output (tools, tiers, cards) against ground truth read from Postgres at run time: exact status, exact ready-to-invoice list, no unknown identifiers or amounts, no SQL, no secret values, and refusals for approve/send/pay. No model grades the model.
