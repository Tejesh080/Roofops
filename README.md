<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%8F%A0-RoofOps-0f2a44?style=for-the-badge&labelColor=0f2a44" alt="RoofOps" height="44" />

# RoofOps

### Operations system for a roofing contractor, from enquiry to paid invoice: every quote, job, supplier order and invoice kept consistent across Postgres, Airtable, Google Drive and Xero.

<br />

![Node.js](https://img.shields.io/badge/Node.js-24-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-App_Router-000000?style=flat-square&logo=nextdotjs&logoColor=white)
![React](https://img.shields.io/badge/React-UI-61DAFB?style=flat-square&logo=react&logoColor=black)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-hosted-3FCF8E?style=flat-square&logo=supabase&logoColor=white)
![Zod](https://img.shields.io/badge/Zod-4-3E67B1?style=flat-square&logo=zod&logoColor=white)

![n8n](https://img.shields.io/badge/n8n-Cloud-EA4B71?style=flat-square&logo=n8n&logoColor=white)
![Airtable](https://img.shields.io/badge/Airtable-staff_UI-18BFFF?style=flat-square&logo=airtable&logoColor=white)
![Xero](https://img.shields.io/badge/Xero-Demo_Company-13B5EA?style=flat-square&logo=xero&logoColor=white)
![Google Drive](https://img.shields.io/badge/Google_Drive-project_folders-4285F4?style=flat-square&logo=googledrive&logoColor=white)
![DeepSeek](https://img.shields.io/badge/DeepSeek-Operations_Copilot-4D6BFE?style=flat-square)
![Twilio](https://img.shields.io/badge/Twilio-SMS_%28RoofOps_Lite%29-F22F46?style=flat-square&logo=twilio&logoColor=white)

![Tests](https://img.shields.io/badge/tests-1%2C335_passing-2EA44F?style=flat-square&logo=vitest&logoColor=white)
![Engines](https://img.shields.io/badge/tested_on-PGlite_%2B_Postgres_17-4169E1?style=flat-square)
![Playwright](https://img.shields.io/badge/e2e-Playwright-2EAD33?style=flat-square&logo=playwright&logoColor=white)
![Promptfoo](https://img.shields.io/badge/AI_eval-Promptfoo_13%2F13-8A2BE2?style=flat-square)
![Integrity](https://img.shields.io/badge/integrity_check-0_FAIL-2EA44F?style=flat-square)
![ADRs](https://img.shields.io/badge/ADRs-40-555555?style=flat-square)
![Data](https://img.shields.io/badge/data-100%25_synthetic-F59E0B?style=flat-square)

<br />

[**Status**](#-project-status) · [**RoofOps Lite**](#-roofops-lite) · [**Screenshots**](#-screenshots) · [**Architecture**](#-architecture) · [**Engineering highlights**](#-engineering-highlights) · [**Quick start**](#-quick-start) · [**Docs**](#-documentation)

</div>

---

> [!NOTE]
> **Synthetic data, real integrations.** Every customer, supplier, address and amount is fictional. Every integration
> is a real service: Supabase, Airtable, n8n Cloud, Google Drive, the Xero **Demo Company**, DeepSeek and, for
> RoofOps Lite, Twilio. Anything not connected is reported **BLOCKED**, never simulated.

<p align="center">
  <img src="docs/screenshots/phase5/01-dashboard.png" alt="RoofOps operations overview: active projects, projects at risk, awaiting materials, ready to invoice, open issues and the needs-attention list" width="880" />
  <br />
  <sub><b>Operations overview.</b> Live from Postgres: 25 active projects, 6 at risk with the reasons named, supplier confirmations overdue, and $63,873 ready to bill.</sub>
</p>

## ✨ What it is

This repository holds two products:
- **Advanced RoofOps** (most of this page): the full operations system, with Postgres as the source of truth.
- **[RoofOps Lite](#-roofops-lite)**: a small Airtable + n8n + **Twilio SMS** package that any trade business can
  install, with no database or server to run.

Advanced RoofOps runs the full job lifecycle for a fictional Australian roofing contractor: **enquiry → quote →
accepted job → pre-start checks → materials → site visits → completion → invoice → Xero → payment**. The focus is on
what breaks in real operations:

- **Webhooks** that arrive twice, late or out of order.
- **Rate limits and ambiguous writes** to external APIs.
- **Office staff** editing spreadsheets however they like.
- **An AI assistant** that may read everything but must never move money without a person's approval.
- **An audit trail** you can prove hasn't been edited.

| | |
|---|---|
| 🧾 **One source of truth** | Postgres owns every business fact. Airtable, Drive and Xero hold objects; Postgres holds the *verified* link to each. |
| 🔁 **Exactly-once side effects** | A transactional outbox, idempotency keyed on the business fact, and read-back proof before anything counts as done. |
| 🚦 **State machines as data** | Allowed transitions live in `state_transitions` and are enforced by triggers, even for SQL that bypasses the application. |
| 🩺 **Self-checking** | Nightly reconciliation of Airtable, Drive and Xero against Postgres, 34 executable integrity rules, and a System Health page backed only by recorded checks. |
| 👥 **People approve money** | Staff sign in individually; the person who prepares an invoice or a reissue can never approve it. |
| 🤖 **Bounded AI** | The DeepSeek Copilot answers from named, server-side tools. It can *prepare* an invoice preview, but never approve, send or pay. |

### Features

| Area | What staff can do |
|---|---|
| **Sales** | Record an enquiry (duplicates detected), add the customer and site, book an inspection, build a quote, send it, hand it to Airtable |
| **Jobs** | An accepted quote becomes exactly one project, with its Google Drive folder and Airtable record; status changes follow a state machine |
| **Safety before work** | A job cannot start until its SWMS is signed and its materials are reviewed *(release pending)* |
| **Purchasing** | Supplier orders move forward only (ordered → confirmed → delivered) and follow their job |
| **Site work** | Site visits, crew and tasks, with crew-conflict checks; "My work" for each person |
| **Completion** | Completion photos and compliance certificate must be done (or waived with a reason) before the final invoice |
| **Invoicing** | Hashed preview → a second person approves → exactly one Xero DRAFT, read back; void and supervised reissue |
| **Oversight** | Dashboard, Finance page, needs-attention list, System Health, open exceptions with person-attributed resolution |
| **Copilot** | Answers questions about jobs, quotes, materials, finance and system health from database views |

## 📸 Screenshots

<table>
  <tr>
    <td width="50%" align="center">
      <img src="docs/screenshots/phase5/07-copilot-invoice-preview.png" alt="Operations Copilot preparing a draft invoice for PRJ-2026-0005" />
      <br /><sub><b>Operations Copilot.</b> "Prepare invoice for PRJ-2026-0005" returns a hashed preview ($17,831.91 inc GST) that waits for a finance approver. Nothing reaches Xero until then.</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/screenshots/phase6/01-system-health.png" alt="System health: services, sync status for Airtable, Google Drive and Xero, backlog and business rules" />
      <br /><sub><b>System health.</b> Every state comes from a recorded check: 231/231 Airtable records in sync, Drive 3/3, Xero 1/1, plus the business-rule results.</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="docs/screenshots/phase5/02-project-PRJ-2026-0011-at-risk.png" alt="Project PRJ-2026-0011 flagged at risk" />
      <br /><sub><b>At-risk project.</b> Risk is derived from facts (start date passed, supplier confirmation overdue), never typed in.</sub>
    </td>
    <td align="center">
      <img src="docs/screenshots/phase5/03-project-PRJ-2026-0004-xero-draft.png" alt="Project PRJ-2026-0004 with its verified Xero draft invoice" />
      <br /><sub><b>Verified Xero draft.</b> One DRAFT invoice in the pinned Demo Company tenant, read back before it counts.</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="docs/screenshots/phase5/04-project-PRJ-2026-0005-awaiting-approval.png" alt="Project PRJ-2026-0005 awaiting finance approval" />
      <br /><sub><b>Awaiting approval.</b> The preview is hashed; if anything changes before approval, it is refused as stale.</sub>
    </td>
    <td align="center">
      <img src="docs/screenshots/phase5/05-project-PRJ-2026-0033-recovery.png" alt="Project PRJ-2026-0033 recovering from a failed side effect" />
      <br /><sub><b>Failing safely.</b> A Google Drive outage leads to bounded retries, a dead letter and an exception, then recovery with no duplicate folder.</sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="docs/screenshots/phase5/06-copilot-attention.png" alt="Copilot answering what needs attention today" />
      <br /><sub><b>Grounded answers.</b> "What needs attention today?" is answered from database views, not from the model's memory.</sub>
    </td>
    <td align="center">
      <img src="docs/screenshots/phase6/03-copilot-PRJ-2026-0001.png" alt="Copilot reporting the canonical status of PRJ-2026-0001" />
      <br /><sub><b>Canonical status.</b> The Copilot reports what RoofOps holds, and says when Airtable disagrees.</sub>
    </td>
  </tr>
</table>

<details>
<summary><b>More screenshots</b> (responsive layouts, demo guide)</summary>
<br />

| Tablet | 1280 px | Copilot drawer on a tablet | Demo guide |
|---|---|---|---|
| <img src="docs/screenshots/phase5/09-dashboard-tablet.png" alt="Dashboard on a tablet" /> | <img src="docs/screenshots/phase5/09-dashboard-1280.png" alt="Dashboard at 1280 px" /> | <img src="docs/screenshots/phase5/09-tablet-copilot-drawer.png" alt="Copilot drawer on a tablet" /> | <img src="docs/screenshots/phase5/08-demo-guide.png" alt="Interview demo guide" /> |

</details>

## 🏗 Architecture

**One rule:** Postgres (Supabase) is the single source of truth for every business fact. Airtable is where office staff
*edit* a small set of fields and *read* everything else.

```mermaid
flowchart LR
    subgraph Staff["👷 Office staff"]
        AT["Airtable<br/>6 tables · 231 linked records"]
    end
    subgraph Owner["🧑‍💼 Owner / PM"]
        WEB["Next.js dashboard<br/>+ DeepSeek Copilot"]
    end
    subgraph Control["🗄 Postgres (Supabase): canonical"]
        PG["projects · quotes · POs · invoices<br/>state machines · outbox · audit hash chain<br/>reconciliation · health"]
    end
    subgraph Orchestration["⚙️ n8n Cloud"]
        N1["01 Quote accepted → project<br/>02 Drive folder · 03 Airtable project"]
        N6["06 Airtable changes"]
        N4["04/05 Invoice → Xero draft<br/>08 Reissue dispatch"]
        N10["10 Quote → Airtable"]
        N7["07 Reconcile + webhooks<br/>08 Health checks"]
    end
    DRIVE["📁 Google Drive<br/>project folders"]
    XERO["💷 Xero Demo Company<br/>DRAFT invoices"]

    AT -- webhooks --> N1 & N6 & N4
    N1 & N6 & N4 & N10 -- "SECURITY DEFINER wf_* only" --> PG
    PG -- "outbox (claimed, proved)" --> N4 & N10
    N4 --> XERO
    N10 --> AT
    N1 --> DRIVE & AT
    N7 <-- "read · compare · repair" --> AT & DRIVE & XERO
    N7 --> PG
    WEB -- "views + web_* functions<br/>least-privilege role, signed-in staff" --> PG
```

| Layer | System | Role |
|---|---|---|
| Staff-facing operations | **Airtable** | Edits a contracted set of fields; everything else is a read-only projection |
| Staff app | **Next.js dashboard** | Sales, site work, finance approvals, exceptions, health; every write is a `web_*` database function checked against the signed-in person |
| Control layer | **Postgres 17 (Supabase)** | Canonical facts, state machines, outbox, audit, reconciliation |
| Orchestration | **n8n Cloud** | Webhooks and side effects; never bypasses the database's rules |
| Accounting | **Xero Demo Company** | DRAFT invoices only, pinned to one proven tenant |
| Documents | **Google Drive** | One verified folder per project |
| Conversational | **DeepSeek Copilot** | Tiered, server-side tools; prepares, never executes money moves |

Full picture: [system ownership map](docs/system-ownership-map.md) · [architecture](docs/architecture.md) ·
[field-by-field contract (94 rows)](docs/source-of-truth.md) · [state machines](docs/state-machines.md)

## 🛡 Engineering highlights

<details open>
<summary><b>Idempotency and exactly-once side effects</b></summary>

- The idempotency key is the **business fact**, not the delivery id. A webhook redelivered 20 times produces one change
  and one audit row.
- Side effects run through a **transactional outbox** with claim leases. Nothing is `DONE` without **read-back proof**
  from the external system.
- An ambiguous Xero write is marked `UNKNOWN` and reconciled before any retry: never a second draft.

</details>

<details open>
<summary><b>Every Airtable edit is validated</b></summary>

- One entry point (`wf_airtable_change`), driven by the ownership contract, checks each edit:
  - it is identified by record link;
  - the row is locked;
  - duplicate, stale and compare-and-set checks run;
  - the field owner is looked up;
  - the state machine and business guards apply.
- Refused edits are **put back in Airtable** with a plain-English explanation in the `RoofOps Sync` field.

</details>

<details open>
<summary><b>Reconciliation that replays, never guesses</b></summary>

- Nightly (and on demand), n8n 07 reads every Airtable table, Drive folder and Xero draft.
  - A missed staff edit is replayed through the same validation.
  - RoofOps-owned drift is repaired and verified.
  - Anything ambiguous becomes a named exception for a person.
- A lost webhook costs latency, never data.

</details>

<details open>
<summary><b>Adversarial testing and a defect ledger</b></summary>

- 14 independent adversarial reviewers tried to *falsify* the claim that RoofOps works. The result is a
  [catalogue of 30 new failure hypotheses](docs/adversarial-test-catalogue.md).
- Each defect is then fixed one at a time in a [defect ledger](docs/defect-ledger.md): reproduce → root cause →
  failing test → fix → verify on both database engines → deploy → live check.
- **13 defects are FIXED and verified live**, including all 9 P0s: stale reconciliation reads (AC-01), exact-preview
  approval binding (AC-03), Xero voids and tenant pinning (AC-05, AC-06), verified Xero settlement (AC-14) and the
  supervised reissue of a voided invoice (AC-14C, live in the Xero Demo Company).
- **15 more are fixed offline** and wait for one release: the pre-start safety gate (AC-13B), fully billed jobs
  cannot be cancelled (AC-15, AC-15B), deterministic quote acceptance (AC-23, AC-25, AC-18), purchase orders follow
  their job (AC-21), a cancelled job frees its site visits (OPS-02), Copilot guards (AC-22, COP-01, COP-02) and
  per-line GST for reissues (FIN-08). Each has failing-first tests, two-connection race tests where it matters, and an
  exact rollback rehearsed on a restored copy of the hosted database.

</details>

<details>
<summary><b>Security and least privilege</b></summary>

- n8n reaches Postgres only through `SECURITY DEFINER` entry points. The dashboard role can read curated views and
  nothing else.
- RLS is on with no policies; all access is server-side. Secrets live in n8n credentials and server env only; client
  bundles are scanned.
- Xero writes are pinned to one proven Demo Company tenant. The audit trail is a **hash chain**, verified by
  `integrity:check`.

</details>

## 📊 Project status

Last updated 2026-10-29. **Live** = running on hosted Supabase, n8n Cloud, Airtable, Drive or the Xero Demo Company,
with recorded evidence. **Local** = proven by the test suite, not yet deployed.

| Capability | State |
|---|---|
| Quote accepted in Airtable → one project, Drive folder and Airtable record | ✅ Live |
| Staff edits in Airtable validated by Postgres, refused edits put back with an explanation | ✅ Live |
| Invoice preview → second-person approval → one Xero Demo DRAFT, read back | ✅ Live |
| Void in Xero → supervised reissue of the same invoice (generation 2) | ✅ Live |
| Nightly reconciliation of Airtable, Drive and Xero; health checks every 30 minutes | ✅ Live |
| Staff sign-in, roles, sessions, lockout | ✅ Live (synthetic staff only) |
| Dashboard and Copilot | ✅ Live on a protected Vercel preview |
| Enquiry → quote → Airtable hand-off | 🟡 Live once (one synthetic quote, 2026-10-20) |
| Site visits, crew and tasks | 🟡 Deployed, not yet used on the hosted system |
| Pre-start gate, cancellation and purchase-order guards, Copilot read tools ([release runbook](ops/advanced-release-runbook-20261023.md)) | 🟡 Local; backup and read-only preflight passed 2026-10-23, deployment awaits approval |
| Per-line GST on multi-line invoices | 🟡 Local; needs one supervised Xero Demo check |

**Not built yet, and needed before a real business could rely on it:**
- continuous integration (the full suite runs locally today);
- a staging environment separate from the hosted demo;
- alerts that notify a person (today failures are recorded and shown on `/health`);
- a real Xero organisation, real data and real staff (everything is synthetic; the business date is fixed at 2026-09-29);
- one editing surface for staff (project status is edited in Airtable, site work in the dashboard);
- phone-friendly screens for crews.

The phase reports ([2](docs/phase2-status.md), [3](docs/phase3-status.md), [4](docs/phase4-status.md),
[5](docs/phase5-status.md), [6](docs/phase6-status.md)) record how each part was built and proven.

## 📱 RoofOps Lite

A reusable automation package for a small trade business (roofing, plumbing, electrical). An **Airtable** CRM, five
**n8n** workflows and **Twilio** SMS; everything business-specific is one config file, and a build step generates the
workflows and the website enquiry form for each client. It is separate from Advanced RoofOps: it touches none of its
tables, workflows, invoices or Xero. Full guide: [lite/README.md](lite/README.md).

| Module | What it does |
|---|---|
| **Quote-to-Paid CRM** | One job per enquiry, New Lead to Paid, with the contact, their recorded consent, site, quote, messages and alerts (6 Airtable tables + an Interface) |
| **Instant Lead Follow-Up** | A website form posts a lead; it is checked, de-duplicated, saved with the consent given, and acknowledged by SMS once |
| **Google Review Requests** | Daily: each finished job gets one review request, only with review permission |
| **Lead Reactivation** | Weekly: quiet enquiries get one follow-up, only with recorded marketing consent, with a cooldown and a cap |
| **Replies and delivery receipts** | STOP opts out of everything; other replies reopen the enquiry; Twilio delivery receipts update the log |
| **Monitor** | Failed runs, failed or unconfirmed messages and leads nobody contacted are raised once as alerts; safe retry |

**Built to never double-send or spam:**
- Each message is reserved in the Message Log before it is sent, so a second run skips it.
- A message Twilio may have sent (timeout, server error) is marked **Unknown** and never resent by itself.
- Review and marketing messages need recorded consent, and every message names the business and says how to stop
  (Australian Spam Act 2003).
- Messaging is **off by default** (a test sink). In Twilio mode, real SMS go only to an allowlist until go-live.

| Lite status | State |
|---|---|
| 70 acceptance tests and a local demo (the workflows' real node code, an in-memory Airtable, a fake Twilio API with signed webhooks and real error codes) | ✅ Local |
| The workflows in n8n Cloud against a real Airtable base, messages to the test sink, synthetic data (20–21 Oct) | ✅ Live |
| Twilio connected through n8n's credential; every check that sends no SMS passed against the real Twilio API | ✅ Live |
| Real SMS | ⏸ Not yet. The supervised live test on 21 Oct stopped when the Twilio trial account refused the first message (error 572003); no SMS has been sent. The test's clean-up (unpublishing Inbound Replies) awaits the owner |

Try it locally (nothing leaves your computer):

```bash
npx tsx lite/demo/run-demo.ts lite/config/example-plumbing-twilio.json lite/demo/output-twilio
```

## 🚀 Quick start

> **Requires** Node 24 and Docker.

Install dependencies:

```bash
npm install
```

Start local Postgres 17:

```bash
npm run db:up
```

Apply migrations and import the synthetic dataset (running it again is a no-op):

```bash
npm run db:load
```

Lint, typecheck and test:

```bash
npm run check
```

`npm test` runs on in-process **PGlite**. To also run every database suite against **real Postgres 17**, including the
two-connection concurrency tests:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test
```

`npm run db:reset` rebuilds the local database from scratch. After changing a date rule, run `npm run data:normalise`.

## 🧭 Operating the hosted system

| Command | What it does |
|---|---|
| `npm run integrity:check` | Executable business rules, PASS / WARNING / FAIL per entity, including the audit hash chain |
| `npm run reconcile -- --dry-run` | Airtable / Drive / Xero ↔ Postgres check through n8n 07 (observe only) |
| `npm run reconcile` | Same, and repair: replay missed edits, repair RoofOps-owned drift |
| `npm run demo:status` · `demo:reset` | Interview scenarios |
| `npm run security:check` | Database privilege audit |
| `npm run ai:eval` | Copilot regression with Promptfoo (web app running) |
| `npm run contract:export` | Regenerate the source-of-truth and state-machine docs |

### 🧾 The supervised reissue CLI

A final invoice whose Xero document was legitimately **voided or deleted** in Xero is not collectible, but the customer
still owes the job. A FINANCE or ADMIN employee brings the *same* invoice back with two explicit, audited steps against
the local database (`DATABASE_URL`, default `postgresql://postgres:postgres@127.0.0.1:54322/roofops`; a non-local host
is refused) or, with `--hosted`, the hosted one:

```bash
# 1. ask for a reissue of a voided final invoice (the reason is mandatory)
npm run reissue -- request --invoice INV-2026-0004 --by EMP-900 --reason "Xero deleted the draft; the customer still owes the job"

# 2. a finance approver decides: exactly one new Xero draft generation is queued for the same invoice
npm run reissue -- decide --approval APR-2026-0009 --by EMP-900 --note "checked the customer account"
```

Both steps print the JSON the database returns (`{ ok, code, detail, ... }`) and nothing else: the CLI holds no rules
of its own, writes nothing itself and never calls Xero. Exit codes: `0` success, `2` refused (the canonical code is in
the JSON - `REASON_REQUIRED`, `ACTOR_UNAUTHORIZED`, `INVOICE_NOT_VOIDED`, `TENANT_MISMATCH`, `PAYMENT_EXISTS`,
`WRITE_IN_FLIGHT`, `ALREADY_PROCESSED`, ...) and `1` for a usage or connection error. A refusal changes nothing.

The queued generation is then created in Xero by **[RoofOps] 08 Reissue Dispatch**, which runs the unchanged
[RoofOps] 05 for exactly one write: the invoice number and generation the operator names. Postgres lists it only when it
is that invoice's current generation ≥ 2, due and proven to be the supervised reissue; no other queued reissue is ever
dispatched with it, and 05's claim re-proves the write before any Xero call:

```bash
# 3. where does the invoice's current Xero draft generation stand? (read-only)
npm run reissue -- status --invoice INV-2026-0004

# 4. create it in Xero through 08 -> 05 and wait for the outcome (hosted only: 08 reads the hosted database)
npm run reissue -- dispatch --invoice INV-2026-0004 --hosted
```

`--hosted` runs any step against the hosted database (`SUPABASE_DB_URL` in `~/.roofops/hosted.env`, like `db:load --hosted`); every hosted write also needs `--confirm <project-ref>`. `dispatch` POSTs
08's webhook with `REISSUE_DISPATCH_TOKEN` from `~/.roofops/hosted.env` and the selection (`{ invoice_number, generation }`, read
from the invoice's current generation); Postgres keeps only the token's SHA-256 in
`app_settings.reissue.dispatch_token_sha256` (empty = every dispatch refused). It reports `REISSUE_CREATED` (exit 0),
`NO_REISSUE_QUEUED`, `REISSUE_NOT_CREATED` (05 failed it: see `last_error` / `open_exceptions`) or `STILL_PENDING`
(token refused, 08 not published, or the write not proven - see `open_exceptions`) (exit 2).

## 🧪 Testing

1,335 tests pass (37 skipped on PGlite only) across 67 Vitest files, on PGlite and real Postgres 17. External services
are simulated in these tests by calling the database functions with the payloads the workflows send, so live checks are
recorded separately in [evidence/](evidence/).

| Suite | Where | Notes |
|---|---|---|
| Unit, database and workflow | `test/*.test.ts` (Vitest) | Every database suite runs on PGlite **and** real Postgres 17 |
| n8n workflow code | `test/n8n-*.test.ts` | The real Code-node JavaScript and HTTP requests of the workflows, run in a harness |
| Business lifecycle | `test/business-lifecycle.test.ts` | Enquiry to Xero draft at the database boundary, with failure injections |
| RoofOps Lite | `test/lite.test.ts` | 70 acceptance tests: consent, opt-out, de-duplication, Twilio errors, retries, monitoring |
| State integrity | `test/state-integrity.test.ts` | All state-machine pairs are generated from `state_transitions`; includes real two-connection race tests |
| End to end | `web/e2e/*.spec.ts` (Playwright, 11 specs) | Staff, sales, site-work and invoice-approval journeys; Airtable ↔ dashboard state sync |
| AI regression | `promptfoo/` | Grounded against the database; refusals for approve, pay, credential and SQL requests |
| Live proofs | `test/live-*.test.ts` | Read-only checks against hosted, opt-in via `RUN_HOSTED_TESTS=1` |

## 🗂 Repository layout

```text
supabase/migrations/   schema, workflow functions, state machines, reconciliation (64 ordered migrations)
src/                   importer, date normalisation, event envelope (zod), db port and migration runner
n8n/                   the 16 n8n workflows as code (SDK)
web/                   Next.js dashboard, Copilot (agent + tools), auth, Playwright e2e
test/                  Vitest suites and fixtures (webhooks, HTTP failures)
scripts/               load, reconcile, integrity, security, staff, reissue, AI eval, contract export
promptfoo/             Copilot regression suite
data/                  raw synthetic bundle and normalised dataset (with hashes)
docs/                  architecture, ADRs, contracts, state machines, phase reports, defect ledger
ops/                   release and demo runbooks; ops/rollback/ holds the exact down file for each recent migration
evidence/              live and offline verification records
lite/                  RoofOps Lite: a separate Airtable + n8n + Twilio package for small trade businesses
```

## 📚 Documentation

| Start here | Deep dives | Quality |
|---|---|---|
| [Architecture](docs/architecture.md) | [Data model](docs/data-model.md) | [Acceptance criteria](docs/acceptance-criteria.md) |
| [System ownership map](docs/system-ownership-map.md) | [Source-of-truth contract](docs/source-of-truth.md) | [Mutation matrix](docs/mutation-matrix.md) |
| [Decisions (40 ADRs)](docs/decisions.md) | [State machines](docs/state-machines.md) | [Adversarial test catalogue](docs/adversarial-test-catalogue.md) |
| [Data import](docs/data-import.md) | [Airtable editability audit](docs/airtable-editability-audit.md) | [Defect ledger](docs/defect-ledger.md) |

---

<div align="center">
<sub>Built as a portfolio project. All business data is synthetic; all integrations are real sandbox or demo services.</sub>
</div>
