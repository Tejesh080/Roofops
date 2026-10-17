# Release-blocker remediation (2026-10-17, local and restored hosted copies only)

Branch `factory/ac14-integrity-followup`. No hosted data, environment variable, Airtable, Xero or n8n change.

## Confirmed and fixed

| Suspected | Confirmed? | Fix | Evidence |
|---|---|---|---|
| Hosted frozen at 2026-09-29 | Yes, intentionally: the importer sets the bundle's demo date; nothing marked it as synthetic. Invoices take issue/due dates from it: INV-2026-0041/0042, approved 16 Oct, are dated 29 Sep and due 13 Oct (Xero Demo drafts; not rewritten) | `business_date_mode` REAL / SYNTHETIC (migration keeps hosted SYNTHETIC); REAL ignores a leftover override and is reported; banner now says "synthetic … today is …" (it was hard-coded text) | `test/release-blockers.test.ts` §1; copy: switch changes derived figures only, stored records identical |
| Exclusive-GST quotes reach the financial process | Partly: `invoice_final_preview` already refused them, but only at invoicing (after the job) | Refused at quote save (and removed from the builder); the preview refusal stays as a backstop | §2 tests; `enquiry-to-quote` revision now inclusive |
| Multi-line finals differ from Xero by a cent (FIN-GST-01, known, unfixed) | Yes (arithmetic: 100.05 + 100.05 → 18.19 vs per-line 18.20) | Per-line tax shares adding up exactly; n8n 05 sends `TaxAmount`; until that 05 is deployed (`xero.line_tax_amounts`), multi-line finals stop at preview | §2 tests incl. 120 random line sets, 05's real node body |
| Unknown topics pass `done_has_proof` | Yes (`else true`) | Fails closed; quote hand-offs need 3 Airtable links | §3 |
| Abandoned claims invisible | Yes for Drive/Airtable writes | `claimed_and_abandoned` WARNING after 15 min | §3 |
| Duplicate enquiries | Yes (only customers were checked) | Open enquiries matching phone/email/name are shown; recorded only when confirmed; concurrent callers serialised | §4, real-Postgres race test, browser test |
| Visit completion mistaken for project completion | Yes (no guidance when Airtable still says Scheduled) | Next step + completion message say what is still needed and where | `next-step.test.ts`, `job-journey` |
| Stale Airtable Invoice Preview | Yes (PRJ-2026-0007 stale, PRJ-2026-0005 empty, read live) | Existing fix (20261017000000) confirmed: a repair run rewrites both | copy: repair corrections for both |
| Customer details uncorrectable | Yes | Phone/email correction for admin/ops/PM, versioned, reasoned, audited; names and record ownership not editable | §4, browser test |

## Results

- Full suite: **983 passed, 0 failed** (PGlite + PostgreSQL 17); lint and both typechecks clean; production build clean.
- Browser (local rehearsal DB, fresh reset each): sales-journey 2/2, site-work 2/2, job-journey 1/1, invoice-approval 3/3,
  staff-journey 2/2, operations 2/2, dispatch-gate 1/1.
- Restored hosted copy (`pre-release-ops-sales-20261017-000023.dump`): 4 migrations via the real runner (53/79/105/68 ms);
  integrity 29/3/0 → 28/4/0 → **29/5/0** (new checks: business date synthetic WARNING; abandoned claims PASS; proof PASS);
  security 16/16 after adding the two reviewed dashboard functions; acceptance, Drive completion, 04, 09 and the Sales chain
  unchanged; rollback (4 scripts, reverse order) restores pristine definitions, re-apply identical.
- Date switch on the copy: overdue invoices 2 → 8, projects with risk reasons 6 → 17, past planned completion 1 → 15,
  open tasks overdue 0 → 3; stored dates/amounts/statuses identical.

## Not fixed (release blockers or approvals)

- Hosted still SYNTHETIC until `ops/business-date-switch-to-real.sql` is approved and run.
- n8n 05 with `TaxAmount` is not deployed; multi-line finals stay blocked until it is (and a supervised Demo test).
  Xero's acceptance of an overridden line TaxAmount is documented but **unverified** against Xero.
- Airtable lacks 7 select options (blocks Sales hand-offs).
- Wrong customer chosen at conversion: not correctable in RoofOps; procedure in `docs/customer-corrections.md`.
