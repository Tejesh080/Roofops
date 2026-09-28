# Source data audit (Phase 0): `RoofOps_Master_Synthetic_Operations.csv`

> **Superseded in Phase 1.** The canonical per-table bundle replaced this flat file, and dates were normalised under the rules in [data-import.md](data-import.md). The recommendation below to regenerate data was **not** adopted: IDs, names, amounts and scenarios come from the bundle unchanged.

Audited: 2026-09-29 with `scripts/phase0-csv-audit.mjs` (reference date 2026-09-29).
File: `data/source/RoofOps_Master_Synthetic_Operations.csv`, 65 rows × 60 columns, one row per quote, denormalised.

## What's good

- **Counts match the brief:** 40 customers, 52 properties, 65 quotes, 30 projects, 6 suppliers, 38 invoices (Σ `invoice_count`).
- **All ten named scenarios are tagged:** 3 × `DELAYED_PROJECT`, 2 × `SUPPLIER_ACK_PENDING`, 1 × `MISSING_COMPLIANCE_PHOTOS`, 1 × `ACCEPTED_QUOTE_PROJECT_CREATION_FAILED`, 2 × `OVERDUE_INVOICE` (both really are overdue as of 2026-09-29), 1 × `DUPLICATE_CUSTOMER_CANDIDATE` (CUST-0040 shares a phone number with CUST-0008), 1 × `SUPPLIER_DELIVERY_DELAY`, 1 × `MISSING_INSPECTION_MEASUREMENT`, 1 × `JOB_BEFORE_MATERIALS`, 1 × `UNRESOLVED_AUTOMATION_EXCEPTION`.
- Emails use `example.com`; supplier names carry a "Demo" suffix; every row is flagged `synthetic_demo_data=YES`.

## Problems (would show up on stage)

### P1: 21 of 22 active projects are silently overdue ⚠ blocks the demo script

Every non-completed project except PRJ-2026-0024 has `planned_completion_date` before 2026-09-29, yet 18 of them are `schedule_risk = Low`. Once risk is derived from facts (as it must be), the copilot's answer to *"Which projects are at risk next week?"* would list about 21 projects, and none of them would be "next week". The CSV dates look like they were written relative to an earlier "today" (roughly June–August 2026).

### P2: Temporal impossibilities

| Row | Issue |
|---|---|
| OPS-0011 | invoice paid 2026-06-19, *before* the quote was accepted (2026-07-22) |
| OPS-0024 | invoice paid 2026-07-08, *before* the quote was accepted (2026-09-15) |
| OPS-0003 | invoice paid 2026-09-30, a date in the future |

### P3: Completed projects whose materials were never confirmed

OPS-0001, 0002, 0004, 0005, 0006 and 0008 are `Completed`, but their PO is still `Sent`/`Approved` and unacknowledged, with supplier ETAs *after* the completion date. PO status looks randomly assigned.

### P4: Invoiced more than the accepted quote, with no variation record

| Row | Accepted quote | Total invoiced | Over by |
|---|---|---|---|
| OPS-0006 | 25,740.60 | 30,888.72 | +20% |
| OPS-0008 | 49,739.70 | 59,687.64 | +20% |

This is useful for Module 5 as a *deliberate* scenario ("invoice exceeds contract + approved variations → blocked"), but only if we seed it on purpose, with or without a matching variation.

### P5: `last_event_type` contradicts state

It looks randomly drawn. Examples: OPS-0009 is `Planning` with last event `job.completed`; OPS-0025's invoice is unpaid with last event `invoice.paid`; OPS-0012's PO is `Draft` with last event `po.approved`; OPS-0026 is `Materials Pending` with last event `lead.created`. **This column should not be imported.** Events must be generated *from* the state history.

### P6: Scenario flags without matching data

- OPS-0016 is tagged `UNRESOLVED_AUTOMATION_EXCEPTION`, but `open_exception_count = 0`, `latest_exception_class` is blank and `automation_health = Healthy`.
- OPS-0031 (project creation failed) has no exception recorded either. That makes it invisible in an exception queue.
- OPS-0008 has the only recorded exception (`ExternalServiceTimeout`), and it is untagged.

### P7: Shortfalls against the brief

| Entity | Brief | CSV | Gap |
|---|---|---|---|
| Purchase orders | 35 | 30 | +5 needed |
| Project events | 110 | Σ `project_event_count` = 95 | +15 needed |
| Products | 45 | 0 | generate |
| Site notes | 75 | 0 | generate |
| Documents | 60 | 0 | generate |
| Second invoice for the 8 rows with `invoice_count=2` | 8 | only totals given | derive |
| Quote versions | v1 + v2 where `quote_version=2` | version number only | derive |
| Line items (quote/PO/invoice) | needed for arithmetic | header amounts only | generate so the lines sum to the header |

### Minor

- The customer type doesn't match the name pattern: CUST-0035..0040 are `Commercial` but have personal names and no business name. Properties typed `Small Commercial` belong to `Residential` customers.
- All addresses are in the Bundaberg region (postcode 4670). Street numbers + names could coincide with real addresses. Mitigation: prefix the street number with `Unit 0/` or use obviously fictional street names in the regenerated set. This is a judgement call.

## Recommendation: treat the CSV as a scenario specification, not as rows to import

The seed generator (Phase 1) will:

1. **Keep:** names, IDs (CUST/PROP/Q/PRJ/PO/INV/SUP), statuses, amounts, relationships and every edge-case tag, so `Q-2026-0031` means the same thing in the CSV, the app and the demo script.
2. **Re-anchor dates:** every date becomes an offset from `DEMO_ANCHOR_DATE` (default: the day the seed runs; fixed at `2026-09-29` in tests). Active projects get plausible future windows, and the tagged at-risk projects land in "next week".
3. **Repair contradictions deterministically:** P2 (paid-before-accepted), P3 (completed projects get DELIVERED POs), P5 (events derived from state), P6 (tagged exceptions get real `workflow_exceptions` rows).
4. **Turn P4 into two deliberate scenarios:** one over-invoice *with* an approved variation (passes) and one *without* (blocked in Module 5).
5. **Fill P7 gaps** with a seeded PRNG (`seedrandom`-style, `SEED=roofops-demo-1`). Same seed + same anchor → byte-identical data, verified by a snapshot hash test.
6. Emit `data/generated/seed-manifest.json` listing each named scenario → the record IDs that carry it, so the demo script and tests look scenarios up by name, not by hard-coded ID.

This choice is flagged as **Decision D-1** for your review.
