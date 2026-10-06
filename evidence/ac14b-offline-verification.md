# AC-14B offline verification: a verified Xero void is not an AC-05 integrity failure

Facts and command output only. Nothing here was run against a hosted system; no deploy, no production credentials, no
Xero, Airtable, n8n or Supabase call. Everything below is local (PGlite and a locally installed PostgreSQL 17).

- Defect: AC-14B in [docs/defect-ledger.md](../docs/defect-ledger.md).
- Fix: `supabase/migrations/20261001130000_xero_verified_void_is_not_an_integrity_failure.sql` (new migration; no
  applied migration was edited) and `test/xero-settlement.test.ts` (cases 15-20).
- Migration SHA-256 prefix: `24f343ebdce34faa`.
- Branch: `factory/ac14-integrity-followup`, base `98729f3`.

## 1. The defect

AC-14 (`20261001120000`) legitimately follows a void made in Xero: 07's repair run reads the linked invoice, records
`VERIFIED / VOIDED` in `xero_invoice_observations`, and applies `APPROVED -> VOIDED`. AC-05's integrity predicate,
carried over verbatim (`20261001060000:189`, then `20261001120000:381-388`), still failed every `VOIDED`, RoofOps-origin
invoice whose Xero write exists, may exist or is linked. So a designed state left the gate red:

```
FAIL voided_invoice_has_no_xero_write -> INV-2026-0039   while   PASS xero_invoice_state_verified
```

`scripts/integrity-check.ts` exits 1 on any FAIL, so the team's correctness gate was red in a state the fix creates.

## 2. The rule (AC-05 not weakened)

A RoofOps-origin invoice that is `VOIDED` while its Xero write is pending, in flight, ambiguous or linked and
**unexplained** is still a FAILURE. It is VALID only when the exact linked Xero invoice
(`external_links` XERO `Invoice` `external_id`) was independently read `VERIFIED / VOIDED` in the tenant its write is
bound to (`outbox.payload ->> 'xero_tenant_id'`) - exactly the condition `invoice_void_guard` already trusts
(`20261001120000:290`).

Ordering. A Xero void is irreversible, so the exemption is "such an observation **exists**, and no later `VERIFIED`
observation of that same linked `InvoiceID` says something else". A latest-observation predicate (what the guard uses)
would let a transient `LOOKUP_FAILED` read of the now-voided invoice flip a legitimately voided invoice back to FAIL,
and repeated repair runs (each recording `VERIFIED / VOIDED` again) must stay stable. A later `VERIFIED` read that
contradicts the void is not explained, so it fails again and a person looks. Case 15 proves the first half, case 20 the
second. Only the AC-05 predicate and its detail text changed; the rest of the wrapper is the one from `20261001120000`.

## 3. Red before, green after (the new positive tests only)

Command: `npx vitest run test/xero-settlement.test.ts`, first without the new migration (moved aside), then with it.

```
# WITHOUT 20261001130000
 × 15. AC-14B: a void verified in Xero is not an integrity failure, and a later failed read does not make it one
 × 16. AC-14B: the local void the guard allows (a verified Xero void, observed first) is not an integrity failure
 ✓ 17. AC-14B: a bypass void whose last verified read is not a void is still an integrity failure
 ✓ 18. AC-14B: a verified void recorded in another tenant does not excuse a bypass void
 ✓ 19. AC-14B: a verified void of a different Xero invoice does not excuse a bypass void
 × 20. AC-14B: a later verified read that contradicts the void puts the invoice back in the FAIL list
 Test Files  1 failed (1)
      Tests  3 failed | 19 passed (22)          Duration 51.66s

# WITH 20261001130000
 Test Files  1 passed (1)
      Tests  22 passed (22)                     Duration 51.14s
```

The three red cases are exactly the positive ones (the exemption is absent); the three negatives pass before and after,
as they must. Negative case (a) from the brief - a bypass void of a linked, `SYNCED` invoice with no `VOIDED`
observation at all - is already covered by the safety-net case in `test/invoice-void.test.ts`, kept green below.

## 4. Ablation proofs (applied, run, reverted; not committed)

Each clause of the exemption was neutralised in turn and the six AC-14B tests run
(`npx vitest run test/xero-settlement.test.ts -t AC-14B`). `RESTORED` + `diff` confirmed the file back to
`24f343ebdce34faa` after every ablation.

| Ablation | Tests red |
|---|---|
| (i) whole exemption removed | 15, 16, 20 |
| (ii) tenant condition (`x.tenant_id = outbox.payload ->> 'xero_tenant_id'`) dropped | 18 |
| (iii) linked-invoice condition (`x.xero_invoice_id = linked external_id`) dropped | 19 |
| (iv) `x.settlement = 'VOIDED'` dropped | 17, 20 |
| (v) "no later VERIFIED observation with a different settlement" clause dropped | 20 |

An early draft of ablation (v) removed one parenthesis too many; the migration then failed to apply and all six tests
errored. That run is discarded and the corrected ablation (balanced parentheses) is the row above.

## 5. Required regression files

`npx vitest run test/invoice-void.test.ts test/xero-tenant-binding.test.ts test/xero-ambiguous-create.test.ts test/xero-settlement.test.ts test/project-lifecycle.test.ts test/state-integrity.test.ts`

