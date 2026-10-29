# Manual acceptance script (dashboard and Airtable only)

For a tester who has never seen the code. Everything is done in the protected RoofOps dashboard and the Airtable base.
No SQL, terminal or AI help. Record every step: **Pass / Fail**, what you saw, and a screenshot for each **[shot]**.
If anything differs from "Expect", stop that section, note it, and continue with the next section.

## Before the tester starts (owner prepares, not the tester)

- The release steps 0, A–C of `ops/ops-sales-release-plan.md` are done (Airtable options added, migrations applied,
  protected Preview deployed with Xero dispatch off, n8n 10 created).
- **The business date override is cleared** (otherwise every date shows 29 Sep 2026). Write today's date here: ______
- Tester logins exist, one per role: Estimator, Project Manager, Field Crew, Finance, Admin (synthetic names, e.g.
  "Test Estimator"). The tester receives the Preview link and the passwords privately.
- n8n 10 is either active for the test window or the owner is on hand to run it once when asked (step S7).
- The tester has edit access to the Airtable base.
- Use only names starting with **"UAT "** so test records are easy to find and remove.

## Section L: signing in and roles

| # | Do | Expect |
|---|---|---|
| L1 | Open the Preview link | The Vercel protection page or sign-in page; no RoofOps data before signing in |
| L2 | Sign in as Estimator with a wrong password | A generic "did not match" message (it does not say whether the login exists) |
| L3 | Sign in as Estimator correctly **[shot]** | Your name and role in the top-right menu; "Sales" and "My work" in the sidebar |
| L4 | Sign out, press the browser Back button | You are sent to sign-in; no page content |

## Section S: an enquiry becomes a quote (as Estimator)

| # | Do | Expect |
|---|---|---|
| S1 | Sales → Record an enquiry: name "UAT Olive Tester", source Phone call, phone 0400 111 222, address "1 UAT Street, Bundaberg", need "Leak over kitchen". Record | The enquiry appears under "New enquiries"; its page shows "Next step: Record the customer and the site" |
| S2 | Press Record again on a fresh form with exactly the same details | **Record what happens.** Known gap: duplicates are only flagged against existing *customers*, so a second identical enquiry is created without a warning. Close the duplicate as "Not a job" (reason "UAT duplicate") |
| S3 | Open the enquiry. In "Customer and site" choose New customer, Residential, same phone; site "1 UAT Street", suburb Bundaberg, QLD, 4670, House. Save | Customer and site numbers appear (CUST-…, PROP-…); the suburb is written in normal capitals |
| S4 | Book the inspection for tomorrow 9:00 with yourself as inspector | "Inspection … booked"; trying to book a time yesterday is refused with a plain message |
| S5 | Record the inspection: Concrete tile, 120 m², tape measure, pitch 22°, findings "UAT cracked tiles" | Shows Done with those details |
| S6 | Prepare the quote: Labour "Replace tiles" 10 hrs × 95; Material (pick a product) 2 × 50; prices include GST. Check the live totals **[shot]**, then save | Total $1,050.00, GST $95.45, ex GST $954.55 (check with a calculator: GST = total ÷ 11). Then revise one price and save: "version 2" |
| S7 | Tick the confirmation and Send. (Owner: run n8n 10 once now if it is not active.) Reload after a minute **[shot]** | Quote "Sent", valid until today + 30 days; "Airtable: added". If it says "retrying" or "stopped", record the message |
| S8 | In Airtable, open Quotes and find the quote number **[shot]** | Exactly one row: Status Sent, amount equal to the dashboard's total, linked to customer "UAT Olive Tester" and the property; Customers and Properties each have exactly one UAT row |
| S9 | In Airtable, change the UAT customer's Name to "UAT Wrong Name". Wait up to 2 minutes, refresh | It changes back, with a "RoofOps Sync" note saying the name is managed by RoofOps |

## Section A: acceptance creates the project (Airtable)

| # | Do | Expect |
|---|---|---|
| A1 | In Airtable, set the UAT quote's Status to **Accepted**. Wait up to 5 minutes | The quote's Automation Status/Message says the project was created |
| A2 | Airtable → Projects: find the new project for "UAT Olive Tester" **[shot]** | One new project, Status Planning, linked to the quote, with a Drive Folder link |
| A3 | Click the Drive Folder link | A Google Drive folder named after the project, with subfolders 01 Quote … 05 Completion |
| A4 | Dashboard → Sales → the UAT enquiry | Badge "Won", "Open project PRJ-…" button; the project page opens |
| A5 | Set the same quote to Accepted again (change to Sent, then Accepted) in Airtable | No second project appears; the quote shows it was already processed (or the change is refused/reverted) |

## Section F: field work (Project Manager, then Field Crew)

| # | Do | Expect |
|---|---|---|
| F1 | Sign in as Project Manager. Open the UAT project → Book a site visit for tomorrow 07:00–12:00 with the Field Crew tester | Visit listed as Scheduled with the crew name |
| F2 | Book a second overlapping visit for the same crew member | Refused: the person is already booked |
| F3 | Add a task "UAT check gutters" for the Field Crew tester, due tomorrow. Double-click the Add button | Exactly one task appears |
| F4 | Sign in as Field Crew on a phone **[shot]** → My work | The visit and the task; no Sales forms, no invoice actions |
| F5 | Start the visit, then Complete it with a note; start and finish the task | Statuses change; the project page shows the note |
| F6 | Look at the project's Status in Airtable | **Record what it says.** (Known gap: completing a visit does not change the project status; the PM must change it in Airtable) |

## Section I: invoice approval (Finance + Admin; Xero dispatch stays OFF)

| # | Do | Expect |
|---|---|---|
| I1 | In Airtable set the UAT project Status step by step: Scheduled, then In Progress, then Completed; then Completion Photos and Compliance Certificate to Waived with the note "UAT" | Each change stays (no revert note). Jumping straight from Planning to Completed should be reverted with a reason; record it if you try |
| I2 | Sign in as Finance → Finance page → Prepare the UAT project's final invoice **[shot]** | A preview with the amount (= accepted quote total) and GST |
| I3 | As Finance, try to approve it | Not possible (the preparer cannot approve) |
| I4 | Sign in as Admin, approve it with the confirmation ticked | Approved by Admin, requested by Finance; **no "Send to Xero" button** (dispatch is off) |
| I5 | As Estimator or Field Crew, open the Finance page | No prepare/approve controls |

## Section C: clean-up and close

- Note every UAT number (enquiry, customer, property, quote, project, visit, task, invoice). The owner removes or
  cancels them; the tester does not delete anything.
- Summary: sections passed, failed (with step numbers), and anything confusing for staff even if it "passed".
