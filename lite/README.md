# RoofOps Lite

A small, reusable automation package for a trade business (roofing, plumbing, electrical and so on): an **Airtable**
CRM and five **n8n** workflows, with **Twilio** for SMS. There is no database to run, no server to host and no app
to deploy. Everything business-specific is one config file. Lite is separate from Advanced RoofOps: nothing in it
touches Advanced RoofOps tables, workflows, invoices or Xero.

| Module | What it does | Built as |
|---|---|---|
| **Quote-to-Paid CRM** | One Job per enquiry, New Lead to Paid, with contact (and their consent), site, quote, messages and alerts | 6 Airtable tables + an Interface ([airtable/](airtable/)) |
| **Instant Lead Follow-Up** | A website form posts a lead. It is checked, de-duplicated, saved with the consent given (source, time, wording), and acknowledged by SMS once. | `[Lite] Instant Lead Follow-Up` + `lead-form.html` |
| **Google Review Requests** | Daily: each finished job gets one review request, only with review permission | `[Lite] Google Review Requests` |
| **Lead Reactivation** | Weekly: quiet enquiries get one follow-up, only with recorded marketing consent, with cooldown and cap | `[Lite] Lead Reactivation` |
| **Replies and delivery receipts** | STOP opts out of everything; other replies reopen the enquiry; Twilio delivery receipts update the log | `[Lite] Inbound Replies` |
| **Monitoring** | Failed runs, failed or unconfirmed messages, leads nobody contacted: raised once as alerts; safe retry | `[Lite] Monitor` |

**Messaging is off by default.** `messaging.mode` is `test-sink`: every message is written to **Lite Message Log** as
"Simulated Sent" and nothing reaches a phone. In `twilio` mode, real SMS go only to numbers on
`messaging.twilio.allowedRecipients` until `allowAllRecipients` is set at go-live.

## How a message is sent (and never twice)

1. The workflow plans the message and checks permission (see Consent below).
2. It writes the message to the Message Log first (Status **Sending**, with a Dedupe Key and the CRM updates to make
   once it is sent).
3. It reads the log back. If another run reserved the same message earlier, this one is Skipped as a duplicate.
   Airtable has no conditional writes, so the earliest row wins.
4. It sends through the test sink or Twilio. Twilio mode calls `POST /Messages.json` with a Basic Auth credential or
   n8n's Twilio credential, and receipts go to the reply webhook. A Twilio trial account sends a Twilio template; see
   DEPLOY.md.
5. It records the outcome:

   | Outcome | Meaning |
   |---|---|
   | **Sent** | Twilio accepted it; the log row has the SID, and the job moves on. |
   | **Failed** | Twilio refused it, with the error code (for example 21211 invalid number). Nothing was sent. |
   | **Unknown** | No clear answer (timeout, server error). It may have been sent, so it is never resent by itself. |

   A Twilio 21610 (unsubscribed recipient) opts the contact out. Receipts later turn Sent into **Delivered**, or into
   Failed.

Staff tick **Retry Requested** on a Failed or Unknown message. `[Lite] Monitor` first asks Twilio whether it went out:
- **Found:** the row is corrected and nothing is resent.
- **Not found:** it is resent once, through the same reservation.
- **Never resent:** opted-out contacts, 21610 errors, or messages that could not be checked.

## Consent and opt-out (Australia: Spam Act 2003)

| Message | Purpose | Needs |
|---|---|---|
| Lead acknowledgement | Operational: a reply to their own enquiry | SMS consent ticked on the form |
| Review request | Commercial | **Review Opt-In** (or Marketing Opt-In), with **Consent Source** and **Consent Recorded At**. Set `consent.reviewRequests` to `"service"` to accept SMS consent instead (client decision). |
| Reactivation | Marketing | **Marketing Opt-In**, with Consent Source and Consent Recorded At |

- **Every message names the business;** review and marketing messages say "Reply STOP". The build refuses templates
  without these.
- **STOP, UNSUBSCRIBE, CANCEL, END, QUIT, OPT OUT…** opt the person out at once, well within the 5 working days the
  law allows. Lite never re-subscribes anyone automatically: a START is flagged for staff.
- **No consent is assumed.** A contact with a ticked box but no recorded source and date gets no review request or
  marketing. Details: [docs/compliance-au.md](docs/compliance-au.md).

## Try it locally (nothing leaves your computer)

```bash
npx tsx lite/demo/run-demo.ts
```
```bash
npx tsx lite/demo/run-demo.ts lite/config/example-plumbing-twilio.json lite/demo/output-twilio
```

- The first runs the test sink. Report: [demo/output/demo-report.md](demo/output/demo-report.md).
- The second runs Twilio mode against a **local fake** of the Twilio API: signed webhooks, real error codes, a refused
  number, an alert, a retry. Report: [demo/output-twilio/demo-report.md](demo/output-twilio/demo-report.md).

Both run the workflows' **actual n8n node code** against an in-memory Airtable that enforces the Lite schema.

Tests: 63, the same code, acceptance tests A–H.
```bash
npx vitest run test/lite.test.ts
```

## How it is built

```
lite/config/<client>.json      one file per business: name, timezone, Airtable base + credential, n8n URL, Twilio
                               (sender, account, credential, allowlist), consent wording and rules, templates, timings,
                               monitoring (validated: lite/config/config.ts; template: template.json)
lite/airtable/schema.json      the six Lite tables (field names are the contract)
lite/airtable/setup.ts         creates them (dry run by default; --apply create-only; --upgrade adds only what is missing)
lite/airtable/seed-demo.ts     loads the synthetic demo data (dry run by default)
lite/airtable/views.md         the Quote-to-Paid Interface
lite/n8n/src/*.sdk.ts          the five workflows (n8n Workflow SDK) + shared parts (common, send pipeline)
lite/forms/lead-form.ts        the website enquiry form
lite/build.ts                  config + sources -> lite/dist/<client>/<workflow>.sdk.ts (n8n MCP tools)
                                                   lite/dist/<client>/<workflow>.json   (n8n: Import from File)
                                                   lite/dist/<client>/lead-form.html    (paste into the website)
lite/demo/                     local demo: in-memory Airtable, fake Twilio, synthetic data, runbooks, demo script
```

Install a client: [DEPLOY.md](DEPLOY.md) (full guide) and [SETUP-CHECKLIST.md](SETUP-CHECKLIST.md) (one page).
Hand it over: [DELIVERY-CHECKLIST.md](DELIVERY-CHECKLIST.md). Staff guide: [docs/employee-guide.md](docs/employee-guide.md).
Demo script: [demo/portfolio-demo-script.md](demo/portfolio-demo-script.md).

## Limits (MVP)

- **Lookup size:** each look-up reads up to 100 records (no pagination). That is enough for a small business: about
  100 open enquiries or finished jobs waiting for a review at one time.
- **Channels:** SMS only with Twilio. In test-sink mode email is simulated too.
- **Simultaneous form copies:** two copies of one form arriving at the same moment can create two contact/job
  records. Only one SMS is sent, and the second job is marked Lost.
- **Timezone:** schedules run in the business timezone (workflow setting). Delays are whole days.
- **Retries:** a retry uses the number on the message row. Fix the number there (or on the contact for future
  messages), then tick Retry Requested.
