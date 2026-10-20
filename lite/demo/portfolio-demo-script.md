# RoofOps Lite: portfolio demo script (about 4 minutes)

**The story:** a small roofing business that never misses a lead, asks every happy customer for a review, wins back quiet quotes, and respects STOP. Everything runs on n8n Cloud and real Airtable records, with synthetic data. Messages go to a test sink and are never really sent.

## Before you record

Open three browser tabs:
1. **Airtable:** the Interface **Lite Quote-to-Paid**, page **Pipeline**: `https://airtable.com/appMc8V0Wm29tEeHQ/pagSoRoOHL8eClVBC`
2. **Airtable:** the same Interface, page **Message Log**: `https://airtable.com/appMc8V0Wm29tEeHQ/pagXBMMy90Crh9v3Q`
3. **n8n:** the Roofops project, showing the four `[Lite]` workflows.

Have a terminal ready for one `curl`.

Pick a new person for the live lead (below, Chloe). The seeded people have already been messaged, and the workflows correctly refuse to message them twice.

Optional, so a review request goes out live: in Airtable, set job **LJ-DEMO-P2** (Jack, flashing repair) to Stage **Completed**, with **Completed At** three days ago. Jack has SMS consent, so the review run will pick him up.

## Script

### 0:00 to 0:30: the problem and the result

> "Tradies lose work because enquiries sit unanswered, happy customers are never asked for a review, and old quotes go cold. This is RoofOps Lite: four automations on n8n and Airtable that fix all three, without anyone sending a message by hand."

**Show:** tab 1, the Pipeline Kanban. Scroll the stages from New Lead to Paid.
> "Every job lives on this board. The automations only ever move a job to Contacted; everything after that is the business's decision."

### 0:30 to 1:30: instant lead follow-up (live)

**Show:** tab 3. Open **[Lite] Instant Lead Follow-Up** and click **Execute workflow**, so the editor listens on the test URL.

Run this in the terminal:
```bash
curl -s -X POST https://tejesh08.app.n8n.cloud/webhook-test/roofops-lite/lead -H "content-type: application/json" -d "{\"name\":\"ZZ Lite Demo Chloe Hart\",\"first_name\":\"Chloe\",\"phone\":\"0400 000 202\",\"email\":\"chloe.hart@example.test\",\"address\":\"3 Demo Lane\",\"suburb\":\"Bargara\",\"service\":\"roof restoration\",\"source\":\"website\",\"consent_sms\":true,\"consent_email\":true,\"demo\":true}"
```

**Show:** the green run in n8n and the JSON reply: `job_ref`, `stage: Contacted`, `acknowledgement: Simulated Sent`.
> "In about five seconds she's in the CRM with her property and a job, and she's had a personalised SMS. Here it's a test sink, so the text lands in the Message Log, not on a phone."

**Show:** tab 2, the Message Log. Point at "Hi Chloe, thanks for contacting Harbourside Roofing…".

**Show:** run the same `curl` again (click Execute workflow first). The reply is `duplicate: true` with the same job.
> "If she fills in the form twice, nothing is duplicated and she isn't messaged again."

### 1:30 to 2:15: Quote-to-Paid

**Show:** tab 1. Find Emma's card in **Paid** and open it: linked contact, property, quote LQ-DEMO-EMMA for $3,450, and the message history.
> "This job came in through the same webhook and went New Lead → Contacted → Quoted → Accepted → In Progress → Completed → Invoiced → Paid. The quote, the property and every message are linked to it."

**Show:** the **Overview** page: new leads, to invoice, money owed, paid.

### 2:15 to 3:00: Google review requests

**Show:** tab 3. Open **[Lite] Google Review Requests** and click **Execute workflow** (the "Run Now" trigger). Open the last node, **Review Run Summary**.
> "Every day it finds finished jobs. It asks each happy customer once, and only with consent. Opted-out people and people without consent are skipped, with the reason recorded."

If you completed Jack's job beforehand, the summary shows `sent: 1`. If not, it shows `sent: 0` and `already requested`. That is the duplicate protection working: it asked Olivia and Marcus in the earlier run, and it won't ask them twice.

**Show:** the Message Log tab **Problems** for the skipped reasons: "opted out", "no consent".

### 3:00 to 3:40: reactivation and replies

**Show:** the Message Log. Point at the **Reactivation** rows (Mia by email, Daniel by SMS), then the **Inbound Reply** rows.
> "Weekly, it follows up quotes that have gone quiet for 90 days, but only for people who opted in to marketing, never more than once in six months. Daniel replied 'Yes please', so his job came back to life. Olivia replied STOP, and she is now opted out of everything."

**Show:** the **Contacts** page, tab **Do not contact**: Olivia, Priya and Liam.

### 3:40 to 4:00: close

> "Four automations: instant follow-up, review requests, reactivation and replies, on n8n Cloud with an Airtable CRM. Built from one config file per business, so the next roofer, plumber or electrician is a new config, not new code. Every rule (consent, opt-out, no duplicates) is checked on every run."

## After recording

- **Workflows:** leave all four unpublished.
- **Clean-up:** Chloe's records have Demo Data ticked. Delete them from the Jobs page tab **Demo data** if you want a clean board for the next take.
- **Next take:** a new take needs another new name and phone, for example `0400 000 203`.
