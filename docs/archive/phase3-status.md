# Phase 3: Approved Project → Xero Demo Company DRAFT invoice ✅ (awaiting review)

Real Airtable → n8n → Postgres → **Xero Demo Company (AU)** → Postgres → Airtable, with human approval, persistent
idempotency and read-back verification. All data is synthetic. Demo Company only. DRAFT invoices only. Nothing is sent,
paid, or posted to a bank account, and payroll is never touched.

## What is live

| Piece | ID |
|---|---|
| `[RoofOps] 04 Approved Project → Xero Draft Invoice` (published, Airtable webhook `achAHQLGW3ueCycSt`) | `YpmpJxQtSIBGSx6Z` |
| `[RoofOps] 05 Xero Draft Invoice` (sub-workflow, the only thing that writes to Xero) | `Y2deCFTZzpv1uo8C` |
| `[RoofOps] 96 Xero Read-Only Check` (identity, Demo guard, RoofOps invoice/contact inventory) | `aNl2HF1f8TwZgTUq` |
| n8n credential `RoofOps Xero` (`xeroOAuth2Api`), one connection: Demo Company (AU) | `rjqe50LhcU1IRLBc` |
| Pinned tenant (`app_settings xero.demo_tenant_id`, audited `xero.demo_tenant.pin`) | `96643bb0-3a0a-406e-96fb-ab8a933ee6b8` |
| Migrations | `20260929000800_xero_draft_invoice.sql`, `20260929000900_duplicate_outcomes_report_invoice_state.sql` |
| Airtable Projects fields | Invoice Action (the staff "button"), Invoice Status, Invoice Preview, Invoice Amount, Xero Invoice Number, Xero Invoice ID |

**Safety found live, before any write.** The first `RoofOps Xero` connection was to a real organisation (Class `ULTIMATE_10`,
`IsDemoCompany=false`). `96` refused to read its contacts or invoices, nothing was written, and the credential was reconnected
to Demo Company (AU) only (execution 1785: one connection, `Class=DEMO`, `IsDemoCompany=true`). Only then was the tenant
pinned. Every Xero write re-checks the pinned tenant and `Class=DEMO`, and Postgres refuses proof from any other tenant.

## Flow

1. Staff set **Invoice Action = Prepare Xero draft invoice** on a Project → `wf_invoice_prepare` validates state (COMPLETED,
   completion documents present, no FINAL invoice yet, no invoices awaiting approval) and computes the amount
   deterministically: quote total inc GST + approved variations − already billed. GST is `round(amount/11, 2)`, INCLUSIVE.
2. A hashed preview (`approvals`, `PENDING`) shows project, customer, amount (inc/ex GST), reference (= project number),
   Xero contact and the **intended Xero organisation**. Nothing is queued for Xero.
3. **Approve Xero draft invoice** → `wf_invoice_decide`: the Airtable user must map to a FINANCE/ADMIN/OPERATIONS_MANAGER
   employee; the preview must be unexpired and its hash unchanged; a tenant must be pinned. Then, in one transaction: one
   FINAL invoice (UNIQUE `invoice:final:<project>`) + lines equal to the preview, one run, one outbox row `xero:invoice:<id>`.
4. `05` claims the outbox row → checks connection = pinned tenant and `Class=DEMO` → finds/creates contact `RO-CUST-nnnn`
   → **searches Xero by invoice number and by reference first** (adopts an existing DRAFT from an earlier ambiguous attempt,
   refuses anything else) → `PUT /Invoices` DRAFT with `Idempotency-Key` → reads it back → recounts → hands proof to
   `wf_complete_side_effect`, which records InvoiceID/ContactID only if the proof matches exactly.
5. `04` writes Airtable, reads it back and verifies. Timeouts mark the invoice `UNKNOWN` and are reconciled by search before
   any retry. Xero's own idempotency is only a second line of defence.

## Evidence (PRJ-2026-0004, Airtable `reczturPjx3N6PGoY`)

