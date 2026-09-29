# Airtable editability audit

Every editable Airtable field in base `appMc8V0Wm29tEeHQ`, classified before and after Phase 6. "Before" is what the live
system did on 29 Sep 2026 before this phase; "After" is what it does now, with evidence. Airtable (Free plan) can't
lock individual fields. So a field that must not be edited is **enforced as read-only by RoofOps**: the edit is reverted and the
RoofOps Sync field explains why. The field description in the contract says so.

Legend: **SUPPORTED** = captured, validated, applied through one path, read back. **READ ONLY** = owned by RoofOps or an
external system; Airtable edits are reverted (webhook) or repaired (reconciliation). **BROKEN** = edit silently lost or
applied without validation. **NOT IMPLEMENTED** = no path exists; stated explicitly.

## Projects (`tblvUPIoebC3zoacv`)

| Field | Before | After | Evidence |
|---|---|---|---|
| Status | **BROKEN** (no webhook; PRJ-2026-0001 Cancelled never reached RoofOps) | SUPPORTED: legal transitions applied (state machine + guards), illegal ones refused and Airtable put back | live: PRJ-0009 Planning→Scheduled applied, PRJ-0010 Materials Pending→Completed refused + corrected, PRJ-0009 →On Hold with reason during n8n outage recovered; PRJ-0001 repaired by reconciliation; 56-pair generated test |
| Status Reason (new) | n/a | SUPPORTED as input (becomes on-hold / cancellation reason) | live: "Waiting on council permit" stored as `on_hold_reason` |
| Planned Start / Planned Completion | **BROKEN** | SUPPORTED: date order checked, locked once Completed/Closed/Cancelled | live: PRJ-0013 finish 10-12 → 10-14 applied; tests: start after finish refused, completed job locked |
| Project Manager (text) | **BROKEN** | SUPPORTED: must match an active PROJECT_MANAGER by name | tests: Sophie Carter applied, Chloe Mason (estimator) refused with the list of valid names |
| Actual Start / Actual Completion | **BROKEN** | READ ONLY: set by Status → In Progress / Completed; edits reverted | test: PRJ-0016 Actual Start edit reverted |
| Invoice Action | SUPPORTED (Phase 3, n8n 04) | SUPPORTED (unchanged) | Phase 3 evidence |
| Invoice Status / Preview / Amount / Xero Invoice Number / Xero Invoice ID | projection by 04; drift undetected | READ ONLY: projection; reconciliation refreshes it when canonical invoice state is stable | contract `PROJECTION` rows |
| Drive Folder | written by 03; drift undetected | READ ONLY: must equal the verified folder URL; repaired | reconciliation compares every project |
| Project Number, Quote, Customer, RoofOps ID | drift undetected | READ ONLY: reverted / repaired | contract `REPAIR_AIRTABLE` |
| Material Review Task | written by 03 | READ ONLY (informational; not compared) | contract `IGNORE` |
| Purchase Orders (inverse link) | — | not compared (Airtable-maintained) | |
| RoofOps Sync (new) | n/a | written by RoofOps only | |

## Quotes (`tblzenPRNVV5O7lZP`)

| Field | Before | After | Evidence |
|---|---|---|---|
| Status → Accepted | SUPPORTED (n8n 01) | SUPPORTED (unchanged; 06 defers acceptance to 01) | test: Sent→Accepted = DEFERRED, no correction |
| Status → Sent / Lost / Expired | **BROKEN** (01 skipped non-Accepted changes silently) | SUPPORTED | live: Q-0033 Draft→Sent applied; tests: Lost with reason, Lost→Sent refused, Draft→Accepted refused |
| Lost Reason | **BROKEN** | SUPPORTED (required while Lost) | test |
| Accepted On | written by nobody after acceptance (real gap: Q-0041/0044/0048 blank) | READ ONLY: projection; **repaired live** by reconciliation | findings in RECON-20260929-121410 |
| Number, Customer, Property, Version, Amount, Job/Roof Type, Area, Estimator, Lead Source, Created/Sent On, RoofOps ID | drift undetected | READ ONLY | contract |
| Automation Status / Message | written by 01 | READ ONLY (not compared) | |

## Purchase Orders (`tbluIbl4zpMiAlMVw`)

| Field | Before | After | Evidence |
|---|---|---|---|
| Status | **BROKEN** | SUPPORTED: forward-only machine; Approved needs a mapped approver for RoofOps-origin POs; timestamps set | live: PO-2026-0011 Sent→Acknowledged applied (PRJ-0011 materials → Confirmed on the dashboard); tests: Delivered→Approved refused, Acknowledged→Sent refused, approval needs approver |
| Expected Delivery | **BROKEN** | SUPPORTED: on/after PO date; locked once Delivered/Cancelled | test |
| Supplier Reference | **BROKEN** | SUPPORTED | test |
| PO Number, Project, Supplier, PO Date, Subtotal, RoofOps ID | drift undetected | READ ONLY | contract |

## Customers, Properties, Suppliers

| Fields | Before | After | Evidence |
|---|---|---|---|
| All data fields (name, email, phone, type, address, lead time …) | **BROKEN** (edits silently diverged from RoofOps and Xero contacts) | READ ONLY: reverted with a note; managed in RoofOps (**editing customer details from Airtable: NOT IMPLEMENTED**, by decision: the customer record feeds Xero contacts and needs duplicate checks) | live: CUST-0002 name edit reverted and read back |
| Inverse links | — | not compared | |

## Record-level operations

| Operation | Status |
|---|---|
| Creating a record directly in Airtable (any table) | NOT IMPLEMENTED by design; reconciliation reports it as `UNKNOWN` and opens an exception (RoofOps creates records; quotes come from the quoting process) |
| Deleting a record in Airtable | NOT IMPLEMENTED; reconciliation reports `EXTERNAL_MISSING` and opens an exception; RoofOps data is untouched |
