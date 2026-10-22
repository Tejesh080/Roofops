# OPS-02 offline verification (a cancelled job frees its site visits)

Status: **Fixed offline**. Live verification is pending. Nothing hosted was touched. Everything below ran locally: PGlite
and the local Postgres 17 container.

Branch `feature/advanced-sprint-lifecycle`. Audit findings E2-VISIT-CANCEL and CC-02 (2026-10-22).

## 1. Defect and reproduction

Cancelling a project already withdrew pending invoice previews and cancelled open tasks (`project_apply_change`). Its
site visits (`jobs`, OPS-01, migration 20261017010000) were left as they were. After a cancellation:
- a Scheduled visit kept its crew booked (`visit_crew_conflict` still counted it);
- the crew could still start and complete it, because `web_visit_update` never looked at the project's status
  (`web_visit_schedule` already refused CLOSED and CANCELLED projects);
- no integrity check noticed.

Reproduced first in `test/visit-cancel.test.ts`. Without the migration: **3 of 4 red**. The live-job case holds before and
after.

## 2. Rules

- Cancelling a job also cancels its booked visits (Scheduled, Weather delayed), with `status_reason` "Project cancelled".
  Each visit gets one audit row (`job.cancel`, actor `project_transition`, as for withdrawn previews). The project's
  `project.status.changed` audit also counts them (`visits_cancelled`, next to `tasks_cancelled`). The crew is then free.
- On a Cancelled or Closed job, `web_visit_update` refuses start, reschedule and weather delay with `PROJECT_CLOSED`, the
  code `web_visit_schedule` already uses.
- A visit already under way is left for the crew to complete; completing it is still allowed, so it is never stranded.
  The state rules do not let a planner cancel an in-progress visit.
- Integrity `closed_job_has_booked_visit` (FAIL): no Cancelled or Closed job still has a Scheduled or Weather-delayed visit.
  It can be reached only by changing a project's status around the handler, for example with direct SQL.

**Owner decision, not changed:** whether a visit in progress at cancellation should be stopped rather than completed.

## 3. Fix

Migration `20261022050000_cancelled_job_frees_its_visits.sql`. Each function is its latest definition plus only this
delta, built by script. The only changed source lines are `project_apply_change`'s `declare` line and its audit
`after_state`; the other two functions only gain lines. Rollback:
`ops/rollback/20261022050000_cancelled_job_frees_its_visits.down.sql`, with the exact prior bodies.

| Function | Latest source | Delta |
|---|---|---|
| `project_apply_change` | 20261022000000 | cancel the job's booked visits in the CANCELLED branch, audited; `visits_cancelled` in the status audit |
| `web_visit_update` | 20261017010000 | `PROJECT_CLOSED` for start / reschedule / weather delay on a Cancelled or Closed job |
| `integrity_check` | 20261022010000 | `closed_job_has_booked_visit` (FAIL) |

## 4. Verification

| Check | Result |
|---|---|
| `test/visit-cancel.test.ts` (4 cases) with `site-visits-and-tasks`, `state-integrity`, `project-lifecycle`, `cancel-guard` and `schema`, PGlite and Postgres 17 | 222 passed, 3 skipped |
| Ablation: no cascade | 1 red |
| Ablation: no refusal | 2 red |
| Rollback round trip (scratch database) | only the three functions change; after the down file, functions with ACLs, views, field contract and settings are identical |
| Full gate, `TEST_DATABASE_URL=… npm run check` (lint, both typechecks, PGlite and Postgres 17) | exit 0; Test Files 61 passed, 3 skipped (64); Tests 1275 passed, 37 skipped (1312) |

No existing test changed.

## 5. Hosted steps awaiting owner approval

1. Read-only before: `npx tsx scripts/sql.ts --read-only "select j.job_number, j.status, p.project_number, p.status from jobs j join projects p on p.id = j.project_id where p.status in ('CANCELLED','CLOSED') and j.status in ('SCHEDULED','WEATHER_DELAYED')"`.
   It must return 0 rows, or the new check FAILs on deploy. If it returns rows, a planner cancels those visits first,
   from the dashboard.
2. 🔒 `npm run db:load -- --hosted` (with the release).
3. Read-only after: `npm run integrity:check` (0 FAIL, `closed_job_has_booked_visit` PASS).
4. Rollback: `npx tsx scripts/sql.ts -f ops/rollback/20261022050000_cancelled_job_frees_its_visits.down.sql` (owner, one
   transaction). Visits cancelled in the meantime stay cancelled.
