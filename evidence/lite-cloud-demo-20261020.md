# Evidence: RoofOps Lite cloud demonstration, 2026-10-20

These are the four Lite automations, run in n8n Cloud against real Airtable records. They used the existing base `appMc8V0Wm29tEeHQ` and the existing n8n project "Roofops". The data was synthetic and messages went to the simulated sink only. Everything was approved by the owner as one batch.

- **Code:** branch `feature/roofops-lite` at `12bbf6d`. Rebuilding the generated exports from the committed sources gave identical files (`git diff --exit-code lite/dist`).
- **Run window:** 11:07 to 11:25 UTC.
- **Resource IDs:** every created resource is listed in `lite/demo/cloud-resources.demo.json`.

## Result

| # | Acceptance test | Result | Evidence |
|---|---|---|---|
| 1 | New lead | **PASS** | execution 3095 |
| 2 | Duplicate lead | **PASS** | execution 3100 |
| 3 | Quote-to-Paid CRM | **PASS** | Airtable writes and Interface reads below |
| 4 | Google review requests | **PASS** | execution 3107 |
| 5 | Lead reactivation | **PASS** | execution 3111 |
| 6 | Inbound replies | **PASS** | executions 3115 and 3118 |
| 7 | Duplicate prevention on re-run | **PASS** | executions 3110, 3114 and 3121 |

Two extra runbook cases also passed:
- **Invalid lead** (execution 3102): HTTP 400 and nothing written.
- **Lead without consent** (execution 3103): the job was saved and the acknowledgement Skipped.

Every number below matched the local run in `lite/demo/output/demo-report.md`, which uses the same node code against the in-memory Airtable.

## What was created

### Airtable tables

All five were new. Fields and options were taken from `lite/airtable/schema.json`, and the specs and order from `setup.ts`.

| Table | ID | Fields | Records before | After seed | After demo |
|---|---|---|---|---|---|
| Lite Contacts | `tble7dgq0tl1vvoWs` | 15 + 3 back-links | (did not exist) | 12 | 14 |
| Lite Properties | `tblO0DR7XBW5tByLI` | 4 + Contact + 1 back-link | (did not exist) | 13 | 14 |
| Lite Jobs | `tbl4iwogMRPz0g6Q5` | 16 + Contact, Property + 2 back-links | (did not exist) | 13 | 15 |
| Lite Quotes | `tblKg4sjiGcrvCjMI` | 6 + Job | (did not exist) | 2 | 3 |
| Lite Message Log | `tblW8Uq5j5dW0B8RH` | 11 + Job, Contact | (did not exist) | 0 | 11 |

Airtable created the back-links on Lite Contacts as "Lite Properties", "Lite Jobs" (`fld4QlyTquSn8VEPr`, the name the workflows rely on) and "Lite Message Log".

**How it was done.** No Airtable personal access token was set on this machine, so `setup.ts --apply` and `seed-demo.ts --apply` could not run as written. The same calls went through the owner's authenticated Airtable connector instead:
- The tables used exactly the plan `setup.ts` prints: the five tables first, then the six link fields.
- The records were produced by the seed tool's own `demoRecords()`. They were loaded contacts → properties → jobs → quotes, with each local link mapped to the real record ID.

### Advanced RoofOps tables (independent check)

| Table | Records before | Records after | Fields before = after |
|---|---|---|---|
| Customers | 41 | 41 | 13 |
| Suppliers | 6 | 6 | 8 |
| Properties | 53 | 53 | 12 |
| Quotes | 66 | 66 | 20 |
| Projects | 33 | 33 | 29 |
| Purchase Orders | 35 | 35 | 10 |

The total stayed at 234 records, which matches the last reconciliation. The six Advanced tables and their field IDs were identical in schema reads taken before and after the Lite tables were created. The demo itself writes records only, never schema.

**Supabase (hosted, read-only), 11:10 onwards:**
- `airtable_writes`: 0
- `airtable_observations`: 0
- `audit_events`: 0
- `automation_events`: 0
- `processed_events`: 0

Xero was not touched.

### n8n workflows

All four are in project Roofops (`4kSuZdSc0Opp3juv`) and unpublished: `active: false`, `triggerCount: 0`, so no production webhook is registered. They were created from `lite/dist/demo/*.sdk.ts`, and every Airtable node carries the credential `3XbFnHjAd7mFvBD2`.

| Workflow | ID | Nodes |
|---|---|---|
| [Lite] Instant Lead Follow-Up | `6GlAPXRMVAEyK9pV` | 25 |
| [Lite] Google Review Requests | `LdPy36pX3jKJxd2r` | 14 |
| [Lite] Lead Reactivation | `ECE108TYrOoHsTQh` | 14 |
| [Lite] Inbound Replies | `vc4DEkcDxXnEdLmr` | 17 |

