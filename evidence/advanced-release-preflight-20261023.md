# Advanced release: backup and read-only preflight (2026-10-23)

Runbook [ops/advanced-release-runbook-20261023.md](../ops/advanced-release-runbook-20261023.md) §3 and §4, approved by
the owner. Nothing was migrated, published, activated or edited: every hosted read ran inside a READ ONLY transaction
or through a read-only API. No 🔒 step of §5 has started.

**Result: GO for §5, subject to the owner's 🔒 approvals.** One gap: the Vercel deployment ids (§3.4) were not readable
with the current access.

## 1. Backup (§3)

| # | Item | Recorded |
|---|---|---|
| 1 | Hosted dump | `D:\Claude\roofops-backups\pre-advanced-release-20261023-232418.dump`, 1,193,479 bytes, SHA-256 `fe2843bf1e424f8e65a06a26898fbd6a2ee7a802f72e27a1a138f93c87e5957a` (`.sha256` alongside). File ACL: owner and SYSTEM only |
| 1a | Restore test (scratch database, dropped afterwards) | 65 TABLE DATA entries; 56 migrations, head `20261017060000_quote_publish_lifecycle.sql`; 33 projects, 66 quotes, 42 invoices, 186 audit_events. Only error: `schema "public" already exists` (expected) |
| 1b | Supabase PITR / daily backup | not checked here (needs the Supabase dashboard); owner to confirm before §5.3 |
| 2 | n8n versions to roll back to | below |
| 3 | Airtable PRJ-2026-0031..0033 | below |
| 4 | Vercel deployment ids | **not recorded**: the Vercel connector returned 403 for team scope `tejesh1`, and no Vercel CLI is installed. The owner records them from the Vercel dashboard (Deployments, project `roofops-dashboard`) before §5.7 |

**n8n** (`versionId` = `activeVersionId` for all four; each has a single saved version):

| Workflow | Id | versionId / activeVersionId | Version name |
|---|---|---|---|
| 06 Airtable Changes → Postgres | `lD6BOf2dhZZpSoEH` | `9a2eb69e-fd26-4b67-b1b4-4b2d65d78423` | AC-13A: watch Completion Photos and Compliance Certificate |
| 03 Airtable Project Write-back | `gtUffpzbdGa0vbYj` | `737a7a66-abf7-46d3-ae82-5eae662ebdb8` | AC-13A: new records start with the completion gate To do |
| 05 Xero Draft Invoice | `Y2deCFTZzpv1uo8C` | `feab88d9-1753-4471-9167-cbfeff29225a` | AC-14C P2-D2: generation-aware reconcile and read-back |
| 07 Reconcile & Webhook Supervision | `EiBs0AB2NfOua7AM` | `a0ca9e60-a812-450f-b754-673882d0d656` | AC-14: pass verified Xero settlement to Postgres |

**Airtable** (Projects `tblvUPIoebC3zoacv`):

| Project | Record | Status | SWMS Signed | Materials Reviewed | Completion Photos / Compliance Certificate |
|---|---|---|---|---|---|
| PRJ-2026-0031 | `recDT4dQPmrjy5Mmu` | Planning | blank | blank | To do / To do |
| PRJ-2026-0032 | `reczFqGxwhWTHzpsP` | Planning | blank | blank | To do / To do |
| PRJ-2026-0033 | `recIxvTNChcgkctnx` | Planning | blank | blank | To do / To do |

§5.2 sets the two blank fields to To do; rolling it back means clearing them again.

## 2. Preflight (§4)

| Check | Expect | Result |
|---|---|---|
| `npm run integrity:check` | 0 FAIL | **30 PASS, 4 WARNING, 0 FAIL**. Warnings: `cancelled_open_purchase_orders` (PRJ-2026-0001), `accepted_has_project` (Q-2026-0031), open exceptions (EXC-0003, 0013, 0016, 0017), synthetic business date (2026-09-29). Last reconciliation 1227 minutes earlier (the nightly run) |
| `npm run security:check` | all pass | **all privilege checks pass** (16 of 16) |
| `schema_migrations` | 56, head `20261017060000` | **56, head `20261017060000_quote_publish_lifecycle.sql`** |
| Started jobs with open pre-start items | 0 rows | **0 rows** |
| Jobs the gate will hold | PRJ-2026-0031..0033 | **PRJ-2026-0031, 0032, 0033 (all PLANNING)** |
| Booked visits on cancelled / closed jobs | 0 rows | **0 rows** |
| Orders on cancelled / closed jobs | the §2 list | **PO-2026-0001 / SENT on PRJ-2026-0001 / CANCELLED** (as rehearsed) |
| Imported draft orders | 7 | **7**: PO-2026-0012, 0013, 0014, 0017, 0019, 0022, 0033 (all DRAFT) |
| n8n active states | 01–08 active; 09, 10 inactive | **as expected**: 00, 01, 02, 03, 04, 05, 06, 07, 08 Health, 08 Reissue active; 09 Staff Xero Dispatch and 10 Airtable Quote Publish inactive |
| n8n 06 errors today | none | **0** error or crashed executions of 06 (or any workflow) since 2026-10-22 13:00 UTC. 06 last ran 2026-10-21 15:29 UTC (success) |

The hosted integrity count today (30 / 4 / 0) differs from the rehearsal's starting point (28 / 6 / 0 on the
20 Oct dump) because hosted data has moved on since that dump; the total is the same 34 checks, with 0 FAIL in both.
After §5.3, expect 33 PASS (the three new checks) with the same warnings, give or take.

## 3. Not done (by instruction)

No migration (`db:load`), no n8n publish or activation change, no Airtable edit, no Vercel change, no reconcile run.
