# RoofOps Lite: Twilio trial on n8n Starter (2026-10-21)

**Result:**
- **Done without SMS:** Lite now sends through n8n's own Twilio credential, and its inbound webhooks need no n8n
  Variables. Every test that needs no SMS passed against the real Twilio API.
- **Safety:**
  - **No SMS sent:** no SMS was sent or delivered. Twilio's message list for the account is still empty.
  - **Nothing published:** no workflow was published, and no public webhook was opened.
  - **Nothing paid:** nothing paid was started.
  - **Advanced RoofOps and Xero:** neither was changed.
- **Waiting for approval:** one real SMS and reply.

The repository is public, so this file names no Account SID (only its last four characters), no real phone number
and no secret. The build config with those details is `lite/config/demo-twilio.local.json`, which git ignores.

## 1. What exists

| Item | Checked how | Result |
|---|---|---|
| Twilio account | Read-only n8n workflow `[Lite] Twilio Account Check (read-only)`, runs 3186–3192 | Trial, active, primary; SID ends `942f` |
| n8n's Twilio credential "Twilio account" (`twilioApi`, Account SID + Auth Token) | The same runs, HTTP Request node with `predefinedCredentialType: twilioApi` | Works |
| Twilio phone numbers, Messaging Services | The same runs | None (on a trial, Twilio assigns the sender) |
| Messages ever sent | The same runs | 0 |
| Webhooks configuration API (Settings, Rules) | The same runs | Available on this trial; none set up |
| Twilio Monitor (Events, Alerts) | The same runs | 20003 "not available on a Trial account" |
| Verified Caller IDs list | The same runs | Empty. The trial's automatically verified recipient is the sign-up number (Twilio docs, error 14111), so check it in the Console |
| n8n plan | Owner: Starter | No Variables. Data tables, error workflows and the public API are available. Execution logs are kept for about 7 days: the oldest execution listed was 2026-10-13 |

**Finding the Account SID.** No Twilio endpoint the credential can call returns the Account SID without the Auth
Token. So a second workflow, `[Lite] Twilio Account SID (saves no execution data)`, wrote only the SID, type and
status to the n8n data table `Lite Twilio Account Facts`. That run, 3188, is not stored.

## 2. Trial rules (Twilio docs, 2026, and the real API)

- **Message body:** a create takes only `To`, `Body` and `StatusCallback`. `Body` must be one of Twilio's template
  keys (`sms_appointment_reminders`, `sms_order_confirmation`, …). Twilio sends its own text, from a trial number it
  assigns per recipient.
- **Recipients:** verified recipients only: the sign-up number, and up to 5 in all. The real API answers any other
  number with **HTTP 422, code 572002**: "No Twilio trial phone number is assigned for messaging to this destination
  number…".
- **Account limits:** sign-up country only (Australia), 100 free SMS, 30 days.
- **Not on a trial:** no Functions, TwiML Bins, Proxy or direct TwiML replies.
- **Replies:** inbound SMS reach a webhook only through Console › Try out SMS › Auto-Reply › Custom webhook.

## 3. Changes (tests: `npm run check` passes; Lite tests 48/48, full suite 608 passed and 46 skipped)

| Change | Why |
|---|---|
| `credentialType: "twilioApi"` | Use the n8n Twilio credential that already exists. The default stays a Basic Auth API key. |
| `trialTemplate` | On a trial, send the template key with no `From`. The Message Log keeps Lite's wording, with a note naming the template. |
| `inboundAuth: "basic-auth"` | The reply webhook uses n8n's Webhook Basic Auth. The build then contains no `$vars`, which Starter rejects. |
| `inboundAuth: "header-auth"` + `lite/twilio/reply-relay.js` | For the customer release on Starter. A Protected Twilio Function (Twilio checks the signature) forwards to n8n with a secret header. n8n checks the header with Header Auth. |
| `statusCallbacks`, `statusCallbackUrl` | Receipts only where Twilio can log in. The build refuses a callback URL with credentials in it. |
| Error codes 572002, 21608, 14111, 21607, 10002 | Logged as plain trial reasons, and never retried automatically. |
| **Fix:** Monitor retry on a trial | Monitor matched "already sent?" on message text, but Twilio's template text never matches Lite's. A retry after a message that did go out would have sent a second one. Now any message to that number since the first attempt counts. The test failed before the fix and passes after it. |
| **Fix:** 572002 reason | The first real refusal (run 3198) logged Twilio's raw text. It now logs "trial account: the number is not a verified recipient (not sent)" (run 3209). |
| Fake Twilio trial mode | Local tests use the real 422/572002 refusal, template-only bodies and no `From`. |
| `.gitignore`: `lite/config/*.local.json`, `lite/dist/*.local/` | Account details stay out of the public repository. |

