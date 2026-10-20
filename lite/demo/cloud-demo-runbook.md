# RoofOps Lite: cloud demo runbook

The real demonstration of all four Lite automations, against the existing Airtable base (`appMc8V0Wm29tEeHQ`) and
n8n Cloud, with synthetic data only. It repeats the local demo (`npx tsx lite/demo/run-demo.ts`, report in
`lite/demo/output/demo-report.md`) step for step, so every expected result below has already been produced once by
the same node code.

**Run on 2026-10-20, with the owner's approval. Every step passed first time, and the results matched this page.**
- Evidence: `evidence/lite-cloud-demo-20261020.md`.
- Resource and record IDs: `lite/demo/cloud-resources.demo.json`.
- The tables and records went in through the Airtable connector, following the same plan as the tools. No token was
  configured; see `lite/DEPLOY.md` step 3.

Messages go to the test sink only: each "send" is a row in Lite Message Log with Status `Simulated Sent`. No SMS or
email leaves n8n.

**Shared base:** in the RoofOps base, every Lite write also wakes `[RoofOps] 06 Airtable Changes → Postgres`, which
listens to the whole base. It ignores tables that aren't its own, so nothing changes, but each wake-up is one n8n
execution. Give a client its own base.

## What it touches, and what it does not

| Touches | Does not touch |
|---|---|
| 5 new tables in the base, all named `Lite …` | any existing (Advanced RoofOps) table, field or option |
| 40 synthetic records (12 contacts, 13 properties, 13 jobs, 2 quotes), names `ZZ Lite Demo …`, `Demo Data` ticked | Supabase, Xero, the dashboard |
| 4 new n8n workflows `[Lite] …`, **inactive** | workflows 01–10, their schedules and webhooks |

The workflows use the existing n8n Airtable credential (`3XbFnHjAd7mFvBD2`). No new credential is needed for the
demo.

## Before: checks (read-only)

```bash
npx vitest run test/lite.test.ts
```
```bash
npx tsx lite/airtable/setup.ts lite/config/demo.json
```
```bash
npx tsx lite/airtable/seed-demo.ts lite/config/demo.json
```

- The tests should pass.
- The setup dry run should list 5 tables to create and 0 existing.
- The seed dry run should show the record counts.

## 1. (cloud) Create the Lite tables

```bash
LITE_AIRTABLE_TOKEN=... npx tsx lite/airtable/setup.ts lite/config/demo.json --apply
```
```bash
LITE_AIRTABLE_TOKEN=... npx tsx lite/airtable/setup.ts lite/config/demo.json --verify
```

- Use a token scoped to this base only, with `schema.bases:read`, `schema.bases:write`, `data.records:read` and
  `data.records:write`. Pass it in the environment; never put it in a file or a commit.
- The tool is create-only. It stops before writing anything if a Lite table already exists.
- `--verify` must report every table and field as present, with the right types and options.

## 2. (cloud) Load the synthetic demo data

```bash
LITE_AIRTABLE_TOKEN=... npx tsx lite/airtable/seed-demo.ts lite/config/demo.json --apply
```

The tool writes contacts, then properties, then jobs, then quotes, and refuses if any Lite table already holds Demo
Data. Dates are relative to the moment of loading:
- finished jobs 1 to 10 days ago;
- quiet leads over 90 days old;
- one lead followed up recently (to show the cooldown).

So run steps 4 to 7 soon after.

## 3. (cloud) Create the four workflows in n8n, inactive

For each file in `lite/dist/demo/`, run `validate_workflow` and then `create_workflow_from_code` with the n8n MCP
tools. Or, in the n8n UI, use Workflows › Import from File on the `.json`.

| Workflow | File | Nodes | Validated by n8n Cloud |
|---|---|---|---|
| [Lite] Instant Lead Follow-Up | `lead-follow-up.sdk.ts` | 25 | full file, valid |
| [Lite] Google Review Requests | `review-requests.sdk.ts` | 14 | full file, valid |
| [Lite] Lead Reactivation | `lead-reactivation.sdk.ts` | 14 | structure valid (same parts as review) |
| [Lite] Inbound Replies | `inbound-replies.sdk.ts` | 17 | structure valid (Code bodies shortened) |

- Leave all four **unpublished**. Nothing runs on a schedule, and the production webhook URLs stay closed.
- Check that each Airtable node shows the credential "Roofops Airtable Personal Access Token account".
- Record the four workflow ids here: ______

## 4. Instant Lead Follow-Up (webhook)

Run each case with `execute_workflow` on the lead workflow: `triggerNodeName: "Lead Webhook"`, and
`inputs.webhookData.body` set to the JSON shown. Or open the workflow in the editor, click "Execute workflow", and
POST the JSON to the **test** URL `https://tejesh08.app.n8n.cloud/webhook-test/roofops-lite/lead`.

**4a. New lead.** Expect 200 with `duplicate: false`, `stage: "Contacted"` and acknowledgement `Simulated Sent` by SMS.

```json
{ "name": "ZZ Lite Demo Emma Walsh", "first_name": "Emma", "phone": "0400 000 201", "email": "emma.walsh@example.test",
  "suburb": "Bargara", "address": "7 Coral Demo Court", "postcode": "4670", "service": "roof leak repair",
  "message": "Water coming through the ceiling after last night's storm.", "source": "website",
  "consent_sms": true, "consent_email": true, "marketing_opt_in": false, "preferred_channel": "sms", "demo": true }
```

