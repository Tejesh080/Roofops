# Evidence: RoofOps Lite client-ready MVP, local verification, 2026-10-20

These are the v2 changes:
- Twilio adapter (off by default);
- consent evidence and AU rules;
- the reserve-and-confirm send pipeline;
- delivery receipts and signed webhooks;
- [Lite] Monitor (alerts and safe retry);
- the website form;
- the client template.

The workflows' real n8n node code was run locally against a schema-enforcing in-memory Airtable and a local fake of
the Twilio API. **No cloud resource was changed, and no SMS was sent.**

Commands:
```bash
npx vitest run test/lite.test.ts
```
```bash
npx tsx lite/demo/run-demo.ts lite/config/example-plumbing-twilio.json lite/demo/output-twilio
```

Result: **40/40 tests pass**; tsc and eslint are clean.

## Acceptance tests (local)

| Test | Result | Test(s) in `test/lite.test.ts` |
|---|---|---|
| A. A new lead creates CRM records | PASS | Contact (with consent source, time and wording), Property and Job; Contacted after the acknowledgement |
| B. An eligible lead receives one SMS | PASS (fake Twilio) | One POST to `/Accounts/{AC}/Messages.json` (E.164 To, configured From, StatusCallback, Basic Auth credential); log Sent with the SID |
| C. A duplicate lead gets no duplicate message | PASS | Same lead again: no POST. Two copies arriving together (a pre-reserved Dedupe Key): one SMS; the second job is Lost and logged "duplicate" |
| D. A completed job produces one permitted review request | PASS | Only with Review Opt-In recorded; opted-out, no-permission and no-SMS customers skipped with reasons; a second run sends 0 |
| E. A consented inactive lead receives one reactivation | PASS | Only Marketing Opt-In with a recorded source and date; "consent not recorded" (Zoe) excluded; cooldown and recent leads excluded; a second run sends 0 |
| F. STOP prevents future promotional messages | PASS | A signed STOP marks Opted Out and clears marketing; later reviews and reactivation skip the contact; START does not re-subscribe; a 21610 receipt opts out |
| G. Failed delivery is logged and recoverable | PASS | Below |
| H. A new client config installs without editing workflow source | PASS | Below |

**G in detail:**
- **Refused number (21211):** logged Failed with the reason, and the job stays New Lead. Monitor raises one alert and
  texts the operator once; a second run raises nothing new.
- **Fixed number:** after the number is fixed and Retry Requested ticked, Twilio is checked first, then the message is
  resent once (`:retry:2`), and the job moves to Contacted.
- **Timeout after Twilio sent it:** the row is Unknown and never resent by itself. On a retry it is found at Twilio, the
  log is corrected, and nothing is resent.
- **Server error:** the row is Unknown. The retry is postponed while Twilio cannot be checked, then resends once.
- **Never resent:** an opted-out contact, a 21610, or a message that is already Sent.
- **Stuck in Sending:** the row becomes Unknown and is raised.
- **Error Trigger:** a failed run is raised once.

**H in detail:** `lite/config/example-plumbing-twilio.json` (Sydney, its own base, table names, Twilio account,
paths, review link and error workflow) builds and runs with no source edits:
- the generated files contain nothing of the demo client;
- `setup.ts` creates the tables under the client's names, and names the back-link "Lite Jobs";
- a lead on those tables is acknowledged through Twilio;
- no secret is in any generated file.

## Guards proven by deliberately breaking them (red, then green)

| Removed | Tests that failed |
|---|---|
| The duplicate-reservation check in `send.part.ts` | "C. … two copies … send one SMS", "live safety …" |
| The signature check in `inbound-replies.sdk.ts` | "requests that are not from Twilio change nothing" |

With the code restored, all 40 pass.

## n8n Cloud validator (read-only)

A 13-node probe built from the real generated node definitions passed `validate_workflow`: `{"valid":true,"nodeCount":13}`.
The Code bodies were shortened; nothing was created in n8n. It covers every node type v2 adds:
- Error Trigger;
- an hourly schedule;
- Twilio form-POST and GET with Basic Auth;
- HTTP with an expression method and URL;
- the generic PATCH;
- Respond to Webhook with TwiML text and headers;
- a webhook with Basic Auth.

The full workflow files are emitted by the same emitter, whose full v1 files n8n Cloud validated unshortened and ran
on 2026-10-20.

## Not verified (needs the cloud batches or your approval)

| What | Why | When |
|---|---|---|
| v2 running in n8n Cloud against the real Airtable | Needs the Airtable additions (one manual step for select options) and the five workflows | `lite/demo/cloud-v2-plan.md`, batches A and B |
| The Error Trigger on n8n Cloud | n8n runs error workflows only for production (published) executions | At go-live |
| The real Twilio API | Needs your Twilio credentials in n8n (never in the repository or chat) | Batch C (test credentials) and batch D (one real SMS) |
| n8n Variables for signature checks | Needs n8n Cloud Pro or Enterprise; basic-auth mode is the alternative | Your plan |
