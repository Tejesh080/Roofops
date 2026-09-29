# Phase 6: state integrity, reconciliation and production readiness

**Result:** every staff edit in Airtable now reaches RoofOps through one validated path, or is refused and explained,
or is put back. Postgres enforces the state machines itself. Missed, late, duplicate and concurrent changes end in
the canonical state, or in a named exception for a person. Nothing is silently lost and no winner is guessed.
PRJ-2026-0001 is **Cancelled** everywhere, through the production path.

Status on 29 Sep 2026 (business date), hosted Supabase + n8n Cloud + real Airtable/Drive/Xero Demo.

## 1. Gaps found and root causes

| # | Gap | Root cause | Fix |
|---|---|---|---|
| 1 | PRJ-2026-0001 Cancelled in Airtable, Completed in RoofOps / dashboard / Copilot | Only two Airtable fields had webhooks (Quotes.Status, Projects.Invoice Action) | base-wide webhook + n8n 06 + `wf_airtable_change` |
| 2 | Quote Draft→Sent, →Lost, →Expired silently ignored | n8n 01 filters to →Accepted and drops the rest | 06 handles them; 01 unchanged (acceptance still 01's job) |
| 3 | PO status, delivery date, schedule, PM edits silently ignored | same as 1 | 06 |
| 4 | Read-only data (customers, amounts, actual dates) editable in Airtable with no effect | no ownership contract | `field_contract`; edits reverted with a RoofOps Sync note |
| 5 | Legal status changes only implicit in each `wf_*` function; direct SQL could set anything | no state machine in the database | `state_transitions` + `enforce_state_machine()` triggers on 10 status columns |
| 6 | Nothing noticed drift after a missed/expired webhook | no reconciliation | n8n 07 + `wf_reconcile_*`, nightly + `npm run reconcile` |
| 7 | Q-2026-0041/0044/0048 had no "Accepted On" in Airtable (found by the first reconciliation) | 01's write-back never wrote it | repaired live; the nightly run keeps it repaired |
| 8 | An invoice approval could interleave with a cancellation (both read COMPLETED) | `wf_invoice_decide` didn't lock the project row | now locks it (migration 1200 §9b), like prepare and the change handler |
| 9 | Copilot said "nothing left to invoice" for a cancelled job | tool reason ignored status | explicit "cancelled job is never final-invoiced" |
| 10 | No health view; health would have been guessed | no recorded checks | n8n 08 + 07 record real checks; `/health` shows only recorded states |

## 2. Fixes (what was built)

- **Migrations 1200–1600** (hosted and local):
  - state machines and triggers, plus `project_transition_guard`
  - `field_contract` (94 rows)
  - `wf_airtable_change` with per-entity handlers: CAS, stale, duplicate, row lock, corrections
  - write-back proof
  - reconciliation functions, health recording, `integrity_check()` (26 rules)
  - drift and freshness read models, least-privilege grants
- **n8n:**
  - 06 Airtable Changes → Postgres (`lD6BOf2dhZZpSoEH`)
  - 07 Reconcile & Webhook Supervision (`EiBs0AB2NfOua7AM`, daily 02:30 Brisbane + operator trigger; success data not stored because the webhook-create response has a MAC secret)
  - 08 Health Checks (`e27BO9irmsYfVq6u`, every 30 min)
  - 00–05 unchanged
- **Airtable:** fields Projects.Status Reason, and RoofOps Sync on 6 tables. Base-wide webhook `achrbwFiSoL4y5RXM` (created by 07).
- **Web:**
  - `/health` System Health page and sidebar entry
  - out-of-sync notice on project pages
  - Copilot: `_meta` freshness on every tool result, `airtable_sync` facts, `system_health` tool, prompt rules
  - timeline wording for Airtable changes; echoes hidden
- **Scripts:** `integrity:check`, `reconcile [--dry-run]`, `contract:export`, `ai:eval`, `security:check`.

## 3. Source-of-truth map

[system-ownership-map.md](system-ownership-map.md); field by field: [source-of-truth.md](source-of-truth.md) and
[source-of-truth.json](source-of-truth.json). Both are generated from the enforcing table.

## 4. State diagrams

[state-machines.md](state-machines.md): 10 machines, 98 legal transitions. The generated tests cover every pair (242 on the
generic trigger + 56 project pairs through the real handler).

Decisions:
- **Completed → Cancelled:** allowed until a non-void final invoice exists. It withdraws pending previews and cancels open tasks; earlier invoices are kept.
- **Cancelled → Planning:** refused, because Cancelled and Closed are terminal. Reopening means a new job.
- **Completed → In Progress (shown on the dashboard as "On site"):** refused.

## 5. Airtable editability

[airtable-editability-audit.md](airtable-editability-audit.md). Before this phase, 12 editable fields were **BROKEN**. Now:

- **SUPPORTED:** 11 fields
- **READ ONLY** (enforced by revert/repair): all others
- **NOT IMPLEMENTED** (reported as exceptions): creating or deleting records in Airtable, and editing customer details from Airtable

## 6. Mutation matrix

[mutation-matrix.md](mutation-matrix.md). Functional coverage per system: [functional-coverage.md](functional-coverage.md).

## 7. Reconciliation design

- **Contract-driven.** For each linked record, `v_airtable_expected` builds what Airtable *should* show, using the same formatting as the original load and the write-backs. `wf_reconcile_airtable` compares it with a full read of each table (≈8 Airtable API calls per run).

| Drift on a field owned by | Classification | Action |
|---|---|---|
| Staff (editable) | `SAFE_AUTO_REPAIR` | observe: recorded; repair: **replayed through `wf_airtable_change`**, so the same rules apply as for a live edit (applied, or refused and put back) |
| RoofOps, value edited in Airtable | `UNAUTHORIZED_STATE` | Airtable put back, read back, note written |
| RoofOps, value never written | `SAFE_AUTO_REPAIR` (missing projection) | written, read back |
| Quote shows Accepted but RoofOps never got it | `REQUIRES_HUMAN` | exception with the exact fix; a project is never auto-created |
| Record only in Airtable | `UNKNOWN` | exception |
| RoofOps record missing in Airtable / Drive folder trashed or deleted / Xero invoice voided or deleted | `EXTERNAL_MISSING` | exception |
| Drive folder moved, Xero total/reference edited | `REQUIRES_HUMAN` | exception |
| Older change arriving after a newer one | `STALE_EVENT` | ignored, noted |

Webhook supervision on the same run:
- refreshes any RoofOps webhook with less than 72 hours to live;
- re-creates the change webhook if it is missing;
- **wakes any consumer with unread payloads**. A lost ping costs at most one day of delay, never data, because Airtable keeps payloads for 7 days behind our durable cursor.

## 8. Drift report (live)

| Run | Mode | Airtable | Drive | Xero | Findings |
|---|---|---|---|---|---|
| RECON-20260929-120127 | observe | 231 checked, 4 drift | 3/3 | 1/1 | PRJ-0001 Status (Completed vs Cancelled); Q-0041/0044/0048 Accepted On blank; change webhook MISSING |
| RECON-20260929-121410 | repair | 231, 4 repaired, **0 now** | 3/3 | 1/1 | PRJ-0001 **applied through the handler** (COMPLETED → CANCELLED, audit actor `reconciliation`); 3 dates written + read back; webhook created |
| RECON-20260929-121832 | repair | 231/231 in sync | 3/3 | 1/1 | none; all 3 webhooks OK |

## 9. Health

`/health` ([screenshot](screenshots/phase6/01-system-health.png)): every service is **Healthy** from recorded checks.
- Airtable: 231/231 in sync; Drive: 3/3; Xero: 1/1.
- Xero is healthy only if the pinned Demo tenant is among the connections.
- A service with no check within its interval shows **Unknown**; there are no defaults.
- Overall shows **Degraded** because of three honest business-rule warnings:
  - PRJ-2026-0001 is cancelled but PO-2026-0001 is still open with the supplier;
  - Q-2026-0031 is accepted but has no project (the planted Phase 1 scenario);
  - 4 open exceptions.

## 10. Chaos and failure results

**Webhook delivery**

| Scenario | How tested | Outcome |
|---|---|---|
| Duplicate / delivered 20 times | test (20×) | one change, one audit row, `delivery_count` 20 |
| Delayed / out of order | test | older change → `STALE`, not applied, no Airtable write |
| Missed completely (PRJ-0001) | **live** | observe run detected it; repair run applied it through the handler |
| n8n unavailable (06 unpublished during a staff edit) | **live** | Postgres unchanged while down; after re-publish Airtable's retry delivered the payload, applied with the staff member as actor; next reconciliation 0 drift |
| Webhook expired / missing | **live** (missing → created) + test (expiring → refresh, unread → wake) | recovered, health recorded |
| Echo of our own correction | **live** | `NO_CHANGE`, no write (kept out of history) |
| n8n fails after Postgres committed | test | redelivery re-issues the *current* canonical correction until the read-back proof is recorded |

**Concurrent mutations**
- Scheduled→Cancelled vs Scheduled→In Progress (two real connections): the first wins; the second is `REJECTED` as a conflict, with the reason written to Airtable.
- Invoice preparation vs cancellation: serialised on the project row; either the preview is withdrawn by the cancellation, or preparation sees Cancelled and refuses.

**External service failure matrix**

| Service down / failing | Behaviour | Evidence |
|---|---|---|
| Airtable (read in 06/07) | 06: HTTP node retries 3×, then the execution fails **before** the cursor advances, so the payload is redelivered. 07: a table that can't be read stops the run ("not every record deleted"). | workflow design; `Group Records By Table` guard |
| Airtable (write-back) | correction not verified → redelivery re-issues it; reconciliation repairs it | test |
| Google Drive | Phase 2: bounded retry, dead letter + exception, staff retry, no duplicate folder; 07 reports missing/trashed/moved folders | Phase 2 live outage test; tests |
| Xero | Phase 3: pinned tenant, `UNKNOWN` on ambiguous write, reconcile before any retry, never a second draft | Phase 3 tests / live |
| Postgres | every n8n step writes through a `wf_*` function; if it can't, the workflow fails without advancing cursors or claiming side effects | design; leases expire and are re-claimed (tests) |
| DeepSeek | Copilot shows "could not answer"; health records the failure; no data changes | route error handling; 08 |

## 11. AI accuracy (Promptfoo)

`npm run ai:eval` runs 13 cases against the real `/api/copilot` → DeepSeek → read-only tools. The assertions are deterministic and use ground truth read from Postgres (no LLM grading). Latest run: **13/13 pass**. The cases:

- status matches RoofOps;
- a cancelled job is never ready to invoice;
- no preparation for an ineligible project;
- the ready-to-invoice list is exact;
- a pending invoice is never "approved";
- approve/send and pay are refused;
- prompt injection for credentials and for SQL is refused;
- sync question answered from recorded checks.

Every answer is also checked for:
- no unknown PRJ/Q/PO/INV/APR/EXC ids;
- no $ amount that RoofOps doesn't hold;
- no SQL or internal names;
- no server secret value in the reply.

Along the way the harness caught three of its own defects, all fixed:
- stale ground truth for newly created approvals;
- a regex that was too strict;
- backspace characters in a regex.

## 12. End to end (browser)

`web/e2e/state-sync.spec.ts`: **9/9**. It reads canonical values with the dashboard's read-only role and checks the pages match:
- PRJ-0001/0009/0010/0011/0013 show the canonical stage, with no false sync warning;
- the cancelled job is not in the ready-to-invoice list;
- `/health` shows real figures;
- the Copilot answers Cancelled for PRJ-0001.

The live Airtable edits behind it were made through the Airtable connector, as a staff member would make them. The Phase 5 smoke suite passes 12/12. Its PRJ-0011 assertions now expect the confirmed supplier order, because the live E2E confirmed PO-2026-0011.

## 13. Security re-test

`npm run security:check` (hosted): **all pass**.
- The dashboard role reads no table. Its only definer functions are read-only or the preview.
- The workflow role can run only `wf_*`.
- anon/authenticated have no access; PUBLIC has no execute; every table has RLS.
- The Xero tenant is pinned; the reconcile token is stored only as a hash.

Web:
- no cookie → 401 / redirect to login;
- forged session → 401;
- SQL-injection and path-traversal URLs → not-found page, no data;
- client bundles and page HTML: 0 secret values found (scan compares actual values, never prints them).

AI: no DB credentials and no SQL tool; the injection cases above are refused.

Credentials stay in n8n or server-side env ([ownership map](system-ownership-map.md#credentials-where-they-live)). The Airtable PAT's scope is set in Airtable and can't be read through the API (see manual operations).

## 14. Tools evaluated, adopted, rejected

[phase6-tool-evaluation.md](phase6-tool-evaluation.md).

| Verdict | Tools |
|---|---|
| Adopted | **Promptfoo** (dev-only, pinned `0.123.1`, telemetry and sharing off) |
| Rejected | XState (SQL transition table is the single definition, with generated tests); Nango; Restate |
| Later | Hookdeck (n8n Cloud node not available; the drain step closes the gap); DBOS; EventCatalog |

Xero was not migrated. Business idempotency and persistence in Postgres are unchanged.

## 15. Manual operations (for a person)

1. **Delete the old n8n executions that hold secrets** (the safety rules don't allow me to delete data): 1778, 1779, 1781 (APIKey field), and 1749, 1780 (Airtable MAC secrets). Workflow 07 now stores no success data, so its webhook-create response isn't kept.
2. In Airtable, if you want: add field descriptions "Managed by RoofOps: edits are reverted" to the READ ONLY fields (about 60 API calls, so I skipped it on the Free plan), and review the PAT scopes (the base and `webhook:manage` are needed).
3. **Decide on PO-2026-0001**: PRJ-2026-0001 is cancelled but the supplier order is still open. Cancel it in Airtable (PO Status → Cancelled); RoofOps will apply it.
4. Q-2026-0031 is accepted without a project (planted Phase 1 scenario, visible as a warning), unchanged by design.

## 16. Limitations

- **One Airtable user.** Staff edits and RoofOps' own writes use the same Airtable account (`usr7uCnNO15fCefbH`, also the mapped demo finance approver). Echoes are recognised by value, not by author. Real use needs separate accounts, so an API write can't count as an approver action.
- **Airtable Free plan.** 1,000 calls a month. Reconciliation is daily, not continuous, and 08 doesn't call Airtable. Airtable's own health is checked nightly.
- **Compare-and-set** uses the previous value in the webhook payload. Two edits to the same field by two people within one delivery batch are resolved in Airtable's transaction order.
- **Status Reason** is read with a Status change only; editing it alone doesn't update the stored reason.
- **Not supported from Airtable:** record creation or deletion, customer/property/supplier edits, and task completion.
- **Health page speed.** It evaluates `integrity_check()` and drift on each load (≈1–1.5 s on hosted).
- **Dev server.** Next dev (Turbopack) panicked once after many edits and needed a restart. Hosted DB connections are limited by the Supabase session pooler, and concurrent test clients can exhaust it briefly.

## 17. PRJ-2026-0001 (the regression that started this phase)

| Check | Result |
|---|---|
| Airtable | **Cancelled** (read back independently) |
| Postgres | **CANCELLED**, reason recorded, audit `project.status.changed` COMPLETED → CANCELLED by `reconciliation` |
| Dashboard | Cancelled, no sync warning ([screenshot](screenshots/phase6/02-project-PRJ-2026-0001-cancelled.png)) |
| Ready to invoice | not listed (only PRJ-2026-0002, PRJ-2026-0005) |
| `prepare_invoice` | refused ("CANCELLED; only a COMPLETED project can be final-invoiced"); Copilot refuses too |
| History | both earlier invoices (INV-2026-0001, INV-2026-0031) untouched. It never had a Drive folder (imported job), so there was nothing to lose. |
| Copilot, "What's the status of PRJ-2026-0001 currently?" | "PRJ-2026-0001 for Oliver Grant is **Cancelled** (RoofOps and Airtable agree)" ([screenshot](screenshots/phase6/03-copilot-PRJ-2026-0001.png)) |
| Before the repair (observe run) | project page and Copilot said: "RoofOps status: Completed. Airtable currently shows: Cancelled. They are out of sync; last full check: 2026-09-29 12:01." |

## 18. Commands

| Command | What it does |
|---|---|
| `npm run integrity:check` | 26 rules on hosted: 23 PASS, 3 WARNING, 0 FAIL (exit 1 on FAIL); `-- --local` for Docker |
| `npm run reconcile` | repair run via n8n 07, prints the result from Postgres |
| `npm run reconcile -- --dry-run` | observe only |
| `npm run demo:status` | interview scenarios (PRJ-0011 still at risk; the supplier-confirmation talking point changed, see §12) |
| `npm run test` | 308 pass (PGlite + Postgres with `TEST_DATABASE_URL`), 31 skipped (live suites) |
| `RUN_HOSTED_TESTS=1 npx vitest run test/live-phase6.test.ts` | 6/6 hosted proofs |
| `npm run ai:eval` | Promptfoo 13/13 (needs the web app running) |
| `cd web && npx playwright test --project=state-sync` | 9/9 |
| `npm run security:check` | hosted privilege audit |
| `npm run contract:export` | regenerate the contract and state-machine docs |
