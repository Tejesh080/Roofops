# Mutation matrix

Every business action the brief lists: the path it takes, what RoofOps does, and the evidence. **Live** means performed
against the real Airtable base, n8n Cloud and hosted Postgres on 29 Sep 2026. **Test** means a Vitest case on PGlite
**and** real Postgres 17, and `state-integrity` names `test/state-integrity.test.ts`. Every test case checks both the
outcome returned and the database state afterwards.

Path shorthand: **06** = Airtable webhook → n8n 06 → `wf_airtable_change` (identify by record link → lock row →
duplicate/stale/compare-and-set checks → field owner → state machine + guards → canonical update + audit → Airtable
corrections written and read back). **07** = reconciliation replaying the same handler.

## Quotes

| Action | Path | Result | Evidence |
|---|---|---|---|
| Draft → Sent | 06 | Applied; Sent On kept or set to the business date | **Live** Q-2026-0033 (event SUCCEEDED "✓ Status: Draft → Sent applied"); test |
| Sent → Accepted | Airtable → n8n 01 → `wf_quote_accepted` (06 defers) | Project + Drive + Airtable project, exactly once | Phase 2 live; test `DEFERRED`, no correction |
| Sent → Lost (with Lost Reason) | 06 | Applied; reason stored (default supplied if blank) | test |
| Invalid (Lost → Sent, Draft → Accepted) | 06 | Refused; Airtable put back; RoofOps Sync explains | test (both) |
| Duplicate (same event 1× / 20×) | 06 | One change, one audit row; later deliveries return the first result | test (20 deliveries) |
| Accepted in Airtable but acceptance never received | 07 | `REQUIRES_HUMAN` exception: "set back to Sent, then Accepted" (never auto-creates a project) | test |

## Projects

| Action | Path | Result | Evidence |
|---|---|---|---|
| All 56 status pairs (8 × 7) | 06 | Legal pairs applied (dates set, audit written); illegal pairs refused, row unchanged, Airtable corrected | test (generated from `state_transitions`) |
| Planning → Scheduled | 06 | Applied | **Live** PRJ-2026-0009 |
| Scheduled → In Progress | 06 | Applied; Actual Start = business date; Airtable told | test (PRJ-0015) |
| In Progress → Completed | 06 | Applied; Actual Completion set | test |
| Completed → Cancelled (**decision: allowed** until a final invoice exists) | 06 / 07 | Applied; pending invoice preview withdrawn; open tasks cancelled; earlier invoices kept | **Live** PRJ-2026-0001 (07 repair run); test PRJ-0005 (withdrawn approval audited) |
| Completed → Cancelled with a final invoice | 06 | Refused: "a final invoice (INV-…) already exists; void it first" | test |
| Cancelled → Planning (**decision: refused**, Cancelled is final) | 06 | Refused; Airtable put back to Cancelled | test (and PRJ-0001 re-open attempts) |
| Completed → In Progress (**decision: refused**; reopen = new job) | 06 | Refused | test |
| Materials Pending → Completed | 06 | Refused; Airtable corrected; read back | **Live** PRJ-2026-0010 |
| → On Hold with Status Reason, while n8n was unpublished | Airtable retry → 06 | Captured after n8n returned; reason stored | **Live** PRJ-2026-0009 ("Waiting on council permit") |
| Schedule change (valid) | 06 | Applied | **Live** PRJ-2026-0013 finish 12 → 14 Oct |
| Schedule change (start after finish; completed job) | 06 | Refused with the reason | test |
| PM change (active PM / not a PM) | 06 | Applied / refused with the valid names | test |
| Concurrent Scheduled → Cancelled vs Scheduled → In Progress | 06 × 2 | First wins; second refused as a conflict (compare-and-set on the previous value) | test on **two real Postgres connections** + single-connection test |

## Materials and purchase orders

| Action | Path | Result | Evidence |
|---|---|---|---|
| Material review complete | none | **NOT SUPPORTED**: tasks have no staff editing surface (state machine enforced if one is added) | contract row `task.material_review` |
| Supplier confirmed (Sent → Acknowledged) | 06 | Applied; acknowledged_at set; risk and materials views update | **Live** PO-2026-0011 (PRJ-0011 materials → Confirmed) |
| Delivery date changed | 06 | Applied if on/after PO date and not delivered | test |
| Overdue response (supplier confirmation overdue) | derived | Shown as a risk reason and "needs attention"; cleared by the confirmation above | dashboard views; live effect above |
| PO drafted | import / RoofOps | **NOT SUPPORTED** from Airtable (creating records in Airtable is not a supported path) | editability audit |
| PO approved | 06 | Only by a mapped approver for RoofOps-origin POs; approver and time recorded | test (unmapped refused, EMP-900 applied) |
| PO sent / acknowledged / delivered | 06 | Forward transitions applied with timestamps | test |
| Invalid backward (Acknowledged → Sent, Delivered → Approved) | 06 | Refused; Airtable put back | test |

## Finance

| Action | Path | Result | Evidence |
|---|---|---|---|
| Prepare | Airtable Invoice Action / dashboard / Copilot → `wf_invoice_prepare` | Hashed preview, awaiting a finance approver; no Xero call | Phase 3 live; Promptfoo; `invoice.test` |
| Prepare twice | same | Same pending preview returned | `invoice.test` "asking again returns the same pending preview" |
| Approve | Airtable → n8n 04 → `wf_invoice_decide` → n8n 05 | One FINAL invoice, one Xero DRAFT (pinned Demo tenant), read back | Phase 3 live PRJ-2026-0004 |
| Reject | same | Recorded with the approver; nothing created | `invoice.test` |
| Stale preview | same | Refused and cancelled ("prepare a new preview") | `invoice.test` |
| Cancelled project | prepare | Refused ("CANCELLED; only a COMPLETED project can be final-invoiced"); Copilot refuses without calling it | **Live** hosted (rolled-back transaction); Promptfoo |
| Duplicate approval | same | Never a second invoice or Xero draft; reports verified Xero state | `invoice.test`; Phase 3 live |
| Approval racing a cancellation | `wf_invoice_decide` (now locks the project row) vs 06 | Serialised: whichever commits first wins; the other sees the result | fix in migration 1200 (§9b); two-connection test for prepare vs cancel |
