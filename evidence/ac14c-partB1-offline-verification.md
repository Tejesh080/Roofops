# AC-14C Part B1 offline verification: explicit, single-live Xero draft generations, and a voided invoice that is not collectible

**FIXED OFFLINE, NOT HOSTED/DEPLOYED.**

Facts and command output only. Nothing here was run against a hosted system; no deploy, no production credentials, no
Xero, Airtable, n8n or Supabase call. Everything below is local: PGlite and a locally installed PostgreSQL 17 container
(`roofops-postgres`) at `127.0.0.1:54322`.

- Defect: AC-14C in [docs/defect-ledger.md](../docs/defect-ledger.md) (Part B1 of A/B1/B2/C; Part A shipped at
  `153d87b`, B1 closes with this file, B2 and C follow). The AC-14C row's "Known follow-up" line — `v_invoice_balances`
  still shows a deletion-voided invoice's full total while the dashboard ignores VOIDED rows — is resolved by B1b
  (§2.2, §6); the ledger row itself is updated by Part C's docs feature per the delivery map.
- Migrations (both new files; no applied migration was edited and `git status` shows no modified migration):
  - `supabase/migrations/20261001150000_one_live_xero_draft_generation.sql` (B1a), SHA-256
    `710a22b5db1e1d0d3d0be9928cd1ffa122b1908e9242027d31b70455e7663d10` (prefix `710a22b5`).
  - `supabase/migrations/20261001160000_voided_invoice_has_no_collectible_balance.sql` (B1b), SHA-256
    `59e21084532b484c5e1dd40b28006848736899ca6381b98a469042df478d7acd` (prefix `59e21084`).
- Tests: `test/xero-generations.test.ts` (B1a; 13 cases, 26 results) and `test/balance-read-model.test.ts` (B1b; 8
  cases, 16 results). Every case runs on PGlite and PostgreSQL 17.
