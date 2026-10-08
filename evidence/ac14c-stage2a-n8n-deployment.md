# AC-14C Stage 2A: n8n deployment (2026-10-08). STOPPED before publishing 08

Authorised by the owner: n8n workflow deployment and configuration only. The dispatch token stays blank.
- **No migration, no reissue, no dispatch credential, no Xero, Airtable or Drive call, no invoice created.**
- No secret is recorded here.
- Branch `factory/ac14-integrity-followup` at `dd10e78` (clean, equal to GitHub) when it ran.

## 1. Before changes: all PASS

| Check | Result |
|---|---|
| Git | `dd10e78`, clean, equal to the remote |
| Hosted integrity (read-only) | 28 PASS / 4 WARNING / 0 FAIL |
| Hosted security | 16/16 PASS |
| In flight | outbox PENDING/DISPATCHING 0; open approvals 0; reconciliation running 0; **n8n running/waiting/new executions 0** (MCP search and public API) |
| Saved n8n executions | **0** for 04, 05, 07, 08-Health, 96 and 99 (public API, metadata only): no execution history, and so no stored token, exists today |
| Credentials (without executing anything) | 08-Health's scheduled checks through the n8n credentials, last 24 h: **Postgres 49/49 OK, Xero 48/48 OK**, latest 2026-10-08 08:30 UTC |
| Rollback snapshots (read-only GETs, saved outside the repo; ACL owner + SYSTEM) | `n8n-04-YpmpJxQtSIBGSx6Z-fee94016…-20261008-192214.json` (sha256 `e30639af…`), `n8n-05-Y2deCFTZzpv1uo8C-e6c57486…-20261008-192214.json` (`8c56055d…`), `n8n-07-EiBs0AB2NfOua7AM-a0ca9e60…-20261008-192214.json` (`955507a9…`), in `D:\Claude\roofops-backups` |

## 2. Workflow 05: republished. PASS

| Item | Value |
|---|---|
| Change | `update_workflow` on the **draft**: `setNodeParameter /jsCode` on exactly **Reconcile Before Create** and **Verify Xero Read-Back** (the only parameters that differ from the live version). Same workflow ID, credentials, settings, project and the other 35 nodes |
| Verified before publishing | draft `feab88d9-1753-4471-9167-cbfeff29225a` **IDENTICAL to HEAD** `n8n/05-xero-draft-invoice.sdk.ts`: 37 nodes, parameters, credentials, onError, 46 edges. The active version was still `e6c57486…` |
| Window | immediately before publishing: 0 running/waiting executions, 0 in flight, 0 open approvals |
| Published | **active version `feab88d9-1753-4471-9167-cbfeff29225a`** (= draft), active, project Roofops `4kSuZdSc0Opp3juv`, settings unchanged (`executionOrder v1`, `availableInMCP`), no pinned data, **IDENTICAL to HEAD** after publishing |
| Generation 1 | unchanged by construction: the new code acts only when the Postgres claim returns `generation ≥ 2`, and no such write exists |
| **Rollback** | `restore_workflow_version(Y2deCFTZzpv1uo8C, e6c57486-46f1-4e8a-9de9-b9f19a2f9cc9)`, then `publish_workflow`. The full pre-change definition is in the snapshot above |

## 3. Workflow 08: created, configured, verified, **NOT published**

| Item | Value |
|---|---|
| Workflow | **`JH1H0EmMzpdNWmcp`** "[RoofOps] 08 Reissue Dispatch", team project **Roofops** `4kSuZdSc0Opp3juv` |
| Code | `n8n/08-reissue-dispatch.sdk.ts` (selection contract of `18be673`); `validate_workflow` valid (one static warning: the `$json.none` field is not in the documented sample output, but is emitted at runtime and covered by the recorded-node tests) |
| Draft | `facd57c8-7b60-4106-9d05-90beba3e8369`, **IDENTICAL to HEAD**: 6 nodes, 5 edges, credentials (Postgres `kWqjtv0gz7ref2EN`), calls 05 `Y2deCFTZzpv1uo8C` |
| Selection contract | the body's `invoice_number` and `generation` go to `wf_reissue_dispatch($1, $2, nullif($3,'')::int, $4)`, and 05 receives only a write matching that selection |
| Settings | `saveDataSuccessExecution: none`, `saveDataErrorExecution: none`, `saveManualExecutions: false`, `saveExecutionProgress: false`, **`callerPolicy: none`** (no workflow may call 08), no error workflow, no pinned data |
| Calling 05 | 05 declares no `callerPolicy`, so the default (same owner/project) applies. 08 and 04 are both in Roofops. Exercised only at the first real dispatch: if refused, 08 errors, the write stays PENDING and nothing reaches Xero |
| State | **inactive (unpublished)**: its webhook is not registered, so no request can reach it |

