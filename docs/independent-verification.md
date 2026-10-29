# RoofOps: what is genuinely verified (independent-verification preparation)

Checkpoint `8a5bb26`, 2026-10-17. Written by the AI that built the system, so read it as a claimant's statement with
pointers to evidence, not as verification. Evidence was re-read for this document (read-only): hosted Postgres records,
n8n execution history, and the live Airtable base read through a separate Airtable client. Nothing was changed.

**Important limit on evidence.** n8n keeps executions for about a day. Of all the execution IDs quoted in earlier
evidence files, only five are still visible in n8n today (05: 2833, 2851; 06: 2842, 2847, 2848, 2855). Older IDs exist
only where RoofOps itself recorded them (in `outbox.result`), i.e. as the system's own claim. Xero was never read by
anything other than RoofOps's own n8n workflows; no human check of Xero is recorded anywhere.

## 1. Inventory of business workflows

Legend: **Live** = ran on hosted Postgres with real n8n and the real external service. **Local** = only on local
databases, external services simulated by calling the database functions directly. **Indep.** = confirmed outside
RoofOps's own code paths (by a separate client or a person).

| # | Workflow | Hosted Postgres | Real n8n executions | External system confirmed independently | Employee-style browser use | Simulated only |
|---|---|---|---|---|---|---|
| W1 | Staff edit in Airtable → Postgres (06): status, dates, PO status, completion items; RoofOps-owned edits reverted | Yes (29 events) | Yes (06: 2842–2855 still visible) | Airtable records show the results (read today) | Airtable UI edits under the owner's Airtable user `usr7uCnNO15fCefbH`; whether each was a UI click or an API call is **not recorded** | No |
| W2 | Quote Accepted in Airtable → project, Drive folder, Airtable project (01/02/03) | Yes, **3 times, all on 2026-09-28** (PRJ-2026-0031/32/33); none since | Recorded by RoofOps only (1751–1776); pruned from n8n | Airtable projects + quote links + Drive URLs match (read today). Drive itself **not re-checked** | None by an employee | Local `job-journey` |
| W3 | Invoice via Airtable *Invoice Action* (04 → 05) | Yes (INV-2026-0039; prepares/refusals: 20 prepare events) | Recorded only (1788–1801, 1793) | Airtable shows RO-INV-2026-0039 + InvoiceID; **Xero: UNVERIFIED by any independent means** | None | — |
| W4 | Void + reissue of a Xero draft (generation 2) | Yes (INV-2026-0040, 2026-10-08) | Recorded only (2391, 2402) | Airtable shows the new InvoiceID; Xero **UNVERIFIED** independently | None (owner CLI) | Local reissue suites |
| W5 | Dashboard invoice prepare → approve → staff dispatch (09 → 05) | Yes: INV-2026-0041 (supervised), INV-2026-0042 (scheduled) by synthetic EMP-801/802 | **Yes, visible: 05 2833, 2851** | Airtable shows RO-INV-2026-0041/0042 + InvoiceIDs; Xero **UNVERIFIED** independently | Hosted protected preview in a real browser; the owner signed in, the actions were driven by the AI in the browser pane. **No unassisted person** | Local `invoice-approval`, `dispatch-gate` |
| W6 | Reconciliation + webhook supervision (07, daily) | Yes: 73 runs; last repair 2026-10-16 16:30 UTC: 0 drift (6 tables, 3 Drive, 4 Xero) | Recorded only (07 keeps no execution data) | No (it is RoofOps checking itself) | n/a | Local reconcile suites |
| W7 | Exceptions resolved by a person | Yes (EXC-0020/21 by EMP-900, CLI/dashboard) | n/a | n/a | Local `staff-journey` | — |
| W8 | Staff sign-in, roles, sessions, throttle | Yes (8 sign-ins EMP-801/802) | n/a | n/a | Hosted, owner-assisted (as W5) | Local `staff-journey` |
| W9 | Site visits, crew, tasks, next steps, My work (OPS-01) | **No** (migrations not applied) | none needed | n/a | **Never on hosted**; local only | Local `site-work`, `job-journey` |
| W10 | Enquiry → customer/site → inspection → quote → send → Airtable hand-off (n8n 10) → acceptance (SALES-01) | **No** | **n8n 10 has never executed** (validated only) | **Never**: Airtable acceptance of the writes is simulated | **Never on hosted**; local only | Local `sales-journey`, `enquiry-to-quote` |
| W11 | Health checks (08) | Running (active) | Not inspected | — | — | — |
| W12 | Copilot (AI answers) | Smoke-tested earlier (`evidence/phase4-copilot-smoke.json`) | — | — | Local/preview | — |

