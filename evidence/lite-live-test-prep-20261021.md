# RoofOps Lite: final live test, prepared (2026-10-21)

**Result: ready for approval.**
- **Nothing sent or opened:** no SMS was sent, no webhook was published and no Twilio configuration was changed.
- **Inbound login:** the chosen design keeps the reply-webhook login out of URLs, source code and saved execution
  data. That was checked on a local n8n and in the cloud.
- **Exactly one SMS:** four safeguards stand between the test and a second message.
- **Still needed:** your verified number, added to `.env.local` by you, and your approval.

This file names no real phone number, Account SID or secret.

## 1. The recipient

**Your verified number is not configured anywhere yet.** The cloud allowlist still holds two ACMA fictional numbers.
Twilio's API cannot confirm a trial's verified recipients: Verified Caller IDs is empty, and the sign-up number is
verified automatically. So the number has to come from you.

**How it is handled:**
1. You add one line to `.env.local`: `LITE_LIVE_TEST_TO=+614…`. The file is git-ignored and stays on this computer.
2. A local script checks it is an Australian mobile, and not a fictional test number. It prints only that result.
3. It writes the git-ignored live config `lite/config/demo-twilio-live.local.json` and its build. In that build the
   allowlist is that number only, with `allowAllRecipients: false`.
4. The number goes into the temporary n8n data table, where only the pre-check reads it. The pre-check reports counts,
   never the number.
5. The pre-check result shows whether the number is already a Lite contact, is opted out, or already had an
   acknowledgement that day. Any of these would stop the SMS.

**Where the number will exist during the test:**
- the five unpublished workflows (allowlist), and Lead Follow-Up's pinned test lead;
- the `ZZ Live Test` contact and its Message Log rows in Airtable;
- Twilio's message log.

**Where it will not exist:**
- git, chat or my output;
- any saved n8n execution. The live build turns off saved manual runs for Lead Follow-Up, and Inbound Replies saves
  none.

## 2. Inbound webhook: the design and its checks

**Design:**
- **Twilio side:** a Webhook **Setting** with the login inline (Basic). The password is write-only and Twilio never
  returns it. The Setting still signs with the Auth Token.
- **Rule:** an **`EXACT_MATCH` Rule** for `https://<n8n>/webhook/roofops-lite/reply`. Twilio drops the query string
  before matching, so the Rule also covers receipts (`?event=status`). No other address gets the login.
- **URL:** the URL in Twilio's console is plain.
- **n8n side:** n8n's Webhook Basic Auth checks the login before the workflow starts.

**Checks:**

| Question | How it was checked | Result |
|---|---|---|
| Does n8n refuse requests without the login? | The real trial build of Inbound Replies on n8n 2.34.6 (local, throwaway) | No login: `401`. Wrong login: `401`. Right login: `403` from Lite ("not for this Twilio account": a synthetic AccountSid). |
| Does n8n keep the login in saved executions? | The same, saved execution read from n8n's database | **Yes.** With default saving, the `Authorization` header is stored in the run. |
| Does "Do not save" fix it? | The same, a copy with `saveDataSuccessExecution/ErrorExecution: none` | The run is hidden at once (soft-deleted) and gone from the database about 16 minutes later. |
| Can n8n hide execution data instead? | n8n docs | Redaction is Enterprise only. |
| Change made | `lite/build.ts` | Any workflow whose webhook needs a login saves no production executions. Test first failed, then passed; Lite 49/49. |
| Does the cloud Inbound Replies use it? | n8n API, after replacing the five workflows | `save=none`; all five match the build node for node; all unpublished. |
| Are the helper runs stored? | n8n API for runs 3237 to 3240 | `404` each time: not stored. |
| Login in a URL (`https://user:password@…`)? | Rejected | The password would sit in Twilio's console and in every receipt URL. |
| Can the login reach Twilio without being exposed? | Dry runs of the setup helper with no login staged (3238) | Read, clear and store steps work; nothing reached Twilio. |

**Not provable without opening the webhook:**
- that Twilio sends the login, and accepts n8n's answer;
- that Twilio applies the Rule to the trial's Try out SMS webhook. Twilio does not document this.

The approved procedure checks both before the SMS, with Twilio's Webhooks Test and an outside probe. If either
fails, the webhook is unpublished again and nothing is sent.

## 3. Prepared in n8n

All unpublished, manual trigger only, saving no execution data, with no secret or phone number in any node:

| Workflow | Id | Does |
|---|---|---|
| `[Lite] Live Test Pre-check (saves nothing)` | `ikWTxNSgiH3u1TWr` | Counts the number's contact, opt-out, jobs and messages, and lists the latest rows (status, SID yes/no, error code, masked reason). Used before and after the test. |
| `[Lite] Twilio Webhook Login Setup (one-shot, saves nothing)` | `0h3YTk1ewoemNQCq` | Reads the login from the data table, creates the Setting and the Rule with n8n's Twilio credential, clears the login, and stores the ids and status codes. |
| `[Lite] Twilio Webhook Test (no SMS, saves nothing)` | `CRYdGYERCuVGcaEs` | Sends Twilio's Webhooks Test through the Setting to the reply URL, and stores the outcome. |

