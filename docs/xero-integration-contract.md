# Xero integration contract

`docs/master-plan.md` Task 2.3. What a bookkeeper can expect from RoofOps's Xero integration. Each expectation is
**verified**, with the code and the test that pin it, or **deferred to Phase 4**, with the decision or change it waits
on. Checked against `main` on 30 Oct 2026; line numbers are as of that date.

The expectations come from the research (`reports/RoofOps master plan research.md`, lines 21–25). Everything below has
run only against the Xero Demo Company. Workflow 05 refuses any other organisation (node `Check Demo Company`).

Short names: **05** = `n8n/05-xero-draft-invoice.sdk.ts`, **07** = `n8n/07-reconcile.sdk.ts`. Migrations, all in
`supabase/migrations/`: **A** = `20261016000000_staff_invoice_approval_and_xero_dispatch.sql`,
**B** = `20261017030000_release_blockers.sql`, **C** = `20261017040000_sales_reliability.sql`,
**D** = `20261001150000_one_live_xero_draft_generation.sql`, **E** = `20261001080000_ambiguous_xero_create_stays_unknown.sql`.

## Summary

| # | Expectation | Verified | Deferred to Phase 4 |
|---|---|---|---|
| 1 | Push to Xero only on approval | Yes | Two people on the Airtable path (decision) |
| 2 | Never a zero-value invoice | Yes | A table-level backstop (code) |
| 3 | ContactID and InvoiceID stored and used | InvoiceID | Look contacts up by stored ContactID (code) |
| 4 | Contact matched by stored id, then email, never by name | Never by name | How existing contacts are matched (decision) |
| 5 | One invoice number sequence, checked against Xero including VOIDED/DELETED | Yes | A test for DELETED on a first invoice (code) |
| 6 | `Idempotency-Key` on every Xero write | Yes | A test that the header is sent (code) |
| 7 | 429 handled with `Retry-After` | Writes | Reads, and a cap on the wait (code) |
| 8 | Nightly reconciliation catches what a write or webhook missed | Linked invoices | Manual invoices, contacts, credit notes, a count-and-total report (decision) |
| 9 | DRAFT or AUTHORISED on approval | DRAFT | AUTHORISED (decision) |
| 10 | Tracking categories | No | Which categories and options (decision) |

## Line by line

**1. Push to Xero only on approval.**
- *Verified:* `wf_invoice_decide_core` (A 25–195) queues the first Xero write only when an invoice is approved (164–168). It first checks the approver's role (87–90), that the preview has not changed (101–107), and that a Xero tenant is pinned (108–109). `xero_dispatch_problem` (A 273–275) refuses an unapproved invoice. On the dashboard, `web_invoice_decide` (A 390–396) refuses approval by the person who prepared it (`SAME_PERSON`). Tests: invoice.test.ts `PRJ-2026-0004: deterministic amount = quote 20949.27 - billed 6284.78 = 14664.49 inc GST (GST 1333.14)` (no Xero write after Prepare); staff-invoice-approval.test.ts `Finance prepares: the preview records the employee and shows customer, amounts, GST and lines; Finance cannot approve it`.
- *Deferred:* on the Airtable path one shared account can prepare and approve, and `invoice.reissue_requires_second_person` ships off. **Decision:** require two people everywhere before a real tenant.

**2. Never a zero-value invoice.**
- *Verified:* `invoice_final_preview` (B 151–156) refuses when nothing is left to invoice. Test: billing-entitlement.test.ts `6. exactly fully invoiced (including an invoiced variation): FULLY_INVOICED, not ready, not over-billed`.
- *Deferred:* this is the only guard; no table check backs it up (`invoices.total_inc_gst` defaults to 0). **Code:** add a check constraint.

**3. ContactID and InvoiceID stored and used.**
- *Verified:* `wf_complete_side_effect_core` (C 302–357) requires both ids, stores them in `external_links`, and refuses a second InvoiceID or a different ContactID. The InvoiceID is used afterwards: `wf_reconcile_targets_core` (D 543–548) feeds 07's `Read Xero Invoice`, and the result goes to `xero_record_settlement`. Test: invoice.test.ts `good proof records InvoiceID + ContactID, marks the invoice SYNCED, the approval EXECUTED and the run SUCCEEDED`.
- *Deferred:* the stored ContactID is only checked, never used to find the contact, and the different-ContactID refusal has no test. **Code:** 05 looks the contact up by stored ContactID first.

**4. Contact matched by stored id, then email, never by name.**
- *Verified:* never by name. 05's `Find Contact By Number` (94–98) searches `ContactNumber=="RO-CUST-nnnn"`, archived included, and `Check Contact Search` (99–106) refuses duplicates and archived contacts.
- *Deferred:* neither the stored id nor the email is used, and these nodes have no test. A real tenant's existing contacts carry no RoofOps number, so 05 would create duplicates. **Decision (bookkeeper):** match existing contacts by email, or load their ContactIDs in advance.

