# RoofOps Lite: installation guide for a trade business

This guide sets up Lite for a new client. Steps marked **(cloud)** change the client's Airtable, n8n or Twilio and are
done with the client's approval. Steps marked **(live)** send real SMS.

The one-page version is [SETUP-CHECKLIST.md](SETUP-CHECKLIST.md).

What gets installed:
- an Airtable Quote-to-Paid CRM: 6 tables and an Interface;
- five n8n workflows: Lead Follow-Up, Review Requests, Reactivation, Inbound Replies and Monitor;
- a website enquiry form;
- Twilio SMS.

**Time:** about 2 hours, plus the client's Twilio number registration.

## 0. From the client

| Item | Used for |
|---|---|
| Business name, trade, phone, sign-off, timezone | Templates, schedules |
| Google review link (`https://g.page/r/<id>/review`) | Review requests |
| Approved message wording and consent wording | Templates, the form, the consent record |
| Whether review requests need a separate tick (Australia: yes by default) | `consent.reviewRequests` |
| Who gets alert texts (operator mobile) | `monitoring.operatorPhone` |
| A Twilio account in the business's name, with an Australian mobile number that can send and receive SMS | Real messaging |

## 1. Accounts (cloud)

**Airtable: one base for the client.** Don't add Lite to a base other automations watch. In the RoofOps demo base,
every Lite write woke `[RoofOps] 06`; it ignored them, but each one cost an n8n execution.

**n8n: one project (or folder) for the client.** Create these credentials (Credentials › New):

| Credential | Type | Value | Used by |
|---|---|---|---|
| Airtable | Airtable Personal Access Token | A token for the client's base only, with `data.records:read` and `data.records:write` | Every Airtable node |
| Twilio (outbound) | **Basic Auth** (`credentialType: "httpBasicAuth"`, the default) | User: a Twilio **API Key SID** (SK…); password: its **Secret** | Sending SMS and checking delivery |
| Twilio (outbound), alternative | n8n's own **Twilio API** credential (`credentialType: "twilioApi"`) | Account SID + Auth Token, or an API key | The same; use it when that credential already exists |
| Twilio (inbound), signature mode | **n8n Variable** (Settings › Variables; n8n Cloud Pro or Enterprise) | `LITE_TWILIO_AUTH_TOKEN` = the Twilio account's **Auth Token** | Verifying Twilio's webhook signatures |
| Twilio (inbound), basic-auth mode | **Basic Auth** | A username and long random password | Plans without Variables (n8n Starter): the reply webhook requires this login |
| Twilio (inbound), header-auth mode | **Header Auth** | A header name and long random value | The reply relay (see "n8n Starter" below): the webhook accepts only the relay |

- **Twilio API key:** create it under Twilio Console › Account › API keys. Using a key keeps the main Auth Token out
  of n8n's outbound credential.
- **Secrets:** they live only in n8n credentials and variables. The repository and the generated workflows contain only
  credential **ids and names**.

**Twilio:**
1. Buy or port an Australian mobile number. Australian numbers need a regulatory bundle.
2. Under Messaging, set the number's **"A message comes in"** webhook to the reply URL (step 7). Leave it until then.

## 2. Config (your machine)

```bash
cp lite/config/template.json lite/config/acme-plumbing.json
```

Fill in every `<placeholder>`:
- `business` (with `timezone`) and `airtable.baseId` / `airtable.credential` (id and name of the n8n credential);
- `n8n.baseUrl`, for example `https://acme.app.n8n.cloud`;
- `messaging.twilio`: `accountSid`, the sender `from` (+614…), the credential id and name, `inboundAuth` and its
  secret source, and `allowedRecipients` (the approved test phone);
- `consent.wording` and `consent.reviewRequests`;
- `leadIntake.services`, the templates, the timings, and `monitoring`.

Keep `messaging.mode` at **`"test-sink"`** for now.

**Keep account details out of git.** A config with a real Account SID or real phone numbers goes in
`lite/config/<client>.local.json`, and builds to `lite/dist/<client>.local/`. Git ignores both.

```bash
npx tsx lite/build.ts lite/config/acme-plumbing.json
```

