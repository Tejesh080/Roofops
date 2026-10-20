# RoofOps Lite: deployment guide for a trade business

This guide sets up the four Lite automations for a new client: a roofer, plumber, electrician or any other trade. You get:
- an Airtable Quote-to-Paid CRM (5 tables and an Interface);
- the four n8n workflows: Instant Lead Follow-Up, Google Review Requests, Lead Reactivation and Inbound Replies.

The whole path was run end to end on 2026-10-20 against real Airtable and n8n Cloud. The evidence is in `evidence/lite-cloud-demo-20261020.md`.

**Time:** about 1.5 hours for a new client, plus the go-live items, which depend on the client.

## 0. What you need from the client

| Item | Used for |
|---|---|
| Business name, trade, phone, sign-off line, timezone | message templates |
| Google review link (`https://g.page/r/<place-id>/review`) | review requests |
| The wording they want, or approval of the defaults | all four messages |
| How leads arrive (website form, Facebook lead ads, phone) | Lead Follow-Up webhook |
| Their SMS or email provider account, before go-live | real sending (not part of Lite yet) |
| Who may approve consent and opt-out changes | staff rules in the CRM |

## 1. Accounts and isolation

- **Give every client their own Airtable base.** Don't add Lite tables to a base that other automations watch.
  - In the RoofOps demo base, every Lite write woke the base-wide webhook of `[RoofOps] 06`. That workflow ignored the writes correctly, but it cost one n8n execution each.
  - A dedicated base avoids this, and keeps client data apart.
- **n8n:** use one project per client, or a folder in your own project.
  - Create an **Airtable Personal Access Token** credential, scoped to the client's base only, with `data.records:read` and `data.records:write`.
  - Note the credential's ID and name for the config.
- **Optional, needed before go-live:** an n8n **Header Auth** credential to protect the two webhooks.

## 2. Config and build (your machine)

```bash
cp lite/config/template.json lite/config/acme-plumbing.json
```

Edit the new file:
- business details;
- `airtable.baseId` and `airtable.credential`;
- `reviews.googleReviewUrl`;
- the message templates and thresholds;
- unique webhook paths, for example `acme-plumbing-lite/lead`.

Leave `messaging.mode` as `test-sink` until go-live.

```bash
npx tsx lite/build.ts lite/config/acme-plumbing.json
```

The build refuses any `<placeholder>` left behind, a review message without `{reviewUrl}`, and a reactivation message without STOP. It writes `lite/dist/acme-plumbing/` with four `.sdk.ts` files and four importable `.json` files.

## 3. Airtable tables

Print the plan first. It changes nothing:
```bash
npx tsx lite/airtable/setup.ts lite/config/acme-plumbing.json
```

Then use one of two routes.

**Route A: token.** Create a personal access token for the client's base with `schema.bases:read` and `schema.bases:write`, then:
```bash
LITE_AIRTABLE_TOKEN=... npx tsx lite/airtable/setup.ts lite/config/acme-plumbing.json --apply
```
```bash
LITE_AIRTABLE_TOKEN=... npx tsx lite/airtable/setup.ts lite/config/acme-plumbing.json --verify
```

**Route B: Airtable connector.** This is the route used for the 2026-10-20 demo.
1. Create the five tables in plan order, with the fields exactly as `fieldSpec` in `setup.ts` builds them.
2. Then create the six link fields: Properties.Contact, Jobs.Contact, Jobs.Property, Quotes.Job, Messages.Job, Messages.Contact.
3. Check that **Lite Contacts** now has the back-link **"Lite Jobs"**. The workflows depend on that name.

Either way, the tool only creates. It never changes or deletes an existing table.

## 4. CRM Interface (about 10 minutes)

Build the **Quote-to-Paid** Interface described in `lite/airtable/views.md`: Overview, Pipeline (Kanban by Stage), Jobs (with tabs), Message Log, Contacts and Quotes.

With the Airtable connector this is six `create_page` calls and one `publish_interface`. The demo Interface `pbdAzDJhyiIb7CFZJ` is a working reference; copy its page settings. Choice IDs differ per base, so read them with `get_table_schema` first.

## 5. n8n workflows (inactive)

For each file in `lite/dist/<client>/`, use one of two routes:
- **n8n MCP tools:** `validate_workflow`, then `create_workflow_from_code` (with `projectId`).
- **n8n UI:** Workflows › Import from File, using the `.json`.

Then check each workflow:
- every Airtable HTTP node shows the client's Airtable credential;
- the workflow is **unpublished**: `active: false`, no registered triggers.

Ignore the message "credentials must be configured manually" after an MCP create. The credential is set in the code, and the demo confirmed it was kept.

## 6. Test with synthetic data (still inactive)

Follow `lite/demo/cloud-demo-runbook.md`. For a new client, either load the demo records first (`seed-demo.ts`, or the connector route in the same link order), or use your own `ZZ`-named test people.

Run each case once as a **manual** execution:
- n8n `execute_workflow` with `executionMode: manual`;
- `triggerNodeName: "Lead Webhook"` or `"Reply Webhook"` with `inputs.webhookData.body`;
- or `"Run Now"` for the scheduled workflows.

Check the Message Log and the Pipeline after each case.

**If a run fails:**
1. Do not re-run it blindly. Open the execution; the error names the step (for example `create job: Airtable HTTP 422`).
2. Check in Airtable what was already written.
3. Re-run only once you know what the re-run will do.

## 7. Go-live (client decision, one item at a time)

1. **Real messages.** Choose the provider, for example Twilio for SMS or an email API, and create its n8n credential. Replace `deliver` in `lite/n8n/src/common.part.ts` with the provider call, set `messaging.mode` accordingly, rebuild and re-test. Lite has no live provider yet.
2. **Webhook protection.** Set `webhookAuth` in the config to the Header Auth credential, then rebuild and replace the workflows. The form and provider must send the header. Never publish an unprotected webhook.
3. **Review link and wording.** Use the client's real Google link and approved wording.
4. **Lead source.** Point the website form, or the Facebook/Zapier bridge, at the production URL: `https://<n8n host>/webhook/<leadIntake.webhookPath>`. Point the provider's inbound reply webhook at `/webhook/<replies.webhookPath>`.
5. **Publish** the four workflows. The schedules start: reviews daily at 10:00, reactivation weekly on Monday at 09:00, in the n8n instance timezone.
6. **Remove the demo data:** the Jobs page tab **Demo data**.

## 8. Handover to the client

Show staff:
- the Pipeline, and how to move a job from Quoted to Paid;
- where to set Completed At (review requests depend on it);
- the "Do not contact" list.

Their rules:
- Never untick Opted Out unless the customer asks.
- Don't rename tables or fields.
- Consent is three separate boxes.

## Undo

Nothing is deleted automatically.
- **Workflows:** unpublish, then archive the four in n8n.
- **Data:** in Airtable, delete records from the Demo data tab, or delete the five Lite tables and the Interface. A dedicated base can simply be deleted.
