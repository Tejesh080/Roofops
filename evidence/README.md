# Evidence

Records of what was checked, when, and what it showed. Every file here is a record: it is never edited after the fact.

**From 30 Oct 2026, per-defect evidence files stop** (`docs/master-plan.md` Task 3.3):
- **A code change** is evidenced by its pull request (the tests run, CI green) and its row in `docs/defect-ledger.md`.
- **A hosted change** adds one file per release, `evidence/release-<YYYYMMDD>.md`, written by line 6 of
  `ops/release-checklist.md`.

Paths inside older files may name documents that have since moved to `docs/archive/`.

## Hosted releases and operations

| File | What it records |
|---|---|
| [advanced-release-preflight-20261023.md](advanced-release-preflight-20261023.md) | The waiting release: backup and read-only preflight (23 Oct) |
| [recovery-report-20261022.md](recovery-report-20261022.md) | Project recovery report (22 Oct) |
| [quote-integration-test-20261020.md](quote-integration-test-20261020.md) | First real quotation hand-off: hosted Supabase, n8n Cloud, Airtable (20 Oct) |
| [pilot-release-deployment.md](pilot-release-deployment.md) | Pilot release: hosted deployment (8 Oct) |
| [pilot-staff-journey.md](pilot-staff-journey.md) | Pilot readiness: environment, security review, local staff journey (9 Oct) |
| [ac14c-demo-preflight-hosted.md](ac14c-demo-preflight-hosted.md) | AC-14C: read-only hosted preflight (8 Oct) |
| [ac14c-demo-backup-readiness.md](ac14c-demo-backup-readiness.md) | AC-14C: hosted backup and recovery readiness (8 Oct) |
| [ac14c-stage1-hosted-migration.md](ac14c-stage1-hosted-migration.md) | AC-14C stage 1: hosted database migration |
| [ac14c-stage2a-n8n-deployment.md](ac14c-stage2a-n8n-deployment.md) | AC-14C stage 2A: n8n deployment |
| [ac14c-stage3a-gen1-invoice.md](ac14c-stage3a-gen1-invoice.md) | AC-14C stage 3A: first supervised final invoice in Xero Demo |
| [ac14c-stage3b-delete-and-reconcile.md](ac14c-stage3b-delete-and-reconcile.md) | AC-14C stage 3B: verified deletion of the Xero Demo draft, reconciled |
| [ac14c-stage3c-hosted-reissue.md](ac14c-stage3c-hosted-reissue.md) | AC-14C stage 3C: supervised reissue in hosted RoofOps and Xero Demo |
| [ac14c-stage3d-closeout.md](ac14c-stage3d-closeout.md) | AC-14C stage 3D: synchronisation, exception closure, final verification |

## Live verification records (hosted, read back)

| Files | What they record |
|---|---|
| [ac01](ac01-live-verification.json), [ac02](ac02-live-verification.json), [ac03](ac03-live-verification.json), [ac04](ac04-live-verification.json), [ac05](ac05-live-verification.json), [ac06](ac06-live-verification.json), [ac08](ac08-live-verification.json), [ac09](ac09-live-verification.json), [ac10](ac10-live-verification.json), [ac13a](ac13a-live-verification.json), [ac14](ac14-live-verification.json) | Each acceptance criterion verified on the hosted system |
| [ac02-airtable-read-2026-10-01.json](ac02-airtable-read-2026-10-01.json) | The Airtable read behind AC-02's verification |
| [ac03-exact-preview-live-verification.json](ac03-exact-preview-live-verification.json), [ac03-hosted-checks.txt](ac03-hosted-checks.txt) | AC-03: the exact invoice preview, and the hosted checks |
| [ac10-origin-live-verification.json](ac10-origin-live-verification.json), [ac10-hosted-checks.txt](ac10-hosted-checks.txt) | AC-10: the origin check, and the hosted checks |
| [business-date-live-verification.json](business-date-live-verification.json) | The fixed business date |
| [demo-reset-airtable-live-verification.json](demo-reset-airtable-live-verification.json) | The demo reset of Airtable |
| [exception-resolution-live-verification.json](exception-resolution-live-verification.json) | Resolving a workflow exception |
| [e2e-1-created.json](e2e-1-created.json), [e2e-2-after-duplicates.json](e2e-2-after-duplicates.json) | One run end to end: what was created, then the same after duplicate deliveries |
| [transient-1-recovered.json](transient-1-recovered.json), [transient-2-exhausted.json](transient-2-exhausted.json), [transient-3-recovered-after-requeue.json](transient-3-recovered-after-requeue.json) | A transient failure: recovered; retries exhausted; recovered after a requeue |
| [validation-0-before.json](validation-0-before.json), [validation-1-after.json](validation-1-after.json), [validation-2-after-fix.json](validation-2-after-fix.json) | A validation failure: before, after, and after the fix |
| [reconcile-drive-rate-limit-verification.json](reconcile-drive-rate-limit-verification.json) | The nightly reconciliation under a Google Drive rate limit |
| [phase3-airtable-readback.json](phase3-airtable-readback.json), [phase3-prj-2026-0004-postgres.json](phase3-prj-2026-0004-postgres.json), [phase3-xero-readback.json](phase3-xero-readback.json) | Phase 3: Airtable read-back, PRJ-2026-0004 in Postgres, Xero read-back |
| [phase4-copilot-smoke.json](phase4-copilot-smoke.json) | Phase 4: the Copilot smoke test |

