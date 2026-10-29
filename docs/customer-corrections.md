# Correcting customer mistakes without corrupting history

RoofOps never re-points an enquiry, quote, project or invoice to a different customer: those records are the history of
what was agreed and billed. Correct mistakes forward instead.

| Mistake | Where it is | Supported correction |
|---|---|---|
| Typo in a customer's phone or email | Any time | Dashboard → Sales → the enquiry → Customer and site → *Correct phone or email* (admin, operations or project manager; a reason is required and audited). Invoices already made keep the old details; Airtable shows the new ones after the next reconciliation; update the Xero contact by hand. |
| Typo in a customer's name | Any time | Not editable in RoofOps (the name is in Xero contact names and Drive folder names). Record the correct spelling in the enquiry notes and ask the owner; a data correction is a supervised owner task. |
| Wrong existing customer picked, no quote yet | Enquiry contacted / inspection booked | Close the enquiry as *Not a job* (reason "recorded against the wrong customer"), record a new enquiry and pick the right customer. |
| Wrong customer, quote drafted but not sent | Draft quote | As above; the draft is never sent and stays as history. |
| Wrong customer, quote sent | Quote in Airtable | In Airtable set the quote's Status to *Lost* with Lost Reason "wrong customer" (the enquiry closes as Lost), then record a new enquiry. |
| Wrong customer, quote accepted (project exists) | Before invoicing | In Airtable set the project's Status to *Cancelled* with the reason, then quote again for the right customer. Never after a final invoice: void the invoice first (Finance), then cancel. |
| Two customer records for one person | Any time | Not merged by RoofOps; look-alike pairs are listed for review (`customer_match_candidates`). |
