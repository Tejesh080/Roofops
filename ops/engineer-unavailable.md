# When the engineer is unavailable

`docs/master-plan.md` Task 2.4. One page for the person at the business who is not the engineer. It answers three
questions: is RoofOps healthy, how do I stop all automation right now, and whom do I call.

## What runs where

| Part | Where | What it does |
|---|---|---|
| Database | Supabase | The single source of truth: projects, quotes, invoices, every change and its audit trail |
| Automation | n8n Cloud, workflows named `[RoofOps] 00`–`10` | Reacts to Airtable edits, creates Drive folders, writes back to Airtable, sends draft invoices to Xero, reconciles nightly |
| Dashboard | Vercel, project `roofops-dashboard` | Staff sign in to see jobs, approvals, System Health and the Copilot |
| Office view | Airtable | Where staff edit; RoofOps checks every edit before it counts |
| Accounting | Xero (the Demo Company until the pilot) | Receives DRAFT invoices only |
| RoofOps Lite | Separate n8n workflows `[Lite] …` | A different product. None of its workflows is published today |

## Is it healthy?

- **`/api/healthz`** on the dashboard address. `"status":"ok"` means every check is fresh and passing.
  `"attention"` lists the reasons: a check older than two hours, a service failing three times in a row, an integrity
  rule failing, or a write that gave up ("dead-lettered"). It never shows customer data.
- **System Health** (dashboard menu): the same checks in more detail; once workflow 95 is live, also the last n8n failures.
- **healthchecks.io** (after Task 1.2): an alert reaches the owner's phone when `/api/healthz` stops answering "ok".

## Stop all automation right now

In n8n Cloud, open each workflow below, **in this order**, and unpublish it. Check that it shows as inactive before
the next one.

1. `[RoofOps] 07 Reconcile & Webhook Supervision`: first, because it wakes the others.
2. `[RoofOps] 04 Approved Project → Xero Draft Invoice`: stops new invoices going to Xero.
3. `[RoofOps] 08 Reissue Dispatch`: the other way an invoice reaches Xero.
4. `[RoofOps] 01 Quote Accepted → Project`: stops new projects, Drive folders and write-backs.
5. `[RoofOps] 06 Airtable Changes → Postgres`: stops staff edits in Airtable from being applied.

That is enough. Leave these alone:
- `00 Setup & Maintenance` and `08 Health Checks` only keep the Airtable connection alive and report health.
- `02`, `03` and `05` run only when called by the ones above.
- `09` and `10` are already inactive.
- `95` runs only when another workflow fails.

**While stopped:** nothing is lost for up to seven days. Airtable keeps every edit for seven days, and RoofOps records
how far it has read. Staff can keep working in Airtable; their edits wait. `/api/healthz` may show "attention" while
stopped: that is expected.

**The dashboard** is a staff tool, not automation; it cannot send anything to Xero on its own. If it must go offline
too: `vercel project pause roofops-dashboard` stops the production address (`vercel project resume` brings it back).
A Preview address stays reachable only to people signed in to Vercel; ask the engineer to remove it.

**To resume** (under seven days): publish them again in reverse order (06, 01, 08 Reissue, 04, then 07). 07's next
run picks up the edits that waited. Then check `/api/healthz` and System Health. **Stopped longer than seven days:**
call the engineer before resuming. The waiting edits have expired, and the nightly reconciliation must be checked first.

## Restoring data

This is not a one-person job. Stop all automation first, then call the engineer or Supabase support.
- Supabase's own backups (Supabase › Database › Backups) exist only on some plans (Task 0.7 records which).
- The weekly off-platform copies are `weekly-<date>.dump` files in `roofops-backups`, each with a `.sha256` beside it.
  Restoring one undoes every change made after that date. Technical steps: `ops/release-phase1.md` §6.

## Whom to call

| For | Who | How |
|---|---|---|
| Anything RoofOps | The engineer | (fill in) |
| The database | Supabase support | supabase.com/support (fill in the plan and account email) |
| n8n Cloud | n8n support | (fill in the account email) |
| The dashboard | Vercel support | (fill in the team name) |
| Xero and invoices | The bookkeeper | (fill in) |
