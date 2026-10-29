# AC-14C demo: read-only hosted pre-flight (2026-10-08)

Authorised by the owner for read-only inspection only. **No hosted write, no migration, no n8n change, no Xero, Airtable
or Drive call.** Branch `factory/ac14-integrity-followup` at `65ab588`. No secret, connection string or host name is
recorded here.

## 1. TLS to the hosted Postgres (Supabase session pooler)

| Check | Result |
|---|---|
| CA file | `secrets/prod-ca-2021.crt` (downloaded by the owner from the project's dashboard); `secrets/` ignored by `.gitignore:16` **and** `.git/info/exclude`; nothing tracked or staged |
| CA identity | `CN=Supabase Root 2021 CA`, self-signed, `CA:TRUE`, key usage Certificate Sign / CRL Sign, valid 2021-04-28 to 2031-04-26 |
| Fingerprint (SHA-256) | `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`. **Equal** to the root the pooler presented at the TLS checkpoint, recorded *before* the file was downloaded; that presented root was never trusted on its own |
| Chain presented | `*.pooler.supabase.com` ← Supabase Intermediate 2021 CA ← Supabase Root 2021 CA |
| OpenSSL, downloaded CA as the **only** trust anchor (`-no-CApath -no-CAstore`), hostname verified | `Verification: OK`, `Verified peername: *.pooler.supabase.com`, return code 0. Negative control (a wrong expected hostname): code 62, hostname mismatch |
| App configuration | `SUPABASE_CA_CERT` is a **file path** (`hostedDbConfig` reads it), set in `.env.local`; `hostedDbConfig()` returns `verified: true` with a CA equal to the downloaded file (the code falls back to unverified only if the path is missing, which it is not) |
| Node / `pg` 8.23 (the app's path: `ca` + `rejectUnauthorized: true`; `pg` always sets `servername` to the connection host) | the pre-flight connected verified. Negative controls refused **during the handshake**: the same server by IP gives `ERR_TLS_CERT_ALTNAME_INVALID`; the right host with a different public CA gives `SELF_SIGNED_CERT_IN_CHAIN` |

One earlier control was invalid, and it is recorded here. Passing `servername: 'wrong-host…'` to `pg` is overridden by
`pg` (`connection.js:117`), so that attempt verified against the real host and **logged in**, then disconnected without
running any SQL. The IP-address control above replaces it.

## 2. Pre-flight (`npx tsx scripts/sql.ts --read-only -f ops/reissue-demo-preflight.sql`, READ ONLY transaction, exit 0)

| Check | Result | Detail |
|---|---|---|
| 01 33 migrations, head `20261001120000` | **PASS** | 33 applied |
| 01b hosted checksums equal the repo | **PASS** | 0 mismatched or missing |
| 02 no invoice with two draft writes (150000 index) | **PASS** | 0 |
| 03 no invoice with two live draft writes (150000 index) | **PASS** | 0 PENDING/DISPATCHING |
| 04 `approvals_action_type_check` exists (170000) | **PASS** | present |
| 05 action types within the old list (170000) | **PASS** | `CREATE_INVOICE` ×11 only |
| 06 nothing in flight | **PASS** | no PENDING/DISPATCHING outbox row |
| 07 VOIDED baseline (160000) | **PASS** (info) | 0 VOIDED invoices, so 160000 changes no current balance |
| 08 Demo tenant pinned; reconcile hash; no reissue keys yet | **PASS** | tenant pinned true; reconcile hash length 64 |
| 09 demo approver | **PASS** | EMP-900, active FINANCE, mapped to the Airtable approver |
| 10 demo candidates (COMPLETED, Airtable-linked) | info | **PRJ-2026-0002** (final preview OK, remaining 15,155.98, no final) and **PRJ-2026-0005** (OK, 17,831.91, no final) are eligible. Not eligible: 0003 (unapproved INV-2026-0033), 0004 (already has INV-2026-0039), 0006/0008 (over-billed), 0007 (completion documents missing) |

**Migration hazards: none found.**
- No duplicate draft writes; the expected constraint exists.
- No unknown action types, so the restated CHECK validates.
- Nothing in flight.
- No VOIDED invoice whose balance would change.

**Schema conflicts: none.** The hosted checksums equal the repo.

**Unexpected pending writes: none.**

## 3. Live n8n workflow 05 (read only: n8n MCP `get_workflow_details` / `get_workflow_history`, and the n8n API GET)

| Item | Value |
|---|---|
| Workflow | `Y2deCFTZzpv1uo8C` "[RoofOps] 05 Xero Draft Invoice", active, not archived |
| **Live version** | `versionId` = `activeVersionId` = **`e6c57486-46f1-4e8a-9de9-b9f19a2f9cc9`** (the draft equals the active version); the **only** version in its history (created 2026-09-28 22:35 UTC, "Xero DRAFT invoice side effect v1 (demo-only, reconcile-before-create)") |
| Owner | team project "Roofops" (`4kSuZdSc0Opp3juv`), role owner |
| Settings | `{"executionOrder":"v1","availableInMCP":true}`: **no `callerPolicy`** (the instance default applies; 04 already calls it under that default), and **no execution-saving settings** (n8n's defaults save all executions; 05's executions never hold the dispatch token) |
| Credentials | Postgres `kWqjtv0gz7ref2EN`, Xero `rjqe50LhcU1IRLBc` |
| **Compared with the repo at `becd3c1`** (the expected deployed version) | **IDENTICAL**: 37 of 37 nodes (type, version, parameters, credentials, `onError`) and all 46 edges |
| Compared with HEAD | differs only in **Reconcile Before Create** and **Verify Xero Read-Back**, exactly the two nodes P2-D2 changed |
| Rollback target | version `e6c57486-46f1-4e8a-9de9-b9f19a2f9cc9`: restore it with `restore_workflow_version` and publish. A read-only copy of the definition was saved to the session scratchpad; the formal backup step is not done yet |

**Configuration drift: none** in 05.

Two details for the deployment:
- 08 must be created **inside the "Roofops" project**, so that 05's default caller policy admits it.
- 05's own number search asks Xero for `Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED`, so the
  superseded document is expected to be returned and filtered, as the P2-D2 tests assume. The recount excludes
  VOIDED/DELETED.

## 4. Blockers

None for the deployment steps. Still open, and each needs the owner's approval:
- the backup (runbook 3.1);
- the deployment itself (3.2–3.7), with the 07/08 execution-saving settings and the dispatch-token hash;
- the demo operator-identity acceptance (runbook §5);
- the choice of demo project: **PRJ-2026-0002** recommended, because PRJ-2026-0005 is the project `demo:reset`
  restores.
