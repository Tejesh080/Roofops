# RoofOps Lite

A small automation kit for a trade business (roofing, plumbing, electrical and so on). It uses **Airtable** as the CRM
and **n8n** for the automations. There is no database to run, no server to host and no app to deploy. It reuses the
Airtable base and the n8n Cloud account that RoofOps already has. It is separate from Advanced RoofOps, and nothing in
it touches Advanced RoofOps tables, workflows, invoices or Xero.

| Module | What it does | Built as |
|---|---|---|
| **1. Quote-to-Paid CRM** | One Job record per enquiry, from New Lead to Paid, with contact, site, quote and invoice status | 5 Airtable tables + views ([airtable/](airtable/)) |
| **2. Instant Lead Follow-Up** | A website form posts a lead. It is checked, de-duplicated, saved, and acknowledged on the channel the person agreed to. Logged. | n8n workflow `[Lite] Instant Lead Follow-Up` |
| **3. Google Review Requests** | Daily: each finished job gets one review request with your Google review link, only with consent, never twice | n8n workflow `[Lite] Google Review Requests` |
| **4. Lead Reactivation** | Weekly: quiet enquiries get one follow-up, only with marketing permission, with cooldown and cap. Replies and STOPs are recorded. | n8n workflows `[Lite] Lead Reactivation` + `[Lite] Inbound Replies` |

**Messages go to a TEST sink.** Every message that would be sent is written to **Lite Message Log** with Status
"Simulated Sent". Nothing reaches a real phone or inbox. Connecting a real SMS or email provider is a deliberate later
step (see Blocked below).

## Try it in 1 minute (local, nothing leaves your computer)

```bash
npx tsx lite/demo/run-demo.ts
```

The demo:
- builds the 4 workflows from `lite/config/demo.json`;
- loads synthetic data (every record starts with "ZZ Lite Demo");
- starts a local webhook server and sends it real HTTP requests: a new lead, the same lead again, an invalid lead, a
  lead without consent, a reply "Yes please", a reply "STOP";
- runs Review Requests and Reactivation twice each, to show nobody is messaged twice.

It runs the workflows' **actual n8n node code** against an in-memory Airtable that enforces the Lite schema. The report
goes to [`demo/output/demo-report.md`](demo/output/demo-report.md): every step, the pipeline by stage, the Message Log
and sample message texts.

Tests (17, the same code):
```bash
npx vitest run test/lite.test.ts
```

## How it is built

```
lite/config/<client>.json      one file per business: name, phone, Airtable base + n8n credential, message templates,
                               review link, thresholds (validated: lite/config/config.ts)
lite/airtable/schema.json      the five Lite tables (field names are the contract)
lite/airtable/setup.ts         creates them in a base (dry run by default; create-only; refuses if they exist)
lite/airtable/views.md         the CRM views and Interface to set up by hand
lite/n8n/src/*.sdk.ts          the four workflows (n8n Workflow SDK) + shared parts
lite/build.ts                  config + sources -> lite/dist/<client>/<workflow>.sdk.ts  (create with the n8n MCP tools)
                                                   and lite/dist/<client>/<workflow>.json   (n8n: Import from File)
lite/demo/                     the local demo: in-memory Airtable, synthetic data, webhook server
lite/tools/                    the SDK recorder, loader and runner the build, demo and tests share
```

The generated workflows are plain n8n workflows: HTTP Request nodes to the Airtable API, using an existing n8n
Airtable credential, plus Code and If nodes. They are exported **inactive**. n8n Cloud's own validator accepts the
generated node structures and connection patterns: webhook, Respond to Webhook, schedule and manual triggers, If,
Code, and Airtable HTTP reads and writes.

## Deploy for a business

The commands here run on your machine. Steps marked **(cloud)** change Airtable or n8n and need the owner's approval.

1. **Config.** Copy `lite/config/template.json` to `lite/config/<client>.json` and fill it in: the business name,
   phone and sign-off, the Airtable base id, the n8n Airtable credential, the Google review URL and the message
   templates. Then check it:
   ```bash
   npx tsx lite/build.ts lite/config/<client>.json
   ```
   This refuses any `<placeholder>` left behind, a review template without `{reviewUrl}`, or a reactivation message
   without a STOP instruction.
2. **(cloud) Create the five Lite tables** in that base. Use a token limited to that base, with `schema.bases:read`
   and `schema.bases:write`. First look at the plan, which changes nothing:
   ```bash
   npx tsx lite/airtable/setup.ts lite/config/<client>.json
   ```
   Then create the tables:
   ```bash
   LITE_AIRTABLE_TOKEN=... npx tsx lite/airtable/setup.ts lite/config/<client>.json --apply
   ```
   The tool only creates, and stops without changing anything if any Lite table already exists. Then confirm the
   result, read-only:
   ```bash
   LITE_AIRTABLE_TOKEN=... npx tsx lite/airtable/setup.ts lite/config/<client>.json --verify
   ```