**4b. Same person again.** Send the same JSON with `"message": "Just checking you got this?"`. Expect 200 with
`duplicate: true` and the **same** `job_ref` as 4a. No new contact or job is created; the Message Log gets a `Skipped`
row ("repeat enquiry").

**4c. Invalid lead.** Expect 400, "an email address or phone number is required". Nothing is written.

```json
{ "name": "ZZ Lite Demo Nobody", "source": "Facebook", "demo": true }
```

**4d. No consent.** Expect 200, `stage: "New Lead"`, acknowledgement `Skipped` ("no consent or no reachable contact
detail").

```json
{ "name": "ZZ Lite Demo Ethan Cole", "first_name": "Ethan", "email": "ethan.cole@example.test",
  "service": "gutter clean", "source": "google", "demo": true }
```

## 5. Google Review Requests (scheduled; run by hand)

Run with `execute_workflow` and `triggerNodeName: "Run Now"`, or click "Execute workflow" on the Run Now trigger.

**First run.** The last node's output should match:

| Field | Expected |
|---|---|
| `finished_jobs` | 5 |
| `sent` | 2 (Olivia by SMS, Marcus by email) |
| `skipped` | 2 (Priya: opted out; Tom: no consent) |
| `not_due_yet` | 1 (Grace, finished 1 day ago) |
| `logged` | 4 |
| `jobs_updated` | 4 |

**Second run.** Expect `sent 0`, `logged 0`, `jobs_updated 0` and `not_due_yet 1`. Nobody is asked twice.

## 6. Lead Reactivation (scheduled; run by hand)

Run with `triggerNodeName: "Run Now"`.

**First run.** Expect:

| Field | Expected |
|---|---|
| `open_leads` | 8 |
| `sent` | 2 (Mia by email, Daniel by SMS) |
| `still_active` | 3 |
| `excluded` | 3: no marketing permission 1, opted out 1, cooldown 1 |

**Second run.** Expect `sent 0` and `excluded 5`, with cooldown 3.

These numbers assume step 4 ran first, as in the local run. Emma and Ethan count as open, recently active leads.

## 7. Inbound Replies (webhook)

Run with `triggerNodeName: "Reply Webhook"`. Test URL: `https://tejesh08.app.n8n.cloud/webhook-test/roofops-lite/reply`.

**7a. Daniel replies YES.** Expect 200 with `known_contact: true`, `opted_out: false` and `job_ref: "LJ-DEMO-A1"`.
His job's Last Activity moves to now, and the Message Log gets a `Received` row.

```json
{ "from": "0400 000 106", "text": "Yes please, call me this week", "demo": true }
```

**7b. Olivia replies STOP.** Expect 200 with `opted_out: true`. Her contact gets Opted Out ticked and Marketing
Opt-In cleared, and the Message Log gets an `Opt-Out` row.

```json
{ "from": "+61 400 000 101", "text": "STOP", "demo": true }
```

**7c. Reactivation once more.** Run step 6 again. Expect `sent 0` and `still_active 4` (Daniel is active again),
with opted out still 1.

## 7d. Quote-to-Paid (staff actions in Airtable)

On Emma's job from 4a, act as staff would:
1. Create a **Lite Quotes** record (Status Sent, Amount, linked to the job). Set the job's Stage to Quoted.
2. Set the quote to Accepted (Accepted At), and the Stage to Accepted.
3. Set the Stage to Job In Progress, then to Completed (set **Completed At**).
4. Set the Stage to Invoiced, with Invoice Status Invoiced and Invoice Amount.
5. Set the Stage to Paid, with Invoice Status Paid.

**Expect:**
- The Pipeline page shows the job in each stage as it moves.
- At Invoiced, the Overview "Owed" figure includes it.
- The job keeps its links to the contact, property, quote and messages.

No invoice is created anywhere.

## 8. Check the result in Airtable (read-only)

- **Lite Jobs by Stage** should match the "Pipeline after the run" table in `lite/demo/output/demo-report.md`.
  Generated job refs differ.
- **Lite Message Log** should have 11 rows:
  - Lead Follow-Up: 3 (1 sent, 2 skipped);
  - Review Request: 4 (2 sent, 2 skipped);
  - Reactivation: 2 sent;
  - Inbound Reply: 2 (Received, Opt-Out).

  Every row should have Provider `lite-test-sink`.
- **n8n:** every execution should be green, with no execution of 01–10 caused by these steps.

## If something does not match

- **Stop.** Do not re-run a webhook step blindly. Each run writes real rows, and a re-run of 4a is (correctly) a
  duplicate.
- An Airtable error fails the execution with the step name, for example `create job: Airtable HTTP 422 …`. The
  execution in n8n shows which node, and nothing after it ran.
- A missing field or option means the tables differ from `lite/airtable/schema.json`. Run `setup.ts --verify`.

## Clean-up (owner decision)

The demo data is easy to find: every record has `Demo Data` ticked and a `ZZ Lite Demo` name.
- **To keep the demo for showing staff:** leave it. The workflows stay inactive, so nothing changes by itself.
- **To remove it:** in each Lite table, filter on Demo Data and delete the records (Airtable keeps them in trash for
  7 days). Archive the four `[Lite]` workflows in n8n. The empty tables can stay, or be deleted by the owner.

None of this is automated. Deleting is the owner's call.

## Go-live is a separate decision

These are not part of the demo. See `lite/README.md` › "Blocked":
- a real SMS or email provider;
- webhook protection (`webhookAuth` in the config, then rebuild);
- the business's own Google review link;
- publishing the workflows.
