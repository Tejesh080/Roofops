# RoofOps

**An operations and automation platform for a fictional Australian roofing contractor. Portfolio/interview project.**

> ⚠ **SYNTHETIC DEMO DATA.** Every customer, supplier, address and amount is fictional. External integrations run in **MOCK** mode unless explicitly configured, and the UI always shows which mode each integration is in.

RoofOps models the full job lifecycle (lead → quote → project → purchasing → field work → invoice → payment). Its focus is the parts that break in real operations:

- a webhook delivered twice must not create two projects
- Xero returning 429, or timing out after it may have created the invoice
- an AI assistant that can read freely, draft safely, and **never** move money without a human approving
- a supplier quote parsed by AI but totalled by code
- every change traceable in an append-only, hash-chained audit trail

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Architecture, schema, acceptance criteria | ✅ complete, awaiting review |
| 1 | Database + deterministic seed data | ⏳ |
| 2 | Quote → Project automation (idempotency) | ⏳ |
| 3 | Reliability lab + exception queue | ⏳ |
| 4 | AI Operations Copilot (GREEN/AMBER/RED tools) | ⏳ |
| 5 | Supplier quote → PO | ⏳ |
| 6 | Xero integration (mock → Demo Company) | ⏳ |
| 7 | OpenTakeoff experiment (optional) | ⏳ |

## Read in this order

1. [docs/architecture.md](docs/architecture.md): how it fits together and why
2. [docs/data-model.md](docs/data-model.md): ERD, integrity rules, state machines
3. [docs/acceptance-criteria.md](docs/acceptance-criteria.md): definition of done per phase, and the test matrix
4. [docs/data-audit.md](docs/data-audit.md): what's wrong with the source CSV and how the seed will fix it
5. [docs/decisions.md](docs/decisions.md): ADRs, three marked *needs review*

## Phase 0 checks you can run

```bash
# needs: npm i -D @electric-sql/pglite (added properly in Phase 1)
node scripts/phase0-schema-check.mjs supabase/migrations/20260929000000_core_schema.sql
node scripts/phase0-csv-audit.mjs data/source/RoofOps_Master_Synthetic_Operations.csv
```

## Stack

Next.js · TypeScript · Tailwind · shadcn/ui · Supabase Postgres · n8n · Claude/OpenAI behind `LlmProvider` · Xero, Google Drive and Airtable behind REAL/MOCK adapters · Vitest · Playwright.