## 2. Evidence behind each claimed end-to-end success

| Claim | Evidence | Status |
|---|---|---|
| An accepted quote creates exactly one project, Drive folder and Airtable project | Hosted: `workflow_runs` quote_to_project ×3; `outbox` drive/airtable DONE with folder IDs `1cI9mw…`, `1LoiHZ…`, `123xVm…` and records `recDT4dQPmrjy5Mmu`, `reczFqGxwhWTHzpsP`, `recIxvTNChcgkctnx`; Airtable read today shows those records with the Drive URLs and quote links | Verified (Airtable); Drive folders themselves UNVERIFIED today |
| The acceptance was triggered by a person in Airtable | Audit `quote.accept` actor `usr7uCnNO15fCefbH` | UNVERIFIED (UI vs API not distinguishable) |
| Xero drafts RO-INV-2026-0039…0042 exist, are DRAFT, in the Demo Company, with the right amounts | n8n 05 read-back (RoofOps code) stored in `outbox.result`; 07 reconciliation "4 verified"; Airtable mirrors the IDs | **UNVERIFIED independently** (no human or separate client has looked in Xero) |
| Dashboard approval by a second person, then exactly one Xero write | Hosted audit: EMP-801 `invoice.preview_prepared`, EMP-802 `approval.approve` APR-2026-0015/0016, `xero.dispatch_requested`; n8n 05 executions 2833/2851 (visible) | Verified in Postgres + n8n; Xero side UNVERIFIED independently |
| Scheduled (unattended) dispatch works | 05 execution 2851 in `integrated` mode, request claimed by `n8n:09:2850` | Verified once; the request row is still `CLAIMED` (never moved to HANDED_OVER), a loose end |
| Staff Airtable edits are validated, applied or reverted | 29 `airtable_change@1` events; audit `airtable.edit_reverted` CUST-0002; Airtable writes ledger 19 (all Projects table) | Verified for Projects; customer/quote/PO corrections never written live |
| Reconciliation finds and repairs drift | 27 repair runs; reported drift 0 | Self-reported (same code checks itself) |
| Site visits / tasks work | Local Playwright `site-work` 2/2, `job-journey` 1/1; SQL tests | Local only. UNVERIFIED on hosted |
| Sales works end to end | Local `sales-journey` 1/1; rehearsal probes on a restored hosted copy (rolled back) | Local/copy only. Airtable hand-off UNVERIFIED (never ran) |
| 945 tests pass | `npx vitest run` on PGlite + local Postgres | True, but see §5 |

## 3. Dangerous shared components (one change, many effects)

