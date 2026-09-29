# Phase 6: tool evaluation (done before installing anything)

Each candidate was checked against its current official docs or repository (September 2026) and against **the problems RoofOps
actually has**, which the audit found:

- **P1:** staff edits in Airtable to fields other than Quote Status and Invoice Action are never captured (the PRJ-2026-0001 bug).
- **P2:** there is no explicit, enforced state machine outside the individual `wf_*` functions.
- **P3:** nothing detects drift after a missed or expired webhook.
- **P4:** there is no health view.
- **P5:** the Copilot's factual behaviour is only smoke-tested.

The constraints are real ones:

- n8n **Cloud** (no community nodes except verified ones).
- Airtable **Free plan**: 1,000 API calls per workspace per month, and 5 requests per second (Airtable support article *Managing API call limits*).
- Postgres is the source of truth and must enforce invariants even if application code is bypassed.
- This is an interview system, not a rewrite.

## Summary

| Tool | Verdict | One-line reason |
|---|---|---|
| **Promptfoo** | **ADOPT NOW** (dev-only, via `npx`, no runtime dependency) | Structured, repeatable assertions on the live Copilot, plus red-team/injection cases. No service, no data leaves except to our own API. |
| XState | **REJECT for current RoofOps** | The legal transitions must live in Postgres (triggers) anyway. A second definition in TypeScript would drift. Tests are generated from the SQL transition table instead. |
| Hookdeck (+ `@hookdeck/n8n-nodes-hookdeck`) | **STUDY / LATER** | Genuine durable-inbound benefits, but the n8n node is self-hosted-only today (n8n Cloud accepts verified nodes only; verification pending). Airtable pings carry no data and Airtable already stores payloads for 7 days behind our cursor. It would need a new account and service for little gain now. |
| Nango | **REJECT for current RoofOps** | Free self-hosting is auth + proxy only; syncs, webhooks and triggers need Nango Cloud or Enterprise. A records sync would still need our own reconciliation rules, cost more Airtable API calls on a 1,000/month plan, and add a multi-service platform. |
| Restate | **REJECT for current RoofOps** (STUDY for a rewrite) | Keyed virtual objects (single writer per key) are elegant, but a Postgres row lock per project already gives single-writer semantics inside the transaction that also enforces the invariants. It adds a server, a new runtime and a migration of working flows. |
| DBOS Transact | **STUDY / LATER** | Closest fit (Postgres-backed durable workflows and queues as a library). But our orchestration is n8n, and processed_events + outbox + claims + dead-letter already give the guarantees. Worth it if orchestration moves from n8n into TypeScript. |
| EventCatalog | **STUDY / LATER** | Good for documenting events and ownership at scale. For about 30 events and 6 tables, a generated machine-readable contract (`docs/source-of-truth.json`, generated from the database) is smaller and cannot go stale. |

What RoofOps adopts instead, as the **smallest architecture with strong guarantees**:

```
existing RoofOps
+ state machines as data in Postgres (state_transitions) enforced by triggers, used by every wf_* path and by generated tests
+ one generic Airtable change capture (new base-wide webhook → n8n 06 → wf_airtable_change, same validation for every table)
+ reconciliation (n8n 07 → wf_reconcile_*) that replays missed edits through the same validation and repairs read-only drift
+ synthetic health checks (n8n 08) + System Health page + npm run integrity:check
+ Promptfoo regression suite for the Copilot
```

---

## Promptfoo: ADOPT NOW (dev tooling only)

1. **Problem solved:** P5. The Copilot must never contradict tool data (status, amounts, readiness), never fabricate IDs, never leak secrets, and never approve, send or pay. Today `scripts/copilot-smoke.ts` checks six questions with substring matching.
2. **Replaces:** it complements rather than replaces the vitest tool tests. It supersedes ad-hoc smoke assertions with a declarative suite, repeat runs and a report.
3. **New service?** No. It is a CLI run with `npx promptfoo@latest eval`. MIT licence (Promptfoo is now part of OpenAI and remains MIT, per its GitHub README). A custom HTTP/JS provider calls **our own** `/api/copilot` with a locally signed session, so assertions see the real tool steps, cards and answer.
4. **Correctness:** high value. Assertions are deterministic JavaScript over structured output (tools called, cards, amounts in the DB-sourced card), and LLM grading is not relied on.
5. **Observability:** a per-case pass/fail matrix and a saved history of runs.
6. **Demo complexity:** none (not part of the runtime).
7. **Migration risk:** none. **Decision:** adopt now.

## XState v5: REJECT (for now)

1. **Problem:** P2 (explicit legal transitions), plus model-based test generation (`@xstate/graph` shortest paths, per the Stately docs).
2. **Replaces:** nothing in the database. The invariants must be enforced by Postgres even when code is bypassed, which XState in Node cannot do.
3. **New service?** No, but a second source of truth for the same rules.
4. **Correctness:** negative if duplicated. A TS machine and SQL checks can disagree.
5. **Observability:** a nice visualiser, but the transition table in SQL is also browsable, and it is exported to `docs/state-machines.md`.
6. **Demo:** neutral. 7. **Risk:** low, but no benefit.
8. **Decision:** reject. The SQL `state_transitions` table is the single definition. Triggers enforce it, and the vitest suite generates every valid/invalid pair from it (the "test generation" benefit, without the duplication). Revisit if the dashboard ever edits multi-step workflows client-side.

