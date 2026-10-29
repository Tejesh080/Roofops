# RoofOps Lite: Factory's eleven findings, reproduced and fixed (2026-10-21)

## Which commit Factory audited

**What the report says.** Factory's report gives findings, file and line locations, and "612 passed, 46 skipped". It
names no commit.

**What I matched it against.**
- **Line references:** every one matches the Lite sources at **d5e81c2** and **fc0e007**. The Lite workflow code is
  identical in both; fc0e007 changed only the Airtable Interface and docs.
- **Test count:** 612 passed / 46 skipped is the count for both.

**So:** the findings apply to the current branch. Each was reproduced on fc0e007 by a new test that failed before its
fix: 11 failed, 52 passed.

**Two kinds of evidence:**
- **Local tests:** every reproduction runs the real generated n8n node code against the schema-enforcing fake Airtable,
  and the fake Twilio where needed.
- **Cloud (Airtable only):** the showcase and Interface changes were made in the cloud Airtable.
- **Cloud (n8n):** no n8n workflow was changed, and no SMS was sent.

## Results

| # | Factory finding | Reproduced on current code | Fixed | Regression test | Remaining risk |
|---|---|---|---|---|---|
| 1 | P1: retries send after consent withdrawn (`monitor.sdk.ts:58`) | Yes: the retry went out after SMS consent and review permission were removed | Yes | Pass | A retry row with no linked contact is no longer retried (staff send it by hand). Safe direction. |
| 2 | P1: service consent enables marketing (`lead-follow-up.sdk.ts:78`) | Yes: a form with SMS and email only made Zoe's old, unrecorded marketing tick usable, and earlier evidence was overwritten | Yes | Pass | Website-form evidence from before this fix has no [marketing] tag, so it counts only while the config wording stays the same. Changing that wording blocks those contacts (safe direction). |
| 3 | P1: STOP opts out one of several duplicates (`inbound-replies.sdk.ts:97`) | Yes: one duplicate stayed messageable | Yes | Pass | STOP can opt out more records than the person (a shared number). Safe direction. |
| 4 | P1: a phone edit makes STOP unrecognised (`inbound-replies.sdk.ts:54`) | Yes: STOP from the edited number, and from the old messaged number, opted nobody out | Yes | Pass | Matching relies on Airtable `REGEX_REPLACE`, proven on the fake: confirm on real Airtable in acceptance step 4. |
| 5 | P1: retrying a queued, uncertain message duplicates it (`monitor.sdk.ts:110`) | Yes: a second SMS went out | Yes | Pass | The check reads the newest 50 messages to that number. A number with more since the attempt could hide it (unlikely for one trade business). Twilio mode only: proven locally. |
| 6 | P1: reactivation bypasses cooldown across months (`lead-reactivation.sdk.ts:39`) | Yes: an Unknown attempt and a sent follow-up from last month were ignored | Yes | Pass | An unconfirmed attempt (Sending/Unknown) now holds the job until a person resolves it. Monitor raises it. |
| 7 | P1: early failure receipts discarded (`inbound-replies.sdk.ts:63`) | Yes: the receipt was acknowledged and nothing changed | Yes | Pass | A failure for a message still being recorded becomes an alert; the row is not rewritten (that would race with the send). A person checks it. Twilio mode only: proven locally. |
| 8 | P2: reconciliation moves Paid back to Contacted (`monitor.sdk.ts:137`) | Yes: found-at-Twilio and resend both did | Yes | Pass | None known. Staff can still move stages freely. |
| 9 | P2: a new enquiry after a paid job marked Lost (`lead-follow-up.sdk.ts:131`) | Yes | Yes | Pass | Two enquiries from one person within 10 minutes are still treated as one form sent twice. A later same-day enquiry gets no second text (staff call). |
| 10 | P2: apostrophes match the wrong customer (`common.part.ts:64`) | Yes: o'brien@ matched obrien@ | Yes | Pass | Uses Airtable's backslash escape in formula strings: confirm on real Airtable in acceptance step 10. |
| 11 | P2: consent with a new number texts the old number (`lead-follow-up.sdk.ts:79`) | Yes | Yes | Pass | A returning person with a new number becomes a second contact (same email). Staff merge if needed. A web form never changes a number on file. |

## The fixes (smallest change each)

1. **Retries (Monitor).** Before any retry, the contact's permission for the message's purpose and its channel consent
   are checked again.
2. **Consent wording.**
   - **Tagged per purpose:** the form tags what each consent line covers ([reviews], [marketing]).
   - **Form evidence vouches only for its boxes:** for review requests and marketing, evidence recorded by the website
     form counts only if it names that purpose. Other evidence (staff-recorded, older imports with a source) is
     unchanged.
   - **Merged, not overwritten:** a returning person's new consent is added to their evidence.
3. **STOP across duplicates (Inbound Replies).** STOP opts out every contact with the number, up to 10.
4. **Matching the sender (Inbound Replies).**
   - **By phone:** Phone Normalized, or the Phone field itself however it is typed.
   - **By history:** contacts Lite has messaged at that number before (a new Find Number History lookup).
   - Lead Follow-Up uses the same phone match.
5. **Retry check (Monitor).** The check looks a message up by recipient without the `DateSent` filter, which excluded
   queued messages.
6. **Reactivation.** Earlier follow-ups count by job, whatever their month:
   - Sending or Unknown holds the job.
   - Failed holds it for the cooldown.
   - Sent counts towards the cooldown.
7. **Early receipts (Inbound Replies).** A receipt that matches no SID either settles the one Unknown send to that
   number, or, if it reports a failure, raises a Delivery Failed alert (new nodes: Receipt Alert?, Save Receipt Alert,
   Receipt Updates).
