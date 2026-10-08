# AC-14C Stage 3C: supervised synthetic reissue verified in hosted RoofOps and Xero Demo (2026-10-08)

**Result: HOSTED REISSUE VERIFIED.**

Authorised by the owner: one supervised reissue of INV-2026-0040 (PRJ-2026-0002, AUD 15,155.98 inc GST, original Xero
RO-INV-2026-0040 / `21545f60-7aa8-418b-8d8d-635a4c1d08ed`, approval APR-2026-0012) in the pinned Demo Company (AU).
- The CLI ran as EMP-900 under the owner's demo-only authorisation. This is not production authentication.
- The privileged database credential is held by the owner only.
- No secret, token, hash, connection string or host is recorded here.
- Branch `factory/ac14-integrity-followup` at `080573e` when it started.

## Phase A: before any write. PASS

| Check | Result |
|---|---|
| Git, integrity, security | `080573e` synced; integrity 27 PASS / 5 WARNING / 0 FAIL (the 5th warning was the known Airtable `drift`); security all PASS |
| Old Xero invoice (fresh read, observe run `RECON-20261008-194617-0618`) | exactly `21545f60…`: **VERIFIED DELETED**, paid 0.00, credited 0.00, pinned tenant |
| Canonical invoice and entitlement | INV-2026-0040 **VOIDED** ("Deleted in Xero (verified by reconciliation RECON-20261008-193809-1f4c)"); `project_billing` remaining **15,155.98** (billed 35,363.94 of 50,519.92); outstanding 0 |
| History | ledger generation 1 CREATED, not superseded, `21545f60…`; the generation-1 write DONE; Xero link `21545f60…` verified; **APR-2026-0012 EXECUTED** |
| Airtable before | **not cleared** (no scheduled run since Stage 3B). PRJ-2026-0002 showed Invoice Status "Xero draft created", Xero Invoice ID `21545f60…`, Xero Invoice Number RO-INV-2026-0040, where canonical expected them cleared (3 SAFE_AUTO_REPAIR fields). **No repair was run.** The reissue does not depend on them, and its result changes what canonical expects |
| Exceptions | EXC-0020 (EXTERNAL_MISSING "Xero invoice RO-INV-2026-0040 is deleted") and EXC-0021 (INVALID_STATE "a replacement final invoice needs a person …"): the expected deletion and reissue alerts, OPEN. The other open exceptions (EXC-0003, 0013, 0016, 0017) predate this work and concern other records |
| In flight | outbox 0, running reconciliation 0, open approvals 0, REISSUE approvals ever 0 |
| Dispatch | hash length 0; 08 `JH1H0EmMzpdNWmcp` active `facd57c8…`, IDENTICAL to HEAD, `availableInMCP: false`, all four execution-saving settings off, `callerPolicy: none`; 05 active `feab88d9…`, IDENTICAL to HEAD |
| Eligibility (`invoice_reissue_check`, read-only) | ok: target generation 2, void evidence DELETED (observation `5e409e7b…`) on the linked ID, bound = pinned tenant |

## Phase B: request and approve (CLI `npm run reissue -- … --hosted`, TLS verified). PASS

| Step | Result |
|---|---|
| Request | **APR-2026-0013**, REISSUE_REQUESTED, target generation 2. The mandatory reason cites the deletion of `21545f60…` verified by `RECON-20261008-193809-1f4c` |
| Preview | REISSUE_INVOICE PENDING for INV-2026-0040 only, by EMP-900; **hash matches the preview** (`6229a4e0…`); record version 4. Draft: **RO-INV-2026-0040**, **15,155.98** = 13,778.16 + GST **1,377.82**; one line (account 200, OUTPUT, inclusive); contact **Mia Campbell [CUST-0002] / RO-CUST-0002**; reference PRJ-2026-0002; pinned Demo Company (AU). **No key differs from generation 1's payload.** The request changed no other state |
| Decision | APR-2026-0013 → **REISSUE_QUEUED**, generation 2, outbox `…:g2`, new Xero idempotency key `roofops-…-g2`, superseded generation 1 |
| After the decision | invoice APPROVED/PENDING on APR-2026-0013. Ledger: generation 1 **SUPERSEDED** (`21545f60…`, APR-2026-0012); generation 2 PENDING (APR-2026-0013). **Exactly one generation-2 write: PENDING, 0 attempts, proof PROVEN.** Both approvals EXECUTED. **No Xero action yet**: link still `21545f60…`, no new observation |

## Phase C: one dispatch. PASS

One fail-safe script did the following:
1. **Re-checked the preconditions:** 1 in flight; exactly 1 open generation-2 write, PENDING; hash blank.
2. **Generated a 256-bit token in memory only.** It was never printed or written to disk.
3. **Stored only its SHA-256 hash** (length 64).
4. **Ran the CLI dispatch once**, selecting INV-2026-0040 generation 2.
5. **Blanked the hash in `finally`, regardless of outcome.**

| Item | Result |
|---|---|
| Token lifetime | activated 09:49:18.47 UTC, **revoked 09:49:28.70 UTC** (hash length 0, re-checked) |
| n8n path | **08 execution #2401** (mode `webhook`, started 09:49:20) invoked **05 execution #2402** (mode `integrated`, i.e. called as a sub-workflow, started 09:49:24). This is the intended Execute Workflow connection. One webhook POST; no duplicate request |
| CLI result | `REISSUE_CREATED`: generation 2 CREATED, write DONE in **1 attempt**, no error, `dead: false` |

