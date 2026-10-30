# Phase 4: Operations Dashboard + Operations Copilot ✅ (awaiting review)

A business-facing view of the live RoofOps system, plus a DeepSeek copilot that answers from RoofOps data through
controlled tools. All data is synthetic (Demo mode banner on every page). Phase 2 and Phase 3 workflows are unchanged.

## Run it

```
npx tsx scripts/provision-dashboard-role.ts   # once: creates the roofops_web login, writes web/.env.local (not printed)
npm --prefix web install
npm --prefix web run dev                      # http://127.0.0.1:3000 (bound to this machine only)
```

## What the owner sees

| View | Content |
|---|---|
| **Dashboard** `/` | Five headline numbers (Active projects, Projects at risk, Awaiting materials, Ready to invoice, Open issues), each clickable. Project table with tabs (Active, Needs attention, At risk, Awaiting materials, Ready to invoice, Completed, All) and search: project, customer + site, stage, scheduled date, materials, invoice status (+ Xero number), risk with plain reasons. "Needs attention: automation issues" list. Demo guide with the real examples. |
| **Project** `/projects/PRJ-…` | Customer, quote, schedule; why it is at risk; materials with purchase orders; checklist and material review; invoicing (amount, RoofOps invoice, Xero invoice number and ID, why not ready, invoices); Google Drive and Airtable links; automation issues; automation history in plain words ("Duplicate ignored safely", "Retry in progress", "Failed safely", "Completed"). |
| **Copilot** (right panel, every page) | Suggested questions; answers with the tools it checked; invoice preview card straight from the database with an "Approve in Airtable" link. |

Screenshots: `docs/screenshots/01-dashboard.png` … `06-needs-attention.png`.

## Architecture (no business state in the frontend)

- `web/` is a Next.js 16 app, server-rendered. Every figure is read at request time from the hosted database.
- The server connects as **`roofops_web`** (member of `roofops_dashboard`, ADR-032), which can:
  - `SELECT` only `v_dashboard_*`, `v_purchase_order_status` and `v_invoice_balances`;
  - `EXECUTE` `wf_invoice_prepare` (the same preview-only entry point n8n uses).
  It cannot read a table, approve, write settings or call any other workflow function (proven by `test/dashboard.test.ts` and at provisioning time).
- Migrations `1000` (read models + role) and `1100` (two fixes found in review) add views only; nothing new is stored.
- The labels (`web/lib/labels.ts`) translate codes into business words; they hold no state.

## Operations Copilot

DeepSeek (`deepseek-flash`, OpenAI-compatible tool calling) runs **server-side** in `web/lib/copilot/agent.ts`. The key is only in
`web/.env.local`, and a scan of the built client bundles found no key, key fragment or database URL. The model sees tool results, never
SQL or credentials.

| Tool | Tier | Returns |
|---|---|---|
| `business_overview` | GREEN (read) | headline numbers + business date |
| `what_needs_attention_today` | GREEN | at-risk jobs with reasons, open issues with status, invoices awaiting approval, ready to invoice ("not prepared yet"), overdue payments |
| `list_projects(group)` | GREEN | at_risk / awaiting_materials / ready_to_invoice / awaiting_approval / active / completed |
| `get_project(project)` | GREEN | customer, quote, dates, risk reasons, POs, checklist, invoice + Xero, open issues |
| `get_project_history(project)` | GREEN | where it stands now + plain-English timeline |
| `list_open_issues` | GREEN | open automation issues |
| `prepare_invoice(project)` | **AMBER** (preview) | calls `wf_invoice_prepare`; returns amount, GST, basis, reference, due date, Xero organisation, approval ref |
| approve / send / pay | **RED** | not available to the copilot. Approval stays with a finance approver in Airtable → n8n 04 → 05 → Xero DRAFT (Phase 3) |

Guards: `prepare_invoice` runs only if the user's message explicitly asks to prepare/create an invoice. A job that is not ready is
explained without filing an automation issue. Preview figures shown to the user come from the database card, not from model text.

## Demonstrated live

- **"Prepare invoice for PRJ-2026-0005"** (typed in the dashboard copilot): APR-2026-0002 **PENDING**, $17,831.91 inc GST
  (GST $1,621.08) = quote Q-2026-0005 v2 $44,579.78 − already invoiced $26,747.87, reference PRJ-2026-0005, due 13 Oct 2026, Xero organisation
  Demo Company (AU). Afterwards the database still has **1** final invoice and **1** Xero job (PRJ-2026-0004's) and no new issues; the audit chain is intact.
  The project page switched to "Awaiting approval", and history shows "Invoice preview requested · Operations Copilot".
- "Approve the invoice for PRJ-2026-0005 and send it to Xero" → refused, with the next human step explained.
- "Prepare invoice for PRJ-2026-0031" (still Planning) → explained as not ready; no preview, no new issue.

## Tests

| Suite | Result |
|---|---|
| Local, PGlite + Postgres 17 | **237 passed**, 24 skipped (hosted-only). New: `dashboard.test.ts` (read models agree with the existing KPIs, readiness = invoice preview rule, role cannot read tables/approve/write, regressions for both review fixes), `copilot-tools.test.ts` (tiers, no commit tool, loose project numbers, groups = headline numbers, plain wording without jargon, prepare guard, preview + idempotent re-prepare, all run *as the dashboard role*) |
| Hosted (`RUN_HOSTED_TESTS=1`) | **201 passed**, 3 skipped |
| Live copilot smoke (`scripts/copilot-smoke.ts`, real DeepSeek + hosted data) | **6/6, three consecutive runs**: expected tool used, answer contains the facts the database says are true, no records created. Evidence: `evidence/phase4-copilot-smoke.json` |
| Lint, root typecheck, web typecheck, `next build` | clean |
| Browser (in-app + headless Chrome) | dashboard, project pages, copilot panel, prepare card, narrow-screen drawer |

**Found in review and fixed:**
- `needs_attention` was NULL for projects without a final invoice, so on-track projects sorted first.
- "Owed to us" counted an approved, unsent draft invoice.
- Model answers overgeneralised ("all flagged by PM"), called a "Needs attention" issue "retry in progress", and used planned finish dates as actual finish dates. Fixed with per-item status fields and actual dates in tool results, plus stricter prompt rules.
- A conflicting tool description made "needs attention" answers incomplete.
- Technical text in the issue and history wording.

## Remaining limitations

1. **No login.** The dashboard binds to 127.0.0.1 for a local demo. It is not deployed, because a public URL would need authentication before it could show customer data or prepare invoices.
2. **Approval happens in Airtable, not the dashboard.** A preview prepared by the copilot shows in the dashboard, but Airtable's Invoice Status for that project stays blank until the finance approver acts (they approve by setting Invoice Action; 04 finds the pending preview).
3. **LLM answers are non-deterministic.** Facts come only from tools, and the smoke test checks key facts, but wording and emphasis vary between runs. DeepSeek outages show a friendly error; the dashboard itself keeps working.
4. **Copilot conversations are not stored** (browser memory only). Tool calls that change anything (prepare) are recorded in the automation history and audit log.
5. **Imported history is thinner than live history**: no checklists or Drive folders for imported projects, and some imported data quirks (e.g. a completed job with a PO still "Sent to supplier").
6. Carried over: TLS to Supabase is encrypted but not certificate-verified from this machine; shared n8n instance.
