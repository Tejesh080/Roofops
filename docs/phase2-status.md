`# Phase 2 status: Real n8n + Airtable + Google Drive, Quote Accepted → Project
`
`**State: 🟡 partially live. Two blockers need you (n8n workspace, Google credential).**
`Nothing below is simulated; every "LIVE" line was executed against the real service and read back.
`
`## Live and verified
`
`| Item | Evidence |
`|---|---|
`| Hosted Postgres | Supabase, PostgreSQL 17.6, Sydney session pooler; migrations 000–500 applied; dataset \`0dd5b614…\` imported (batch \`243ef8f4-08fb-41d5-98c3-ab62f13560c6\`) |
`| Hosted verification | \`RUN_HOSTED_TESTS=1 npx vitest run test/schema.test.ts test/import.test.ts -t hosted\` → **50 passed** (read-only, or rolled back) |
`| Security fix found by testing | Supabase default privileges exposed 10 views, \`import_batches\` and 16 functions to \`anon\`. Now **0 / 0** for \`anon\` and \`authenticated\` (migrations 300 + 500, verified before and after) |
`| Placeholder identities removed | 65 fake Xero/Drive links deleted, 35 invoices → NOT_SYNCED, 60 documents → NOT_STORED; audited as \`data.correction\` |
`| Workflow control layer | \`wf_quote_accepted\`, \`wf_claim_side_effect\`, \`wf_complete_side_effect\`, \`wf_fail_side_effect\` deployed to hosted |
`| Least-privilege n8n DB login | \`roofops_n8n\` (member of \`roofops_workflow\`): EXECUTE on the 4 entry points; \`select … from projects\`, \`app_today()\` and audit inserts are **denied**. Verified by connecting as the role through the pooler. Password only in \`secrets/roofops-n8n-postgres.env\` (gitignored) |
`| Airtable base | **RoofOps Demo** \`appMc8V0Wm29tEeHQ\` (in "My First Workspace"; the API cannot create workspaces). 6 tables, 228 records |
`| Airtable read-back | Every record listed back from the real base and compared with hosted Postgres (business key, Postgres UUID, name/amount/status/date, links) and with create-time record IDs. **All checks passed**; 228 \`external_links (AIRTABLE, verified_at)\` written, audited as \`airtable.initial_load.verified\` |
`
`### Airtable tables created
`
`| Table | Table ID | Records |
`|---|---|---|
`| Customers | \`tblHKX79FJFHn5FDc\` | 40 |
`| Suppliers | \`tbloPJwCIcdIZQFVK\` | 6 |
`| Properties | \`tblSYcCqId9wTMg3c\` | 52 |
`| Quotes | \`tblzenPRNVV5O7lZP\` | 65 |
`| Projects | \`tblvUPIoebC3zoacv\` | 30 |
`| Purchase Orders | \`tbluIbl4zpMiAlMVw\` | 35 |
`
`Record ID ↔ business key maps and the raw read-backs are in \`data/airtable-load/\`. Examples:
`Q-2026-0041 → \`rec4MMzrBxFdppyVd\` · CUST-0001 → \`reci6DO3ni6fvb2DM\` · PRJ-2026-0001 → \`recAkVBilgUt3jyxa\`.
`
`## Blocked
`
`| # | Blocker | Why it blocks | What you need to do |
`|---|---|---|---|
`| B1 | \`N8N_BASE_URL\` = \`tejesh08.app.n8n.cloud\` is **not** a dedicated RoofOps workspace. It hosts 28 workflows (ARIE, Revenue Swarm, JobAI, a Binance testnet executor…) | You asked for a dedicated workspace and no reuse; deploying RoofOps here would mix credentials and executions | Create a **new** n8n Cloud workspace for RoofOps (paid plan: the n8n API is not available on the trial). Put its URL and API key in \`.env.local\` (\`N8N_BASE_URL\`, \`N8N_API_KEY\`). **Or** tell me explicitly to use \`tejesh08.app.n8n.cloud\` |
`| B2 | No **Google OAuth2 API** credential exists (only Google Sheets ones) | No way to create or read Drive folders | In the RoofOps workspace: Credentials → New → **Google OAuth2 API** → your Google Cloud OAuth client → Scope \`https://www.googleapis.com/auth/drive.file\` → **Sign in with Google** as tejesht08 → name it \`RoofOps Google Drive\` |
`| B3 | No RoofOps-scoped Airtable credential in the RoofOps workspace (the existing "Airtable account" is in the shared workspace, legacy \`airtableApi\` type) | n8n can't read quotes or write projects back | airtable.com/create/tokens → token \`roofops-n8n\`, scopes \`data.records:read data.records:write schema.bases:read webhook:manage\`, access **RoofOps Demo only** → n8n credential **Airtable Personal Access Token API**, named \`RoofOps Airtable\` |
`| B4 | n8n Postgres credential | n8n must call the \`wf_*\` functions as \`roofops_n8n\` | n8n → Credentials → New → **Postgres**, with values from \`secrets/roofops-n8n-postgres.env\` (host, port 5432, database \`postgres\`, user \`roofops_n8n.<ref>\`, password, SSL require) |
`| B5 | TLS verification to Supabase | Connections are encrypted but the server certificate isn't verified | Supabase dashboard → Database → SSL Configuration → download the certificate → save as \`secrets/supabase-ca.crt\` → set \`SUPABASE_CA_CERT=secrets/supabase-ca.crt\` in \`.env.local\` |
`
`Once B1–B4 exist I'll build and deploy the workflow via the n8n API, register the Airtable webhook, and run the E2E tests. Nothing gets reported as done until each side effect has been read back.
`
`## Workflow (designed; deploys when B1–B4 are cleared)
`
`\`\`\`
`Airtable: staff sets Quotes.Status = "Accepted"
`  │  Airtable webhook (tableData, Quotes) → push notification
`  ▼
`n8n Webhook ─► Airtable "list webhook payloads" (cursor) ─► keep records whose Status changed to Accepted
`  ▼
`Postgres  SELECT wf_quote_accepted(event)            [roofops_n8n; one transaction]
`  │   validate → idempotency claim (quote.accepted:Q:vN) → accept quote → project + checklist
`  │   + MATERIAL_REVIEW task → outbox rows → automation_events + audit_events
`  ├─ REJECTED  → Airtable Quotes: Automation Status = Rejected, message = issues   (read back)
`  └─ CREATED / DUPLICATE (+ pending side effects)
`        ▼
`     for each side effect:  wf_claim_side_effect(key)   (only one worker wins)
`        ├─ drive.ensure_project_folder
`        │     search Drive for appProperties.roofops_project_id → create folder if absent
`        │     files.get(folderId) → verify mimeType/parent/name
`        │     wf_complete_side_effect(key, {verified:true, folder_id, …})
`        ├─ airtable.project_writeback
`        │     upsert Projects (merge on RoofOps ID) + link Quote + Drive Folder URL
`        │     GET record → verify → wf_complete_side_effect(key, {verified:true, project_record_id})
`        └─ on error: wf_fail_side_effect(class, http, retry_after) → Wait → re-claim (bounded) or exception
`        ▼
`Airtable Quotes: Automation Status = "Project created" / "Duplicate ignored"   (read back)
`\`\`\`
`
`## Tests run this phase
`
`| Suite | Where | Result |
`|---|---|---|
`| All local suites (dates, normalise, fixtures, schema, import, workflow) | PGlite + Postgres 17 (Docker) | 165 passed, 3 skipped (PGlite-only skips for real-concurrency tests) |
`| Real concurrency races | Postgres 17, 20 rounds × 3 races | 60/60 passed (after fixing a real primary-key race found by this test) |
`| Hosted verification | Supabase | 50 passed |
`| Airtable read-back verification | Airtable API + hosted Postgres | 228/228 records, all fields matched |
`| Least-privilege role proof | Supabase pooler, as \`roofops_n8n\` | EXECUTE allowed; 3 forbidden operations denied |
