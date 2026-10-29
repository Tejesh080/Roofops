# AC-13B deployment runbook: the pre-start gate (SWMS signed, materials reviewed)

Release commit: the head of `feature/advanced-ac13b-pre-start-gate` that contains this file. Owner-run. Every step marked
🔒 changes a live system and needs the owner's approval for that step; the others are read-only. No secret appears in this
file: connection strings come from `.env.local` and are never printed.

Offline evidence: [evidence/ac13b-offline-verification.md](../evidence/ac13b-offline-verification.md). Ledger row: AC-13B in
[docs/defect-ledger.md](../docs/defect-ledger.md).

## 1. What changes, where

| System | Change | Effect while the old version still runs |
|---|---|---|
| Supabase (hosted Postgres) | Migration `20261022000000_pre_start_gate_before_work_starts.sql`: the gate in `project_transition_guard` (Scheduled → In Progress needs SWMS Done, and materials Done / Waived / Not applicable with a reason); `checklist_apply_change` (pre-start items, project row locked first); `project_apply_change` (the two fields); `checklist_apply_note` and a thin `wf_airtable_change` layer (a Note edited on its own replaces a waiver's reason); `v_airtable_expected` (two projected fields); `v_dashboard_project_checklist` (the card follows the item until work starts); `integrity_check` (`started_with_pre_start_open`, FAIL); 4 field-contract rows; setting `checklist.not_waivable = SWMS_SIGNED` | The gate is live as soon as the migration commits, for every path. A quote-born job (PRJ-2026-0031..0033 today) cannot start until both items are set in Airtable, which needs n8n 06 (step 6) |
| n8n 06 `lD6BOf2dhZZpSoEH` | Watches SWMS Signed, Materials Reviewed and the four checklist Notes | Old 06: edits of the new fields are skipped (the fields are inert) |
| n8n 03 `gtUffpzbdGa0vbYj` | New node *Find Existing Project Record* before *Build Project Record*; the four checklist fields are written only when the record is created; *Verify* checks them only then | Old 03: new projects get no SWMS / Materials value in Airtable, and a retry can write "To do" over a staff Done |
| Airtable Projects | **No schema change.** The four fields already exist (created 2026-10-06). Read-only check 2026-10-22: SWMS Signed is a single select with **To do, Done** only; Materials Reviewed has **To do, Done, Waived, Not applicable**; both Notes are long text; names resolve exactly. No record has SWMS Signed filled yet | — |
| Dashboard, Copilot | No code change. The project checklist card follows the canonical item before work starts | — |

Deploy order: **migration alone, then 06, then 03.** Reverse order to roll back: 03, 06, then the down file.

## 2. Pre-flight (read-only, no approval)

| # | Check | Command / where | Expect |
|---|---|---|---|
| P1 | Hosted integrity and privileges | `npm run integrity:check`; `npm run security:check` | 0 FAIL (2026-10-22: 30 PASS / 4 WARNING / 0 FAIL); all privilege checks pass |
| P2 | Hosted migration head | `npx tsx scripts/sql.ts --read-only "select count(*), max(version) from schema_migrations"` | 56, `20261017060000_quote_publish_lifecycle.sql` |
| P3 | No started job has open pre-start items (the new integrity check would FAIL on it) | `npx tsx scripts/sql.ts --read-only "select p.project_number, ci.item_code, ci.status from projects p join project_checklist_items ci on ci.project_id = p.id where ci.stage = 'PRE_START' and ci.status not in ('DONE','WAIVED','NOT_APPLICABLE') and (p.actual_start_date is not null or p.status in ('IN_PROGRESS','COMPLETED','CLOSED'))"` | 0 rows. If any row: stop and decide with the owner |
| P4 | Jobs the gate will hold | same, without the "started" condition | PRJ-2026-0031..0033 (Planning, both items OPEN), plus any quote-born job created since |
| P5 | n8n versions to roll back to | n8n read: workflow 06 and 03 details | Record each `versionId` / `activeVersionId` in the deployment evidence |
| P6 | Local suite on the release commit | `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run check` | exit 0 (both engines) |
| P7 | Rehearsal on a restored hosted copy | §6 below | migration applies; integrity 0 FAIL; rollback exact |

## 3. Backups (before any 🔒 step)

**B1. Hosted database** (read-only dump, stays outside the repo; same procedure as earlier releases):

```powershell
$env:PGURL = ((Select-String -Path .env.local -Pattern '^\s*SUPABASE_DB_URL\s*=').Line -split '=', 2)[1].Trim().Trim('"') + '?sslmode=require'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
docker exec -e PGURL roofops-postgres sh -c "pg_dump `"`$PGURL`" --schema=public --format=custom --no-owner --file=/tmp/pre-ac13b-$stamp.dump"
docker exec roofops-postgres pg_restore --list "/tmp/pre-ac13b-$stamp.dump" | Select-Object -First 5   # readable?
docker cp "roofops-postgres:/tmp/pre-ac13b-$stamp.dump" "D:\Claude\roofops-backups\pre-ac13b-$stamp.dump"
docker exec roofops-postgres rm "/tmp/pre-ac13b-$stamp.dump"; Remove-Item Env:PGURL
Get-FileHash "D:\Claude\roofops-backups\pre-ac13b-$stamp.dump" -Algorithm SHA256
```

Also confirm Supabase's own daily backup / PITR status in the Supabase dashboard.

**B2. n8n:** download 06 and 03 as JSON (n8n UI → workflow → Download) into `D:\Claude\roofops-backups\` and record
their version ids (P5). n8n's version history keeps the previous versions as well.

**B3. Airtable:** record the current SWMS Signed / Materials Reviewed (blank) and Status of PRJ-2026-0031..0033, with
their record ids, in the deployment evidence. Nothing else in Airtable changes.

## 4. Deployment sequence (owner, in order)

| # | Step | How | Verify |
|---|---|---|---|
| 1 | 🔒 **Pause workflow 07** so that no scheduled reconciliation runs inside the window | unpublish 07 `EiBs0AB2NfOua7AM` | 07 inactive |
| 2 | 🔒 **Airtable data:** set SWMS Signed = To do and Materials Reviewed = To do on PRJ-2026-0031, 0032, 0033 (one PATCH of 3 records). Imported projects stay blank (they have no pre-start items) | Airtable UI or one API call | read back: 3 records × 2 fields = "To do"; old 06 skips the change (fields not watched yet) |
| 3 | 🔒 **Supabase migration** | `npm run db:load -- --hosted` | output lists exactly `20261022000000_pre_start_gate_before_work_starts.sql` and "already imported; nothing to do" |
| 4 | Post-migration checks (read-only) | `npm run integrity:check`; `npm run security:check`; P2 again | 0 FAIL and `started_with_pre_start_open` PASS; all privilege checks pass (the workflow role's set is unchanged: `wf_airtable_change` keeps its grant, `wf_airtable_change_before_notes` and `checklist_apply_note` have none); 57 migrations |
| 5 | 🔒 **Resume 07 and dry-run** | publish 07; `npm run reconcile -- --dry-run` | 0 drift; in particular nothing on the SWMS Signed / Materials Reviewed fields of PRJ-2026-0031..0033 (Airtable "To do" = expected "To do"). Any drift: stop (do not run a repair) |
| 6 | 🔒 **n8n 06** | update `lD6BOf2dhZZpSoEH` from `n8n/06-airtable-changes.sdk.ts` (same id, same credentials), then publish | node-for-node equal to the file; the WATCHED set contains `fldM6kgPz6QZagPAC`, `fldozWSCU877wEZHq`, `fldA77ad94yUmvnu3`, `fldLi9FkGDFAbf0QB`, `fldNcsIgH6TfQFfaU`, `fldEtAmAokIvtzJdn`; the change webhook still OK (07 webhook supervision) |
| 7 | 🔒 **n8n 03** | update `gtUffpzbdGa0vbYj` from `n8n/03-airtable-project-writeback.sdk.ts`, then publish | node-for-node equal; connections *Claimed?* (case 0) → *Find Existing Project Record* → *Build Project Record*; credentials unchanged |
| 8 | Post-deploy checks (read-only) | integrity, security, n8n executions of 06 in the last hour | 0 FAIL; no 06 execution with an error |
| 9 | 🔒 **Live acceptance** (§5) | a mapped staff member in the Airtable UI | every row of §5 as expected |
| 10 | Evidence | `evidence/ac13b-hosted-verification.md`: backups (path, SHA-256), version ids before/after, outputs of steps 3-9 | the ledger row moves from "Fixed offline" to **FIXED** only after step 9 passes |

Whether 03 is exercised live in this window is the owner's choice: it runs only when a quote is accepted. The supervised
Sales step "set synthetic Q-2026-0066 to Accepted" (separate approval, `ops/ops-sales-release-plan.md`) would prove it: the
new project's Airtable record gets the four checklist fields "To do", read back by 03.

## 5. Live acceptance on PRJ-2026-0031 (🔒, Airtable UI, mapped user)

PRJ-2026-0031 is quote-born, Planning, both items To do. The test leaves no net canonical change.

| # | Action in Airtable (Projects › PRJ-2026-0031) | Expected in Airtable (after 06 runs, within a minute) | Expected in RoofOps (read-only check) |
|---|---|---|---|
| A1 | Planned Start = a date ≥ today, Planned Completion after it; Status = Scheduled | kept | `projects.status = SCHEDULED` |
| A2 | Status = In Progress | Status put back to **Scheduled**; RoofOps Sync: "pre-start items are still open (Materials reviewed and approved, Safe Work Method Statement signed)…" | still SCHEDULED; no Actual Start |
| A3 | SWMS Signed = Done | kept | SWMS_SIGNED DONE, `completed_by` = the staff member's employee |
| A4 | Materials Reviewed = Not applicable, with Materials Reviewed Note "Live test: labour-only" | kept | MATERIALS_REVIEWED NOT_APPLICABLE, reason = the Note, audit `project.checklist.changed` |
| A5 | Edit **only** Materials Reviewed Note to "Live test: labour-only (2)" | kept | reason replaced; one more audit row |
| A6 | Clear Materials Reviewed Note (blank) | Note put back to "Live test: labour-only (2)"; RoofOps Sync explains | reason unchanged |
| A7 | Materials Reviewed = To do, then SWMS Signed = To do | kept | both OPEN |
| A8 | Status = Planning; clear Planned Start / Completion if they were blank before | kept | PLANNING; net canonical change: none (audit rows remain, as for every edit) |

Then: `npm run reconcile -- --dry-run` (0 drift) and `npm run integrity:check` (0 FAIL). Whether to really start a job is
the owner's call, so the test does not start one.

**Stop rule:** if any row differs, stop. Do not re-run, do not fix Airtable by hand, and keep the 06 execution ids and
the RoofOps Sync text for the analysis.

## 6. Rehearsal on a restored hosted copy (read-only, local)

Restore the newest hosted dump into a scratch database in the local container, migrate it, check, roll back, compare:

```powershell
docker exec roofops-postgres createdb -U postgres roofops_ac13b_rehearsal
docker cp "D:\Claude\roofops-backups\<newest>.dump" roofops-postgres:/tmp/rehearsal.dump
docker exec roofops-postgres pg_restore -U postgres -d roofops_ac13b_rehearsal --no-owner /tmp/rehearsal.dump
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/roofops_ac13b_rehearsal'; npm run db:load; npm run integrity:check -- --local
```

Expect: the pending migrations apply; integrity 0 FAIL with `started_with_pre_start_open` PASS; the down file then returns
every function, view, field-contract row and setting to the pre-migration state. Drop the scratch database afterwards.
The rehearsal result for this release is in the offline evidence (§3g).

## 7. Rollback procedures

Use the first layer that is enough. Nothing deletes data.

| Layer | When | How | Result |
|---|---|---|---|
| R1. n8n 03 | 03 misbehaves on a new project | 🔒 restore 03's previous version (P5), publish | new projects get no pre-start values in Airtable again (the gate still holds in Postgres) |
| R2. n8n 06 | 06 misbehaves on edits | 🔒 restore 06's previous version, publish | SWMS / Materials / Note edits are skipped again; **quote-born jobs then cannot start** (the gate holds, nothing can set the items), so R2 alone is a short-term measure: follow with R3 or a fix |
| R3. Database | the gate itself must go | 🔒 R1 and R2 first, then pause 07, then `npx tsx scripts/sql.ts -f ops/rollback/20261022000000_pre_start_gate_before_work_starts.down.sql` (owner, one transaction), then 4 and 5 again | every function, view, field-contract row and setting as before (rehearsed byte for byte); checklist items, audit events and Airtable values written in the meantime are kept |
| R4. Restore B1 | last resort, if hosted state is damaged | 🔒 restore the B1 dump | loses every hosted change since B1 |

The Airtable fields stay; with R2 and R3 they are inert again. Values staff set in them stay visible and do nothing.

## 8. Approval items (in order)

1. Pause 07 (step 1).
2. Airtable: "To do" on PRJ-2026-0031..0033 (step 2).
3. Supabase migration (step 3).
4. Resume 07 and the dry-run (step 5).
5. Publish n8n 06 (step 6), then n8n 03 (step 7).
6. Live acceptance on PRJ-2026-0031 (step 9).
7. Optional, separately: the Sales step that accepts synthetic Q-2026-0066 (proves the new 03 live).
