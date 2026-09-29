# System ownership map (as built, Phase 6)

This describes the running system, not the target diagram. Every arrow below is a real workflow, function or view. IDs are real.

## One rule

**Postgres (Supabase) is the single source of truth for every business fact.** Airtable is where office staff *edit*
a small set of fields and *read* everything else. Google Drive and Xero hold objects; Postgres holds the verified link to
them. The dashboard and the Copilot read Postgres only.

```
            staff edit (Airtable UI)                               owner / PM
                     │                                                 │
                     ▼                                                 ▼
 ┌──────────── Airtable base appMc8V0Wm29tEeHQ ───────────┐     ┌── Web app (Next.js) ──┐
 │ Customers · Properties · Suppliers · Quotes · Projects │     │ dashboard + Copilot   │
 │ · Purchase Orders   (231 linked records)               │     │ reads v_dashboard_*,  │
 └───┬───────────────┬───────────────┬────────────────────┘     │ v_system_health …     │
     │ webhook       │ webhook       │ webhook (base-wide,      │ role roofops_web      │
     │ Quotes.Status │ Invoice Action│ all fields, Phase 6)     │ (no table access)     │
     ▼               ▼               ▼                          └─────────┬─────────────┘
  n8n 01          n8n 04          n8n 06 Airtable Changes                  │ read-only views,
  Quote→Project   Invoice         → wf_airtable_change                     │ wf_invoice_prepare
     │            preview/approve   (ownership · state machine · CAS ·     │ (preview only)
     │               │               stale · duplicate · read-back)        │
     ▼               ▼               ▼                                     ▼
 ┌──────────────────────────── Postgres (canonical) ─────────────────────────────────┐
 │ projects · quotes · purchase_orders · invoices · approvals · tasks · outbox       │
 │ state_transitions (enforced by triggers) · field_contract · audit_events (hash    │
 │ chain) · processed_events · automation_events · reconciliation_runs/findings ·    │
 │ airtable_observations · external_field_versions · integration_health              │
 └───────┬─────────────────────────┬─────────────────────────┬───────────────────────┘
         │ outbox (claimed, proved)│                         │ nightly + `npm run reconcile`
         ▼                         ▼                         ▼
   n8n 02 Drive folder       n8n 05 Xero DRAFT         n8n 07 Reconcile & webhook supervision
   n8n 03 Airtable write-back  (pinned Demo tenant)    (Airtable ↔ PG, Drive ↔ PG, Xero ↔ PG;
         │                         │                    refresh / create / wake webhooks)
         ▼                         ▼                   n8n 08 Health (Drive, Xero, DeepSeek, n8n)
   Google Drive              Xero Demo Company (AU)
   "RoofOps Demo" root       tenant 96643bb0-…
```

## Who owns what

| Area | Canonical owner | Editable by staff where | Path that changes it | Downstream |
|---|---|---|---|---|
| Project status, planned dates, PM | Postgres `projects` | Airtable Projects (Status, Planned Start/Completion, Project Manager, Status Reason as input) | Airtable → n8n 06 → `wf_airtable_change` → `project_apply_change` (state machine + guards) | dashboard, Copilot, risk, invoice eligibility, tasks/approvals on cancel; Airtable corrected if needed |
| Actual start / completion | Postgres | nowhere directly (derived from Status) | set by the project transition | Airtable projection |
| Quote status (Sent, Lost, Expired), Lost Reason | Postgres `quotes` | Airtable Quotes | n8n 06 → `quote_apply_change` | KPIs, Copilot |
| Quote acceptance | Postgres | Airtable Quotes.Status = Accepted | n8n 01 → `wf_quote_accepted` (creates project, Drive, Airtable project) | projects, Drive, Airtable |
| Purchase order status, Expected Delivery, Supplier Reference | Postgres `purchase_orders` | Airtable Purchase Orders | n8n 06 → `po_apply_change` | materials status, risk, dashboard, Copilot |
| Invoice preview / approval | Postgres `approvals` | Airtable Projects.Invoice Action; dashboard/Copilot "Prepare" | n8n 04 / web → `wf_invoice_prepare`, `wf_invoice_decide` | invoices, outbox → Xero |
| Final invoice + Xero draft | Postgres `invoices` + verified `external_links` | nowhere | `wf_invoice_decide` → outbox → n8n 05 (read-back proof) | Xero Demo, Airtable projection |
| Drive project folder | Google Drive object; verified link in Postgres | Drive (files inside) | n8n 02 (read-back proof) | Airtable Drive Folder, dashboard |
| Customers, properties, suppliers, quote pricing, PO numbers/dates/amounts | Postgres | **read-only in Airtable** (edits reverted with a note) | import | Airtable projection, Xero contact |
| Invoice Status / Amount / Xero IDs in Airtable | derived from Postgres | nowhere | n8n 04; repaired by reconciliation when canonical state is stable | Airtable only |
| RoofOps Sync (new field, 6 tables) | written by 06/07 | nowhere | explains refusals, reverts and derived values to staff | Airtable only |

The full field-by-field contract (94 rows, machine-readable) is [source-of-truth.json](source-of-truth.json) /
[source-of-truth.md](source-of-truth.md), generated from the `field_contract` table that the change handler and the
reconciler actually use.

## What changed in Phase 6 (and why)

The audit found that only two Airtable fields reached Postgres: **Quotes.Status (→ Accepted only)** and
**Projects.Invoice Action**. Every other staff edit was silently ignored. That's how PRJ-2026-0001 showed *Cancelled* in
Airtable and *Completed* everywhere else. Draft→Sent, Sent→Lost and →Expired quote changes, PO status, delivery dates and
schedule changes had the same gap. Phase 6 adds:

1. **One generic change capture:** a base-wide webhook `achrbwFiSoL4y5RXM` → n8n 06 → `wf_airtable_change`. Every
   change is decided by the owning field's contract.
2. **State machines as data:** `state_transitions`, enforced by a trigger on every status column.
3. **Reconciliation:** n8n 07. It replays missed edits through the same handler, repairs RoofOps-owned drift, and opens
   exceptions for anything ambiguous.
4. **Health:** n8n 08 and 07 record real checks; they are shown on `/health`.

## Credentials (where they live)

| Secret | Lives in | Never in |
|---|---|---|
| Airtable PAT (n8n) | n8n credential `3XbFnHjAd7mFvBD2` | repo, Postgres, web |
| Postgres `roofops_n8n` (role `roofops_workflow`) | n8n credential `kWqjtv0gz7ref2EN` | repo |
| Postgres `roofops_web` (role `roofops_dashboard`) | `web/.env.local` / Vercel env (server only) | client bundles (scanned) |
| Google Drive OAuth | n8n credential `o7IjcWsTr1ZUy9wU` | repo |
| Xero OAuth (Demo Company) | n8n credential `rjqe50LhcU1IRLBc` | repo; writes pinned to tenant `96643bb0-…` in Postgres |
| DeepSeek key | `web/.env.local` (server only), n8n credential `jv3W4NvaBlk9SJgb` | client bundles, prompts, replies (Promptfoo checks) |
| Reconcile trigger token | `.env.local` | Postgres holds only its SHA-256 |
