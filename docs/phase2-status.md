# Phase 2: Real Airtable → n8n → Postgres → Google Drive → Airtable ✅ (awaiting review)

Everything below was executed against the real services on 2026-09-29 (AEST) and read back independently. No mocks, no simulated responses.

## What is live

| System | Resource | Id |
|---|---|---|
| n8n Cloud (`tejesh08.app.n8n.cloud`, **Roofops** team project) | `[RoofOps] 01 Quote Accepted → Project` (published, webhook) | `X7KX9zGrClRbHyD1` |
| | `[RoofOps] 02 Drive Project Folder` (published sub-workflow) | `9Sf3qrNhb31KMrrF` |
| | `[RoofOps] 03 Airtable Project Write-back` (published sub-workflow) | `gtUffpzbdGa0vbYj` |
| | `[RoofOps] 00 Setup & Maintenance` (published: daily 03:15 + manual) | `1e0844GE0OOh7Qyq` |
| | `[RoofOps] 98 Drive Read-Back` (read-only verifier, manual) | `6LVHjof4Zbvu8aAw` |
| | `[RoofOps] 97 TEST Fault: Toggle Drive Root` (test only, never published) | `rcnjdewv1IhfHn8P` |
| | `[RoofOps] 99 Credential Check` (manual) | `zKQd6A0zf5myVWbo` |
| Airtable | Base **RoofOps Demo** | `appMc8V0Wm29tEeHQ` |
| | Webhook → `…/webhook/roofops/airtable/quote-events`, watches **Quotes.Status only** | `ach6PdRNqU0HAb2oV` (refreshed daily; Airtable expiry is 7 days) |
| Google Drive (`tejeshhowyadoin@gmail.com`) | Root folder **RoofOps Demo** (`appProperties.roofops_role=root`) | `1cStzFN2ZcxAaq05ECO6g91cvQF73Hwjf` |
| Supabase Postgres 17 | Migrations `000`–`700` (8) | control layer |

Sources for every workflow are in `n8n/*.sdk.ts` (n8n Workflow SDK). Credentials are referenced by id and name only; no secret appears in any workflow or file.

## Credentials verified (execution 1748, `[RoofOps] 99`)

| n8n credential | Proof |
|---|---|
| Roofops Airtable Personal Access Token account (`airtableTokenApi`) | read the base schema, read quote Q-2026-0041, list webhooks: all 200 |
| RoofOps Postgres (`roofops_n8n`) | `current_user = roofops_n8n`; `wf_claim_side_effect` allowed; `select … from projects` **denied** |
| RoofOps Google Drive | `about` → the account above; temp folder created, read back, moved to trash (not deleted) |
| Roofops DeepSeek | `GET /models` → 200, `deepseek-flash` listed. Nothing else built (Phase 6) |

The first credential check found the original `Airtable account` credential (legacy `airtableApi` type) returned **401**; it was replaced by the PAT credential and every Airtable node was re-pointed.

## Workflow

```
Airtable: staff sets Quotes.Status = Accepted
  │  Airtable webhook ach6PdRNqU0HAb2oV (Quotes.Status only) → POST ping (no record data)
  ▼
[01] Webhook ─► Validate Ping (our base + an ach… id, else stop)
  ─► Postgres wf_airtable_cursor(hook)                       durable cursor; n8n keeps no state
  ─► GET /webhooks/{hook}/payloads?cursor=…  (paginated)       data fetched with OUR credential
  ─► Extract: Status changed to "Accepted" (previous ≠ Accepted)
       event_id = airtable:{hook}:txn{baseTransactionNumber}:{recordId}
       payload  = quote_id, accepted_version, quote_uuid (RoofOps ID), airtable_record_id, accepted_on?
  ─► Postgres wf_quote_accepted(event)  ─┬─► wf_airtable_cursor_advance (monotonic)
       validate → idempotency (quote.accepted:Q:vN) → cross-check RoofOps ID → accept quote
       → project + 5 checklist items + MATERIAL_REVIEW task → outbox ×2 → events + audit   (one transaction)
       outcome: CREATED | ALREADY_PROCESSED | INVALID_EVENT | INVALID_STATE
  ─► side effects needed? (CREATED, or ALREADY_PROCESSED with unfinished side effects)
       ├─ yes ─► [02] Drive:   claim → find root → find/create project folder (tagged roofops_project_id)
       │                        → list + create missing 01..05 subfolders → READ BACK folder + children
       │                        → verify (parent, name, tag, not trashed, 5 subfolders exactly once)
       │                        → wf_complete_side_effect(proof)      Postgres re-checks the proof
       │                        on failure: classify → wf_fail_side_effect → wait (1,2,4,8 s…) → re-claim
       │                        → after 5 attempts: DEAD_LETTERED + exception
       │         [03] Airtable: claim (refused until the Drive folder is verified; receives it)
       │                        → upsert Projects on RoofOps ID (+ Quote, Customer links, Drive Folder URL)
       │                        → READ BACK project, the quote's back-link, and count matches (must be 1)
       │                        → wf_complete_side_effect(proof)       same retry/exception path
       └─ no
  ─► Compose Quote Status → PATCH Quotes.Automation Status/Message → READ BACK → verify
       Project created | Duplicate ignored | Rejected | Failed
```