Every run was a manual execution through the n8n API (`executionMode: manual`). Webhook payloads were passed directly, so no public URL was opened.

### Airtable Interface (the CRM views)

The Interface is **Lite Quote-to-Paid** (`pbdAzDJhyiIb7CFZJ`), published. Its pages:

| Page | ID | What it shows |
|---|---|---|
| Overview | `pagXFR1yZ7q3TAwXz` | Headline numbers: new leads (with a list), to invoice, money owed, paid, logged messages (with the latest) |
| Pipeline | `pagSoRoOHL8eClVBC` | Kanban of Lite Jobs by Stage, with a count per stack |
| Jobs | `pagweElqH06yKZeXg` | Grid with tabs: New leads, To quote, Work on, To invoice, Unpaid, Reviews, Quiet leads, Demo data |
| Message Log | `pagXBMMy90Crh9v3Q` | Grouped by workflow, newest first. Tabs: Problems, Replies and opt-outs |
| Contacts | `pag03vKa1GUUsao5Y` | Tabs: Do not contact, Marketing list |
| Quotes | `pagYpUijUAOhMnXoj` | Quotes with an Amount total |

## Test details

### Test 1: new lead (execution 3095)

The input was the synthetic lead "ZZ Lite Demo Emma Walsh" (`0400 000 201`, `emma.walsh@example.test`), with SMS and email consent.

The webhook replied 200:
```json
{"ok":true,"duplicate":false,"job_ref":"LJ-20261020-J4MN","new_contact":true,"stage":"Contacted","acknowledgement":{"status":"Simulated Sent","channel":"SMS","reason":null}}
```

In Airtable:
- **Contact** `recZ6rfPo4kTnMvA3` was created.
- **Property** `recZUen5DBTFQJGAX` was created, linked to the contact.
- **Job** `recG8LPTJweKiOhVY` was created, linked to the contact and the property. It started at New Lead and moved to Contacted once the acknowledgement was logged.
- **Message Log** row `recBhW1BumGKDY6GR` was written:
  - Status Simulated Sent, Provider `lite-test-sink`, To `0400000201`;
  - Body: "Hi Emma, thanks for contacting Harbourside Roofing (Lite demo) about roof leak repair. We've got your enquiry and will call you within one business day. Reply STOP to opt out."

### Test 2: duplicate lead (execution 3100)

The same person sent the form again. The webhook replied 200 with `duplicate: true` and the same `job_ref` (LJ-20261020-J4MN). The contact was found by email or phone, and the open job through the contact's "Lite Jobs" back-link.

No create node ran. After the test there was still exactly one Emma contact, one property and one job. The only write was a Skipped log row, "repeat enquiry within 30 days of LJ-20261020-J4MN" (`recTb4K62KgeAGX7g`), not a second acknowledgement.

### Test 3: Quote-to-Paid CRM

Job LJ-20261020-J4MN went through every stage. Each write was read back from Airtable.

