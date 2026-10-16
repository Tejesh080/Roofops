# OPS-01: site visits, tasks and next steps (2026-10-16, local only)

Branch `factory/ac14-integrity-followup`. Nothing here is on hosted yet: two migrations wait for approval.

## What changed

- **Site visits with crew** (`jobs`, `job_assignments`, existing but unused: hosted had 0 / 0). A planner (admin, operations
  or project manager) books a visit: kind, Brisbane times, crew, leading hand, a note. Crew or planner start it, mark it
  weather delayed (reason required, kept as a site note) and complete it (optional note, kept as a site note). Planners
  reschedule or cancel (reason required). The database refuses: no session, wrong role, wrong state, a stale screen (record
  version), the past, longer than 14 days, unknown or viewer crew, a closed/cancelled project, a non-return visit on a
  completed one, and a person already on an overlapping visit (checked under a row lock: a real two-connection race books
  one). A repeated submit (same request key) returns the first visit.
- **Tasks** (`tasks`, 3 rows on hosted, previously no staff UI). A task manager (admin, operations or project manager,
  finance) adds one, optionally on a project, for someone, by a date; the assignee or a manager starts and finishes it; a
  manager reassigns, re-dates or cancels it (reason required). Done and Cancelled stay final (the existing task state
  machine). Duplicate open titles and past due dates are refused; every task now gets a number, including the material
  review quote acceptance creates (it was invisible before).
- **Next steps** on every project, from canonical state: what to do now, then what follows, and where (here, Airtable,
  Finance). **My work**: my visits, my tasks, the projects I manage with their next step, and the 14-day schedule.
- **Checklist**: "Materials reviewed and approved" follows its review task and "Final invoice approved" follows the final
  invoice's approval (they were never updated, so finished jobs showed them as To do). Safe Work Method Statement still has
  no recording path.
- **Phase 1 fix**: Airtable's Invoice Preview for a dashboard-approved invoice is projected with its current Xero identity,
  so reconciliation replaces a stale 04 refusal (PRJ-2026-0007 showed "missing completion documents ... Nothing was sent to
  Xero" after its draft existed). Only where a final invoice is synced: a current refusal on a project without a final
  invoice is never touched.
- **Forms keep input after a refusal** (React reset every action form after submission, so a refused reject note, resolve
  note, crew booking or task lost what was typed); a second click before the button disables is ignored.
- Wording: invoice next steps point to the Finance page; the project Schedule card no longer says "In progress" for a job
  that has not started.

## Verified

- Database tests, PGlite and local Postgres (`test/site-visits-and-tasks.test.ts`, 13 cases each engine incl. the race;
  `test/next-step.test.ts`; Invoice Preview regression in `test/staff-invoice-approval.test.ts`, red without the migration).
  Full suite: 920 passed / 0 failed on both engines; lint and both typechecks clean; production build clean.
- Browser, local rehearsal database (`E2E_PILOT=1`): `site-work` 2/2, `job-journey` 1/1 (accepted quote Q-2026-0041 ->
  one project -> visit booked and worked by the synthetic roofer -> Scheduled / In Progress / Completed via the n8n 06 event
  -> completion items closed with reasons -> ready to invoice -> Finance offers Prepare), plus `invoice-approval` 3/3,
  `staff-journey` 2/2, `operations` 2/2, `dispatch-gate` 1/1. Read-only suites on local data: 4 failures that depend on
  hosted-only history (PRJ-2026-0001 cancellation, RO-INV-2026-0039, PRJ-2026-0033 Drive retries, a Copilot answer without
  an AI key); not re-run against a hosted preview.
- Simulated at the boundary in the journeys: Airtable (events delivered as n8n 01/06 would), the Airtable record link 03
  would record; no Drive, no Xero, no invoice.
- Rehearsal on a fresh read-only dump of hosted (`D:/Claude/roofops-backups/pre-ops01-20261016-162531.dump`, sha256
  `edfdcb97...87f1`) restored into the local `roofops_rehearsal_ops01`: 49 -> 51 migrations; only `app_settings` (+3),
  `field_contract` (1 row text), `id_counters` (+TASK) and `tasks` (3 numbered) change; security check 16/16 PASS;
  integrity 29/3/0 -> 28/4/0, the new warning being exactly PRJ-2026-0007's stale Invoice Preview, which the next
  reconciliation repairs. A rolled-back probe booked a visit and created a task as EMP-802 and the dashboard role read them.

## For staging (needs approval)

1. Apply `20261017000000` and `20261017010000` to hosted (backup first); expect 51 migrations, 16/16 security, integrity
   28/4/0 until the next reconciliation repairs PRJ-2026-0007's (and, once observed, PRJ-2026-0005's) Invoice Preview.
2. Deploy a protected preview from this branch (dispatch switch stays off).
3. Hosted has no FIELD_CREW employees: crew can be any active employee; add real or synthetic crew with
   `staff:add-employee` before a field test.
