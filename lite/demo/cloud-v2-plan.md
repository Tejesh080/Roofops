# RoofOps Lite v2: cloud upgrade plan for the demo base (A, B and C done; D awaiting approval)

This plan moves the cloud demo from Lite v1 (verified 2026-10-20, `evidence/lite-cloud-demo-20261020.md`) to v2:
consent evidence, the send pipeline, Twilio (off by default), delivery receipts, and Monitor.

It is split into batches so that each can be approved on its own. No step touches Advanced RoofOps tables, workflows
01–10, Supabase or Xero.

| Batch | Status |
|---|---|
| A, B | Approved 2026-10-21 |
| A | **Done** 2026-10-21 (`evidence/lite-v2-batch-a-20261021.md`). The four Status options were added through the API, using one labelled setup row, instead of by hand. |
| B | **Done** 2026-10-21 (`evidence/lite-v2-batch-b-20261021.md`). Five v2 workflows unpublished; tests A, C, D, E, F and G passed on the test sink; v1 archived. One Monitor defect was found and fixed. The error workflow is set at go-live, because n8n needs Monitor published first. |
| C | **Done** 2026-10-21, adapted to what exists: a Twilio trial and n8n Starter (`evidence/lite-twilio-starter-20261021.md`). The five workflows run in Twilio trial mode, all unpublished. Every test reached the real Twilio API with no SMS sent. |
| D | **Prepared** 2026-10-21 (`evidence/lite-live-test-prep-20261021.md`). The login reaches Twilio through a Webhook Rule (no credentials in URLs). Inbound Replies saves no execution data, and one-shot helpers are ready. Waiting for the recipient in `.env.local` and the owner's approval. |

## Batch A: Airtable additions (no messages, additive only)

Base `appMc8V0Wm29tEeHQ`. Equivalent to `setup.ts --upgrade`. No existing field or record is changed.

| Table | Add |
|---|---|
| Lite Contacts `tble7dgq0tl1vvoWs` | `Review Opt-In` (checkbox), `Consent Source` (single line text), `Consent Recorded At` (date/time), `Consent Wording` (long text) |
| Lite Message Log `tblW8Uq5j5dW0B8RH` | `Purpose` (single select: Operational, Review, Marketing, Inbound), `Provider Message ID` (text), `Error Code` (text), `Attempts` (number), `Retry Requested` (checkbox), `Retry Of` (text), `On Success` (long text) |
| **new** Lite Alerts | Alert Ref, Kind (Workflow Failed / Delivery Failed / Delivery Unknown / Stuck Lead / Incomplete Job), Status (Open / Resolved), Detail, Workflow, Execution, Record Ref, Dedupe Key, Raised At, Demo Data |

**By hand in Airtable (the API cannot add select options):** in Lite Message Log › Status, add **Sending, Sent,
Delivered, Unknown**. That takes about 1 minute; `setup.ts --verify` then confirms it.

**Existing records are left as they are:**
- **The 14 Lite contacts in the base get no consent evidence.** v2 will therefore not send them review requests or
  reactivation ("consent not recorded"). That is the intended behaviour.
- **v2 positive tests use new synthetic people with recorded consent**, all `ZZ Lite Demo v2 …` with Demo Data ticked:
  - 1 finished-job customer with Review Opt-In;
  - 1 quiet lead with Marketing Opt-In;
  - 1 imported-style contact with a box ticked but no record.

  That is about 3 contacts, 3 properties and 3 jobs.

**Interface `pbdAzDJhyiIb7CFZJ`:**
- add an **Alerts** page;
- add a **Needs attention** tab on Message Log and a **Consent not recorded** tab on Contacts;
- add an **Open alerts** number on Overview;
- republish.

## Batch B: n8n workflows (unpublished, test sink)

- **Create** the five v2 workflows from `lite/dist/demo/*.sdk.ts`, unpublished, in the Roofops project. Set the
  timezone to Australia/Brisbane, and Monitor as the error workflow of the other four.
  - **Found when doing it:** n8n refuses an error workflow that has no published version, so this waits for go-live
    (`lite/DEPLOY.md` step 8).
