# RoofOps Master Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. A step marked 🔒 touches a hosted system (Supabase, n8n Cloud, Airtable, Vercel, Xero, Twilio) and needs the owner's approval **in chat, for that step, at that time**. A step marked ✍️ is the owner's own (accounts, payments, identity checks); the engineer prepares, the owner performs. Nothing in this file is a standing approval.

**Written:** 2026-10-29. **Owner:** Tejesh (sole engineer, with Claude). **Supersedes:** the phase plans implied by `ops/pilot-release-checklist.md`, `ops/ops-sales-release-plan.md` and the per-defect sprint pattern. Those documents stay as records; this file is the plan we follow.

**Goal:** Turn what is already built, RoofOps Lite and Advanced RoofOps, into systems a roofing business can trust, by adding the rails that are missing (CI, staging, alerting, a production SMS account, off-platform backups) and then proving each product with a person, not by adding features.

**Architecture:** Keep the existing design: Postgres (Supabase) as the canonical store with state machines, outbox and idempotency in the database; n8n Cloud for orchestration; Airtable as the office view with per-field ownership (`field_contract`); the Next.js dashboard on Vercel for approvals and the Copilot; Xero drafts from approved, hashed previews. Lite stays a separate package (its own Airtable base, its own n8n workflows, Twilio). What changes is how work lands: every change is a small PR that CI runs, hosted changes go out every one to two weeks through one short checklist, and failures page the owner instead of waiting to be noticed.

**Tech stack:** TypeScript 6, Node 24, vitest 5 on PGlite 0.5 and Postgres 17, Playwright 1.63, Next.js 16, n8n Cloud (workflows as `n8n/*.sdk.ts`), Supabase, Airtable, Xero (`xero-node` patterns via n8n HTTP), Twilio, GitHub Actions, healthchecks.io.

**Spec and evidence this plan argues from:**
- `reports/RoofOps master plan research.md` (29 Oct 2026; 159 cited sources; notes in `research_notes/RoofOps master plan research/`).
- `evidence/advanced-release-preflight-20261023.md` and `ops/advanced-release-runbook-20261023.md` (the waiting release).
- `evidence/lite-activation-investigation-20261022.md` §6 (the Lite clean-up list) and `lite/DELIVERY-CHECKLIST.md`.
- `docs/defect-ledger.md`, `docs/functional-coverage.md`, `docs/decisions.md` (ADR-001 to ADR-040).

---

## 0. How to use this plan

1. Work top to bottom inside a phase; phases 0 and 1 are detailed to the step, phases 2 to 4 are detailed to the task and get their own step-level plan (same format, `docs/plans/<phase>.md`) when they start.
2. A task is finished when its **Done when** line is true and observed, not when the code exists.
3. One PR per task (or smaller), CI green, merged to `main`. No direct commits to `main` once Task 0.2 lands. Phase 0 is the one exception: it is the PR that creates CI, so its local tasks (0.1 to 0.5) go out as one PR on branch `phase0/safety-net`, one commit per task, and CI runs on that PR itself.
4. Hosted steps happen only with 🔒 approval in chat. If a step's precondition has changed since approval (a preflight older than 7 days, a different hosted head, an unexpected error execution), stop and re-ask.
5. Nothing outside this plan gets built until Phase 2 is done. New catalogue hypotheses, new features and new evidence formats wait. A defect found by a person doing the walkthrough (Phase 2) outranks everything in the catalogue.
6. Lite and Advanced stay separate: separate Airtable bases (Task L3), separate n8n workflows and credentials, separate configs. No shared tables.

## 1. Where we are (29 Oct 2026)

