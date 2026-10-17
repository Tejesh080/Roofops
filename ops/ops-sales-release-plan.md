# Release plan: field operations (OPS-01) and Sales (SALES-01) to the hosted pilot

Prepared 2026-10-17 from branch `factory/ac14-integrity-followup`. Nothing in this plan has been run against hosted,
Vercel, n8n, Airtable or Xero. Every step marked **[approval]** waits for the owner.

## What is released

| Item | File | sha256 (LF) |
|---|---|---|
| Migration 1 | `supabase/migrations/20261017000000_airtable_shows_dashboard_approved_invoice.sql` | `96fc85482963135d580309502e85c4b102917011a520b584b37dfd68c706690c` |
| Migration 2 | `supabase/migrations/20261017010000_site_visits_and_tasks.sql` | `5e4e31743c7a8cca56e6472bdb857574d7adbd72d91b38b171a0dab6a7198c0c` |
| Migration 3 | `supabase/migrations/20261017020000_enquiry_to_quote.sql` | `7864440090e1ffc0d2878ce925fac8b5a1bd53321c9543e359cacbcd9dbcee4d` |
| Migration 4 (release blockers) | `supabase/migrations/20261017030000_release_blockers.sql` | `52e812eb52d9119964a162c324823437fcf7d99ce4f4ee71dd6fa90a0b2eccb4` |
| n8n 05 (changed: per-line TaxAmount; deploy later, step H) | `n8n/05-xero-draft-invoice.sdk.ts` | `f2527749f26cb4eda9fa673d158ded30adfc88113a1caba1a208cca2f8d47f2c` |
| n8n 10 (new, inactive) | `n8n/10-airtable-quote-publish.sdk.ts` | `93fc44135d3d2344918a51d4d1eba7eb18a52eb98dd0dc0c435f102314eb44f3` |
| Rollbacks | `ops/rollback/20261017{000000,010000,020000}_*.down.sql` | generated verbatim from the restored hosted copy |
| Operator script | `ops/requeue-quote-publish.sql` | re-queues one stopped quote hand-off |

Hosted today: 49 migrations, every checksum equal to the repo; these three are the only pending ones (in this order).
No other n8n workflow changes. Workflow 09 stays inactive; no Xero change.

## Hosted baseline (read-only, 2026-10-17 00:00 Adelaide)

- Integrity **29 PASS / 3 WARNING / 0 FAIL**: Q-2026-0031 accepted without a project; PRJ-2026-0001 cancelled with an
  open supplier order; 4 open exceptions (EXC-0003, EXC-0013, EXC-0016, EXC-0017).
- Outbox: 11 rows, all DONE (3 Drive, 3 Airtable write-back, 5 Xero draft). Dispatch requests: INV-2026-0041
  HANDED_OVER, INV-2026-0042 CLAIMED (the scheduled-dispatch test; a CLAIMED request cannot be re-sent).
- Invoices: 4 APPROVED/SYNCED, 1 DRAFT, 10 ISSUED, 27 PAID. `xero.dispatch_roles` = FINANCE,ADMIN; Vercel has no
  `STAFF_XERO_DISPATCH` (the dashboard requires exactly `on`), so staff dispatch is off; n8n 09 inactive.
- 0 enquiries, 65 quotes, 33 projects, 0 site visits, 3 tasks. Staff logins: EMP-801 (FINANCE), EMP-802 (ADMIN).
- Backup taken: `D:/Claude/roofops-backups/pre-release-ops-sales-20261017-000023.dump`
  (sha256 `78ee7cfd7fac1e208a1cb0bbc3f12f3e03c15f6fa82b968453b1dcf4c26f42f2`). Take a fresh one immediately before step A.

## Rehearsal (local restores of that dump; final files)

- The real runner, one migration at a time: 58 / 85 / 114 ms. Integrity 29/3/0 -> **28/4/0** after migration 1, unchanged
  by 2 and 3. Security 16/16 PASS. `db:load` afterwards applies nothing and imports nothing.
- **The extra warning** is `drift` on PRJ-2026-0007's Invoice Preview. Migration 1 makes RoofOps expect the Xero identity
  of a dashboard-approved invoice there; Airtable still shows the 04 refusal text from before INV-2026-0042's draft
  existed. It is a pre-existing stale Airtable field becoming visible, not new damage. The next reconciliation **repair**
  run (n8n 07, active daily) writes the correct text into that one Airtable field. Migrations 2 and 3 do not affect it.
- Changed existing data: 2 `field_contract` description texts; 3 tasks get numbers (TASK-0001..3); new settings only
  (no existing setting changed). Quotes and inspections gain an empty `request_key` column; no row content changes.
- Replaced existing objects: `v_airtable_expected`, `v_dashboard_project_checklist`, and `wf_complete_side_effect_core`
  (only the quote hand-off branch added; the Drive, Airtable write-back and Xero branches are byte-identical; the
  workflow-run step stays mandatory for every existing topic). No existing grant changed; nothing new is executable by
  PUBLIC, anon or authenticated.
- Probes (rolled back): the pending acceptance Q-2026-0031 through `wf_quote_accepted` still creates its project and
  side effects; a Drive completion is refused without proof and recorded with it; 04 and 09 answer as before; the whole
  Sales chain (enquiry -> customer/site -> inspection -> quote -> send -> hand-off proof -> acceptance -> project, enquiry
  Won) runs as EMP-802.
