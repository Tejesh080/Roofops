# AC-14C hosted deployment and one supervised Xero Demo reissue: runbook

Branch `factory/ac14-integrity-followup`, checkpoint `5bcaddb` (code verified at `18be673`). Nothing in this file has
been run against a hosted system.

**Legend**
- 🔒 = needs the owner's explicit approval before it runs.
- 🟢 = local or read-only on the repo.

Commands are PowerShell, run from `D:\Claude\roofops`. **No command prints a secret.**

## 0. Local preparation (🟢, no hosted access)

| # | Action | Command / where |
|---|---|---|
| 0.1 | Confirm the checkpoint | `git fetch origin; git rev-parse HEAD; git ls-remote origin refs/heads/factory/ac14-integrity-followup` (equal, clean tree) |
| 0.2 | TLS: download Supabase's CA (Dashboard → Project Settings → Database → SSL Configuration → *Download certificate*, `prod-ca-2021.crt`) and keep it **outside the repo** | e.g. `D:\Claude\roofops-secrets\supabase-prod-ca-2021.crt`, then add `SUPABASE_CA_CERT=D:\Claude\roofops-secrets\supabase-prod-ca-2021.crt` to `.env.local` |
| 0.3 | Generate the dispatch token (never echoed) and its hash | see the block below |
| 0.4 | Backup folder outside the repo | `New-Item -ItemType Directory -Force D:\Claude\roofops-backups` |

```powershell
# 0.3 - token into .env.local (not printed); its SHA-256 (safe to show: only the hash is stored hosted)
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$tok = ($b | ForEach-Object { $_.ToString('x2') }) -join ''
Add-Content -Path .env.local -Value "REISSUE_DISPATCH_TOKEN=$tok"
$hash = node -e "process.stdout.write(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" $tok
Remove-Variable tok, b; $hash   # keep for step 3.4
```

**TLS.** With `SUPABASE_CA_CERT` set, `src/db/db.ts` connects with `ca` + `rejectUnauthorized: true`. Node then
verifies the chain *and* the hostname, which is the equivalent of `sslmode=verify-full`. Supabase documents this CA for
the session pooler (`*.pooler.supabase.com:5432`, which is what `SUPABASE_DB_URL` uses). So **a successful connection
means the server was verified**, and a wrong certificate fails with "self-signed certificate in certificate chain".
Without the CA the connection is encrypted but unverified; every hosted tool says so in its output.

## 1. Read-only pre-flight 🔒

| # | Action | Command |
|---|---|---|
| 1.1 | 🔒 The ten deployment checks, inside a READ ONLY transaction that is always rolled back (any write errors). The first connect also proves TLS (0.2) | `npx tsx scripts/sql.ts --read-only -f ops/reissue-demo-preflight.sql` |
| 1.2 | 🔒 Baselines | `npm run integrity:check` and `npm run security:check` (both read-only) |
| 1.3 | 🔒 n8n read: snapshot 05 (see §2) | n8n MCP `get_workflow_details` / `get_workflow_history` for `Y2deCFTZzpv1uo8C` |
| 1.4 | 🔒 n8n read: credentials connected (Xero `rjqe50LhcU1IRLBc` → Demo Company; Postgres `kWqjtv0gz7ref2EN` → `roofops_workflow`) and 05's "can be called by" (default `workflowsFromSameOwner` admits 08) | n8n UI → Credentials (test), 05 → Settings |

**Go criteria for 1.1** (`ops/reissue-demo-preflight.sql`, verified locally on a database built to the hosted head):
- rows 01, 01b, 02, 03, 04, 05, 06 and 08 are `true`. These are 33 migrations at `20261001120000`, checksums equal to
  the repo, no duplicate or live-duplicate draft writes, the `approvals_action_type_check` CHECK present with known
  `action_type` values only, nothing in flight, the Demo tenant pinned and the reconcile token hashed.
