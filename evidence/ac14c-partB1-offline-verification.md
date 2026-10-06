# AC-14C Part B1 offline verification: explicit, single-live Xero draft generations

**FIXED OFFLINE, NOT HOSTED/DEPLOYED.**

Facts and command output only. Nothing here was run against a hosted system; no deploy, no production credentials, no
Xero, Airtable, n8n or Supabase call. Everything below is local: PGlite and a locally installed PostgreSQL 17 container
(`roofops-postgres`) at `127.0.0.1:54322`.

- Defect: AC-14C in [docs/defect-ledger.md](../docs/defect-ledger.md) (Part B1 of A/B1/B2/C; B2 and C follow).
- Migration: `supabase/migrations/20261001150000_one_live_xero_draft_generation.sql` (new file; no applied migration
  was edited, and `git status` shows no modified migration).
- Tests: `test/xero-generations.test.ts` (new; 13 cases, run on both engines = 26 test results).
- Migration SHA-256: `710a22b5db1e1d0d3d0be9928cd1ffa122b1908e9242027d31b70455e7663d10` (prefix `710a22b5`).
- Branch: `factory/ac14-integrity-followup`, base `153d87b` ("AC-14C-A: a Xero-verified deletion follows the void
  path"). Commit: `AC-14C-B1: Xero draft generations are explicit and single-live`.
- Reference read, never applied and never modified: `backups/ac14c-b1-partial.sql` / `.patch`. Its HEAD-verified
  replacement bodies, the `outbox.generation` column and the two index names were reused; its Part B2 content
  (`REISSUE_INVOICE`, the `APPROVED/ISSUED/VOIDED -> PENDING` state edges, `invoice_reissue_guard`) was deliberately
  left out, and it has no generation-aware idempotency keys, no ledger maintenance for new writes and no stale-read
  handling, so it could not be applied as it stands.

## 1. What Part B1 is

Today a final invoice has at most one draft write, and eight separate places ask the database for "the draft write" of
an invoice with a scalar subquery. A replacement draft (Part B2's supervised reissue) makes that question ambiguous:
two writes exist, one superseded and one current. Part B1 prepares the storage, the maintenance and every read for
that, so that when B2 opens a second generation nothing has to be rewritten:

- the write itself carries its generation, and the database refuses two live drafts for one invoice;
- a durable ledger records every generation (its status, its Xero InvoiceID/number, its bound tenant, its approval,
  who opened it, and when/why it was superseded), backfilled from the history that already exists;
- every "the draft write" lookup reads the current generation only, and a superseded Xero InvoiceID is inert;
- idempotency keys are generation-aware, so a replacement draft never reuses a key Xero has already seen;
- single-generation behaviour is byte-identical to before (the existing suites are the proof, §6).

Part B1 opens no generation by itself: until B2 lands, a second generation can only be written directly (which is what
the tests do), and the constraints keep that honest.

## 2. The migration

1. **`outbox.generation`**: `int not null default 1` + `outbox_generation_positive` (`generation >= 1`);
   `outbox_one_row_per_draft_generation` unique `(topic, aggregate_id, generation) where topic =
   'xero.create_draft_invoice'`; `outbox_one_live_draft_per_invoice` unique `(aggregate_id) where topic =
   'xero.create_draft_invoice' and status in ('PENDING','DISPATCHING')`. DONE and dead-lettered FAILED rows are
   history: they do not block a replacement.
2. **Ledger table `invoice_xero_draft_generations`**: `invoice_id`, `generation` (check `>= 1`), `status` (check in
   `PENDING/DISPATCHING/CREATED/FAILED/UNKNOWN/SUPERSEDED`), `outbox_idempotency_key`, `xero_invoice_id`,
   `xero_invoice_number`, `tenant_id`, `approval_id`, `opened_by` (`workflow` / `operator:<code>`), `created_at`,
   `updated_at`, `superseded_at`, `superseded_reason`; unique `(invoice_id, generation)`
   (`invoice_xero_draft_generations_invoice_id_generation_key`); `invoice_xero_draft_generations_superseded_consistency`
   (`(status = 'SUPERSEDED') = (superseded_at is not null)`); partial unique
   `invoice_xero_draft_generations_one_live (invoice_id) where superseded_at is null`; lookup index
   `..._invoice_idx (invoice_id, generation desc)`; RLS enabled, `revoke all … from public`. The migration's own run
   backfills it and reports the number of rows written.
3. **`invoice_xero_draft_generations_backfill()`** (idempotent, `security definer`, returns the row count): inserts one
   generation row per existing draft write and **only inserts**. Key and timestamps come from the outbox row, the
   number and bound tenant from its payload, the approval from the invoice, and the Xero InvoiceID from the invoice's
   verified XERO Invoice link. Mapping precedence: invoice `sync_status = 'UNKNOWN'` ⇒ `UNKNOWN`, otherwise
   `DONE ⇒ CREATED`, `PENDING/DISPATCHING` mirrored, everything else (`FAILED`, dead-lettered) ⇒ `FAILED`
   (`xero_draft_ledger_status`, shared with the maintenance triggers). `on conflict do nothing`, so a rerun inserts
   nothing and rewrites nothing.
4. **Generation-aware keys** (frozen formats, used by the writer and every test fixture):
   `xero_draft_outbox_key(uuid, int)` = `xero:invoice:<id>` for generation 1, `xero:invoice:<id>:g<n>` otherwise;
   `xero_draft_provider_key(uuid, int)` = `roofops-<id>` / `roofops-<id>-g<n>`. Generation 1 is byte-identical to the
   keys this schema has always queued.
5. **`outbox_current(topic, aggregate_id)`** (one definition of "the current write": greatest generation, ties broken
   by `created_at` then `id`) and **`xero_draft_superseded_ids(invoice)`** (the Xero InvoiceIDs of superseded
   generations; empty for every invoice that never went through a reissue).
6. **Ledger maintenance for new writes** (triggers, not caller discipline): `outbox_xero_draft_generation_open`
   (INSERT opens the generation row from the write and the invoice), `outbox_xero_draft_generation_mirror` (status
   transitions: `PENDING/DISPATCHING` mirrored, `DONE ⇒ CREATED` capturing the verified link's InvoiceID plus the
   number and tenant, `FAILED ⇒ FAILED`), and `invoices_xero_draft_generation_sync` (the invoice's `sync_status`,
   which `wf_fail_side_effect` records *after* closing the write: `UNKNOWN` ⇒ ledger `UNKNOWN`, cleared again when
   reconciliation proves the draft absent). None of them ever touches a `SUPERSEDED` row, and only a reissue (B2) may
   supersede.
7. **Writer**: `wf_invoice_decide_core` queues the generation with the helpers (never a hand-built key) and the
   wrapper `wf_invoice_decide` is untouched.
8. **Generation-aware replacements of the eight scalar lookups**: `xero_record_settlement`, `wf_reconcile_targets_core`,
   `wf_reconcile_targets`, `v_airtable_expected`, `invoice_void_guard`, `wf_reconcile_xero_uncertain`,
   `invoice_xero_state`, `integrity_check`. Reconciliation targets and reads the current generation only; a superseded
   Xero InvoiceID is discounted (uncertain-write recovery returns `PROVEN_ABSENT` when Xero only shows the superseded
   document); `done_has_proof` applies to the current generation; a local void/claim with two generations present
   refuses with the guard's documented message instead of raising a multi-row SQL error. The AC-05/AC-14B/AC-14C-A
   void exemption and its ordering clause are behaviour-identical (the guard body is the reference's, with the current
   generation as the row it reads).
9. **Privileges**: blanket `revoke execute on all functions in schema public from public;`, the new functions revoked
   from both roles, `integrity_check()` still granted to `roofops_dashboard`, `wf_reconcile_targets` /
   `wf_reconcile_xero_uncertain` still granted to `roofops_workflow` (§5).

## 3. Red before, green after

Command: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest run test/xero-generations.test.ts`,
first with the new migration moved aside, then restored (SHA-256 `710a22b5…` verified identical).

```
# WITHOUT 20261001150000
 Failed Suites 2   (the backfill describe cannot run: the migration file is absent)
 Failed Tests 22
 error: relation "invoice_xero_draft_generations" does not exist
 column "generation" of relation "outbox" does not exist
 error: function xero_draft_outbox_key(unknown, integer) does not exist
 Test Files  1 failed (1)
      Tests  22 failed | 4 skipped (26)

# WITH 20261001150000
 Test Files  1 passed (1)
      Tests  26 passed (26)
```

Every failure is a missing object or missing column - the tests are non-vacuous, and no case passes for an unrelated
reason before the migration exists.

## 4. The backfill, proven non-vacuously (VAL-GEN-001)

The backfill describe builds the pre-B1 world itself: it copies the chain up to
`20261001140000_xero_deletion_follows_the_void_path.sql` into a temp directory, migrates a fresh database with it
(`migrate(db, dirA)`, so the B1 migration is genuinely absent), imports the bundle, then drives the **real** path
(n8n 04's prepare/approve, 05's claim/complete-with-proof/fail) to leave draft writes in every status:

| fixture write | state left behind | expected ledger row |
|---|---|---|
| PRJ-2026-0004 | queued (`PENDING`) | `PENDING`, generation 1, the write's key/number/tenant |
| PRJ-2026-0002 | claimed (`DISPATCHING`) | `DISPATCHING` |
| PRJ-2026-0001 | completed with proof (verified link) | `CREATED` + the linked Xero InvoiceID |
| PRJ-2026-0005 | ambiguous failure, retried 4×, dead-lettered | `UNKNOWN` (the invoice's sync wins over the write's `FAILED`) |
| PRJ-2026-0007 | fixture row: closed `FAILED`, retry pending, sync `PENDING` | `FAILED` |
| PRJ-2026-0006 | fixture row: closed `FAILED`, `next_attempt_at = 'infinity'`, sync `FAILED` | `FAILED` |

Only four COMPLETED projects in this dataset can be final-invoiced (0003 has an unapproved draft, 0006/0008 are
over-billed, 0007 is missing completion documents), so the last two rows are fixture writes of exactly the shape this
schema already holds. The migration is then applied by the same migrate runner (`migrate(db, dirB1)`, which reports
`applied = [B1_FILE]` and `skipped` = the 35 Part A files). Assertions: exactly six ledger rows (non-zero, no more),
each with the mapping above, key and `created_at` equal to the write's, the Xero InvoiceID equal to the verified link,
and a rerun of the backfill inserting `0` rows and leaving every row's `to_jsonb` byte-identical. VAL-GEN-011
fingerprints invoices, outbox (excluding the new column), observations, approvals and audit events before and after
the migration: identical counts and content md5.

## 5. Ablation proofs (applied to the new migration, run, reverted)

Each clause was neutralised in turn, its targeted cases run on both engines, then the migration was restored from a
copy of the pristine file and its SHA-256 `710a22b5…` re-verified byte-identical before the green re-run.

| Ablation | Change made | Test red | After restore |
|---|---|---|---|
| (i) one-live protection removed | `create unique index outbox_one_live_draft_per_invoice` → `create index` | **VAL-GEN-003** `Tests 2 failed | 24 skipped (26)` ("expected rejection: insert into outbox …") | `2 passed` |
| (ii) generation-aware idempotency removed | `xero_draft_outbox_key` returns the generation-1 key for every generation | **VAL-GEN-005** `Tests 2 failed | 24 skipped (26)` (`expected { …(6) } to deeply equal { …(6) }`) | `2 passed` |
| (iii) historical Xero ID preservation removed | backfill `on conflict do nothing` → `do update set status, xero_invoice_id, xero_invoice_number, tenant_id, updated_at` | **VAL-GEN-001** `2 failed` (`expected 6 to be +0` on the rerun) and **VAL-GEN-006** `2 failed` (the superseded row's InvoiceID/number rewritten) | `26 passed` |

Ablation (iii) is the "never rewrite history" claim: with the backfill allowed to update, the superseded generation
loses the Xero InvoiceID it produced and the rerun stops being a no-op.

## 6. Validation runs

| Check | Exact command | Result |
|---|---|---|
| New suite, both engines | `TEST_DATABASE_URL=… npx vitest run test/xero-generations.test.ts` | `Test Files 1 passed (1)`, `Tests 26 passed (26)` |
| Affected suites, both engines | `TEST_DATABASE_URL=… npx vitest run test/xero-generations.test.ts test/xero-settlement.test.ts test/invoice-void.test.ts test/invoice-approval-binding.test.ts test/xero-tenant-binding.test.ts test/state-integrity.test.ts test/dashboard.test.ts test/billing-entitlement.test.ts test/schema.test.ts test/import.test.ts test/xero-ambiguous-create.test.ts test/reconcile-07-uncertain-xero.test.ts test/invoice.test.ts test/workflow.test.ts` | `Test Files 14 passed (14)`, `Tests 484 passed | 8 skipped (492)`, 0 failed |
| Full suite, PGlite + PostgreSQL 17 | `TEST_DATABASE_URL=… npx vitest run` | `Test Files 28 passed | 3 skipped (31)`, `Tests 630 passed | 35 skipped (665)` (baseline at `153d87b`: 604 passed, +26 = the new cases) |
| Lint / types | `npm run lint`, `npm run typecheck` | exit 0, no output |
| Fresh chain from zero | `docker exec roofops-postgres createdb -U postgres ac14c_b1_fresh`; `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/ac14c_b1_fresh npx tsx scripts/db-load.ts` | 36 migrations applied from zero, ending `20261001150000_one_live_xero_draft_generation.sql`; `schema_migrations` = 36; import `IMPORTED` |
| Integrity on the fresh DB | `DATABASE_URL=… npm run integrity:check -- --local` | **26 PASS, 5 WARNING, 0 FAIL**; `xero_link_only_when_synced` PASS, `done_has_proof` PASS (both now read the current generation) |
| Backfill determinism | `select invoice_xero_draft_generations_backfill();` twice on the fresh DB | `0` and `0` rows; ledger count `0` (the demo chain holds no draft writes) |
| Constraint/index names | `select conname from pg_constraint where conrelid = 'invoice_xero_draft_generations'::regclass;` `select indexname from pg_indexes where tablename='outbox';` | `…_generation_check`, `…_status_check`, `…_superseded_consistency`, `…_invoice_id_generation_key`, `…_one_live`, `…_invoice_idx`; `outbox_one_row_per_draft_generation`, `outbox_one_live_draft_per_invoice`; `relrowsecurity = true` |
| Privileges (offline replica of `scripts/security-check.ts`) | psql on the fresh DB: role/function/table privilege queries | see §7 |

## 7. Privileges

Read from the fresh chain (the same queries `scripts/security-check.ts` uses, which needs a hosted database and was
therefore skipped):

```
workflow role: executable functions      = the 21 pinned names (unchanged; test/schema.test.ts passes)
dashboard role: SECURITY DEFINER functions = app_today, at_link, integrity_check, invoice_final_preview,
                                             project_left_to_bill_after_final, project_over_billing, sm_label,
                                             wf_invoice_prepare   (the existing allow-list, no new entry)
dashboard role: readable tables          = (none)
new helpers executable by either role    = none  (outbox_current, xero_draft_superseded_ids, the key helpers,
                                                  xero_draft_ledger_status, the backfill)
functions executable by PUBLIC           = (none)
tables without RLS                       = (none)   (includes invoice_xero_draft_generations)
ledger table privileges for the roles    = none
PUBLIC table grants                      = (none)
as roofops_dashboard: select count(*) from v_dashboard_projects = 30; drift_fields computes
```

## 8. What the new tests assert (VAL-GEN-001 … 011)

1. **VAL-GEN-001** (backfill describe): the six fixture writes above map exactly, non-vacuously, and a rerun inserts
   nothing and changes nothing.
2. **VAL-GEN-002** (three cases, real path): a first-time draft opens generation 1 and goes `PENDING → DISPATCHING →
   CREATED` with the Xero InvoiceID, number and tenant captured; a retryable failure mirrors `FAILED` while the retry
   is pending and returns to `DISPATCHING`/`CREATED` as the write progresses; a dead-lettered write shows `FAILED` with
   the invoice's sync recorded truthfully.
3. **VAL-GEN-003**: a second live draft write, a second write for the same generation, and a second non-superseded
   ledger row are each rejected with the exact constraint/index names.
4. **VAL-GEN-004**: a duplicate `(invoice_id, generation)` ledger row is rejected, and `SUPERSEDED` without
   `superseded_at` (and the reverse) is rejected by `…_superseded_consistency`.
5. **VAL-GEN-005**: generation 1 keys are byte-identical to the legacy keys and equal to the queued row's key;
   generations 2 and 7 are distinct, equal to the helper outputs, and no two generations share a key; the live
   `wf_invoice_decide_core` body calls both helpers and contains no hand-built key literal.
6. **VAL-GEN-006**: after a supersede with the replacement completed, the superseded row keeps its Xero InvoiceID,
   number, tenant and reason; every earlier outbox, approval, observation and audit row is still present; the old
   InvoiceID is still queryable from the ledger and the observations; the Airtable projection shows the **current**
   generation's number and the link that moved to the replacement.
7. **VAL-GEN-007**: with two generations present, `outbox_current`, `invoice_xero_state` and the projection all report
   the current generation (no multi-row error); a local void is refused with the documented message; the queued
   replacement is claimed per the current generation; and the AC-14C-A void exemption still fires when the linked
   document was verified deleted (the reissue's own reason), leaving the superseded history untouched.
8. **VAL-GEN-008**: an uncertain (dead-lettered) replacement generation is the one reconciliation targets; Xero
   answering with only the superseded document proves the replacement absent (`PROVEN_ABSENT`, the invoice ends
   `FAILED`, never linked); a settlement read of the superseded InvoiceID applies nothing; the superseded identity is
   still retrievable afterwards.
9. **VAL-GEN-009**: an ambiguous write records `UNKNOWN` in the ledger and the invoice's sync, is never `CREATED` or
   `FAILED`, and never links.
10. **VAL-GEN-010**: `integrity_check()` returns 0 FAIL on a fresh lifecycle, after a supersede, and after a
    superseded generation is present; `done_has_proof` applies to the current generation only (a DONE generation that
    is no longer current is history, not proof-by-sync).
11. **VAL-GEN-011**: the migration changed no invoice, outbox, observation, approval or audit row, and created no
    invoice or outbox row (before/after fingerprints).

## 9. Deviations from the design (and why)

1. **The projection view does not call `outbox_current()`.** `v_airtable_expected` is read by `roofops_dashboard`
   (through `v_dashboard_projects` → `invoice_final_preview`), and PostgreSQL checks a function used inside a view
   against the **caller's** privileges. Granting `outbox_current` to the dashboard role would add a SECURITY DEFINER
   function to that role, which `scripts/security-check.ts` pins to an exact allow-list, so the current-generation
   lookup is written out in the view instead (same rule, same ordering: greatest generation, then `created_at`, then
   `id`). Every other replacement uses `outbox_current()` as designed.
2. **Ledger maintenance is done by triggers**, not by the writer/worker calling ledger functions (the design allows
   either: "open on draft-write insert, mirror on status transitions"). This keeps every writer - including the
   existing 05 flow - correct without changing it, and it is what makes VAL-GEN-002's `PENDING → DISPATCHING →
   CREATED` and the retryable-failure round trip work through the real path.
3. **The two-generation state in the tests is fixture-built.** The real supervised reissue (the `REISSUE_INVOICE`
   approval, the new state edges, the link move at generation ≥ 2 completion, `invoice_reissue_guard`) is Part B2 by
   design; B1 provides the storage, the maintenance and the reads. The fixture writes the ledger row and the queued
   write directly, which is the only way to express a second generation before B2, and the constraints keep that
   honest.
4. **`xero_link_only_when_synced` is re-emitted generation-aware.** The B2 reissue legitimately leaves the superseded
   document linked while the replacement is queued, which the single-generation form of that AC-04 check would report
   as a FAIL. It now exempts a link whose Xero InvoiceID belongs to a superseded generation of the same invoice, and is
   otherwise unchanged (single-generation behaviour identical - `state-integrity`, `invoice-void` and the AC-14/AC-14B/
   AC-14C-A suites pass).

## 10. Observed, deliberately untouched (Part B2 follow-up)

- A local void whose linked document was verified deleted is allowed by the AC-14C-A exemption **even while a
  replacement generation is queued** (VAL-GEN-007's last block proves the exemption still fires). That is today's
  behaviour preserved verbatim; what should happen to a queued replacement when the invoice is voided is a B2
  decision (the reissue/void interaction), and B1 does not change the guard's ordering.
- Nothing in B1 opens, supersedes or reissues a generation: the ledger's `SUPERSEDED` state is only ever written by
  the tests until B2 lands.

## 11. SKIPPED (and why)

- `npm run security:check`: hard-wired to the hosted database (`hostedDbConfig()` needs `SUPABASE_DB_URL`). Its
  assertions were replicated offline against the fresh local database (§7).
- `npm run integrity:check` (hosted): skipped, no hosted access and no hosted database touched. The equivalent
  `-- --local` run was made against a throwaway PostgreSQL 17 database built from zero (§6).
- `test/live-phase2|3|6.test.ts` (35 tests): gated by `RUN_HOSTED_TESTS`, not set.
- No deploy, no migration applied to Supabase, no dry run, no reconciliation run, no Xero/Airtable/n8n call, no Xero
  write of any kind. AC-14C Part B1 is **verified offline**; the phase is not closed until B2 (the supervised reissue)
  and C (the integration sweep) land, and nothing here has been pushed.
