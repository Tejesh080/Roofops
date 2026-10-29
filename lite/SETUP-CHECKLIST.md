# RoofOps Lite: setup checklist (one client)

Tick each line. Full detail: [DEPLOY.md](DEPLOY.md).

## Before you start
- [ ] Business details, timezone, Google review link, operator mobile
- [ ] Message and consent wording approved by the client
- [ ] Review requests: separate tick (`express`, AU default) or service consent (`service`), written down
- [ ] Twilio account in the business's name; Australian mobile number (can send and receive); API key created
- [ ] On a Twilio trial: `trialTemplate` set, `from` empty, only your own verified phone (DEPLOY.md, "Twilio trial accounts")

## Accounts (cloud)
- [ ] A new Airtable base for the client (not shared with other automations)
- [ ] n8n project or folder for the client
- [ ] n8n credential: Airtable token (this base only, `data.records:read` + `data.records:write`)
- [ ] n8n credential: Basic Auth = Twilio API Key SID + Secret, **or** n8n's Twilio API credential (`credentialType: "twilioApi"`)
- [ ] Inbound check, one of:
  - n8n Variable `LITE_TWILIO_AUTH_TOKEN` (Pro/Enterprise);
  - a Basic Auth login for the reply webhook (Starter; tests only);
  - the reply relay with Header Auth (Starter; customer release).
- [ ] Basic Auth: a Twilio Webhook Setting + `EXACT_MATCH` Rule sends the login (never a password in a URL), checked with Twilio's Webhooks Test; then `statusCallbacks: true`
- [ ] Workflows with a login-protected webhook show **Do not save** for production executions (the build sets it: n8n would keep the login in saved headers)
- [ ] No secret written anywhere else (repository, chat, config file)

## Config and build (local)
- [ ] `lite/config/<client>.local.json` from `template.json`, every `<placeholder>` replaced, `messaging.mode: "test-sink"` (`.local` keeps the Account SID and numbers out of git)
- [ ] `npx tsx lite/build.ts lite/config/<client>.json`: no errors
- [ ] `npx tsx lite/demo/run-demo.ts lite/config/<client>.json lite/demo/output-<client>`: report reads correctly

## Airtable (cloud)
- [ ] `setup.ts` dry run reviewed, then `--apply`, then `--verify` clean
- [ ] Quote-to-Paid Interface built and published (views.md)

## n8n (cloud, all unpublished)
- [ ] Monitor imported; its id in `n8n.errorWorkflowId`; rebuilt
- [ ] The other four imported
- [ ] Every node shows the right credential; timezone set (the error workflow comes at go-live: n8n needs Monitor published first)

## Tests without real SMS (cloud)
- [ ] Cloud runbook with synthetic `ZZ` people: lead, duplicate, review, reactivation, STOP, monitor
- [ ] Optional: Twilio test credentials (`from: +15005550006`): Sent rows, nothing delivered, nothing charged

## First real SMS (live, approved: sender, ONE recipient, the test)
- [ ] `messaging.mode: "twilio"`, `allowedRecipients: [approved phone]`, `allowAllRecipients: false`; rebuilt and re-imported
- [ ] Twilio number: "A message comes in" → reply webhook URL (trial: Try out SMS › Auto-Reply › Custom webhook)
- [ ] Inbound Replies published (it rejects requests without the signature, login or relay header)
- [ ] One lead → one SMS → log Sent with SID → Delivered (if receipts are on)
- [ ] STOP from that phone → Opted Out → a new lead from it is not messaged

## Go live (client decision)
- [ ] `allowAllRecipients: true`; rebuilt and re-imported
- [ ] Website form live (lead-form.html or the form tool → lead webhook)
- [ ] Publish: Monitor, Inbound Replies, Lead Follow-Up, Review Requests, Lead Reactivation
- [ ] Error workflow = [Lite] Monitor on the other four; one deliberate production failure shows a Workflow Failed alert
- [ ] Demo data removed
- [ ] Staff shown: the Pipeline (drag cards, open a job, add its quote), recording consent, alerts and Retry Requested, Do not contact
