# FIN-GST-01 follow-ups and LIFE-01: offline verification (CC-04, FIN-08)

Status: **Fixed offline**. Nothing hosted, n8n or Xero was touched. Branch `feature/advanced-sprint-lifecycle`.

## 1. Where FIN-GST-01 stood

The release-blockers sprint (`fc30b1a`, migration `20261017030000`) fixed FIN-GST-01 offline, though the ledger still
said "Not started":
- each line carries its exact share of the GST, by largest remainder, so the shares add up;
- `invoice_final_preview` refuses a multi-line final while `xero.line_tax_amounts` is off;
- n8n 05 sends `TaxAmount`.

The audit of 2026-10-22 found two gaps.

| Id | Gap | Fix |
|---|---|---|
| CC-04 | Every payload carries `tax_amount`, a single line included, and 05 sent `TaxAmount` whenever it was there. So deploying the new 05 would change the request of every single-line draft. Xero's acceptance of an overridden `TaxAmount` is unverified, and the switch did not control this | n8n 05 sends `TaxAmount` only on a multi-line draft. A single-line draft is exactly today's request; only the multi-line path, which the switch gates, uses `TaxAmount` |
| FIN-08 | A reissue skipped the multi-line gate: a voided two-line final could be requested and queued as a generation-2 write with the switch off | Migration `20261022070000_reissue_multi_line_gst_gate.sql`: `invoice_reissue_check`, which `ops_reissue_request` and `ops_reissue_decide` both call (and the dashboard's reissue overview shows), refuses `MULTI_LINE_GST`. Its latest and only definition (20261001170000) plus only the gate; exact rollback |

## 2. LIFE-01

Already fixed in display by `v_dashboard_project_checklist` (migration `20261017010000`, on hosted since 20 Oct). The
"Final invoice approved" card follows the final invoice's approval; the canonical checklist row stays OPEN, and no gate
reads it. Nothing tested it until now. `test/project-lifecycle.test.ts` case 5 + 6 now asserts the card is To do before
the approval and Done after it.

## 3. Verification

| Check | Result |
|---|---|
| `test/reissue-gst-gate.test.ts` without the migration | 2 of 3 red (request and decide succeeded with the switch off) |
| With the migration | 3 of 3 |
| `test/release-blockers.test.ts`, 05's real node | a single-line payload with a tax share produces exactly the old request; two lines carry [9.10, 9.09] |
| Ablation: 05 sends `TaxAmount` on any line again | red |
| `test/project-lifecycle.test.ts` | 13 of 13 |
| Rollback round trip (scratch database) | only `invoice_reissue_check` changes; everything identical after the down file |
| Full gate, `TEST_DATABASE_URL=… npm run check` (PGlite and Postgres 17) | exit 0; Test Files 63 passed, 3 skipped (66); Tests 1299 passed, 37 skipped (1336) |

## 4. Hosted steps awaiting owner approval

1. 🔒 `npm run db:load -- --hosted` (with the release).
2. 🔒 Deploy n8n 05 from `n8n/05-xero-draft-invoice.sdk.ts`. Single-line drafts send the same request as today.
3. 🔒 One supervised multi-line draft in the Xero Demo Company, with its read-back checked (GST equals RoofOps's to the
   cent). Only then switch `xero.line_tax_amounts` on.
4. Rollback: the previous 05 version, then the down file.
