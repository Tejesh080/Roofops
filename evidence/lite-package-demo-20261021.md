# RoofOps Lite: the complete package, demonstrated end to end (2026-10-21)

**What ran for real, and what was simulated:**
- **Real:** the cloud Airtable base, the cloud n8n workflows, and the real website form in a browser.
- **Simulated:** every outgoing message. It ran in test-sink mode and is logged **Simulated Sent**; nothing reached a
  phone or inbox. No live SMS was sent.
- **Customers:** both are synthetic (`ZZ Demo …`, ACMA fictional numbers, `example.test` email addresses).
- **Published:** Lead Follow-Up only, for about 2 minutes, with your approval. Everything is unpublished again.

## What an employee clicks, and what happens automatically

| # | Who | Action | What happens automatically | Evidence |
|---|---|---|---|---|
| 1 | Customer | Fills in the enquiry form on the website and clicks **Send enquiry**. The form says "Thanks, we have your enquiry". | — | Browser: the real `lead-form.html` posting to n8n (cross-origin works) |
| 2 | — | — | **Lead Follow-Up** creates the Contact (with the consent ticked, its source, time and wording), the Property and the Job (New Lead). The lead appears on the **Pipeline**. | Runs 3242 (Hannah), 3248 (Peter), both production webhook runs |
| 3 | — | — | The SMS acknowledgement is permitted (SMS consent given). It is sent (Simulated Sent) and logged; the job moves to **Contacted**. | Message Log: `LM-…TPPO`, `LM-…96A2` |
| 4 | Staff | **Pipeline:** clicks Hannah's card. The **Job** page opens: customer name, phone, email and consent; the enquiry; quotes; messages. | — | Interface: Pipeline `pagLDm2qi1CrHjfZD` opens Job detail `pagwUYRZgQB8QSSp5` |
| 5 | Staff | **Quotes** section: adds the quote ($1,850, Sent), and drags the card to **Quoted**. Later sets the quote to Accepted, and drags to **Accepted**, then **Job In Progress**, then **Completed**. | — | Quote `LQ-DEMO-HANNAH` |
| 6 | Staff | **Finishing and invoicing:** Invoice Status Invoiced, $1,850; after payment, Paid. Leaves **Completed At** empty, as staff do. | The next Monitor (every 2 h) or review run records Completed At. | Review run 3260: `completed_at_recorded: 1` |
| 7 | — | (Time skip for the demo: Completed At set 3 days back, past the 2-day delay.) | **Review Requests** (daily 10:00) finds the finished job and the recorded review consent from the form. It sends one review request with the Google link and STOP (Simulated Sent); the job shows Review Status **Sent**. | Run 3263: `sent: 1`; `RV-…OV0T` |
| 8 | — | (Time skip: Peter's enquiry, consent and quote moved 120 days back; his job is Quoted and quiet.) | **Lead Reactivation** (Mondays 09:00) finds the quiet lead with marketing consent recorded by the form. It sends one follow-up (Simulated Sent); Reactivation Count 1. Of 15 open leads, 6 were excluded (consent, cooldown, opt-out). | Run 3270: `sent: 1`; `RA-…N1DP` |
| 9 | Customer | Peter replies "Yes, still keen. Can you call me this week?" (a simulated SMS reply). | **Inbound Replies** logs it as Received on Peter's job. The job's Last Activity updates, so his card jumps to the top of the Quoted column. Nothing is sent back. | Run 3274; `IN-…ZSKR` |
| 10 | Customer | Hannah replies "Thanks, the leak is fixed." | Logged on her **finished** job, which stays Paid. | Run 3277; `IN-…H1WK` ("reply recorded on the finished job (not reopened)") |
| 11 | Staff | **Overview / Alerts:** sees counts and open alerts; resolves them. | **Monitor** (every 2 h) raises failed or unconfirmed messages and stuck leads once each. | Run 3284 |

Messages for steps 9 and 10 were fed to the unpublished reply workflow by manual runs, in the test-sink JSON shape.
The real Twilio path was tested separately (`evidence/lite-twilio-starter-20261021.md`).

## Missing connections found, and fixed

1. **A job dragged to Completed never got its review request.**
   - **Cause:** the review request needed staff to also fill in Completed At, and the Pipeline doesn't show that field.
     Monitor then raised a false "the review request will never go out" alert.
   - **Fix:** Review Requests and Monitor now record Completed At themselves. One drag is enough.
   - **Tested:** both tests failed before the fix and pass after it; the cloud review run 3260 recorded the date.
2. **Staff couldn't open a job.**
   - **Cause:** the Pipeline had no detail page, so a card showed only the customer's name: no phone, no quotes, no
     messages.
   - **Fix:** a **Job** detail page with Job, Customer (phone and consent), Quotes (add or link), Finishing and
     invoicing, Messages, and "Set by the automations". The Pipeline was rebuilt to open it and republished.
3. **A reply about a finished job wasn't linked to any job.**
   - **Fix:** it is now logged on the customer's latest job, without reopening it.
   - **Tested:** the test failed before the fix and passes after; cloud run 3277.

**Docs updated:** views.md (the Job page), DEPLOY step 9 and both checklists. One more note added: an imported old
job needs Completed At or Review Status Skipped, or Lite treats it as finished today.

## Not changed (by design, or outside the API)

- **Quotes and stage are two actions.** Staff add the quote, then drag the card. No automation links them.
- **The Job page is fully editable.** An Airtable detail page is all-editable or all-read-only, so the automation
  fields sit in a labelled "leave these as they are" section.
- **Page order:** the new Pipeline appears last in the Interface menu, and the API cannot reorder pages. Drag it to the
  top in the Interface editor (10 seconds).
- **Visual check:** I verified the Interface through Airtable's page API: the cards, the detail page and field
  editability. I have not seen it rendered, because that needs your Airtable login. Open **Pipeline › click a card**
  once to check that the Customer, Quotes and Messages sections display.
- **"Hi ZZ"** in the demo messages comes from the `ZZ Demo` test names. A real "Hannah Reid" gets "Hi Hannah".

## A second fictional business

**Yes: no workflow code changes are needed.**
- **The build:** `lite/config/example-plumbing-twilio.json` ("ZZ Example Plumbing", Sydney time, its own base, tables,
  Twilio account and paths) builds the five workflows and the form from the same source.
- **No client text in the code:** the workflow and form sources contain no client wording.
- **Its own run:** the local run for that business passes all 16 steps, against the schema-enforcing Airtable and a
  fake Twilio:
  - lead, duplicate, invalid lead, no consent;
  - review requests, twice;
  - reactivation, twice;
  - YES, STOP;
  - a delivery receipt;
  - a refused number, a Monitor alert, a retry.

  Report: `lite/demo/output-twilio/demo-report.md`. Its workflows mention "Plumbing" and never the demo client (test H).
- **Per client:**
  - one config file;
  - `setup.ts` for the tables;
  - the Interface built from views.md (about 10 minutes with the connector);
  - n8n credentials;
  - a Twilio number.

## State after the demo

- **Workflows:** all five are unpublished and in test-sink mode, identical to `lite/dist/demo`.
- **Demo records:** Hannah's and Peter's records are ticked Demo Data, ready for clean-up.
- **The live SMS test:** your number stays only in `.env.local` and the git-ignored live config. The n8n data-table row
  is cleared. The test is ready to re-stage when you approve it.