- Row 07 is the VOIDED-balance baseline.
- Row 09 confirms the demo approver EMP-900.
- Rows 10 list the COMPLETED projects; choose the **demo project** from those with `ok = true` (final preview OK,
  Airtable-linked, no final yet).

**Stop** if any of 01–06 or 08 is false.

## 2. Workflow 05: snapshot and rollback procedure

The repo records no live version ID for 05. Only `becd3c1` (original) and `0b9cc23` (reissue-aware) ever changed it.

1. 🔒 **Read** with `get_workflow_details(Y2deCFTZzpv1uo8C)` and record the **active version ID**. Save the full
   workflow JSON to `D:\Claude\roofops-backups\n8n-05-<versionId>.json`.
2. 🟢 **Compare** the live nodes with `git show becd3c1:n8n/05-xero-draft-invoice.sdk.ts`, checking especially the Claim,
   Reconcile Before Create and Verify Xero Read-Back code. If they differ, **stop**: someone edited 05 live, and the
   difference must be reconciled first.
3. **Rollback, if ever needed:** 🔒 `restore_workflow_version(Y2deCFTZzpv1uo8C, <recorded versionId>)` and publish.
   This is safe against the new database: generation 1 is unchanged. With a generation-2 write, the old 05 either
   refuses the same-numbered VOIDED/DELETED document (a person decides) or creates the replacement, which Postgres's
   claim and completion still re-prove.

## 3. Deployment 🔒

The order matters only for convenience. Both directions are compatible: the new 05 works on the old database, and the
old 05 works on the new one.

| # | Action | Command / where | Verify |
|---|---|---|---|
| 3.1 | 🔒 Logical backup of hosted `public` (read-only dump, stays outside the repo) | block below | the dump file exists and `pg_restore --list` reads it; also confirm Supabase's own daily backup/PITR status in the Dashboard |
| 3.2 | 🔒 Apply the 10 migrations `130000`–`220000` (each in its own transaction; stops at the first failure; the bundle import afterwards is idempotent) | `npm run db:load -- --hosted` | output lists the 10 as applied, import SKIPPED or IMPORTED; then `npm run integrity:check` (0 FAIL, `reissue_transition_bound` PASS) and `npm run security:check` (all PASS) |
| 3.3 | 🔒 05: update from the repo file and publish | n8n MCP `update_workflow(Y2deCFTZzpv1uo8C, n8n/05-xero-draft-invoice.sdk.ts)` then `publish_workflow` | the live Reconcile Before Create / Verify Xero Read-Back code equals the repo |
| 3.4 | 🔒 08: create from `n8n/08-reissue-dispatch.sdk.ts`. **Before publishing**, set Settings → Save failed / successful production / manual executions = *Do not save*, Save execution progress = *Do not save* (API: `{"saveDataErrorExecution":"none","saveDataSuccessExecution":"none","saveManualExecutions":false,"saveExecutionProgress":false}`), then publish | n8n MCP `create_workflow_from_code`, workflow settings, `publish_workflow` | webhook `POST /webhook/roofops/reissue/dispatch` active; settings read back as above |
| 3.5 | 🔒 07: the same four settings (its operator-triggered runs carry `RECONCILE_TRIGGER_TOKEN` in the webhook headers). Existing 07 executions may already hold that token: the owner deletes them in n8n and rotates the token (the token is a production credential: owner action) | n8n UI → 07 → Settings | settings read back |
| 3.6 | 🔒 Store the dispatch-token hash (`$hash` from 0.3, same PowerShell session; otherwise recompute it from `.env.local` without printing the token) | `npx tsx scripts/sql.ts "update app_settings set value = '$hash' where key = 'reissue.dispatch_token_sha256' returning key, length(value) as len"` | `len = 64`; `npm run security:check` all PASS |
| 3.7 | 🔒 Smoke test, **no Xero write** | `npm run reissue -- dispatch --invoice INV-2026-0039 --hosted` | `NO_REISSUE_QUEUED` (generation 1; nothing triggered); 08's execution list holds no saved data |

