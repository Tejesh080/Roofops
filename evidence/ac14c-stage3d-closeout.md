# AC-14C Stage 3D: post-demonstration synchronisation, exception closure and final verification (2026-10-08)

**Result: CLOSED OUT.**
- 0 drift across Airtable, Drive and Xero; integrity 0 FAIL; security all PASS.
- EXC-0020 and EXC-0021 resolved by EMP-900 through the supported path.
- One staff-facing text field is still stale (§5, item 1). The authorised repair cannot reach it.

Authorised by the owner: verify the state; one repair reconciliation, only if limited to the PRJ-2026-0002
synchronisation; resolve EXC-0020 and EXC-0021 as the supervised EMP-900 demo identity; final verification.
- **No code, migration or workflow change. No Xero document deleted. No staff access enabled. AC-13B not started.**
- No secret, token, hash, connection string or host is recorded here.
- Branch `factory/ac14-integrity-followup` at `3f84406` when it started.

## 1. Financial state before any change (read-only, 09:59:46 UTC): PASS

| Check | Result |
|---|---|
| Current generation | **1 live (non-superseded) generation: generation 2**, CREATED, `61e09cad-38d9-49e5-b537-bba0d185786b`, APR-2026-0013. Generation 1 SUPERSEDED (`21545f60-7aa8-418b-8d8d-635a4c1d08ed`, APR-2026-0012), history kept |
| Writes | generation 1 `xero:invoice:1b6486b9-…` DONE (1 attempt); generation 2 `…:g2` DONE (1 attempt) |
| Xero link | exactly 1 Xero invoice link for INV-2026-0040 → `61e09cad…`, verified |
| Replacement in Xero | latest read (`RECON-20261008-195108-6ad0`): VERIFIED **DRAFT**, 15,155.98, paid 0.00, credited 0.00, pinned tenant. 05's read-back: RO-INV-2026-0040, subtotal 13,778.16 + GST **1,377.82** = **15,155.98**; contact RO-CUST-0002 Mia Campbell [CUST-0002] (the same Xero ContactID as the customer's link); reference PRJ-2026-0002; Demo Company (AU), the **pinned** tenant; 1 live invoice with that number |
| Original in Xero | last read (`RECON-20261008-194617-0618`): VERIFIED **DELETED**, paid 0.00, credited 0.00, pinned tenant |
| Xero UI (the owner's signed-in Demo session, page text only, no clicks, about 10:00 UTC) | `21545f60…`: "Invoice RO-INV-2026-0040 — **Deleted**", 15,155.98. Draft list (6): **exactly one RO-INV-2026-0040** (15,155.98, Mia Campbell [CUST-0002], PRJ-2026-0002). All list (55 live items): RO-INV-2026-0040 **once**, Draft, paid 0.00, not sent; RO-INV-2026-0039 Draft 14,664.49 unchanged |
| Entitlement consumed exactly once | `project_billing(PRJ-2026-0002)`: entitlement **50,519.92**, billed **50,519.92**, **remaining 0.00**. One FINAL on the project (INV-2026-0040 APPROVED); balance outstanding 15,155.98, paid 0.00 |
| No second final invoice or second reissue possible | `invoice_final_preview`: refused, "PRJ-2026-0002 already has a final invoice (INV-2026-0040)". `invoice_reissue_check`: refused, `INVOICE_NOT_VOIDED` |
| Dispatch | token hash length **0** |
| Nothing else running | outbox in flight 0; running reconciliation 0; open approvals 0 (13 in total, REISSUE 1); payments 27, 0 on INV-2026-0040; no reconciliation since `RECON-20261008-195108-6ad0` |

## 2. Airtable synchronisation: one repair. PASS

| Step | Result |
|---|---|
| Scheduled repair? | not yet: the daily repair is 16:30 UTC; no run since Stage 3C |
| Airtable before | PRJ-2026-0002 *Xero Invoice ID* `21545f60…` (stale); Invoice Status "Xero draft created", Number RO-INV-2026-0040 and Amount 15,155.98 already correct. **No Projects row had an Invoice Action set**, so a repair had no pending staff decision to replay |
| Observe run `RECON-20261008-200052-89da` (10:00:52) | **the complete proposed change set: 1 finding.** AIRTABLE PRJ-2026-0002 *Xero Invoice ID*, expected `61e09cad…`, actual `21545f60…`, SAFE_AUTO_REPAIR. Xero 2/2 VERIFIED DRAFT, 0 drift; Drive 3/3, 0 drift; dead letters 0; uncertain Xero writes 0. No financial change was proposed |
| Quota guard | a first repair request at 10:02:35 was **refused by the guard** ("a reconciliation ran less than 2 minutes ago": 102 s after the observe run *started*). **No run started** (verified: only the observe run exists). It was not bypassed. The request was repeated after the window |
| Repair `RECON-20261008-200334-8bec` (10:03:34, the one repair) | **1 finding, REPAIRED_AIRTABLE**: one Airtable write, `recbBZIwsTX5SgMHH` `fld3sDI9LIX8Voo4u` → `61e09cad…` (replacing `21545f60…`), issued 10:03:36, **read back and verified 10:03:39** (`airtable.writeback.verified`). Airtable drift now 0; Xero and Drive 0 drift. **0 invoices, 0 approvals, 0 payments, 0 exceptions changed**; 0 in flight after |
| The echo | Airtable's change webhook delivered the write to **06 (execution #2408, 10:03:39)**. It advanced the cursor (to 52) and changed no canonical state: no audit, no exception, no further write |
| Airtable after (independent read) | *Xero Invoice ID* **`61e09cad-38d9-49e5-b537-bba0d185786b`**, Number RO-INV-2026-0040, Amount 15,155.98, Status "Xero draft created", Invoice Action empty |

## 3. Exceptions: both resolved through the supported path

Inspected first (read-only):
- **EXC-0020**: EXTERNAL_MISSING, reconciliation, invoice PRJ-2026-0002, "Xero invoice RO-INV-2026-0040 is deleted".
- **EXC-0021**: INVALID_STATE, project_to_invoice, "Final invoice INV-2026-0040 was voided (…): a replacement final invoice needs a person …".

Both were OPEN, created 09:38:16 by `RECON-20261008-193809-1f4c`, with no earlier audit. The reconciler never auto-resolves these two classes.

Both conditions are conclusively answered:
- **EXC-0020:** the deletion was intended (Stage 3B). The invoice's canonical link now points to a verified live DRAFT with the same number, and two later reconciliations show 0 Xero drift with no EXTERNAL_MISSING finding.
- **EXC-0021:** the replacement final invoice it asked a person for exists, made through the supported reissue.

`npm run exception:resolve -- EXC-00NN --by EMP-900 --note "…"` uses `ops_resolve_exception`. EMP-900 is FINANCE and active, a role in `exception.resolver_roles`.

| Exception | Result |
|---|---|
| EXC-0020 | **RESOLVED** by EMP-900 at 10:05:31 UTC; one `exception.resolved` audit row (USER:EMP-900). Note (753 characters, stored intact): the owner's Stage 3B deletion of `21545f60…`; the DELETED read in `RECON-20261008-193544-7ea3`; the void by repair `RECON-20261008-193809-1f4c`; the replacement **APR-2026-0013**, generation 2, DRAFT **`61e09cad…`**, RO-INV-2026-0040, 15,155.98 inc GST 1,377.82; verified by `RECON-20261008-200052-89da` and `-200334-8bec` |
| EXC-0021 | **RESOLVED** by EMP-900 at 10:06:03 UTC; one audit row. Note (822 characters, stored intact): **APR-2026-0013**, dispatched once through 08 #2401 and 05 #2402; DRAFT **`61e09cad…`** replacing **`21545f60…`** (deletion verified and applied by the two runs above); INV-2026-0040 APPROVED/SYNCED; generation 1 SUPERSEDED, generation 2 CREATED; billing remaining 0.00 |

Each exception row is kept as it was: its class, message, attempts and creation time. Only the resolution fields were set.
- Still open, and not related to this work: EXC-0003 (PRJ-2026-0008), EXC-0013 (Q-2026-0035), EXC-0016 (PRJ-2026-0007),
  EXC-0017 (PRJ-2026-0031).

## 4. Final verification: PASS

| Check | Result |
|---|---|
| Read-only reconciliation `RECON-20261008-200624-1313` (10:06:24) | **0 drift**: Airtable 231/231, Drive 3/3, Xero 2/2 (INV-2026-0040 VERIFIED DRAFT on `61e09cad…`, 15,155.98, paid and credited 0, pinned tenant; INV-2026-0039 VERIFIED DRAFT unchanged). "No drift found." All three Airtable webhooks OK, 0 unread |
| Integrity | **28 PASS / 4 WARNING / 0 FAIL** (the `drift` warning cleared). The 4 warnings predate AC-14C: PRJ-2026-0001's open supplier order, Q-2026-0031 without a project, open exceptions EXC-0003/0013/0016/0017, completion items still To do |
| Security | **all PASS**: no readable tables or PUBLIC functions; RLS everywhere; reissue functions not executable by app roles; tenant pinned; reconcile token stored as a hash; **dispatch token hash blank (length 0)** |
| One live Xero draft | Xero UI (§1) and the read-back: exactly one live RO-INV-2026-0040 (`61e09cad…`, DRAFT); the original `21545f60…` Deleted |
| No new approvals, duplicates, payments or credits | approvals 13 (REISSUE 1, open 0); invoices unchanged; 1 FINAL on the project; payments 27; credited 0.00 in every Xero read; 0 Xero links created |
| Staff-facing Xero InvoiceID | the project's *Xero Invoice ID* field is `61e09cad…`. **Not met for the free-text *Invoice Preview* field** (§5, item 1) |
| Dispatch credential | hash blank; **08 Reissue Dispatch: 0 saved executions** |
| n8n since Stage 3C | one saved execution only: 06 #2408 (the echo above). No 04, 05 or 08 run. 07 (success and error saving off) and 08-health (success saving off) keep no runs: 0 saved each |
| Workflows unchanged | public API read: 05 active `feab88d9…`, 07 active `a0ca9e60…`, 08 Reissue Dispatch active `facd57c8…` (`availableInMCP` false, all saving off, `callerPolicy` none); nothing published or edited in this stage |
| Open exceptions for this reissue | **none** |
| Unrelated records | whole-database diff since the end of Stage 3C: **51 of 62 tables byte-identical**, including invoices, invoice_lines, approvals, payments, outbox, the ledger, projects, customers, processed_events and workflow_runs. The other 11 are all attributable: **reconciliation_runs** +3 (the three runs) and their findings (+2), Xero observations (+6), integration_health (+20; also the scheduled 08-health probe at 10:00:52), re-read airtable_observations (same rows) and external_links (re-verification timestamps only; 0 created); **airtable_writes** +1 (the repair's write); **automation_events** +1 (its verification); **integration_cursors** (the Airtable cursor, advanced by 06); **workflow_exceptions** (EXC-0020 and EXC-0021 resolved); **audit_events** +5 (3 `reconciliation.completed`, 2 `exception.resolved` by EMP-900) |

## 5. Remaining items (not done; for the owner)

1. **Stale staff-facing text: *Invoice Preview* (`fldt9KIOPXh3c3pGU`) on PRJ-2026-0002.**
   - It still reads "XERO DRAFT RO-INV-2026-0040 (InvoiceID 21545f60-…) … Approved by Demo Finance Approver under
     APR-2026-0012".
   - Under the field contract it is `WORKFLOW`-owned and `IGNORE` for reconciliation. Only 04 writes it, at prepare or
     approve. The CLI reissue path never refreshes it, and no reconciliation can.
   - It is not financial: the *Xero Invoice ID* field, the status, the number and the amount are all correct.
   - It does name the deleted invoice's ID. A supported fix (the reissue projecting a refreshed preview) is a later code
     change. A hand edit in Airtable was not authorised and was not made.
2. **Cosmetic: `invoices.voided_reason`** on INV-2026-0040 still reads "Deleted in Xero (verified by reconciliation
   RECON-20261008-193809-1f4c)" although the invoice is APPROVED again. The same evidence is kept in the approvals, the
   ledger and the audit trail.
3. **Pre-existing warning: the 08-health Google Drive probe** fails intermittently with HTTP 403 (`roofops_roots: 0`).
   - It has done so every day since 2026-09-28 (6 to 31 of about 48 probes a day), including the 10:00:52 probe today.
   - Every reconciliation verified the 3 Drive folders.
4. **Not observed yet:** the first scheduled 07 run (16:30 UTC) since 07's execution-saving settings changed in
   Stage 2A.
5. **Recommended in Stage 3A, not applied:** turn off `availableInMCP` on 07.