**5. One invoice number sequence, checked against Xero including VOIDED/DELETED.**
- *Verified:* numbers come from one counter (`next_friendly_id('INV', year)`, A 133) and are unique. The Xero number is `RO-` plus that number (B 212). Before creating, 05's `Search Xero By Invoice Number` (128–132) searches all statuses, and `Reconcile Before Create` refuses a number that exists only as VOIDED or DELETED, a duplicate, or a different invoice (166–172). The read-back requires exactly one live invoice with the number (05 229–230). Test: n8n-05-generation.test.ts `only a VOIDED document with the number: a person decides (as before)`.
- *Deferred:* DELETED has no test of its own for a first invoice. **Code:** add one.

**6. `Idempotency-Key` on every Xero write.**
- *Verified:* the only Xero writes are 05's `Create Contact` (key `roofops-contact-<customer id>`, line 115) and `Create DRAFT Invoice` (key from `xero_draft_provider_key`, line 184). 07, 08 and 96 only read. Test: xero-generations.test.ts `VAL-GEN-005: generation 1 is byte-identical to the legacy keys, generation >= 2 is new, and every writer uses the helpers` (the key's value).
- *Deferred:* no test checks that the header is actually sent. **Code:** add one.

**7. 429 handled with `Retry-After`.**
- *Verified for writes:* 05 reads `retry-after` (line 24, 60 s if absent); `wf_fail_side_effect` (E 73) uses it as the delay, 05 waits and claims the job again, and a job stops after five attempts. Test: workflow.test.ts `retryable failures stop after max attempts and open an exception` (the database half).
- *Deferred:* 07's reads record a 429 as a failed lookup without waiting, the wait has no upper limit, `X-MinLimit-Remaining` is not used, and no test runs 05's header parsing. **Code:** all four.

**8. Nightly reconciliation catches what a write or webhook missed.**
- *Verified:* 07 runs daily at 02:30. It reads every linked invoice and follows its Xero status (`xero_record_settlement`, D 407–534), and looks up uncertain writes by number and by reference (`wf_reconcile_xero_uncertain`, D 699–833). RoofOps uses no Xero webhook, so this is the only path back. A missed run shows as stale after 26 hours (A 519–523). Test: reconcile-07-uncertain-xero.test.ts `one target, one exact match: two read-only GETs in the pinned tenant, by number and by reference; the draft is linked, SYNCED`.
- *Deferred:* 07 never reads invoices made by hand in Xero, contacts or credit notes, and there is no RoofOps-versus-Xero count-and-total report. **Decision (bookkeeper):** whether a weekly report replaces their own check (master plan Task 4.3).

**9. DRAFT or AUTHORISED on approval.**
- *Verified:* RoofOps creates DRAFT only (05 line 186); the read-back and `wf_complete_side_effect_core` (C 309–311) require DRAFT. When a person authorises it in Xero, 07 follows it and RoofOps marks the invoice ISSUED. Test: xero-settlement.test.ts `2. AUTHORISED and unpaid: ISSUED, owed in full (a dry run records it but changes nothing)`.
- *Deferred:* creating AUTHORISED invoices. **Decision (bookkeeper, master plan §15):** drafts leave the final check to them; AUTHORISED would need changes in the three places above.

**10. Tracking categories.**
- *Not implemented:* invoice lines carry description, quantity, unit amount, account code and tax type only, and every line uses the same `xero.sales_account_code`. The word "tracking" appears nowhere in the code or tests.
- *Deferred:* **Decision (bookkeeper):** which categories and options, if any. The research's note of a two-per-line limit is unverified.

## Other safeguards

- **Only the pinned Demo tenant:** 05 lines 70–91 and C 296–301; the pin cannot change while a write is open (`20261001070000_xero_write_bound_to_its_tenant.sql`). Test: invoice.test.ts `refuses proof from the wrong tenant, a non-demo org, a non-draft, a wrong total, or two matching invoices`.
- **Read back before anything is recorded:** 05 lines 200–240. Test: n8n-05-generation.test.ts `read-back of the created draft: verified`.
- **A voided invoice never gets a draft:** test invoice-void.test.ts `safety net: an invoice voided behind the checks (bypassing triggers) is never written or linked, and integrity reports it`.
- **A lost create answer stays UNKNOWN and is never sent again:** E 31–115. Test: xero-ambiguous-create.test.ts `4. the create answer is lost: UNKNOWN, kept through later failures of any class and through the dead letter; never FAILED`.
- **Staff dispatch is off:** the 09 trigger is disabled.

## For Phase 4

**The bookkeeper decides:** two people for every approval (1); how existing contacts are matched (4); whether a weekly
count-and-total report is needed (8); DRAFT or AUTHORISED (9); tracking categories (10).

**Code before a real tenant:** a zero-value check constraint (2); contact lookup by stored ContactID (3); tests for
DELETED (5) and for the `Idempotency-Key` header (6); 429 on reads, a cap on the wait, and a test of the header
parsing (7).