## Hookdeck Event Gateway: STUDY / LATER

1. **Problem:** durable inbound webhooks (queue while n8n is down, retries up to 50, dedupe window, signature verification, delivery logs and replay), per the official `@hookdeck/n8n-nodes-hookdeck` README.
2. **Replaces:** little. Airtable pings contain only `{base, webhook, timestamp}`. The data lives in Airtable's payload store for about 7 days behind our durable cursor, so a lost ping loses no data. It only delays the fetch until the next ping or the next reconciliation.
3. **New service?** Yes: a Hookdeck account and project, a new credential, and a new ingress URL. The node **"runs on self-hosted n8n"** until n8n verifies it. We are on n8n Cloud, so only the plain Webhook node pointed at a Hookdeck source would work.
4. **Correctness:** small gain for us. Business idempotency (processed_events) and the cursor already make redelivery harmless.
5. **Observability:** a real gain (delivery logs).
6. **Demo:** adds a hop to explain.
7. **Risk:** low to medium (URL change on three webhooks, account signup is an interactive credential action).
8. **Decision:** later. The gap it would close ("n8n down → ping lost") is closed more cheaply by the daily **drain** step in reconciliation, which self-pings each consumer so payloads since the cursor are fetched.

## Nango: REJECT (for current RoofOps)

1. **Problem:** Airtable auth, proxy, pre-built `records` sync and webhook actions (Nango Airtable docs list `records` / `webhooks` syncs and `create-webhook` / `refresh-webhook` / `list-webhook-payloads` actions).
2. **Replaces:** webhook create/refresh (small) and possibly polling.
3. **New service?** Yes, and a big one. **Free self-hosting = Auth + Proxy only; Syncs, Webhooks and Triggers are "No"** (Nango self-hosting docs). Full features need Nango Cloud or Enterprise, with 5 Node services + Postgres + Redis + Elasticsearch + object storage.
4. **Correctness:** a generic records sync mirrors data but does not know RoofOps ownership rules, legal transitions or which side wins. We would still write the reconciliation logic. Polling syncs would also exhaust the Airtable Free plan quota.
5. **Observability:** good logs, but for a system we would not otherwise need.
6. **Demo:** more to explain. 7. **Risk:** high (new platform, OAuth app registration).
8. **Decision:** reject. **Do not migrate Xero** (it already works and is verified). Reconsider only if RoofOps becomes multi-tenant, with many customer-owned Airtable bases needing OAuth.

## Restate: REJECT (current), STUDY (future rewrite)

1. **Problem:** single-writer per key (virtual objects), durable steps and exactly-once-style RPC. For example, `Project["PRJ-2026-0001"]` would serialise commands.
2. **Replaces:** in theory processed_events, claims, retries and outbox.
3. **New service?** Yes. A Rust server with its own durable log, plus moving handlers out of n8n and Postgres into TS services.
4. **Correctness:** equal, not better, for our need. Serialisation per project is achieved by `SELECT … FOR UPDATE` on the project row inside the same transaction that validates and writes. That is strictly stronger for invariants, because Restate state would not be the Postgres row.
5. **Observability:** a good UI, but a second place to look.
6. **Demo:** substantially more complex. 7. **Risk:** high (rewrite of working, tested flows).
8. **Decision:** reject.

## DBOS Transact: STUDY / LATER

1. **Problem:** Postgres-checkpointed durable workflows, durable queues with dedupe, rate limits and recovery (dbos-transact-ts README).
2. **Replaces:** processed_events, outbox, claim/complete/fail and dead-letter, if orchestration moved from n8n to TypeScript.
3. **New service?** No server (it is a library on our Postgres), but it needs a long-running Node worker, which we do not have (n8n Cloud + a Next.js app on Vercel).
4. **Correctness:** equivalent to what we built and proved (duplicate, retry, dead-letter and recovery tests). No uncovered gap.
5. **Observability:** workflow history tables, similar to our workflow_runs/steps.
6. **Demo:** neutral. 7. **Risk:** medium to high (re-platforming the orchestration).
8. **Decision:** later. It is the first candidate if n8n were replaced by code.

## EventCatalog: STUDY / LATER

1. **Problem:** documenting domains, services, events, schemas and owners in a browsable catalog.
2. **Replaces:** hand-written docs.
3. **New service?** A static site generator (docs only).
4. **Correctness:** none by itself.
5. **Observability:** documentation only.
6. **Demo:** harmless but off-topic.
7. **Risk:** low.
8. **Decision:** later. The ownership contract is **executable** here: the `field_contract` table drives change capture and reconciliation and is exported to `docs/source-of-truth.json` / `.md`, so it cannot drift from behaviour.

---

## Outcome (after implementation)

- **Promptfoo** was adopted as planned: `npm run ai:eval`, pinned `promptfoo@0.123.1`, 13/13 on the live Copilot.
- **Nothing else was installed.** The chosen architecture above was built as described: migrations 1200–1600, n8n 06/07/08, `/health`.
- The gap Hookdeck would have closed ("n8n down → ping lost") was verified live without it. 06 was unpublished during a real staff edit; Airtable's retry and the durable cursor delivered the change once 06 was back. The nightly drain step covers the case where Airtable stops retrying.
