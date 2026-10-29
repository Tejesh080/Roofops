# Evidence: RoofOps Lite v2, cloud batch B (n8n workflows and acceptance tests), 2026-10-21

You approved batches A and B of `lite/demo/cloud-v2-plan.md` in chat on 2026-10-21. Batch A is in
`evidence/lite-v2-batch-a-20261021.md`. This file covers batch B. It ran on 2026-10-21 between 01:17 and 01:42 Brisbane
time (2026-10-20 15:17–15:42 UTC; the times below are UTC). Record and workflow ids are in
`lite/demo/cloud-resources.demo.json` (`n8n`, `airtable.v2BatchB`).

**No SMS or email was sent.** Every message went through the test sink: Simulated Sent rows with SIM… ids. All 23 rows
in Lite Message Log are Demo Data, with `0400 000 xxx` or `example.test` recipients. No Twilio credential exists in n8n
yet (batch C).

## 1. Workflows created (n8n Cloud, project Roofops, all unpublished)

| Workflow | Id | Nodes |
|---|---|---|
| [Lite] Monitor | `Tmk4lj7VrbHix9A9` | 33 |
| [Lite] Instant Lead Follow-Up | `9BjHeFBUKqnmQqHl` | 34 |
| [Lite] Google Review Requests | `WzFUcqFQnpEh309s` | 20 |
| [Lite] Lead Reactivation | `FYc1hpB9RAcwg2SH` | 20 |
| [Lite] Inbound Replies | `3Jeal7RQAhUmgLZ3` | 24 |

- **Source:** created with `create_workflow_from_code` from `lite/dist/demo/*.sdk.ts`. Monitor went first, so its id
  could go into `n8n.errorWorkflowId` before Inbound Replies (the only export that embeds it) was built.
- **Exact copies:** a read-only comparison through the n8n API checked each cloud workflow node by node against
  `lite/dist/demo/*.json`. It compared type, version, parameters (all Code), credentials, `onError` and connections, and
  all five match. To prove the comparison works, a one-character change to Plan Health was reported as a difference.
  The comparison was run again after the Monitor fix (section 4): all five still match.
- **Settings:** timezone Australia/Brisbane and "save manual executions" on all five.
- **State:** all five are `active: false` with no active trigger.

**Error workflow: not set (finding).** `update_workflow` refused [Lite] Monitor as the error workflow of the other
four: "has no published version, so n8n cannot run it". Publishing Monitor would start its 2-hourly schedule, which is a
live activation and was not approved. So:
- the setting moves to go-live, after Monitor is published (`lite/DEPLOY.md` step 8, `SETUP-CHECKLIST.md`);
- before go-live it would change nothing anyway: n8n runs error workflows only for production executions.

## 2. Before the tests

| Table | Records |
|---|---|
| Lite Contacts | 17 (the 14 from v1 and the 3 v2 people from batch A) |
| Lite Properties | 17 |
| Lite Jobs | 18 |
| Lite Message Log | 12 |
| Lite Alerts | 0 |

The six Advanced RoofOps tables had 13, 8, 12, 20, 29 and 10 fields, as after batch A.

## 3. Acceptance tests (manual executions, test sink)

The tests ran at 01:30 on 21 October in Brisbane, so "due" and "quiet" were judged at that moment.

| Test | Execution | What happened | Result |
|---|---|---|---|
| **A** new lead | 3145 | **ZZ Lite Demo v2 Chloe Hart**, SMS and review boxes ticked. Contact created with Consent SMS and Review Opt-In, plus the evidence: Consent Source "Website form (https://example.test/contact)", Consent Recorded At, and Consent Wording "Contact me about this enquiry and my job. [SMS]" / "After the job, send me a link to leave a review." Property and job were created. One acknowledgement was reserved as Sending (Purpose Operational, Attempts 1, On Success), then recorded as Simulated Sent `SIMdJ85ngB0uUB9Bs`, and the job moved to Contacted. | Pass |
| A, invalid input | 3151 | Name "Z", phone "12345", a bad email: answered 400 with four reasons. Nothing written. | Pass |
| **C** duplicate | 3152 | The same enquiry again: answered "already have this enquiry", logged as Skipped "repeat enquiry within 30 days of LJ-20261020-N5QH". No second message, contact or job. | Pass |
| **C** race | 3154 | One synthetic reservation was written first: Sending, the same Dedupe Key `lead-ack:0400000203:2026-10-20`. Then **ZZ Lite Demo v2 Leo Park** submitted. Pick Winners chose the earlier row: Leo's own reservation became Skipped ("duplicate: ZZ-RACE-PRE-0400000203 already handles this message"), nothing was delivered, the answer was "already have this enquiry", and the losing job was set to Lost. | Pass |
| **D** reviews | 3161 | Four finished jobs. **Hannah** (Review Opt-In with source and date): one review request, Purpose Review, Simulated Sent, job Review Status Sent. **ZZ Lite Demo v2 Isla Grant** (added for this test: Review Opt-In ticked, no record): Skipped "consent not recorded (source and date)". Grace and Emma: not due yet (finished less than 2 days earlier). | Pass |
| D, second run | 3165 | Sent 0, planned 0: Hannah and Isla are marked, and the other two are still not due. | Pass |
| **E** reactivation | 3166 | 10 open leads. **Oscar** (Marketing Opt-In with source and date): one follow-up, Purpose Marketing, Reactivation Count 1. **Ruby** (Marketing ticked, no record): excluded, "consent not recorded (source and date)". The other exclusions are 2 within the cooldown, 1 with no marketing permission and 1 opted out; 4 leads are still active. No v1 contact without a record was messaged. | Pass |
| **F** STOP | 3170 | JSON reply "STOP" from Oscar's number: contact Opted Out with a time, Marketing Opt-In cleared, reply logged as Opt-Out (Purpose Inbound). The answer is an empty TwiML, so nothing is sent back. | Pass |
| F, later message | 3173 | A new enquiry from Oscar, with every box ticked again. The job is recorded, but the acknowledgement is Skipped "opted out", and the new ticks did not undo the STOP. | Pass |
| **G** monitor, run 1 | 3176 | The race reservation was 30 minutes old and still Sending. It became Unknown, Error Code `stuck`, with "it may have been sent; check before retrying". Two alerts were raised: Delivery Unknown, and Stuck Lead for LJ-DEMO-A3. Nothing was sent. | Pass, with the defect in section 4 |
| G, run 2 | 3179 | Retry Requested was ticked on that row. Lite resent it once: new row `RT-20261020153641-TLBN`, Simulated Sent, "Retry Of: ZZ-RACE-PRE-0400000203". The original's Retry Requested was cleared, Attempts 2, Reason "…; resent as attempt 2". No duplicate alerts. | Pass |
| G, run 3 | 3182 | No resend and no new alert. | Pass |

