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
| 2 | Airtable Quote Accepted → n8n → Postgres → Project → Drive → audit → Airtable | 🟡 partial: hosted DB, Airtable, workflow functions live; n8n and Drive BLOCKED ([status](docs/phase2-status.md)) |
| 3 | Reliability lab + exception queue | ⏳ |
| 4 | AI Operations Copilot (GREEN/AMBER/RED tools) | ⏳ |
| 5 | Supplier quote → PO | ⏳ |
| 6 | Xero Demo Company integration | ⏳ |
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
