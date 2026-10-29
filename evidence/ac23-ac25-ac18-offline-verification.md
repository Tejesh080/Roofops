# AC-23, AC-25 and AC-18 offline verification (quote acceptance is deterministic)

Status: **Fixed offline**. Live verification is pending. Nothing hosted was touched. Everything below ran locally: PGlite
and the local Postgres 17 container (each suite creates and drops its own throwaway database).

Branch `feature/advanced-sprint-lifecycle`, on the M1 commit `d87627b` (AC-15B and AC-13C), itself stacked on the AC-15
commit `75b76eb`. Audit items: C1-AC23 (= INT-02), C2-AC25, C3-AC18 (the first part of INT-03; its second part, the
`replay_from_cursor` field that n8n 01 and 04 accept from an unauthenticated ping, is not in this milestone).

## 1. Defects and reproduction

All three are in `wf_quote_accepted`, the function n8n 01 calls for every Airtable quote set to Accepted. Its latest
definition is `20260929000700_one_exception_per_rejected_fact.sql:49-287`; no later migration redefines it.

**AC-23 (catalogue P1; audit C1 P1, INT-02).** n8n 01 copies the Airtable Accepted On cell into `payload.accepted_on`
(`n8n/01-quote-accepted-to-project.sdk.ts:66`). The function refused only a future date (`:93-97`) and then wrote the
value (`:199`). A date before the quote's Sent On violated `quotes_check4` (`accepted_on >= sent_on`, core schema) and
**raised**: nothing was recorded (no event row, no exception), and 01's Accept node has no error output while its
cursor advances only after it, so 01 re-read the same payload on every ping and every later acceptance in the base
stalled behind it. Reproduced: Q-2026-0032 (sent 2026-04-14) with Accepted On 2026-04-13 threw
`new row for relation "quotes" violates check constraint "quotes_check4"` on both engines.

**AC-25 (catalogue P1; audit C2 P1).** Airtable's "Duplicate record" copies Quote Number and RoofOps ID onto a new record
id. The function cross-checked only `payload.quote_uuid`; `payload.airtable_record_id` was only logged. Reproduced:
Q-2026-0064 with a verified Airtable Record link `recQ0064ORIGINAL1`; an acceptance from `recQ0064DUPLICATE` with the
correct RoofOps ID returned CREATED (a project from a row whose amount staff may have edited).

**AC-18 (catalogue P1; audit C3 P2, INT-03 P1).** On a business rejection the function releases the fact's
`processed_events` claim (so a corrected event can succeed); a repeated event_id was only logged as a redelivery and then
judged again against the quote as it is now. Reproduced: Q-2026-0033 (imported, Draft, verified record
`recQ0033RECORD001`): event `airtable:achTESTTESTTEST01:txn18:recQ0033RECORD001` was REJECTED (INVALID_STATE: Draft);
staff set Status = Sent through `wf_airtable_change` (as n8n 06 hands it over: APPLIED); the **same event_id** delivered
again returned CREATED (a project).

Reproduced first in `test/workflow.test.ts` (describe "acceptance is deterministic", `:312`). Without the migration
(file moved aside, both engines): **11 failed, 53 passed, 4 skipped (68)**:
- AC-23: the rejection test (`:328`, threw `quotes_check4`) and the batch test (`:348`, the first item threw, so the
  second never ran), per engine;
- AC-25: the duplicated-row test (`:366`), per engine;
- AC-18: the Draft → Sent test (`:393`) and the "recorded before this rule" test (`:439`), per engine, plus the
  two-connection test (`:486`, Postgres only). Before the fix that one also **raised** on one connection:
  `workflow_exceptions_check` (see §6, a pre-existing race).

The new tests that hold before and after (they pin behaviour the fix must not change):
- AC-23 `:358`: an Accepted On from Sent On to today is kept as given; a future one is refused as an invalid event;
- AC-25 `:385`: an event that names no Airtable record is judged as before, even for a quote with a verified record;
- AC-18 `:419`: a delivery whose transaction failed (a trigger raises while it opens the exception, then rollback) left
  no event row and no exception; after the quote is Sent, the same event_id is judged as new and CREATED.

