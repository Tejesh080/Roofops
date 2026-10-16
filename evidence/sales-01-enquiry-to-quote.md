# SALES-01: enquiry to quote (2026-10-16, local only)

Branch `factory/ac14-integrity-followup`. Nothing here is on hosted yet: one migration and one n8n workflow wait for approval.

## What changed

- **Enquiries** (`leads`: the table existed but hosted has 0 rows; enquiries lived only in people's heads and Airtable). A
  sales person (admin, operations manager, project manager, estimator: `sales.roles`) records an enquiry: name, source,
  phone or email (one is required), the address as the caller said it, what they need. A repeat submit (request key)
  returns the first one. RoofOps says when the name, email or phone looks like an existing customer and links to it.
  Contacted, Lost and Not a job (a reason is required) are the only manual moves; Won follows the accepted quote.
- **Customer and site**: pick the existing customer or add a new one; a new one that looks like an existing customer is
  refused with the look-alikes listed ("Use Noah Richards (CUST-0003)") until the person confirms it is a different
  customer (the pair is kept in `customer_match_candidates` for review). The site is reused when the customer already has
  that address (case and spacing ignored), otherwise added and linked as owner.
- **Inspection**: book who measures and when (inspector role, not in the past, not double-booked), then record roof type,
  area, method, pitch and findings, or cancel with a reason.
- **Quote**: lines (labour, material with product, equipment, other), inclusive or exclusive GST, scope. Totals are derived
  by the database (`quote_versions`); the builder previews them live. Saving again on a draft makes the next version; one
  open quote per enquiry. **Send** (DRAFT -> SENT, valid for `quote.validity_days` = 30) queues exactly one
  `airtable.quote_publish` hand-off with the customer, site and quote keyed by Airtable field IDs.
- **n8n 10 Airtable Quote Publish** (`n8n/10-airtable-quote-publish.sdk.ts`, unpublished, trigger disabled): claims the
  hand-off, upserts Customer, Property and Quote by RoofOps ID (never creates a second row), links them, reads the quote
  back and records proof. The database refuses proof that does not match (wrong numbers, missing record IDs or links);
  only then does the quote show "Airtable: added". Failures are recorded and shown on the quote and in Automation.
- **Acceptance stays where it is**: the office sets the quote to Accepted in Airtable; n8n 01 delivers it to the existing
  `wf_quote_accepted`, which creates the project. New: the accepted quote moves its enquiry to **Won** (a trigger on quote
  status), so the pipeline never shows a project as still "Quoted" (found on the first screenshot).
- **Dashboard**: `Sales` in the sidebar: pipeline (New / Contacted and inspecting / Quoted / Won / Lost or not a job) and
  "Record an enquiry" (first on a phone); each enquiry page leads with its one next step, then the four numbered steps.
  Field crew and the shared demo login see everything but get no forms.

## Verified

- Database tests, PGlite and local Postgres: `test/enquiry-to-quote.test.ts` (6 cases per engine + a two-connection
  race), `test/sales-words.test.ts` (GST preview matches the database, next-step wording, refusal wording). Full suite:
  941 passed / 0 failed on both engines; `npm run check` exit 0 (lint, both typechecks, PGlite suite); production build
  clean.
- Browser, local rehearsal database (`E2E_PILOT=1`), each on a fresh reset: `sales-journey` 1/1 (as the synthetic
  estimator: enquiry -> look-alike refused, then a new customer and site -> inspection booked and recorded -> quote with a
  product line, live totals, revision to version 2 -> send -> simulated n8n 10 proof -> "Airtable: added" -> simulated
  acceptance -> Won, project page; a duplicate customer reused with "Use"; the roofer sees no forms). Existing journeys
  unchanged: `site-work` 2/2, `job-journey` 1/1, `invoice-approval` 3/3, `staff-journey` 2/2, `operations` 2/2,
  `dispatch-gate` 1/1. Desktop (1440) and phone (390) screenshots: no horizontal overflow.
- Simulated at the boundary: Airtable (n8n 10's proof and n8n 01's acceptance delivered as those workflows would). n8n 10
  passes `validate_workflow` (21 nodes; warnings only about pin data) but has never run against Airtable.
- Rehearsal on the restored hosted copy `roofops_rehearsal_ops01` (from
  `D:/Claude/roofops-backups/pre-ops01-20261016-162531.dump`, OPS-01 already applied): migration `20261017020000` applied
  in one transaction (82 ms); the 65 existing quotes read through the new views; no outbox rows created; security check all
  PASS; integrity 28/4/0, unchanged from OPS-01. A rolled-back probe as EMP-802 (Admin) recorded an enquiry, added a
  customer and site, saved and sent a $220.00 quote and queued one pending hand-off with all 10 quote fields; after
  rollback 0 leads and 0 hand-offs.

## Known limits

- The integrity check `done_has_proof` does not inspect `airtable.quote_publish` (unknown topics pass); the completion
  function itself refuses a hand-off without proof.
- When n8n 10 creates Customer/Property/Quote rows in Airtable, n8n 06 may see them as edits and send events; RoofOps
  ignores fields Airtable does not own, but watch the first runs in Automation.
- No quote document (PDF) or email to the customer yet: the quote is sent from Airtable as today.

## For staging (needs approval)

1. Back up hosted, then apply `20261017020000` (expect security all PASS, integrity 28/4/0 or better).
2. Create workflow 10 in n8n from `n8n/10-airtable-quote-publish.sdk.ts`, unpublished; one supervised run on a synthetic
   enquiry, then check the three Airtable rows and the proof before enabling its schedule.
3. Deploy a protected preview from this branch (Xero dispatch switch stays off).

## Release preflight (2026-10-17)

Found and fixed before any hosted run (details and the release sequence: `ops/ops-sales-release-plan.md`):
recording a failed hand-off went through `wf_fail_side_effect`, which needs a project workflow run (a 5xx would have left
the hand-off stuck and uncounted): quote hand-offs now fail through `wf_quote_publish_fail` (backoff, then one exception
with the quote number; `ops/requeue-quote-publish.sql` re-queues; completion answers the exception); a run that dies
holding a hand-off is handed out again when its lease ends; a retry never writes Status (cannot undo an Accepted made in
Airtable meanwhile); the dashboard says "retrying" or "stopped" instead of "failed"; an enquiry whose last quote is Lost
or Expired becomes Lost; the enquiry page fails closed without the migration; quote lines stack on a phone. Airtable
lacks 7 select options the dashboard can produce (needs adding before the first hand-off). Rollback scripts are in
`ops/rollback/`.
