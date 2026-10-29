# RoofOps Lite: activation discrepancy and Twilio configuration risks, read-only (2026-10-22)

**Status: investigation only.** Nothing was executed, published, unpublished, restored, archived or written in n8n,
Airtable or Twilio. No SMS was sent. The only file written is this one.

**Method.**
- **n8n:** read tools only: `search_workflows`, `get_workflow_details`, `get_workflow_history`, `get_workflow_version`
  and `search_workflow_executions`. Reads were made on 2026-10-22, around 11:30 to 11:45 UTC.
- **Airtable:** two record reads in the Lite Message Log (base `appMc8V0Wm29tEeHQ`, table `tblW8Uq5j5dW0B8RH`).
- **Repo:** file reads, plus a full-text search of earlier Claude session transcripts.
- **Earlier reports:** two read-only investigators reported before this pass. Their claims are used only where marked
  "investigator". Everything else was re-read here.

This file names no Auth Token, password or login. The Account SID appears only as `AC…942f`, and phone numbers only by
their last 3 digits.

## 1. Summary

**State on 2026-10-22, about 11:40 UTC:**

| Item | State | Evidence |
|---|---|---|
| `[Lite] Inbound Replies` `3Jeal7RQAhUmgLZ3` | **Published** with the live Twilio build | `get_workflow_details`: `active: true`, `activeVersionId` = `versionId` = `3009c821-2372-45e4-83dd-bc599e0326fa` |
| Its description | Still says "Demo config, test sink (JSON replies). Unpublished." | `search_workflows` |
| `[Lite] Instant Lead Follow-Up` `9BjHeFBUKqnmQqHl` | Inactive. Its draft is the live Twilio build | `active: false`, `activeVersionId: null`; version `bfccbea4`: CFG `mode: "twilio"`, 1 allowlisted recipient (***771), `allowAllRecipients: false` |
| `[Lite] Monitor` `Tmk4lj7VrbHix9A9` | Inactive. Its draft is the live Twilio build | `active: false`; version `e7ec9940`: same CFG; `operatorPhone: null` |
| Other 7 [Lite] workflows | Inactive | `search_workflows`, `active: false` for all |
| [Lite] executions since 2026-10-21T13:00Z | **None stored** | `search_workflow_executions startedAfter=2026-10-21T13:00Z`: 7 runs, none of them [Lite] (section 3) |
| S7 Message Log row `rec4IUGCUBSSiBd4N` (`LM-20261021152950-XRQA`) | Failed, Error Code 572003, Attempts 1, no Message SID, Retry Requested **not** ticked | Airtable read today. The fields come back empty, and Airtable omits empty fields |
| Message Log rows after 2026-10-21T15:29:50Z | None | Airtable read: the 55 rows with Attempted At on or after 2026-10-21; the latest is the S7 row |

**Why is Inbound Replies published?**
- The owner approved the live acceptance test ("i approve the live test including s9"; session transcript
  `local_3d969051-a055-41c5-b8a8-e453f9d5cf3b`). The plan allowed Inbound Replies to be published "for about 20
  minutes" (`evidence/lite-live-acceptance-plan-20261021.md:120`).
- Step S3 published it with the live build. The active version is `3009c821`, created 2026-10-21T13:44:14.025Z
  (`get_workflow_history`).
- S7 was refused (572003). The owner then stopped the test at 15:36Z ("STOP THE LIVE ACCEPTANCE TEST", same
  transcript; `evidence/recovery-report-20261022.md:46`).
- The clean-up step S12 was never run. Its first action is "Unpublish Inbound Replies" (plan `:139`, `:183`).
- The previous session said that Inbound Replies "stays published as it is now (Basic Auth protected); I'm not touching
  it unless you ask" (same transcript).

**In one line:** it is published because the approved test was stopped before its clean-up, not because anyone chose
to keep it live.

**NOT VERIFIED:**
- The exact publish time (reported as 13:44:32Z). No n8n read tool shows a publish event, and `updatedAt` did not
  change. It was published at or after 13:44:14Z.
- The time of the owner's approval (reported as 13:29Z). The transcript snippet has no timestamp.
  `evidence/recovery-report-20261022.md:53` gives 13:29Z.

## 2. The ten workflows