## 4. Webhook Basic Auth (n8n 2.34.6, local throwaway container)

The container ran a published probe workflow. Its Webhook node was configured like Lite's reply webhook: POST, path
`roofops-lite/reply`, Basic Auth with an n8n credential. The container was removed afterwards.

| Request | Answer | Execution |
|---|---|---|
| No credentials | `401`, `WWW-Authenticate: Basic realm="Webhook"` | none |
| Wrong password | `401`, "Authentication data is wrong!" | none |
| Wrong user | `401`, "Authentication data is wrong!" | none |
| `Authorization: Bearer …` | `401`, "Authorization is required!" | none |
| Correct login (message, and `?event=status`) | `200` | yes |

**Lite's own logic after the login** ran in the cloud as manual executions (T3, section 5). Manual executions skip the
webhook's login check.

Twilio documents that when the webhook URL carries credentials, it first posts without them, then repeats with them
after a `401` that carries a realm. n8n sends that challenge.

**Not yet proven: Twilio's own half of the exchange.** It needs a public n8n webhook, so it waits for approval
(section 8).

## 5. Cloud tests (no SMS)

The five Lite v2 workflows in project Roofops were replaced with the trial build: `trialTemplate:
sms_appointment_reminders`, `twilioApi`, `basic-auth`, receipts off. The allowlist was two ACMA fictional numbers
(+61491570156, +61491570157), neither of them verified. Every run was a manual execution.

| Test | Run | Result |
|---|---|---|
| **T1:** lead to a number not on the allowlist (0400000501) | 3194 | Skipped, "not on the live test allowlist". Twilio was not called. |
| **T2:** lead to an allowlisted number that is not verified | 3198 | Real POST to Twilio; 422, code 572002. Logged Failed, code 572002, no SID. |
| **T3a:** reply for another Twilio account | 3202 | 403 "request is not for this Twilio account"; nothing written. |
| **T3b:** STOP from the T2 person (Twilio's form fields) | 3203 | Contact Opted Out; empty TwiML reply. |
| **T4:** Monitor, with Retry Requested ticked on the T2 message | 3207 | "not retried: the contact has opted out"; 1 alert. |
| **T4b:** lead to the second number | 3209 | 572002, with the plain reason after the fix. |
| **T4b:** Monitor retry (Retry Requested ticked) | 3215 | Real delivery check (`GET Messages.json?To=…&DateSent>=…`, 200, none). Then one resend: 572002 again, logged as attempt 2 with a new Failed row; 1 Delivery Failed alert. |

After each Lite write, `[RoofOps] 06` woke 16 times (runs 3195–3217). Every time it took "Any Record Changes?" →
no, and only advanced its cursor. No Postgres or Xero workflow ran: the last Xero run was 2026-10-16.

**Live state checked on 2026-10-21:**
- **Lite v2 workflows:** all five match `lite/dist/demo-twilio.local` node for node. They are unpublished, set to
  Australia/Brisbane time, with no error workflow. Lead Follow-Up keeps its webhook without authentication: it is the
  public form, as designed.
- **Diagnostic workflows:** both are unpublished and have no trigger.

## 6. Is n8n Starter enough?

**For the trial test and one small client: yes.**

| Limit | Lite's use |
|---|---|
| 2,500 executions/month | See below. |
| 5 concurrent | Lite runs take a few seconds (run 3215: about 5 s). |
| 5-minute limit | Same. |
| No Variables | Covered by `basic-auth` (tests) or the relay (release). |
| 7-day logs | Evidence has to be captured within the week, as it is here. |

**Executions:**
- **Now:** the instance ran 115 production executions in the 8 days of logs, about 430 a month. Most were
  `[RoofOps] 06`.
- **Lite's fixed load:** Monitor every 2 hours ≈ 360 a month, reviews 30, reactivation 4–5.
- **Lite's variable load:** 1 per lead, 1 per reply, and about 2 receipts per SMS when receipts are on.
- **One client:** with about 60 leads and 90 SMS a month, that is ≈ 650–700. With the instance's existing load, the
  total is ≈ 1,100–1,200 of 2,500.
- **Easy savings:** Monitor every 4 hours saves about 180. Each client in its own Airtable base stops `[RoofOps] 06`
  waking up.
- **Not enough for:** several clients on one instance.

**What Starter cannot do:** check Twilio's signature inside n8n. For a customer release, choose the relay (Twilio
upgraded, Functions billed past the free allowance) or n8n Pro.

