# Functional coverage

One row per user-visible action. Each system column says what that system does for the action. **Result** is one of
**A** verified end-to-end path, **B** verified safe failure, **C** explicitly not supported. "—" means the system is not
involved.

| Action | Airtable | n8n | Postgres | Drive | Xero | Dashboard | Copilot | Result |
|---|---|---|---|---|---|---|---|---|
| Quote accepted | Status → Accepted | 01 → 02 → 03 | `wf_quote_accepted`, project + outbox | folder + 5 subfolders, read back | — | new project | reads it | **A** (Phase 2 live) |
| Quote sent / lost / expired | Status | 06 | `quote_apply_change` | — | — | KPIs | reads it | **A** (live: Q-0033) |
| Quote invalid change | Status | 06 | refused | — | — | unchanged | unchanged | **B** |
| Project status change (legal) | Status (+ Status Reason) | 06 | state machine + guards, audit | — | — | new stage | new stage | **A** (live ×3) |
| Project status change (illegal) | Status | 06 → PATCH + read-back | refused, audit event | — | — | unchanged | unchanged | **B** (live PRJ-0010) |
| Project cancelled after completion | Status | 06 / 07 | cancel, withdraw preview, cancel tasks | kept | kept | Cancelled; not ready to invoice | Cancelled | **A** (live PRJ-0001) |
| Schedule change | Planned dates | 06 | validated | — | — | risk recalculated | reads it | **A** (live PRJ-0013) |
| PM change | Project Manager | 06 | must be an active PM | — | — | shows PM | reads it | **A** (test) |
| Actual dates edited | Actual Start/Completion | 06 | reverted | — | — | unchanged | unchanged | **B** (test) |
| Supplier confirmed / delivered | PO Status | 06 | forward machine, timestamps | — | — | materials status | reads it | **A** (live PO-0011) |
| PO backwards / after delivery | PO Status | 06 | refused | — | — | unchanged | unchanged | **B** (test) |
| Delivery date change | Expected Delivery | 06 | validated | — | — | materials ETA | reads it | **A** (test) |
| Customer / property / supplier edit | any field | 06 | reverted with a note | — | — | unchanged | unchanged | **B** (live CUST-0002) |
| Create a record in Airtable | new row | 07 | UNKNOWN exception | — | — | exception | lists issue | **C** (reported) |
| Delete a record in Airtable | delete | 07 | EXTERNAL_MISSING exception | — | — | exception | lists issue | **C** (reported) |
| Material review task complete | — | — | — | — | — | shown | shown | **C** |
| Invoice prepare | Invoice Action / dashboard | 04 | preview (hashed) | — | — | awaiting approval | card from DB | **A** (Phase 3 live, Promptfoo) |
| Invoice approve | Invoice Action | 04 → 05 | invoice + outbox | — | one DRAFT, read back | Xero draft created | reads it | **A** (Phase 3 live) |
| Invoice reject / stale / duplicate | Invoice Action | 04 | recorded / refused / ignored | — | nothing | unchanged | unchanged | **B** (tests, Phase 3 live) |
| Invoice for cancelled project | Invoice Action / Copilot | 04 | refused | — | nothing | not ready | refuses | **B** (live hosted, Promptfoo) |
| Approve / send / pay via Copilot | — | — | no tool exists | — | — | — | refuses | **B** (Promptfoo) |
| Xero invoice altered / voided / deleted in Xero | — | 07 | REQUIRES_HUMAN / EXTERNAL_MISSING | — | read-only GET | health page | system_health | **B** (tests; live check 1/1 verified) |
| Drive folder trashed / moved / deleted | — | 07 | EXTERNAL_MISSING / REQUIRES_HUMAN | read-only GET | — | health page | system_health | **B** (tests; live check 3/3 verified) |
| Webhook missed / n8n down | (edit made) | Airtable retry; 07 wakes consumer | applied on recovery | — | — | correct | correct | **A** (live) |
| Webhook expired / missing | — | 07 refresh / create | health recorded | — | — | alerts state | system_health | **A** (live create; test) |
| Is everything in sync? | — | 07, 08 | recorded checks | — | — | /health | system_health | **A** (live, Promptfoo) |
