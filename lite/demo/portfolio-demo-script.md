# RoofOps Lite: Loom demo script (about 4 minutes)

**The story:** a small trade business that answers every enquiry in seconds, asks happy customers for a review, wins
back quiet quotes, honours STOP, and is warned when something fails. It is built on n8n Cloud, Airtable and Twilio,
from one config file per client.

**What to record:**
- **After cloud batches A–B** (`cloud-v2-plan.md`): everything below runs in n8n Cloud and Airtable with the test sink.
- **Until then:** use the local Twilio-mode run for steps 4–6:
  ```bash
  npx tsx lite/demo/run-demo.ts lite/config/example-plumbing-twilio.json lite/demo/output-twilio
  ```
- **After batch D only:** a real SMS on your own phone.

## Before you record

Open five tabs:
1. **Airtable:** Interface "Lite Quote-to-Paid", **Pipeline**.
2. **Airtable:** the same Interface, **Message Log** (tab Needs attention), then **Alerts**.
3. **n8n:** the Roofops project with the five `[Lite]` workflows.
4. **The enquiry form:** `lite/dist/demo/lead-form.html` opened in a browser. In test-sink mode, POST with `curl`
   instead (below).
5. **Code:** `lite/config/demo.json` in an editor.

**Use a new synthetic person:** `ZZ Lite Demo Chloe Hart`, `0400 000 202`. People already messaged are, correctly,
not messaged again.

## Script

### 0:00–0:25: the problem

> "Tradies lose jobs to slow replies, never ask for reviews, and forget old quotes. This is a small package that fixes
> all three: an Airtable CRM and five n8n automations, set up from one config file."

**Show:** the Pipeline Kanban, New Lead → Paid.

### 0:25–1:10: instant lead follow-up

**Show:** n8n › [Lite] Instant Lead Follow-Up › Execute workflow. Submit the form, or run:
```bash
curl -s -X POST https://tejesh08.app.n8n.cloud/webhook-test/roofops-lite/lead -H "content-type: application/json" -d "{\"name\":\"ZZ Lite Demo Chloe Hart\",\"first_name\":\"Chloe\",\"phone\":\"0400 000 202\",\"address\":\"3 Demo Lane\",\"suburb\":\"Bargara\",\"service\":\"Roof restoration\",\"consent_sms\":true,\"consent_reviews\":true,\"demo\":true}"
```

**Show:** the green execution and `stage: Contacted`. Then the Message Log row: Purpose Operational, Status Simulated
Sent (or Sent with a Twilio SID).
> "Under five seconds: contact, property and job created, and one SMS. Her consent is stored with where and when she
> gave it, and the exact wording."

**Show:** the contact's Consent Source, Consent Recorded At and Consent Wording. Send the same request again: the
answer is `duplicate: true`.
> "Twice, or double-clicked: one record, one message."

### 1:10–1:50: consent decides who gets what

**Show:** n8n › [Lite] Google Review Requests › Execute (Run Now) › the summary.
> "Review requests are commercial messages in Australia, so they need express permission. This customer ticked the
> review box and gets one request. These customers didn't, so they get nothing, and the reason is logged."

**Show:** the Contacts tab **Consent not recorded**.
> "A ticked box with no record of where or when is not consent. Lite won't message that person."

### 1:50–2:30: STOP, and nobody is messaged twice

**Show:** Inbound Replies with a STOP, then the contact: Opted Out, marketing cleared.
> "STOP takes effect immediately; the law allows five working days. After that, no review request, follow-up or
> retry. Twilio's own 'unsubscribed' error does the same."

**Show:** Run Review Requests again: 0 sent.

### 2:30–3:30: when something goes wrong

Local Twilio run or cloud:
- **Show** a Message Log row with Status **Failed** and Error Code **21211** (invalid number), then **Alerts**: one
  Delivery Failed.
- **Narrate:**
  > "Failures don't disappear. Monitor runs every two hours, raises each problem once, and texts the owner."
- **Show:** fix the number on the row, tick **Retry Requested**, run Monitor. The row says "resent as attempt 2", and
  the job moves to Contacted.
  > "Before resending, Lite asks Twilio whether the message went out. If it did, nothing is sent again."

### 3:30–4:00: a new client is a config file

**Show:** `lite/config/example-plumbing-twilio.json` next to `demo.json`. Then run the build:
```bash
npx tsx lite/build.ts lite/config/example-plumbing-twilio.json
```
> "A plumber in Sydney: different name, tables, Twilio number, review link and timezone. Same workflows, no code
> edits. 40 automated tests cover lead capture, consent, STOP, duplicates and failures."

## After recording

- **Workflows:** leave them unpublished.
- **Demo data:** delete it from the Jobs tab **Demo data**.
- **Next take:** use a new synthetic number, such as `0400 000 203`.