## 4. Why Stage 2A stopped: n8n cannot guarantee that the token is never retained

Owner's rule: *"If n8n cannot guarantee the requested execution-data retention protections, STOP and explain the
limitation."* A documentation and source review, with four independent researchers and a skeptical synthesis, found:

- **The execution row is created up front, with the webhook data.** On every run n8n inserts the row as
  `new`/`running` with the trigger's output. The Webhook node's output always holds **all request headers**
  (`json.headers = req.headers`, with no option to drop them), so `x-roofops-token` is stored for the whole run. Read
  Request's output holds a second copy.
- **"Do not save" acts only after the run finishes.** The row is deleted then, but by default it is soft-deleted and
  hard-deleted at the next prune (about 15 minutes).
- **A waiting execution is always saved in full.** 08 has no Wait node. It waits for 05, which has *Wait For Backoff*.
  Whether 08's own run then enters "waiting" is **unconfirmed**. If it does, a Xero retry would leave 08's
  token-bearing execution stored until it resumes and finishes.
- **A crashed execution keeps its data** until normal retention pruning.
- **Header Auth does not help.** The Webhook node's built-in Header Auth rejects bad tokens before any execution
  exists, but on success it still outputs the raw header. Its credential would also hold the token in plaintext,
  which conflicts with the hash-only design.
- **Redaction does not close it.** It is Enterprise-only, hides data only when served through the UI and API (not in
  the database), and is silently ignored without the licence. Whether this instance has the licence is unconfirmed.
- **Error workflows, log streaming, Insights and statistics carry no node data or headers**, except an error message
  that quotes the token, and no node in 08 does that. 08 has no error workflow and no Error Trigger.

**Additional points from the skeptical synthesis:**
- 08 carries `availableInMCP: true` (the default for workflows created through MCP). Once 08 is published with an active
  webhook, it becomes executable over MCP. It should be set to `false` before publishing.
- Read Request's copy of the token can be removed by hashing it in the Code node (`crypto` is available on n8n Cloud).
  The copy in the Webhook node's output cannot be removed.
- 05 never receives the token: 08 hands it only `xero_key`, `invoice_number`, `generation` and `dispatched_by`.
- n8n Cloud telemetry, which cannot be switched off, may include error-message text. No 08 node puts the token into an
  error message.

**What the settings do guarantee:** after a run ends normally (success or failure), no execution history holding the
token remains readable, and no manual run is kept.

**What they cannot guarantee:** non-retention while a run is in progress, while it is waiting, or after it crashes.

## 5. Not done (owner decision required)

- **08 publication.** It awaits the owner's choice of mitigation below.
- **07 retention settings** (`saveDataErrorExecution: none`, `saveExecutionProgress: false`, added to its existing
  `saveDataSuccessExecution: none` and `saveManualExecutions: false`). This change is protective and functionally
  neutral, but was deferred under the STOP rule. 07 has the same structural limitation for `RECONCILE_TRIGGER_TOKEN`.
- **The webhook-refusal test** ("cannot authorise any dispatch while the hash is blank") needs 08 published. It is
  proven offline (TOKEN_REFUSED with a blank hash) but not yet on hosted.

## 6. Database after Stage 2A

**62 of 62 tables byte-identical** to the post-Stage-1 fingerprint. Dispatch hash blank, 0 in flight, 0
REISSUE_INVOICE approvals.
