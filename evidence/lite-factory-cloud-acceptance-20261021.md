# RoofOps Lite: Factory fixes deployed to n8n Cloud and accepted on real Airtable (2026-10-21)

## Summary

Deployed with the user's approval, as one supervised batch.

- **What was deployed:** the five [Lite] workflows from commit `82b5684` (`lite/dist/demo`, test-sink build), into n8n project
  Roofops.
- **State:** all five stay unpublished. No schedule, public webhook or Twilio sending was enabled, and no SMS was sent.
- **What was not touched:** Advanced RoofOps, Xero, real customers and the five showcase customers.
- **Rollback:** not needed.

## 1. Backup (before any change)

- **Where:** the five cloud definitions were saved in full to `lite/dist/cloud-backup-20261021.local/` (git-ignored).
- **State before:** all unpublished, no pinned data.
- **Rollback command:** `deploy-kit.mjs restore` puts these files back. n8n's own version history also holds them.

| Workflow | ID | Version before | Version deployed |
|---|---|---|---|
| [Lite] Monitor | `Tmk4lj7VrbHix9A9` | `05b19f0e-ce4a-42e1-8228-fea992e48c20` | `d29db26e-974c-4a88-b572-f2e41af587b7` |
| [Lite] Instant Lead Follow-Up | `9BjHeFBUKqnmQqHl` | `ab83b9aa-427b-48ff-a9c5-a100486f126d` | `a0e16aaf-ebb5-4278-ae79-4cfde5cb3494` |
| [Lite] Review Requests | `WzFUcqFQnpEh309s` | `d34beefc-7678-4c7b-9e40-6ef6fff3a4a7` | `ade3bea2-f2c1-49c6-86b3-15aecdeb4474` |
| [Lite] Lead Reactivation | `FYc1hpB9RAcwg2SH` | `2264d1cc-42c9-49ad-893d-e202184327fe` | `db5e8b64-a23a-42dc-8fa6-a74d9b8a7293` |
| [Lite] Inbound Replies | `3Jeal7RQAhUmgLZ3` | `75b118eb-be35-4d51-ab0d-81cf9952dbe4` | `0e722307-18f5-4f04-9908-090d3fa17ce9` |

## 2. Verification of the cloud copies

Each cloud workflow was compared with the export through the n8n API, after the deployment and again after all the
tests. All five were identical on both checks.

**What was compared:**
- every node property except its canvas position;
- credentials by ID;
- every connection, with its type and index;
- every workflow setting.

**Two deliberate differences:**
- `errorWorkflow` is left for go-live, because n8n accepts only a published Monitor as an error workflow.
- `availableInMCP` is on, so the acceptance runs could be started.

**Also confirmed on all five:**
- the only credential is Airtable (`3XbFnHjAd7mFvBD2`);
- there are no Twilio nodes;
- every workflow is unpublished;
- there is no pinned data.

**Cloud-specific defect found and fixed.** n8n's public API **merges** workflow settings on update instead of replacing
them.
- **Problem:** Inbound Replies kept two settings from the earlier Twilio trial build (do not save successful or failed
  production runs).
- **Fix:** an n8n `setWorkflowSettings` update set them back to the default.
- **Retest:** the comparison then passed.
- **Future deployments:** settings must be checked, not assumed.

## 3. Acceptance on real Airtable (test sink, no SMS)

**Test data.** 17 synthetic people named "ZZ Accept …", all with Demo Data ticked and Record Type Test (hidden from the
employee pages). Their numbers were in an unused block (0400 000 601–618) and their emails were `@example.test`.

**Pre-check.** Before each workflow-wide run (Monitor, Reactivation), I confirmed that it could change no existing
record:
- existing problems were already alerted;
- no existing quiet lead was eligible for a follow-up.

**How records were made.**
- **Lead Follow-Up:** created each test person through the deployed workflow.
- **By hand:** a duplicate contact, an older import (Zoe), and three synthetic history rows.
- **Edited as staff would:** Stage, Phone, consent boxes, and message status / Retry Requested.