- Role matrix (one synthetic person per role): Admin, Operations Manager, Project Manager: everything; Estimator: sales
  only; Finance: tasks only; Field Crew: start their own visit and task only; Purchasing and Viewer: nothing.
- Rollback: refused while a quote hand-off is queued, running or due a retry; then the three down scripts (~20 ms each)
  restore every function, view, trigger, grant, setting and contract row exactly (integrity back to 29/3/0); visits,
  tasks, enquiries, quotes, hand-offs and links are kept. Re-applying gives a database identical to a first apply.

## Release sequence

Order matters only where stated. Stop at any failed check and use Rollback below.

0. **[approval] Airtable options** (required before step E). Airtable rejects a value its single-select does not have
   (n8n 10 writes with `typecast: false`), and the dashboard can produce these: add to Quotes > *Lead Source*:
   `Phone`, `Other`; Quotes > *Roof Type*: `Other`; Customers > *Type*: `Builder`, `Strata`; Properties > *Property Type*:
   `Industrial`, `Strata Complex`. Until then a hand-off with one of them stops with a VALIDATION_ERROR exception (never
   marked done). Re-check the schema read-only right before step E.
A. **[approval] Hosted migrations.** Fresh read-only backup; then `npm run db:load -- --hosted` (applies exactly the four,
   each in its own transaction). Expect: 53 migrations, security 16/16, integrity 29/5/0 (the drift above, plus "business date
   is synthetic"). The next
   n8n 07 repair run then rewrites PRJ-2026-0007's Invoice Preview in Airtable (**[approval]**: one Airtable field; or
   pause 07 until you are ready).
A2. **[approval] Real date.** `npx tsx scripts/sql.ts -f ops/business-date-switch-to-real.sql` (audited; undo documented in
   the file). Expect the banner "Today …", integrity business_date PASS, more overdue/at-risk items (the demo data ages).
B. **[approval] Protected Vercel Preview** from this branch, Vercel Authentication on, `STAFF_XERO_DISPATCH` unset.
   (Safe in either order with A: without the migrations the new pages say "not available on this server yet".)
C. **[approval] Create n8n 10** from the file, inactive, schedule trigger disabled. Do not activate.
D. Staff smoke test in the Preview (synthetic only), signed in as EMP-802: record an enquiry (`Synthetic Sales Pilot`,
   source Referral), add a new synthetic customer and site, book and record the inspection, prepare a quote, check the
   totals, **do not send yet**. Check the audit timeline and that nothing appeared in Airtable.
E. **[approval] One synthetic hand-off into Airtable.** Send the quote; run n8n 10 **once manually**. Then independently:
   read the Customer, Property and Quote rows in Airtable by RoofOps ID (one each, linked, Status Sent, numbers equal);
   in Postgres the outbox row is DONE with proof and the dashboard says "Airtable: added"; integrity unchanged; n8n 06 made
   no change for those rows. Then **[approval]** set the quote's Status to Accepted in Airtable and confirm n8n 01 created
   one project (Drive folder, Airtable project linked to the quote) and the enquiry shows Won. Afterwards mark the
   synthetic project Cancelled (or keep it as the pilot's example), as you decide.
F. Field operations with synthetic staff: on that synthetic project (never a real one) book a visit for EMP-802 and add a
   task; start, delay, complete the visit; start and finish the task; check My work, Next steps and the audit trail.
   Adding a FIELD_CREW synthetic login (`staff:add-employee`) is needed for a crew-eye view.
G. Keep n8n 10 inactive (run manually per quote) until E has passed and you decide to enable its schedule.

H. **[approval, later] Per-line GST for finals with variations.** Update n8n 05 from the file (TaxAmount per line), run one
   supervised Demo draft with a variation line and check Xero's TotalTax equals RoofOps's GST, then set
   `xero.line_tax_amounts = on`. Until then such finals are refused at preview (single-line finals are unaffected).

## Rollback

- Web: promote nothing; delete or stop sharing the Preview. Production is untouched.
- n8n 10: deactivate/delete. It writes only the three Airtable rows of a sent quote, found by RoofOps ID.
- Database, in this order, each one transaction (`npx tsx scripts/sql.ts -f <file>`):
  `ops/rollback/20261017030000_release_blockers.down.sql`, then `ops/rollback/20261017020000_enquiry_to_quote.down.sql`, then `..._site_visits_and_tasks.down.sql`, then
  `..._airtable_shows_dashboard_approved_invoice.down.sql`. Records made meanwhile are kept; the dashboard shows Sales,
  visits and tasks as unavailable; quote acceptance through Airtable keeps working.
- Last resort: restore the pre-release dump (loses every hosted change made after it).
- A synthetic Airtable row from step E is removed by hand in Airtable (RoofOps never deletes Airtable rows).

## Known residual risks

- Quote numbers come from RoofOps; a quote typed directly into Airtable with the next number would be a second row with
  the same number (Airtable's highest today is Q-2026-0065). During the pilot, create quotes only in RoofOps.
- A retry of a hand-off never writes Status (so it cannot undo an Accepted made meanwhile); if the first try failed before
  the quote row existed, the retry creates it without Status and reconciliation sets it to Sent with a "blank not
  applied" note.
- A quote revised after it was sent keeps the hand-off's original amount until reconciliation repairs it.
- The integrity check does not inspect quote hand-offs (the completion function refuses one without proof).
- Customer details can not be corrected from the dashboard after conversion; a quote sent to the wrong customer is
  closed by marking it Lost in Airtable (the enquiry follows) and the enquiry is re-entered.
