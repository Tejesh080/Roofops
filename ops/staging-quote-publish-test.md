# Staging: one supervised synthetic quote through workflow 10 (candidate 6c1b2f9)

Prepared 2026-10-18. Nothing here has been run. Every **[approval]** step is yours. Checks marked *read-only* change
nothing.

## Current state (checked 2026-10-18, read-only)

**Workflow 10 definition.** n8n Cloud's `validate_workflow` accepted the committed file as valid, with 29 nodes. Its
three warnings come from placeholder sample outputs on predecessor nodes ("Any Quote?", "Customer Row Built?", "Record
Publish Failure"), not from the runtime expressions.

**n8n Cloud.**
- Workflow 10 does not exist yet.
- Both credentials it references exist: `3XbFnHjAd7mFvBD2` (Airtable PAT) and `kWqjtv0gz7ref2EN` (RoofOps Postgres).
- These workflows are active: 01, 02, 03, 04, 05, 06, 07, 08 Reissue and 08 Health.
- Workflow 09 is inactive.

**Airtable.**
- Quotes holds 65 records; the highest is Q-2026-0065. The next RoofOps number is Q-2026-0066 on the restored hosted
  copy, so it does not collide.
- The filter fields `{RoofOps ID}` and `{Quote Number}` resolve to exactly the field IDs workflow 10 checks.

**Hosted database.** As of the last backup (17 Oct), none of the 7 migrations `20261017000000` to `20261017060000` is
applied. Workflow 10 cannot run until they are. On a restored copy they apply cleanly: security 16/16, integrity
29 pass / 5 warning / 0 fail, and rollback is exact.

## The seven Airtable options: still missing, still required for general use

The database allows all seven values; the Airtable selects still lack them. Workflow 10 writes with `typecast: false`,
so a quote carrying any of them stops with a `VALIDATION_ERROR` exception and is never marked done.

| Table › field | Missing options | Has today |
|---|---|---|
| Quotes › Lead Source | `Phone`, `Other` | Google Ads, Organic Search, Referral, Facebook, Repeat Customer, Builder Referral, Local Signage, Website Form |
| Quotes › Roof Type | `Other` | Tile, Terracotta Tile, Metal, Colorbond, Zincalume |
| Customers › Type | `Builder`, `Strata` | Residential, Commercial |
| Properties › Property Type | `Industrial`, `Strata Complex` | Detached House, Townhouse, Small Commercial |

**For the first test they are not needed.** Use only values Airtable already has (see the synthetic data below).
**[approval]** Add the seven before staff use the dashboard for real enquiries.

## What the test touches, and what it cannot touch

**Airtable.** Workflow 10 creates, at most, one new Customer, one new Property and one new Quote.
- The customer and property writes are upserts keyed on their RoofOps ID. A new synthetic customer and site have new
  IDs, so these writes create records; no existing record can match.
- The quote write is create-only.
- No other table or record is written.

**Postgres.** The test adds an enquiry, customer, site, quote, quote version, one outbox hand-off, external links, audit
rows and events. Nothing existing is updated.

**Not touched.** Xero, Drive, projects, invoices, approvals and the other workflows' outboxes. A project, a Drive folder
and an Airtable project would only appear if someone set the synthetic quote to **Accepted**. That is not part of this
test.

**Other active workflows will see it:**
- **06** reads only *changed* records (`changedRecordsById`), not created ones. Adding the quote's links also changes
  inverse link fields on the new customer and property. 06 should skip those as unwatched fields; the test confirms it.
- **01** reacts only to a Status change to Accepted.
- **07** (daily) will compare the synthetic records with Postgres; it should report no drift.

## Running one controlled worker

1. **Create workflow 10 inactive and run it by hand.** **[approval]** Create it from `n8n/10-airtable-quote-publish.sdk.ts`,
   unpublished/inactive, with the "Every Minute" trigger disabled. An inactive workflow never runs on a schedule, so the
   only execution is the one you start. For that run, open the editor, enable the trigger node without activating the
   workflow, press **Execute workflow** once, and wait for it to finish. Then disable the node again.
2. **Make sure exactly one hand-off is due.** Postgres hands out one write per run (`wf_quote_publish_next` returns
   one; "Write To Publish" keeps one). The claim is exclusive for 180 seconds, and since 060000 only the attempt holding
   the claim can record anything. Before you press Execute, the pre-run query must return exactly the synthetic quote,
   so no older hand-off can be picked instead.
3. **Do not start a second execution while one is running.** If one hangs, leave it until its lease expires (180 s)
   and look at the hand-off before doing anything else.

## Detecting duplicates

Workflow 10 checks this itself: it looks up the quote by RoofOps ID or quote number before writing and again after.
More than one record stops the hand-off with `AMBIGUOUS_WRITE` and opens an exception.

Check independently afterwards (all read-only):

- **Airtable › Quotes:** filter `RoofOps ID = <quote id>`, then separately `Quote Number = Q-2026-00NN`. Each must
  return exactly 1 record. Total quotes must be 66.
- **Airtable › Customers and Properties:** filter by the synthetic customer's and site's RoofOps ID; exactly 1 record
  each.
- **Postgres:** the hand-off result has `quote_record_count = 1`, and there is one verified Airtable `external_links`
  row each for the quote, customer and property.
- **Re-run check (optional):** execute workflow 10 a second time. It must end at "Any Quote?" = false and write nothing.

## Execution checklist

| # | Step | Approval |
|---|---|---|
| 0 | **Preflight (read-only).** Hosted `schema_migrations` latest; no `airtable.quote_publish` rows; Airtable highest quote still Q-2026-0065; the select options as above. | none |
| 1 | **Backup.** Take a fresh read-only dump of hosted (as for `pre-release-ops-sales-…dump`) and keep it with the others. | none (read-only) |
| 2 | **Hosted migrations.** Run `npm run db:load -- --hosted` (applies the 7, each in its own transaction). Expect security 16/16 and integrity 29/5/0. **Note:** 07's next repair run then rewrites PRJ-2026-0007's Invoice Preview in Airtable; pause 07 first if you don't want that yet. | **[approval]** |
| 3 | **Dashboard to send from.** Either a protected Vercel Preview of this branch with `STAFF_XERO_DISPATCH` unset (release plan step B), or the local build (`next start` on 127.0.0.1) pointed at hosted with the dashboard role. Either way Production is not touched. | **[approval]** |
| 4 | **Create workflow 10.** Inactive, trigger disabled, from the committed file. | **[approval]** |
| 5 | **Synthetic data.** Signed in as the synthetic sales login on hosted (EMP-802, as in the release plan), record an enquiry. Use only the values listed below. | none |
| 6 | **Pre-run query (read-only).** It must return exactly one row: the synthetic quote, PENDING, `attempts = 0`. | none |
| 7 | **Run it once.** Workflow 10, **Execute workflow** once; wait for it to finish. | **[approval]** (this is the Airtable write) |
| 8 | **Verify** against all of the criteria below. | none (read-only) |
| 9 | **Watch.** Re-run the 06/exception query 10 minutes later and again after 07's next daily run. | none |
| 10 | **Clean up** (see below), and deactivate workflow 10 or leave it inactive. | **[approval]** |

**Synthetic data for step 5** (only values Airtable already has):
- Name `ZZ Synthetic Quote Test 1`; email `synthetic.quote.test1@example.test`; phone `0400 000 066`.
- Source **Referral**.
- On conversion, a **new** customer (type **Residential**, preferred contact **Email**) and a **new** site at
  `1 Synthetic Test Street, Bundaberg QLD 4670` (type **Detached House**). Never pick an existing customer or site.
- Skip the inspection, or record it with roof type **Tile**.
- Quote: job type **Leak Repair**, one labour line, 1 hr at $100 (prices include GST); then **Send**.

### Queries (read-only, owner connection; replace `<Q>`)

Pre-run (step 6):
```sql
select o.idempotency_key, o.status, o.attempts, o.payload->>'quote_number' q
from outbox o where o.topic = 'airtable.quote_publish' and o.status <> 'DONE';
```

After the run (step 8):
```sql
select o.status, o.attempts, o.result->>'attempt' att, o.result->>'quote_record_count' n,
       o.result->'quote_read_back'->>'status' st, o.result->>'quote_record_id' rec
from outbox o join quotes q on q.id = o.aggregate_id
where o.topic = 'airtable.quote_publish' and q.quote_number = '<Q>';

select entity_type, external_id, verified_at is not null v
from external_links
where provider = 'AIRTABLE' and entity_id in (
  select id from quotes where quote_number = '<Q>'
  union select customer_id from quotes where quote_number = '<Q>'
  union select property_id from quotes where quote_number = '<Q>');

select exception_number, error_class, resolution_status, left(error_message, 160)
from workflow_exceptions where business_reference = '<Q>' or first_failed_at > now() - interval '1 hour';

select status, count(*) from integrity_check() group by 1;
```

## Pass criteria (all must hold)

**n8n execution:**
- It succeeded and passed through Find Quote, Create Quote, Read Back Quote/Customer/Property and Record Verified
  Publish, which returned `RECORDED`.
- "Record Publish Failure" did not run.

**Postgres:**
- The hand-off is `DONE`, `attempts = 1`, with `result.attempt = 1`, `quote_record_count = 1` and
  `quote_read_back.status = Sent`.
- Three verified `external_links` exist; the quote's equals the Airtable record ID.
- No open exception exists for the quote.
- Integrity is still 29/5/0 (or better), with no FAIL.

**Airtable:**
- Exactly 1 quote record carries Q-2026-00NN and its RoofOps ID, with Status **Sent**, Version **1** and
  Amount **100**, linked to exactly 1 new customer and 1 new property.
- The property's owner link points to that customer.
- Quotes total is 66. No pre-existing record was modified: check record history on any record you are unsure of.

**Dashboard:** the quote card says "Airtable: added".

**Other workflows, after 10 minutes:**
- 06 recorded no applied change and no exception for the three records.
- 01 created no project.

**Stop rule.** If any criterion fails, stop: do not re-run, do not fix anything in Airtable by hand, and send me the
execution ID and the query output. A failed run is recorded as FAILED with an exception and is never marked done.

## Clean-up and rollback

**Synthetic records (recommended: keep and close).** In Airtable, set the synthetic quote's Status to **Lost**. 06
applies this through the normal path, so the quote and its enquiry become Lost in Postgres and both systems stay
consistent. The records stay, clearly named "ZZ Synthetic…".

**Do not simply delete the Airtable rows.** Postgres keeps verified links to them, and reconciliation would then report
the records as missing. If you want them gone, delete them in Airtable (quote first, then property, then customer)
*and* accept the resulting reconciliation exceptions as expected. RoofOps never deletes Airtable rows itself.

**Workflow 10.** Leave it inactive, or delete it. It writes only when executed.

**Database, only if the release is abandoned.**
- Stop or delete workflow 10 first.
- Run the rollbacks one at a time, newest first, each in one transaction (`npx tsx scripts/sql.ts -f <file>`):
  `ops/rollback/20261017060000_quote_publish_lifecycle.down.sql`, then `050000`, `040000`, `030000`, `020000`,
  `010000`, `000000`.
- **The 020000 rollback refuses while a quote hand-off is pending.** Finish the hand-off, or close it, first.
- Records are kept. As a last resort, restore the backup from step 1; this loses every hosted change made after it.

**Dashboard.** Delete the Preview, or stop the local server. Production is untouched.

## Not covered by this test

- Acceptance (Status → Accepted → project, Drive, Airtable project). It is a separate supervised step, if you want it.
- The seven missing options.
- Concurrent workers and real stalls; they are only simulated in tests.
- A failure path against real Airtable: the first run is the happy path.
