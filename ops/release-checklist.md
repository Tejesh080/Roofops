# Release checklist: every hosted change after the Phase 1 release

`docs/master-plan.md` §13 rule 2 and Task 1.4 Step 4. A hosted change goes out every one to two weeks through this
page: no new runbook per change. The only exception is the Phase 1 batch, `ops/release-phase1.md`; every hosted change
after it uses this page. Every 🔒 line changes a live system and needs the owner's approval in chat, for that line, at that time.
Hosted and staging writes take `--confirm <project ref>`.

## The loop

PR → CI → merge to `main` → `staging` fast-forwarded → smoke on the staging preview → hosted release.

1. **PR.** Small, from the template. CI green: `check`, `db`, `secrets`, the seven `e2e (…)` suites and CodeQL.
2. **🔒 Merge to `main`.** Only with every check green.
3. **🔒 Staging.**
   - Fast-forward the `staging` branch to `main`. Vercel builds the staging preview from it.
   - `npm run db:load -- --staging --confirm <staging-ref>`: applies the new migrations; the synthetic bundle reports "already imported".
   - `npm run integrity:check -- --staging`: 0 FAIL.
   - Run `smoke-deployment.yml` (Actions › Run workflow) with `base_url` = the staging preview. Green. It needs the three repository secrets from Task 1.3 Step 3.
   - Until Task 1.4 Steps 1–3 exist, skip this line and say so in the evidence.
4. **Hosted release.** The six lines below.

## The six lines

| # | Line | How | Holds when |
|---|---|---|---|
| 1 | Backup | `npm run backup:hosted` (read-only on hosted) | The dump and its sidecar exist; record the file and its SHA-256 |
| 2 | Read-only preflight | `npm run integrity:check`, `npm run security:check`, and the change's own read-only queries (`npx tsx scripts/sql.ts --read-only -f <file>`). For a migration: `npx tsx scripts/release-rehearsal.ts <the line 1 dump>` | 0 FAIL; all pass; `RESULT: every check held` |
| 3 | 🔒 Apply / publish | Migrations: `npm run db:load -- --hosted --confirm <ref>`. n8n: record each workflow's `versionId`, then publish from its file. Dashboard: `cd web && npx vercel deploy` | Each step read back before the next |
| 4 | Verify | Read back every change, node for node for n8n; `/api/healthz` answers 200; the change's own live check (one real edit, one synthetic record) | Every check as expected; stop at the first that is not |
| 5 | Monitor 24 h | System Health, n8n error executions (workflow 95 records them), the healthchecks.io checks | No new FAIL, error execution or alert that the change explains |
| 6 | Evidence | One file: `evidence/release-<YYYYMMDD>.md` | It names what went out (commits, migrations, workflow `versionId` before and after, deployment ids), each check and its result, and anything that deviated. Ledger rows move to **FIXED** only where their live check passed |

## Rollback (newest layer first; nothing deletes data)

1. Dashboard: promote the previous deployment (its id is in the evidence file).
2. n8n: restore each workflow's recorded `versionId`.
3. 🔒 Database: the migration's `ops/rollback/<version>.down.sql`, newest first, with `npx tsx scripts/sql.ts --confirm <ref> -f <file>`. Line 2's rehearsal ran the same files.
4. Last resort: restore the line 1 dump. This loses hosted changes made after it.