- Starting SHA (branch point of the mission): `153d87bc43d30ec54377101c201a234d74248f21` ("AC-14C-A: a Xero-verified
  deletion follows the void path"). Branch: `factory/ac14c-integrity-followup`.
- Phase commits: `AC-14C-B1: Xero draft generations are explicit and single-live` (B1a, `2f3a13b`) and
  `AC-14C-B1: …` (B1b, the phase close — the exact commit and its presence on origin are recorded in §14).
- Reference read, never applied and never modified: `backups/ac14c-b1-partial.sql` / `.patch`. Its HEAD-verified
  replacement bodies, the `outbox.generation` column and the two index names were reused; its Part B2 content
  (`REISSUE_INVOICE`, the state edges, `invoice_reissue_guard`) was deliberately left out, and it has no
  generation-aware idempotency keys, no ledger maintenance for new writes, no stale-read handling and no balance fix,
  so it could not be applied as it stands.

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
- single-generation behaviour is byte-identical to before (the existing suites are the proof, §8);
- a VOIDED invoice — however it was voided — stops being collectible in `v_invoice_balances` (outstanding 0, never
  overdue) while the project's billing entitlement stays intact, so the debt remains billable and Part B2's reissue is
  what makes it collectible again through normal settlement states.

Part B1 opens no generation by itself: until B2 lands, a second generation can only be written directly (which is what
the tests do), and the constraints keep that honest.

## 2. The migrations

### 2.1 `20261001150000_one_live_xero_draft_generation.sql` (B1a)

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
   `wf_reconcile_xero_uncertain` still granted to `roofops_workflow` (§9).

### 2.2 `20261001160000_voided_invoice_has_no_collectible_balance.sql` (B1b)

The defect (measured in Part A: `{"paid": "0", "outstanding": "14664.49"}` on a row that was already `VOIDED`):
`v_invoice_balances` presented a voided invoice as money owed in all three void paths — the AC-14C-A deletion path
(the DELETED read is deliberately excluded from the Xero lateral so a deletion that moved money can never zero a live
debt, which leaves the local total-minus-payments fallback), the AC-14B Xero void path (the void is applied from
Xero's Status alone, so a voided document that still carries its original amounts drove the same full outstanding) and
the AC-05 local dead-letter void (no Xero document, no read, the fallback again). `is_overdue` was already false for a
`VOIDED` row (the old predicate required `ISSUED`/`PARTIALLY_PAID`); the defect was the outstanding figure and the
money-owed/overdue sums that read it.

The rule:

1. **`create or replace view v_invoice_balances`** keeps one row per invoice and keeps `amount_paid` as it was, but
   `outstanding` becomes `case when i.status = 'VOIDED' then 0::numeric else coalesce(xv.due, i.total_inc_gst -
   coalesce(pay.paid, 0))::numeric end`, and `is_overdue` states `i.status <> 'VOIDED'` explicitly before the existing
   predicate (non-voided rows keep today's rule byte for byte: `ISSUED`/`PARTIALLY_PAID`, `due_date < app_today()`,
   owed > 0). `days_past_due` is untouched, so the row's history stays readable.
2. **The Xero lateral is unchanged** — still the latest VERIFIED read of the linked InvoiceID (tenant-bound, because
   only a VERIFIED verdict for the exact linked `xero_invoice_id` reaches it) with `settlement <> 'DELETED'`. That
   exclusion is what keeps a money-moved deletion from silently zeroing a live debt, and it is what makes Xero's
   verified amounts win for every other invoice.
3. **Entitlement is deliberately untouched**: `project_billing`, `project_left_to_bill_after_final`,
   `invoice_final_preview` and `project_transition_guard` (the close gate) are not changed. `project_billing` never
   counts `VOIDED` as billed, so the debt stays "left to bill" and the close gate keeps refusing; after a reissue the
   new generation's normal settlement states make it collectible again (VAL-BAL-006, exercised by Part C).
4. **`v_dashboard_projects` was checked and is not stale**: its `final_inv` CTE selects only `i.status <> 'VOIDED'`, so
   a voided generation cannot surface as `XERO_DRAFT_CREATED` / `CREATING_IN_XERO` / `CHECKING_WITH_XERO` /
   `XERO_FAILED_SAFELY`, and its `final_invoice_sync` / `xero_invoice_id` columns stay null for it. No change was
   needed; `test/balance-read-model.test.ts` pins the truthfulness (a live draft still shows `XERO_DRAFT_CREATED`,
   the voided one shows the project's real `NOT_READY` state with the void reason as its blocker).
5. **`v_executive_kpis`** keeps driving `overdue_invoices` / `overdue_amount` from `is_overdue`, which a voided row no
   longer satisfies.
6. **Privileges**: no new function, table or grant. `create or replace view` keeps the view's owner and grants, so the
   dashboard's `SELECT` on `v_invoice_balances` is untouched; the tail restates the blanket revoke and the two role
   grants exactly as `20261001150000` left them (a no-op, kept so every migration's tail reads the same).

## 3. State transitions

Part B1 adds **no** state or transition: `state_machine_states` and `state_transitions` are unchanged, and
`npm run contract:export` regenerated `docs/state-machines.md` / `docs/source-of-truth.*` with **no file change**
(`contract: 98 fields; 10 machines, 103 legal transitions`; `git status` clean of docs). The void-family transitions
B1 exercises already existed — `APPROVED | ISSUED → VOIDED` through the AC-05/AC-14B/AC-14C-A paths — and `VOIDED`
remains terminal until Part B2 seeds the supervised reissue edge (`invoice VOIDED → APPROVED`,
`invoice_sync SYNCED → PENDING`). B1b changes only what a `VOIDED` row reports to readers.

## 4. Red before, green after (B1a)

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

## 5. The backfill, proven non-vacuously (VAL-GEN-001)

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

## 6. Red before, green after (B1b)

Command: `TEST_DATABASE_URL=… npx vitest run test/balance-read-model.test.ts`, first with the new migration moved aside
(a pristine copy was hash-verified before the move), then restored from that copy.

```
# WITHOUT 20261001160000
 FAIL  … [pglite] > VAL-BAL-001 a deletion-voided invoice reports outstanding 0 and is not overdue, …
 AssertionError: expected { paid: '0.00', …(3) } to deeply equal { paid: '0.00', …(3) }
   -   "outstanding": "0.00"
   +   "outstanding": "14664.49"
 FAIL  … [pglite] > VAL-BAL-002 a Xero-voided invoice reports outstanding 0 …  (same 14664.49)
 FAIL  … [pglite] > VAL-BAL-003 a locally voided invoice … received "outstanding": "15155.98"
 FAIL  … [pglite] > VAL-BAL-004 entitlement survives every void … (the first voided row still owes 14664.49)
 (each of the four red on [pglite] and on [postgres])
 Test Files  1 failed (1)
      Tests  8 failed | 8 passed (16)

# WITH 20261001160000 (restored byte-identical, SHA-256 59e21084…)
 Test Files  1 passed (1)
      Tests  16 passed (16)
```

The four red cases per engine are exactly the defect-pinning ones: the deletion void (VAL-BAL-001), the Xero void
(VAL-BAL-002), the local dead-letter void (VAL-BAL-003) and the entitlement loop that reads each voided row's balance
(VAL-BAL-004). They fail for the right reason — the voided row still reports its whole total as outstanding.
Recorded honestly: `VAL-BAL-005` (money-moved deletion stays fully collectible), `VAL-BAL-007` (dashboard
truthfulness) and the non-voided characterization case are **green before and after**; they are behaviour-preserving
pins (the deletion refusal and the dashboard filter are untouched by design), and their load-bearing role is proved by
ablation (v) and by the existing suites instead.

## 7. Ablation proofs (applied to the new migration, run, reverted)

Each clause was neutralised in turn, its targeted cases run on both engines, then the migration restored from a
hash-verified pristine copy (B1a `710a22b5…`, B1b `59e21084…`) and the green re-run made. Never committed.

| Ablation | Change made | Test red | After restore |
|---|---|---|---|
| (i) one-live protection removed (B1a) | `create unique index outbox_one_live_draft_per_invoice` → `create index` | **VAL-GEN-003** `Tests 2 failed \| 24 skipped (26)` ("expected rejection: insert into outbox …") | `2 passed` |
| (ii) generation-aware idempotency removed (B1a) | `xero_draft_outbox_key` returns the generation-1 key for every generation | **VAL-GEN-005** `Tests 2 failed \| 24 skipped (26)` (`expected { …(6) } to deeply equal { …(6) }`) | `2 passed` |
| (iii) historical Xero ID preservation removed (B1a) | backfill `on conflict do nothing` → `do update set status, xero_invoice_id, xero_invoice_number, tenant_id, updated_at` | **VAL-GEN-001** `2 failed` (`expected 6 to be +0` on the rerun) and **VAL-GEN-006** `2 failed` (the superseded row's InvoiceID/number rewritten) | `26 passed` |
| (iv) voided-balance rule removed (B1b) | the `case when i.status = 'VOIDED' then 0::numeric` branch replaced by the plain fallback expression | **VAL-BAL-001/002/003/004** `Tests 8 failed \| 8 passed (16)` (both engines; the voided rows owe 14664.49 / 15155.98 again) | `16 passed` |
| (v) the wrong rule: any DELETED read zeroes the row (B1b) | `case when exists (… o.settlement = 'DELETED') then 0::numeric …` | **VAL-BAL-005** (both cases) red, plus VAL-BAL-002/003/004: `Tests 10 failed \| 6 passed (16)` (a refused money-moved deletion silently zeroed a live debt) | `16 passed` |

Ablation (iii) is the "never rewrite history" claim; (iv) is the phase's headline rule; (v) proves that VAL-BAL-005 —
the money-moved deletion refusal staying fully collectible — is load-bearing rather than a happy accident, and that
the fix must key on the invoice's own status, not on the presence of a DELETED read.

## 8. Validation runs (the phase-closing battery)

| Check | Exact command | Result |
|---|---|---|
| New B1b suite, both engines | `TEST_DATABASE_URL=… npx vitest run test/balance-read-model.test.ts` | `Test Files 1 passed (1)`, `Tests 16 passed (16)`, exit 0 |
| Affected suites, both engines | `TEST_DATABASE_URL=… npx vitest run test/balance-read-model.test.ts test/xero-settlement.test.ts test/invoice-void.test.ts test/invoice-approval-binding.test.ts test/xero-tenant-binding.test.ts test/state-integrity.test.ts test/dashboard.test.ts test/billing-entitlement.test.ts test/schema.test.ts test/import.test.ts test/xero-generations.test.ts` | `Test Files 11 passed (11)`, `Tests 373 passed \| 5 skipped (378)`, 0 failed, exit 0 |
| **Full suite, PGlite only (phase close)** | `npm test` (no `TEST_DATABASE_URL`) | `Test Files 29 passed \| 3 skipped (32)`, **`Tests 340 passed \| 35 skipped (375)`**, 0 failed, exit 0 (baseline `153d87b`: 319 passed / 35 skipped; +13 B1a, +8 B1b) |
| **Full suite, PGlite + PostgreSQL 17 (phase close)** | `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test` | `Test Files 29 passed \| 3 skipped (32)`, **`Tests 646 passed \| 35 skipped (681)`**, 0 failed, exit 0, 286.79 s (baseline: 604 passed / 35 skipped; +26 B1a, +16 B1b) |
| Lint / types | `npm run lint`, `npm run typecheck` | exit 0, no output |
| Fresh chain from zero | `docker exec roofops-postgres createdb -U postgres ac14c_b1b_fresh`; `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/ac14c_b1b_fresh npx tsx scripts/db-load.ts` | **37 migrations applied (skipped 0)**, ending `20261001160000_voided_invoice_has_no_collectible_balance.sql`; `schema_migrations` = 37; import `IMPORTED` (batch `b3e27b37…`, dataset `0dd5b61419f7…`); `projects` 30, `invoices` 38; second run: `migrations applied: none (skipped 37)` |
| Integrity on the fresh DB | `DATABASE_URL=… npm run integrity:check -- --local` | **26 PASS, 5 WARNING, 0 FAIL**, exit 0 (`voided_invoice_has_no_xero_write` PASS, `done_has_proof` PASS, `closed_project_settled` PASS) |
| SQL probe: the rule is in the view | `docker exec roofops-postgres psql -U postgres -d ac14c_b1b_fresh -c "select pg_get_viewdef('v_invoice_balances'::regclass) like '%VOIDED%' …, like '%settlement <> ''DELETED''%' …"` | `has_voided_rule = t`, `keeps_deleted_exclusion = t` |
| SQL probe: voiding zeroes the row | same DB: `begin; … update invoices set status='VOIDED' … where id = (INV-2026-0001) … ; select … from v_invoice_balances …; rollback;` | BEFORE `ISSUED 0.00 paid / 3860.76 outstanding`; AFTER `VOIDED 0.00 / 0.00, is_overdue f`; rolled back |
| SQL probe: non-voided fallback unchanged | same DB: `select invoice_number, status, total, amount_paid, outstanding, total - amount_paid from v_invoice_balances where status in ('ISSUED','PARTIALLY_PAID') …` | INV-2026-0001/0010/0020/0025: `outstanding = total - paid` exactly (3860.76 / 23874.60 / 11600.57 / 3518.67) |
| Contract docs | `npm run contract:export` | `contract: 98 fields; 10 machines, 103 legal transitions`; **no file change** (`git status` clean of `docs/`) |
| Throwaway cleanup | `docker exec roofops-postgres dropdb -U postgres ac14c_b1b_fresh` | dropped, exit 0 |

## 9. Privileges

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

B1b adds no function, table or grant at all: `create or replace view v_invoice_balances` keeps the view's owner and its
grants, and its tail restates the blanket revoke plus the two existing role grants (a no-op). `test/schema.test.ts`
(the privilege pins) passes on both engines in §8.

## 10. What the new tests assert

`test/xero-generations.test.ts` (B1a, VAL-GEN-001 … 011):

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

`test/balance-read-model.test.ts` (B1b, VAL-BAL-001 … 007 plus a characterization case). Scenarios are built the real
way: n8n 04's prepare/approve, 05's claim/complete-with-proof (or a dead letter), and 07's recorded nodes against the
fake Xero handler, on PGlite and PostgreSQL 17:

1. **VAL-BAL-001** — the AC-14C-A deletion path: a final invoice goes `APPROVED → ISSUED` (Xero `AUTHORISED`, unpaid,
   backdated so it is overdue and in the executive KPIs' overdue figure), then a verified Xero `DELETED` (no money
   movement) voids it. Asserted: the read is `VERIFIED / DELETED` in the bound tenant and the void reason is the
   deletion reason; the balance row reports `0.00 paid / 0.00 outstanding / is_overdue false` while the row itself, the
   invoice number, the total, both observations, both applied transitions and the Xero link stay visible; and
   `v_executive_kpis.overdue_amount` drops by exactly the invoice's total.
2. **VAL-BAL-002** — the AC-14B Xero void path, with the voided document still carrying its original amounts: after
   `ISSUED` (overdue), a verified `VOIDED` read (`AmountDue` = total) voids the invoice; the balance row reports
   `0.00 / 0.00 / false` and the row's total stays readable.
3. **VAL-BAL-003** — the local dead-letter void (AC-05): 05 fails the write safely (nothing created in Xero), the
   operator voids it through `invoices.status`; the balance row reports `0.00 / 0.00 / false` with zero observations.
4. **VAL-BAL-004** — entitlement survives every void: all three paths at once; each voided invoice reports
   `outstanding 0.00`; `project_billing(...) ->> 'remaining'` stays `> 0` (14664.49 for the deletion-voided project)
   and never lists the voided invoice as billed; the close gate refuses each project (the deletion-voided one with the
   left-to-bill class itself); `invoice_final_preview` refuses with `final_voided` and names the void; and
   `project_left_to_bill_after_final` stays null for all three (no live final, so the entitlement — not that
   helper — is the debt's home; architecture §4.3 keeps it unchanged by design).
5. **VAL-BAL-005** (two cases) — a money-moved `DELETED` read is refused and the debt stays fully collectible: with
   `AmountPaid` 5000 (Xero says money moved) the read is recorded `VERIFIED / DELETED`, the invoice keeps `ISSUED /
   SYNCED` and the full outstanding, and the close gate still refuses; a credit (`AmountCredited` 100) and a local
   `payments` row likewise change nothing, and the refused reads stay queryable.
6. **VAL-BAL-007** — dashboard truthfulness: while the draft is live the project shows `XERO_DRAFT_CREATED` with the
   linked InvoiceID and no attention flag; after the verified deletion it shows `NOT_READY` with the void as its
   blocker, `final_invoice_sync` and `xero_invoice_id` null, and `outstanding_inc_gst` 0 — never a live-draft state
   (`XERO_DRAFT_CREATED` / `CREATING_IN_XERO` / `CHECKING_WITH_XERO` / `XERO_FAILED_SAFELY`) for the voided
   generation.
7. **Characterization** — `APPROVED` (no read yet: the local fallback), `ISSUED` (verified `UNPAID`), `PARTIALLY_PAID`
   (verified 5000 paid, outstanding = Xero's `AmountDue`, overdue while backdated) and `PAID` (nothing outstanding,
   and only then may the project close) keep exactly today's semantics, state by state.

VAL-BAL-006 (collectibility returning after a reissue) is not claimed here: it needs the reissue facility and is
exercised by the Part C lifecycle flows (as the validation contract says).

## 11. Deviations from the design (and why)

1. **The projection view does not call `outbox_current()`** (B1a). `v_airtable_expected` is read by
   `roofops_dashboard` (through `v_dashboard_projects` → `invoice_final_preview`), and PostgreSQL checks a function
   used inside a view against the **caller's** privileges. Granting `outbox_current` to the dashboard role would add a
   SECURITY DEFINER function to that role, which `scripts/security-check.ts` pins to an exact allow-list, so the
   current-generation lookup is written out in the view instead (same rule, same ordering: greatest generation, then
   `created_at`, then `id`). Every other replacement uses `outbox_current()` as designed.
2. **Ledger maintenance is done by triggers** (B1a), not by the writer/worker calling ledger functions (the design
   allows either: "open on draft-write insert, mirror on status transitions"). This keeps every writer - including the
   existing 05 flow - correct without changing it, and it is what makes VAL-GEN-002's `PENDING → DISPATCHING →
   CREATED` and the retryable-failure round trip work through the real path.
3. **The two-generation state in the B1 tests is fixture-built** (B1a). The real supervised reissue (the
   `REISSUE_INVOICE` approval, the new state edges, the link move at generation ≥ 2 completion,
   `invoice_reissue_guard`) is Part B2 by design; B1 provides the storage, the maintenance and the reads.
4. **`xero_link_only_when_synced` is re-emitted generation-aware** (B1a). The B2 reissue legitimately leaves the
   superseded document linked while the replacement is queued, which the single-generation form of that AC-04 check
   would report as a FAIL. It now exempts a link whose Xero InvoiceID belongs to a superseded generation of the same
   invoice, and is otherwise unchanged.
5. **B1b keeps `v_dashboard_projects` as it is** (pin, no change). The design said "pin this with a test, and if a
   stale `XERO_DRAFT_CREATED` can still surface for the voided generation, fix it minimally in this migration". The
   pin proves it cannot surface (the `status <> 'VOIDED'` filter already excludes the voided generation, and the
   `xero_invoice_id` / `final_invoice_sync` joins are keyed on that filtered CTE), so no change was made — a fix here
   would have been dead code.
6. **B1b's `is_overdue` states `i.status <> 'VOIDED'` explicitly** even though the old predicate already excluded a
   voided row. That is deliberate: the rule "a voided invoice is never overdue" is now written where a reader expects
   it, so a later change to the status test cannot silently make a voided row overdue. It is behaviour-preserving
   (proved by the characterization case and the existing `import`/`dashboard`/`xero-settlement` suites).
7. **B1b leaves `project_left_to_bill_after_final` alone** although VAL-BAL-004 mentions it. That helper answers "how
   much is left after the *final invoice*" and returns null when no live FINAL invoice exists (it selects non-voided
   finals); after a void there is no live final, so the debt lives in `project_billing`, the preview refusal and the
   close gate — exactly as architecture §4.3 specifies ("entitlement and 'left to bill' stay governed by
   `project_billing`"). The test asserts the null explicitly so the behaviour is pinned rather than assumed.
8. **B1b's local-void scenario goes through `invoices.status`** (the only supported local void path, per AC-05), not
   through a dead-letter-specific function: 05's write is failed safely first, which is the documented precondition.

## 12. Observed, deliberately untouched (Part B2 follow-up) and environment notes

1. **A local void whose linked document was verified deleted is allowed by the AC-14C-A exemption even while a
   replacement generation is queued** (VAL-GEN-007's last block proves the exemption still fires). **Decided
   (orchestrator, B1 close):** that is wrong for AC-14C; the exemption must apply only when the invoice's Xero draft
   writes are terminal. Part B2 refines `invoice_void_guard`'s ordering accordingly (architecture §4.2 item 13, pinned
   by `VAL-RIS-018`) and updates the B1 test that pins the old exemption-while-queued behaviour to assert the refusal
   instead. B1 does not change the guard.
2. **Nothing in B1 opens, supersedes or reissues a generation**: the ledger's `SUPERSEDED` state is only ever written
   by the tests until B2 lands.
3. **A second (orphan) worker session ran in this checkout during part 2.** At 06:37:51 a `npm test` process this
   session did not start appeared in the repository, and the B1b migration file was rewritten under this session's
   runs (the PGlite-only run at 06:34 produced internally inconsistent failures — some cases behaving as if the voided
   rule were absent, others as if a DELETED read zeroed the row). The file's SHA-256 was re-verified
   (`59e21084…`, unchanged) and the runs re-made with the hash checked before and after: PGlite-only 340/35 green
   (§8). The incident is reported for the orchestrator; no evidence in §8 comes from a run whose migration hash
   changed mid-run.

## 13. SKIPPED (and why)

- `npm run security:check`: hard-wired to the hosted database (`hostedDbConfig()` needs `SUPABASE_DB_URL`). Its
  assertions were replicated offline against the fresh local database (§9).
- `npm run integrity:check` (hosted): skipped, no hosted access and no hosted database touched. The equivalent
  `-- --local` run was made against a throwaway PostgreSQL 17 database built from zero (§8).
- `test/live-phase2|3|6.test.ts` (35 tests): gated by `RUN_HOSTED_TESTS`, not set.
- No deploy, no migration applied to Supabase, no dry run, no reconciliation run, no Xero/Airtable/n8n call, no Xero
  write of any kind.

## 14. Phase close: git status, commit, push

Everything in §1–§13 was produced on branch `factory/ac14c-integrity-followup` from the starting SHA
`153d87bc43d30ec54377101c201a234d74248f21`, on top of the B1a commit `2f3a13b`.

- Working tree at the close: `git status --short` showed only the intended files — the new B1b migration, the new
  `test/balance-read-model.test.ts` and this evidence file (plus, for B1a, the already-committed
  `20261001150000_one_live_xero_draft_generation.sql`, `test/xero-generations.test.ts` and this file's part-1 content).
  No backups, no scratch files, no `.env*`, no modified applied migration.
- Commit: `AC-14C-B1: a voided invoice is not collectible`, SHA `dd9c4c8bb8159048a5b1e2c3c2b23b6f2c699623` (`git rev-parse HEAD`),
  on top of `2f3a13b` (B1a) and the mission's starting SHA `153d87b`. The exact push output and the `git ls-remote`
  verification are recorded in §14.2 (committed immediately after the push, per the mission's phase-gate rule).

### 14.2 The push (recorded after it happened)

- Committed content verified byte-identical to the content every run in §8 tested: `git cat-file blob HEAD:<file>`
  hashed to SHA-256 `59e21084…` for the B1b migration and `a4f4cd87…` for `test/balance-read-model.test.ts`, equal to
  the working files' hashes.
- `git status --short`: empty before and after the push (only the three intended files were committed; no backups, no
  scratch files, no `.env*`, no modified applied migration).
- `git push origin "HEAD:refs/heads/factory/ac14-integrity-followup"` (exit 0):

  ```
   153d87b..dd9c4c8  HEAD -> factory/ac14-integrity-followup
  ```

- `git ls-remote origin` (exit 0, byte-exact, after the push):

  ```
  dd9c4c8  refs/heads/factory/ac14-integrity-followup     (len 42)
  dd9c4c8  refs/heads/factory/ac14c-integrity-followup    (len 43)
  ```

  The mission's branch — as named in `mission.md`, `architecture.md`, this branch's own tracking config and its
  reflog — is `factory/ac14-integrity-followup`; the feature description and `validation-contract.md` (VAL-DOC-001)
  also spell it `factory/ac14c-integrity-followup`. Both refs now carry the phase commit, so the phase gate holds
  under either spelling. The 43-character ref is a duplicate created by the first push attempt (a typo'd destination);
  it points at the same commit and is reported to the orchestrator rather than deleted here.
- `git status -sb`: `## factory/ac14-integrity-followup...origin/factory/ac14-integrity-followup` — in sync, no
  divergence, nothing ahead or behind.

**FIXED OFFLINE, NOT HOSTED/DEPLOYED.** Nothing in Part B1 has been deployed, pushed to any hosted system, or applied
to any hosted database; the only "push" is the git branch push of this offline work to the mission's own remote, per
the phase gate.