**Not shown in the cloud:**
- **Error Trigger** (Workflow Failed alert): the workflows are unpublished, and n8n runs error workflows only for
  production executions. It is verified locally (test G) and becomes a go-live check (DEPLOY.md step 8).
- **The Twilio paths** (signed webhooks, delivery receipts, error codes, the check before a retry): batch C, which needs
  credentials. They are verified locally against a fake Twilio.

## 4. Defect found and fixed

In Monitor run 1, the Delivery Unknown alert read "has no confirmed result: **.** Tick Retry Requested…". When a row is
turned from stuck Sending into Unknown in the same run, Plan Health wrote the new reason but built the alert from the
old, empty one.

- **Fix:** `lite/n8n/src/monitor.sdk.ts` keeps the reason it writes, and both alerts use it.
- **Test:** test G in `test/lite.test.ts` now checks the alert text.
- **Red-green:** with the old Plan Health, the test fails with exactly the cloud text ("has no confirmed result: .");
  with the fix it passes. All 40 Lite tests pass.
- **Cloud:**
  - the Monitor Plan Health node was updated (`update_workflow`, version "Plan Health: Delivery Unknown alert shows the
    stuck reason");
  - the comparison again reports all five workflows identical to the rebuilt exports;
  - one more labelled synthetic stuck row (`ZZ-STUCK-CHECK-0400000404`) was raised by execution 3183 with the full
    reason.

The first alert keeps its old text as a record.

## 5. Rows added by hand for the tests

All are Demo Data and named `ZZ…`:

| Row | Why |
|---|---|
| `ZZ-RACE-PRE-0400000203` (Message Log) | The reservation that wins the race in test C. Attempted At was set 30 minutes back, so the same row also serves test G as a stuck message. Linked to Leo's contact after his run. Retry Requested ticked before Monitor run 2. |
| ZZ Lite Demo v2 Isla Grant and job LJ-DEMO-V2-R2 | The review-side case of "box ticked, no record" (test D). |
| `ZZ-STUCK-CHECK-0400000404` (Message Log) | Re-check of the Monitor fix. |

## 6. After the tests

| Table | Records | Change |
|---|---|---|
| Lite Contacts | 20 | Chloe and Leo (workflows), Isla (by hand) |
| Lite Properties | 18 | Chloe's |
| Lite Jobs | 22 | Chloe, Leo (Lost), Oscar's new enquiry, Isla |
| Lite Message Log | 23 | +11 |
| Lite Alerts | 3 | all Open |

**Nothing outside the Lite tables changed:**
- **Advanced tables:** 234 records (41 + 6 + 53 + 66 + 33 + 35), the same as before v1, and the same field ids.
- **[RoofOps] 06:** it ran 27 times on the Lite writes (base-wide webhook), all successful. Each run read the change,
  found nothing it owns ("no_events"), wrote no corrections and only advanced its change cursor. This is the shared-base
  behaviour recorded for v1; client bases are separate.
- **Not called:** Xero, Supabase business tables, Twilio and workflows 01–10. The Lite workflows call only
  api.airtable.com.

## 7. v1 archived

All five v2 workflows passed, so the four v1 Lite workflows were archived: `6GlAPXRMVAEyK9pV`, `LdPy36pX3jKJxd2r`,
`ECE108TYrOoHsTQh` and `vc4DEkcDxXnEdLmr`. The project now lists only the five v2 workflows. Archiving can be undone in
n8n.

## 8. Observations (not fixed here)

- **Demo greeting:** in test A the greeting is "Hi ZZ", because the first name is taken from the synthetic display
  name "ZZ Lite Demo v2 …". Real names are unaffected. Later payloads passed `first_name`.
- **Retried rows stay on Needs attention:** after a successful resend, the original row stays Unknown. That is
  accurate, since nobody knows whether it arrived, but the Interface tab "Needs attention" (Failed or Unknown) keeps
  listing it. A follow-up could hide rows already resent (Attempts > 1) from that tab. It is an Interface change, not
  done in this batch.

## Status

| | |
|---|---|
| **BUILT** | Everything in commit 7bcab58, plus the Monitor fix. |
| **CLOUD-VERIFIED** (test sink) | Tests A, C, D, E, F and G above, on the real n8n Cloud and Airtable. |
| **LIVE-MESSAGING-VERIFIED** | Nothing yet. Needs batch C (Twilio credentials) and batch D (first real SMS, after you approve the sender, the recipient and the test). |