| Stage | Who | Writes |
|---|---|---|
| New Lead | Lead Follow-Up, execution 3095 | job created |
| Contacted | Lead Follow-Up, execution 3095 | after the simulated acknowledgement |
| Quoted | staff (connector) | quote LQ-DEMO-EMMA `rec5Dn3fRDjJhH7iW` created ($3,450, Sent, linked to the job; the job's "Lite Quotes" back-link filled in), then Stage set |
| Accepted | staff | quote Status Accepted and Accepted At, then Stage |
| Job In Progress | staff | Stage |
| Completed | staff | Stage and Completed At |
| Invoiced | staff | Stage, Invoice Status Invoiced, Invoice Amount $3,450 |
| Paid | staff | Stage, Invoice Status Paid |

Checked through the published Interface:
- **At Invoiced:** the Overview "Owed" element returned R4 ($1,200) and LJ-20261020-J4MN ($3,450), so $4,650 owed.
- **After Paid:** the Pipeline Kanban returned all 15 jobs with their linked contact names, and the job was in the Paid stack.
- **Read-back of the final job:** linked to contact `recZ6rfPo4kTnMvA3`, property `recZUen5DBTFQJGAX`, quote `rec5Dn3fRDjJhH7iW`, and log rows `recBhW1BumGKDY6GR` and `recTb4K62KgeAGX7g`.

No invoice was created anywhere. In Lite, invoicing is tracking only.

### Test 4: Google review requests (execution 3107)

```json
{"finished_jobs":5,"sent":2,"skipped":2,"skip_reasons":{"opted out":1,"no consent or no reachable contact detail":1},"not_due_yet":1,"logged":4,"jobs_updated":4}
```

| Who | Result |
|---|---|
| Olivia (R1) | SMS `recB69Jj93cPlHQaN` |
| Marcus (R2) | email `receB2nsfIPhzMcdc` (preferred channel Email) |
| Priya (R3) | Skipped, opted out (`recMZf15lTKnGnn4l`) |
| Tom (R4) | Skipped, no consent (`recs5y2d6Ghcwxl9e`) |
| Grace (R5) | Not due yet (finished 1 day ago; the delay is 2 days) |

The jobs were marked with Review Status Sent or Skipped.

### Test 5: lead reactivation (execution 3111)

```json
{"open_leads":8,"sent":2,"still_active":3,"excluded":3,"exclusion_reasons":{"no marketing permission":1,"opted out":1,"followed up within the cooldown":1},"logged":2,"jobs_updated":2}
```

| Who | Result |
|---|---|
| Mia (A6) | email `recelO7FpNdRE5Y3s` |
| Daniel (A1) | SMS `recKayJlQBrO0OM87` |
| Sophie | Excluded: no marketing permission |
| Liam | Excluded: opted out |
| Ava | Excluded: followed up 30 days ago, within the 180-day cooldown |
| Noah, Emma, Ethan | Still active (recent activity) |

### Test 6: inbound replies (executions 3115 and 3118)

**Daniel replies "Yes please, call me this week"** from `0400 000 106` (execution 3115):
- The reply returned `known_contact: true`, `job_ref: LJ-DEMO-A1`.
- The job's Last Activity moved to the time of the reply.
- A Received row was logged (`recml8rqSJwswJcpZ`).

**Olivia replies "STOP"** from `+61 400 000 101` (execution 3118). The sender was matched despite the different number format.
- The reply returned `opted_out: true`.
- Contact `rec5BD3IAghAEK2v9` now has Opted Out ticked, Opted Out At set and Marketing Opt-In cleared.
- An Opt-Out row was logged (`rec0Pv8ItckMaHFGP`).

### Test 7: duplicate prevention

| Run | Execution | Result |
|---|---|---|
| Review Requests, again | 3110 | `sent 0, logged 0, jobs_updated 0, not_due_yet 1` |
| Reactivation, again | 3114 | `sent 0, logged 0`, excluded 5 (cooldown 3) |
| Reactivation, after the replies | 3121 | `sent 0`, still active 4 (Daniel is active again), opted out 1 |

**Message Log at the end: 11 rows**, every one with Provider `lite-test-sink`:
- Lead Follow-Up: 3 (1 sent, 2 skipped);
- Review Request: 4 (2 sent, 2 skipped);
- Reactivation: 2 sent;
- Inbound Reply: 2.

Each of the 4 people who got a simulated review request or reactivation message has exactly one row.

## Findings

1. **Lite writes wake the Advanced workflow `[RoofOps] 06 Airtable Changes → Postgres`** (`lD6BOf2dhZZpSoEH`). It listens to a base-wide Airtable webhook, so every Lite write in this shared base triggered a run: 24 runs between 11:15 and 11:24.
   - The workflow processes only the six Advanced table IDs (`TABLES` in `n8n/06-airtable-changes.sdk.ts`). The checked runs ended with `no_events: true` and only advanced its payload cursor (71 → 96).
   - Supabase shows no new events for the window.
   - So the effect is harmless, but it costs n8n executions. It only happens because the demo shares the RoofOps base.
   - **For a client deployment, give Lite its own base.** The deployment guide says so. Workflow 06 was not changed.
2. **The setup and seed tools need a personal access token.** None was configured on this machine, so the connector carried out the same plan.
   - For a client, either create a base-scoped token and run the tools, or repeat the connector steps in `lite/DEPLOY.md`.
3. **Airtable Interfaces can be created through the Airtable connector.** `lite/airtable/views.md` said they had to be built by hand; it now describes the Interface built here.
4. **Cosmetic issues:**
   - The Lead Follow-Up stores the phone in normalised form (`0400000201`), while seeded contacts show `0400 000 201`.
   - The reactivation template reads "about full re-roof", with no article.

   Neither affects matching or delivery. Both are wording or format choices for the client config.

No defect in the Lite workflows or the schema was found. Nothing needed fixing or a second run: every execution succeeded first time.

## Clean-up (owner decision; nothing is automated)

- **Records:** every demo record has Demo Data ticked. The Jobs page has a "Demo data" tab, and the record IDs are in `lite/demo/cloud-resources.demo.json`.
- **Workflows:** unpublished, so they cannot run by themselves. They can be archived in n8n.
- **Interface and tables:** can stay, or be deleted by the owner.
