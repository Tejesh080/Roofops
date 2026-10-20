# First real quotation hand-off: hosted Supabase -> n8n Cloud -> Airtable (2026-10-20)

Synthetic reference **ZZ-SYNTH-QT-20261020**. One supervised run. Nothing was sent to Xero.

## Before the test

- **Backup:** `D:/Claude/roofops-backups/pre-synthetic-quote-test-20261020-164125.dump` (sha256 `69ca07be…`).
  Restore-tested locally: 65 tables, row counts equal to live, audit chain intact.
- **Migrations:** the 7 pending migrations were applied with the real runner and no data import, giving 56 in total.
  Security 16/16; integrity 0 FAIL; invoices, approvals and Xero untouched; business date SYNTHETIC 2026-09-29;
  `xero.line_tax_amounts` off.
- **Workflow 07** was paused for the migrations and resumed afterwards (version `a0ca9e60`).
  - Observe run `RECON-20261020-170014-bd6c`: exactly the 2 expected drifts (Invoice Preview on PRJ-2026-0005 and
    PRJ-2026-0007).
  - Repair run `RECON-20261020-170356-f72a`: 2 repaired, drift now 0, Xero 0 and Drive 0. All 3 Airtable webhooks
    OK; the 06 change webhook was refreshed to 168 hours.
- **Workflow 09** (staff Xero dispatch) stayed inactive. `STAFF_XERO_DISPATCH` is absent in Vercel, so it is off.

## The test

1. **Session.** The owner connection created ONE 30-minute session for the synthetic pilot admin EMP-802. Every
   business step then ran through the dashboard's own hosted login (`roofops_web`) using the application functions,
   so role checks, validation and audit applied as usual.
2. **Records.** All created with those functions:
   - enquiry `web_lead_create` -> **LEAD-2026-0001**;
   - `web_lead_convert` -> new customer **CUST-0041** and new site **PROP-0053**;
   - `web_quote_save` -> **Q-2026-0066**, version 1, $100.00 including $9.09 GST;
   - `web_quote_send` -> SENT, with exactly one hand-off queued.
3. **Run.** n8n workflow 10 `T3LGLVgs2FbaJH6S` (inactive) was executed once, manually: **execution 3080**,
   status success, 10 seconds. Its trigger node was enabled only for that run and disabled again straight after.
4. **Session revoked** (`web_staff_sign_out`) at 07:10:37 UTC.

## Evidence

**Airtable**, read independently through the Airtable API rather than from n8n's output:

| Record | Airtable id | Checked |
|---|---|---|
| Quote Q-2026-0066 | `recLx1NLtkdz8Zjnt` | Status Sent, Version 1, Amount 100, Leak Repair, Referral, RoofOps ID `e36f1270…`, linked to the customer and property below |
| Customer CUST-0041 | `recwhLYqvR3DJtzFw` | name "ZZ-SYNTH-QT-20261020 Synthetic Customer", linked to the property and the quote |
| Property PROP-0053 | `recjouZGkdAPfX9vi` | 66 Synthetic Test Street, owner = CUST-0041 |

- **Duplicates:** searching by number OR RoofOps ID returns exactly 1 record for each of the three.
- **Table totals:** Customers 40 -> 41, Properties 52 -> 53, Quotes 65 -> 66, Projects 33 -> 33.

**Postgres:**
- **Hand-off:** DONE on attempt 1. The proof carries `quote_record_count = 1` and the quote read-back (Sent,
  version 1, amount 100, both links).
- **Links:** 3 verified Airtable `external_links`. The dashboard view says "in Airtable" (`airtable_handoff = DONE`).
- **Exceptions:** none.
- **Audit:** exactly lead.created, customer.created, lead.converted, quote.drafted and quote.sent (all by EMP-802),
  then airtable.quote.published (integration).
- **Rows added, and nothing else:** audit +6, automation event +1, customer +1, property +1, customer_property +1,
  external links +3, ID counter +1, lead +1, outbox +1, quote / version / line +1 each, staff session +1.
- **Invoices unchanged:** 4 APPROVED, 1 DRAFT, 10 ISSUED, 27 PAID; Xero queue empty; 5 Xero draft generations.
- **Integrity:** 30 PASS / 4 WARNING / 0 FAIL. The drift warning cleared after the repair.

**After the test:**
- Observe run `RECON-20261020-171000-57e0` compared all **234** linked Airtable records field by field and found
  **0 drift**.
- Webhooks OK, with 0 unread payloads.
- Workflow 06 recorded no events for the created records, as designed.
- No exceptions.

## Staff journey

**Local rehearsal database** (`roofops_pilot`): the browser suite `sales-journey` passed 3/3 through the real
dashboard routes, signed in as the synthetic ESTIMATOR:

- enquiry -> customer and site -> inspection -> quote -> send -> "Airtable: added" -> accepted -> project;
- duplicate-enquiry handling and contact correction;
- a sent quote is final.

In that suite the Airtable step is simulated. The real Airtable step is the hosted test above.

**Hosted dashboard:** not exercised in a browser. Signing in needs a staff password, and none was used: the one
pasted in chat earlier was not reused, and no signed cookie was forged.

## Observations (no code change)

- Conversion sets Preferred Contact from the data (Phone when a phone number is given); the form has no choice for it.
  The test script passed a `preferred_contact` field that the function does not take.
- A manual run of workflow 10 needs its trigger node enabled. While the workflow is unpublished, that cannot cause
  scheduled runs.