The build refuses:
- placeholders left behind;
- templates without `{businessName}`, review templates without `{reviewUrl}`, review and marketing templates without
  STOP;
- an alphanumeric sender;
- Twilio mode without an allowlist.

It writes `lite/dist/acme-plumbing/`, with five `.json` imports, five `.sdk.ts` files and `lead-form.html`.

## 3. Airtable tables (cloud)

```bash
npx tsx lite/airtable/setup.ts lite/config/acme-plumbing.json
```
```bash
LITE_AIRTABLE_TOKEN=... npx tsx lite/airtable/setup.ts lite/config/acme-plumbing.json --apply
```
```bash
LITE_AIRTABLE_TOKEN=... npx tsx lite/airtable/setup.ts lite/config/acme-plumbing.json --verify
```

- **Order:** the first command is a dry run; `--apply` creates; `--verify` checks.
- **Token:** use one with `schema.bases:read` + `schema.bases:write` on that base only. Pass it in the environment and
  never save it.
- **Names:** tables get the names in `airtable.tables`. The back-link the workflows read is named "Lite Jobs".
- **Older Lite base:** use `--upgrade`. It adds the missing table and fields only, and lists any select options to
  add by hand.
- **No token:** the Airtable connector can make the same calls, in the order the dry run prints.

## 4. CRM Interface (cloud, about 10 minutes)

Build the **Quote-to-Paid** Interface as described in [airtable/views.md](airtable/views.md). With the Airtable
connector, that is `create_interface`, one `create_page` per page, then `publish_interface`. Select choice IDs differ
per base, so read them first with `get_table_schema`.

## 5. Workflows (cloud, unpublished)

1. **Import Monitor first:** Workflows › Import from File › `monitor.json`, or `create_workflow_from_code` with
   `monitor.sdk.ts`. Note its id.
2. **Rebuild with that id:** put it in `n8n.errorWorkflowId` and rebuild. The other four then name Monitor as their
   **Error workflow** in their exported settings.
3. **Import the other four.**
4. **Check each workflow:**
   - **Credentials:** every Airtable node shows the Airtable credential, and every Twilio node the Twilio Basic Auth
     credential.
   - **Settings:** the timezone is the client's.
   - **Unpublished:** all five stay unpublished for now.

The import JSON already carries the timezone in its settings. If you create from `.sdk.ts` with the MCP tools instead,
set it with `update_workflow` (`setWorkflowSettings`).

**The error workflow waits for go-live.** n8n accepts Monitor as another workflow's error workflow only once Monitor
has a published version (seen in the 2026-10-21 cloud run: `update_workflow` refused it). It makes no difference
before go-live, because n8n runs error workflows only for production executions. Set it in step 8, right after
publishing Monitor.

## 6. Test without real SMS

1. **Local:** run the client config locally. The test sink exercises every rule:
   ```bash
   npx tsx lite/demo/run-demo.ts lite/config/acme-plumbing.json lite/demo/output-acme
   ```
2. **(cloud) Test sink on n8n:** follow [demo/cloud-demo-runbook.md](demo/cloud-demo-runbook.md) with `ZZ`-named
   synthetic people. Use manual executions (`execute_workflow`, `executionMode: manual`). Check the Message Log,
   Pipeline and Alerts.
