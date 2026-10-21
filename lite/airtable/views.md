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
| → Job In Progress, → Completed | Staff. Moving the card to Completed is enough: the next Monitor or review run records **Completed At**, and the review request follows. Set the date yourself only if the work finished on another day. |
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

The demo base has the published Interface **"Lite Quote-to-Paid"** (`pbdAzDJhyiIb7CFZJ`), rebuilt on 2026-10-21 around
what an employee does. A first-time owner can follow it in five minutes. The staff guide is
[../docs/employee-guide.md](../docs/employee-guide.md).

**Build order.** The API cannot reorder or edit pages, and a new page goes to the end of the menu. So:
1. Add the three display fields below.
2. Create the two detail pages (Job, Customer).
3. Create the five menu pages in menu order. Pipeline comes first, which makes it the home page.
4. Publish.

**Three read-only display fields on Lite Jobs.** These are Interface helpers. The workflows never read or write them,
and `setup.ts --verify` ignores them:

| Field | Type | Definition |
|---|---|---|
| Quote Amount | rollup | Lite Quotes › Amount, `MAX(values)` |
| Amount | formula | "Paid $1,980" / "Invoiced $1,980" once there is an Invoice Amount, otherwise "Quote $6,400" (thousands separator built in the formula) |
| Job Name | formula | `IF({Contact}, {Contact} & ' – ' & {Service}, {Service})`, e.g. "Linda Thompson – Gutter replacement" |

**Hiding test data.** Every employee page is scoped to **Demo Data is not checked**. So install tests and synthetic
records (all ticked Demo Data) never appear to staff. They are listed on the Admin page instead.

**Menu (in this order):**

| Page | Type | Configuration |
|---|---|---|
| **Pipeline** (home) | kanban on Lite Jobs | Stacked by Stage, which follows the field's option order: New Lead → Contacted → Quoted → Accepted → Job In Progress → Completed → Invoiced → Paid. **Scope:** not Demo Data, and Stage is not Lost (Lost jobs leave the board; they are listed on Business overview). **Cards:** Contact, Service, Amount, Last Activity At. No Job Ref. Newest activity first, count per stack. A click opens **Job**. |
| **Business overview** | dashboard | One section per figure, each with its own scope (not Demo Data). **Numbers:** New enquiries to call (with a grid that opens Job); Quotes waiting for a yes; Jobs booked or in progress; Finished, not invoiced yet; Awaiting payment ($); Paid ($). The money figures say "CRM tracking only: the real invoices live in Xero". **Grids:** Latest customer replies; Lost enquiries (opens Job). |
| **Customers** | grid on Lite Contacts | Name, Phone, Email, Suburb, the four permission boxes, Opted Out. Tabs: **Do not contact**; **Permission not recorded** (a box ticked but no Consent Recorded At). A click opens **Customer**. |
| **Messages** | grid on Lite Message Log | When, Customer, Type (Workflow), Channel, Status, Message, Reason, Retry Requested. Newest first. Tabs: **Replies from customers** (Received, Opt-Out); **Problems to fix** (Failed, Unknown). |
| **Admin (owner)** | dashboard | Open alerts (with count), failed or unconfirmed messages (Retry Requested), and test and demo records (Demo Data ticked; delete before go-live). |

**Job** (record detail, sidesheet, editable). The title is Job Name. Its sections are numbered as the steps of a job:
1. **Stage:** Stage, Service, Amount, Enquiry Message.
2. **Customer:** the Contact link as an embedded grid: Name, Phone, Email, Suburb, Opted Out.
3. **Quotation:** the Lite Quotes link as an embedded grid (+ adds a quote): Quote Ref, Amount, Status, Sent At,
   Accepted At.
4. **Invoice and payment: CRM tracking only (not Xero):** Invoice Status, Invoice Amount, Completed At. The
   description says the real invoice is made in Xero, and that Completed At fills itself in.
5. **Customer messages (written by Lite):** the Message Log link as an embedded grid, marked read only.

The automation fields (Review…, Reactivation…, Lead Received At, Last Activity At) are not on this page. A detail page
is all-editable or all-read-only, so leaving them off is the only way to keep staff from seeing them as inputs.

**Customer** (record detail, sidesheet, **read-only**). The title is Name. Sections:
1. **Contact details:** Phone, Email, Suburb, Notes.
2. **Jobs:** an embedded grid that opens Job.
3. **Permission to message:** the four boxes, Opted Out, Consent Source, Recorded At, Wording.
4. **Messages.**

**Three things only the Interface editor can do (2 minutes):**
1. Rename the interface after the business.
2. On the Messages page, make every column read-only except Retry Requested.
3. Check that kanban cards lead with the customer's name. If Airtable shows Job Ref as the card title, set the title
   to Job Name in the card settings.

## Rules that keep the automations safe

- **Keep the names.** The table and field names in `schema.json` are what the workflows read and write. Rename one and
  the workflow stops with a clear Airtable error; it never writes to the wrong place.
- **Keep the back-link "Lite Jobs"** on Lite Contacts. Airtable creates it as the other side of Lite Jobs › Contact.
  The reply and duplicate checks use it.
- **Leave Opted Out ticked.** Once someone opts out, never untick it unless they ask to be contacted again; every Lite
  message checks it.
- **Consent is three separate boxes.** Consent SMS and Consent Email cover service messages (acknowledgements and
  review requests). Marketing Opt-In is also required for reactivation.