```powershell
# 3.1 - pg_dump 17 from the local container; the URL is passed by environment and never printed.
$env:PGURL = ((Select-String -Path .env.local -Pattern '^\s*SUPABASE_DB_URL\s*=').Line -split '=', 2)[1].Trim().Trim('"') + '?sslmode=require'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
docker exec -e PGURL roofops-postgres sh -c "pg_dump `"`$PGURL`" --schema=public --format=custom --no-owner --file=/tmp/pre-ac14c-$stamp.dump"
docker exec roofops-postgres pg_restore --list "/tmp/pre-ac14c-$stamp.dump" | Select-Object -First 5   # readable?
docker cp "roofops-postgres:/tmp/pre-ac14c-$stamp.dump" "D:\Claude\roofops-backups\pre-ac14c-$stamp.dump"
docker exec roofops-postgres rm "/tmp/pre-ac14c-$stamp.dump"; Remove-Item Env:PGURL
```

**Kill switch**, effective immediately at any time:
- 🔒 `npx tsx scripts/sql.ts "update app_settings set value = '' where key = 'reissue.dispatch_token_sha256' returning key"`
  refuses every dispatch. A reissue that is decided but not dispatched stays queued, and nothing reaches Xero.
- Also unpublish 08.

**Rollback by layer.**
- **Dispatch:** the kill switch plus unpublishing 08.
- **05:** §2.3.
- **Database:** keep it. `180000`–`220000` change only functions, grants and one setting. `150000` (an outbox column,
  indexes, a backfilled ledger table, triggers) and `170000` (the approvals CHECK, an index, state rows, an invoices
  trigger) change schema and data, and reversing them is destructive once a reissue exists.
- **Last resort**, before any reissue only: 🔒 restore the 3.1 dump (`pg_restore --clean`) **plus** delete the 10
  `schema_migrations` rows. This is the owner's decision.

## 4. The supervised demonstration: one synthetic invoice 🔒

Operator for every step: the owner, as **EMP-900** (synthetic demo FINANCE approver, mapped to the owner's Airtable
user), on the owner's machine. `SUPABASE_DB_URL` is held by the owner only. `<P>` is the demo project from 1.1 row 10;
`<INV>` is its new final invoice number.

| # | Step | Command / action | Pass criterion |
|---|---|---|---|
| 4.1 | 🔒 Airtable: on project `<P>`, Invoice Action = *Prepare*; check the preview; then *Approve* (04 → 05 creates the Xero Demo DRAFT) | Airtable UI | `npx tsx scripts/sql.ts --read-only "select i.invoice_number, i.status, i.sync_status from invoices i join projects p on p.id = i.project_id where p.project_number = '<P>' and i.invoice_type = 'FINAL'"` gives APPROVED / SYNCED |
| 4.2 | 🟢 Record generation 1 | `npm run reissue -- status --invoice <INV> --hosted` | generation 1 CREATED; note `xero_invoice_id` (old) and `xero_invoice_number` |
| 4.3 | 🔒 **Xero mutation:** delete that DRAFT in the Xero Demo Company UI | Xero UI | Xero shows it DELETED |
| 4.4 | 🔒 Reconcile: observe, then repair (one run each; Airtable quota) | `npm run reconcile -- --dry-run` then `npm run reconcile` | `<INV>` becomes VOIDED, reason "Deleted in Xero (verified by reconciliation …)" |
| 4.5 | 🔒 Request | `npm run reissue -- request --invoice <INV> --by EMP-900 --reason "Xero Demo proof: draft deleted, customer still owes the job" --hosted` | `REISSUE_REQUESTED`; note `<APR>` |
| 4.6 | 🔒 Decide | `npm run reissue -- decide --approval <APR> --by EMP-900 --note "supervised Xero Demo proof" --hosted` | `REISSUE_QUEUED`, generation 2 |
| 4.7 | 🔒 Exactly one reissue is queued, and it is `<INV>` | `npx tsx scripts/sql.ts --read-only "select i.invoice_number, o.generation, o.status from outbox o join invoices i on i.id = o.aggregate_id where o.topic = 'xero.create_draft_invoice' and o.generation >= 2 and o.status <> 'DONE'"` | exactly one row: `<INV>`, 2, PENDING |
| 4.8 | 🔒 Dispatch exactly `<INV>` generation 2 | `npm run reissue -- dispatch --invoice <INV> --hosted` | `REISSUE_CREATED` (exit 0) |
| 4.9 | 🔒 Xero read (UI) | Xero Demo UI | a new DRAFT with the **same number**, a **new InvoiceID**, the same contact, reference and totals; the old document still DELETED |
| 4.10 | 🟢 RoofOps state | `npm run reissue -- status --invoice <INV> --hosted` | APPROVED / SYNCED, generation 2 CREATED, `xero_link` = the new InvoiceID ≠ 4.2's |
| 4.11 | 🔒 Consistency | `npm run reconcile -- --dry-run`, `npm run integrity:check`, `npm run security:check` | 0 drift for `<P>`; 0 FAIL; all PASS |
| 4.12 | 🔒 Negative checks (no Xero write) | `dispatch` again; `decide --approval <APR>` again | `REISSUE_CREATED` without a trigger; `ALREADY_PROCESSED` |
| 4.13 | 🔒 Close the window | kill switch (§3), or keep the hash for later demos (owner) | `security:check` PASS |

**Single target (proven in `18be673` on both engines).**
- `wf_reissue_dispatch` lists at most the named invoice's current generation ≥ 2 write when it is due and proven.
- 08 hands 05 only a write matching the body's selection.
- The CLI sends the selection read from `<INV>`'s current generation.
- Only 04 (generation 1 only, including approval replays) and 08 can run 05, and nothing sweeps the outbox.

Step 4.7 confirms on hosted that `<INV>` is the only queued reissue.

**Stop and roll back** (kill switch, then diagnose; leave the data in place) if any of these happens:
- a pre-flight row is false;
- a migration fails;
- integrity shows a FAIL or security a FAIL;
- 4.7 shows other than exactly one row;
- dispatch returns anything but `REISSUE_CREATED`;
- Xero shows two live documents with that number;
- the link points to the old InvoiceID;
- an unrelated outbox row changed;
- 08 saved execution data.

If Xero **rejects the duplicate number** (`REISSUE_NOT_CREATED` with Xero's validation message), the same-number
replacement is not possible in Xero. Stop: the fallback (a suffixed number or a credit note) is the owner's design
decision. A failed write leaves nothing linked.

## 5. Operator authentication

**For this one supervised demo**, the smallest safe approach adds no code:
- the owner is the only person holding `SUPABASE_DB_URL`, and runs every step personally as EMP-900;
- the data is synthetic and the tenant is Xero Demo;
- 4.7 confirms there is exactly one reissue;
- the kill switch closes the window afterwards (4.13).

The audit trail records EMP-900 and the approval numbers. Identity is asserted, not authenticated, and that is accepted
for this demo only.

**Production requirement.** Reissues must not run on the owner credential, which can impersonate anyone and bypass
triggers.
- One personal Postgres `LOGIN` role per FINANCE/ADMIN person, each a member of a `roofops_reissue_operator` group.
  The group may execute only `ops_reissue_request` / `ops_reissue_decide` and a SECURITY DEFINER status read.
- The login is mapped to the employee in `employee_external_identities`, which needs a `POSTGRES` provider.
- The functions take the actor from `session_user` and refuse a mismatched `--by`.
- The decider must differ from the requester (four-eyes).
- The CLI uses the person's own URL. The owner credential stays with deployment only.

The alternative is Airtable as the authenticated surface, as AC-03's invoice approvals already are.
