# RoofOps Lite: client delivery checklist

This list covers what must be true before, at and after handover to a trade business. The install itself is in
[SETUP-CHECKLIST.md](SETUP-CHECKLIST.md) and [DEPLOY.md](DEPLOY.md). Tick every line; write down every decision.

## 1. What the client receives

| Item | Where it lives |
|---|---|
| Quote-to-Paid CRM: six Lite tables and the Interface (Overview, Pipeline, Jobs, Message Log, Contacts, Quotes, Alerts, Needs Attention, Consent, Health) | The client's own Airtable base |
| Five workflows: `[Lite]` Lead Follow-Up, Review Requests, Lead Reactivation, Inbound Replies, Monitor | The client's n8n project |
| Website enquiry form | `lite/dist/<client>/lead-form.html`, pasted into their site |
| SMS from the business's own Australian number | The client's Twilio account |
| Staff guide | [docs/employee-guide.md](docs/employee-guide.md) and DEPLOY.md step 9, plus a recorded walkthrough (script: [demo/portfolio-demo-script.md](demo/portfolio-demo-script.md)) |
| Compliance notes | [docs/compliance-au.md](docs/compliance-au.md) |
| Their config and build | `lite/config/<client>.local.json` and `lite/dist/<client>.local/`: kept by the installer, never in git |

## 2. Release gate (installer, before client work)

- [ ] `npm run check` passes: lint, typecheck and every test (Lite: 70 in `test/lite.test.ts`).
- [ ] The client config builds with no errors.
- [ ] The local demo report reads correctly: `npx tsx lite/demo/run-demo.ts lite/config/<client>.local.json lite/demo/output-<client>`.
- [ ] `git status` shows no `*.local.json`, no `lite/dist/*.local/` and no `.env.local`. The diff contains no Account SID,
      phone number, token or password.
- [ ] After installing, the cloud workflows match the build node for node.

## 3. Decisions the client signs off

- [ ] Message wording and consent wording: form, acknowledgement, review request, reactivation.
- [ ] Review consent: `express` (Australian default) or `service`.
- [ ] Alert texts: the operator mobile, and how often Monitor runs.
- [ ] **Twilio:**
  - an upgraded account in the business's name;
  - an Australian mobile number, with its regulatory bundle.

  A trial account cannot serve customers. It sends only Twilio's own template text, only to verified phones.
- [ ] **Reply webhook security** (record which one):

  | n8n plan | Option | What it proves |
  |---|---|---|
  | Pro or Enterprise | `signature`: the Auth Token in an n8n Variable | The request came from Twilio, unchanged |
  | Starter | `header-auth` with the reply relay (a Protected Twilio Function) | The same; Functions are billed past Twilio's free allowance |
  | Starter | `basic-auth`, with the login sent by a Twilio Webhook Rule | Only that the caller knows the password: suitable for a pilot |

- [ ] **Executions:** the estimate fits the plan. Starter allows 2,500 a month; about 650–700 a month for 60 leads and
      90 SMS, with Monitor every 2 hours.
- [ ] **Ownership:** the client owns the Airtable, n8n and Twilio accounts. The installer has a named user with only the
      access needed.

## 4. Install

- [ ] Every line of [SETUP-CHECKLIST.md](SETUP-CHECKLIST.md) is ticked, including the cloud tests on the test sink with
      synthetic `ZZ` people.

## 5. Acceptance on the client's system

- [ ] **Test sink, synthetic people:**
  - A: a new lead;
  - C: a duplicate;
  - D: a review request, with consent;
  - E: reactivation, with consent;
  - F: STOP;
  - G: a Monitor alert and one retry.
- [ ] **The reply webhook refuses outsiders,** checked from outside: no login, or a wrong login, gives `401`. In
      signature mode, an unsigned request gives `403`.
- [ ] **Basic Auth only:** Twilio's Webhooks Test confirms the Rule's login is accepted.
- [ ] **Workflows with a login-protected webhook** show "Do not save" for production executions.
- [ ] **One real SMS** to the client's own phone, with the allowlist set to that phone only: logged Sent with a SID,
      then Delivered.
- [ ] **A normal reply** is logged Received and reopens the enquiry. **STOP** opts the person out, and a new lead from
      that phone gets no SMS.
- [ ] **The error workflow works:** after Monitor is published, one deliberate failure raises a Workflow Failed alert.
- [ ] **Evidence is filed:** execution ids and screenshots without personal data. Starter keeps execution logs for 7
      days only.

## 6. Go-live (the client's decision, in this order)

- [ ] `allowAllRecipients: true`; rebuild; replace the workflows; check them node for node.
- [ ] The form is on the website, or their form tool posts to the lead webhook.
- [ ] Publish Monitor, Inbound Replies, Lead Follow-Up, Review Requests, then Lead Reactivation. Then set Monitor as the
      error workflow of the other four.
- [ ] The number's "A message comes in" points at the reply URL. It is a plain URL; any login comes from the Rule or the
      relay.
- [ ] **Clean up:** remove the synthetic data (Admin page › test and demo records) and the installer's test rows. The test rows hold real
      phone numbers.

## 7. Handover

- [ ] **Staff walkthrough** (DEPLOY.md step 9, following [docs/employee-guide.md](docs/employee-guide.md)):
  - the Pipeline: drag the cards, click one to open the job, and add the quote there;
  - recording consent taken by phone;
  - alerts and Retry Requested;
  - the "Do not contact" list.
- [ ] The recorded walkthrough is sent.
- [ ] **Secrets:**
  - Rotate any login the installer created (reply webhook, Header Auth). Twilio Settings are immutable: rotating means
    a new Setting, then moving the Rule to it.
  - Keep secrets only in the client's n8n and Twilio.
- [ ] **Access:** remove the installer's access, or keep the support access agreed in writing.
- [ ] **Hand over:** this checklist, DEPLOY.md, the compliance notes, the config file and the acceptance evidence.
- [ ] Agree who answers an alert, and how fast.

## 8. First two weeks

- [ ] Check Alerts on the Overview page every day.
- [ ] After week 1, check n8n execution usage against the plan.
- [ ] Watch Twilio delivery and opt-out rates. An opt-out rate above about 3% risks carrier filtering.
- [ ] Resolve every Unknown or Failed message, using Retry Requested where it is safe.

## 9. Limits to tell the client

- SMS only. Email is simulated in test-sink mode.
- Each look-up reads up to 100 records: about 100 open enquiries or finished jobs waiting for a review at one time.
- Two copies of one form at the same moment can create two records. Only one SMS is sent.
- Lite v1 never re-subscribes a number that replied STOP: its Opt-Out row keeps it suppressed. If the person asks to
  hear from the business again, contact them outside Lite.
- **On n8n Starter:**
  - no signature check inside n8n;
  - execution logs for 7 days;
  - workflows with a login-protected webhook keep no execution data. The Message Log is their record.

## Sign-off

| Role | Name | Date |
|---|---|---|
| Client | | |
| Installer | | |
