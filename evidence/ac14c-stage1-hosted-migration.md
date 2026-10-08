# AC-14C Stage 1: hosted database migration (2026-10-08)

Authorised by the owner: the ten approved migrations only.
- **No n8n publishing or change, no dispatch credential, no Xero, Airtable or Drive call, no reissue, no restore, no
  demo.**
- No secret, connection string or host is recorded here.
- Branch `factory/ac14-integrity-followup` at `37148be` (clean, equal to GitHub) when it ran.

## 1. Before migrating

| Safeguard | Result |
|---|---|
| Branch, HEAD, tree, GitHub | `37148be`, clean, equal to the remote |
| Backup | `D:\Claude\roofops-backups\pre-ac14c-20261008-185203.dump` present; SHA-256 equals the recovery report (`6ff77749…27a4`); ACL owner + SYSTEM only |
| Hosted pre-flight, re-run immediately before (read-only) | **all PASS**: 33 migrations at `20261001120000` with checksums equal to the repo; no duplicate or live-duplicate draft writes; `approvals_action_type_check` present; action types known; **nothing in flight**; Demo tenant pinned; reconcile hash 64 |
| Ordering | the ten files sort `130000` … `220000` after the hosted head; no hosted migration outside the repo |
| Import step of `db:load` | hosted `import_batches` holds the bundle's dataset hash, so the importer returns `SKIPPED_ALREADY_IMPORTED` (one SELECT) |
| Pending approvals | 0, so the stricter generation-1 check of `190000` affects no existing approval |
| Reconciliation in progress | none (last run 2026-10-07 16:30 UTC) |
| Live workflow compatibility | read-only comparison of every live [RoofOps] workflow with the repo (below) |

**Live n8n workflows against the new schema** (read-only GETs; nothing changed):
- **04, 06 and 07 are identical to HEAD.** **05 is identical to `becd3c1`** (version `e6c57486…`). The full suites on
  `18be673` exercised exactly these database calls against the new schema.
- **Every live Postgres node** in 01–07 is identical to HEAD. 08-Health's one differing Postgres node calls only
  `wf_record_health`, which these migrations do not change. 00 has no Postgres node.
- Changed functions that live workflows call:
  - `wf_claim_side_effect` and `wf_complete_side_effect` (02, 03, 05; `210000`) change behaviour only for a
    generation ≥ 2 Xero draft write. None exists, and none can be created or dispatched in Stage 1.
  - `wf_reconcile_targets` and `wf_reconcile_xero_uncertain` (07; `150000`): 07 equals the tested HEAD.
- The only function dropped is `wf_reissue_dispatch(text,text)`. It was created and replaced inside this same
  deployment, and nothing live calls it.

**Mixed-version operation is safe.**

## 2. Migration

`npm run db:load -- --hosted`, TLS **verified against `SUPABASE_CA_CERT`**, 2026-10-08 19:08:15–19:08:19 (+10:30),
**exit 0**.
- Applied, in order: `130000`, `140000`, `150000`, `160000`, `170000`, `180000`, `190000`, `200000`, `210000`,
  `220000` (33 skipped). Each ran in its own transaction; none failed.
- Import: "already imported; nothing to do".

## 3. After migrating

| Check | Result |
|---|---|
| Migrations | **PASS**: 43 recorded, **43 of 43 checksums equal the repo**, head `20261001220000`, none outside the repo |
| Integrity (read-only) | **PASS**: 28 PASS / 4 WARNING / **0 FAIL**. `reissue_transition_bound`, `done_has_proof`, `voided_invoice_has_no_xero_write` and `xero_invoice_state_verified` all PASS. The 4 warnings (`accepted_has_project`, `cancelled_open_purchase_orders`, `completed_awaiting_completion_items`, `open`) are **identical** to the pre-migration state (27 PASS / 4 WARNING, measured on the restored backup); the extra PASS is the new check |
| Security (`npm run security:check`, hosted) | **PASS: all 16**, including the two hosted-only checks (tenant `96643bb0-…` pinned; reconcile hash length 64). The workflow role has 22 functions (only `wf_reissue_dispatch` added, intended); the dashboard definer set is unchanged; nothing executable by PUBLIC; every table has RLS |
| Whole-database content (61 tables before, fingerprint = row count + MD5 of every row ignoring only the new `outbox.generation` key) | **57 tables byte-identical**, among them invoices, payments, approvals, outbox, external_links, xero_invoice_observations, audit_events, customers and projects. The only differences are the documented ones below |
| Documented changes, row by row (diffed against the restored pre-migration backup) | `app_settings`: **+2** (`invoice.reissue_roles` = `FINANCE,ADMIN`; `reissue.dispatch_token_sha256` = blank). `state_transitions`: **+2** (`invoice VOIDED>APPROVED`, `invoice_sync SYNCED>PENDING`). `state_machine_states`: **1 changed** (`invoice:VOIDED`, now not terminal). `schema_migrations`: +10. New table `invoice_xero_draft_generations`: **1** backfilled row. All other 180 configuration rows are identical |
| Ledger backfill | INV-2026-0039, generation 1, CREATED, not superseded; bound to the historic outbox key, the current Xero link, the pinned tenant and the invoice's approval (all true) |
| Outbox | 7 rows, all generation 1; **0 rows with generation ≥ 2**; the one draft write is DONE |
| Invoices and approvals | 39 invoices, 0 VOIDED, 1 FINAL; INV-2026-0039 still APPROVED/SYNCED. 11 approvals, 0 pending, **0 REISSUE_INVOICE** |
| Replacement dispatch | **disabled**: dispatch-token hash length 0 |
| Live 05 with the migrated schema | **PASS (static)**. Its three Postgres calls (`wf_claim_side_effect($1,$2,180)`, `wf_fail_side_effect(…)`, `wf_complete_side_effect($1,$2::jsonb)`) match the hosted signatures exactly, and `roofops_workflow` may execute them (SECURITY DEFINER). Its nodes equal `becd3c1`, and its database calls equal HEAD's, which the full suites ran against this schema with generation-1 behaviour unchanged |

**Limitation, stated.** I tried a live, read-only probe of 05's claim. It cannot be done read-only:
`wf_claim_side_effect` issues an `UPDATE` (refused in a READ ONLY transaction even when it matches no row; nothing
was written). A write-then-rollback probe on hosted was **not** run, because it is not authorised. The first real
exercise of 05 on the new schema is the next generation-1 invoice approval, or Stage 2.

**Clean-up:** the local pre-state copy and temporary files were removed. The older container dump
(`/tmp/roofops-pre-ac14c-final.dump`) is untouched and still the owner's to delete.

**Result: Stage 1 PASS.** No stop condition was met. Stage 2 (05 republish, 08 creation with execution data not
saved, 07 settings, dispatch token) waits for the owner's separate approval.
