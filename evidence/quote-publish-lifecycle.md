# Quote publishing lifecycle (Factory review of 920e274)

Migration `20261017060000_quote_publish_lifecycle.sql` (rollback in `ops/rollback/`), n8n 10 definition, `ops/requeue-quote-publish.sql`.
Nothing was deployed. Workflow 10 has still never run against the real Airtable base.

## What Airtable's API allows

The Airtable Web API has no conditional write. Update, replace and upsert (`performUpsert`) take no precondition such as a
version, ETag or If-Match, and an upsert that matches a record overwrites the fields it sends. Once a request has been
sent, Postgres cannot stop it from being applied. A lease or claim check in the database only decides what RoofOps
records afterwards.

So "an older version never overwrites a newer one" and "Accepted is never put back to Sent" cannot be guaranteed while
automation sends updates to an existing quote record. The design below never sends one.

## Lifecycle rules

| Rule | How it is enforced |
|---|---|
| L1. A quote is published once, as sent | `web_quote_save` refuses to revise a SENT quote (`QUOTE_SENT_FINAL`), and the dashboard no longer offers "Revise" for it. A different price means a new quote, with a new number and its own Airtable record. One hand-off per quote; the database index allows only one open hand-off (050000). |
| L2. An existing Airtable quote record is never written | n8n 10 looks the quote up by RoofOps ID or quote number. **None:** it creates the record with every field, Status Sent and both links. **One:** it writes nothing. **Two or more:** it stops (`AMBIGUOUS_WRITE`, exception for a person). |
| L3. DONE only on what Airtable holds | After any write the quote is looked up again; exactly one record must exist. The proof must carry that record's RoofOps ID, number, version, amount, links and a valid Status (Sent, Accepted, Lost or Expired), plus the customer and property read-backs. Postgres checks all of it again. |
| L4. Only the current attempt can report | Completion and failure reports carry the attempt number from the claim. Postgres ignores a report from any other attempt: it records no DONE, no retry and no stop. A late worker that saw a duplicate still opens or updates the quote's exception. Attempt numbers only increase; the requeue never resets them. |
| L5. Requeue only the latest authorized hand-off | The quote must be SENT. Its latest hand-off (chosen by version) must be stopped and carry the quote's current version, and no other hand-off of the quote may be open. Otherwise nothing changes and `refused_because` says why. |

## The three Factory scenarios

All three are tests in `test/quote-publish-lifecycle.test.ts`. They use workflow 10's real nodes, a real migrated
Postgres database and a scripted Airtable.

| Scenario | On 920e274 (red) | Now (green) |
|---|---|---|
| 1. Blank Status but DONE | The retry created the record without Status, and the hand-off was recorded DONE. | The record is created with Status Sent. Postgres refuses DONE if Status is blank or unknown, or if the record count is not 1. |
| 2. Delayed worker overwrites Accepted | Worker A stalls and its lease runs out; worker B publishes; the office accepts. A resumes and changes Status `"Accepted"` back to `"Sent"`. | The Accepted record is untouched and no write ever reaches it. A's create lands as a second record. A sees two records and reports `AMBIGUOUS_WRITE`; Postgres changes nothing, and a person is told. |
| 3. Requeue revives a superseded hand-off | With the latest hand-off DONE, the script revived the older stopped one (`requeued: 1`). | Refused, with the reason given. Only the latest stopped hand-off for the current version is re-queued. A hand-off that is still retrying is refused, without a unique-index error. |

## Remaining limitations

- **Duplicate records are still possible.** A stalled worker, or two concurrent ones, can still create a second Airtable
  quote record, because Airtable has no unique constraint. The worker that created it reads back two records and
  reports `AMBIGUOUS_WRITE`, which opens or updates the quote's exception; a person must delete the extra record. It is
  never an overwrite. If that worker dies before its read-back, nothing reports the duplicate. Whether reconciliation
  (n8n 07) flags it is not verified.
- **Customer and property records are still upserted.** They are matched on RoofOps ID and overwritten with the payload
  taken when the quote was sent. A delayed worker could write older contact details over a newer correction. This is
  not covered here.
- **Price changes need a new enquiry.** Marking the sent quote Lost also closes its enquiry (existing trigger), so the
  new quote needs a new enquiry, which can reuse the existing customer and site.
- **An existing record with a blank or wrong Status is not repaired.** If such a record is found (for example, left by
  older code), the hand-off stops for a person; automation does not fix it.
- **Not tested against the real Airtable.** The look-up formula (`{RoofOps ID}`, `{Quote Number}` by field name) follows
  workflow 03's live pattern but is unproven for the Quotes table. n8n's validator has not been re-run on workflow 10.

**No Airtable configuration change is required.** The design uses only list, get and create on the existing tables and
fields with the current token scopes.
