# RoofOps Lite: the Quote-to-Paid CRM in Airtable

The CRM is five Airtable tables (`lite/airtable/schema.json`) plus the views below. The Airtable API cannot create views
or Interfaces, so they are set up by hand once. That takes about 15 minutes, and then works for every client base.

## The journey

**Lite Jobs › Stage** carries every enquiry through:

New Lead → Contacted → Quoted → Accepted → Job In Progress → Completed → Invoiced → Paid (or Lost)

| Stage change | Who makes it |
|---|---|
| New Lead | **Lead Follow-Up** creates the job when a lead arrives. |
| → Contacted | **Lead Follow-Up**, once the acknowledgement has gone out, and **Inbound Replies** when a New Lead replies. Otherwise staff. |
| → Quoted | Staff: create a **Lite Quotes** record (Status Sent) linked to the job, then set the Stage. |
| → Accepted | Staff: set the quote to Accepted, then the Stage. |
| → Job In Progress, → Completed | Staff. Set **Completed At** when the work is finished; the review request depends on it. |
| → Invoiced, → Paid | Staff, with **Invoice Status** and **Invoice Amount**. This is tracking only: Lite never creates invoices or touches Xero. |

The automations only ever move a job forward to **Contacted**. Every other stage belongs to the business.

## Views to create

### Lite Jobs

1. **Pipeline (Kanban)**: Kanban view, stacked by **Stage**. Card fields: Contact, Service, Last Activity At, Invoice
   Amount. This is the main CRM screen.
2. **New leads**: Grid. Filter: Stage is New Lead. Sort: Lead Received At, newest first. Staff call these first.
3. **To quote**: Grid. Filter: Stage is Contacted.
4. **Work on**: Grid. Filter: Stage is Accepted or Job In Progress.
5. **To invoice**: Grid. Filter: Stage is Completed AND Invoice Status is Not Invoiced.
6. **Unpaid**: Grid. Filter: Invoice Status is Invoiced. Shows the total of Invoice Amount.
7. **Reviews**: Grid. Filter: Review Status is not empty. Fields: Review Status, Review Requested At, Review Skip Reason.
8. **Quiet leads**: Grid. Filter: Stage is New Lead, Contacted or Quoted. Sort: Last Activity At, oldest first.
9. **Demo data**: Grid. Filter: Demo Data is checked. Use it to find and delete the synthetic records.

### Lite Contacts

- **Do not contact**: Opted Out is checked.
- **Marketing list**: Marketing Opt-In is checked AND Opted Out is not checked.

### Lite Message Log

- **All messages**: Grid. Sort: Attempted At, newest first. Group by Workflow.
- **Problems**: Status is Failed or Skipped.
- **Replies and opt-outs**: Status is Received or Opt-Out.

## Interface (optional, recommended for the owner)

Create an Interface named **"Quote-to-Paid"** with these elements:

- **Number** elements: count of Lite Jobs where Stage is New Lead; to invoice; and the sum of Invoice Amount where Invoice
  Status is Invoiced (money owed).
- **Kanban** element on Lite Jobs, stacked by Stage. This is the pipeline.
- **Grid** element: Lite Message Log, last 20.
- **Record review** layout on Lite Jobs, for staff working through New leads.

## Rules that keep the automations safe

- **Keep the names.** The table and field names in `schema.json` are what the workflows read and write. Rename one and
  the workflow stops with a clear Airtable error; it never writes to the wrong place.
- **Keep the back-link "Lite Jobs"** on Lite Contacts. Airtable creates it as the other side of Lite Jobs › Contact.
  The reply and duplicate checks use it.
- **Leave Opted Out ticked.** Once someone opts out, never untick it unless they ask to be contacted again; every Lite
  message checks it.
- **Consent is three separate boxes.** Consent SMS and Consent Email cover service messages (acknowledgements and
  review requests). Marketing Opt-In is also required for reactivation.
