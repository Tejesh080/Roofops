# RoofOps Lite: Factory release gate, four blockers closed (2026-10-21)

## Summary

| | |
|---|---|
| Code | commits `902503a` (the four fixes) and `d6cc44f` (STOP batches paced for Airtable's rate limit), branch `feature/roofops-lite` |
| Deployed | `lite/dist/demo` at `d6cc44f` (test sink) to the five existing [Lite] workflows in n8n project Roofops |
| State | all five unpublished; no schedule, public webhook or Twilio node; no live message sent |
| Not touched | Advanced RoofOps, Xero |

**Tests**
- **Before any fix:** the four new reproductions failed at Factory's defects: 4 failed, 63 passed.
- **After the fixes:** Lite 67 of 67.
- **Full check:** `npm run check` passed (lint, both typechecks, all tests): 627 passed, 46 skipped.

## Results

| Finding | Before (failing reproduction, unchanged code) | After | Local | Cloud (real Airtable and n8n, test sink) |
|---|---|---|---|---|
| **FIX 1. Marketing consent** | Factory's contact (Marketing Opt-In, "Legacy CSV import", no date) submitted a service-only form and then got **3 messages**: acknowledgement, marketing follow-up and review request | Acknowledgement only; no follow-up, no review request | PASS | **PASS** |
| **FIX 2. STOP across all contacts** | Of 11 contacts sharing a number, **1 was left** not opted out | All 11 opted out; all 150 (two pages) too | PASS | **PASS** (11, and 105 over two real Airtable pages) |
| **FIX 3. Early callback and duplicate SMS** | Message B's failure receipt marked unrelated Unknown message **A as Failed with B's SID**, so Monitor would resend A | A untouched, an alert raised, the retry held, no third SMS | PASS | Receipt correlation: **local only** (Twilio mode). Monitor never resends an Unknown send by itself: **PASS** |
| **FIX 4. Legitimate new enquiries** | A different-service enquiry 2 minutes after a paid job was answered **"duplicate"**, and its job marked Lost | Its own job (Contacted) and its own acknowledgement; an identical form twice is still one enquiry | PASS | **PASS** (34 seconds apart; and a real simultaneous double submission) |

## The fixes

### FIX 1. Marketing consent

**Rule.** Recorded wording must name the purpose, whoever recorded it.
- **What counts:** the form's words, or the tag `[reviews]` / `[marketing]`.
- **What doesn't:** consent for one purpose never covers another. Before, any non-form source was trusted for every
  purpose.

**When a person comes back and ticks a new box:**
- **Earlier evidence with both a source and a date** is kept. Its date is written beside its source, which the old
  code lost.
- **Earlier evidence without both** is moved to Notes, word for word, and no longer counts.

### FIX 2. STOP across all matching contacts

**Before.** Inbound Replies read one page and opted out at most ten contacts.

**Now.**
- **Reading:** it reads every page with n8n's pagination, following Airtable's `offset`, up to 20 pages (2,000
  contacts).
- **Writing:** it opts out every match in batches of 10, paced at 4 per second.
- **Failures:** a failed batch, or a list cut short, fails the run with the reason ("STOP from … was not fully applied:
  1 of 3 opt-out batches failed …"). Monitor turns this into an alert once the error workflow is set at go-live. It is
  never a quiet partial opt-out.

### FIX 3. Early callbacks and duplicate SMS

**Receipts.** A delivery receipt changes only the message with its exact Message SID. If it matches none, it changes
nothing and is raised as an alert:
- a failure, always;
- any receipt, while an unconfirmed message to that number exists.

**Monitor (Retry Requested).**
- **Linking:** a message is linked only by its SID.
- **No SID:** if Twilio has a message to the same number since the attempt, nothing is sent or linked, and a person
  checks it.
- **Unknown sends:** never resent by itself. A person sets it Failed, and it is then sent once.

### FIX 4. Legitimate new enquiries

The acknowledgement's Dedupe Key now carries an FNV-1a fingerprint of the enquiry (service, message, address,
postcode).
- **An identical form twice** still sends one SMS, and the copy's job is marked Lost.
- **A different enquiry** is its own job, with its own acknowledgement.

### Test support (models real behaviour)

- **Demo Airtable:** pages like Airtable (100 per page, `offset`).
- **Lite runner:** executes n8n's pagination option.
- **Fixtures:** their synthetic consent wording carries the tags.

**Earlier tests changed to the new rules.**
- **Retry and receipt rule:** six tests. Unknown sends are held, not settled by number. Each still asserts that no
  duplicate SMS is sent.
- **Dated source:** two tests.
- **Test 9:** now covers the same form resent hours after its job was paid. It stays a New Lead, gets no second text,
  and is not marked Lost.

## Cloud deployment

**Backups (git-ignored).**
- `lite/dist/cloud-backup-20261021.local/` holds the pre-`82b5684` versions.
- `lite/dist/cloud-backup-20261021b.local/` holds the `82b5684` versions replaced today.
- n8n's version history also keeps both.

| Workflow | ID | Previous version | Deployed version |
|---|---|---|---|
| [Lite] Monitor | `Tmk4lj7VrbHix9A9` | `d29db26e-974c-4a88-b572-f2e41af587b7` | `9cad5e02-7bf0-4e5f-8298-89aa0672e774` |
| [Lite] Instant Lead Follow-Up | `9BjHeFBUKqnmQqHl` | `a0e16aaf-ebb5-4278-ae79-4cfde5cb3494` | `50b4406e-7847-4718-b8e3-340b814889e2` |
| [Lite] Review Requests | `WzFUcqFQnpEh309s` | `ade3bea2-f2c1-49c6-86b3-15aecdeb4474` | `f0e622b4-a08c-4e3a-a069-aed06510dec1` |
| [Lite] Lead Reactivation | `FYc1hpB9RAcwg2SH` | `db5e8b64-a23a-42dc-8fa6-a74d9b8a7293` | `dacf7ba9-b471-43df-9848-6e31ae0362f3` |
| [Lite] Inbound Replies | `3Jeal7RQAhUmgLZ3` | `0e722307-18f5-4f04-9908-090d3fa17ce9` | `1d973e66-a4d9-4904-9645-c278f38dec03` |

**Verification.** Each workflow was compared with the export through the n8n API, after the deployment and again
after the tests. All five were identical both times.

**What was compared:**
- every node property, including the pagination and batching options;
- every connection;
- every credential;
- every setting.

**Two deliberate differences:**
- the error workflow is left for go-live;
- `availableInMCP` is on, for the test runs.

**Also confirmed:** the only credential is Airtable, and there are no Twilio nodes.

## Cloud runs (synthetic "ZZ Gate …" records, Demo Data ticked, Record Type Test)

**FIX 4.**
- **3435:** Riley's first enquiry was acknowledged (key `lead-ack:0400000642:2026-10-21:7c5g18`). Staff set the job
  Paid.
- **3441:** a different-service enquiry, 34 seconds later, got key `…:7ilwru`, Simulated Sent. Job LJ-20261021-X2W6 is
  Contacted; LJ-20261021-W4YV stays Paid.
- **3447 and 3448:** the same form, as two concurrent executions. Both passed the duplicate check. 3447 sent the one
  acknowledgement; 3448 lost the reservation and answered "duplicate". Its job, LJ-20261021-9G27, is Lost.

**FIX 1.**
- **3456 and 3457:** service-only forms from Lena (Factory's case) and from Lars (the same, plus marketing wording but
  no date). Each now holds only "Contact me about this enquiry and my job. [SMS]". Each legacy record moved to Notes
  word for word; the marketing tick was left as it was.
- **3478 (Reactivation):** 0 planned. Lena, Lars and Sami (staff evidence for SMS only, with a marketing tick) were
  excluded as "marketing permission is not in the recorded consent wording".

**FIX 2.**
- **3466:** STOP from the number of Factory's 11 contacts. One page of 11; batches of 10 and 1, both HTTP 200.
- **3470:** STOP from the number of 105 contacts. Airtable pages of 100 (with `offset`) and 5; 11 batches, all HTTP
  200, in 7.2 seconds.
- **Airtable check:** 116 of 116 opted out, none left.
- **3478:** the eleventh duplicate's quiet job was excluded as "opted out".

**FIX 3 (Monitor).**
- **3485:** an Unknown acknowledgement with Retry Requested was held ("not resent: its result is unknown (test mode
  cannot check); …").
- **3488:** staff set it to Failed, and it was sent once (`…:retry:2`, Retry Of LM-20261021120810-P771).

**All runs.** Every Lite run since the deployment (3435–3488, 12 runs) was manual and succeeded.

**Advanced RoofOps.** "[RoofOps] 06 Airtable Changes → Postgres" ran 43 times on Airtable change pings. The sampled
runs ended at "Advance Payload Cursor", with no record changes.

## Not verified with real Twilio (test sink only)

- **FIX 3, receipts:** delivery-receipt correlation (B's callback, A untouched, unmatched-receipt alerts). Proven
  locally against the fake Twilio only: the test sink has no receipts.
- **FIX 3, Monitor's Twilio lookups:** by Message SID, and by number (held when there is no SID). Local only.
- **Real Twilio behaviour:** concurrency, callback ordering, timeouts and queued messages are not verified by any
  test-sink run.
- **FIX 2, signed STOP:** a STOP arriving in Twilio mode (signed, Basic Auth) is local only. The cloud runs used the
  test-sink reply path, which runs the same nodes after Verify Request.

## Left in place (nothing deleted)

- **FIX 1:** 3 contacts (Lena, Lars, Sami).
- **FIX 2:** 116 contacts.
- **FIX 3 and FIX 4:** 4 contacts (Riley, Uma, and Tess twice: the simultaneous double submission made two Tess
  contacts, as before this change; one job is Lost).
- **Also:** their jobs and messages.

All are marked Test, hidden from staff pages, and to be deleted before go-live with the other test records.
