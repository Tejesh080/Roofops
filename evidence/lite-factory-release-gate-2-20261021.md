# RoofOps Lite: Factory release gate 2, three SMS safety failures closed (2026-10-21)

## Summary

| | |
|---|---|
| Code | commit `c43d4d8`, branch `feature/roofops-lite` |
| Deployed | `lite/dist/demo` at `c43d4d8` (test sink) to the five existing [Lite] workflows |
| State | all five unpublished; no schedule, public webhook or Twilio node; no live message sent |
| Not touched | Advanced RoofOps, Xero |
| New tables or fields | none |

**Tests**
- **Before any fix:** the three new reproductions failed at Factory's defects (`gate2-red`: 3 failed).
- **After the fixes:** Lite 70 of 70.
- **Full check:** `npm run check` passed (lint, both typechecks, all tests): 630 passed, 46 skipped.

## Results

| Failure | Before (failing reproduction) | Fix | Local | Cloud (real Airtable and n8n, test sink) |
|---|---|---|---|---|
| **1. STOP suppression** | 11 contacts, the second contact update got a 503: the eleventh contact still got an acknowledgement, a follow-up and a review request | The STOP's own Message Log row (Opt-Out, "from <number>") is the number's suppression: saved first, retried once, and read just before every send | PASS | **PASS**: 3506 saved the Opt-Out row before both contact updates. 3493 blocked a contact whose own record looked messageable ("not sent: this number replied STOP (IN-20261021120324-ZNYQ)") |
| **2. Complete reactivation history** | An Unknown follow-up at history record 101 was ignored, and the follow-up was sent | Earlier follow-ups read for exactly the candidate jobs (FIND on the Dedupe Key), across every page. An unreadable page stops the run before anything is sent | PASS (101, 150, failed page) | **PASS**: 3493's scoped, paginated query on real Airtable found the 7 relevant rows; Hugo's unconfirmed attempt still holds his job |
| **3. Uncertain SMS retries** | An accepted SMS (on Twilio's second history page), set from Unknown to Failed by staff, was resent | Resend only with proof it did not arrive: Twilio refused it when sent, or Twilio reports it failed by its Message SID. Otherwise held, with an alert. The by-number Twilio lookup is removed | PASS | **PASS**: 3510 held the hand-edited Failed row ("no proof it was not delivered (no_response)", alert `msg:recMdaqINbCQhplU7:retry-held`) and resent the refused one once. Twilio was not asked |

## Details

### 1. STOP suppression

**How a STOP is saved (Inbound Replies).** The reply is now logged before anything else.
- **The suppression:** for a STOP, that row is the number's suppression: Status Opt-Out, To "from <number>".
- **Saving it:** it is tried twice (Write Reply Log, then Write Reply Log Again).
- **Contacts:** the contact opt-outs follow, in batches of 10, paced at 4 per second.

**How a send checks it (shared send pipeline).** "Find Suppressions" reads the Opt-Out rows for the planned
recipients right before delivery. This covers the lead acknowledgement, review requests, reactivation and Monitor
retries.
- **A suppressed number** is blocked: Skipped, "not sent: this number replied STOP (<ref>)".
- **If the list cannot be read completely,** the run fails and nothing is sent.

**When something fails.**
- **A contact update fails:** the run fails with "STOP from … is saved and the number is suppressed, but 1 of 2 contact
  updates failed …". Monitor raises it once the error workflow is set at go-live.
- **Both saves fail:** "STOP from … could not be saved, so the number is NOT suppressed …". The contacts are still
  updated.

**Repeated STOP.** Another Opt-Out row is added; nothing else changes.

**Re-subscribing.** Staff untick Opted Out, and the owner sets the number's Opt-Out row Status to Received. The row
and its text stay as the record.

### 2. Reactivation history

**The query.** `historyFormula` is built in Contact Formula from the candidate jobs: `FIND('reactivation:<job>:',
{Dedupe Key})`. "Find Earlier Follow-Ups" reads it to the last page, and `allRecords` refuses an incomplete list.

**Tests:**
- 100 other jobs' rows, then the Unknown;
- 149 old rows for the same job, then the Unknown (a second page);
- page 2 returns a 503: the run fails with "find earlier follow-ups: Airtable HTTP 503", and nothing is sent.

### 3. Uncertain retries

**Plan Health** passes a Retry Requested message on only with proof:
- a Twilio error code and no Message SID (Twilio refused it, so no message was created);
- or a Message SID to ask Twilio about.

Anything else gets "not resent: no proof it was not delivered (…)" and a Delivery Unknown alert, raised once.

**Retry Checks** asks Twilio only by Message SID. Plan Retries then decides:
- **failed, undelivered or canceled:** resend;
- **any other status:** corrected, not resent;
- **404:** held;
- **no answer:** postponed.

**Earlier tests updated** (five retry tests, one STOP wording test):
- a server error, or a timeout set to Failed by hand, is held;
- the fixed-number retry needs no Twilio lookup;
- the Paid case uses a refused message.

## Cloud deployment

**Backup.** The `d6cc44f` versions are in `lite/dist/cloud-backup-20261021c.local/` (git-ignored) and in n8n's version
history. Earlier backups are in the `cloud-backup-20261021.local` and `cloud-backup-20261021b.local` folders.

| Workflow | ID | Previous (`d6cc44f`) | Deployed (`c43d4d8`) |
|---|---|---|---|
| [Lite] Monitor | `Tmk4lj7VrbHix9A9` | `9cad5e02-7bf0-4e5f-8298-89aa0672e774` | `ab0f14c6-b596-44ff-ad73-02039087105b` |
| [Lite] Instant Lead Follow-Up | `9BjHeFBUKqnmQqHl` | `50b4406e-7847-4718-b8e3-340b814889e2` | `cd14b31d-ca74-4fa8-bec9-8e6675a4fd3b` |
| [Lite] Review Requests | `WzFUcqFQnpEh309s` | `f0e622b4-a08c-4e3a-a069-aed06510dec1` | `cdc704f6-6d2e-4df1-8ff9-17fd5ba9b56b` |
| [Lite] Lead Reactivation | `FYc1hpB9RAcwg2SH` | `dacf7ba9-b471-43df-9848-6e31ae0362f3` | `77653460-84a1-487c-bc98-eaab38f7f4ad` |
| [Lite] Inbound Replies | `3Jeal7RQAhUmgLZ3` | `1d973e66-a4d9-4904-9645-c278f38dec03` | `49aeb37c-394b-41b9-b50a-4a9265ee2f02` |

**Verification.** Each workflow was compared with the export, after the deployment and again after the tests. All five
were identical both times (every node, connection, credential and setting). The two settings differ on purpose, as
before.

**Runs.** The Lite runs since the deployment are 3493, 3497, 3498, 3506 and 3510: all manual, all succeeded.

**Advanced RoofOps.** "[RoofOps] 06" ran 18 times on Airtable change pings, as before.

**Records.**
- **ZZ Gate Dup 11:** its opt-out was unticked for check 1 and restored afterwards.
- **New synthetic test records:** 2 "ZZ Gate2 Pia Pair" contacts, plus Ursula and Rafael's leads. All are Test, hidden
  from staff pages, and kept.

## What Airtable and n8n cannot guarantee

**1. A STOP arriving during a send.**
- **The gap:** a send that read the STOP rows a moment before the STOP was saved can still go out. Airtable has no
  transaction that makes the check and the Twilio send one step. The window is the seconds between Find Suppressions
  and Twilio accepting the message.
- **Paths affected:** every automated send. The scheduled ones (review requests, reactivation) are the ones likely to
  be mid-run.
- **The law:** this is within the Spam Act's 5 working days, but it is not zero.
- **Recommendation:** for go-live, turn on Twilio's own opt-out handling on the sending number or Messaging Service
  (Advanced Opt-Out). Twilio then refuses later sends to that number (21610), which Lite already treats as an opt-out.
  If that cannot be confirmed for the client's Australian number, keep Review Requests and Lead Reactivation
  unpublished (manual runs only) and rely on staff timing.

**2. Airtable refusing both saves of a STOP.**
- **What happens:** Lite cannot record it. The run fails, n8n's error workflow raises it (once set at go-live), and
  Twilio logs a failed webhook.
- **The gap:** until someone records the STOP, only the contact opt-outs that did succeed protect the number.
- **Mitigation:** the same Twilio opt-out handling, and a Twilio fallback URL for the messaging webhook.

**3. Operator alert texts.** Monitor's alert texts to the business's own operator phone do not go through the pipeline,
and are not checked against STOP rows.

## Still to verify with live Twilio (not done; needs the live-test approval)

- **Twilio's own opt-out handling for the client's Australian sender:** that it is on, and that a send after STOP is
  refused with 21610.
- **The Message SID check:** Twilio answering by Message SID for real messages (failed/undelivered gives one resend;
  delivered gives a correction).
- **Receipts:** real delivery-receipt timing and ordering, and that unmatched receipts raise alerts.
- **Signed STOP:** a STOP in Twilio mode (signed, Basic Auth) going through the same save-first path.

## Real messaging

Still blocked:
- all five workflows are unpublished;
- the build is test sink, with no Twilio node;
- no live SMS was sent.
