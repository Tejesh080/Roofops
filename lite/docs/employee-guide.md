# Staff guide: managing a job in the CRM

Everything happens in one Airtable Interface. Open it and you land on the **Pipeline**.

## The five pages (left-hand menu)

| Page | What it is for |
|---|---|
| **Pipeline** | Every open job, as a card in its stage. Your home page. |
| **Business overview** | The numbers: new enquiries to call, quotes waiting, jobs on, money owed and paid. It also lists the latest customer replies and lost enquiries. |
| **Customers** | Everyone who has contacted the business: phone, email, and what they agreed to receive. |
| **Messages** | Every text and email the system sent, and every reply. |
| **Admin (owner)** | For the owner: alerts, failed messages, and test records. |

## Reading the Pipeline

The columns run left to right in the order a job moves:

**New Lead → Contacted → Quoted → Accepted → Job In Progress → Completed → Invoiced → Paid**

| A card shows | What it means |
|---|---|
| Customer name | Who the job is for. |
| Service | What they need. |
| Amount | "Quote $6,400" while quoting; "Invoiced $1,980" and "Paid $1,980" once invoiced. |
| Last activity | When something last happened, such as an enquiry, a message or a reply. |

Lost jobs leave the board. You'll find them under **Lost enquiries** on Business overview.

## One roofing job, start to finish

1. **A new enquiry arrives.** Someone fills in the website form.
   - Their card appears by itself.
   - If they ticked "contact me by SMS", the system has already texted them to say thanks, and the card sits in
     **Contacted**.
   - If they ticked nothing, the card stays in **New Lead**. Nobody has been in touch, so call them.
2. **Open the job.** Click the card. The **Job** panel opens on the right:
   - the job's stage and what they need;
   - the customer's name, phone and email, so you can call them now;
   - the quotation;
   - invoice and payment tracking;
   - the messages.
3. **Quote.** After the site visit, go to **2. Quotation** and click **+**. Enter the quote number, the amount and
   Status **Sent**. Then drag the card to **Quoted**, or change **Stage** at the top of the panel. The card now shows
   "Quote $…".
4. **The customer says yes.** In **Quotation**, set Status to **Accepted**. Move the job to **Accepted**, then to
   **Job In Progress** when work starts.
5. **The work is finished.** Move the job to **Completed**. That's all.
   - The system records the completion date.
   - Two days later, it texts the customer a Google review link, but only if they agreed to review requests.
6. **Invoice in Xero, not here.** Create and send the invoice in Xero (or your accounting software).
   - Then, in **3. Invoice and payment**, set Invoice Status **Invoiced** and type the amount. Move the card to
     **Invoiced**.
   - When the money arrives, set Invoice Status **Paid** and move the card to **Paid**.
   - This section only tracks the job: the system never creates or sends invoices.
7. **Reading replies.** Section **4. Customer messages** shows what the customer was sent and what they replied. The
   **Messages** page, tab **Replies from customers**, shows every reply from everyone.
8. **If the job doesn't go ahead,** set Stage to **Lost**.

## What the system does by itself

| When | It does this |
|---|---|
| A website enquiry arrives | Creates the customer and the job, records what they agreed to receive, and texts or emails a thank-you, if they agreed. |
| A job reaches Completed | Records the date. After 2 days it sends one review request, only to customers who agreed. |
| An old quote goes quiet for 90 days | Sends one friendly follow-up, only to customers who agreed to offers. |
| A customer replies | Logs the reply on their job and moves the job to the top of its column. |
| A customer replies **STOP** | Marks them **Opted Out**. Nobody is ever messaged again. |
| Something fails | Raises an alert on the Admin page. |

## What the system never does

- It never creates invoices or touches Xero. Invoice Status and Amount are notes for the team.
- It never messages anyone who didn't agree, or who replied STOP.
- It never re-subscribes anyone. A number that replied STOP stays blocked. If a customer asks to hear from you again,
  the owner contacts them directly.

## The Customers page

- Click a name to see the customer's details, jobs, messages and permissions. This page is view only.
- **Do not contact** lists everyone who opted out. Never message them.
- **Permission not recorded** lists customers with a ticked box but no record of when or how they agreed. The
  system won't send them review requests or offers until the owner records it.

## Words you'll see

| Term | Meaning |
|---|---|
| Simulated Sent | Test mode: the message was not really sent. |
| Sent, Delivered | A real text, sent or delivered. |
| Skipped | Not sent on purpose. The Reason column says why, for example "no consent". |
| Unknown | Nobody knows whether it arrived. The system never sends it again by itself; the owner checks first. |
| Received | A reply from the customer. |
| Opt-Out | The customer replied STOP. |