The active flags, `updatedAt` and descriptions of all ten come from `search_workflows`, read today. The settings come
from `get_workflow_details`. Rows marked "investigator" were not re-read in this pass.

| Workflow | ID | Active / activeVersionId | Current versionId | updatedAt (UTC) | Trigger, webhook auth | Saving (success / error / manual), error workflow | Build |
|---|---|---|---|---|---|---|---|
| Inbound Replies | `3Jeal7RQAhUmgLZ3` | **true** / `3009c821` | `3009c821` | 21 Oct 13:44:14 | Webhook POST `roofops-lite/reply`, **Basic Auth** (credential "Lite reply webhook (Basic Auth)") | none / none / true; **no error workflow** | Live Twilio (`lite/dist/demo-twilio-live.local`) |
| Instant Lead Follow-Up | `9BjHeFBUKqnmQqHl` | false / null | `bfccbea4` | 21 Oct **13:46:26** | Webhook POST `roofops-lite/lead`, **no auth** | default / default / **false**; none | Live Twilio |
| Monitor | `Tmk4lj7VrbHix9A9` | false / null | `e7ec9940` | 21 Oct 13:44:12 | Error Trigger, Every 2 Hours, manual | default / default / **false**; n/a | Live Twilio |
| Lead Reactivation | `FYc1hpB9RAcwg2SH` | false / null | `77653460` | 21 Oct 12:49:18 | Weekly Monday 09:00 | default / default / true; none | Test sink, `c43d4d8` (`evidence/lite-factory-release-gate-2-20261021.md:91`) |
| Google Review Requests | `WzFUcqFQnpEh309s` | false / null | `cdc704f6` | 21 Oct 12:49:17 | Daily 10:00 | default / default / true; none | Test sink, `c43d4d8` (release gate 2 `:90`) |
| Twilio Webhook Test | `CRYdGYERCuVGcaEs` | false / null | `4b9cab5e` (investigator) | 21 Oct 13:42:47 | Manual (investigator) | none / none / false (investigator) | Diagnostic |
| Twilio Webhook Login Setup | `0h3YTk1ewoemNQCq` | false / null | `550683d5` | 21 Oct 13:42:46 | Manual, no trigger listed | none / none / false | Diagnostic: creates Twilio's Webhook Setting and Rule (`evidence/lite-live-test-prep-20261021.md:76`) |
| Live Test Pre-check | `ikWTxNSgiH3u1TWr` | false / null | `237e4199` (investigator) | 21 Oct 13:42:45 | Manual (investigator) | none / none / false (investigator) | Diagnostic |
| Twilio Account Check (read-only) | `VcTE56qoxldxCeDt` | false / null | `4c2c1018` | 20 Oct 16:33:44 | No trigger listed | **Instance defaults** (no saving settings at all) | Diagnostic: lists recent messages and verified caller IDs (its description) |
| Twilio Account SID | `HWJdTkYMLBFXE5bn` | false / null | `467cb88d` | 20 Oct 16:24:59 | No trigger listed | none / none / false | Reads the Account list, "whose response includes the Auth Token" (its description) |

**Descriptions.** All five product workflows say "Demo config, test sink … Unpublished". That is true only for
Lead Reactivation and Google Review Requests.

**Error workflow.** None of the three workflows read in full has an `errorWorkflow` setting. The build would set
`Tmk4lj7VrbHix9A9` (`lite/config/demo-twilio-live.local.json:26`, `lite/build.ts:127`). It was left unset on purpose,
because n8n accepts only a published Monitor as an error workflow (`lite/DEPLOY.md:126-129`;
`evidence/lite-factory-cloud-acceptance-20261021.md:39`).

**saveManualExecutions = false on Instant and Monitor.**
- The local live build has `true` for both (`lite/dist/demo-twilio-live.local/*.json`, read today), so the value was
  changed in the cloud.
- **Instant:** this is planned (`evidence/lite-live-test-prep-20261021.md:35`). It fits the `updatedAt` of 13:46:26Z,
  which is later than its newest version (13:44:13Z).
- **Monitor:** NOT VERIFIED why. No plan line names it.

## 3. Version history: Inbound Replies, Instant Lead Follow-Up, Monitor

