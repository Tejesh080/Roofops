# Evidence: RoofOps Lite v2, cloud batch A (Airtable additions), 2026-10-21

You approved batches A and B of `lite/demo/cloud-v2-plan.md` in chat on 2026-10-21. Batch A was carried out on base
`appMc8V0Wm29tEeHQ` through the Airtable connector. Every change was an addition. All record and field IDs are in
`lite/demo/cloud-resources.demo.json` (`v2BatchA`).

## Before

- **Lite tables:** the same as v1. Lite Contacts had 18 fields (including 3 back-links). Lite Message Log had 13 fields,
  and its Status field 5 options (Simulated Sent, Skipped, Failed, Received, Opt-Out).
- **Lite Contacts records:** 14, all `ZZ Lite Demo …` with Demo Data ticked.
- **Your form test:** a real enquiry you submitted from `lead-form.html` on 2026-10-21 created nothing. The Lead
  Follow-Up workflow is unpublished, so the form's production webhook does not exist, and the form showed its
  "did not go through" message. Lite Contacts held only the 14 synthetic contacts.

## Changes

| Table | Added |
|---|---|
| Lite Contacts `tble7dgq0tl1vvoWs` | Review Opt-In, Consent Source, Consent Recorded At, Consent Wording |
| Lite Message Log `tblW8Uq5j5dW0B8RH` | Purpose (Operational / Review / Marketing / Inbound), Provider Message ID, Error Code, Attempts, Retry Requested, Retry Of, On Success |
| Lite Message Log, Status | The options Sending, Sent, Delivered and Unknown. Airtable's API cannot add choices to an existing select, but a write with typecast can. One setup row was written for it (`recq2MOD3R6DztbKb`, `ZZ-SETUP-STATUS-OPTIONS`, Demo Data ticked) and left as Skipped; it is safe to delete. |
| **new** Lite Alerts `tblG3Q5k9fe90Mpsi` | 10 fields as in `lite/airtable/schema.json` |
| v2 test people | 3 contacts, 3 properties and 3 jobs, all `ZZ Lite Demo v2 …` (below) |
| Interface `pbdAzDJhyiIb7CFZJ` | Pages Alerts, Needs Attention, Consent and Health; republished |

The v2 test people:
- **Hannah Reid:** a finished job, with Review Opt-In and a recorded source and date.
- **Oscar Lane:** a quiet quote, with Marketing Opt-In and a recorded source and date.
- **Ruby Stone:** a quiet quote, with Marketing Opt-In ticked but no record (as if imported).

None of the 14 existing contacts was given consent evidence. Under v2 they get no review request or marketing until
someone records real consent for them.

## After (independent schema read)

| Table | Fields | Notes |
|---|---|---|
| Lite Contacts | 22 | |
| Lite Message Log | 20 | Status has 9 options |
| Lite Alerts | 10 | |

`lite/airtable/schema.json` matches. The six Advanced RoofOps tables are unchanged: the same field IDs, with 13, 8, 12,
20, 29 and 10 fields.

## Not done (batch B)

The n8n connector dropped out of the working session before batch B, so no n8n workflow was created or changed. The
four v1 Lite workflows are as they were: unpublished, ids in `cloud-resources.demo.json`.
