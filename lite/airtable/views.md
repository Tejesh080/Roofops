# RoofOps Lite: the Quote-to-Paid CRM in Airtable

The CRM is six Airtable tables (`lite/airtable/schema.json`: Contacts, Properties, Jobs, Quotes, Message Log, Alerts)
plus an Interface and views.
- **The Interface** ("Quote-to-Paid", below) can be created through the Airtable connector (`create_interface`,
  `create_page`, `publish_interface`). That is how the demo base got one, on 2026-10-20.
- **Grid and Kanban views inside the tables** cannot be created through the API. Add them by hand if staff prefer
  the table view to the Interface; it takes about 15 minutes.

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

## Interface (recommended: this is what the owner and staff use)

The demo base has the published Interface **"Lite Quote-to-Paid"** (`pbdAzDJhyiIb7CFZJ`). Build the same for a client:

| Page | Type | Configuration |
|---|---|---|
| Overview | dashboard | One section per figure, each with its own record filter. **Numbers:** New leads (count, Stage is New Lead); To invoice (count, Completed and Not Invoiced); Owed (sum of Invoice Amount, Invoice Status Invoiced); Paid (sum, Invoice Status Paid); Logged messages. **Grids:** New leads, Latest messages. |
| Pipeline | Kanban on Lite Jobs | Stacked by Stage, with a count per stack. Cards: Job Ref, Contact, Service, Last Activity At, Invoice Amount. Newest activity first. |
| Jobs | grid on Lite Jobs | The nine job views above as tabs, except Pipeline. Row colour by Stage; sum of Invoice Amount. |
| Message Log | grid | Grouped by Workflow, newest first. Columns include Purpose, Status, Error Code, Provider Message ID, Retry Requested (editable). Tabs: **Needs attention** (Status Failed or Unknown), Problems (Failed or Skipped), Replies and opt-outs. |
| Contacts | grid | Columns include Consent SMS, Review Opt-In, Marketing Opt-In, Consent Source, Consent Recorded At, Opted Out. Tabs: Do not contact, Marketing list (Marketing Opt-In, a Consent Recorded At, not Opted Out), **Consent not recorded** (a box ticked but no Consent Recorded At). |
| Quotes | grid | Sum of Amount, newest first. |
| **Alerts** | grid on Lite Alerts | Open first, newest first; Status editable (Open / Resolved). Tabs: Open, Delivery, Leads and jobs, Workflow failures. Add an **Open alerts** number to the Overview. |

A **Record review** page on Lite Jobs, for working through new leads, is a useful extra.

## Rules that keep the automations safe

- **Keep the names.** The table and field names in `schema.json` are what the workflows read and write. Rename one and
  the workflow stops with a clear Airtable error; it never writes to the wrong place.
- **Keep the back-link "Lite Jobs"** on Lite Contacts. Airtable creates it as the other side of Lite Jobs › Contact.
  The reply and duplicate checks use it.
- **Leave Opted Out ticked.** Once someone opts out, never untick it unless they ask to be contacted again; every Lite
  message checks it.
- **Consent is three separate boxes.** Consent SMS and Consent Email cover service messages (acknowledgements and
  review requests). Marketing Opt-In is also required for reactivation.
