# RoofOps adversarial test catalogue

> **Status: hypotheses, not fixes.** Feature development is frozen and nothing here has been fixed. This is the 30
> highest-value failure hypotheses salvaged from an adversarial review of RoofOps. Each one is a test to write. None has
> been reproduced against the live systems.

## Where these came from

- 14 independent reviewers were launched, one per workstream, and the run was then stopped. **9 finished**:
  WS01 domain state, WS02 Airtable user behaviour, WS03 state machines, WS05 duplicate/delayed/out-of-order events,
  WS06 external failures, WS07 reconciliation, WS08 Xero/financial safety, WS09 Google Drive, WS10 stale UI.
  **5 did not report**: WS04 concurrency, WS11 security/auth, WS12 Copilot accuracy, WS13 malformed input,
  WS14 import/migration. Those areas are only partly covered here, through overlap with the other workstreams.
  WS04's saved probe files independently target AC-01, AC-03, AC-07 and AC-10.
- **The skeptic pass did not complete.** De-duplication, the test-coverage check (against the 268 existing test cases
  and 13 Promptfoo cases) and the ranking below were done in the main session, from the reviewers' own evidence.
- **Confidence:** HIGH means a reviewer reproduced the defect with an offline PGlite probe (the real migrations plus the
  real import bundle). MEDIUM means it is inferred from code or n8n node wiring but was not probed. LOW means it depends
  on external behaviour that was not observed.
- The probe scripts are kept in the session scratchpad under `adv/probes/wsNN/` and are named in each scenario. Raw
  reviewer output is in `adv/salvage-raw.json`. Scratchpad root:
  `C:/Users/suhee/AppData/Local/Temp/claude/D--Claude-roofops/3c0faa07-0e47-43ff-8ca9-b6c33c091b55/scratchpad/`.

| | Count |
|---|---|
| Raw findings from the 9 completed reviewers | **121** |
| Folded in as duplicates or close variants of another finding | **67** |
| Already covered by an existing test (same sequence and invariant) | **0** (9 extend mechanisms that already have tests; kept as variants) |
| Distinct, genuinely new hypotheses | **54** |
| Kept in this catalogue (cap) | **30**: P0 12 · P1 13 · P2 5 · P3 0 |
| Cut by the cap (listed in the appendix) | 24 |

Priorities: **P0** money, data corruption, security · **P1** incorrect business state · **P2** reliability/recovery ·
**P3** UX/stale presentation.

---

## P0: money, data corruption, security

### AC-01 · P0 · The reconciler replays a stale Airtable snapshot over a newer staff edit

- **Failure hypothesis.** n8n 07 reads Airtable pages, and only later calls `wf_reconcile_airtable`. A staff edit that
  06 applies in that gap is treated as drift. The replay runs as `source='reconciler'`, which skips the STALE and
  compare-and-set checks, so the old snapshot value overwrites the newer edit. The replay also stamps
  `external_field_versions.last_source_at = now()`, so a genuinely newer webhook delivered afterwards is discarded as
  STALE, and the drift is hidden.
- **Why current tests may miss it.** `state-integrity.test.ts:327` builds its snapshot at the moment of the reconcile
  call. No test applies a webhook edit between the read and the compare, and no test delivers a webhook after a replay.
- **Systems.** n8n 07, n8n 06, `wf_reconcile_airtable`, `wf_airtable_change`, Airtable Projects.
- **Safe reproduction.** PGlite: take the snapshot, apply two staff edits with `wf_airtable_change`, reconcile with the
  old snapshot, then deliver one more edit (`ws07/p2_stale_snapshot.mts`, `ws05/p2-reconcile.mts`).
- **Invariant.** A replay never applies a value older than the field's last applied external change. After the
  sequence, canonical equals the staff member's latest edit.
- **Confidence.** HIGH. Found independently by 4 reviewers. The probe showed both old values re-applied
  (On Hold → In Progress, 2026-12-18 → 2026-10-01).

### AC-02 · P0 · The reconciler treats missing or reshaped Airtable fields as staff edits

- **Failure hypothesis.** The Airtable API leaves blank cells, and field ids that no longer exist, out of `fields`. The
  reconciler reads an absent key as null and replays it as "staff blanked it". So one deleted or recreated field wipes
  planned dates, expected deliveries and supplier references for every record in a single run. Separately, switching a
  date field to "include time" makes Airtable return UTC instants. `'2026-10-04T14:00:00.000Z'::date` lands on the
  previous Brisbane day, and the corrected value feeds the next night's shift, so dates move back one day per run.
- **Why current tests may miss it.** The `snapshot()` helper always includes every expected field id, and every test
  feeds `YYYY-MM-DD` strings. No test drops a key, sends an instant, or runs reconcile twice.
- **Systems.** n8n 07, `wf_reconcile_airtable`, `at_norm`, `project_apply_change`/`po_apply_change`, Airtable Projects
  and Purchase Orders.
- **Safe reproduction.** PGlite: remove keys from every snapshot record (`ws07/p1_missing_field.mts`), and feed
  Brisbane-midnight instants for two consecutive runs (`ws07/p3_order_and_tz.mts`). For Airtable's own behaviour, use a
  sandbox copy of the base only.
- **Invariant.** A field id missing from a read is never a staff edit. A reconcile run never changes a canonical date
  when the Airtable value denotes the same business-timezone day. N runs with no staff edits change nothing.
- **Confidence.** HIGH. In the probe, one repair run left 8/30 planned completions, 18/30 starts, 3/35 ETAs and
  0/35 supplier references.

### AC-03 · P0 · An Airtable "Approve" is bound to neither the row nor the preview the approver saw