## Phase D: the actual Xero result. PASS (every success condition met)

| Condition | Evidence |
|---|---|
| **A new Xero InvoiceID** | **`61e09cad-38d9-49e5-b537-bba0d185786b`** (≠ `21545f60…`) |
| Original remains DELETED | Xero UI (owner's signed-in session, page text only): `21545f60…` shows **"Invoice RO-INV-2026-0040 — Deleted"**, 15,155.98. 05's own number search must also have found it VOIDED/DELETED, or it would have refused |
| Expected number, same customer, reference, tenant, lines, tax, total | 05's verified read-back (`n8n_execution 2402`): **RO-INV-2026-0040**, **DRAFT** ACCREC, total **15,155.98**, tax **1,377.82**, subtotal 13,778.16, AUD, Inclusive; contact **Mia Campbell [CUST-0002] / RO-CUST-0002** (the same Xero ContactID as generation 1); reference **PRJ-2026-0002**; **Demo Company (AU)**, class DEMO, the **pinned** tenant. Xero UI: "Edit invoice RO-INV-2026-0040 — Draft", account 200, GST on Income 1,377.82, total 15,155.98 |
| No duplicate draft | read-back: **1** live invoice with that number. Xero Draft list: **exactly one RO-INV-2026-0040** (drafts 5 → 6); RO-INV-2026-0039 untouched |
| One current generation, one verified link | **1** non-superseded generation; **1** Xero invoice link → `61e09cad…` (verified); no other entity is linked to that ID |
| Generation 1 history kept | ledger generation 1 **SUPERSEDED**, still `21545f60…`, RO-INV-2026-0040, APR-2026-0012; its write still DONE; its observations kept |
| Generation 2 state | ledger generation 2 **CREATED** `61e09cad…` (APR-2026-0013); write `…:g2` **DONE**, 1 attempt; its payload **contains the approved draft**; invoice **APPROVED/SYNCED** |
| No extra approval, payment or credit | approvals 13 (only APR-2026-0013 added); REISSUE 1; pending 0; **payments 27** (0 on INV-2026-0040); credited 0 everywhere |

## Phase E: final verification

| Check | Result |
|---|---|
| Read-only reconciliation `RECON-20261008-195108-6ad0` | **Xero: 0 drift.** INV-2026-0040 VERIFIED **DRAFT** on `61e09cad…`, 15,155.98, paid and credited 0, pinned tenant; the EXTERNAL_MISSING finding is gone; INV-2026-0039 unchanged. Drive: 0 drift. Webhooks OK, 0 unread. **Airtable: exactly 1 field**, PRJ-2026-0002 *Xero Invoice ID*: shows `21545f60…`, canonical expects `61e09cad…` (SAFE_AUTO_REPAIR). Invoice Status, Number and Amount already match |
| Integrity | 27 PASS / 5 WARNING / **0 FAIL**. Warnings: the four pre-existing ones and `drift` (the one Airtable field) |
| Security | **all PASS**: tenant pinned; dispatch hash blank (length 0); workflow role 22 functions |
| Unrelated records | whole-database diff since the end of Stage 3B: **46 of 62 tables byte-identical**. Every change is attributable: invoices (only INV-2026-0040 → APPROVED/SYNCED); approvals (+APR-2026-0013 only); external_links (INV-2026-0040's Xero link → `61e09cad…`; sync timestamps only on the contact link, INV-2026-0039's link and 3 Drive folders); ledger +1; outbox +1; processed_events +1; workflow_run_steps +1; the project_to_invoice run updated; audit +5 (request, reissue, draft created, two reconciliations); automation_events +2 (reissue decided, draft verified); id_counters; reconciliation runs, findings, observations and integration_health. **0 customers and 0 projects changed; 0 new exceptions** |
| Dispatch hash | **blank** |
| n8n execution data | **08: 0 saved executions** (token not retained in readable history). 05: its successful runs are saved (instance default); 05 never receives the token |

## Remaining work (identified, not done)

1. **Airtable display.** One field: PRJ-2026-0002 *Xero Invoice ID* still shows the superseded `21545f60…`. The next
   repair reconciliation (the daily run at 16:30 UTC) applies exactly this SAFE_AUTO_REPAIR. The dry run proves its
   complete change set: that one Airtable field, with Xero and Drive at 0 drift. No repair was run in this stage.
2. **Exceptions EXC-0020 and EXC-0021** are accurate history but are now answered by the reissue, and still OPEN. A
   person resolves them through the supported path, for example:
   `npm run exception:resolve -- EXC-0021 --by EMP-900 --note "Replaced by supervised reissue APR-2026-0013: Xero draft RO-INV-2026-0040 61e09cad-…"`
   (likewise EXC-0020). This is not done: it is the owner's action.
3. **Observation.** `invoices.voided_reason` on INV-2026-0040 still holds the historical void text while the invoice is
   APPROVED again. The void evidence is also kept in the approval and the ledger; whether the column should be cleared
   on reissue is a data-hygiene question for a later change.
4. **Not enabled:** production staff authentication for reissues (per-person logins, four-eyes). The CLI-as-EMP-900
   model was used for this one supervised demo only.