Each of the three has exactly three versions (`get_workflow_history`).
- **11:59Z:** the `d6cc44f` deploy.
- **12:49Z:** the `c43d4d8` test-sink deploy (`evidence/lite-factory-release-gate-2-20261021.md:86-92`).
- **13:44Z:** the live Twilio build of step S2.

| Workflow | Version | Created (21 Oct, UTC) | Content (read today) |
|---|---|---|---|
| Inbound Replies | `1d973e66-a4d9-4904-9645-c278f38dec03` | 11:59:36.984 | `d6cc44f` test sink (release gate 2 `:92`); content not read |
| | `49aeb37c-394b-41b9-b50a-4a9265ee2f02` | 12:49:19.191 | Test sink: CFG `mode: "test-sink"`. **Reply Webhook has no authentication.** JSON responses |
| | `3009c821-2372-45e4-83dd-bc599e0326fa` (**active**) | 13:44:14.025 | Live: Basic Auth on Reply Webhook; CFG `mode: "twilio"`, `inboundAuth: "basic-auth"`, `statusCallbacks: true`, allowlist ***771; TwiML text responses |
| Instant Lead Follow-Up | `50b4406e-7847-4718-b8e3-340b814889e2` | 11:59:33.148 | `d6cc44f` test sink (release gate 2 `:89`); content not read |
| | `cd14b31d-ca74-4fa8-bec9-8e6675a4fd3b` | 12:49:16.574 | Test sink: 35 nodes, `mode: "test-sink"`, a "Simulated Delivery" node, no Twilio node |
| | `bfccbea4-7f2e-4db5-a813-65184fba60b7` (draft) | 13:44:13.168 | Live: 35 nodes, `mode: "twilio"`. "Send SMS (Twilio)" posts To, Body `sms_appointment_reminders` and StatusCallback to `…/Accounts/AC…942f/Messages.json`, with no From |
| Monitor | `9cad5e02-7bf0-4e5f-8298-89aa0672e774` | 11:59:32.248 | `d6cc44f` test sink (release gate 2 `:88`); content not read |
| | `ab0f14c6-b596-44ff-ad73-02039087105b` | 12:49:15.651 | Test sink: 35 nodes, `mode: "test-sink"`, "Simulated Delivery". No Twilio HTTP node (Retry Checks returns early unless the mode is `twilio`) |
| | `e7ec9940-6fb0-4ae5-9d0a-971ad21d9b1d` (draft) | 13:44:12.237 | Live: 37 nodes, `mode: "twilio"`. Twilio HTTP nodes: Send SMS, Alert Operator, Check Delivery. `operatorPhone: null` |

**Backups.** The backup `lite/dist/cloud-backup-20261021d.local/` was written at 13:44:08–10Z, just before S2. Its
three files carry versionIds `49aeb37c`, `cd14b31d` and `ab0f14c6`, all `mode: "test-sink"` (read today). Those are the
targets for a return to the test sink.

**What the live Inbound Replies can do** (version `3009c821`, all 32 nodes read):
- **No Twilio calls.** Every HTTP node calls `api.airtable.com`. It cannot send an SMS.
- **Checks on a request:** n8n's Basic Auth runs first. Lite then refuses any query parameter other than `event` and
  any AccountSid other than its own. It does not check `X-Twilio-Signature`.
- **A message:** it writes one Message Log row (Received or Opt-Out), retried once.
  - On a STOP keyword, it opts out every matching contact.
  - Otherwise it sets Last Activity At on the open job, and moves New Lead to Contacted.
- **A receipt (`?event=status`):** it updates only the row with that exact Message SID, and never downgrades it. Error
  21610 opts the contact out. A receipt with no matching row raises a Lite Alert.
- **Failures:** a failed run throws. With error-data saving `none` and no error workflow, that failure leaves no trace
  in n8n.

**Executions since 2026-10-21T13:00Z** (`search_workflow_executions`, complete, `nextCursor: null`):

| ID | Workflow | Started (UTC) |
|---|---|---|
| 3529, 3530, 3531 | `lD6BOf2dhZZpSoEH` ([RoofOps] 06, Advanced) | 21 Oct 15:29:50.594, 15:29:51.105, 15:29:52.890 |
| 3537 | `1e0844GE0OOh7Qyq` | 21 Oct 16:45:49 |
| 3546, 3557, 3568 | `o8gMJHVuqJMSNhpP` | 21 Oct 20:35, 22 Oct 01:35, 22 Oct 06:35 |