## 7. Safeguards kept

All of these are tested locally against the schema-enforcing fake Airtable and the fake Twilio. In the cloud, T1 to
T4b covered:
- the allowlist;
- STOP;
- the account check;
- the opt-out check on retry;
- checking with Twilio before a resend;
- the logs.

The safeguards:
- **Consent rules.** Acknowledgement is operational. Reviews need express consent. Reactivation is marketing and
  needs a recorded source, time and wording.
- **STOP and equivalents.** They opt the person out of everything. START is left to staff.
- **Duplicates.** A message is reserved and confirmed before it is sent, and the Dedupe Key wins a race.
- **No automatic resend.** Unknown and Failed messages are never resent on their own, and permanent errors are
  never retried.
- **One resend.** Retry Requested checks with Twilio first, then resends at most once.
- **Logging.** Every attempt is logged.

## 8. What to approve for one real SMS and reply test

Each item below is a separate yes. **About 5 n8n executions and 1 of the trial's 100 free SMS.**

1. **Recipient:** your Twilio sign-up mobile, the only number a trial verifies automatically. Confirm it under Console ›
   Phone Numbers › Verified Caller IDs / Verified recipients. Give it to me as `+614…`.
   - **Where it goes:** it is written only to the git-ignored local config.
   - **What I do with it:** I rebuild and replace the five workflows. They stay unpublished, with
     `allowedRecipients` = that number only.
2. **Template:** `sms_appointment_reminders`, or another key from section 2. Twilio's text will not name Harbourside
   Roofing or say STOP.
3. **Publish `[Lite] Inbound Replies`** for the test only. Its public URL is
   `https://<n8n>/webhook/roofops-lite/reply`, and it rejects anything without the Basic Auth login.
4. **You set the reply webhook:** Console › Messaging › Try out SMS › Auto-Reply › Custom webhook.
   - **The URL:** `https://USER:PASSWORD@<n8n host>/webhook/roofops-lite/reply`.
   - **The login:** `LITE_REPLY_WEBHOOK_USER` and `LITE_REPLY_WEBHOOK_PASSWORD` in your `.env.local`.
   - **Why you:** I don't type the password into Twilio.
   - **What it proves:** Twilio's half of the Basic Auth exchange.
5. **One manual run of Lead Follow-Up** for a synthetic lead ("ZZ Live Test", your number, consent ticked). Expected:
   - one SMS;
   - a log row Sent with a SID and the template note.
6. **From your phone,** reply `Hello`, then `STOP`. Expected:
   - **Hello:** a Received row.
   - **STOP:** the contact is Opted Out.
   - **Twilio's own STOP handling:** Twilio may also block that number. A later send would then fail with 21610, and
     Lite opts the contact out.
7. **Optional: receipts.** I create, through the n8n Twilio credential, a Basic AuthProfile, a Setting and a
   `PREFIX_MATCH` Rule for the n8n webhook address. That is a persistent Twilio configuration. I then turn
   `statusCallbacks` on, so Delivered shows up. Twilio's Webhooks Test endpoint can check that Rule with no SMS.
   - **The catch:** the AuthProfile needs the webhook password to be sent to Twilio from an n8n node, where it appears
     in that workflow. Skip this item if that is not acceptable.
8. **Afterwards:**
   - unpublish Inbound Replies;
   - clear the Try out SMS webhook;
   - delete any Rule, Setting and AuthProfile;
   - reset the allowlist to the fictional numbers and replace the five workflows again.

   To go back to the test sink, rebuild from `lite/config/demo.json` and replace the workflows.
