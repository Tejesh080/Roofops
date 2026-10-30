# Advanced RoofOps: technical demonstration runbook

A 30–40 minute demonstration for a technical audience. All data is synthetic (a fictional Australian roofing business).
Every claim below carries a label:
- **LIVE**: running on hosted Supabase, n8n Cloud, Airtable, Drive or the Xero Demo Company, with recorded evidence.
- **LOCAL**: proven by the test suite on PGlite and Postgres 17, not yet deployed.
- **PLANNED**: approval pending.

Never present a LOCAL or PLANNED item as live.

## 1. The business problem (3 min)

A small roofing contractor runs on spreadsheets, a shared Airtable base, email and a bookkeeper. The bottlenecks:
- quotes accepted by phone never become jobs;
- crews start without a signed SWMS;
- completed jobs sit uninvoiced;
- Xero and the job list disagree;
- nobody can say which system is right.

## 2. Architecture (5 min): draw it

- **Postgres (Supabase) is the system of record.** State machines, guards and integrity rules live in the database
  (`state_transitions`, `project_transition_guard`, `integrity_check()`, 33+ rules). LIVE.
- **Airtable is the staff editing surface.** Every edit reaches Postgres through one validated handler
  (`wf_airtable_change`, n8n 06), or is refused and put back. LIVE.
- **n8n orchestrates side effects through an outbox.** Drive folders (02), Airtable write-backs (03), Xero drafts
  (04/05), the quote hand-off (10). Each is recorded only with read-back proof. LIVE.
- **Nightly reconciliation (07)** compares Airtable, Drive and Xero with Postgres and repairs or escalates. LIVE.
- **The dashboard and the Copilot** read curated views with a least-privilege role; the Copilot has read tools and one
  prepare-only tool. LIVE (the new tools: LOCAL).

## 3. Demonstration script

| # | Show | Where | Label |
|---|---|---|---|
| 1 | `/health`: every service from recorded checks, integrity counts, last reconciliation | dashboard | LIVE |
| 2 | The quote hand-off: synthetic Q-2026-0066 sent from the dashboard, n8n 10 execution 3080, one Airtable record each for quote, customer and site, read back | `evidence/quote-integration-test-20261020.md` | LIVE |
| 3 | A staff edit refused and put back: an illegal status change in Airtable, RoofOps Sync explains | Airtable + dashboard timeline | LIVE |
| 4 | Missed webhook, then recovery: the PRJ-2026-0001 story (observe run found the drift; the repair run applied it through the handler) | `docs/archive/phase6-status.md` §8, §17 | LIVE |
| 5 | Xero safety: pinned Demo tenant, a draft deleted in Xero reconciled to VOIDED, one supervised reissue | `evidence/ac14c-stage3*` | LIVE |
| 6 | The pre-start gate: a job cannot start until SWMS is Done and materials are reviewed; a Note-only edit; two connections racing | `npx vitest run test/pre-start-gate.test.ts` (with `TEST_DATABASE_URL`) | LOCAL |
| 7 | Quote acceptance is deterministic: a duplicated Airtable row is refused; a bad date no longer stalls the queue | `npx vitest run test/workflow.test.ts` | LOCAL |
| 8 | Financial guards: a fully billed job cannot be cancelled; a multi-line reissue waits for per-line GST | `npx vitest run test/cancel-guard.test.ts test/reissue-gst-gate.test.ts` | LOCAL |
| 9 | Copilot: "which jobs are blocked by safety checks?", "which quotes are pending?", then "approve and send the invoice" (refused) and a prompt-injection attempt (refused) | Preview dashboard, or `test/copilot-guards.test.ts` | LOCAL (read tools), LIVE (refusals, Promptfoo 13/13 in Phase 6) |
| 10 | The end-to-end lifecycle at the database boundary: lead → quote → acceptance → project → pre-start → visit → completion → invoice → Xero draft (simulated proof), with failure injections | `npx vitest run test/business-lifecycle.test.ts` | LOCAL |
| 11 | Release discipline: the full-chain rehearsal on a restored hosted backup (31 / 6 / 0, rollback identical) and the approval-gated runbook | `docs/archive/advanced-release-runbook-20261023.md` | LOCAL rehearsal, PLANNED deploy |

## 4. Failure-and-recovery demonstrations (safe, local)

All run on throwaway databases (no hosted access):

- **Duplicate webhook delivery:** `test/state-integrity.test.ts` (20 deliveries, one change).
- **Repeated or concurrent acceptance:** `test/workflow.test.ts` (two connections, one project).
- **A late, stale event:** state-integrity, pre-start-gate (STALE, nothing changes).
- **A failed Airtable write-back, then a retry:** `test/n8n-pre-start-fields.test.ts` (03 never writes over staff values).
- **An ambiguous Xero create:** `test/xero-ambiguous-create.test.ts` (UNKNOWN until a read proves it).
- **A provider outage:** `test/copilot-resilience.test.ts` (bounded retries, then a data-only answer).

## 5. Human in the loop and auditability (3 min)

- Every financial act needs a person: prepare and approve are different people in the dashboard, and the Airtable approve
  is bound to the exact preview. The Copilot can only prepare.
- Every change writes an `audit_events` row: actor, before, after, reason, correlation id. Show the project timeline.
- Approval gates for production: the release runbook lists each 🔒 step; nothing is deployed without the owner.

## 6. Limits to state plainly

- **Airtable account.** One shared Airtable account for staff and RoofOps writes; real use needs seats.
- **Hosted business date.** Synthetic (2026-09-29) until the owner switches it.
- **Xero.** The Demo Company only; per-line GST waits for the n8n 05 deploy and one supervised check.
- **The new controls.** The sprint's controls (pre-start gate, cancellation guards, Copilot tools) are LOCAL until the
  release runbook is approved.
- **RoofOps Lite.** A separate product with its own branch; not part of this demonstration.