```
 Test Files  6 passed (6)
      Tests  102 passed | 5 skipped (107)        Duration 56.33s
```

(AC-05, AC-06, AC-04, AC-14, AC-13A and state integrity. The 5 skipped are the hosted-gated cases; `RUN_HOSTED_TESTS`
was not set.)

## 6. Full suite

- PGlite: `npm test` -> `Test Files 27 passed | 3 skipped (30)`, `Tests 314 passed | 35 skipped (349)`, duration 67.33s.
- PGlite + PostgreSQL 17: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres npm test` ->
  `Test Files 27 passed | 3 skipped (30)`, `Tests 594 passed | 35 skipped (629)`, duration 79.82s.
  `test/xero-settlement.test.ts` ran 44 tests (22 on each target).

0 failed on both. The 35 skipped are `test/live-phase2|3|6.test.ts`, gated by `RUN_HOSTED_TESTS` (not set).

PostgreSQL 17.11 (`17.11-1.pgdg24.04+2`) was installed locally for this run:

```
$ pg_lsclusters
17  main    5432 online postgres /var/lib/postgresql/17/main /var/log/postgresql/postgresql-17-main.log
```

No Docker, no hosted connection; the tests create and drop throwaway databases on `127.0.0.1`.

## 7. Fresh migration chain from zero (throwaway script, outside the repo)

`/tmp/ac14b-check.mts` opens PGlite (`src/db/db.ts` `openPglite`), runs `migrate`, runs `importBundle`, then prints
`integrity_check()` and the privilege assertions of `scripts/security-check.ts` (which normally targets only the hosted
database).

```
applied migrations: 34 (total in schema_migrations: 34)
...
  PASS    closed_project_settled               failing=0
  PASS    final_invoice_settles_entitlement    failing=0
  PASS    voided_invoice_has_no_xero_write     failing=0
  PASS    xero_invoice_state_verified          failing=0
  26 PASS, 5 WARNING, 0 FAIL
voided_invoice_has_no_xero_write = PASS
```

`voided_invoice_has_no_xero_write` PASSes on the untouched imported dataset, as before the change (the 5 WARNINGs are
the pre-existing ones).

## 8. Privileges (blanket revoke leaves nothing else to re-grant)

The same script replicated `scripts/security-check.ts` against PGlite:

```
PASS  dashboard role: readable tables                      []
PASS  dashboard role: SECURITY DEFINER functions           ["app_today","at_link","integrity_check","invoice_final_preview","project_left_to_bill_after_final","project_over_billing","sm_label","wf_invoice_prepare"]
PASS  dashboard role: can it write via wf_* (other than prepare)? []
PASS  workflow role: executable functions                  21 items
PASS  functions executable by PUBLIC                       []
PASS  tables without row level security                    []
PASS  dashboard cannot execute xero_record_settlement(text, jsonb) []
PASS  dashboard cannot execute invoice_financial_state(uuid, boolean) []
PASS  dashboard can execute integrity_check()              ["x"]
PASS  dashboard cannot read xero_invoice_observations      []

ROLE-SET roofops_dashboard (16): app_today, at_link, at_matches, at_norm, at_repair_value, at_title,
  business_days_between, checklist_at_label, integrity_check, invoice_final_preview,
  project_left_to_bill_after_final, project_over_billing, sm_label, wf_invoice_prepare, xero_settlement,
  xero_settlement_status
ROLE-SET roofops_workflow (21): wf_airtable_change, wf_airtable_cursor, wf_airtable_cursor_advance,
  wf_airtable_writeback_verified, wf_claim_side_effect, wf_complete_side_effect, wf_drive_call_decision,
  wf_fail_side_effect, wf_invoice_decide, wf_invoice_prepare, wf_invoice_preview_verified, wf_quote_accepted,
  wf_reconcile_airtable, wf_reconcile_drive_unavailable, wf_reconcile_external, wf_reconcile_finish,
  wf_reconcile_start, wf_reconcile_targets, wf_reconcile_xero_uncertain, wf_record_health, wf_webhook_check
all privilege checks pass
```

The migration ends with `revoke execute on all functions in schema public from public;` then
`grant execute on function integrity_check() to roofops_dashboard;`. To confirm the blanket revoke strips nothing that
must be re-granted, the same run was made with the new migration moved aside (33 migrations): both `ROLE-SET` lines were
**byte-identical** (`roofops_dashboard` 16, `roofops_workflow` 21). `create or replace function` keeps the object and
its grants, so only the re-stated `integrity_check()` grant is needed.

## 9. Lint and typecheck

```
$ npm run lint        # eslint .      -> no output
$ npm run typecheck   # tsc --noEmit  -> no output
```

## 10. Not done (deliberately)

- Nothing hosted: no deploy, no migration applied to Supabase, no dry-run, no repair run, no Xero call. The defect is
  **Fixed offline**, not Fixed; live verification is still needed.
- The Xero `DELETED` dead end is untouched (separate, later defect).
- AC-05 was not weakened: a locally or bypass-voided invoice with an active or unexplained Xero side effect still
  FAILs, proved by cases 17-19 (and the untouched safety net in `test/invoice-void.test.ts`).