| | Advanced RoofOps | RoofOps Lite |
|---|---|---|
| Built | 64 migrations, 155 SQL functions, 16 n8n workflows, dashboard + Copilot, 1,335 tests passing (37 skipped) on PGlite and Postgres 17, 11 Playwright specs | Airtable CRM (6 tables + Interface), 5 n8n workflows, lead form, Twilio relay, 70 tests, config-driven build |
| Live | Quote → project → Drive folder → Airtable write-back → staff edits validated → invoice approval → Xero Demo draft → nightly reconcile; health recorded | Run in n8n Cloud against the shared demo base, in test-sink mode; Twilio connected |
| Never done for real | A person using it for a week; sales and site visits used by staff; a real Xero tenant; real data (business date frozen at 2026-09-29) | A real SMS. The 21 Oct test stopped on Twilio's trial "From" rule (the live API returned 572003; Twilio's error dictionary lists the same message as 572002) |
| Waiting | 15 fixes "Fixed offline" (8 migrations + n8n 06/03/05 + dashboard), rehearsed on a restored dump, preflighted 23 Oct (integrity 0 FAIL, security 16/16) | Clean-up of the 21 Oct test: Inbound Replies still published; two drafts hold live config; no error workflow |
| Missing rails | No CI, no staging, no alerting, no off-platform backup routine, hosted credentials in `.env.local` where the coding agent runs, two unauthenticated replay inputs (INT-03), no Airtable ping authenticity check | Trial Twilio account; shared Airtable base (every Lite write wakes Advanced's 06); no inbound signature check; no spam protection on the lead form |
| Repo | `main` = `9ec47ae`, public, 169 commits in 30 days (two multi-day gaps); 2 stray worktrees; 5 merged local branches; `ops/staging/` + `test/staging.test.ts` untracked; 14,316 lines of docs/ops/evidence | `lite/` on `main`; DELIVERY-CHECKLIST says 49 tests, README says 70 |

## 2. What the research changed in the plan

The full argument is in `reports/RoofOps master plan research.md`. The decisions it drives:

1. **Stop widening.** No open-source trades/field-service project above 30 stars exists; the complete ones converge on 12 to 25 entities and five daily flows. RoofOps already exceeds that scope. The gap is rails, not tables.
2. **Four controls, under A$40/month, first.** Every documented AI-built production loss of 2025–26 (Replit/SaaStr, PocketOS/Cursor, the Lovable RLS CVE) shared the same three missing controls: the agent could reach production credentials, no backup outside the blast radius, no confirmation gating on destructive steps. Phase 0 closes those before anything else.
3. **CI shape is settled.** Postgres service container, migrate from scratch on every PR, `concurrency: cancel-in-progress`, Playwright with `--with-deps` and artefacts uploaded `if: !cancelled()`. Public repo = unlimited Actions minutes and free secret scanning + push protection, so **the repo stays public**; the identifiers in it (base ids, webhook paths) are not secrets, but open webhook paths are open endpoints, which Tasks 0.4 and 1.5 close.
4. **Down migrations are documentation.** Keep `ops/rollback/`, test one round trip in CI, but the recovery plan is backups + expand/contract + forward fixes.
5. **Ship the waiting release as one batch, then never again.** The research says one PR per fix; the 8 migrations were rehearsed together on a restored dump with a verified round-trip rollback, several redefine the same functions, and splitting them now would cost weeks of re-rehearsal for no safety gain. After this release, every hosted change is small and goes out within two weeks.
6. **Two-way Airtable sync is the biggest trust risk.** No open-source two-way sync with loop handling exists; practitioners report phantom records and retreat to one-way. RoofOps already has what the sources recommend (per-field ownership, one validated entry point, a sync log). The plan adds the two things it lacks: the sync log visible where the office looks daily, and a **written retreat position with a trigger** (Task 3.4).
7. **Lite needs an Australian mobile long code, not an alphanumeric sender.** Alphanumeric IDs are one-way (no "STOP" replies) and need ACMA Sender ID Register entry from 1 Jul 2026; a lead-follow-up product that expects replies needs a mobile number with business KYC (3–5 business days). The trial account cannot serve anyone. The Twilio upgrade starts on day 1 because it is the longest lead time with no engineering dependency.
8. **Adoption has a known shape.** Office first (enquiry, quote, invoice, Xero), one crew chosen for influence, a Monday go-live after which every new job is in the system, a date on which the spreadsheet dies, weekly Xero reconciliation for a quarter. The exit tests are "a full day with no paper fallback" and "no double entry".
9. **Trust is a weekly human loop.** In every first-hand account, the owner walking the product weekly, not the test count, caught the agent's overclaims. From Phase 2 the owner spends 15 minutes a week on a walkthrough and writes one line.

## 3. Definition of done

**Lite, complete and demo-ready:** on the upgraded Twilio account with an AU mobile number, with the allowlist set to the owner's phone only: a new lead sends one real SMS (Sent, then Delivered with a SID), a reply is logged Received and reopens the enquiry, STOP opts the person out and a new lead from that number gets nothing, a deliberate failure raises a Workflow Failed alert, and the reply webhook refuses an unauthenticated request. Recorded in `evidence/lite-live-acceptance-<date>.md`.

**Lite, first client:** `lite/DELIVERY-CHECKLIST.md` §1–§6 ticked on the client's own Airtable, n8n and Twilio accounts, then 4 weeks of watched use with zero unexplained sends and zero complaints.

**Advanced, convincing demo:** CI green on `main`; the 15 waiting fixes live; alerts proven by a forced failure; one full journey (enquiry → quote → acceptance → project → site visit held by the pre-start gate → purchase order → completion → invoice approval → Xero Demo draft → nightly reconcile 0 drift) performed by a person in the browser and in Airtable, recorded with screenshots and a video.

**Advanced, trusted by a business:** on a separate production stack with real master data and a real Xero organisation, 12 consecutive weeks in which every week the RoofOps-versus-Xero reconciliation is 0 drift or explained, no failure went unalerted, and the owner used a RoofOps number (margin, outstanding invoices, blocked jobs) in a decision.

## 4. Timeline

Assumes 15–20 focused hours a week from the owner-engineer with Claude, approvals answered within a day, and no new features. Dates are calendar, Australia.

| Phase | When | Gate to leave it |
|---|---|---|
| 0. Safety net | 30 Oct – 5 Nov | CI required on `main`; hosted credentials outside the repo; INT-03 fixed in code; Lite cleaned up; owner's accounts started |
| 1. Deploy and alerts | 6 – 19 Nov | Release live and evidenced; alerts proven; e2e in CI; staging preview working; Airtable ping authenticity live |
| Lite complete | by 20 Nov (KYC permitting) | Definition of done above |
| 2. Complete demo | 20 Nov – 10 Dec | Journey evidence + video; Xero contract checklist; engineer-unavailable runbook |
| 3. Simplify | 1 – 19 Dec (overlaps 2) | Current definitions in git with a CI gate; n8n drift check; docs consolidated; editing-surface rules written |
| 4. Business pilot | 12 weeks from a start the business chooses (earliest mid-Jan 2027, after the building shutdown) | 12 clean weeks |
| Lite first client | 3–5 weeks after a client signs | 4 watched weeks |

Why these are shorter than the last month suggests: the work no longer waits on a new runbook per change, on a batch big enough to be scary, or on the agent re-deriving the state of hosted systems each session. The constraint becomes the owner's approval latency and the Twilio/Supabase lead times, which this plan starts first.

## 5. Global constraints (verbatim, from the owner)

- "Never expose secrets, bypass approval gates, or make unapproved changes to live customer, financial, or operational data."
- "Do not force-push, delete data, activate live integrations, or deploy production changes without explicit approval."
- "Do not send SMS, change live webhook settings, or activate or deactivate workflows without explicit approval."
- "Keep Advanced Roofops and Roofops Lite separate."
- "Do not submit anything to Xero, including Xero Demo, without explicit approval."
- "Do not give the AI unrestricted database access."
- "Do not push branches or merge into the protected main branch without approval."
- "Do not weaken existing tests."
- Commits and PRs carry no Claude attribution lines.
- Read-only hosted checks (`npm run integrity:check`, `npm run security:check`, `npx tsx scripts/sql.ts --read-only`) are allowed without approval; every hosted write is 🔒.

## 6. Review focus

The five failure modes most likely to hurt a person using the software, and the test that pins each one:

1. **A staff edit in Airtable is silently reverted or echoed** (two editing surfaces). Pinned by the existing `field_contract` tests, plus Task 3.4's e2e assertion that the sync log is on the dashboard page the office opens daily.
2. **A scheduled workflow stops being triggered and nobody notices** (paused workflow, expired webhook, n8n incident). Pinned by Task 1.2: skipping one heartbeat produces an email inside the grace period.
3. **A forged Airtable ping moves a cursor or replays events.** Pinned by Task 0.4 (body cursor ignored) and Task 1.5 (ping without a valid `X-Airtable-Content-MAC` rejected).
4. **A real SMS goes to the wrong person, after STOP, or twice.** Pinned by the 70 Lite tests plus Task L6's live acceptance with the allowlist set to one phone and STOP exercised in the same run.
5. **A release applies a migration twice or against a schema it was not rehearsed on.** Pinned by Task 0.2's `db` job (migrate from scratch on every PR, rollback round trip for the newest migration) and Task 1.1's re-preflight rule (hosted head must equal the rehearsed head).

---

## 7. Phase 0: safety net (30 Oct – 5 Nov)

### Task 0.1: Hosted credentials out of the agent's reach, writes need a confirmation

**Files:**
- Modify: `src/config/env.ts` (`loadLocalEnv`, `hostedDbConfig`; new `HOSTED_ONLY_KEYS`, `hostedEnvDir`, `loadHostedEnv`, `supabaseProjectRef`, `confirmHostedWrite`)
- Modify: every hosted-write script: `db-load` (`--hosted`), `sql` (without `--read-only`), `exception`, `staff` (without `--local`), `reconcile` (both modes: a dry run still triggers 07 and keeps the webhooks alive), `demo reset`, `reissue request|decide|dispatch --hosted`, `provision-dashboard-role`, `provision-n8n-role`, `verify-airtable-load`; `n8n-mcp-access` loads the hosted env
- Create: `test/env-hosted.test.ts`
- Modify: `.env.local` (owner; values never pasted into chat)

**Interfaces:**
- Produces: `hostedDbConfig(target: 'hosted' | 'staging' = 'hosted', cwd?): HostedDbConfig`, reading `%USERPROFILE%\.roofops\<target>.env` (override with `ROOFOPS_ENV_DIR`; refused if inside the repository), never `process.env`. `loadLocalEnv()` refuses a repository `.env`/`.env.local` holding any of `SUPABASE_DB_URL, N8N_API_KEY, RECONCILE_TRIGGER_TOKEN, REISSUE_DISPATCH_TOKEN, LITE_REPLY_WEBHOOK_PASSWORD, LITE_LIVE_TEST_TO`, naming the key, never the value. `confirmHostedWrite(url, argv)` requires `--confirm <ref>` equal to the pooler user's `<role>.<ref>` or the direct host `db.<ref>.supabase.co`; its errors never print the expected ref.
- Consumes: nothing new.

- [x] **Step 1: Write the failing tests** in `test/env-hosted.test.ts` (39 cases: the directory rule, every hosted key refused in `.env`/`.env.local`, `hosted.env`/`staging.env`, shell value ignored, the CA path, the ref parser, the gate, and each CLI run as a real process against a closed local port: 11 write commands refuse without `--confirm`, 5 read commands do not ask for it).
- [x] **Step 2: Run** `npx vitest run test/env-hosted.test.ts` → FAIL (exports missing).
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** the test file (39 pass), lint and both typechecks (exit 0). The full suite runs in the Phase 0 check.
- [ ] **Step 5: ✍️ Owner moves** the keys the refusal names (today: `LITE_LIVE_TEST_TO, LITE_REPLY_WEBHOOK_PASSWORD, N8N_API_KEY, RECONCILE_TRIGGER_TOKEN, SUPABASE_DB_URL`) plus `SUPABASE_CA_CERT` (absolute path, or a file next to `hosted.env`) from `.env.local` to `%USERPROFILE%\.roofops\hosted.env`. `N8N_BASE_URL` and the `LITE_REPLY_WEBHOOK_USER`/`_CREDENTIAL_ID` names may stay or move. Until this is done every hosted script stops with `HOSTED_ENV_INSIDE_REPO`.
- [ ] **Step 5b: ✍️ Owner, recommended:** `web/.env.local` points the **local** dashboard at the **hosted** database as `roofops_web` (it can request previews and approvals). Point it at the local Docker database instead (`npm run db:load` locally, then provision the role locally) and keep the hosted `roofops_web` URL only in Vercel. `secrets/roofops-n8n-postgres.env` (written by `provision-n8n-role`) holds the n8n role's hosted password: once it is in the n8n credential, move it next to `hosted.env` or delete it.
- [ ] **Step 5c: ✍️ Owner, recommended:** in Claude Code permissions, an `ask` rule for any command containing `--confirm` and a `deny` rule for reading `~/.roofops/**`, so the agent never sees the values and every hosted write asks you even in auto mode.
- [ ] **Step 6: Verify read path:** `npm run integrity:check` runs and reports (0 FAIL expected); `npm run db:load -- --hosted` without `--confirm` refuses.
- [x] **Step 7: Commit** `Hosted credentials live outside the repo; hosted writes need --confirm <ref>`.

**Done when:** no hosted credential exists under `D:\Claude\roofops`; the read-only checks still run; a hosted write cannot start without the project ref typed by a person.

### Task 0.2: CI on every PR, required on `main`

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/pull_request_template.md`
- Modify: `README.md` (an Actions status badge next to the tests badge)

**Interfaces:**
- Produces: jobs `check` and `db` that later tasks extend (`e2e` in Task 1.3, `drift` in Task 3.2, `schema` in Task 3.1).

- [x] **Step 1: Write `ci.yml`.** `on: [pull_request, push: {branches: [main]}]`; `concurrency: {group: ci-${{ github.ref }}, cancel-in-progress: true}`; `permissions: {contents: read}`.
  - Job `check`: `ubuntu-latest`, `actions/setup-node@v4` with `node-version: 24` and `cache: npm` (cache paths `package-lock.json` and `web/package-lock.json`), `npm ci`, `npm --prefix web ci`, `npm run check` (lint, typecheck, typecheck:web, vitest on PGlite).
  - Job `db`: `services: postgres: {image: postgres:17, env: {POSTGRES_PASSWORD: postgres}, ports: ['5432:5432'], options: --health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 10}`; same setup; `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres npm test` (runs both engines; the two-connection race tests included).
  - Job `rollback-roundtrip` (inside `db`, last step): apply all migrations to a fresh database, apply `ops/rollback/<newest>.down.sql`, re-apply the newest migration, `pg_dump --schema-only` before and after are identical. Expected: `diff` exit 0.
- [x] **Step 2: Write the PR template:** What changed / Why / Tests run (command and result) / Hosted impact (none | migration | n8n publish | dashboard deploy | Airtable | Twilio) / Rollback / Evidence link (only for hosted changes).
- [x] **Step 3: Push a branch and open a PR** (🔒 the push). Expected: `check` green in under 10 minutes, `db` green in under 15. Record the two run times in the PR.
  - PR #2 (29 Oct): `check` 4 min 55 s, `db` 9 min 28 s. The PR description did not list them, so they are recorded here.
- [ ] **Step 4: ✍️ Owner sets branch protection on `main`:** require PR, require status checks `check` and `db`, no force-push. (`gh api -X PUT repos/Tejesh080/Roofops/branches/main/protection` with the two contexts, or the Settings page.)
  - **Open (checked 30 Oct):** `main` is not protected, so a PR can still merge with a failing check.
- [x] **Step 5: Merge** (🔒). Merged with the rest of Phase 0 in PR #2 (29 Oct), as §0 item 3 says, so not under a commit message of its own.

**Done when:** a PR cannot merge to `main` without both jobs green; the README badge shows the workflow status.

As built (29 Oct): `.github/workflows/ci.yml` uses `postgres:17-alpine` (the local image); the round trip compares `pg_dump --schema-only` before and after the newest down file plus a re-migrate, with pg_dump's random `\restrict` lines filtered (rehearsed locally: identical). The newest migration must have an `ops/rollback/` file or the job fails.

### Task 0.3: Secret scanning before and after commit

**Files:**
- Create: `.gitleaks.toml` (default rules; one allowlist for Airtable ids: `^(app|tbl|fld|rec|viw|sel|usr|wsp|ach)[A-Za-z0-9]{14}$`)
- Create: `.githooks/pre-commit` (`gitleaks git --pre-commit --staged` with a local gitleaks, else the pinned image `zricethezav/gitleaks:v8.30.1` through Docker; warns if neither exists)
- Modify: `.github/workflows/ci.yml` (job `secrets`: the same image over the whole history, `fetch-depth: 0`)
- Modify: `package.json` (`"prepare": "git config core.hooksPath .githooks"`)

- [x] **Step 1:** Full-history scan with the default rules (29 Oct, 205 commits): 771 findings, **every one an Airtable id** (`airtable-api-key` and `generic-api-key` match `rec…`/`fld…`/`tbl…` + 14). No credential. With the allowlist: no leaks.
- [x] **Step 2:** Config, hook and CI job written; in a throwaway repository the hook let an Airtable id commit and blocked a random `ghp_…` token ("leaks found: 1", commit refused).
- [x] **Step 3:** PR, CI green, merge (🔒). Merged in PR #2 (29 Oct); the `secrets` job passed.

**Done when:** a staged secret cannot be committed on this machine and cannot pass CI.

### Task 0.4: INT-03 part 2: the Airtable ping body cannot choose the cursor

**Files:**
- Modify: `n8n/01-quote-accepted-to-project.sdk.ts:22-24,36`
- Modify: `n8n/04-approved-project-to-xero-draft-invoice.sdk.ts:19-20,31`
- Test: the runner suites that cover 01 and 04 (`grep -ln "Validate Ping" test/*.test.ts`)
- Modify: `docs/defect-ledger.md` (INT-03 row)

**Interfaces:**
- Produces: `Validate Ping` outputs `{ webhook_id, ping_timestamp }` only; the payload fetch uses the Postgres cursor (`$json.cursor`) unconditionally. Operator replays use the existing SQL path (`ops/requeue-*.sql`, 🔒), never the webhook.

- [x] **Step 1: Failing test:** in each suite, a ping body `{ base: {id}, webhook: {id}, timestamp, replay_from_cursor: 1 }` leaves the fetch cursor equal to the stored cursor (assert the HTTP request the runner records carries the stored value).
- [x] **Step 2: Run** those suites → FAIL (cursor is 1). As built: `test/n8n-ping-cursor.test.ts` runs the real node code of 01 and 04; red before the fix in both (the ping output carried `replay_from_cursor`).
- [x] **Step 3: Implement:** delete the `replay` parsing lines and the `?? $json.cursor` fallback in both files.
- [x] **Step 4: Run** `npm run check` → exit 0 (29 Oct, with Postgres 17: 1,389 passed, 37 skipped).
- [x] **Step 5:** Ledger and merge (🔒). The ledger has no INT-03 row of its own, so the AC-18 row records the second part as **Fixed offline**, live with Task 1.1. Merged in PR #2 (29 Oct).

**Done when:** both suites pin the behaviour; the live publish is a 🔒 step inside Task 1.1 (record 01's and 04's current `versionId` first).

### Task 0.5: Repository hygiene

**Files:** worktrees, branches, the untracked and modified files, `README.md:323`, `evidence/lite-activation-investigation-20261022.md`, `lite/DELIVERY-CHECKLIST.md`.

- [x] **Step 1: Worktrees:** both were clean (no changes, no stash) and removed; `git worktree prune`.
- [x] **Step 2: Local branches:** each was 0 commits ahead of `main`; deleted locally with `git branch -d` (the pushed ones remain on `origin`). Keep `backup/pre-factory-local-work` until 30 Nov, then delete it (🔒 for the remote). Remote branch deletion is 🔒.
- [x] **Step 3: Untracked work:** `ops/staging/` holds the generator, a placeholder-only `env.staging.example` and an ids-only schema (6 tables, 92 fields); gitleaks finds nothing; `test/staging.test.ts` passes (5, 3 skipped). Committed. Note for Task 1.4: the generator reads `ops/staging/.env.staging` inside the repository (gitignored); move it to `hostedDbConfig('staging')` when staging is built. Its guard reads the production project from `hosted.env` as well (30 Oct), so moving the keys (Task 0.1 step 5) does not blind it.
- [x] **Step 4: Modified files:** `web/next-env.d.ts` reverted (generated). **Not committed, left as local changes:** `.claude/launch.json` (three of its six entries point into an old session's temp folder on this machine) and the 10 regenerated screenshots (`phase5/05-…-recovery.png` shows a "Not found" page: the batch was captured against the wrong data). Phase 2's journey regenerates the screenshots.
- [x] **Step 5: Corrections:** Twilio's error dictionary (checked 29 Oct) has no 572003 and lists "The 'From' number isn't assigned to this verified Messaging recipient" as **572002**, but **572003 is what the live API returned** on 21 Oct (stored in the Message Log). So the evidence keeps 572003 with a dated note, and the README states both. `lite/DELIVERY-CHECKLIST.md`: 70 Lite tests. README "Not built yet" links this plan.
- [x] **Step 6:** PR, merge (🔒). Merged in PR #2 (29 Oct).

**Done when:** `git worktree list` shows one entry; `git branch` shows `main` and `backup/…` only; `git status` is clean on `main`.

### Task 0.6: 🔒 Lite clean-up from the 21 Oct test

Source: `evidence/lite-activation-investigation-20261022.md` §6, items 1–10. Item 11 (the trial-From fix) is **dropped**: the Twilio upgrade (Task L2) makes it moot.

- [x] 🔒 1. Unpublish `[Lite] Inbound Replies` (`3Jeal7RQAhUmgLZ3`); confirm `active: false`, `activeVersionId: null`.
- [ ] ~~🔒 2.~~ (29 Oct: the version has aged out of n8n history; not possible) Restore version `cd14b31d-ca74-4fa8-bec9-8e6675a4fd3b` on `9BjHeFBUKqnmQqHl` (Instant Lead Follow-Up), unpublished; verify node for node against `lite/dist/demo/lead-follow-up.json`.
- [ ] ~~🔒 3.~~ (not possible, as 2) Restore version `ab0f14c6-b596-44ff-ad73-02039087105b` on `Tmk4lj7VrbHix9A9` (Monitor), unpublished; verify against `lite/dist/demo/monitor.json`.
- [ ] ~~🔒 4.~~ (not possible, as 2) Restore version `49aeb37c-394b-41b9-b50a-4a9265ee2f02` on `3Jeal7RQAhUmgLZ3`, unpublished (only after 1).
- [ ] ✍️ 5. (owner, n8n editor: the tools cannot read or remove pin data) Remove the pinned S7 test lead from `9BjHeFBUKqnmQqHl`.
- [ ] ✍️ 6. Twilio Console: Try out SMS › Auto-reply › Standard › Save.
- [ ] ✍️ 7. Delete the Twilio Webhook Rule (`EXACT_MATCH`, reply URL) and its Webhook Setting.
- [ ] ✍️ 8. (owner: a permanent row deletion) Clear the Login Setup data table (`y28wzAvfOC2U7fwI`, verify the id first).
- [x] 🔒 9. Archive the five Twilio helper workflows (`HWJdTkYMLBFXE5bn`, `0h3YTk1ewoemNQCq`, `CRYdGYERCuVGcaEs`, `ikWTxNSgiH3u1TWr`, `VcTE56qoxldxCeDt`).
- [x] 10. Keep `rec4IUGCUBSSiBd4N` as evidence, Retry Requested unticked.
- [x] After each item: re-read; recorded in `evidence/lite-cleanup-20261029.md`. The three drafts keep the live one-recipient build (unpublished; trial account) until Task L3 rebuilds Lite from `lite/dist/`.

**Done when:** no Lite workflow is published; every Lite draft matches `lite/dist/demo/*.json` node for node; the evidence file exists.

### Task 0.7: ✍️ The owner's parallel list (start on day 1; nothing here blocks the engineering)

- [ ] **Twilio:** upgrade the account to paid; complete Australian business KYC (ABN/ACN, address proof, authorised representative ID); buy one **Australian mobile long code** (not an alphanumeric sender). Lead time 3–5 business days for KYC plus the number's regulatory bundle.
- [ ] **Supabase:** read the current plan; confirm whether daily backups/PITR exist (the 23 Oct preflight could not). Decision for now: stay on the current plan while all data is synthetic; move to Pro (A$25/month, daily backups) **before Phase 4 starts**, not before.
- [ ] **Vercel:** record the `roofops-dashboard` current deployment id (the preflight could not read it) in `evidence/advanced-release-preflight-20261023.md` §3 line 4.
- [ ] **healthchecks.io:** create a free account (20 checks); keep the ping URLs in `%USERPROFILE%\.roofops\hosted.env` as `HC_*` keys. Task 1.2 uses them.
- [ ] **Repo visibility:** confirm it stays public (recommended; unlimited Actions minutes, free push protection). If private instead: Actions is limited to the $12/month free allowance and push protection is lost; Task 0.3 becomes the only line of defence.
- [ ] **Airtable:** create an empty base for Lite (Task L3 fills it).

---

## 8. Phase 1: deploy and alerts (6 – 19 Nov)

### Task 1.1: 🔒 Release everything on `main` that is not on hosted (`ops/release-phase1.md`)

**Scope (prepared 30 Oct):**
- nine migrations: the sprint's eight plus `20261029120000_airtable_ping_mac`, in log mode;
- n8n: publish 06, 03, 01, 04, 07 and 00, and create 95;
- the dashboard.

Each workflow's live version was matched to its commit, and the node-level changes listed in the checklist come from a
diff of the files. 05 (FIN-GST-01) stays a separate supervised step.

**Precondition:** the credentials have moved (Task 0.1 step 5).

- [x] **Step 0: Rehearsal tooling** (`scripts/release-rehearsal.ts`, `test/release-rehearsal.test.ts`): restore a backup locally, apply the pending migrations, run integrity and privilege checks, roll everything back, compare the schema, and re-apply.
  - On the 23 Oct backup every check held: 32 PASS / 5 WARNING / 0 FAIL after applying, and a schema identical to the backup after the nine rollbacks.
  - The preflight queries are saved as `ops/release-preflight.sql`.
- [ ] **Step 1: Before** (`ops/release-phase1.md` §3):
  - a fresh `npm run backup:hosted`;
  - the rehearsal on that backup;
  - the rollback points;
  - the read-only preflight.
- [ ] **Step 2: 🔒 Steps 1–14 in order** (§4), one approval per 🔒 row, verifying each before the next.
- [ ] **Step 3: Evidence and ledger:** rows move to **FIXED** only where their live check passed.
- [ ] **Step 4: First week** (§5).

**Rollback:** §6, newest layer first. Rehearsed.

**Done when:**
- hosted is at head `20261029120000` with integrity 0 FAIL;
- 06, 03, 01, 04, 07 and 00 are live at `main`'s versions, and 95 is set as their error workflow;
- the Preview serves `main`'s dashboard;
- the evidence file exists.

### Task 1.2: Alerting that reaches a phone

**Design (changed 29 Oct, simpler than per-workflow ping URLs):** the database already records every heartbeat. 08
writes a health check for each service every 30 minutes; the nightly reconciliation writes Airtable's. So one public
answer, `/api/healthz`, built from those records, and **one** outside uptime monitor on it cover everything:
- a stopped health run or reconciliation: the stale check goes Unknown;
- a service failing three times in a row;
- an integrity FAIL;
- a dead-lettered side effect.

No ping URL, address or secret goes into git, and n8n 07/08 need no change. Lite keeps its own Monitor alerts (Task L5).

**Files (as built):**
- `web/lib/health.ts`: `healthzVerdict()`.
- `web/lib/healthz.ts`: `getHealthz()`, which runs `integrity_check()` once.
- `web/app/api/healthz/route.ts`: 200 or 503, `no-store`, through the dashboard role.
- `web/proxy.ts`: lets only that path through without a session.
- `n8n/95-error-alert.sdk.ts`: Error Trigger → `wf_record_health` as a failed n8n check, carrying the workflow, execution, node and a 300-character message, never the stack.
- Tests: `test/healthz.test.ts` (11), `test/n8n-error-alert.test.ts` (7, the real node code against PGlite and Postgres 17).

- [x] **Step 1: Code and tests.** Checked in a local dev server against the local Docker database:
  - `/api/healthz` answers without a session: 503, `no-store`;
  - `/projects` still redirects to sign-in, and `/api/copilot` still returns 401.

  After a recorded health run every service was Healthy. Xero correctly needed attention, because the local database has no pinned tenant.
- [ ] **Step 2: ✍️ Uptime monitor** on `https://<dashboard>/api/healthz`, every 5 minutes, alerting on any non-2xx:
  - Honeybadger (Student Pack) or UptimeRobot (free).
  - The deployment is protected, so the monitor sends Vercel's Protection Bypass for Automation header.
  - Alert channel: the owner's email, plus SMS if wanted.
- [ ] **Step 3: 🔒 Deploy and publish.**
  - Deploy the dashboard (Preview).
  - Publish 95.
  - Set 95 as the error workflow of every RoofOps workflow (n8n `setWorkflowSettings errorWorkflow`).
- [ ] **Step 4: 🔒 Prove it:**
  - Pause 08-health for one period. `/api/healthz` must go 503 and the monitor must alert. Restore it.
  - Three failures through the reversible fault toggle (`n8n/97-test-fault-toggle-drive-root.sdk.ts`) must also make it 503.
  - Record both in `evidence/alerting-proof-<date>.md`.

**Done when:** both alerts arrived and are recorded, and the monitor is watching `/api/healthz`.

**Policy:** a single workflow failure shows on System Health at once but does not page. Three in a row, or any stale check, pages. The nightly reconciliation repairs or reports a single missed edit.

### Task 1.3: End-to-end tests in CI, and a smoke test against the Preview

**Files (as built 29 Oct):**
- `.github/workflows/ci.yml`: job `e2e`. A matrix of 7 suites, each with its own fresh rehearsal database:
  - a `roofops-postgres` container on port 54322, then `scripts/pilot-rehearsal.ts --reset`;
  - a production `next build` and `next start` with `web/e2e/.auth/pilot.env`;
  - Playwright, with the HTML report, test results and the server log uploaded.
- `.github/workflows/smoke-deployment.yml`: the smoke specs against a deployment, run by hand (`workflow_dispatch`, `base_url`).
- `web/e2e/job-journey.spec.ts`: brought up to date with the AC-13B pre-start gate. It now asserts that starting is refused before SWMS and materials are signed off, then signs them off. The audit trail expects the two sign-offs.

**What the rehearsal found** (a clean worktree with no `.env.local`, exactly as CI; 29 Oct):
- **All suites on one database:** 28 passed, 7 failed, 8 did not run. The specs change data and need a fresh database each, as their headers say.
- **Each suite fresh:** every suite passed:
  - smoke + screens + interactions: 27;
  - invoice-approval: 3; site-work: 2; sales-journey: 3; job-journey: 1 (after the fix);
  - staff-journey and operations: passed within the combined run.
- **job-journey had drifted:** it moved a job to In Progress without the pre-start sign-offs, which the AC-13B gate now refuses. Nothing had run the e2e suite since 22 Oct.
- **Three tests need what CI does not have:** two smoke tests need the hosted demo history, and the screens Copilot card needs the DeepSeek key. CI excludes them by name; they run against a deployment.
- **Not in CI:** `state-sync` (hosted database only) and `dispatch-gate` (needs its own `E2E_PILOT_GATE` setup; a follow-up).

- [x] **Step 1:** Reproduce locally. Done, as above.
- [x] **Step 2:** Job `e2e`. Written; actionlint clean. It runs on every PR since PR #6: all seven suites green, one to two minutes each.
- [x] **Step 3:** `smoke-deployment.yml` written.
  - ✍️ The owner adds the repository secrets `E2E_DEMO_USERNAME`, `E2E_DEMO_PASSWORD` and `VERCEL_BYPASS`.
  - Running it against the Preview is 🔒 (it signs in there).
- [x] **Step 4:** PR, CI green, merge (🔒). Merged in PR #6 (29 Oct).
- [ ] **Step 4b: ✍️** Add the seven `e2e (…)` checks to the required checks, together with Task 0.2 Step 4.

**Done when:** the e2e suites run on every PR and pass, and a smoke run against the Preview is green and linked from the release evidence.

### Task 1.4: Staging for the database and the dashboard

n8n stays a single Cloud instance and Airtable a single base in this phase: workflow changes are tested by the runner suites and published supervised. The deeper isolated staging (`ops/staging/staging.ts`, separate base, id-remapped workflow) exists for the sales workflow and is generalised only if Phase 2 needs it.

- [ ] **Step 1: ✍️ Owner creates** Supabase project `roofops-staging` (Free is acceptable: it pauses after 7 idle days and is restored with one click; all data is synthetic) in `ap-southeast-2`, and writes its URL/CA to `%USERPROFILE%\.roofops\staging.env`.
- [ ] **Step 2:** `npm run db:load -- --staging --confirm <staging-ref>` (Task 0.1's target) loads every migration and the canonical synthetic bundle; `scripts/provision-dashboard-role.ts` and `provision-n8n-role.ts` run against staging; `integrity:check` against staging reports 0 FAIL.
  - Ready (30 Oct): the four commands take `--staging` and read `staging.env`. Each refuses a `staging.env` that names the hosted project (`STAGING_IS_PRODUCTION`), and the writes confirm against the staging ref.
  - With `--staging`, the two provisioning scripts write their credentials beside `staging.env` (`staging-dashboard.env`, `staging-n8n-postgres.env`), never over the hosted ones. Step 3 copies the dashboard's from there.
- [ ] **Step 3: ✍️ Vercel:** a `staging` git branch with branch-scoped environment variables (`DASHBOARD_DATABASE_URL` = the staging `roofops_web` URL, new `AUTH_SECRET`, `DEMO_*` for staging only); deployment protection on.
- [x] **Step 4:** Document the loop in `ops/release-checklist.md` (see §13): PR → CI → merge to `main` → `staging` fast-forwarded → smoke on the staging preview → hosted release. Written 30 Oct, with the six lines of §13 rule 2 and the rollback.

**Done when:** a PR merged to `main` and fast-forwarded to `staging` deploys to a preview that signs in with the synthetic login and shows `/api/healthz` from the staging database.

### Task 1.5: Airtable ping authenticity (`X-Airtable-Content-MAC`)

Design: **ADR-041** (`docs/decisions.md`). The signature is checked inside Postgres with pgcrypto, so the MAC secret
never leaves the database. 07's own wake pings are signed by the database. Rollout runs `log`, then `enforce`.

**What it buys, honestly:**
- After Task 0.4 a forged ping can only cause one read from the stored cursor.
- This task stops forged pings before any Airtable call, which protects the 5-requests-per-second limit, and it makes the logs trustworthy.
- A forged ping still costs one n8n execution, because the check runs inside it. That needs something in front of n8n, which is recorded and not built.

- [x] **Step 1: Spike** (29 Oct, no hosted change):
  - Airtable's docs: the secret comes only from the create call, and the MAC covers the JSON body.
  - 07 drops the secret today, so every webhook must be re-created.
  - pgcrypto's `hmac()` equals Node's `createHmac` on Postgres 17.
  - n8n's Webhook node exposes lowercase `headers` and the parsed `body`. "Only Run If" fails open, so it is not used.
- [x] **Step 2: Migration** `20261029120000_airtable_ping_mac.sql`, with an exact rollback (built 30 Oct):
  - the tables `integration_webhook_secrets` and `airtable_ping_checks` (every verdict, kept 7 days; no body, no MAC), RLS on, no grants;
  - the functions `wf_airtable_webhook_created`, `wf_airtable_ping_cursor` and `wf_airtable_sign_ping`, for the workflow role only;
  - the setting `airtable.ping_mac = 'log'`; any other value fails closed (`enforce`);
  - `v_integration_activity` gains the channel `airtable-pings`.

  `test/airtable-ping-mac.test.ts`: 15 cases on both engines, red before the migration. Expected MACs are computed by Node exactly as Airtable documents. Cases:
  - a valid MAC returns the cursor;
  - in `log`, a wrong, missing or unknown-webhook MAC is recorded and the ping proceeds; in `enforce` it gets null;
  - the MAC covers the exact body;
  - no app role reads a secret or a verdict;
  - verdicts are kept 7 days;
  - System Health counts them.

  `test/schema.test.ts` pins the workflow role's functions, now three more. `scripts/security-check.ts` gains two checks.

  Rollback, checked two ways:
  - CI's round trip: identical;
  - a database never migrated against one migrated then rolled back: identical schema (15,215 lines).
- [x] **Step 3: Workflows** (built 30 Oct):
  - **01, 04 and 06:** `Validate Ping` passes `JSON.stringify(body)` and `x-airtable-content-mac`. `Load Payload Cursor` calls `wf_airtable_ping_cursor`. A new `Ping Verified?` step stops before any Airtable call when the cursor is null.
  - **07:** builds its wake ping, has Postgres sign it (`Sign Wake Ping`) and sends it exactly as signed. Its create response goes to `Store Webhook Secret`, which passes on only the status code and whether it stored.
  - **00:** two store steps, and its verify steps refuse a webhook created without a stored secret.

  `test/n8n-ping-mac.test.ts`: 12 cases on both engines, with the real node code:
  - signed pings are fetched from the stored cursor;
  - forged or unsigned pings are stopped at `Ping Verified?` in `enforce`, and recorded and passed in `log`;
  - 07's signed wake ping passes 06's check;
  - the create stores the secret and passes it on nowhere;
  - a failed create stores nothing.

  Deliberately breaking 06's cursor call, or sending 07's wake ping unsigned, turns 4 of them red.

  Not settable from the SDK files: "Do not save successful executions" on 00 and 07. That is a rollout step.
- [x] **System Health:** the Airtable alerts row shows the pings checked in 24 hours and how many were not verified.
- [ ] **Steps 4–6: 🔒 deploy in `log`, re-create the three webhooks one at a time, then `enforce`.** Exact order, read-only checks and rollback levers: `ops/airtable-ping-mac-rollout.md`.

**Done when:** `enforce` is on, a forged ping is stopped before any Airtable call, and real edits apply.

### Task 1.6: Off-platform backups as a routine

- [x] **Step 1:** `scripts/backup-hosted.ts` (`npm run backup:hosted`, `-- --dry-run` to preview). Read-only on the database, so no `--confirm`. The runbook's `pg_dump` inside `roofops-postgres` (URL passed as an environment variable, TLS required), `pg_restore --list` must read it back, SHA-256 sidecar, owner-and-SYSTEM-only ACL, then `HEARTBEAT_WEEKLY_BACKUP_URL` from `hosted.env` (any 2xx counts). Folder: `ROOFOPS_BACKUP_DIR` (set it to `D:\Claude\roofops-backups` to keep the existing ones together), else `~/roofops-backups`; never inside the repository. `test/backup-hosted.test.ts` (10, with the command runner recorded; ablations red). Rehearsed 29 Oct against the local Docker database: 750,565 bytes, 62 TABLE DATA entries, sidecar hash recomputed equal, ACL owner + SYSTEM, nothing left in the container. Not yet run against hosted.
- [ ] **Step 2: ✍️ Owner copies** each dump to a location not on this machine (their choice; not performed by the agent).
- [ ] **Step 3: ✍️ Owner schedules it** (Docker Desktop must be running at that time):
  `schtasks /Create /TN "RoofOps weekly backup" /SC WEEKLY /D MON /ST 07:30 /TR "cmd /c cd /d D:\Claude\roofops && npm run backup:hosted >> %USERPROFILE%\roofops-backups\backup.log 2>&1"`.
  The heartbeat check (Honeybadger check-in or healthchecks.io, period 7 days) alerts if a Monday is missed. Quarterly: one restore rehearsal into a scratch database (the 23 Oct one counts as the first).

**Done when:** two consecutive weekly dumps exist with sidecars and the check shows "up".

---

## 9. Phase 2: the complete demo (20 Nov – 10 Dec)

Step-level plan written when the phase starts (`docs/plans/phase-2-demo.md`). Tasks and completion criteria:

**Task 2.1: One full journey, performed by a person.** Script: `docs/manual-acceptance-script.md` + `ops/advanced-demo-runbook.md`. Every hosted action 🔒 per step. Synthetic customer; Xero Demo tenant (pinned). Issues found become small PRs (Phase 1 pipeline), fixed within the phase. **Done when:** `evidence/demo-journey-<date>.md` records enquiry → quote → acceptance → project + Drive folder → Airtable write-back → site visit held by the pre-start gate until SWMS/materials are done → purchase order approved and delivered → completion photos → invoice prepare, two-person approval → Xero Demo DRAFT read back → nightly reconcile 0 drift, with screenshots at each step.

**Task 2.2: Demo video.** 10 minutes, the journey above, narrated; linked from the README "Demo" section. **Done when:** the link plays.

**Task 2.3: Xero integration contract.** `docs/xero-integration-contract.md`: for each bookkeeper expectation from the research (push only on approval, never a zero-value invoice, ContactID/InvoiceID stored and used, contact matched by stored id then email never name, invoice numbers from one sequence checked against Xero including VOIDED/DELETED, `Idempotency-Key` on every write [already true in 05], 429 handled with `Retry-After`, nightly reconciliation catches lost webhooks [07], DRAFT vs AUTHORISED on approval, tracking category mapping) write **verified where / deferred to Phase 4 with the owner decision**. **Done when:** every line has one of the two.
- **Done 30 Oct, ahead of the phase:** every line has one. Verified, with only a test or a backstop to add: 2, 5, 6. Partly verified: 1, 3, 4, 7, 8, 9. Not implemented: 10. The five bookkeeper decisions and the code changes are listed for Phase 4.

**Task 2.4: "The engineer is unavailable" runbook.** `ops/engineer-unavailable.md`, one page: what runs where, how to read `/api/healthz` and healthchecks.io, how to pause everything safely (which workflows to unpublish, in which order), how to restore a backup, whom to call. **Done when:** the owner reads it and can answer "how do I stop all automation right now" without the engineer.
- **Written 30 Oct.** It waits for the owner to read it and to fill in the contacts.

**Task 2.5: Weekly owner walkthrough starts.** 15 minutes, the owner alone, one scripted path per week from Task 2.1; `docs/walkthrough-log.md` gets one line: date, path, what broke or "nothing". **Done when:** three consecutive entries exist.
- The log exists (30 Oct), empty until the first walkthrough.

## 10. Phase 3: simplify (1 – 19 Dec, overlapping Phase 2)

**Task 3.1: Current definitions in git.** `scripts/export-current-schema.ts` writes `supabase/schema.sql` (`pg_dump --schema-only` of a from-scratch local load, normalised) and `supabase/current/functions/<name>.sql` (`pg_get_functiondef` for every `wf_*`, `web_*`, `integrity_check`, triggers). CI job `schema`: regenerate, `git diff --exit-code`. **Done when:** anyone can read the current body of `integrity_check` in one file, and a migration that changes a function without regenerating fails CI.
- **Built 30 Oct, ahead of the phase:** `npm run schema:export`. The 65 migrations give `supabase/schema.sql` (14,571 lines, grants included) and 168 files in `supabase/current/functions/`.
  - It exports every function in `public` that no extension owns: a superset of the list above, so helpers such as `xero_record_settlement` can be read too.
  - Two runs give identical files. The CI job is pinned to Postgres 17.11, the version they were generated with, and the script refuses any other.
  - The CI job checks untracked files as well (`git status --porcelain`, not `git diff`), so a new function also fails it.

**Task 3.2: n8n drift check.** `scripts/n8n-drift.ts`: public API `GET /api/v1/workflows` (available on Starter and Pro), normalise (ids, positions, timestamps stripped), compare node for node with the SDK build output of `n8n/*.sdk.ts` and `lite/dist/*`. CI `drift` job on a weekly schedule with the API key as a repository secret (✍️). **Done when:** the report is empty for every published workflow and a deliberate live edit (🔒, reverted) is reported.
- **Built 30 Oct, offline, ahead of the phase.** `npm run n8n:drift` compares the published version of each workflow with its file. That is n8n's `activeVersion` when it differs from the draft, which matters: 02's draft and published versions differ.
  - It compares type, version, parameters, credential ids, node settings and every connection, and ignores ids, positions, credential names, webhook ids and two known defaults.
  - `.github/workflows/n8n-drift.yml` runs weekly and on demand, and passes with a notice until the secrets exist.
- **Calibrated read-only** against the live workflows (n8n MCP): the published 02 (34 nodes, nine node types) matches its file exactly.
- **Found:** live 08 Health has `onError: continueRegularOutput` and `alwaysOutputData: true` on its three HTTP nodes, and the file has neither. The owner decides which is right; the file can follow.
- **Expected until the Phase 1 release:** 00, 01, 03, 04, 05, 06 and 07 differ from `main` by exactly the release's changes.
- **08 Reissue and 09** cannot be read through the n8n MCP (their MCP access is off); the public API check covers them.
- **Open:**
  - ✍️ The repository secrets `N8N_BASE_URL` and `N8N_API_KEY`.
  - The first API run must confirm the public API returns `activeVersion` like the MCP does.
  - After the release: the empty report and the deliberate live edit (🔒).

**Task 3.3: Documents.** `evidence/README.md` index; `docs/phase2-status.md` … `phase6-status.md` and superseded runbooks move to `docs/archive/`; per-defect evidence files stop (a PR with CI, a ledger row and, for hosted changes, one release evidence file replace them); README links only current documents. **Done when:** the README's document list is under 15 links and every link resolves.

**Task 3.4: Editing surfaces, written down.** `docs/editing-surfaces.md`: for each Airtable field in `field_contract`, its owner (Postgres-only / Airtable-writes-validated / attachment), which surface staff use for status, dates and approvals (the dashboard), what Airtable keeps (views, Completion Photos, Compliance Certificate, Lite), the sync log's place on the dashboard (an e2e assertion), and the **retreat trigger**: more than three staff-visible reverts or echo exceptions in one pilot week on a field → that field becomes dashboard-only, Airtable read-only, within the following week. **Done when:** the document exists, the e2e assertion passes, and the trigger is a line in the weekly walkthrough log.

## 11. Phase 4: a business runs on it (12 weeks from a chosen start)

Prerequisite (✍️): a willing roofing business (the owner's, or one that agrees to a 12-week pilot), its Xero organisation, ABN, staff list, and a named office person as the in-house expert.

**Task 4.1: Production split.** New Supabase project `roofops-prod` (Pro); the current hosted project becomes demo/staging. n8n production project or folder with re-pointed credentials (🔒); production Airtable base built from `ops/staging/production-airtable-schema.json` with `ops/staging/staging.ts map/generate` generalised to all workflows; Vercel production deployment (`ops/pilot-staging-deployment.md`); `ops/business-date-switch-to-real.sql` (🔒); the pinned-tenant guard re-proven against the real organisation (one approved DRAFT, voided after, 🔒); per-person logins (`scripts/staff.ts`), per-person Airtable seats or dashboard-only approvals (ADR-034). **Done when:** `/api/healthz` on production shows 0 FAIL with real customers, suppliers and staff loaded, and the bookkeeper matches one real DRAFT in Xero to its RoofOps preview.

**Task 4.2: Crew job card (minimum).** Three mobile pages under `web/app/crew/`: today's visits; visit detail (check in, SWMS signed, pre-start checklist, materials note, complete); job list. Reuses `web_visit_update` and the checklist functions; photos go through the existing Airtable Completion Photos field via an Airtable form on the phone (watched by 06, AC-13A), not a new upload path. `web/e2e/crew.spec.ts`. **Done when:** a crew member completes a visit from a phone in under ten taps, and the pre-start gate blocks "start" while SWMS is unsigned (AC-13B live).

**Task 4.3: Office-only phase (2–4 weeks).** Enquiries, quotes, invoices, Xero. Weekly `npm run reconcile` and a RoofOps-versus-Xero count-and-total check with the bookkeeper. Walkthrough log continues.

**Task 4.4: One-crew pilot (2 weeks).** The crew chosen for influence; the old process still available. Exit tests: a full day with no paper fallback; invoices came from jobs, not retyped; Xero posted and payments came back through 07; the crew says they would keep it.

**Task 4.5: Monday go-live.** Every new job in RoofOps from that Monday; the spreadsheet's retirement date written down; 12 weeks of weekly reconciliation; incidents in `docs/walkthrough-log.md`; the Task 3.4 retreat trigger checked weekly. **Done when:** §3 "Advanced, trusted by a business" holds.

## 12. The Lite track (runs beside Phases 0–2)

| # | Task | When | Done when |
|---|---|---|---|
| L1 | Task 0.6 clean-up; error-code correction (Task 0.5) | Week 1 | Nothing published; drafts match the build |
| L2 | ✍️ Twilio paid account, AU business KYC, **AU mobile long code** (Task 0.7) | Day 1; 1–2 weeks lead | The number can send and receive in the Console |
| L3 | Lite's own Airtable base: `lite/airtable` setup create-only into the new base (🔒 run), config `baseId` updated, rebuild `lite/dist`, verify view guide | Week 2 | A Lite write no longer appears in 06's executions |
| L4 | Reply-webhook security on the current n8n plan: `header-auth` through the relay (`lite/twilio/reply-relay.js`, a Protected Twilio Function) or `basic-auth` via a Twilio Webhook Rule for the pilot; lead form: Cloudflare Turnstile token checked in the Lead Follow-Up webhook plus a per-phone/per-IP rate limit before the dedupe step; tests for both | Week 2 | An outside request gets 401/403; a form post without a valid Turnstile token is refused |
| L5 | Error workflow and Monitor heartbeat (Task 1.2); 🔒 publish Monitor | Week 2–3 | A forced failure emails the owner |
| L6 | 🔒 Live acceptance (`lite/DELIVERY-CHECKLIST.md` §5) with `allowAllRecipients: false` and the allowlist = the owner's phone only: new lead → one real SMS Sent then Delivered; reply → Received, enquiry reopened; STOP → opted out, next lead from that phone silent; forced failure → alert; outside webhook request → refused | Week 3 (after L2) | `evidence/lite-live-acceptance-<date>.md`; §3 "Lite, complete" holds |
| L7 | First client: DELIVERY-CHECKLIST §1–§6 on the client's accounts; Spam Act checklist signed (consent at capture, business named in every message, "Reply STOP" from the reply-capable number, suppression within 5 working days, opt-out live 30 days, opt-outs stored in Lite's own table as well as Twilio's block); 4 watched weeks | +3–5 weeks after signing | Zero unexplained sends; zero complaints |

Not in scope for Lite: alphanumeric sender IDs (one-way; Sender ID Register from 1 Jul 2026), multi-tenant hosting, the trial-From fix.

## 13. Rules of work from now on

1. **Small PRs, CI green, merged within days.** A change older than a week unmerged is too big; split it.
2. **Hosted changes every one to two weeks** through `ops/release-checklist.md` (six lines: backup → read-only preflight → apply/publish → verify → monitor 24 h → one evidence file per release). No new runbook per change; the big runbook pattern retires after Task 1.1.
3. **Every hosted write is 🔒 in chat**, step by step, with the verify line checked before the next step.
4. **A person tests what the customer sees**: the weekly walkthrough (Task 2.5) and the pilot exit tests outrank green tests. "Done" is never reported without the observed result.
5. **No new features or catalogue items until Phase 2 is done.** After that, a person's finding beats a hypothesis.
6. **Keep Lite and Advanced separate.** Shared nothing.
7. **The agent never holds production write credentials in its working directory** (Task 0.1), never runs a hosted write without `--confirm`, and never reads a secret into chat.
8. **Down files stay, backups rule.** Expand/contract for schema changes; destructive steps only after a fresh dump.

## 14. Deliberately not doing (and why)

- Replacing Airtable with NocoDB/Teable/Baserow: credible fallback, but the office interfaces are built; revisit only if the Task 3.4 retreat trigger fires on most fields.
- Supabase Branching (Pro + per-hour): a second Free project is enough while data is synthetic.
- Sentry, Supabase/Vercel log drains: `/api/healthz` + heartbeats + the error workflow cover a one-person system; add Sentry only if the dashboard shows user-facing errors in the walkthrough log.
- Xero webhooks: 07's nightly reconcile and read-backs are sufficient at this volume.
- n8n native source control (Business tier) and the Enterprise diff: Task 3.2's API-based drift check instead.
- Mutation testing (Stryker): a Phase 4+ nice-to-have; the walkthrough is the credibility check.
- The unreported catalogue workstreams (WS04 concurrency, WS11 security, WS12 Copilot, WS13 malformed input): closed as a list; specific items re-enter only through a person's finding or Task 1.5/Task 2.3.
- Splitting the rehearsed 8-migration release into eight releases (see §2 item 5).
- Crew offline mode, timesheets, supplier catalogues, form libraries: the commercial products' upper tiers; not needed to be trusted.

## 15. Decisions the owner still has to make (each blocks one task only)

| Decision | Blocks | Recommendation |
|---|---|---|
| Repository stays public | Task 0.3's scope | Yes (free CI minutes, free push protection; nothing secret is in it) |
| Supabase plan now vs before Phase 4 | Task 1.6, Task 4.1 | Stay; Pro before any real data |
| Lite reply-webhook security on the current n8n plan | Task L4 | `header-auth` through the relay (proves the request came from Twilio); `basic-auth` only for a pilot |
| DRAFT vs AUTHORISED on approval for the real tenant | Task 2.3 → 4.1 | Ask the bookkeeper in Phase 2; the research says drafts shift clean-up to them |
| Which business pilots, and when | Phase 4 | The owner's own, starting after the January shutdown |
| Whether the dashboard becomes the only status/date/approval surface before the pilot, or on the retreat trigger | Task 3.4 | Before the pilot for status and approvals; keep Airtable for attachments and views |

## 16. Tools from the GitHub Student Developer Pack (checked 29 Oct 2026)

Read from the official list at education.github.com/pack. The owner redeems each offer (the agent creates no accounts);
the task then wires it in. Rule: an offer is used only where it replaces something the plan already needs, so the
number of vendors does not grow.

**Already in effect (public repository):** GitHub Actions with unlimited standard-runner minutes (CI is running on PR #2),
secret scanning and push protection (both enabled on the repository).

| Offer | Replaces / strengthens | Task | Why |
|---|---|---|---|
| **1Password**, free for 2 years incl. Developer Tools | The plain-text `~/.roofops/hosted.env` | 0.1 follow-up | `hosted.env` holds only `op://` references and hosted commands run as `op run --env-file … -- npm run …`. Every hosted command then needs the owner's unlock in 1Password: a human gate the agent cannot pass, and no secret on disk |
| **GitHub** Dependabot (alerts, security and version updates) and **CodeQL** code scanning | Nothing today | 0.3 follow-up | Free on a public repository; `.github/dependabot.yml` (npm root and `web/`, GitHub Actions; weekly, grouped) and a CodeQL workflow for JavaScript/TypeScript |
| **Sentry**, student plan (50K errors, 100K transactions, 500 replays, Team, 1 year, renewable) | "Sentry only if needed" in §14 | 1.2 | Dashboard errors with the request and the signed-in employee; replays with every input masked. Enough volume for the pilot |
| **Honeybadger**, Small account free for 1 year (exceptions, uptime, cron check-ins) | healthchecks.io and the separate uptime monitor | 1.2 | One place for the `/api/healthz` uptime check and every heartbeat (07, 08, Lite Monitor, weekly backup). Moving back to healthchecks.io (free, no expiry) after the year is a URL change |
| **Name.com** free domain (.app, .dev, .software…) or **.TECH** (1 year) | The Vercel preview URL | 2.2 | A real address for the demo and the video; Vercel serves a custom domain on Hobby |
| **Testmail**, free Essential plan while a student | Checking alert emails by hand | 1.2 | The alert proof asserts that the failure email arrived, through Testmail's API, instead of a person looking |
| **GitHub Copilot** (Student, where available) code review | A second reviewer | every PR | A Copilot review on each PR; its comments reach this session through Auto-fix and carry no authority by themselves |
| **BrowserStack** Automate Mobile (1 parallel, 1 year) | Desktop-only e2e | 4.2 | Run the crew job-card specs on real phones before the crew pilot |
| **SimpleAnalytics**, Starter free for 1 year | Guessing adoption | 4.3–4.5 | Which dashboard pages staff actually open each week; privacy-friendly, no personal data |
| **GitHub Codespaces** (Pro level) | "Clone it and set up Postgres" | 3.3 | A `.devcontainer` with Node 24 and Postgres 17, so a reviewer runs the whole suite in the browser |

**Not used, on purpose:** Datadog and New Relic (a second observability stack for a one-person system); Doppler (1Password
covers secrets); Clerk (the dashboard already has staff sign-in with two-person approval; switching is a rebuild);
Heroku, Azure, Appwrite, MongoDB (the stack is Supabase, Vercel and n8n Cloud); DevCycle and ConfigCat (flags already
live in `app_settings`); Codecov and CodeScene (coverage and code-health numbers are not the trust measure, §2 item 9);
Travis CI (GitHub Actions). Learning offers (Frontend Masters, Educative, Boot.dev) are the owner's choice.

---

### Self-review (29 Oct)

- Spec coverage: every "missing rail" in §1 maps to a Phase 0/1 task; every research decision in §2 maps to a task or to §14; both products have a definition of done and a dated path; the standing constraints are reproduced and referenced by every 🔒 step.
- Steps: Phase 0–1 steps each name a file, a command or an approval, and an expected result. Phase 2–4 tasks name their completion criteria and defer step detail to the phase plan, on purpose.
- Consistency: `hostedDbConfig(target)` (Task 0.1) is what Tasks 1.4 and 1.6 use; `/api/healthz` (Task 1.2) is what Tasks 1.3, 1.4 and 4.1 read; the healthchecks.io checks named in Task 1.2 are the ones Tasks 1.6, L5 and L6 ping.
- Review focus: each of the five failure modes is pinned to a task's test or live proof.
- Proportion: this file is shorter than the research report it argues from and far shorter than the code it governs.
