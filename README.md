# RoofOps

**An operations and automation platform for a fictional Australian roofing contractor. Portfolio/interview project.**

> ⚠ **SYNTHETIC DEMO DATA, REAL INTEGRATIONS.** Every customer, supplier, address and amount is fictional. Every integration is a real service (Supabase, Airtable, n8n Cloud, Google Drive, Xero Demo Company, DeepSeek); anything not connected is reported **BLOCKED**, never simulated.

RoofOps models the full job lifecycle (lead → quote → project → purchasing → field work → invoice → payment). Its focus is the parts that break in real operations: duplicate webhooks, rate limits, ambiguous writes, AI that may read but must not move money without approval, and an audit trail you can prove hasn't been edited.

## Target architecture

| Layer | System |
|---|---|
| Staff-facing operations | Airtable |
| System / control layer | Postgres (Supabase) |
| Workflow orchestration | n8n |
| Accounting source of truth | Xero |
| Document store | Google Drive |
| Conversational interface | AI Copilot (tool calling) |

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Architecture, schema, acceptance criteria | ✅ |
| 1 | Database + canonical data import (dates normalised to 2026-09-29) | ✅ awaiting review |
| 2 | Airtable Quote Accepted → n8n → Postgres → Project → Drive → audit → Airtable | ✅ live and verified, awaiting review ([status](docs/phase2-status.md)) |
| 3 | Approved project → **Xero Demo Company DRAFT invoice** (approval, persistent idempotency, read-back) | ✅ live and verified, awaiting review ([status](docs/phase3-status.md)) |
| 4 | **Operations Dashboard + DeepSeek Operations Copilot** (`web/`, http://127.0.0.1:3000) | ✅ working, awaiting review ([status](docs/phase4-status.md)) |
| 4b | **UI polish, interview readiness, auth, demo reset, Vercel-ready** | ✅ awaiting review ([status](docs/phase5-status.md), [demo sequence](docs/phase5-status.md#7-minute-interview-sequence)) |
| 6 | **State integrity, reconciliation, System Health, AI regression** (every Airtable edit validated; drift repaired or escalated) | ✅ live and verified ([status](docs/phase6-status.md), [ownership map](docs/system-ownership-map.md)) |
| 5 | Supplier quote → PO | ⏳ |
| — | Reliability lab + exception queue UI | partly delivered by Phase 6 (`/health`, reconciliation) |
| 7 | OpenTakeoff experiment (optional) | ⏳ |

## Run it

Requires Node 24 and Docker.

```bash
npm install
```

```bash
npm run db:up
```

```bash
npm run db:load
```

```bash
npm run check
```

`db:load` applies migrations and imports `data/normalised/` into Postgres 17 at `127.0.0.1:54322/roofops`; running it again is a no-op. `db:reset` rebuilds a local database from scratch. `npm test` runs on in-process PGlite; to also run every database suite against real Postgres:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test
```

After changing a date rule, regenerate and re-verify the normalised data:

```bash
npm run data:normalise
```

## Operate it (hosted)

| Command | Purpose |
|---|---|
| `npm run integrity:check` | executable business rules: PASS / WARNING / FAIL per entity |
| `npm run reconcile` (`-- --dry-run`) | Airtable / Drive / Xero ↔ Postgres check and repair via n8n 07 |
| `npm run demo:status` / `demo:reset` | interview scenarios |
| `npm run security:check` | database privilege audit |
| `npm run ai:eval` | Copilot regression (Promptfoo; web app running) |
| `npm run contract:export` | regenerate [source-of-truth](docs/source-of-truth.md) and [state machines](docs/state-machines.md) |

## Layout

```
data/raw/                 canonical synthetic bundle, verbatim
data/normalised/          dates normalised + change log + scenario manifest + hashes
supabase/migrations/      schema (core, staging/import, operational views)
src/normalise/            date rules, invariants, scenario manifest
src/import/               importer + transform.sql (staging -> core)
src/db/                   PGlite/Postgres port, migration runner
src/events/               event envelope contract (zod)
test/                     Vitest suites + fixtures (webhooks, HTTP failures)
docs/                     architecture, data model, import, decisions, acceptance criteria
```

## Read in this order

1. [docs/architecture.md](docs/architecture.md)
2. [docs/data-import.md](docs/data-import.md): how the bundle was loaded, every date rule, known source discrepancies
3. [docs/data-model.md](docs/data-model.md)
4. [docs/acceptance-criteria.md](docs/acceptance-criteria.md)
5. [docs/decisions.md](docs/decisions.md): ADRs; the open ones are marked ⚠
6. [docs/data-audit.md](docs/data-audit.md): Phase 0 audit of the flat CSV (superseded by data-import.md)
