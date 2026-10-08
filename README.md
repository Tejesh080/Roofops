<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%8F%A0-RoofOps-0f2a44?style=for-the-badge&labelColor=0f2a44" alt="RoofOps" height="44" />

# RoofOps

### Operations control centre for a roofing contractor: every job, supplier order and invoice kept consistent across Airtable, Postgres, Google Drive and Xero.

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

![Tests](https://img.shields.io/badge/tests-314_passing-2EA44F?style=flat-square&logo=vitest&logoColor=white)
![Engines](https://img.shields.io/badge/tested_on-PGlite_%2B_Postgres_17-4169E1?style=flat-square)
![Playwright](https://img.shields.io/badge/e2e-Playwright-2EAD33?style=flat-square&logo=playwright&logoColor=white)
![Promptfoo](https://img.shields.io/badge/AI_eval-Promptfoo_13%2F13-8A2BE2?style=flat-square)
![Integrity](https://img.shields.io/badge/integrity_check-0_FAIL-2EA44F?style=flat-square)
![ADRs](https://img.shields.io/badge/ADRs-40-555555?style=flat-square)
![Data](https://img.shields.io/badge/data-100%25_synthetic-F59E0B?style=flat-square)

<br />

[**Screenshots**](#-screenshots) · [**Architecture**](#-architecture) · [**Engineering highlights**](#-engineering-highlights) · [**Quick start**](#-quick-start) · [**Docs**](#-documentation)

</div>

---

> [!NOTE]
> **Synthetic data, real integrations.** Every customer, supplier, address and amount is fictional. Every integration
> is a real service: Supabase, Airtable, n8n Cloud, Google Drive, the Xero **Demo Company** and DeepSeek. Anything not
> connected is reported **BLOCKED**, never simulated.

<p align="center">
  <img src="docs/screenshots/phase5/01-dashboard.png" alt="RoofOps operations overview: active projects, projects at risk, awaiting materials, ready to invoice, open issues and the needs-attention list" width="880" />
  <br />
  <sub><b>Operations overview.</b> Live from Postgres: 25 active projects, 6 at risk with the reasons named, supplier confirmations overdue, and $63,873 ready to bill.</sub>
</p>

## ✨ What it is

RoofOps runs the full job lifecycle for a fictional Australian roofing contractor: **lead → quote → project → purchasing
→ field work → invoice → payment**. The focus is on what breaks in real operations:

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
| 🩺 **Self-checking** | Nightly reconciliation of Airtable, Drive and Xero against Postgres, 26 executable integrity rules, and a System Health page backed only by recorded checks. |
| 🤖 **Bounded AI** | The DeepSeek Copilot answers from named, server-side tools. It can *prepare* an invoice preview, but never approve, send or pay. |

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
        N1["01 Quote → Project"]
        N6["06 Airtable changes"]
        N4["04/05 Invoice → Xero draft"]
        N7["07 Reconcile + webhooks"]
    end
    DRIVE["📁 Google Drive<br/>project folders"]
    XERO["💷 Xero Demo Company<br/>DRAFT invoices"]

    AT -- webhooks --> N1 & N6 & N4
    N1 & N6 & N4 -- "SECURITY DEFINER wf_* only" --> PG
    PG -- "outbox (claimed, proved)" --> N4
    N4 --> XERO
    PG -- outbox --> DRIVE
    N7 <-- "read · compare · repair" --> AT & DRIVE & XERO
    N7 --> PG
    WEB -- "read-only views<br/>least-privilege role" --> PG
```

| Layer | System | Role |
|---|---|---|
| Staff-facing operations | **Airtable** | Edits a contracted set of fields; everything else is a read-only projection |
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
- **AC-01** (a reconciliation read older than a staff edit could revert it) is fixed. It has regression tests,
  **two-connection race tests** on real Postgres, and is deployed to hosted. Live verification is pending.
- **AC-14C** (a final invoice voided or deleted in Xero was a dead end) is **fixed offline**: a voided invoice is no
  longer collectible while the customer still owes the job, and the *same* invoice can be brought back only through a
  FINANCE/ADMIN supervised reissue (`npm run reissue`) — a fresh, evidence-bound approval, the void proof in its bound
  tenant, no money moved, one new Xero draft generation, the old one kept in the ledger for ever. Proven end to end
  (both engines) with a 24-step recovery lifecycle; not deployed.

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

| Phase | Scope | State |
|---|---|---|
| 0 | Architecture, schema, acceptance criteria | ✅ |
| 1 | Database + canonical data import (dates normalised to 2026-09-29) | ✅ |
| 2 | Airtable Quote Accepted → n8n → Postgres → Project → Drive → audit → Airtable | ✅ live ([status](docs/phase2-status.md)) |
| 3 | Approved project → **Xero Demo Company DRAFT invoice** (approval, idempotency, read-back) | ✅ live ([status](docs/phase3-status.md)) |
| 4 | **Operations Dashboard + DeepSeek Operations Copilot** | ✅ ([status](docs/phase4-status.md)) |
| 4b | UI polish, interview readiness, auth, demo reset, Vercel-ready | ✅ ([status](docs/phase5-status.md)) |
| 6 | **State integrity, reconciliation, System Health, AI regression** | ✅ live ([status](docs/phase6-status.md)) |
| 🔬 | **Adversarial hardening**: [catalogue](docs/adversarial-test-catalogue.md) → [defect ledger](docs/defect-ledger.md) | 🟡 in progress (AC-01 deployed; **AC-14C** fixed offline — supervised reissue via `npm run reissue`) |
| 5 | Supplier quote → purchase order | ⏳ planned |
| 7 | OpenTakeoff experiment (optional) | ⏳ planned |

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
[RoofOps] 05 for every write Postgres proves is a supervised reissue (05's claim re-proves it before any Xero call):

```bash
# 3. where does the invoice's current Xero draft generation stand? (read-only)
npm run reissue -- status --invoice INV-2026-0004

# 4. create it in Xero through 08 -> 05 and wait for the outcome (hosted only: 08 reads the hosted database)
npm run reissue -- dispatch --invoice INV-2026-0004 --hosted
```

`--hosted` runs any step against the hosted database (`SUPABASE_DB_URL`, like `db:load --hosted`). `dispatch` POSTs
08's webhook with `REISSUE_DISPATCH_TOKEN` from `.env.local`; Postgres keeps only its SHA-256 in
`app_settings.reissue.dispatch_token_sha256` (empty = every dispatch refused). It reports `REISSUE_CREATED` (exit 0),
`NO_REISSUE_QUEUED`, `REISSUE_NOT_CREATED` (05 failed it: see `last_error` / `open_exceptions`) or `STILL_PENDING`
(token refused, 08 not published, or the write not proven - see `open_exceptions`) (exit 2).

## 🧪 Testing

| Suite | Where | Notes |
|---|---|---|
| Unit, database and workflow | `test/*.test.ts` (Vitest) | Every database suite runs on PGlite **and** real Postgres 17 |
| State integrity | `test/state-integrity.test.ts` | All state-machine pairs are generated from `state_transitions`; includes real two-connection race tests |
| End to end | `web/e2e/*.spec.ts` (Playwright) | Screens, smoke, Airtable ↔ dashboard state sync |
| AI regression | `promptfoo/` | Grounded against the database; refusals for approve, pay, credential and SQL requests |
| Live proofs | `test/live-*.test.ts` | Read-only checks against hosted, opt-in via `RUN_HOSTED_TESTS=1` |

## 🗂 Repository layout

```text
supabase/migrations/   schema, workflow functions, state machines, reconciliation (18 ordered migrations)
src/                   importer, date normalisation, event envelope (zod), db port and migration runner
n8n/                   the 13 n8n workflows as code (SDK)
web/                   Next.js dashboard, Copilot (agent + tools), auth, Playwright e2e
test/                  Vitest suites and fixtures (webhooks, HTTP failures)
scripts/               load, reconcile, integrity, security, AI eval, contract export
promptfoo/             Copilot regression suite
data/                  raw synthetic bundle and normalised dataset (with hashes)
docs/                  architecture, ADRs, contracts, state machines, phase reports, defect ledger
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