## Evidence

### 1. End-to-end (execution 1750, 13.4 s)
Q-2026-0041 (Oliver Grant) changed from **Sent → Accepted** in the real Airtable base.

| Read back from | Result |
|---|---|
| **Postgres** | quote `ACCEPTED` (2026-09-29); project **PRJ-2026-0031** `cf075e42-fcc0-4e99-9b8d-f851d16dd61e`, PM Lachlan Reed; 1 MATERIAL_REVIEW task due 2026-10-01; 5 checklist items; outbox 2 × DONE (1 attempt each); run SUCCEEDED (8 steps); 7 verified `external_links`; audit `quote.accept → project.create → task.create → drive.folder.link → airtable.project.writeback`; chain intact |
| **Google Drive** (`[RoofOps] 98`) | `RoofOps Demo/PRJ-2026-0031 - Oliver Grant` = `1cI9mwecHdt2qA5961tXTa0sAgWhE6Wu9`, parent = root, subfolders 01 Quote `1bnYt6qa…`, 02 Site `16yc8Z4V…`, 03 Materials `1V8poJ02…`, 04 Supplier `1qvqDANU…`, 05 Completion `1Tw8CJuv…` |
| **Airtable** (independent connection) | Projects `recDT4dQPmrjy5Mmu`: PRJ-2026-0031, Quote → Q-2026-0041, Customer → CUST-0001, Planning, Drive Folder = the URL above, RoofOps ID = the Postgres UUID; exactly 1 match. Quote `rec4MMzrBxFdppyVd` links back; Automation Status "Project created" |

### 2. Duplicate: same event (execution 1754)
Ping re-sent with `replay_from_cursor: 1` → n8n re-read the same Airtable payload → identical `event_id …txn16…` → `ALREADY_PROCESSED`, logged as *transport redelivery of the same event_id*. No sub-workflow ran.

### 3. Duplicate: same business action, new event id (executions 1755/1756, then 1757/1758)
Quote set Sent → Accepted again in Airtable (new Airtable transactions txn21, txn25). Each change produced its own ping and the two executions overlapped, so each new event was also delivered twice concurrently. Every delivery → `ALREADY_PROCESSED` (*semantic duplicate* or *transport redelivery*).

| After 6 deliveries of the same fact | Count |
|---|---|
| Postgres projects for Q-2026-0041 | **1** |
| Material-review tasks | **1** |
| Drive project folders (`[RoofOps] 98`) | **1** (same id, created 21:34:39) |
| Airtable project records (filter on RoofOps ID or number) | **1** |
| `processed_events.delivery_count` | 6 |

**Bug found and fixed here:** execution 1755 failed its read-back of the quote status because the concurrent execution overwrote the message ("delivery 3" vs "delivery 4") between write and read. The write-back is now deterministic per business fact, and the verifier accepts a concurrent write only for a non-failure state about the same project (flagged `superseded_by_concurrent_delivery`). Re-test 1757/1758: both succeed.

### 4. Validation failure (executions 1760, 1762)
Q-2026-0035 is LOST; staff set it to Accepted in Airtable. → `INVALID_STATE` "Quote Q-2026-0035 is LOST; only a SENT quote can be accepted", non-retryable, **EXC-0013**; no project, no Drive folder, no Airtable project; quote Automation Status "Rejected". Staff then set it back to Lost.

**Bug found and fixed here:** redelivering the rejected event opened a second exception (EXC-0014). Migration 700 now reuses the open exception for the same quote + class + reason (attempt_count 3 after the third delivery) and folded EXC-0014 into EXC-0013 (audited `exception.fold_duplicate`, nothing deleted).

### 5. Transient failure
Fault: the real Drive root moved to trash by `[RoofOps] 97` (no credential touched). The Drive step gets a real "root not available" answer → `SERVICE_UNAVAILABLE` (retryable).