**Last stored [Lite] runs:** Inbound 3506 (12:51:16Z), Instant 3498 (12:51:04Z) and Monitor 3510 (12:52:00Z), all
manual.

**S7 left no n8n record.** That fits Instant's `saveManualExecutions: false`. The Airtable row is the direct evidence
of S7.

**Inbound Replies saves nothing,** so the absence of runs does not prove it received no requests. Only the Message Log
shows that no reply or receipt was logged (section 1).

## 4. Twilio configuration risks

"Approval needed" means the owner's explicit yes before anyone acts. No restoring action has been taken.

| Risk | Trigger | Likelihood | Impact | Restoring action | Approval needed |
|---|---|---|---|---|---|
| R1: Inbound Replies published with the live build, beyond its approved 20 minutes | An SMS to the trial number (if S5's Custom webhook was saved), a status callback, or anyone holding the Basic Auth login and the Account SID | Low: no Message Log row since 15:29:50Z | Airtable writes only: reply and opt-out rows, contacts opted out, job stage moved, receipt status set by SID. **No SMS** (no Twilio node). Failures are invisible: nothing saved, no error workflow | Unpublish `3Jeal7RQAhUmgLZ3` | Yes (owner's standing rule; `evidence/recovery-report-20261022.md:53-54`) |
| R2: Instant draft holds the live config | A manual run with a lead for ***771, or a publish. The lead webhook has **no auth**, so once published any internet POST creates Airtable records. Only ***771 can be sent to: anything else is Skipped before Twilio | Low (needs a run or a publish) | A real Twilio send to ***771 without a send approval. Today Twilio refuses it (572003, one observation). Twilio's trial behaviour changed between 20 and 21 Oct (572002, then 572003), so acceptance later is NOT excluded | Restore version `cd14b31d` (test sink), then check node for node against `lite/dist/demo` | Yes |
| R3: Monitor draft holds the live config and can resend the S7 row | Retry Requested ticked on `rec4IUGCUBSSiBd4N`, then a Monitor run (manual or published) | Low now. Retry Requested is not ticked (Airtable read). Monitor's own alert text tells staff to tick it after a fix | A resend to ***771. Failed + numeric code (`572003` matches `^[0-9]{4,6}$`) + no SID counts as proof (deployed Plan Health in `e7ec9940`; `lite/n8n/src/monitor.sdk.ts:75`), unless the contact or consent check stops it. If published: Airtable writes every 2 hours. Alert Operator cannot send (`operatorPhone: null`) | Restore version `ab0f14c6` (test sink); keep unpublished | Yes |
| R4: Twilio Try out SMS Auto-reply set to Custom → reply URL (S5) | The verified phone texts the trial number | NOT VERIFIED whether S5 was saved | The same as R1 while published. After unpublishing, Twilio gets 404s and logs errors; no data is changed | Owner: Try out SMS › Auto-reply › **Standard** › Save | Yes (Twilio setting) |
| R5: Twilio Webhook Setting (login inline) and `EXACT_MATCH` Rule for the reply URL (S1) | Any Twilio webhook to that URL | They existed after S1 (`evidence/recovery-report-20261022.md:60`). Current existence NOT VERIFIED | Twilio presents the n8n login to the reply URL. With Inbound Replies published, those requests are accepted | Unpublish R1 first. Then delete the Rule and the Setting (Twilio Webhooks configuration API, or Console if available). The ids may be in the Login Setup's data table (`evidence/lite-live-test-prep-20261021.md:76`; NOT VERIFIED, not read) | Yes (Twilio setting) |
| R6: Twilio Account SID helper `HWJdTkYMLBFXE5bn` | A manual run | Low | The Account list response includes the Auth Token (its own description). Saving is off, but a manual run in the editor would show node output (inference, NOT VERIFIED) | Archive `HWJdTkYMLBFXE5bn` (recommended after the test: `evidence/recovery-report-20261022.md:65-66`) | Yes |
| R7: Twilio Account Check `VcTE56qoxldxCeDt` keeps instance-default saving | A manual run | Low | A saved run would store recent messages and verified caller IDs (phone numbers) | Archive, or set saving to none | Yes |
| R8: Login Setup `0h3YTk1ewoemNQCq` | A manual run with a login staged in its data table | Low | Re-creates the Twilio Setting and Rule (R5) | Archive | Yes |
| R9: No error path on any [Lite] workflow | A failed Inbound Replies run, for example "STOP … could not be saved" | Low | No n8n record and no Lite Alert. Twilio's STOP block is the only backstop (plan `:76-80`) | Removed by R1 (unpublish). At go-live: publish Monitor, then set the error workflow (`lite/DEPLOY.md:276-279`) | Go-live decision |
| R10: Lite shares the Advanced Airtable base | Any Lite write | Certain | Wakes `[RoofOps] 06`: runs 3529–3531 at 15:29:50–52Z coincide with the S7 write (causation inferred; mechanism in `evidence/lite-cloud-demo-20261020.md:203`) | Separate base per client (planned) | Not urgent |
| R11: The trial-From defect | Any Lite trial send | Certain while the build sends no From | Every trial send is refused (572003) and logged Failed. `common.part.ts:173` has no label for 572003. `config.ts:108` forbids From together with `trialTemplate` | Not built. It needs a code change, tests, and then **one approved send** | Yes, before any further send |