- **Archive** the four v1 Lite workflows (`6GlAPXRMVAEyK9pV`, `LdPy36pX3jKJxd2r`, `ECE108TYrOoHsTQh`,
  `vc4DEkcDxXnEdLmr`) once v2 passes. Archiving is reversible.
- **Run the cloud acceptance tests as manual executions** (the runbook, extended):

  | Test | What it checks |
  |---|---|
  | **A** | A new lead creates the CRM records, with consent evidence. |
  | **C** | A duplicate gives no second message; a pre-reserved Dedupe Key wins the race. |
  | **D** | The v2 customer gets one review request; contacts without a record get none. |
  | **E** | The v2 quiet lead gets one follow-up; the imported-style contact gets none. |
  | **F** | A STOP reply (JSON in test-sink mode) leads to no later messages. |
  | **G** | Monitor raises alerts, and Retry Requested resends once (simulated). |

  Every run uses the test sink, so no SMS is sent.
- **One gap:** the **Error Trigger** cannot be shown in the cloud while the workflows are unpublished, because n8n runs
  error workflows only for production executions. It is verified locally (test G), and in the cloud at go-live.

### Batch B by hand, if the n8n connector stays disconnected

In n8n (tejesh08.app.n8n.cloud), project Roofops:
1. **Import Monitor:** Workflows › Import from File › `lite/dist/demo/monitor.json`. Leave it unpublished.
2. **Import the other four:** `lead-follow-up.json`, `review-requests.json`, `lead-reactivation.json` and
   `inbound-replies.json`, all unpublished. The **Error workflow** setting needs Monitor published, so it is set at
   go-live.
3. **Check:** each Airtable node shows "Roofops Airtable Personal Access Token account".
4. **Hand back:** reconnect the connector, or tell me the five ids. I then run the acceptance tests as manual
   executions (test sink: no SMS).

## Batch C: Twilio without real SMS (done 2026-10-21)

**What was done instead of the plan below.** The owner already had n8n's **Twilio API** credential (Account SID + Auth
Token) and n8n **Starter**, which has no Variables.
- **Lite now accepts both.** It has `credentialType: "twilioApi"`, `inboundAuth: "basic-auth"` (n8n Webhook Basic Auth),
  and `trialTemplate` for Twilio's new trial.
- **No SMS was sent.** The real API refused each send, because the number was not a verified recipient (code 572002).
- **The relay for the customer release:** `lite/twilio/reply-relay.js`, behind `inboundAuth: "header-auth"`.

The original plan, kept for reference:


1. **You** create a Twilio API key, then an n8n **Basic Auth** credential with it (SID as user, secret as password).
   Never paste the secret into chat.
2. For signature checks, **you** add the n8n Variable `LITE_TWILIO_AUTH_TOKEN`; this needs n8n Cloud Pro or
   Enterprise. On other plans, use `inboundAuth: "basic-auth"` with a second Basic Auth credential.
3. **Optional, recommended:** do the same with Twilio **test credentials** and `from: "+15005550006"`. That proves the
   real Twilio API path (create message, error codes) with no message sent and nothing charged.

## Batch D: first real SMS (needs your explicit approval of sender, recipient and test)

Follow `lite/DEPLOY.md` step 7, exactly one recipient at a time. The exact approval list for the trial is in
`evidence/lite-twilio-starter-20261021.md`, "What to approve".
- `allowedRecipients: ["+614… your verified phone"]`;
- a Twilio template (`trialTemplate`);
- only Inbound Replies published, with Basic Auth, and only so Twilio can post replies;
- one lead, then one reply and one STOP.

Acceptance tests **B** (one real SMS) and **F** (a real STOP) become **live-verified** here.

## Rollback

| Batch | How to undo |
|---|---|
| A | The new fields and table can be hidden or deleted by the owner; existing data is untouched. |
| B | Restore the archived v1 workflows, and archive v2. |
| C | Rebuild from `lite/config/demo.json` (test sink) and replace the five workflows. Archive the two `[Lite] Twilio Account …` check workflows, and delete the data table `Lite Twilio Account Facts`. |
| D | Unpublish Inbound Replies. Clear the Try out SMS webhook. Delete any Webhook Rule, Setting and AuthProfile. Reset the allowlist to the fictional numbers. |