| Case | Result |
|---|---|
| **Recovers** (Q-2026-0044 → PRJ-2026-0032, execution 1765) | attempts 1–3 FAILED (backoff 1 s, 2 s, 4 s; each a run step + `automation.retry_scheduled` event); root restored; attempt 4 created folder `1LoiHZu_…` + 5 subfolders; Airtable `reczFqGxwhWTHzpsP`; run SUCCEEDED; **no exception** |
| **Exhausts** (Q-2026-0048 → PRJ-2026-0033) | 5 attempts (1, 2, 4, 8 s) → DEAD_LETTERED, **EXC-0015** opened; Airtable write-back never started (waits for Drive); quote Automation Status "Failed … EXC-0015" |
| **Operator recovery** | root restored; `ops/requeue-dead-lettered-side-effect.sql` (audited `exception.retry_queued`); event redelivered → attempt 6 created `123xVm4g_…` + 5 subfolders, Airtable `recIxvTNChcgkctnx`; EXC-0015 **auto-resolved** by `workflow:quote_to_project` |

**Latent bug found and fixed here:** the original CHECK required an employee on every RESOLVED exception, so the workflow's auto-resolve would have aborted completion. Migration 700 adds `resolved_by_system`.

## Tests

| Suite | Result |
|---|---|
| Local (PGlite + Postgres 17): dates, normalise, fixtures, schema, import, workflow | **177 passed**, 16 skipped (13 hosted-only, 3 PGlite concurrency) |
| Hosted (`RUN_HOSTED_TESTS=1`): schema, import (scoped to imported rows), **live-phase2** | **63 passed** |
| Lint, typecheck, `data:check` | clean |
| n8n `validate_workflow` on every SDK source | valid |

## Remaining limitations

1. **n8n is the shared paid instance** (`tejesh08`), isolated by the Roofops team project, not a separate workspace.
2. **Recovery of dead-lettered side effects is an operator SQL action** (`ops/…sql`), not yet a UI button (Phase 3). There is no scheduled sweeper: a crash between `wf_quote_accepted` and the side effects is recovered on the next delivery of the event (or a replayed ping), not automatically.
3. **The final failed attempt (5/5) is recorded as an event and an exception but not as a `workflow_run_steps` row** (attempts 1–4 are).
4. **Airtable pings are not HMAC-verified.** They carry no data (everything is fetched with our credential), so a forged ping can at most cause one extra read. The webhook's MAC secret was returned at creation and is stored in n8n execution 1749's data; delete that execution if that matters.
5. **A replayed ping re-labels earlier quotes** (e.g. Q-2026-0044 now reads "Duplicate ignored" after a replay from cursor 8). Correct but noisy; showing "Project created" for a duplicate of a completed project is a UX choice to revisit.
6. **TLS to Supabase is encrypted but not certificate-verified** from this machine (no `SUPABASE_CA_CERT` yet).
7. **Independent Drive read-back uses the same n8n Drive credential** (in a separate, read-only workflow); the Airtable read-back used a genuinely independent connection.
8. The Drive credential signs in as `tejeshhowyadoin@gmail.com`.

## Reproduce the demo manually

1. Airtable → base **RoofOps Demo** → **Quotes**. Pick a quote with Status **Sent** and Automation Status **Not triggered** (e.g. Q-2026-0050, Q-2026-0051 v2, Q-2026-0052, Q-2026-0054, Q-2026-0058, Q-2026-0064, Q-2026-0032, Q-2026-0034 v2, Q-2026-0036).
2. Change **Status** to **Accepted**. Within ~15 s, Automation Status becomes **Project created**, the message shows the new PRJ number and Drive link, and the quote's **Projects** field links to a new record.
3. Open the Drive link: `RoofOps Demo/PRJ-… - <customer>/01 Quote … 05 Completion`.
4. n8n → project **Roofops** → `[RoofOps] 01 Quote Accepted → Project` → **Executions**: one webhook execution per status change, plus integrated runs of 02 and 03.
5. Duplicate: set the same quote back to **Sent**, then **Accepted** again → Automation Status **Duplicate ignored**, no new project, folder or record.
6. Validation failure: set a **Lost** quote (e.g. Q-2026-0035) to **Accepted** → **Rejected** with the reason and exception number. Set it back to Lost.
7. Postgres view of any quote: `npx tsx scripts/verify-quote-flow.ts Q-2026-0050`.
8. Transient failure (optional): run `[RoofOps] 97` once (root → trash), accept a Sent quote, run `[RoofOps] 97` again within ~10 s (root restored) → the run recovers after a few logged retries. If you wait longer, it dead-letters; recover with `ops/requeue-dead-lettered-side-effect.sql` (edit the project and exception numbers) and a Sent → Accepted toggle.