## 5. What only the owner can check in Twilio

The Twilio tools available here search documentation only. None of the following could be read.

| Check | Where | Why it matters |
|---|---|---|
| Account type and trial expiry (30 days from sign-up) | Console › Account | The test window |
| Verified recipients, including ***771 | Phone Numbers › Verified Caller IDs | R2, R3 |
| The trial number assigned to ***771 for Messaging | Messaging › Try out SMS | Needed for the trial-From fix (R11) |
| Messaging Logs around 21 Oct 15:29Z | Monitor › Logs › Messaging | Whether the S7 refusal is listed, and that no message was created |
| Error Logs and Debugger: 572003, and any 401 or 404 from n8n | Monitor › Logs › Errors | Trials have no Monitor API (`evidence/lite-twilio-starter-20261021.md:25`) |
| Try out SMS › Auto-reply setting and URL | Messaging › Try out SMS › Receive an SMS | R4 |
| Webhook Settings and Rules | Webhooks configuration (API; Console if shown) | R5 |
| Free SMS units left | Billing / trial balance | Planning one more send |

## 6. Recommended approval items, in order (none performed)

Each item is a separate approval. **Item 1 must come before item 4.** Version `49aeb37c` has an unauthenticated Reply
Webhook, so it must never be the published version.

1. **Unpublish `3Jeal7RQAhUmgLZ3`** ([Lite] Inbound Replies). Then confirm `active: false` and
   `activeVersionId: null`.
2. **Restore version `cd14b31d-ca74-4fa8-bec9-8e6675a4fd3b` on `9BjHeFBUKqnmQqHl`** ([Lite] Instant Lead
   Follow-Up). Keep it unpublished, and verify it node for node against `lite/dist/demo/lead-follow-up.json`.
3. **Restore version `ab0f14c6-b596-44ff-ad73-02039087105b` on `Tmk4lj7VrbHix9A9`** ([Lite] Monitor). Keep it
   unpublished, and verify it node for node against `lite/dist/demo/monitor.json`.
4. **Restore version `49aeb37c-394b-41b9-b50a-4a9265ee2f02` on `3Jeal7RQAhUmgLZ3`.** Only after item 1, and keep it
   unpublished. This completes plan clean-up step 3 (plan `:185`).
5. **Remove the pinned S7 test lead from `9BjHeFBUKqnmQqHl`** (plan clean-up step 2, `:184`). Pin data is not exposed
   by the read tools, so its presence is NOT VERIFIED.
6. **Owner, Twilio Console:** Try out SMS › Auto-reply › **Standard** › Save (plan `:188`).
7. **Delete the Twilio Webhook Rule (`EXACT_MATCH`, reply URL) and its Webhook Setting** created in S1 (plan
   `:191`).
8. **Clear the Login Setup's temporary data table** (plan `:187`). The reported id is `y28wzAvfOC2U7fwI` (investigator;
   NOT VERIFIED, not read).
9. **Archive `HWJdTkYMLBFXE5bn`, `0h3YTk1ewoemNQCq`, `CRYdGYERCuVGcaEs`, `ikWTxNSgiH3u1TWr` and `VcTE56qoxldxCeDt`**
   (the five Twilio helper workflows).