8. **Job stages (Monitor).** A message's stored CRM updates never move a job backwards: a new Find Retry Jobs lookup,
   and forward-only stages.
9. **Duplicates (send pipeline).** Two reservations within 10 minutes are a duplicate form, and the second job is
   marked Lost. An earlier one is a separate enquiry: not texted again today, and its job is kept.
10. **Formula text.** Quotes and backslashes are escaped, never stripped.
11. **Picking the contact (Lead Follow-Up and Inbound Replies).** The contact is chosen by current phone, else by email
    with no other number on file. Otherwise a new contact is created for the new number.

## Tests

- **Before:** 11 new tests failed, each at the defect itself.
- **After:** all 11 pass, and also on their own (`-t "Factory review"`).
- **Lite:** 63 of 63 pass.
- **Full check:** `npm run check` passes (lint, both typechecks, all tests): 623 passed, 46 skipped.
- **Neighbouring behaviour:** still passes.
  - simultaneous forms: one SMS, the second job Lost;
  - STOP from a signed request;
  - START left to staff;
  - retries checked with Twilio first;
  - receipts never downgrade;
  - review and reactivation consent cases A–H.
- **One existing test changed.** "A returning person who ticks a new box" had asserted that the earlier evidence was
  replaced, which was defect 2. It now expects the evidence kept, with the new evidence and tags added.
- **Exports.** `lite/dist/demo` and `lite/dist/example-plumbing-twilio` were rebuilt, and the generated JSON was
  checked for each fix (e.g. no `DateSent%3E` left; Find Number History, Save Receipt Alert, Find Retry Jobs present).
  The git-ignored trial and live builds were rebuilt too.

## Showcase data and Interface (cloud Airtable, done)

- **Every synthetic showcase record now has Demo Data ticked:** 5 contacts, 5 properties, 5 jobs, 3 quotes, 7 messages.
  Before, they were unticked and the employee pages depended on that.
- **New filter strategy:** a read-only **Record Type** formula on Jobs, Contacts and Message Log.
  - **Real:** Demo Data not ticked.
  - **Demo:** ticked, with a realistic name.
  - **Test:** ticked, named "ZZ …".
- **Employee pages** are scoped to "Record Type is not Test".
  - **What staff see:** Real records and the showcase, labelled "[Demo] …" in Job Name, plus a Record Type column on
    Customers and Messages.
  - **What is hidden:** every ZZ test record, which stays untouched and is listed on Admin.
- **Checked:**
  - exactly 5 contacts, 5 jobs and 7 messages are Demo;
  - everything else is Test;
  - nothing is Real.
- **Interface operational.** The five pages were recreated in the same order (Pipeline first) and published.
  - The Pipeline shows exactly the five showcase cards ("[Demo] Linda Thompson – Gutter replacement", "Paid $1,980").
  - The Job page opens from a card.
  - Detail pages are unchanged.

## Cloud n8n: unchanged, waiting for approval

- **Now:** the five Lite workflows in project Roofops are unpublished and still run the **pre-fix** test-sink build. A
  node-by-node comparison shows all five differ from `lite/dist/demo`.
- **SMS:** real SMS is disabled. The workflows are in test-sink mode, nothing is published, and the live number stays
  only in the git-ignored local config.

### Deployment (one approval)

1. **Replace the definitions.** Replace the five unpublished workflow definitions (Monitor `Tmk4lj7VrbHix9A9`, Lead
   Follow-Up `9BjHeFBUKqnmQqHl`, Review Requests `WzFUcqFQnpEh309s`, Lead Reactivation `FYc1hpB9RAcwg2SH`, Inbound
   Replies `3Jeal7RQAhUmgLZ3`) with `lite/dist/demo` (test sink). They stay unpublished.
2. **Check.** Compare each node for node with the build.
3. **Rollback.** Put back the fc0e007 build of `lite/dist/demo`, which is what runs now.

### Acceptance (manual runs, test sink, synthetic ZZ people, no SMS)

| Step | Proves | Run |
|---|---|---|
| 1 | Retry re-checks consent | A ZZ lead, mark its message Failed with Retry Requested, untick Consent SMS, run Monitor: not retried |
| 2 | Service consent ≠ marketing | Submit Zoe (ZZ, old unrecorded marketing tick) with SMS and email only, run Reactivation: Zoe not messaged; her evidence merged |
| 3 | STOP across duplicates | Add a ZZ duplicate of a ZZ contact's number, simulated STOP: both Opted Out |
| 4 | Phone edit and STOP | Edit a ZZ contact's Phone in Airtable, simulated STOP from the new number: Opted Out. **This proves `REGEX_REPLACE` on real Airtable.** |
| 6 | Reactivation cooldown | Add a last-month Unknown reactivation row for a ZZ quiet lead, run Reactivation: held |
| 8 | Paid stays Paid | A ZZ lead, staff set Paid, Retry Requested on its message, run Monitor: stays Paid |
| 9 | Repeat enquiry | A ZZ lead acknowledged earlier today, its job Paid, a new ZZ enquiry: New Lead, no second message |
| 10 | Apostrophe | A ZZ contact obrien@, a lead from o'brien@: a new contact. **This proves the escape on real Airtable.** |
| 11 | New number | A ZZ contact submits with a new number: a new contact, acknowledgement logged to the new number |

**Twilio mode only (5 and 7).** These two are proven locally against the fake Twilio. Proving them in the cloud needs
Twilio mode with a public reply webhook, which is the separate live-test approval.

**Clean-up.** Delete the acceptance records (ZZ, Demo Data ticked). The five showcase customers are kept.
