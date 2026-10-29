# AC-14C Stage 3B: verified deletion of the synthetic Xero Demo draft and its reconciliation (2026-10-08)

Authorised by the owner: delete ONLY RO-INV-2026-0040 (`21545f60-7aa8-418b-8d8d-635a4c1d08ed`, INV-2026-0040,
PRJ-2026-0002) in the pinned Demo Company (AU), then reconcile.
- **No reissue, no replacement, no dispatch token, no 08 trigger, no code, schema or n8n change.**
- No secret is recorded here.
- Branch `factory/ac14-integrity-followup` at `cff93b7` when it ran.

## 1. Pre-verification: PASS (nothing differed)

| Source | Result |
|---|---|
| Postgres (read-only) | INV-2026-0040 FINAL, APPROVED/SYNCED, 15,155.98 (GST 1,377.82), APR-2026-0012 EXECUTED; Xero invoice link exactly `21545f60-7aa8-418b-8d8d-635a4c1d08ed` (verified); ledger generation 1 CREATED, not superseded, pinned tenant; one generation-1 write DONE; **0 local payments**; outstanding 15,155.98; billing remaining 0.00; 0 in flight, 0 pending or REISSUE approvals, dispatch hash blank; integrity 0 FAIL |
| Xero (independent read, observe run `RECON-20261008-192900-0260`, 0 drift) | the exact InvoiceID is VERIFIED, **DRAFT**, total 15,155.98, due 15,155.98, **paid 0.00, credited 0.00**, read in the pinned/bound tenant. RO-INV-2026-0039 is also DRAFT, and must not be touched |

## 2. Deletion

RoofOps has no delete path, and only n8n holds the Xero credential, which this stage may not change. So the supported
mechanism is the Xero Demo UI. The browser pane opened at the exact invoice reached Xero's login page; credentials
cannot be entered by the assistant. **The owner deleted RO-INV-2026-0040 in Demo Company (AU).** A read of the owner's
signed-in pane (page text only, no clicks) then showed the banner **"Invoice deleted"**, RO-INV-2026-0040 absent from
the list, and **RO-INV-2026-0039 still Draft 14,664.49**.

## 3. Verified from Xero, then one repair

| Step | Result |
|---|---|
| Dry run `RECON-20261008-193544-7ea3` (observe) | INV-2026-0040 **VERIFIED, HTTP 200, Xero status DELETED, settlement DELETED** on the **exact InvoiceID**, read in the bound = pinned tenant, **paid 0.00, credited 0.00**. Proposed: (1) INV-2026-0040 SAFE_AUTO_REPAIR "a repair run applies it", **the only financial change**; (2) PRJ-2026-0002 EXTERNAL_MISSING "Xero invoice RO-INV-2026-0040 is deleted" (repair mode opens an exception for a person; non-financial). Airtable 231 and Drive 3: 0 drift; INV-2026-0039 VERIFIED DRAFT |
| Scoping | `npm run reconcile` cannot be scoped to one Xero invoice (its only scope is an Airtable projection reset). The dry run showed INV-2026-0040 as the sole financial change; the daily scheduled repair would apply the same change |
| Quota guard | a first repair request 64 s after the dry run was **refused by the 2-minute Airtable quota guard; no run started** (verified). The repair ran once the window had passed |
| Repair `RECON-20261008-193809-1f4c` (one run) | INV-2026-0040 **APPLIED_TO_POSTGRES**; PRJ-2026-0002 **EXCEPTION_OPENED** (EXC-0020). Airtable `drift_now: 1` (see §5) |

## 4. Verified state: PASS

| Check | Result |
|---|---|
| Canonical invoice | **INV-2026-0040 VOIDED**/SYNCED, reason "Deleted in Xero (verified by reconciliation RECON-20261008-193809-1f4c)"; audit `invoice.xero_settlement_applied` by `SYSTEM:workflow:reconciliation` |
| Entitlement preserved | `project_billing(PRJ-2026-0002)`: entitlement 50,519.92, billed 35,363.94, **remaining 15,155.98** |
| Zero collectible | `v_invoice_balances`: VOIDED, paid 0.00, **outstanding 0**, not overdue |
| No replacement or duplicate | invoices still 40; 1 FINAL on the project (the VOIDED one); **0 generation ≥ 2 writes**; **0 REISSUE approvals**; 0 pending approvals; **payments still 27**, 0 on INV-2026-0040; Xero credited 0.00 |
| History preserved | Xero link `21545f60-7aa8-418b-8d8d-635a4c1d08ed` kept (verified); ledger **generation 1 CREATED, not superseded** (`xero_invoice_id` and RO-INV-2026-0040 kept); the generation-1 write still DONE; **APR-2026-0012 EXECUTED** |
| Unrelated records | whole-database diff against the fingerprint taken before the dry run: **52 of 62 tables byte-identical** (payments, approvals, outbox, invoice_lines, ledger, projects, customers and more). Changed: `invoices` (only INV-2026-0040 → VOIDED); reconciliation runs +2, findings +4, Xero observations +4, integration_health +10, audit_events +3 (two `reconciliation.completed`, one `invoice.xero_settlement_applied`), workflow_exceptions +2, id_counters (exception and run numbers), airtable_observations (re-read values, same rows), external_links (**timestamps only**: three Drive folder links and INV-2026-0039's Xero link re-verified; no link added, removed or re-pointed) |
| Integrity | 27 PASS / 5 WARNING / **0 FAIL**. The new WARNING is `drift` (§5); the other four are the pre-existing ones |
| Security | **all PASS** (tenant pinned; dispatch hash blank, length 0) |

## 5. Open items left on purpose (no further action taken)

- **Airtable projection drift: 1 row.** PRJ-2026-0002 still shows "Xero draft created" / RO-INV-2026-0040 /
  15,155.98 / the old InvoiceID. The canonical projection now expects these invoice fields cleared. 07's Airtable phase
  runs before its Xero phase, so the same run that voided the invoice could not repair the row. It is a
  SAFE_AUTO_REPAIR for the next repair reconciliation (the daily run at 16:30 UTC). The owner allowed one repair, so no
  second one was run.
- **Exceptions for a person:**
  - EXC-0020 (EXTERNAL_MISSING): "Xero invoice RO-INV-2026-0040 is deleted".
  - EXC-0021 (INVALID_STATE, project_to_invoice): "Final invoice INV-2026-0040 was voided (…): a replacement final
    invoice needs a person, because RoofOps allows one final invoice per project".

  Both are the designed alerts. The supervised reissue (Stage 3C, not started) is the supported answer to EXC-0021.