10. **Keep `rec4IUGCUBSSiBd4N` as evidence, with Retry Requested unticked.** Optional, after the evidence is recorded:
    delete the `ZZ Live Test` contact, job and message rows, which hold the number ending 771 (plan `:192`).
11. **Separate decision, later:** build the trial-From fix (R11) with failing-first tests. Then decide on one approved
    trial send to ***771. No second send without that approval.

**NOT VERIFIED for items 2 to 4:**
- whether `restore_workflow_version` keeps the current workflow settings (saving, no error workflow);
- whether it can publish a version (it should only change the draft).

Re-read `get_workflow_details` after each item.

## 7. Doc drift found

| Where | What it says | What is true now | Evidence |
|---|---|---|---|
| n8n descriptions of Inbound Replies, Instant, Monitor | "Demo config, test sink … Unpublished"; Inbound "(JSON replies)" | Inbound is published with the live build (TwiML replies). Instant and Monitor hold the live build | Sections 1 to 3 |
| `evidence/lite-live-acceptance-plan-20261021.md:3`, `:8` | "prepared, waiting for approval"; "the five [Lite] workflows run the test-sink build, unpublished" | S1 to S4 and S6 ran, S7 failed (572003), S8 to S12 did not run; three workflows changed. No evidence file records the run itself | `evidence/recovery-report-20261022.md:60` (untracked) |
| Plan `:109` | Webhook Setting and Rule "not created yet" | Created in S1 (current existence NOT VERIFIED) | Recovery report `:60` |
| Plan `:22-23`; `lite/DEPLOY.md:223-224`; `lite/config/config.ts:43`, `:108` | On a trial, send no From | Twilio refused S7 without From: 572003, "The 'from' number isn't assigned to this verified messaging recipient" | Airtable row `rec4IUGCUBSSiBd4N`; recovery report `:44` |
| `evidence/lite-twilio-starter-20261021.md:35-36` | A trial create takes only To, Body and StatusCallback | Same contradiction | Same |
| Plan `:134`; `lite/DEPLOY.md:229`; `lite/n8n/src/common.part.ts:173` | 572002 = number not verified; no mention of 572003 | The live API returned 572003 for a missing From. Twilio's docs title 572002 "From number isn't assigned" (investigator, twilio.com/docs/api/errors/572002, not re-checked) | S7 row |
| `lite/DEPLOY.md:236-237` | Monitor's retry check counts any message to the number since the first attempt as sent | Since `c43d4d8` Monitor asks Twilio only by Message SID; the by-number lookup is removed | Deployed Plan Retries (`e7ec9940`); `evidence/lite-factory-release-gate-2-20261021.md:70-74` |
| `evidence/lite-twilio-starter-20261021.md:168`, `:181` | Login in the webhook URL; `PREFIX_MATCH` Rule | Superseded: no login in URLs; `EXACT_MATCH` Rule | `lite/DEPLOY.md:174`, `:191` |
| `lite/DELIVERY-CHECKLIST.md:20` | "Lite: 49" tests | 70 (`test/lite.test.ts` 70/70) | Recovery report `:35`; commit `c43d4d8` message |
| `lite/README.md:114` | Look-ups read up to 100 records "(no pagination)" | Several look-ups paginate (for example Find Number History and Find Sender in `3009c821`: up to 20 pages) | Version read today |
| `lite/build.ts:126` vs cloud | Build sets `saveManualExecutions: true` | Instant and Monitor have `false` in the cloud; Monitor's change is undocumented | Section 2 |

**Not checked in this pass:**
- the Twilio documentation claims (investigator);
- the temporary data table;
- pin data;
- the content of the 11:59Z versions;
- the two diagnostic workflows marked "investigator" in section 2;
- the Twilio account itself.

## 8. Re-check during the Advanced sprint (2026-10-22, read-only)

n8n search_workflows '[Lite]': unchanged. Inbound Replies 3Jeal7RQAhUmgLZ3 is still active (updatedAt 2026-10-21T13:44:14Z); the other nine are inactive, with the same updatedAt values as above. No action was taken. Remediation is section 6, each item awaiting the owner's approval.
