# Data import: canonical bundle → Postgres

> **SYNTHETIC DEMO DATA.** Source: `RoofOps_Synthetic_Data_Bundle.zip` (generated with seed 20260928), unpacked verbatim into `data/raw/`.

## Pipeline

```
data/raw/*.csv                     canonical bundle, verbatim, never edited
   │  npm run data:normalise       date normalisation only (rules D1–D11), relative to DEMO_DATE = 2026-09-29
   ▼
data/normalised/*.csv              same files; only date cells differ (tables without changes are byte-identical copies)
data/normalised/date_changes.csv   every changed cell: table, record, field, from, to, rule, reason
data/normalised/scenario-manifest.json   scenario → record IDs, read from the planted markers
data/normalised/MANIFEST.json      SHA-256 of every raw + normalised file; dataset hash = import identity
   │  npm run db:load              migrate, then import in ONE transaction
   ▼
staging.*   (every source column as text, for lineage)  ──transform.sql──▶  core tables + views
```

**Guarantees, each enforced by a test:**

| Guarantee | Test |
|---|---|
| Only date columns change. Every other cell (IDs, names, amounts, statuses, tags) is byte-identical to `data/raw` | `normalise.test.ts` |
| Every changed cell is logged with a rule and reason, and every log entry is a real change | `normalise.test.ts` |
| The raw bundle violates the date invariants; the normalised bundle violates none | `normalise.test.ts` |
| Deterministic: a fresh run reproduces the committed `data/normalised` exactly | `normalise.test.ts`, `npm run data:check` |
| Every source ID, name, email, phone, amount, relationship and note text lands unchanged | `import.test.ts` |
| All 14 planted scenarios are reproduced **from facts** by the operational views, not by reading tags | `import.test.ts` |
| The import is all-or-nothing, refuses files that don't match the manifest, and runs only once per dataset hash | `import.test.ts` |
| All of the above hold on PGlite **and** real Postgres 17 | `TEST_DATABASE_URL=… npm test` |

## Date normalisation rules (114 cells changed; 84 → 0 invariant violations)

Principle: a date changes **only** if it violates an invariant as of the demo date. Scenario placement is driven by the planted `edge_case_tags`, never by hard-coded record IDs.

| Rule | Cells | What and why |
|---|---|---|
| D1 customer since after first inspection | 10 | `created_date` set to the customer's first inspection date |
| D2 active schedule re-anchored | 46 | 21 of 22 active projects had schedules months in the past. Each is shifted as a block (durations preserved) into a window that fits its status: Scheduled starts in +2 days onward, Materials Pending in +9, Planning in +16. Tagged scenarios are placed so the scenario holds: 3 delayed projects have a missed start or are past completion; the late-materials and ack-pending projects start next week. PRJ-2026-0024 was already consistent and is untouched. Completed projects are untouched. |
| D3 PO dated before acceptance | 1 | PO-2026-0010: `po_date` moved to the acceptance date |
| D4 PO delivery date aligned to the schedule | 26 | Completed jobs: materials due before the job started. Open POs: delivery still to come, 2 days before start. Delivered POs: in the past. Late-materials scenarios: after start. |
| D5 PO sent date aligned to acknowledgement status | 4 | Sent POs on projects **not** flagged "awaiting supplier confirmation" were months old and unacknowledged, which contradicted the planted `materials_status`. Their sent date moves to the previous business day (inside the 2-business-day acknowledgement SLA). |
| D6 PO dated after its own delivery | 12 | `po_date` set to delivery date minus the supplier's lead time |
| D7 invoice issued before acceptance | 8 | issue date moved to the acceptance date |
| D8 / D9 due / paid before issue | 3 / 3 | original payment terms and payment lag kept |
| D10 paid on/after the demo date | 1 | INV-2026-0003 paid 30 Sep → 28 Sep |
| D11 unpaid invoice accidentally overdue | 0 | guard rule: exactly the 2 planted overdue invoices are overdue |

**Deliberately not changed:** quotes (their date chains were already valid), events, site notes, documents, exceptions and the idempotency ledger. Their timestamps are all before the demo date. The event stream is not aligned to record dates; see the discrepancies below.

## Column mapping (source → core)