3. **Views.** Set up the CRM views and Interface in Airtable ([airtable/views.md](airtable/views.md)), about 15 minutes.
4. **(cloud) Put the workflows in n8n**, inactive. Either import each `lite/dist/<client>/*.json` (Workflows ›
   Import from File), or create them from `lite/dist/<client>/*.sdk.ts` with the n8n MCP tools (`validate_workflow`,
   then `create_workflow_from_code`). Check that each Airtable node shows the credential from the config.
5. **(cloud) Test with synthetic data, still inactive.**
   - In the n8n editor, use "Execute workflow" on a webhook workflow and POST a test lead (the demo's payloads are in
     `lite/demo/run-demo.ts`) to the **test** webhook URL.
   - Run the review and reactivation workflows with "Run Now".
   - Check Lite Jobs and Lite Message Log.
6. **(cloud, owner decision) Go live.** Activate the workflows. Point the website form at the **production** webhook
   URL `https://<n8n host>/webhook/<leadIntake.webhookPath>`, and the provider's reply webhook at
   `/webhook/<replies.webhookPath>`. Do this only after the items under Blocked are done.

### The lead webhook (what a website form sends)

`POST /webhook/<leadIntake.webhookPath>` with JSON:

```json
{ "name": "Jane Citizen", "first_name": "Jane", "phone": "0412 345 678", "email": "jane@example.com",
  "address": "12 Example St", "suburb": "Bargara", "postcode": "4670", "service": "roof leak repair",
  "message": "Water through the ceiling", "source": "website",
  "consent_sms": true, "consent_email": true, "marketing_opt_in": false, "preferred_channel": "sms" }
```

- **Required:** a name, and a phone or email. Anything else missing is fine.
- **Answer:** `200` with the job reference and acknowledgement status, `200` with `duplicate: true` for a repeat
  enquiry within `dedupeWindowDays`, or `400` with the reasons.
- **Replies:** `POST /webhook/<replies.webhookPath>` with `{ "from": "<phone or email>", "text": "..." }`.

## Reuse for another trade business

Everything business-specific is in the config. For a plumber, for example:
1. Copy `template.json` to `lite/config/acme-plumbing.json`. Set the name, trade (`"plumbing"`), phone, sign-off,
   their Airtable base and n8n credential, their Google review link, and the message wording.
2. Build it:
   ```bash
   npx tsx lite/build.ts lite/config/acme-plumbing.json
   ```
   This writes `lite/dist/acme-plumbing/`.
3. Follow "Deploy for a business" with that config.

No workflow code changes. A test proves that a second config changes the name, review link, webhook path and base, and
leaves nothing of the first. To change stages, consent rules or timing: thresholds are in the config; stages and
consent rules are in `lite/n8n/src/` (rebuild afterwards).

## Guarantees and limits

**Built in:**
- **Consent:** service messages need the matching consent box. Reactivation also needs Marketing Opt-In. Opted Out
  blocks everything.
- **Opt-out:** a STOP reply (or UNSUBSCRIBE, OPT OUT…) sets Opted Out and removes marketing permission. The
  opt-out words are in the config.
- **Duplicates:** a repeat lead is spotted by email, or by phone in any format (0412…, +61 412…). Each job gets one
  review request: the job is marked, and the log is checked too, so a re-run or a half-finished run never asks twice.
  Reactivation has a cooldown and a per-month key.
- **Failures:** an Airtable error stops the run with a clear message (n8n marks the execution failed), so nothing is
  reported as done when it was not. The local Airtable rejects any field or option that is not in the schema, as the
  real one does with `typecast: false`.

**Limits (MVP):**
- Each look-up reads up to 100 records, which is fine for a small business. Pagination is not built yet.
- Times use the n8n server clock. The review delay and inactivity thresholds are whole days.
- An existing contact's consent is not changed by a new form submission; staff change consent in Airtable.

## Blocked: needs the owner before going live

1. **Lite tables in Airtable** (step 2) and **workflows in n8n** (step 4): cloud changes, not made yet.
2. **A real SMS or email provider.** Lite only has the test sink. Going live means choosing a provider (for example
   Twilio, or an email API), creating its n8n credential, and replacing the sink in `lite/n8n/src/common.part.ts`
   (`deliver`) with that provider's node. That is a decision and a paid account, so it is not done.
3. **Webhook protection.** The demo webhooks accept any POST. Before go-live, add Header Auth to both webhook nodes
   (n8n credential "Header Auth"), and have the form and provider send that header.
4. **The Google review link** in the config is a placeholder until the business provides its own.