## 2. Rules

- **AC-23 (conservative).** An Accepted On before the quote's Sent On is a handled outcome: REJECTED, error class
  VALIDATION_ERROR, one exception for the quote (through `wf_open_quote_rejection`, the existing rejection path), no
  project, no raise: "Accepted On is before Q-… was sent (…): an acceptance cannot predate its quote". The message
  leaves out the typed date, so repeated mistakes on one quote share one open exception. Otherwise unchanged: a date
  from Sent On to today is kept as given; a future date is refused as an invalid event (as before). An Accepted On left
  blank still defaults to the business date. The check runs only where the date is written (a Sent quote); an
  already-accepted quote ignores the payload date, as before.
  **Owner decision, not taken here:** back-dating within [Sent On, today] stays possible. The field contract says
  Accepted On is RoofOps-owned ("none (set by acceptance)"), yet its value still comes from the Airtable cell. The audit's
  alternative (derive it from the event's Brisbane date, clamped to [Sent On, today], and stop reading the cell in 01)
  changes the recorded date for staff-typed values and needs the owner.
- **AC-25.** When the quote has a verified Airtable Record link (`external_links`: provider AIRTABLE, entity quote,
  external type Record, `verified_at` set) and the event names a different `airtable_record_id`, the acceptance is
  REJECTED: RECONCILIATION_MISMATCH, "Acceptance came from Airtable record recX, but Q-… is Airtable record recY: accept
  the quote on its own record", one exception, no project, the quote stays Sent. An event without a record id, or a quote
  without a verified record, is judged as before. The project write-back already links the verified record.
- **AC-18.** The first completed outcome of an event_id is final for that event_id:
  - a redelivery of an event whose delivery committed, whatever its outcome, returns the stored outcome with
    `duplicate: true` and changes nothing: no claim, no project, no quote change, no new exception. As for every
    redelivery, the delivery is logged (a `:redelivery:N` row, DUPLICATE_IGNORED / DUPLICATE_EVENT) and counted
    (`processed_events.delivery_count` for a success; the open exception's `attempt_count` for a rejection, as before;
    a resolved exception is left alone);
  - a new event_id (a fresh Airtable change, after staff fix the quote) is judged normally;
  - a delivery whose transaction failed was never recorded, so it is judged again as new.

  The existing machinery carries it: the event row in `automation_events` (one per event_id: unique `event_key`, the
  arbiter the function already used, also under concurrency) and, for a success, the fact's `processed_events` result.
  A rejection now also keeps its returned outcome in its event row (`metadata.result`); a rejection recorded before this
  migration has none and is rebuilt from its row (status, class, reason or issues, and its exception). A redelivered
  invalid event already returned its first rejection; it now also says `duplicate: true`.

What n8n 01 does with it: unchanged. Its "Compose Quote Status" writes "Rejected (class): message. Exception EXC-….
No project was created." for INVALID_STATE / INVALID_EVENT outcomes, so a redelivery of a rejected event writes exactly
the text of the first delivery. A replay reads events in order, so the last write to a quote record is the newest event's.

## 3. Fix

Migration `20261022030000_quote_acceptance_is_deterministic.sql`: `wf_quote_accepted` is its latest definition
(`20260929000700`) with only this delta. A script (scratch, not in the repo) extracted the body, applied each delta with a
function replacement that must match exactly once, and checked the result: 239 → 287 lines, **237 source lines kept in
order**, 2 replaced (listed below), 50 added; no `$` lost. The rollback body is byte-identical to the source.

| Part | Delta |
|---|---|
| Declarations | `v_first automation_events`, `v_quote_rec text` (2 lines) |
| AC-18, redelivery | after the delivery is logged, before any claim: if this event_id was already recorded and its first row is REJECTED, return its stored outcome (or, for an older row, the rebuilt one) with `duplicate: true, redelivery: true`; mark this delivery DUPLICATE_IGNORED; count it on its exception if still open (`last_attempt_at = greatest(last_attempt_at, now())`, so a concurrent redelivery cannot violate `workflow_exceptions_check`) (28 lines incl. comments). SUCCEEDED and DUPLICATE_IGNORED first rows take the existing path (the fact's stored result) |
| AC-18, store | the business rejection's `return jsonb_build_object(...)` becomes `v_result := ...`, then `metadata.result` is written on the event row, then `return v_result` (1 replaced line, 3 added) |
| AC-18, invalid events | the redelivered-invalid-event return also carries `'duplicate', true` (1 replaced line) |
| AC-25 | read the quote's verified Airtable Record link with the quote (2 lines); after the RoofOps ID check, an `elsif` refusing another record (6 lines) |
| AC-23 | after the version checks, an `elsif v_q.status = 'SENT' and v_accepted_on < v_q.sent_on` refusing with VALIDATION_ERROR (6 lines) |

No view, field contract, setting or data change; `npm run contract:export` is not needed. No n8n, Airtable or dashboard
change. `CREATE OR REPLACE` keeps the owner and ACL (`{postgres=X/postgres,roofops_workflow=X/postgres}`), SECURITY DEFINER
and `search_path=public, pg_temp`. Rollback: `ops/rollback/20261022030000_quote_acceptance_is_deterministic.down.sql`.
Migration sha256 `3e134054c0e75811eba06e037224960e0ac936c513013db2ac57413ffee29dfc`.

Tests changed: none. Tests added: 8 per engine and 1 two-connection test in `test/workflow.test.ts`. The existing test
"a rejected fact delivered again … reuses its one open exception" (`:129`, attempt count 3 after a redelivery and a new
event) stays green unchanged, because a redelivery is still counted on the open exception.

## 4. Verification

| Check | Result |
|---|---|
| Red, without the migration (both engines) | 11 failed, 53 passed, 4 skipped (68) |
| Green, `test/workflow.test.ts` (PGlite and Postgres 17) | **64 passed, 4 skipped (68)**; the 4 skipped are the two-connection tests on PGlite |
| Ablation AC-23 (the `elsif` removed in place) | 4 failed (the rejection and batch tests, both engines); restored, `cmp` identical |
| Ablation AC-25 (the `elsif` removed) | 2 failed (the duplicated-row test, both engines); restored, `cmp` identical |
| Ablation AC-18 (the redelivery block removed) | 9 failed: the Draft → Sent and older-row tests, both engines, the two-connection test, and the AC-23 and AC-25 tests' redelivery assertions; restored, `cmp` identical |
| Ablation AC-18 store (the `metadata.result` write removed) | 2 failed (the stored-outcome assertion, both engines); restored, `cmp` identical |
| Targeted suites, both engines: workflow, enquiry-to-quote, sales-reliability, quote-publish-lifecycle, release-blockers, site-visits-and-tasks, staff-invoice-approval, pre-start-gate, project-lifecycle, n8n-pre-start-fields, xero-reissue-lifecycle, state-integrity, schema, exception-resolution | 14 files, **476 passed, 7 skipped** (483) |
| Concurrency probe, Postgres 17, 30 pairs of connections delivering the same rejected event_id at once | 60 of 60 handled, none raised |
| Rollback round trip (fresh PGlite: every migration before M2, then M2, then the down file) | M2 changes exactly `wf_quote_accepted`; no view, field contract or setting; after the down file functions with ACLs, views, field contract and settings identical; migrations 59 → 59; owner, ACL, SECURITY DEFINER and search_path identical; re-apply works |
| Full gate | see §4a |

No rehearsal on a restored hosted copy was run for this milestone; the read-only checks in §5 step 1 cover what it would
show.

### 4a. Full gate

`TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run check` (lint, typecheck, typecheck:web,
PGlite and Postgres 17): **exit 0**; Test Files 59 passed, 3 skipped (62); Tests **1255 passed**, 37 skipped (1292); 478 s.
Against M1 (1238 passed, 36 skipped): +17 passed (8 per engine plus the two-connection test) and +1 skipped (that test on
PGlite). The 36 other skipped need the hosted database. The first run stopped at lint (two unnecessary non-null
assertions in the new two-connection test); fixed, and the whole gate was run again.

## 5. Hosted steps awaiting owner approval

M2 changes only Postgres. `npm run db:load -- --hosted` applies every pending migration in order, so M2 goes after (or in
the same window as) AC-13B, AC-15 and M1.

1. Read-only, before step 2, and keep the output:
   - which Sent quotes will be held to their verified Airtable record (AC-25), and that hosted quote links use the
     external type `Record` (a link of another type is not used, and that quote keeps the old behaviour):
     `npx tsx scripts/sql.ts --read-only "select l.external_type, l.verified_at is not null verified, q.status, count(*) from quotes q join external_links l on l.provider = 'AIRTABLE' and l.entity_type = 'quote' and l.entity_id = q.id group by 1, 2, 3 order by 1, 2, 3"`;
   - Sent quotes whose Sent On is after the business date (a blank Accepted On defaults to today and is now refused):
     `npx tsx scripts/sql.ts --read-only "select quote_number, sent_on from quotes where status = 'SENT' and sent_on > app_today()"`;
   - rejected acceptances recorded before M2 (a redelivery of one is answered from its row):
     `npx tsx scripts/sql.ts --read-only "select count(*) from automation_events where event_type = 'quote.accepted' and status = 'REJECTED' and not metadata ? 'result'"`.
2. 🔒 `npm run db:load -- --hosted`. Expect `20261022030000_quote_acceptance_is_deterministic.sql` (after any earlier
   pending ones).
3. Read-only: `npm run integrity:check` (0 FAIL); `npm run security:check` (all pass);
   `npx tsx scripts/sql.ts --read-only "select proacl from pg_proc where proname = 'wf_quote_accepted'"` (unchanged).
4. 🔒 Optional live checks through Airtable, each on a synthetic test quote and only with approval (each leaves one
   exception to resolve):
   - AC-23: on a Sent test quote set Accepted On to the day before Sent On, then Status = Accepted. Expected: 01 writes
     "Rejected (VALIDATION_ERROR): Accepted On is before …", no project, 01's cursor advances (a second test acceptance
     right after is created).
   - AC-25: duplicate a Sent test quote's record in Airtable and set the duplicate to Accepted. Expected: "Rejected
     (RECONCILIATION_MISMATCH): Acceptance came from Airtable record … but … is Airtable record …", no project.
   - AC-18 needs the same Airtable transaction delivered twice (a cursor replay); it is covered offline only.
5. Rollback: step 6.

## 6. Open points

- **Pre-existing race, not changed here.** Two connections delivering **different** event_ids of the same rejected fact
  at once (overlapping pings) can raise `workflow_exceptions_check` in `wf_open_quote_rejection`: the reuse branch sets
  `last_attempt_at = now()`, the transaction start, which can be earlier than the first delivery's `first_failed_at`.
  Probe on Postgres 17, 30 pairs: 2 of 60 deliveries raised. The raised delivery is not recorded, so n8n 01 delivers it
  again on its next run (no wrong outcome, one failed 01 execution). The same pattern is in `wf_open_exception`. The fix
  would be `greatest(last_attempt_at, now())` there, as the new redelivery path does; it is outside this milestone.
- **Transient rejections are final per event_id too.** As the brief requires, any committed outcome is final for its
  event_id, including NOT_FOUND. Staff re-trigger by setting Status again in Airtable (a new event_id). The audit (INT-03)
  suggested limiting finality to INVALID_STATE and RECONCILIATION_MISMATCH if NOT_FOUND must stay retryable; a quote
  reaches Airtable only after it exists in RoofOps (n8n 10), so NOT_FOUND is not expected to be transient.
- The second part of INT-03 (01 and 04 read `replay_from_cursor` from an unauthenticated ping) is still open.

## 7. Rollback

`npx tsx scripts/sql.ts -f ops/rollback/20261022030000_quote_acceptance_is_deterministic.down.sql` (owner, one
transaction). It restores `wf_quote_accepted` as `20260929000700` defined it and removes the migration's record. No data
changes: a rejection's `metadata.result` written while M2 was live stays in `automation_events` and is ignored by the
restored function.
