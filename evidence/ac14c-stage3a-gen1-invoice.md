# AC-14C Stage 3A: first supervised generation-1 final invoice in Xero Demo (2026-10-08)

Authorised by the owner: exactly ONE normal generation-1 final invoice for the synthetic project PRJ-2026-0002,
through the RoofOps/Airtable approval process.
- **No direct SQL write, no retry, no void or delete, no reissue, no dispatch token, no other workflow changed.**
- No secret is recorded here.
- Branch `factory/ac14-integrity-followup` at `bed002c` (clean, equal to GitHub) when it ran.

## 1. Pre-checks (all read-only): all PASS

| Check | Result |
|---|---|
| Git, integrity, tenant, in flight | `bed002c` synced; integrity 28 PASS / 4 WARNING / 0 FAIL; Demo tenant `96643bb0-…` pinned; outbox in flight 0; **open approvals anywhere 0**; reconciliation running 0; dispatch hash length 0 |
| Synthetic | CUST-0002 identity hash equals the committed bundle (`d6fe1c0a…`); `example.com` email; no ABN or legal name. The project chain is the bundle's Q-2026-0002 / CUST-0002 / PROP-0002 |
| Eligible | PRJ-2026-0002 COMPLETED; **no FINAL invoice, no Xero draft write, no Xero link**; no Xero contact for the customer yet |
| Read-only preview (`invoice_final_preview`) | **15,155.98 inc GST** = 13,778.16 + GST 1,377.82; one line (account 200, OUTPUT, inclusive); customer Mia Campbell [CUST-0002], contact RO-CUST-0002; reference PRJ-2026-0002; dated 2026-09-29, due 2026-10-13; Demo Company (AU) |
| 04 and 05 | both active and IDENTICAL to HEAD: 04 `fee94016…`, 05 `feab88d9…` |
| No unrelated trigger | no Projects row in Airtable had an Invoice Action set. With 0 pending approvals, only a Prepare followed by an Approve on this one project could create an invoice |
| Approver | EMP-900 (FINANCE, active) mapped to Airtable user `usr7uCnNO15fCefbH` |

## 2. The business action (Airtable, the normal staff surface)

1. **Invoice Action = "Prepare Xero draft invoice"** on PRJ-2026-0002 (`recbBZIwsTX5SgMHH`). 04 ran
   `wf_invoice_prepare` and opened **APR-2026-0012** (PENDING, 15,155.98). It wrote the preview to the row
   (`PREVIEW APR-2026-0012 · #3ce977a1acd05b7f …`), equal to the read-only preview, set the status to
   "Awaiting approval" and cleared the action.
2. **Invoice Action = "Approve Xero draft invoice."** 04 decided (the approver mapped to EMP-900, the preview bound),
   created the invoice and one write, and ran 05. Postgres showed:
   - approval EXECUTING → **EXECUTED**;
   - **INV-2026-0040** APPROVED, sync PENDING → **SYNCED**;
   - the draft write DISPATCHING → **DONE in 1 attempt**, no error, **no exception**.

   There was no ambiguity and no retry.

## 3. Verification: all PASS

| Check | Result |
|---|---|
| Invoice (Postgres) | INV-2026-0040, FINAL, APPROVED/SYNCED, origin ROOFOPS, 15,155.98 = 13,778.16 + 1,377.82; one line, qty 1 × 15,155.98, account 200; issued 2026-09-29, due 2026-10-13; approval APR-2026-0012 |
| Xero read-back (05's verified proof) | **RO-INV-2026-0040**, **DRAFT** ACCREC; total 15,155.98, tax 1,377.82, subtotal 13,778.16; AUD, Inclusive; contact **Mia Campbell [CUST-0002] / RO-CUST-0002**; reference PRJ-2026-0002; **Demo Company (AU)**, class DEMO, the **pinned tenant**; **matching invoices with this number = 1**; created (not adopted); not sent; nothing paid |
| Exactly one Xero InvoiceID | **`21545f60-7aa8-418b-8d8d-635a4c1d08ed`**: one verified invoice link and one ledger row. The Xero contact was created and linked (`f90734be-de7b-473e-a7ce-384f00349669`) |
| Outbox and ledger | one generation-1 write `xero:invoice:1b6486b9-…` (the generation-1 provider idempotency key), DONE, 1 attempt; ledger generation 1 **CREATED**, bound to the approval and the pinned tenant |
| No duplicate or unexpected writes | Whole-database diff against the pre-test fingerprint: **48 of 62 tables byte-identical**. **Payments unchanged (27)**, Xero observations unchanged until the reconciliation. The changes are exactly one invoice flow: approvals +1, approval_presentations +1, invoices +1, invoice_lines +1, outbox +1, ledger +1, external_links +2 (invoice and contact), audit_events +4, automation_events +5, processed_events +2, workflow_runs +1, workflow_run_steps +6, id_counters and the Airtable webhook cursor. No other invoice changed; 0 pending approvals; 0 REISSUE approvals; 0 in flight |
| Independent Xero read + reconciliation | `npm run reconcile -- --dry-run` gave **RECON-20261008-192138-1877** (observe, COMPLETED). **0 drift**: Airtable 231/231, Drive 3/3, Xero 2/2. INV-2026-0040 is **VERIFIED, Xero DRAFT (NOT_ISSUED)**, read in the bound tenant (the pinned one) on the linked InvoiceID. All three Airtable webhooks OK, 0 unread |
| Airtable row | "Xero draft created", RO-INV-2026-0040, the InvoiceID, "Approved by Demo Finance Approver under APR-2026-0012"; action cleared |
| Integrity, security | 28 PASS / 4 WARNING / **0 FAIL**; security **all PASS** (tenant pinned, dispatch hash blank) |

The draft is left in Xero Demo as a DRAFT. It is the generation-1 subject for the later supervised reissue test, which
is not started.

## 4. Review: does workflow 07 need MCP access? (no change made)

07 runs on its schedule trigger and on its operator webhook (`npm run reconcile`). Neither path uses MCP. MCP access
only lets an MCP client read, edit or **execute** it. n8n's MCP can execute schedule- and webhook-triggered
workflows, so an MCP client could start a **schedule-mode run, which is repair mode**, without any token. That can
write Airtable repairs and apply verified Xero settlements.

**Recommendation: disable `availableInMCP` on 07.** Deployment and inspection keep working through the n8n public API,
as for 08 in Stage 2A. This was not changed, pending the owner's approval. The same reasoning applies to the other
webhook- or schedule-triggered RoofOps workflows; 05 has no MCP-executable trigger.