- **Data table:** `Lite Live Test (temporary)` (`y28wzAvfOC2U7fwI`). Its phone and login rows are cleared now.
- **Archived:** the probe that showed MCP cannot run a webhook workflow from pinned data (`U79SM9NgrZA7OHeh`). So the
  one lead run is your click in the n8n editor.

## 4. Exactly one SMS

1. **Allowlist:** only your number. Any other number is Skipped before Twilio is called (T1, run 3194).
2. **One run:** the lead runs once, from your click. Lead Follow-Up stays unpublished, so the form brings no traffic.
3. **No duplicate:** a second run the same day is a duplicate, because of the Dedupe Key `lead-ack:<number>:<date>`.
4. **No schedules or retries:** Monitor, Review Requests and Reactivation stay unpublished and are not run, and
   `operatorPhone` is empty.
5. **Replies send nothing:** Lite answers Twilio with an empty `<Response/>` as `text/xml`.
6. **On Twilio's side:** a trial can reach only verified phones.

**The one exception:** Twilio itself normally answers STOP with its own confirmation text.

## 5. What happens when you reply

| You send | Lite | Twilio |
|---|---|---|
| A normal reply, e.g. "Hello" | Message Log row **Received** (Inbound), linked to `ZZ Live Test`. Reason: "reply recorded; enquiry reopened for a call". The job's Last Activity is set, and a New Lead becomes Contacted. No SMS back. | Nothing. |
| `STOP` (also STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPT OUT, OPTOUT, REMOVE) | Contact **Opted Out**, Opted Out At set, Marketing Opt-In cleared; Message Log row **Opt-Out**. No Lite workflow messages that number again. No SMS back from Lite. | Normally sends its own opt-out confirmation, then blocks messages to your phone (later sends fail with 21610, which Lite also treats as an opt-out) until you reply START. |
| `START` | Logged for staff only. Lite never re-subscribes anyone. | Unblocks your number. |
| `HELP` (avoid) | Logged as Received. | May send its own help text. |

Reply with the normal message first and STOP last, because STOP ends further testing to your phone.

## 6. The final test procedure

**Before approval (you, a few minutes):**
1. In the Twilio Console, confirm your phone is a verified recipient on the trial.
2. Add `LITE_LIVE_TEST_TO=+614…` to `.env.local` and save. Don't paste it into chat.
3. Tell me it is there. I then run `stage-phone` and the pre-check, and report only counts.

**After your approval (about 15 minutes):**

| Step | Who | Action | Stop if |
|---|---|---|---|
| 1 | me | Stage the login in the temporary table; run Login Setup. It creates the Setting and Rule, then clears the login. | Any status other than 2xx; the login not cleared |
| 2 | me | Replace the five workflows with the live build: your number only, receipts on, Lead Follow-Up manual runs not saved. Check node for node. | Any difference |
| 3 | me | **Publish `[Lite] Inbound Replies` only.** Probe from outside: no login `401`, wrong `401`, Bearer `401`, right login `403`. | Any other answer: unpublish |
| 4 | me | Run the Webhook Test. `400`/`403` means Twilio's login was accepted; `401` means it was not. | `401`, or Twilio fails: unpublish |
| 5 | you | Twilio Console › Messaging › Try out SMS › Auto-Reply › Custom webhook: `https://tejesh08.app.n8n.cloud/webhook/roofops-lite/reply`, method POST. Plain URL, no login. | — |
| 6 | me, then you | I pin the one test lead on Lead Follow-Up (number read from `.env.local`). You open it in n8n and click **Execute workflow** once. | — |
| 7 | me | Pre-check: one row Sent with a SID; then Delivered from the receipt. | Anything else |
| 8 | you | Reply "Hello". I check for a Received row. | No row: check the Twilio Debugger |
| 9 | you | Reply "STOP". I check for an Opt-Out row and Opted Out on the contact. | — |
| 10 | me, and you | **Clean up.** I unpublish Inbound Replies, remove the pinned lead, restore the fictional allowlist, and clear the data table. You clear the Try out SMS webhook. Optional: delete the Twilio Rule and Setting, and the `ZZ Live Test` rows, which hold your number. | — |

**Cost:** 1 of the 100 free trial SMS (plus Twilio's own STOP confirmation), and about 6–8 n8n executions.

## 7. Trial limitations that apply

- Twilio sends its **own template text** (`sms_appointment_reminders`), not Lite's wording. The Message Log keeps
  Lite's wording, noted as a trial send.
- **Only verified phones:** any other number fails with 572002 and nothing is sent.
- **Twilio picks the sender.** Replies reach Lite only through Try out SMS › Auto-Reply.
- **Account limits:** 100 free SMS, 30 days, Australia only. No Functions (so no reply relay), TwiML Bins or Monitor.
- **After STOP,** Twilio blocks your phone until you reply START.
- **Rule coverage:** whether Twilio applies Webhook Rules to Try out SMS replies is not documented.
  - **Step 7** shows the Rule working for receipts (StatusCallback).
  - **Step 8** shows whether replies use it too. If not, n8n refuses the reply with `401`, Twilio's Debugger records
    it, and nothing else happens.
