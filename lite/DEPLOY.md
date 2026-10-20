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
| Twilio (outbound) | **Basic Auth** | User: a Twilio **API Key SID** (SK…); password: its **Secret** | Sending SMS and checking delivery |
| Twilio (inbound), signature mode | **n8n Variable** (Settings › Variables; n8n Cloud Pro or Enterprise) | `LITE_TWILIO_AUTH_TOKEN` = the Twilio account's **Auth Token** | Verifying Twilio's webhook signatures |
| Twilio (inbound), basic-auth mode | **Basic Auth** | A username and long random password | Plans without Variables: the reply webhook requires this login, and Twilio's webhook URLs carry it |

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
   **Error workflow**.
3. **Import the other four.**
4. **Check each workflow:**
   - **Credentials:** every Airtable node shows the Airtable credential, and every Twilio node the Twilio Basic Auth
     credential.
   - **Settings:** the timezone is the client's, and four of the five name Monitor as error workflow.
   - **Unpublished:** all five stay unpublished for now.

The import JSON already carries the timezone and the error workflow in its settings. If you create from `.sdk.ts`
with the MCP tools instead, set them with `update_workflow` (`setWorkflowSettings`).

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

## 7. First real SMS (live, one at a time, with approval)

1. **Agree first:** the sender number, the **one** recipient (a phone the client holds), and the exact test with the
   client.
2. **Config:**
   - real credentials, `from` = the client's Twilio number;
   - `allowedRecipients = ["+614…the approved phone"]`;
   - `allowAllRecipients: false`;
   - mode `"twilio"`.

   Rebuild and re-import.
3. **Twilio webhook:** point the number's "A message comes in" at `https://<n8n>/webhook/<replies.webhookPath>`. In
   basic-auth mode, the URL carries `user:password@`.
4. **Publish only Inbound Replies.** It must receive Twilio's posts.
   - Signature mode rejects anything unsigned.
   - Basic-auth mode rejects anything without the login.
5. **Send one lead** as a manual execution: the approved person, consent ticked. Check that:
   - one SMS arrives;
   - the log row is Sent with a SID;
   - Delivered follows.
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
4. **Clean up:** remove synthetic data from the Jobs page tab **Demo data**.

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
- **Twilio:** remove the webhook URL from the number.
- **Airtable:** delete the base, or the six tables and the Interface.