| Component | Why it is dangerous |
|---|---|
| `wf_complete_side_effect` / `_core` (8 definitions over time) | One function records proof for Drive, Airtable project write-back, Xero drafts and now quote publishing. Every migration that touches one topic re-creates the whole function. |
| `wf_claim_side_effect`, `wf_fail_side_effect` | Shared claim/retry/exception logic, incl. Xero "may already exist" handling. SALES-01 initially broke the failure path for a new topic (found in preflight); the same could happen to the next topic. |
| `v_airtable_expected` (6 definitions) | Defines what reconciliation **writes into Airtable daily in repair mode** for 6 tables. A wrong expression silently overwrites staff data base-wide. |
| `wf_airtable_change` / `_core` + `airtable_writes` echo ledger | Every staff edit in Airtable passes here; echo detection depends on timing windows (5 min skew, 30 min) and on every RoofOps writer recording its writes. n8n 10 does not record its writes (safe today only because its values equal canonical). |
| `integrity_check` (14 definitions) | Unknown side-effect topics pass `done_has_proof` by default. |
| `field_contract`, `app_settings` | Data that changes behaviour: ownership, roles, `business_date_override` (**hosted is frozen at 2026-09-29**), `xero.demo_tenant_id`, dispatch roles. |
| Migrations | 52 files, ~14,700 lines; functions are redefined wholesale in later files, so the current definition is spread across history. Hosted equals the repo by checksum. |
| n8n workflows | Field IDs, select-option names and error classification are hand-copied into each workflow (`FAIL_JS` duplicated). Only 05's generation logic has unit tests; n8n 10's code has never run. |
| Integration assumptions | Xero: Demo Company only, account 200 / OUTPUT, always `LineAmountTypes: Inclusive`, contacts matched by `RO-CUST-` number. Airtable: fixed field IDs, single-select option names, webhooks refreshed by 07 (expire after 7 days). |

## 4. Fields more than one system can change

| Field | Writers | Rule | Deterministic? |
|---|---|---|---|
| Project Status | Airtable staff (06); reconciliation | Airtable edit validated by state machine; Postgres canonical | Yes, but **the dashboard cannot change it**: completing a visit in the dashboard does not complete the project; the same real-world event must be entered twice |
| Completion Photos / Compliance Certificate | Airtable staff (06) | Applied via handler; dashboard shows only | Yes |
| Planned start/completion, Project Manager, PO status/delivery/reference | Airtable staff (06) | Applied via handler | Yes |
| Quote Status, Lost Reason | Airtable staff (06/01); RoofOps send (Postgres SENT, n8n 10 writes Sent); reconciliation | Accepted → 01; others → 06 handler; reconciliation repairs via handler | Mostly; a revised quote's amount in Airtable lags until reconciliation; no automatic expiry anywhere |
| Invoice Preview (Airtable) | n8n 04 writes; reconciliation projection (for reissued and, after migration 1, dashboard-approved invoices) | Projection wins on the next repair run | **Eventually consistent, not immediate**: 04 can write text that 07 later replaces (PRJ-2026-0007 shows a stale refusal today, confirmed in Airtable) |
| Customer / property details | RoofOps (dashboard creates, n8n 10 upserts); Airtable edits are reverted | Postgres owns | Deterministic but **there is no screen to correct a customer's details**; a person fixing a phone number in Airtable is reverted daily |
| Approval / invoice action | Airtable *Invoice Action* (04) **and** dashboard prepare/decide **and** staff dispatch (09) **and** reissue dispatch (08) | All end in the same approval rows and 05 | Guarded by idempotency keys and locks; four entry points to one financial action |
| Xero draft after creation | Accountant in Xero; RoofOps reads back | `VERIFY_EXTERNAL` | What RoofOps does when an accountant edits a draft's amount is not exercised live |
| Airtable "Material Review Task" text | Written once by 03 | Never updated | Stale by design (shows "Review materials… due 2026-10-01" after the task is done) |

## 5. Do the tests just repeat the implementation's assumptions?

Partly. The tests are strong where the database is the whole truth: refusals, roles, idempotency, races, state machines,
rounding of RoofOps's own numbers, rollback. They are **self-referential** wherever an external system is involved:
Airtable and Xero responses, field IDs, option names and n8n behaviour are written by the same author as the code and
simulated by calling the database functions with the payload the author expects. Example found this week: Airtable
lacks 7 option values the dashboard produces; every test passed because Airtable was simulated.

Five business failures that can still happen with all 945 tests green:

1. **Wrong dates in real use.** Hosted runs on `business_date_override = 2026-09-29`. Quotes, validity, "in the past"
   checks, overdue tasks and visits all use that date. Tests pin the same date, so they cannot notice.
2. **Job finished but not invoiced (or invoiced early).** Visit completion (dashboard) and project status (Airtable)
   are separate; invoicing is gated by the Airtable status. Nothing reconciles the two.
3. **Integration drift breaks writes silently until someone looks.** Renamed Airtable fields/options, a different
   Xero organisation (account codes, tax types, contact numbering), or expired webhooks. Only live runs detect these;
   tests use the same hard-coded identifiers as the code.
4. **Money that differs by a cent from Xero.** RoofOps sends every invoice as GST-inclusive and compares Xero's tax to
   its own. Quotes priced exclusive of GST (new in SALES-01) have never gone through Xero; a 1-cent rounding difference
   would leave the invoice unconfirmed. Tests compare RoofOps's numbers with RoofOps's formula.
5. **Customer data that cannot be corrected.** No dashboard edit, Airtable edits reverted: staff will correct details
   in Xero or Airtable and fight the reconciler; wrong details propagate to Xero contacts and Drive folder names.

Also possible: the same enquiry recorded twice without a warning (duplicates are checked only against existing
customers, not other enquiries; the "duplicate enquiries" claim covered only a repeated submit of one form); events lost if n8n is down longer than Airtable keeps webhook payloads (7 days; 07 replays only what
Airtable still has); investigation hampered because n8n keeps one day of executions.

## 6. Manual acceptance script

See `docs/manual-acceptance-script.md` (dashboard + Airtable only).

## 7. External code review brief

See `docs/external-review-brief.md`.

## 8. What could be simplified or removed

| Candidate | Why | Keep instead |
|---|---|---|
| Four entry points into a Xero draft (Airtable Invoice Action/04, dashboard + 09, reissue/08, owner CLI) | Most of the financial complexity is coordinating them | One path: dashboard prepare → second-person approve → dispatch. Retire Airtable Invoice Action and 08 |
| Reissue machinery (generations, reissue request/decide, 08, dispatch token) | Built for Demo-company drafts; a pilot can void in Xero and prepare a new invoice | A documented manual void-and-re-prepare procedure |
| Dual system of record for quotes (Airtable + dashboard, n8n 10, Status from Airtable via 01) | Creates most dual-writer rules and the echo ledger's hardest cases | Choose one: either quotes live only in the dashboard (accept there; Airtable read-only projection) or only in Airtable |
| `_core` wrapper layering and functions redefined 8–14 times | Current behaviour is spread across migrations | After the pilot baseline, squash into one schema file per area |
| Demo-only features in the pilot build (business date override, demo reset, shared demo login, demo guide) | They change behaviour of real use (dates) | Keep only in a demo environment |
| Copilot | Optional, adds an external AI dependency | Disable for the pilot unless explicitly wanted |
| `integrity_check` default `else true` | Hides unchecked topics | Fail closed for unknown topics |

## Assessment

- **Genuinely working against the real services (at least once, recorded):** Airtable edits to Postgres (W1), the
  quote-to-project automation (W2, three runs on one day), Xero Demo draft creation through the Airtable path, the
  reissue path and the dashboard approval/dispatch path (W3–W5, five drafts), daily reconciliation (W6), staff sign-in
  (W8). Of these, only the Airtable side has been confirmed by a reader other than RoofOps itself, and no workflow has
  been used by an employee who is not the owner.
- **Only locally tested:** site visits and tasks (W9) and the whole Sales workflow including n8n 10 (W10).
- **Unverified:** any independent look at Xero; whether Airtable acceptances were UI actions; Drive folders today;
  exclusive-GST invoices; real-calendar behaviour; a production Xero organisation; use by real staff; behaviour after
  long n8n outages.
- **Not production-ready.** The core automation has worked in the Demo environment under supervision; the newest
  workflows have never touched the real services, and the pilot environment still runs on a frozen demo date.