3. **(cloud) Twilio, still without real SMS:** use Twilio **test credentials** (Console › Account › API keys › Test
   credentials) in a separate n8n Basic Auth credential, with `from: "+15005550006"` (Twilio's magic test sender).
   Switch the config to `"twilio"`, rebuild and re-import. Then:
   - Twilio answers like the real API, but sends nothing and charges nothing.
   - Lite logs the result as Sent.
   - Delivery checks are not available with test credentials, so a retry check is "postponed". That is the designed
     safe behaviour.

## n8n Starter and Twilio trial accounts

### n8n Starter (no Variables)

Signature mode needs an n8n Variable, and Starter has none. Everything else in Lite works on Starter, including data
tables, error workflows and the public API.

| Need | On Starter |
|---|---|
| Outbound | Either credential type works. `twilioApi` was checked on 2026-10-21: account fetch, message list, and a create that Twilio refused. |
| Inbound replies | `inboundAuth: "basic-auth"`. |
| Delivery receipts | `statusCallbacks: false` until Twilio can log in (below). |

**How `basic-auth` works.** n8n's Webhook node requires the Basic Auth credential before the workflow runs.
- No login: `401`, with `WWW-Authenticate: Basic realm="Webhook"`.
- Wrong login (user, password, or a Bearer token): `401`.
- Rejected requests create no execution.

These were tested against n8n 2.34.6 on 2026-10-21. After the login, Lite still refuses a request for another Twilio
account (`403`).

**How Twilio sends the login: a Webhook Rule.** Set it up in Twilio's Webhooks configuration API
(webhooks.twilio.com), in two parts:
1. **A Setting** with the login inline: `auth: {source: "INLINE", value: {scheme: "BASIC", username, password}}`.
   Keep the usual signature, `signature: {type: "ACCOUNT_AUTH_TOKEN", algorithm: "HMAC_SHA1"}`. Twilio never returns
   the password.
2. **An `EXACT_MATCH` Rule** for `https://<n8n>/webhook/<replies.webhookPath>`.
   - Twilio ignores the query string when matching, so the same Rule covers receipts (`?event=status`).
   - No other address gets the login.
   - Twilio refuses Basic on the default Rule.

**Create the Setting from n8n.** Only n8n holds the Twilio credential, so create the Setting with a one-shot n8n
workflow:
- it reads the login from a temporary data table;
- it saves no executions;
- it clears the table at the end.

That way the password never appears in chat, code or a saved run.

**Check it before live traffic** with `POST /v1/Webhooks/Tests`:
- `401`: n8n refused the login.
- `400` or `403`: n8n accepted the login, and Lite refused Twilio's synthetic test body.

**Don't put the login in the URL** (`https://user:password@…`). The password would then sit in Twilio's number
settings and in every receipt URL.

**Execution data.**
- **The problem:** n8n saves the Webhook node's request headers with each execution, login included. On n8n 2.34.6,
  the `Authorization` header was in the saved run.
- **What the build does:** execution-data redaction is an Enterprise feature. So on every workflow whose webhook
  needs a login, the build sets **Save successful/failed production executions: Do not save**.
- **The effect:** n8n hides such a run at once, and deletes it at its next clean-up (about 15 minutes in the local
  test).
- **What remains:** the Message Log keeps a row for each reply and receipt, and Monitor alerts on failures.

**Receipts.** Turn `statusCallbacks` on once the Rule exists. Lite never puts a password in `StatusCallback`. Without
receipts, Sent stays Sent. Failed messages are still caught, because Twilio refuses them when Lite sends.

**What Basic Auth does not prove.** It shows the caller knows the password. It does not show the caller is Twilio,
and it does not sign the content. That is acceptable for a test with one phone, but not for a customer release.

**For the customer release, use one of:**
1. **Signature mode,** on n8n Pro or Enterprise.
2. **The reply relay, on Starter:**
   - **What it is:** [twilio/reply-relay.js](twilio/reply-relay.js), deployed as a **Protected** Twilio Function. Twilio checks
     `X-Twilio-Signature` before a Protected Function runs. The function then forwards the same parameters to n8n with a
     secret header.
   - **n8n side:** n8n checks the header with Header Auth (`inboundAuth: "header-auth"`).
   - **Twilio side:** point the number's "A message comes in" webhook and `statusCallbackUrl` at the function.
   - **Function variables:** `N8N_REPLY_URL`, `RELAY_HEADER_NAME`, `RELAY_SECRET`.
   - **Account:** this needs an upgraded Twilio account. Trials cannot run Functions, and Functions beyond Twilio's
     free allowance are billed.

### Twilio trial accounts

Twilio's current trial is not the old one. Set `trialTemplate` (a key from `TWILIO_TRIAL_TEMPLATES`, for example
`sms_appointment_reminders`) and leave `from` and `messagingServiceSid` empty.