| Source | Core | Notes |
|---|---|---|
| `customers.customer_id / customer_name / email / phone` | `customers.customer_number / display_name / email / phone` | verbatim, including `"Chloe Bennett "` (trailing space) |
| `customers.created_date` | `customers.customer_since` (date) | `created_at` always means "row inserted" |
| `customers.duplicate_candidate_of` | `customer_match_candidates` | score and reasons computed from the facts (phone exact, name match after trim/case-fold, email differs) |
| `properties.customer_id` | `customer_properties (OWNER)` | many-to-many link table |
| `quotes.inspection_date / roof_type / roof_area_sqm` | `inspections` (one per quote, `INS-2026-nnnn`) | missing roof area stays NULL (planted scenario) |
| `quotes.quote_version` + `quote_amount_aud` | `quote_versions.version_number` + one `SUMMARY` line | only the current version exists in the source; earlier versions are **not invented** |
| `quotes.estimator`, `projects.project_manager`, `site_notes.author` | `employees` (7, `EMP-001…`) | names verbatim; emails `first.last@roofops.example.com` |
| `projects.schedule_risk / delay_reason` | `pm_risk_flag / delay_reason` | kept as the PM's own assessment; system risk is derived separately |
| `projects.materials_status` | derived (`v_project_risk`, `v_projects_waiting_on_materials`) | kept verbatim in `staging.projects` |
| `projects.compliance_photos_status` | `project_checklist_items (COMPLETION_PHOTOS)` | Complete → DONE, Missing / Not Due → OPEN |
| `projects.drive_folder_status = Created` | `external_links (GOOGLE_DRIVE, is_mock = true)` | the bundle's storage is "Mock Drive" |
| `purchase_orders.po_value_aud` | one `SUMMARY` line, **ex-GST** | subtotal equals the source exactly; GST derived |
| `purchase_orders.supplier_acknowledged` | derived from status | Yes ⇔ ACKNOWLEDGED / PARTIALLY_DELIVERED / DELIVERED (consistent across all 35 rows) |
| `invoices.invoice_amount_aud` | one `SUMMARY` line, **GST-inclusive** | total equals the source exactly; GST = total ÷ 11 |
| `invoices.paid_date` | `payments` row for the full amount | method `UNKNOWN`, source `IMPORT` |
| `invoices.xero_invoice_id` (`DEMO-XERO-nnnn`) | `external_links (XERO, is_mock = true)`, `sync_status = SYNCED` | placeholders, not real Xero IDs |
| `project_events` | `automation_events` (`event_key` = source ID) | `duplicate_of` → `causation_id`; source error class kept in metadata |
| `processed_events` | `processed_events` (`consumer = legacy:<event_type>`) | |
| `workflow_exceptions.error_class` | FK to the `error_classes` reference table | `retryable` comes from the reference policy |

Vocabulary is translated 1:1 (`'Materials Pending'` → `'MATERIALS_PENDING'`). An unmapped value violates a CHECK or foreign key and aborts the whole import.

## Interpretation decisions (please review)

1. **Money basis.** The bundle doesn't say whether amounts include GST. Customer quotes and invoices are loaded as **GST-inclusive**, because Australian Consumer Law requires single-price, GST-inclusive quotes to consumers. Supplier POs and prices are loaded as **ex-GST**, the trade convention. Each document records its basis (`line_amount_type`, as Xero does), so the source number is always stored exactly; only the GST split depends on this choice.
2. **Imported records are marked `record_origin = 'IMPORT'`.** Legacy POs, invoices and exceptions have no approver or resolver in the source, so they're exempt from those checks. Anything RoofOps creates is held to the full rule.
3. **Demo date is fixed.** `app_today()` returns 2026-09-29 (`app_settings.business_date_override`), so "overdue" and "next week" stay true on the interview day.

## Known source discrepancies (reported, not fixed, since only dates may change)

| # | Finding | Effect |
|---|---|---|
| K1 | The `UNRESOLVED_AUTOMATION_EXCEPTION` tag is on **PRJ-2026-0016**, but the only open exception (EXC-0003, TIMEOUT) is on **PRJ-2026-0008**. EXC-0011 (PRJ-0016) is resolved. | "1 unresolved automation exception" holds (EXC-0003). The tag points at the wrong project. |
| K2 | Exception → event links look shifted by one: EXC-0011 references `EVT-DUP-0001` (a duplicate quote.accepted for Q-0005) but says "MissingDocument" for PRJ-0016; EXC-0012 references `EVT-FAIL-0001` (PRJ-0016 timeout) but is filed against PRJ-0017. | Exceptions load as supplied |
| K3 | `project_events` is a round-robin stream: event types cycle across projects every 13 h from 1 Jun, regardless of state (e.g. `job.completed` for PRJ-0014, which is Materials Pending; `quote.accepted` for Q-0004 three weeks after it was accepted). | Loaded as history; Phase 2 will generate real, state-consistent events |
| K4 | 9 POs on **completed** projects are still Draft/Approved/Sent (never acknowledged) | Visible in `v_purchase_order_status`; excluded from active-project risk |
| K5 | 5 quotes are `Draft` but have a sent date (Q-0033, 0038, 0039, 0046, 0065) | Loaded as-is (plausible: a new draft version after sending) |
| K6 | The accepted quote with the failed project (Q-2026-0031) has **no** exception record | Detected instead by `v_accepted_quotes_without_project`, which is the better design anyway |
| K7 | Two overdue invoices (INV-0025, INV-0032) and one draft have no Xero ID | Loaded as `NOT_SYNCED`, a useful reconciliation demo |
| K8 | 45 products have only 27 distinct names, and **15 names appear twice at the same supplier** with different SKUs and very different prices (e.g. SUP-006 "Insulation Blanket Classic Cream": PROD-0012 $12.39 vs PROD-0042 $54.05) | Kept 1:1 with the source IDs. This makes supplier-quote product matching (Module 4) ambiguous by name, so matching must use the supplier SKU, and name-only matches must go to human review. |