## Offline verifications (one per defect, until 30 Oct)

| File | What it records |
|---|---|
| [ac13b-offline-verification.md](ac13b-offline-verification.md) | AC-13B: the pre-start gate before work starts |
| [ac14b-offline-verification.md](ac14b-offline-verification.md) | AC-14B: a verified Xero void is not an integrity failure |
| [ac14c-partA-offline-verification.md](ac14c-partA-offline-verification.md) | AC-14C part A: a Xero-verified deletion follows the void path |
| [ac14c-partB1-offline-verification.md](ac14c-partB1-offline-verification.md) | AC-14C part B1: one live Xero draft generation at a time |
| [ac14c-partB2-offline-verification.md](ac14c-partB2-offline-verification.md) | AC-14C part B2: the supervised final-invoice reissue |
| [ac14c-partC-offline-verification.md](ac14c-partC-offline-verification.md) | AC-14C part C: the supervised recovery end to end |
| [ac14c-p2-followup-offline-verification.md](ac14c-p2-followup-offline-verification.md) | AC-14C audit follow-ups |
| [ac15-offline-verification.md](ac15-offline-verification.md) | AC-15: a fully billed job is not cancelled |
| [ac15b-ac13c-offline-verification.md](ac15b-ac13c-offline-verification.md) | AC-15B and AC-13C: lifecycle guard follow-ups |
| [ac21-offline-verification.md](ac21-offline-verification.md) | AC-21: purchase orders follow their job |
| [ac23-ac25-ac18-offline-verification.md](ac23-ac25-ac18-offline-verification.md) | AC-23, AC-25, AC-18: quote acceptance is deterministic |
| [ops-02-offline-verification.md](ops-02-offline-verification.md) | OPS-02: a cancelled job frees its site visits |
| [copilot-guards-offline-verification.md](copilot-guards-offline-verification.md) | Copilot read coverage and guards (AC-22, COP-01, COP-02) |
| [fin-gst-followups-offline-verification.md](fin-gst-followups-offline-verification.md) | FIN-GST-01 follow-ups and LIFE-01 |
| [ops-01-site-visits-and-tasks.md](ops-01-site-visits-and-tasks.md) | OPS-01: site visits, tasks and next steps (local) |
| [sales-01-enquiry-to-quote.md](sales-01-enquiry-to-quote.md) | SALES-01: enquiry to quote (local) |
| [quote-publish-lifecycle.md](quote-publish-lifecycle.md) | The quote publishing lifecycle |
| [release-blockers-sprint.md](release-blockers-sprint.md) | Release-blocker remediation (local and restored hosted copies) |

## Sprint records

| File | What it records |
|---|---|
| [sprint-2-tracker.md](sprint-2-tracker.md) | Sprint 2: testing and hardening |
| [autonomous-sprint-progress.md](autonomous-sprint-progress.md) | An autonomous sprint's progress checkpoint |

## RoofOps Lite

| File | What it records |
|---|---|
| [lite-mvp-local-verification-20261020.md](lite-mvp-local-verification-20261020.md) | The client-ready MVP, verified locally (20 Oct) |
| [lite-cloud-demo-20261020.md](lite-cloud-demo-20261020.md) | The cloud demonstration (20 Oct) |
| [lite-v2-batch-a-20261021.md](lite-v2-batch-a-20261021.md) | v2 batch A: Airtable additions |
| [lite-v2-batch-b-20261021.md](lite-v2-batch-b-20261021.md) | v2 batch B: n8n workflows and acceptance tests |
| [lite-factory-fixes-20261021.md](lite-factory-fixes-20261021.md) | Eleven review findings reproduced and fixed |
| [lite-factory-release-gate-20261021.md](lite-factory-release-gate-20261021.md) | Release gate: four blockers closed |
| [lite-factory-release-gate-2-20261021.md](lite-factory-release-gate-2-20261021.md) | Release gate 2: three SMS safety failures closed |
| [lite-factory-cloud-acceptance-20261021.md](lite-factory-cloud-acceptance-20261021.md) | The fixes deployed to n8n Cloud and accepted on real Airtable |
| [lite-package-demo-20261021.md](lite-package-demo-20261021.md) | The complete package, demonstrated end to end |
| [lite-twilio-starter-20261021.md](lite-twilio-starter-20261021.md) | The Twilio trial on n8n Starter |
| [lite-live-acceptance-plan-20261021.md](lite-live-acceptance-plan-20261021.md) | The controlled live Twilio acceptance: plan |
| [lite-live-test-prep-20261021.md](lite-live-test-prep-20261021.md) | The final live test, prepared |
| [lite-activation-investigation-20261022.md](lite-activation-investigation-20261022.md) | The activation discrepancy and Twilio configuration risks (read-only) |
| [lite-cleanup-20261029.md](lite-cleanup-20261029.md) | The clean-up after the 21 Oct live test |