| Rule | What Lite does |
|---|---|
| The Body must be one of Twilio's template keys. Twilio sends its own text from a trial number it assigns. | Lite sends the key. The Message Log keeps Lite's wording, with the Reason "Twilio trial: sent as the Twilio template …". |
| Only verified recipients: the sign-up number automatically, and up to 5 in all. | Any other number gets HTTP 422, code **572002**. Lite logs Failed, "trial account: the number is not a verified recipient (not sent)", and never retries it on its own. |
| Replies reach a webhook only through Console › Messaging › Try out SMS › Auto-Reply › Custom webhook. | Set that to the reply URL. |
| Sign-up country only (Australia), 100 free SMS, 30 days. No Functions, TwiML Bins or Proxy. | The relay waits for an upgraded account. |

**Template text.** Twilio's template text does not name the business or say "Reply STOP". Send trial messages only to
your own verified phone, never to customers.

On a retry, Monitor still asks Twilio first. A message sent since the first attempt counts as already sent, because
Twilio's text never matches Lite's.

## 7. First real SMS (live, one at a time, with approval)

1. **Agree first:** the sender number, the **one** recipient (a phone the client holds), and the exact test with the
   client.
2. **Config:**
   - real credentials, `from` = the client's Twilio number (on a trial, `trialTemplate` instead: see above);
   - `allowedRecipients = ["+614…the approved phone"]`;
   - `allowAllRecipients: false`;
   - mode `"twilio"`.

   Rebuild and re-import.
3. **Twilio webhook:** point the number's "A message comes in" at `https://<n8n>/webhook/<replies.webhookPath>`. On a
   trial, use Try out SMS › Auto-Reply › Custom webhook.
   - **Basic-auth mode:** a plain URL. The Webhook Rule sends the login.
   - **Header-auth mode:** the URL is the relay function's.
4. **Publish only Inbound Replies.** It must receive Twilio's posts.
   - Signature mode rejects anything unsigned.
   - Basic-auth mode rejects anything without the login.
   - Header-auth mode rejects anything without the relay's header.
5. **Send one lead** as a manual execution: the approved person, consent ticked. Check that:
   - one SMS arrives;
   - the log row is Sent with a SID;
   - Delivered follows (only with receipts on).
6. **Reply STOP from that phone.** Check that the contact is Opted Out, then that a new lead from it is not messaged.
7. **Refused number (optional):** a lead with a number on the allowlist that Twilio refuses gives a Failed row, a
   Monitor alert, then Retry Requested.

## 8. Go live (client decision)

1. **Recipients:** set `allowAllRecipients: true` (and leave the allowlist as a record of the tests). Rebuild and
   re-import.
2. **Form:** paste `lead-form.html` into the client's website, or point their form tool at the lead webhook.
   - The form is public by nature. Validation, the hidden honeypot field and the de-duplication protect it.
   - `webhookAuth` (Header Auth) is for server-to-server sources such as Zapier or Make, not a public page.
3. **Publish, in this order:** Monitor, Inbound Replies, Lead Follow-Up, Review Requests, Lead Reactivation. The
   schedules start in the business timezone: reviews daily at 10:00, reactivation Mondays at 09:00, Monitor every
   `monitoring.everyHours`.
4. **Error workflow:** once Monitor is published, set **Error workflow** to [Lite] Monitor on the other four (Settings,
   or `setWorkflowSettings` with `errorWorkflow`). Check it once by making one production run fail on purpose, for
   example a lead posted while the Airtable credential is disconnected. A Workflow Failed row should appear in Lite
   Alerts.
5. **Clean up:** remove synthetic data from the Jobs page tab **Demo data**.

## 9. Handover

Show staff:
- **Pipeline:** move a job Quoted → Paid; set **Completed At** (review requests need it).
- **Consent:** record consent taken by phone (tick the boxes and fill Source, Recorded At, Wording). Never tick boxes
  without it.
- **Alerts:** on the Overview and Alerts pages. Fix the cause, tick **Retry Requested** on the message, then set the
  alert to Resolved.
- **Opt-outs:** the "Do not contact" list. Never untick Opted Out unless the person asks.

## Undo

Nothing is deleted automatically.
- **n8n:** unpublish, then archive, the five workflows.
- **Twilio:** remove the webhook URL from the number (or from Try out SMS), and delete any Webhook Rule, Setting and
  AuthProfile made for Lite.
- **Airtable:** delete the base, or the six tables and the Interface.
