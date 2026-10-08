# AC-14C demo: hosted backup and recovery readiness (2026-10-08)

Authorised by the owner: hosted backup and recovery-readiness verification only.
- **No hosted write, migration, setting change, n8n change, or Xero, Airtable or Drive call.**
- No backup content, connection string or credential is recorded here or in Git.
- Branch `factory/ac14-integrity-followup` at `0e288fb` (clean, equal to GitHub) when it ran.

## 1. The backup

| Item | Value |
|---|---|
| File | `D:\Claude\roofops-backups\pre-ac14c-20261008-185203.dump` (outside the repo) |
| SHA-256 | `6ff777494d3298eb16ed496c151e156401c9a0919e8742774fd06bda9d5e27a4` (recorded beside it as `.sha256`; the container copy and the host copy were checked equal before the container copy was removed) |
| Size, time | 843,319 bytes; pg_dump ran 2026-10-08 18:52:03–18:52:16 (+10:30) |
| Source | hosted RoofOps database, PostgreSQL **17.6**, schema `public` (all RoofOps data: 61 tables, 7,334 rows; RoofOps uses no Supabase Auth or storage schema), state before any AC-14C migration (33 migrations, head `20261001120000`) |
| Tool, format | `pg_dump` 17.11 (local container), custom format, ownership and privileges kept in the archive |
| Transport | TLS `sslmode=verify-full`, with `sslrootcert` = the owner-downloaded Supabase Root 2021 CA (fingerprint-checked in the pre-flight); the connection string was passed by environment variable and cleared afterwards |
| Access | folder and file ACL: inheritance removed; only the owner's account and SYSTEM (FullControl) |
| Git | `secrets/` excluded by `.gitignore` and `.git/info/exclude`; the backup folder is outside the work tree; nothing tracked or staged |

## 2. Verification

| Check | Result |
|---|---|
| Archive readable (`pg_restore --list`) | **PASS** (exit 0) |
| Contents (TOC counts) | 61 TABLE + 61 TABLE DATA, 99 FUNCTION, 22 VIEW, 42 TRIGGER, 26 INDEX, 112 CONSTRAINT + 108 FK CONSTRAINT, 61 row-security entries, 5 SEQUENCE + 3 SEQUENCE SET, 8 DEFAULT, 3 COMMENT, 186 ACL, 1 SCHEMA |
| Isolated test restore | **PASS**. A brand-new local database (`roofops_restore_test_…`) in the local container, never hosted, restored with `--no-owner --no-privileges`. The single error, `schema "public" already exists`, is expected for any new database |
| Data equality, hosted vs restored | **PASS: 61 of 61 tables identical** in row count *and* content hash (MD5 of every row, `collate "C"` ordering, session `TimeZone=UTC` and `extra_float_digits=0` matched to hosted). The first pass differed in 38 tables only because the local session rendered `timestamptz` in Australia/Brisbane; with the session matched, all are equal |
| Schema equality | **PASS**: functions 99/99, views 22/22, triggers 42/42, indexes 138/138, constraints 410/410, RLS tables 61/61, policies 0/0 |
| Integrity inside the restored copy | **PASS**: 27 PASS, 4 WARNING, 0 FAIL (the hosted baseline) |
| Clean-up | the test database dropped; my temporary files in the container removed |

**Limits, stated rather than assumed.**
- The test restore used `--no-owner --no-privileges`, because the Supabase roles (`anon`, `authenticated`, …) do
  not exist locally. The archive's 186 ACL entries were therefore **not** exercised. A restore into the hosted
  project would apply them; it has not been rehearsed there, by design.
- Cluster-level roles (the n8n and dashboard logins) are never in a database dump; they persist on hosted.
- **Supabase's own backups/PITR were not checked.** There is no Supabase management token here (no CLI login, no
  `SUPABASE_ACCESS_TOKEN`), and reading them needs the owner's dashboard: Database → Backups (scheduled backups,
  PITR) and the project's add-ons and plan. Nothing was changed.

**Restore procedure:** beside the file as `pre-ac14c-20261008-185203.dump.README.txt`.
1. Verify the checksum.
2. Rehearse into an isolated local database.
3. Restore hosted only as a last resort, before any reissue exists, and only by the owner's decision.

## 3. n8n 05 rollback version

**PASS.**
- Recorded in `evidence/ac14c-demo-preflight-hosted.md`: version `e6c57486-46f1-4e8a-9de9-b9f19a2f9cc9`, identical
  to `becd3c1`.
- The read-only definition captured during the pre-flight is saved as
  `D:\Claude\roofops-backups\n8n-05-e6c57486-46f1-4e8a-9de9-b9f19a2f9cc9.json` (versionId = activeVersionId =
  `e6c57486…`, 37 nodes; SHA-256 `bba06cbea9ece150ae73beec4faab52f173cd86991d7d650bc11916f84caaef8`).
- Rollback: `restore_workflow_version(Y2deCFTZzpv1uo8C, e6c57486-…)` and publish.

## 4. The demo subject: PRJ-2026-0002 (not altered)

**PASS: fully synthetic.**
- The dataset is the repo's canonical synthetic bundle. The README says "Every customer, supplier, address and amount
  is fictional", and `data/normalised/MANIFEST.json` has `synthetic_demo_data: true`.
- Every bundle customer email is `@example.com` (an RFC 2606 reserved domain), and every phone number uses the
  `0400 00…` placeholder prefix.
- **Hosted** PRJ-2026-0002 (COMPLETED) is the bundle chain Q-2026-0002 / CUST-0002 / PROP-0002.
- The customer's identity hash (`md5(name|email|phone)`) on hosted, `d6fe1c0a0250c4d645676c705a630723`, **equals**
  the bundle row's. The email domain is `example.com`; there is no ABN and no legal name; the customer is
  RESIDENTIAL with no other project.
- The project has two invoices, both imported bundle records: INV-2026-0002 PAID with one payment, and INV-2026-0032
  ISSUED. Both are `NOT_SYNCED` with no Xero link, matching `invoices.csv`.
- It has no final invoice and no pending approval. Its only external links are Airtable Records (project, customer).

## 5. Observation (owner action)

The local container holds an **older** dump, `/tmp/roofops-pre-ac14c-final.dump` (721,340 bytes, 2026-10-07 10:19
+10:00), left by an earlier session. Any process in the container can read it. It was not touched; the owner should
delete it or move it into the restricted folder.
