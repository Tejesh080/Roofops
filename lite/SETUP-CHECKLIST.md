# RoofOps Lite: setup checklist (one client)

Tick each line. Full detail: [DEPLOY.md](DEPLOY.md).

## Before you start
- [ ] Business details, timezone, Google review link, operator mobile
- [ ] Message and consent wording approved by the client
- [ ] Review requests: separate tick (`express`, AU default) or service consent (`service`), written down
- [ ] Twilio account in the business's name; Australian mobile number (can send and receive); API key created

## Accounts (cloud)
- [ ] A new Airtable base for the client (not shared with other automations)
- [ ] n8n project or folder for the client
- [ ] n8n credential: Airtable token (this base only, `data.records:read` + `data.records:write`)
- [ ] n8n credential: Basic Auth = Twilio API Key SID + Secret
- [ ] Inbound check: n8n Variable `LITE_TWILIO_AUTH_TOKEN` (Pro/Enterprise), **or** a Basic Auth login for the reply webhook
- [ ] No secret written anywhere else (repository, chat, config file)

## Config and build (local)
- [ ] `lite/config/<client>.json` from `template.json`, every `<placeholder>` replaced, `messaging.mode: "test-sink"`
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
- [ ] Twilio number: "A message comes in" → reply webhook URL
- [ ] Inbound Replies published (it rejects unsigned requests)
- [ ] One lead → one SMS → log Sent with SID → Delivered
- [ ] STOP from that phone → Opted Out → a new lead from it is not messaged

## Go live (client decision)
- [ ] `allowAllRecipients: true`; rebuilt and re-imported
- [ ] Website form live (lead-form.html or the form tool → lead webhook)
- [ ] Publish: Monitor, Inbound Replies, Lead Follow-Up, Review Requests, Lead Reactivation
- [ ] Error workflow = [Lite] Monitor on the other four; one deliberate production failure shows a Workflow Failed alert
- [ ] Demo data removed
- [ ] Staff shown: pipeline, Completed At, recording consent, alerts and Retry Requested, Do not contact