| # | Test | Result |
|---|---|---|
| 1 | No approval = no Xero invoice | Prepare (txn51, exec 1789) → APR-2026-0001 PENDING, Airtable "Awaiting approval", **no** FINAL invoice or outbox row; Xero inventory (exec 1791): **0** RoofOps invoices, 0 contacts |
| 2 | Approval creates exactly one DRAFT | Approve (txn53, exec 1792 → 05 exec 1793): INV-2026-0039 APPROVED; Xero `RO-INV-2026-0039` **DRAFT**, attempt 1 |
| 3 | Xero read-back | Independent `96` (exec 1795): InvoiceID `7b74973c-a487-48f0-85b9-91ca8c5b2909`, ref PRJ-2026-0004, contact `fb5fe56b-…` RO-CUST-0004, total 14,664.49, tax 1,333.14, ACCREC, Inclusive, paid 0, not sent, **1 per reference** |
| 4 | IDs stored in Postgres | `external_links` XERO invoice/Invoice `7b74973c-…` and customer/Contact `fb5fe56b-…`, both verified; invoice `SYNCED`; approval `EXECUTED`; run `SUCCEEDED` |
| 5 | Airtable reflects the state | "Xero draft created", RO-INV-2026-0039, InvoiceID, 14,664.49 (independent Airtable read) |
| 6 | Same event resent | Ping replay from cursor 1 (exec 1796) re-read txn47/51/53: all `DUPLICATE_IGNORED` (transport redelivery); still 1 invoice, 1 outbox row, 1 approval |
| 7 | New event id, same project | Approve again (txn57, exec 1797/1798): semantic duplicate "APR-2026-0001 was already decided"; Prepare again (txn59): `ALREADY_INVOICED`. Xero (exec 1801): still **1** invoice |
| 8 | Invalid state rejected | PRJ-2026-0007 (no compliance photos) → MISSING_DOCUMENT, EXC-0016; PRJ-2026-0031 (PLANNING) → INVALID_STATE, EXC-0017; no approvals; "Not eligible" |
| 9 | Audit trail | `xero.demo_tenant.pin` → `invoice.preview_prepared` (usr7uCnNO15fCefbH) → `approval.approve` (EMP-900) → `invoice.create` → `xero.invoice.draft_created` (external ref = InvoiceID); hash chain intact |

Evidence files: `evidence/phase3-prj-2026-0004-postgres.json` (`scripts/verify-invoice-flow.ts`), `evidence/phase3-xero-readback.json`,
`evidence/phase3-airtable-readback.json`. Only one run of `05` has ever happened: every duplicate stopped in Postgres.

**Bug found live and fixed (ADR-031):** a duplicate after the draft existed was written back as a bare "Duplicate ignored",
overwriting "Xero draft created". The duplicate was correctly ignored, but Airtable no longer described the invoice. Migration
900 adds the verified Xero state to duplicate outcomes; `04` keeps "Xero draft created" with the real IDs and notes the ignored
duplicate. Proven live by tests 6 and 7 and pinned by a regression test.

## Tests

| Suite | Result |
|---|---|
| Local, PGlite + Postgres 17 (`TEST_DATABASE_URL=…`) | **211 passed**, 24 skipped (hosted-only) |
| Hosted (`RUN_HOSTED_TESTS=1`): schema, import (scoped to imported rows), live-phase2, **live-phase3** (plus the PGlite suite) | **188 passed**, 3 skipped |
| Lint, typecheck | clean |

`test/invoice.test.ts` (both engines): deterministic amount, ineligible states, malformed events, unpinned tenant refused,
unauthorised approver refused, one invoice + one side effect, duplicates (transport and semantic) incl. the ADR-031 state,
UNIQUE bypass impossible, stale preview cancelled, reject, timeout → UNKNOWN, bad proofs refused (wrong tenant, non-demo,
non-draft, sent, wrong total/reference/contact, two matches, unverified), good proof, least privilege. `test/live-phase3.test.ts`
pins the live result above.

## Remaining limitations

1. **The demo approver is a seeded employee** (EMP-900 "Demo Finance Approver") mapped to the single Airtable user; in a real
   team each approver would be mapped individually and the requester could be barred from approving their own request.
2. **Airtable is the approval UI** (a single-select "button"), not a signed approval link; the approver identity is Airtable's
   authenticated user on the change, fetched with our own credential.
3. **Recovery of a dead-lettered Xero write is an operator action** (the side effect goes `FAILED`, the approval
   `EXECUTION_FAILED`, one exception); no queue UI yet. The reconcile-before-create path has been exercised by tests, not by a
   real Xero timeout.
4. **Xero Demo Company resets** periodically; after a reset the stored InvoiceID will no longer exist in Xero (the pinned
   tenant ID may also change, which blocks writes until re-proven and re-pinned).
5. **The real organisation's Organisation response included a legacy `APIKey` field**, which is stored in n8n executions
   1778/1779/1781 (the Demo Company response has none). It was never used or repeated; delete those executions if that
   matters. The Airtable webhook MAC secrets are in executions 1749/1780.
6. Carried from Phase 2: pings not HMAC-verified; TLS to Supabase not certificate-verified from this machine; shared n8n instance.

## Reproduce

1. Airtable → Projects → a **Completed** project with completion docs and no final invoice (e.g. PRJ-2026-0005).
2. **Invoice Action → Prepare Xero draft invoice**. Within ~10 s: "Awaiting approval" and the preview (amount, reference,
   customer, Xero organisation). Nothing exists in Xero.
3. **Invoice Action → Approve Xero draft invoice** → "Xero draft created" with the Xero number and InvoiceID. Check it in Xero
   Demo Company → Business → Invoices → Draft.
4. Approve again → still "Xero draft created", preview says "Duplicate ignored". Run `[RoofOps] 96` → one invoice for that reference.
5. `npx tsx scripts/verify-invoice-flow.ts PRJ-2026-0005` for the Postgres side.