- **Failure hypothesis.** The 04 decision event carries no approval number or preview hash. `wf_invoice_decide` looks
  the project up by the `Project Number` cell value (not the record id) and approves whichever `CREATE_INVOICE` approval
  is PENDING at processing time. So each of these approves money the approver never saw: a Copilot/dashboard prepare
  made after the approver clicked (the Copilot never writes Airtable's Invoice Preview text); an edited or pasted
  Project Number cell; or 04 running every Prepare in a batch before any Decide (n8n v1 execution order).
- **Why current tests may miss it.** `invoice.test.ts:127` follows the re-prepare with a reject, not an approve, and
  every event comes from one source. No test mixes a Copilot prepare with an Airtable approve, or approves from a row
  whose record id belongs to another project.
- **Systems.** Airtable Projects (Invoice Action, Project Number), n8n 04, `wf_invoice_decide`, Copilot
  `prepare_invoice`, outbox → n8n 05 → Xero Demo.
- **Safe reproduction.** PGlite: prepare from Airtable, make it stale, re-prepare as `dashboard:copilot`, then decide
  from Airtable with no approval number (`ws08/p4.mts` section J, `ws05/p4-approve.mts`). Also decide with a payload
  whose record id and project number disagree. Never run 05.
- **Invariant.** An approval executes only when the decision names the approval number (or payload hash) displayed to
  the approver, for the project whose Airtable record sent the event.
- **Confidence.** HIGH for the Postgres binding (the probe approved APR-2026-0002, which was never shown in Airtable).
  MEDIUM for the batch-ordering variant, which is inferred from the deployed 04 wiring.

### AC-04 · P0 · A Xero draft that really exists is recorded as never created

- **Failure hypothesis.** Three paths leave a live, unlinked RO-INV draft in Xero while RoofOps shows
  "failed safely":
  - TIMEOUT sets sync UNKNOWN, a later 429 resets it to PENDING, and a final failure dead-letters to FAILED.
  - A correct multi-line draft is refused at read-back over a 1-cent GST difference, because RoofOps rounds GST on the
    total and Xero rounds per line.
  - An ambiguous create is never checked, because reconciliation reads only invoices that already have a verified Xero
    link.

  A later retry or re-prepare can then create a second draft.
- **Why current tests may miss it.** `invoice.test.ts:154` checks one TIMEOUT → UNKNOWN only. No test sends a different
  error class after an ambiguous one, dead-letters after ambiguity, uses more than one invoice line, or checks what
  reconciliation reads for a FAILED invoice.
- **Systems.** n8n 05, `wf_fail_side_effect`, `wf_complete_side_effect`, `wf_reconcile_targets`, n8n 07, Xero Demo,
  dashboard.
- **Safe reproduction.** PGlite with a fake pinned tenant: approve PRJ-2026-0004, then fail with TIMEOUT, RATE_LIMITED,
  RATE_LIMITED, RATE_LIMITED, UPSTREAM_5XX, reading `sync_status` and `wf_reconcile_targets` each time
  (`ws06/p1_xero.mts`). For GST, compute per-line vs header tax on a quote-plus-variation invoice. The Xero side goes
  in the Demo Company only.
- **Invariant.** After any ambiguous attempt, the invoice stays "may exist in Xero" until a read proves presence or
  absence. Every Xero draft whose Reference is a RoofOps project maps to exactly one RoofOps invoice.
- **Confidence.** HIGH for the state downgrade (probe: UNKNOWN → PENDING → FAILED, not reconciled). MEDIUM for the GST
  cent difference and the reconciliation blind spot.

### AC-05 · P0 · Voiding an invoice does not cancel its queued Xero write

- **Failure hypothesis.** APPROVED → VOIDED is allowed, and nothing ties the outbox to the invoice's business status.
  05 still creates the draft, `wf_complete_side_effect` records it SYNCED on the VOIDED invoice, and the dashboard
  offers the project as READY_TO_INVOICE again, inviting a second invoice.
- **Why current tests may miss it.** No test voids an invoice while its side effect is pending. The cancellation tests
  (`state-integrity.test.ts:245`, `:409`) cover previews only.
- **Systems.** Postgres invoices/outbox, `wf_complete_side_effect`, n8n 05, Xero Demo, `v_dashboard_projects`,
  `integrity_check`.
- **Safe reproduction.** PGlite: approve PRJ-2026-0004, void the invoice, claim, then complete with synthetic proof
  (`ws08/p4.mts` section K).
- **Invariant.** No Xero draft is created or linked for a VOIDED invoice. Voiding either cancels the pending outbox row
  or is refused while sync is PENDING/UNKNOWN.
- **Confidence.** HIGH. The probe ended with VOIDED + SYNCED, the dashboard showed READY_TO_INVOICE, and
  `needs_attention` was false.

### AC-06 · P0 · Unpinning the Xero tenant is not a kill switch

- **Failure hypothesis.** The tenant id is copied into the outbox payload at approval time, and 05 and
  `wf_complete_side_effect` trust the payload. Clearing `xero.demo_tenant_id` (the documented "no writes possible"
  state) does not stop approved or retrying writes. Re-pinning to a new tenant strands queued rows on the old one.
- **Why current tests may miss it.** `invoice.test.ts:84` checks that decide is refused while unpinned, but only before
  approval. No test unpins or re-points the tenant after approval.
- **Systems.** Postgres `app_settings`, outbox, `wf_claim_side_effect`/`wf_complete_side_effect`, n8n 05, Xero.
- **Safe reproduction.** PGlite: pin a fake tenant, approve, clear the pin, then claim and complete with proof carrying
  the old tenant (`ws08/p1.mts` section A). Never run 05.
- **Invariant.** With the pin empty, or different from `payload.xero_tenant_id`, no `xero.*` row can be claimed and no
  proof is accepted.
- **Confidence.** HIGH. The probe returned `claimed=true` and RECORDED, and the invoice became SYNCED.

### AC-07 · P0 · An expired outbox lease has no fencing: two workers, two external objects

- **Failure hypothesis.** The outbox stores no lease owner, and completion does not check who holds the claim. A 05 run
  can take up to 9 Xero calls × 20 s, which exceeds the 180 s lease, so a re-drive can re-claim the row. Both workers
  create a draft. The first completion is recorded and the second returns ALREADY_DONE without error, then writes its
  own InvoiceID to Airtable. The same applies to 02 and Drive folders: a verified folder is refused, or a second folder
  is silently orphaned.
- **Why current tests may miss it.** `invoice.test.ts:193` treats a mismatching second InvoiceID as a benign duplicate.
  No test steals a lease.
- **Systems.** Postgres outbox (`wf_claim_side_effect`, `wf_complete_side_effect`, `wf_fail_side_effect`), n8n 05/02,
  Xero Demo, Google Drive, Airtable.
- **Safe reproduction.** PGlite: claim as A, move `locked_until` into the past, claim as B, complete A with X1 and B
  with X2 (`ws08/p5.mts` section M, `ws04/p4-outbox-no-fencing.mts`). Any live check uses a copied, unpublished 05
  against the Demo Company only.
- **Invariant.** Only the current lease holder (by attempt or claim token) can complete or fail a side effect. A
  different external id at completion opens a mismatch exception. There is at most one live Xero invoice per RoofOps
  invoice.
- **Confidence.** HIGH for the Postgres half. MEDIUM that real 05 timing overruns the lease.

### AC-08 · P0 · Over-billed projects are labelled "Fully invoiced", with no flag, and can be closed

- **Failure hypothesis.** When billed-to-date exceeds quote + variations (for example the deposit billed twice on
  PRJ-2026-0006 and PRJ-2026-0008: $30,888.72 billed against $25,740.60), `invoice_final_preview` reports "nothing left
  to invoice". The dashboard shows FULLY_INVOICED (green), with no blocker and `needs_attention=false`, and the
  project can reach CLOSED with no credit note. Asking to prepare opens a permanent exception misdescribed as a
  supplier-totals problem.
- **Why current tests may miss it.** `dashboard.test.ts:34` **asserts** PRJ-2026-0006 is FULLY_INVOICED with a null
  blocker. The existing test enshrines the defect.
- **Systems.** `invoice_final_preview`, `v_dashboard_projects`, `project_transition_guard`, dashboard, Copilot.
- **Safe reproduction.** PGlite on the imported bundle: read the preview and dashboard row for PRJ-2026-0006, mark its
  invoices PAID, then try CLOSED (`ws08/p2.mts`, `ws08/p3.mts`).
- **Invariant.** Billed-to-date ≤ quote + approved variations. Otherwise the project needs attention with a named
  over-billing reason, and CLOSED is refused until a credit or void is recorded.
- **Confidence.** HIGH. Found by 2 reviewers and shown by the probe.

### AC-09 · P0 · The final invoice under-bills once a variation is marked INVOICED

- **Failure hypothesis.** The final amount adds only variations with status APPROVED, but subtracts every billed
  invoice, including VARIATION invoices. Moving a billed variation to its terminal state INVOICED makes the final
  invoice short by exactly that variation.
- **Why current tests may miss it.** `invoice.test.ts:127` inserts an APPROVED variation only to prove staleness. No
  test uses INVOICED or a VARIATION-type invoice.
- **Systems.** `invoice_final_preview`, `wf_invoice_decide`, n8n 04/05, Xero Demo.
- **Safe reproduction.** PGlite, in a rolled-back transaction: add a $1,100 variation and its VARIATION invoice, then
  compare the preview before and after setting the variation to INVOICED (`ws01/p3_money.mts` S8).
- **Invariant.** Final = quote + all customer-approved variations (APPROVED or INVOICED) − everything billed. The
  result is independent of the variation's status label.
- **Confidence.** HIGH. The probe gave 14,664.49 → 13,564.49, exactly $1,100 short.

### AC-10 · P0 · 06 applies its own stale correction back as a staff edit, and ping-pongs forever

- **Failure hypothesis.** `wf_airtable_change` computes an item's Airtable correction when it processes that item, but
  n8n writes the correction only after later items in the same batch have moved canonical. The echo of that stale
  write passes compare-and-set, is applied as a staff edit, and every redelivery flips canonical again. A related
  symptom: a staff member who fixes their own refused edit before the correction lands is told someone else changed
  it.
- **Why current tests may miss it.** `state-integrity.test.ts:218` echoes a value that still equals canonical, and
  `:203` redelivers with nothing in between. No batch has a later item change canonical first.
- **Systems.** n8n 06, `wf_airtable_change`, `wf_airtable_writeback_verified`, Airtable Projects, audit chain.
- **Safe reproduction.** PGlite: call `wf_airtable_change` in n8n's batch order, and build the echo from the returned
  corrections (`ws05/p1-pingpong.mts`, `ws04/p3-stale-correction-echo.mts`).
- **Invariant.** A value RoofOps wrote is never applied back as a staff edit. After the staff member's last edit,
  canonical and Airtable converge within one run and the cursor advances.
- **Confidence.** HIGH. In the probe, runs 2–5 each applied the echo, and PRJ-2026-0009's date kept flipping.

### AC-11 · P0 · The Drive identity is not pinned, so a re-authorised credential forks a new root

- **Failure hypothesis.** Unlike Xero, nothing pins the Drive root id, the Google account or the OAuth client. The root
  is found through `appProperties`, which are private to the OAuth client. So re-authorising the n8n credential with
  another account or client, or moving the root into a shared drive, makes 00's daily run create a new "RoofOps Demo"
  root. Customer folders then go to the new location while health stays green.
- **Why current tests may miss it.** No test covers n8n 00. There is no Drive equivalent of the Xero tenant pin test
  (`state-integrity.test.ts:387`).
- **Systems.** n8n 00/02/07/08, Google Drive, Postgres `app_settings`, health.
- **Safe reproduction.** Two throwaway Google accounts, with copied, unpublished 00 and 08 on a test credential. Create
  the root with account A, reconnect to B, and run the copies.
- **Invariant.** Drive writes happen only when the credential identity and the root id match values pinned in Postgres.
  00 never creates a root while any project has a verified Drive link.
- **Confidence.** MEDIUM.

### AC-12 · P0 · Folder read-back never checks sharing: customer folders can be public and still "verified"

- **Failure hypothesis.** 02, 07 and 98 verify id, name, parents, trashed and `appProperties`, but never permissions,
  `shared` or the owner. If the root or a project folder is shared as "Anyone with the link", every customer folder
  inherits that access, and RoofOps keeps reporting a verified, healthy Drive.
- **Why current tests may miss it.** The proof shape (`workflow.test.ts:27`) has no permissions field, and the proof
  refusals at `:176` have no permission dimension.
- **Systems.** Google Drive permissions, n8n 02/07/98, `wf_complete_side_effect`, Airtable Drive Folder.
- **Safe reproduction.** A throwaway Google account and a copied, unpublished 02 on a test credential. Share the test
  root with anyone-with-link, run the copy, and check that the proof passes.
- **Invariant.** A folder is verified only if its effective permissions contain no anyone/anyoneWithLink grant and no
  grantee outside an allow-list. 07 raises a finding when that changes.
- **Confidence.** LOW (it depends on how the root is shared). The check is missing by construction.

## P1: incorrect business state

### AC-13 · P1 · Checklist gates have no editing surface: new jobs can never be invoiced, and start without a signed SWMS

- **Failure hypothesis.** `wf_quote_accepted` creates required COMPLETION items (COMPLETION_PHOTOS,
  COMPLIANCE_CERTIFICATE) and PRE_START items (SWMS_SIGNED, MATERIALS_REVIEWED) as OPEN, and nothing can mark them DONE
  or WAIVED. Every RoofOps-born project therefore hits MISSING_DOCUMENT forever once completed, and the blocker tells
  staff to upload documents that no signal reads. Meanwhile SCHEDULED → IN_PROGRESS checks only Planned Start, so a job
  starts with the SWMS unsigned.
- **Why current tests may miss it.** `workflow.test.ts:45` only counts the checklist items. The invoice tests use
  imported PRJ-2026-0004/0005, whose items are already DONE.
- **Systems.** `wf_quote_accepted`, `project_checklist_items`, `invoice_final_preview`, `project_transition_guard`,
  Airtable, Copilot, `/projects/[number]`.
- **Safe reproduction.** PGlite: accept a quote, walk the new project to COMPLETED, then call `wf_invoice_prepare`
  (`ws03/p2_lifecycle.mts` section A).
- **Invariant.** Every required gate has a supported path to satisfy or waive it. A project born from quote acceptance
  can reach READY_TO_INVOICE. A job cannot enter IN_PROGRESS with a required pre-start item OPEN.
- **Confidence.** HIGH. Found by 3 reviewers. In the probe, PRJ-2026-0031 was refused with MISSING_DOCUMENT.

### AC-14 · P1 · The invoice lifecycle stops at APPROVED: "money owed" is wrong, and CLOSED is unreachable

- **Failure hypothesis.** A RoofOps FINAL invoice is created APPROVED, and no path (n8n 05, reconciliation, payment
  sync) ever moves it to ISSUED or PAID. "Money owed" and "overdue" count only ISSUED/PARTIALLY_PAID, so an invoice
  that was sent, or even paid, in Xero is invisible there. `nothing_left_to_bill` requires every invoice PAID or VOIDED,
  so COMPLETED is absorbing: CLOSED is refused for all 8 completed projects, and after a FINAL invoice exists Cancelled
  is blocked too.
- **Why current tests may miss it.** `state-integrity.test.ts:110-149` forces the row shapes with
  `session_replication_role` and checks guards pairwise. It never asks whether realistic invoice states can satisfy
  the guard. `invoice.test.ts` stops at SYNCED.
- **Systems.** `project_transition_guard`, invoice state machine, money-owed views, Xero Demo, Airtable Status.
- **Safe reproduction.** PGlite: evaluate `project_transition_guard(p,'CLOSED')` for every COMPLETED project, before
  and after a synthetic Xero-synced FINAL invoice (`ws03/p1_guards.mts`, `ws03/p3_xero.mts`, `ws01/p5_owed.mts`).
- **Invariant.** Every COMPLETED project has a supported sequence of actions that reaches CLOSED. An invoice the
  customer has been sent counts in money owed.
- **Confidence.** HIGH.

### AC-15 · P1 · The Completed → Cancelled guard ignores imported (untyped) final bills

- **Failure hypothesis.** `no_final_invoice` looks only for `invoice_type='FINAL'`, and every imported invoice has a
  NULL type. So PRJ-2026-0008, billed to 100%+ with $49,739.70 outstanding, can be cancelled from Airtable, which
  leaves a receivable on a "Cancelled" job.
- **Why current tests may miss it.** `state-integrity.test.ts:256` blocks cancellation only after inserting an
  explicitly FINAL-typed invoice. The PRJ-2026-0001 case is a partly billed job.
- **Systems.** `project_transition_guard`, `wf_airtable_change`, n8n 06, Airtable Projects, imported invoices.
- **Safe reproduction.** PGlite: import, link, then send Status "Cancelled" for PRJ-2026-0008 through
  `wf_airtable_change` (`ws03/p1_guards.mts`).
- **Invariant.** A COMPLETED project whose billed-to-date reaches the contract value, or which has any ISSUED or
  PARTIALLY_PAID invoice, cannot be cancelled.
- **Confidence.** HIGH. Found by 2 reviewers. The probe applied the cancellation, leaving $49,739.70 outstanding.

### AC-16 · P1 · Changes made in Xero never change RoofOps state

- **Failure hypothesis.** `wf_reconcile_external` flags only 404, DELETED/VOIDED, or a changed Total/Reference. A draft
  that is approved (AUTHORISED), submitted or paid in Xero, or whose contact, tax type or due date changes while the
  total stays the same, counts as "verified, in sync". A voided or deleted draft only opens an exception, and the
  invoice stays SYNCED (SYNCED → UNKNOWN never runs). The job then can be neither re-invoiced nor cancelled.
- **Why current tests may miss it.** No test calls `wf_reconcile_external` for XERO; the only such test uses DRIVE
  (`state-integrity.test.ts:357`). `invoice.test.ts:167` checks AUTHORISED only at creation-time read-back.
- **Systems.** n8n 07, `wf_reconcile_external`, Xero Demo, `/health`, `/projects/PRJ-2026-0004`, Copilot, Airtable
  projection.
- **Safe reproduction.** PGlite: feed synthetic Xero reads with AUTHORISED, PAID, VOIDED and a changed contact
  (`ws07/p4_external.mts`). Live only by approving a throwaway draft in the Demo Company.
- **Invariant.** Any Xero status other than DRAFT, or any change to contact or tax, produces a finding or a canonical
  update. `verified_count` excludes such invoices. A voided Xero draft moves sync away from SYNCED.
- **Confidence.** HIGH. In the probe, AUTHORISED and PAID both returned `verified:1`, `drift:0`.

### AC-17 · P1 · The reconciler replays the final value, not what happened

- **Failure hypothesis.** After missed webhooks (quota hit, expired webhook, n8n outage), 07 replays only the latest
  Airtable value, one field at a time in `field_contract` order, as actor `reconciliation`. This goes wrong three ways:
  - A legal sequence Scheduled → In Progress → Completed collapses into an illegal jump, which is REJECTED_AND_REPAIRED:
    Airtable is forced back to Scheduled and the finished work disappears.
  - A whole-schedule shift fails on its first field.
  - A missed PO approval by the mapped approver is refused, because `reconciliation` is not an approver, while the
    observe run labels it SAFE_AUTO_REPAIR.
- **Why current tests may miss it.** `state-integrity.test.ts:327` replays one legal single-step change. No test
  replays a value several steps ahead, a multi-field shift, or an approver-gated edit.
- **Systems.** n8n 07, `wf_reconcile_airtable`, `project_apply_change`/`po_apply_change`, Airtable Projects and
  Purchase Orders.
- **Safe reproduction.** PGlite: a snapshot with PRJ-2026-0011 Status "Completed" (`ws06/p3_collapse.mts`); a shifted
  start and completion pair; a missed PO Approved (`ws07/p5_po_approval.mts`).
- **Invariant.** A missed edit that is not a legal single step, or that needs a human actor, becomes REQUIRES_HUMAN
  and Airtable is left alone. The reconciler never reverts a staff-entered forward status as a "safe" repair.
- **Confidence.** HIGH.

### AC-18 · P1 · A redelivered quote acceptance, rejected while the quote was Draft, later creates a project

- **Failure hypothesis.** `wf_quote_accepted` releases its idempotency claim on rejection and re-checks against the
  quote's current status. Suppose an acceptance made while the quote was Draft is rejected, and staff later move the
  quote to Sent. A redelivery, drain or `replay_from_cursor` of the old event then creates a project, so the same
  event_id gets a different outcome.
- **Why current tests may miss it.** `workflow.test.ts:129` redelivers a rejected fact only while the quote stays
  rejected. No test changes the quote between two deliveries of the same event_id.
- **Systems.** Airtable Quotes, n8n 01/06/07 drain, `wf_quote_accepted`, `processed_events`, outbox (Drive, Airtable).
- **Safe reproduction.** PGlite: deliver an acceptance while the quote is Draft, change Draft → Sent, redeliver the
  same event_id (`ws05/p3-quote.mts`).
- **Invariant.** A redelivery of an event_id always returns its first outcome. An event older than the quote's last
  status change never creates a project.
- **Confidence.** HIGH. The probe returned INVALID_STATE, then CREATED PRJ-2026-0031, for the same event_id.

### AC-19 · P1 · A multi-field Airtable transaction is applied field by field

- **Failure hypothesis.** Each field in one transaction is validated against the other fields' pre-transaction values,
  with Status always first. This causes three failures:
  - Moving a job earlier by pasting both dates rejects the completion and applies the start, turning a 5-day job into
    a 23-day one.
  - "Planned Start + In Progress" in one edit is refused.
  - Pasting a whole row (or restoring a revision) reverts the identity fields (Project Number, Quote, Customer), but
    still applies another job's Status, PM and Planned Start.
- **Why current tests may miss it.** `state-integrity.test.ts:268-270` changes each date in a separate event. No event
  carries several editable fields, or identity and editable fields together.
- **Systems.** Airtable Projects, n8n 06, `wf_airtable_change`, `project_apply_change`, `v_project_risk`.
- **Safe reproduction.** PGlite: one `wf_airtable_change` event with both dates; one with Status plus Planned Start;
  one with every field of another project (`ws02/p1_multi.mts`, `ws02/p2_identity.mts`).
- **Invariant.** One Airtable transaction is validated against its combined post-transaction values and applied all or
  nothing. A transaction that changes identity fields applies nothing.
- **Confidence.** HIGH. In the probe, the earlier shift was PARTIALLY_APPLIED as 2026-10-05 → 2026-10-28.

### AC-20 · P1 · A voided final invoice can never be replaced

- **Failure hypothesis.** After the FINAL invoice is voided (for example, the accountant deletes the wrong draft), the
  dashboard says READY_TO_INVOICE with the full amount. But `wf_invoice_prepare` short-circuits on the old EXECUTED
  approval (ALREADY_INVOICED), `UNIQUE invoice:final:<project>` forbids a replacement, Airtable still says "Xero draft
  created", and CLOSED is refused because the final invoice "has not been raised".
- **Why current tests may miss it.** `invoice.test.ts:121` proves a second FINAL is impossible, but never voids the
  first. No test voids a FINAL invoice at all.
- **Systems.** `wf_invoice_prepare`, `invoice_final_preview`, `invoices` unique key, `invoice_xero_state`, n8n 04,
  Airtable, dashboard, Copilot.
- **Safe reproduction.** PGlite: approve and complete PRJ-2026-0004, void it, then read the dashboard, prepare, and
  try CLOSED (`ws08/p1.mts` section D).
- **Invariant.** The readiness shown on the dashboard equals what prepare will do. A voided FINAL invoice either allows
  exactly one replacement or shows a named blocker. A voided invoice is never projected as "Xero draft created".
- **Confidence.** HIGH.

### AC-21 · P1 · Purchase-order guards: POs advance on cancelled jobs, and imported DRAFT POs need no approver

- **Failure hypothesis.** `po_apply_change` has no project-status guard, and cancelling a project does not touch its
  POs. So a PO on a CANCELLED job can still be approved, sent, re-dated or acknowledged, while the dashboard reports
  materials as JOB_COMPLETE. Separately, the ADR-015 IMPORT exemption also skips the "RoofOps approver only" rule for
  approvals made after import. Any Airtable user can approve the 7 imported DRAFT POs, and no approver is recorded.
- **Why current tests may miss it.** `state-integrity.test.ts:300-315` covers PO transitions on active projects only.
  The cancel-cascade test (`:245`) checks approvals and tasks, not POs. The approver test uses a RoofOps-origin PO.
- **Systems.** `po_apply_change`, `project_apply_change` cancel cascade, purchase_order machine, Airtable Purchase
  Orders, n8n 06, dashboard `material_status`.
- **Safe reproduction.** PGlite: cancel a project, then send PO Approved, Sent, ETA and Acknowledged edits
  (`ws03/p2_lifecycle.mts` section D). Approve an imported DRAFT PO as a non-approver.
- **Invariant.** No PO moves forward, and no ETA changes, while its project is CANCELLED or CLOSED. Every PO approval
  records a mapped approver, whatever the PO's origin.
- **Confidence.** HIGH. Found by 3 reviewers.

### AC-22 · P1 · One Copilot request that prepares two projects shows the first project's invoice under the second's name

- **Failure hypothesis.** `prepareInvoice` builds `event_id = dashboard:copilot:<requestId>` from one per-request UUID.
  A second `prepare_invoice` in the same request is treated as a transport redelivery, returns the first project's
  cached preview, and the card labels it with the second project's number. Two quick "Prepare with Copilot" clicks
  overlap and re-prepare the first project in the same way.
- **Why current tests may miss it.** `copilot-tools.test.ts:66` uses two request ids for the same project. No test
  prepares two different projects under one request id.
- **Systems.** `/api/copilot`, `web/lib/copilot/tools.ts`/`agent.ts`, `AskButton`, `wf_invoice_prepare`,
  `processed_events`.
- **Safe reproduction.** PGlite, in a rolled-back transaction: call `TOOLS.prepare_invoice` for PRJ-2026-0005, then
  PRJ-2026-0004, with the same `ctx.requestId` (`ws10/p2_collision.mts`). No DeepSeek call is needed.
- **Invariant.** For every card, `preview.project_number == card.project`. Each distinct project asked for gets its own
  approval, or an explicit refusal.
- **Confidence.** HIGH. The probe's card for PRJ-2026-0004 carried PRJ-2026-0005's $17,831.91 preview.

### AC-23 · P1 · A staff-typed "Accepted On" back-dates acceptance, or crashes 01 and stalls every later acceptance

- **Failure hypothesis.** Accepted On is RoofOps-owned, but n8n 01 reads it from the Airtable cell. A date between
  Sent On and today becomes the canonical acceptance date, with no audit trail. A date before Sent On violates
  `quotes_check4`, and the function raises instead of returning REJECTED. No exception is logged, the 01 cursor never
  advances, and every later quote acceptance in the base is stuck behind that payload.
- **Why current tests may miss it.** `workflow.test.ts:12` always sends `accepted_on` = today. No test sends a past
  date, and none checks the cursor after a function error.
- **Systems.** Airtable Quotes, n8n 01, `wf_quote_accepted`, 01 payload cursor.
- **Safe reproduction.** PGlite: `wf_quote_accepted` for Q-2026-0041 with `accepted_on` 2026-01-02, and again with a
  date between Sent On and today. The cursor half uses a copied 01 against local Postgres.
- **Invariant.** A value from an Airtable cell always leads to a handled outcome (REJECTED plus one exception). A
  RoofOps-owned date is never read from Airtable. One bad payload never blocks later ones.
- **Confidence.** HIGH for the crash and the back-dating. MEDIUM that the 01 cursor stalls.

### AC-24 · P1 · Risk signals switch off when data is removed or re-planned

- **Failure hypothesis.** Several edits make a late job look fine:
  - Clearing Planned Completion on an active job, or Expected Delivery on an open PO, is accepted, and the NULL
    comparisons turn off "overdue" and "late materials".
  - Marking a PO Partially Delivered drops the delivery-after-start reason, although the remainder still arrives
    late.
  - A started job moved In Progress → On Hold → Scheduled keeps its `actual_start_date`, and every start-related
    signal requires it to be NULL.
  - A hold/re-plan loop yields an In Progress job with no dates.
- **Why current tests may miss it.** The date tests only move dates to other dates. No test clears a date, records a
  partial delivery, or re-schedules a started job, and then reads `v_project_risk`.
- **Systems.** Airtable Projects/POs, n8n 06, `project_apply_change`/`po_apply_change`, `v_project_risk`, dashboard,
  Copilot.
- **Safe reproduction.** PGlite: clear PRJ-2026-0020's Planned Completion and PO-2026-0010's ETA; mark PO-2026-0013
  Partially Delivered; walk a started job to Scheduled with a past start. Compare the risk rows before and after
  (`ws01/p2_risk.mts`, `ws03/p5_sched.mts`).
- **Invariant.** A risk flag never goes from true to false because data was deleted, partially recorded or re-labelled.
  An active job always has planned dates, and a re-scheduled job is judged against its new start.
- **Confidence.** HIGH. In the probe, completion_overdue went true → null and supplier_delivery_late went
  true → false.

### AC-25 · P1 · A duplicated Airtable quote record keeps edits and can drive an acceptance

- **Failure hypothesis.** "Duplicate record" creates a new record id that copies the Quote Number and RoofOps ID. Edits
  on the duplicate get UNKNOWN_RECORD and are never reverted, so it can show a revised amount indefinitely. Accepting
  the duplicate converts the original quote at the canonical price, so staff and customer saw one price and RoofOps
  bills another.
- **Why current tests may miss it.** `workflow.test.ts:138` checks a RoofOps ID mismatch, but a duplicate copies the
  matching id. `state-integrity.test.ts:222` checks that an unknown record opens an exception, but not what happens
  next.
- **Systems.** Airtable Quotes, n8n 01/06/07, `wf_quote_accepted`, `wf_airtable_change`.
- **Safe reproduction.** PGlite: `wf_airtable_change` and then `wf_quote_accepted`, both with record id
  `recDUPLICATEQ0044` (`ws02/p2_identity.mts`). For Airtable's side, duplicate a record in a sandbox copy of the base.
- **Invariant.** An acceptance from a record that is not the quote's verified `external_links` record is refused. An
  unknown record that shows business values differing from canonical is flagged and reverted.
- **Confidence.** HIGH. The probe CREATED PRJ-2026-0031 from the duplicate.

## P2: reliability and recovery

### AC-26 · P2 · A dead-lettered Xero draft has no working recovery, and doesn't show on its project

- **Failure hypothesis.** The documented `ops/requeue-dead-lettered-side-effect.sql` selects rows by project id, but
  Xero rows are keyed by invoice id, so it re-queues nothing. A hand-adapted re-queue creates the draft, but completion
  then fails on the illegal FAILED → SYNCED and EXECUTION_FAILED → EXECUTED transitions, which orphans the draft.
  Attempts stay at max, so the next retryable error dead-letters again, and the exception sits at RETRY_QUEUED forever.
  The exception is keyed to the invoice, so the project page says "Automation: Healthy" and Needs Attention drops it.
- **Why current tests may miss it.** Re-queue was exercised live for Drive only (PRJ-2026-0033), and
  `workflow.test.ts:246` covers auto-resolve for a non-Xero side effect. No test re-queues a Xero row.
- **Systems.** `ops/requeue-dead-lettered-side-effect.sql`, outbox/invoice_sync/approval machines,
  `wf_complete_side_effect`, `v_dashboard_exceptions`, n8n 05, dashboard.
- **Safe reproduction.** PGlite: approve, fail with VALIDATION_ERROR, run the script's CTE (0 rows), re-queue by key,
  claim, complete with good proof (`ws08/p1.mts` section C). Then read the project's dashboard row.
- **Invariant.** One audited operator action takes any dead-lettered Xero row to DONE/SYNCED/EXECUTED on valid proof.
  Postgres never refuses valid proof for a draft 05 just created. Every open exception appears on its project.
- **Confidence.** HIGH. Found by 3 reviewers. The probe raised `illegal invoice_sync transition FAILED -> SYNCED`.

### AC-27 · P2 · A lost n8n execution strands work, and nothing ever flags it

- **Failure hypothesis.** 04 advances its payload cursor as a child of the Prepare branch, before Decide and 05 have
  run. If the execution dies (a Cloud restart, a timeout, or an error in Decide), the Approve is never redelivered. Or
  the outbox row stays PENDING, or DISPATCHING with an expired lease, indefinitely. The same happens to 02's retry loop
  inside a Wait node. No sweeper, integrity rule, exception or `needs_attention` flag picks these rows up.
- **Why current tests may miss it.** `invoice.test.ts:110` and `workflow.test.ts:93` rely on a new event arriving. No
  test ages an orphaned claim, or checks what surfaces it.
- **Systems.** n8n 02/04/05 on the n8n Cloud runtime, Postgres outbox, `integrity_check`, dashboard, Copilot.
- **Safe reproduction.** PGlite: approve PRJ-2026-0004, claim as a "crashed" worker, age `locked_until` and
  `created_at` by 3 days, then query `integrity_check()`, exceptions and the dashboard (`ws06/p2_stuck_hooks.mts`
  part 1, `ws09/p3-stuck.mts`).
- **Invariant.** An outbox row PENDING past a threshold, or DISPATCHING with an expired lease, is either re-driven
  (reconciling before any create) or surfaced as needing attention. A cursor advances only after its whole batch is
  processed.
- **Confidence.** HIGH that nothing flags the stranded row. MEDIUM for the cursor ordering, which is inferred from the
  04 wiring.

### AC-28 · P2 · One deterministic Airtable rejection wedges the whole change stream while health stays green

- **Failure hypothesis.** 06 has no error branch. One correction PATCH that Airtable always rejects fails the execution
  after 3 retries, and the cursor never advances. Examples: a renamed select option (`typecast:false`), a date field
  switched to date-time, a deleted field, or restoring a link to a deleted record. Every later ping dies on the same
  item, so all staff edits in the base stop. `wf_webhook_check` reports `ok:true` with the consumer BEHIND.
- **Why current tests may miss it.** `state-integrity.test.ts:203` covers a transient write-back failure only. The
  health test at `:378` goes red only because a hook is also MISSING in that fixture; BEHIND alone was never checked.
- **Systems.** n8n 06, Airtable schema, `wf_airtable_change`, `wf_webhook_check`, `/health`.
- **Safe reproduction.** PGlite: `wf_webhook_check` with the changes hook 800 payloads behind (`ws06/p2_stuck_hooks.mts`
  part 2). For the 422, use a sandbox copy of the base with a copied 06 and a renamed option.
- **Invariant.** A deterministic 4xx on one record is recorded against that record, and never blocks other records or
  the cursor. A consumer BEHIND across two checks is unhealthy.
- **Confidence.** MEDIUM. The health half is HIGH (the probe returned `ok:true` while BEHIND). The wedge is inferred
  from the 06 wiring.

### AC-29 · P2 · 07's webhook maintenance: starved by any failure, duplicated by a failed list call, and active in dry-run

- **Failure hypothesis.** 07 is one linear chain, and it is the only refresher of the 06 "changes" webhook.
  - Any earlier failure skips webhook refresh, drain and health for the day, and after 7 days the webhook expires.
    Causes include a 422 correction, a Drive root not found exactly once (for example the 97 fault toggle left on),
    or an OAuth failure.
  - A 429/5xx on `GET /webhooks` passes `[]` to `wf_webhook_check`. 07 then creates a second base-wide webhook, and
    every edit reaches 06 twice under different event ids.
  - A superseded run keeps going and records "completed" health.
  - The drain step pings 01 and 04 even with `--dry-run`, so an "observe only" run can create projects and Xero
    drafts.
- **Why current tests may miss it.** `wf_webhook_check` is tested only in isolation (`state-integrity.test.ts:378`).
  The phase 6 chaos results cover a missing or expiring webhook only when 07 itself succeeds.
- **Systems.** n8n 07/06/00/01/04, Airtable webhooks, `wf_webhook_check`, `wf_reconcile_start`/`finish`, `/health`.
- **Safe reproduction.** PGlite: `wf_webhook_check` with an empty list while the hooks exist
  (`ws05/p5-misc.mts`, `ws07/p7_renamed_option.mts`). For the node ordering, use a copied 07 against a sandbox base,
  with pinned List-Webhooks responses.
- **Invariant.** Webhook supervision and health recording run even when a comparison phase fails. A failed list call
  never creates a webhook. Observe mode causes no business side effects. The changes webhook never reaches 0 hours
  left while 07 is scheduled.
- **Confidence.** MEDIUM. The duplicate-webhook decision is HIGH (probe). Starvation and the dry-run drain are inferred
  from the wiring.

### AC-30 · P2 · Health and consistency say "in sync" when repairs never landed or runs are failing

- **Failure hypothesis.** Replays write `airtable_observations` with the intended correction before n8n PATCHes it.
  If the PATCH fails, `v_state_drift`, `integrity_check` and `/health` report zero drift. In the probe, 26 corrections
  targeted field ids that no longer existed and `drift_now` was still 0. The consistency cards also read only the
  latest COMPLETED run, with no age check, so while 07 fails nightly they keep showing an old "231 / 231 in sync".
- **Why current tests may miss it.** `state-integrity.test.ts:350` calls `wf_airtable_writeback_verified` before it
  asserts that drift is gone. No test reads drift between a correction and a missing read-back, or checks card age.
- **Systems.** `wf_airtable_change`, `v_state_drift`, `v_consistency`, `v_reconciliation_latest`, n8n 07, `/health`,
  Copilot sync answers.
- **Safe reproduction.** PGlite: after `ws07/p1_missing_field.mts`, query `v_state_drift` without calling the
  write-back verify. Insert a FAILED run after a COMPLETED one, then read the cards.
- **Invariant.** Observations come only from values actually read from Airtable. A failed or unverified correction
  stays visible as drift. Consistency cards older than one schedule interval show Unknown.
- **Confidence.** HIGH for the optimistic observation. MEDIUM for the stale cards.

---

## Test these first

These ten have the highest impact, the highest confidence, and are the cheapest to turn into offline PGlite tests:

1. **AC-01**: a reconcile replay overwrites a newer staff edit. This happens in normal nightly operation.
2. **AC-02**: one missing field or date-time switch wipes or shifts canonical dates for every record.
3. **AC-03**: an Airtable Approve approves a preview the approver never saw.
4. **AC-08**: over-billing is shown as "Fully invoiced", and `dashboard.test.ts:34` asserts the wrong answer.
5. **AC-09**: the final invoice is short by the variation amount once the variation is marked INVOICED.
6. **AC-05**: a voided invoice still gets a Xero draft.
7. **AC-06**: unpinning the Xero tenant doesn't stop queued writes.
8. **AC-04**: an ambiguous Xero create is downgraded to "failed safely" and never reconciled.
9. **AC-13**: every job created from quote acceptance can never be final-invoiced.
10. **AC-10**: 06 ping-pongs its own stale correction.

---

## Appendix A: raw findings behind each scenario

Raw ids are `WS-index` from `adv/salvage-raw.json`.

| Scenario | Raw findings | Scenario | Raw findings |
|---|---|---|---|
| AC-01 | 07-01, 03-06, 05-02, 05-03 | AC-16 | 07-07, 08-10, 03-05 |
| AC-02 | 07-02, 07-03 | AC-17 | 06-07, 07-04, 07-05 |
| AC-03 | 08-04, 05-04, 05-05, 02-01 | AC-18 | 05-06 |
| AC-04 | 06-01, 08-07, 07-13, 01-15, 08-06 | AC-19 | 02-06, 02-07, 03-12, 02-05 |
| AC-05 | 08-03 | AC-20 | 08-09 |
| AC-06 | 08-02 | AC-21 | 03-09, 01-06, 01-07 |
| AC-07 | 08-05, 06-11, 09-02 | AC-22 | 10-01, 10-02 |
| AC-08 | 08-01, 01-01, 01-16 | AC-23 | 02-03, 02-04, 01-12 |
| AC-09 | 01-02 | AC-24 | 02-09, 01-10, 01-09, 03-07, 01-11, 02-10, 03-08 |
| AC-10 | 05-01, 05-11 | AC-25 | 02-11 |
| AC-11 | 09-04 | AC-26 | 08-08, 03-01, 03-11, 10-04 |
| AC-12 | 09-05 | AC-27 | 06-03, 05-07, 09-09 |
| AC-13 | 03-04, 01-03, 09-08, 03-10 | AC-28 | 06-04, 02-12, 02-02 |
| AC-14 | 03-03, 01-04 | AC-29 | 07-10, 06-06, 09-06, 07-12, 05-08, 06-05, 07-06 |
| AC-15 | 03-02, 01-05 | AC-30 | 07-11, 07-14 |

## Appendix B: distinct hypotheses cut by the 30-scenario cap

These are new and concrete, but lower value. Raw ids are in brackets.

| Pri | Hypothesis |
|---|---|
| P1 | Preview lifetime: the preview hash includes today's date and payment statuses, so it goes stale at midnight or when a payment lands; approvals expire on the wall clock while the business date is frozen; EXPIRED is never set, so Airtable and the dashboard disagree [01-14, 08-14, 10-06, 03-14] |
| P1 | A finance rejection vanishes: the project returns to "Ready to invoice", and one click re-prepares it [10-07] |
| P1 | The supplier-confirmation SLA depends on the DB session time zone (UTC pooler vs Brisbane `app_today()`) [01-13] |
| P1 | A malformed or truncated DeepSeek tool call runs the tool with `{}`, which answers a different question; `finish_reason:'length'` is ignored [06-12] |
| P1 | "Needs attention" omits overdue customer payments that the table and Copilot count [10-05] |
| P1 | Invoice numbers restart after a DB reload, reusing RO-INV-2026-0039, which already exists in Xero [08-11] |
| P1 | A trashed or deleted Drive folder can never be re-linked; it stays "verified" and the staff member's fix is reverted [09-01] |
| P1 | Exception wording mislabels failures: every "drive.*" message becomes "Drive unavailable", and PERMISSION_DENIED is described as a Copilot action [09-07, 10-08] |
| P2 | Error classification: a transient Postgres error at proof time is non-retryable; an OAuth refresh failure is read as a network error; the retry schedule ends inside Xero's 6-minute cached-response window [06-02, 06-09, 08-12] |
| P2 | The Airtable free-plan monthly cap: one fill-handle drag spends hundreds of calls, and the exhausted cap is treated as a 30 s rate limit [02-13, 06-08] |
| P2 | Reconciliation exceptions never close; transient read errors become permanent; "Delete it" advice outlives the link [07-08, 09-11, 07-09] |
| P2 | A Drive create that times out, plus search-index lag, produces duplicate tagged folders [06-10, 09-03] |
| P2 | Re-pinning the Xero tenant poisons each customer's contact link [08-13] |
| P2 | DeepSeek fails after `prepare_invoice` committed, and the user is told nothing happened [06-13, 10-03] |
| P2 | A DB failure in the `(ops)` layout escapes `error.tsx`, so `/health` can't load during an outage [10-09] |
| P2 | 07 verifies only the top folder, and flags archived folders of cancelled jobs forever [09-10, 09-12] |
| P3 | Status Reason typed after the status is dropped, and an old reason is reused for the next change [02-08, 05-09, 03-13] |
| P3 | Stale PM risk flag, imported and never editable [01-08] |
| P3 | ON_HOLD jobs show "On schedule", with no hold reason in the UI [10-10] |
| P3 | A Copilot card keeps "Awaiting approval" after the approval is decided [10-11] |
| P3 | A malformed percent-escape in a project URL crashes the page and blames the database [10-12] |
| P3 | A mistyped Invoice Action option is silently ignored [02-14] |
| P3 | Redelivery of an unverified correction erases the RoofOps Sync explanation [05-10] |
| P3 | `demo:status` recommends preparing the cancelled PRJ-2026-0001 [03-15] |
