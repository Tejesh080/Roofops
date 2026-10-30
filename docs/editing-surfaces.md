# Editing surfaces

`docs/master-plan.md` Task 3.4. Where staff change what, where they see what happened to their change, and the rule
for taking a field out of Airtable when it causes trouble. The field-by-field contract behind this page is
`docs/source-of-truth.md`, generated from the `field_contract` table.

## The rule

RoofOps (Postgres) owns every business fact. Airtable is where the office edits a small, named set of fields. RoofOps
checks every such edit:
- it **applies** the edits that pass;
- it **refuses** the ones that break a rule and corrects the Airtable record, with a note saying why;
- it **puts back** any edit to a field RoofOps owns, with a note saying so.

Of the 92 Airtable fields in the contract, 19 are edited by staff (below). The other 73 are copies RoofOps writes and
repairs every night.

## What staff edit in Airtable, and what RoofOps checks

| Table | Field | RoofOps checks |
|---|---|---|
| Projects | Status | The project's allowed transitions and guards (for example the pre-start gate, or a fully billed job that cannot be cancelled) |
| Projects | Status Reason | Free text, read with a status change |
| Projects | Planned Start, Planned Completion | Dates in order; locked once Completed, Closed or Cancelled |
| Projects | Project Manager | An active project manager, by full name |
| Projects | SWMS Signed | Done only, by a mapped RoofOps employee; it cannot be waived |
| Projects | Materials Reviewed (and its note) | Done, or Waived / Not applicable with a reason in the note |
| Projects | Completion Photos, Compliance Certificate (and their notes) | Done only once work has started; Waived / Not applicable need a reason |
| Projects | Invoice Action | Prepare, or Approve by a mapped approver |
| Purchase orders | Status | The order's allowed transitions; an approver for Approved |
| Purchase orders | Expected Delivery | On or after the order date; locked once Delivered or Cancelled |
| Purchase orders | Supplier Reference | Free text |
| Quotes | Status | The quote's allowed transitions (Accepted is handled by the Quote → Project workflow) |
| Quotes | Lost Reason | Required while the quote is Lost |

## Which surface for what

| What | Today | Before the pilot (owner's decision, master plan §15) |
|---|---|---|
| Project status and dates | Airtable, checked as above | Recommended: the dashboard; Airtable read-only for these fields |
| Invoice approval | Airtable Invoice Action, or the dashboard's Finance page, where the person who prepared an invoice cannot approve it | Recommended: the dashboard only |
| Site visits, crew, tasks, next steps | The dashboard only | No change |
| Completion items and their notes | Airtable | No change |
| Office views and filters | Airtable | No change |

Airtable keeps its views, the completion items with their notes, and anything a person reads but RoofOps owns. RoofOps
Lite has its own Airtable base (master plan Task L3) and shares nothing with this one.

## Where staff see what happened (the sync log)

- **A project's page, "Automation history":** every Airtable edit to that project, as "Change made in Airtable" with who
  made it.
  - An applied edit reads "✓ Status: Scheduled → In Progress applied".
  - A refused edit reads "✗ … not applied:" with the reason and the value kept, marked "Needs attention or stopped safely".
  - An edit RoofOps put back reads "↺ Actual Start is managed by RoofOps; … was reverted to …", marked the same way.
  - `web/e2e/job-journey.spec.ts` (step 7) pins all three.
- **Automation page, "Recent activity":** the last 30 days of automation across all projects.
- **System Health:** the Airtable row, with the pings checked and any drift the nightly reconciliation found.

The Airtable record itself also carries the correction note, so the person who made the edit sees it where they made it.

## The retreat trigger

If one field produces **more than three** staff-visible problems in one pilot week, then **within the following week** it
becomes dashboard-only and read-only in Airtable. A problem is any of these:
- an edit refused;
- an edit put back;
- an exception raised because Airtable and RoofOps disagreed on that field.

Making a field dashboard-only means:
- a migration sets its owner in `field_contract` to RoofOps, so any further Airtable edit is put back;
- the field is locked in the Airtable interface;
- the dashboard gains the edit, if it does not have it yet.

The count is part of the weekly walkthrough (`docs/walkthrough-log.md`), from the projects' Automation history and the
Automation page.
