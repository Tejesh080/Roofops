# Brief for an independent senior code review

RoofOps runs a roofing business's operations: Postgres (Supabase) is the system of record; Airtable is the staff
spreadsheet UI; n8n runs integrations (Airtable webhooks, Google Drive, Xero); a Next.js dashboard serves staff.
**Almost all of it was written by one AI agent, including the tests.** Please review for correctness and for
assumptions the tests share with the code. Context: `docs/independent-verification.md` (what is and is not verified).

## Ask

1. Can money go wrong? (double Xero drafts, wrong amounts or GST, invoicing an unfinished job)
2. Can two systems disagree about a business fact without anyone noticing?
3. Where do tests only confirm the author's own assumptions?
4. What should be deleted or simplified before a pilot with real staff?

## Read first (highest risk)

| Area | Files | What to check |
|---|---|---|
| Side-effect outbox (claim, complete with proof, fail/retry) | latest `wf_claim_side_effect`, `wf_complete_side_effect(_core)`, `wf_fail_side_effect` (search `supabase/migrations/` for the last `create or replace`; SALES-01 version in `20261017020000_enquiry_to_quote.sql`) | One function per stage for all topics (Drive, Airtable, Xero, quotes). Is "never marked done without proof" really unconditional? Lease/attempt handling; the new `wf_quote_publish_fail` |
| Xero draft creation | `n8n/05-xero-draft-invoice.sdk.ts`, `xero_failure_evidence`, `wf_reconcile_xero_uncertain` | Search-before-create, idempotency key, "may already exist" handling, Demo-tenant pin, always-Inclusive lines vs exclusive-priced quotes |
| Invoice decision and amounts | latest `invoice_final_preview`, `wf_invoice_prepare/decide`, `web_invoice_prepare/decide`, `web_xero_dispatch_request`, `n8n/09-staff-xero-dispatch.sdk.ts` | Four entry points into one financial action; second-person rule; entitlement = quote + approved variations − billed |
| Airtable edits into Postgres | latest `wf_airtable_change(_core)` (`20261001000000_roofops_writes_are_not_staff_edits.sql`), `n8n/06-airtable-changes.sdk.ts` | Ownership decisions, echo detection timing windows, the `airtable_writes` ledger (n8n 10 does not record writes) |
| Reconciliation (writes to Airtable daily) | latest `v_airtable_expected`, `wf_reconcile_airtable`, `n8n/07-reconcile.sdk.ts` | A wrong projection overwrites staff data base-wide in repair mode |
| Quote acceptance | `wf_quote_accepted` (`20260929000400_…`, later edits), `n8n/01-…`, `02-…`, `03-…` | One project per quote under redelivery and concurrency |
| SALES-01 (never run live) | `20261017020000_enquiry_to_quote.sql`, `n8n/10-airtable-quote-publish.sdk.ts`, `web/app/(ops)/sales/*` | Upsert-by-RoofOps-ID, Status handling on retry, select-option values vs Airtable |
| OPS-01 (never run live) | `20261017010000_site_visits_and_tasks.sql`, `web/components/ops/*` | Crew conflict locking, role checks |
| Auth | `20261009000000_staff_sign_in_and_sessions.sql`, `web/lib/auth.ts`, `web/lib/client-address.ts` | Session token handling, throttle, server actions as the only write path |

## Decisions worth challenging

- Two systems of record for quotes and project status (Airtable edits + dashboard); project status cannot be changed
  from the dashboard, so visit completion and project completion are separate.
- Business logic in ~14,700 lines of SQL across 52 migrations, with functions redefined up to 14 times.
- Reconciliation in *repair* mode runs daily and writes to Airtable.
- `business_date_override` exists in production schema (hosted is frozen at 2026-09-29).
- `integrity_check` treats unknown side-effect topics as passing.
- Hard-coded Airtable field IDs and option names in SQL and n8n code, duplicated per workflow.

## How to run

- `npm run check` (lint, types, PGlite tests); `TEST_DATABASE_URL=… npx vitest run` adds real Postgres.
- Browser journeys: `web/e2e/*.spec.ts`, opt-in against a local rehearsal DB (`scripts/pilot-rehearsal.ts --reset`).
- Note: external systems are simulated in these tests by calling the database functions with the payload the code
  expects; they do not prove Airtable, Drive or Xero accept the writes.
- Please do not run anything against the hosted database, n8n, Airtable or Xero.