| # | Finding | Cloud execution(s) | Result on real Airtable |
|---|---|---|---|
| 1 | Retries ignore withdrawn consent | 3331, 3332 (leads); **3383** (Monitor) | **Pass.** Cara (SMS consent unticked) gave "not retried: no SMS consent". Rhys's review request (review box unticked) gave "not retried: no permission for review requests". Control: Paige, consent intact, was resent once (RT-20261021064141-ZF2F). |
| 2 | Service consent enabled marketing | **3397** (Zoe's form), **3403** (Reactivation), **3418** (evidence merge) | **Pass.** Zoe has an old, unrecorded marketing tick; her form recorded only "[SMS, email]". Reactivation excluded her: "marketing permission is not in the recorded consent wording". Control: Remy, tagged [marketing], got one follow-up. On Remy's return form, the earlier [marketing] wording was kept and [reviews] added. |
| 3 | STOP misses duplicates | 3341; **3386** | **Pass.** STOP opted out both Dana records: the form contact and the duplicate staff typed in. |
| 4 | Phone edit hides STOP | 3342, 3343, 3345; **3387, 3388, 3389** | **Pass.** Each was opted out: Ellie (Phone edited to "0400 000 606"), Omar (STOP from the old number Lite had messaged) and Ivy (Phone typed as "+61 400 000 609"). Airtable `REGEX_REPLACE` works in the lookup, including on contacts with no phone (23 Lead Follow-Up and Inbound Replies runs, no error). |
| 5 | Queued retry sent twice | n/a | **Local only.** Needs Twilio mode: in test sink Monitor does not ask Twilio. |
| 6 | Reactivation bypasses cooldown across months | 3354, 3355; **3403** | **Pass.** Hugo (an Unknown follow-up in September) was held: "earlier attempt awaits a retry decision". Cleo (a Sent follow-up in September, no Reactivation Sent At) was held: "followed up within the cooldown". |
| 7 | Early failure receipts discarded | n/a | **Local only.** Delivery receipts exist only in Twilio mode. |
| 8 | Paid moved back to Contacted | 3333; **3383** | **Pass.** Paige's job was Paid, and her failed acknowledgement was resent. The stored "move to Contacted" update was dropped and the job stayed Paid. |
| 9 | New enquiry after a paid job marked Lost | 3359; **3417** (12 minutes later) | **Pass.** Petra's first job stayed Paid. The new enquiry (LJ-20261021-FLHL) stayed New Lead, with its acknowledgement Skipped: "already sent this message earlier today". |
| 10 | Apostrophe matched the wrong customer | 3369; **3407**, **3414** | **Pass.** Airtable accepted the escaped formula. `zz.o'neill@` did not match `zz.oneill@`, so a new contact was created. Her reply was linked to her own contact and job. |
| 11 | New number texted the old number | 3370; **3408** | **Pass.** Nina came back with the same email and a new number. A new contact was created, and the acknowledgement was logged to 0400 000 616, not 615. |

**All cloud runs, by workflow:** 3331–3333, 3341–3343, 3345, 3354–3356, 3359, 3369, 3370, 3383, 3386–3389, 3397, 3403,
3407, 3408, 3414, 3417, 3418. All are manual runs and all succeeded.

**Advanced RoofOps (63 runs in the same period).**
- **What ran:** the published "[RoofOps] 06 Airtable Changes → Postgres" received the Airtable change pings.
- **What it did:** every run ended at "Any Record Changes? → no" and advanced its cursor; nothing was written.
- **Changes made:** none.

**Interface.** The Pipeline still shows exactly the five [Demo] showcase cards, and Customers shows the five [Demo]
customers. No acceptance record appears.

## 4. Left in place (nothing deleted)

- **Test people:** the 17 "ZZ Accept" contacts, with their jobs, messages and three synthetic history rows. They are
  marked Test, hidden from staff pages and listed on Admin. Delete them with the other test records before go-live.
- **Alerts:** three new Delivery Failed alerts for the synthetic failures (Demo Data).

## 5. Observations (not among the 11, not blockers)

- **STOP log on duplicates.** When duplicates share a number, the STOP reply is logged against whichever record Airtable
  returns first. In 3386 that was the staff-typed duplicate, which has no job. Both records were opted out.
- **Repeated wording line.** When a returning person ticks a new box, the merged wording repeats the service line,
  because each form's wording is recorded whole. The record is accurate; the repetition is cosmetic.
