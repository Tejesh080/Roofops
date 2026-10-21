# RoofOps Lite: controlled live Twilio acceptance, plan (2026-10-21)

**Status: prepared, waiting for approval.** Nothing has been sent, published or scheduled. No Twilio setting has been
changed.

**Set up for the session:**
- **Code:** `c43d4d8`.
- **Cloud:** the five [Lite] workflows run the test-sink build, unpublished.
- **Live build:** `lite/dist/demo-twilio-live.local`, git-ignored, built from `c43d4d8`.
  - **Sending:** trial template `sms_appointment_reminders`, through the existing n8n Twilio credential.
  - **Reply webhook:** Basic Auth with the existing credential, saving no execution data.
  - **Receipts:** on.
  - **Allowlist:** exactly the number in `.env.local`. No operator phone.

**Pre-check (13:10 UTC, run 3514, not stored).** Your number has no contact, no message and no STOP row in Airtable.
The staged number was cleared again.

This file names no phone number, Account SID or secret.

## 1. STOP and resubscription with your trial sender (Twilio docs, read 2026-10-21)

**The sender.** A trial sends from a shared Twilio-owned trial number. Twilio assigns it per recipient, so Lite sends
no `From`. The body is a Twilio template; the text is Twilio's, not Lite's.

**Inbound.** Replies reach a webhook only through Console › Try out SMS › Receive an SMS › Auto-reply › Custom (one
webhook per account). They must come from a verified number in Australia.

**STOP at Twilio.**
- **How it works:** Twilio's default opt-out handling covers long codes and toll-free numbers. On a single-word STOP
  (or STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, …), Twilio:
  - adds a block-list entry for that sender and recipient;
  - replies "You have successfully been unsubscribed…";
  - still passes the message to the webhook.
- **After that:** a later send from that sender returns 21610.
- **Scope:** the block covers only the number the person replied to. With one sender, or a Messaging Service, that is
  every Lite message.
- **Undoing it:** START, YES or UNSTOP removes the block.
- **On a trial:** Twilio does not document whether this applies to shared trial numbers. Step S11 observes it: your
  phone shows Twilio's confirmation.

**STOP in Lite.**
- **Saved first:** the reply's Message Log row (Opt-Out, "from <number>") is saved before anything else, with one
  retry.
- **Checked before every send:** every send reads these rows just before sending. A send stops if the number is
  suppressed, or if the rows cannot be read.
- **Then the contacts:** they are opted out in batches.

**START in Lite.** Logged for staff only.

## 2. Resubscription: disabled; proposed alternative (not built)

**Disabled for the test and in Lite v1.**
- **What changed:** the docs (`compliance-au.md`, `employee-guide.md`, `DELIVERY-CHECKLIST.md`) no longer describe
  editing an Opt-Out row. A number that replied STOP stays suppressed. If the person asks again, the business contacts
  them outside Lite.
- **What still works:** in the current build, an edit to that row's Status would lift the suppression. Nothing tells
  staff to do it, and nobody does it in this test.

**Proposed, simplest safe alternative** (one formula and one comparison in the shared send step):
- **Who lifts it:** only the person. A START or UNSTOP from that same number, logged after their latest STOP. Twilio
  requires exactly that to lift its own block.
- **Plus consent:** staff record fresh consent on the contact, with a Consent Recorded At after that START.
- **Matching the STOP:** suppression would match the STOP row by its text as well as its status. A status edit would
  then change nothing.

## 3. If a STOP cannot be saved or verified

**In this test, automated marketing cannot run.**
- **Marketing workflows:** Review Requests and Lead Reactivation stay unpublished, and keep the test-sink build,
  which has no Twilio node. Even a manual run could not send a real SMS.
- **Monitor:** stays unpublished. It runs once, manually, and only before the STOP (S9).
- **Lead Follow-Up:** stays unpublished. It runs only from your single click.
- **Failing to save:** if Lite fails to save your STOP, the S11 check fails (no Opt-Out row) and the STOP is recorded
  by hand.

**At go-live, Lite alone cannot guarantee it.** If Airtable refuses both saves:
- **What happens:** the run fails. With the error workflow set, Monitor raises it; Twilio logs a failed webhook.
- **What still protects the number:** only the contact updates that succeeded, until someone acts.

**The backstop is Twilio's own STOP block on the sender.** It is documented for the client's own long code, and S11
shows whether it applies to your trial sender.

**Recommendation for the client release:**
- one sender number, or a Messaging Service;
- the error workflow set;
- Review Requests and Lead Reactivation published only after Twilio's STOP block has been seen on the client's
  number. Until then, run them manually.

## 4. Inbound authentication (the existing secure configuration)

**n8n side.**
- **The login:** n8n checks Basic Auth before the workflow starts, using the existing credential. Its id matches
  `LITE_REPLY_WEBHOOK_CREDENTIAL_ID`.
- **Execution data:** the workflow keeps none, because n8n would store the login header in it.
- **Already proven (earlier session, n8n 2.34.6, the real trial build):**

| Request | Answer |
|---|---|
| No login | 401 |
| Wrong login | 401 |
| Bearer | 401 |
| Right login, another Twilio account | 403 from Lite |

**Twilio side.**
- **The Setting:** a Webhook Setting with the login inline. It is write-only; Twilio never returns the password.
- **The Rule:** an `EXACT_MATCH` Rule for `https://tejesh08.app.n8n.cloud/webhook/roofops-lite/reply`. Twilio drops
  the query, so the Rule also covers receipts.
- **Nothing exposed:** no login appears in any URL, code or saved run.
- **Current state:** not created yet. The earlier setup was a dry run.

**Proved only in the session:**
- that Twilio sends the login (S4);
- that Twilio applies the Rule to receipts (S8) and to Try out SMS replies (S10). The last is not documented.

## 5. The session: what you approve, what you click, PASS and FAIL

**Approval covers:**
- one Twilio Setting and Rule;
- replacing **only** Lead Follow-Up, Inbound Replies and Monitor with the live build (still unpublished);
- publishing **Inbound Replies only**, for about 20 minutes;
- **one SMS**;
- optional S9.

**Cost:** 1 of the trial's free SMS (Twilio's STOP confirmation is free), and about 10 n8n executions.

| # | Who | Action | PASS | FAIL, then |
|---|---|---|---|---|
| S1 | me | Stage the login in the temporary table; run **Login Setup** (creates the Setting and Rule, then clears the login) | Both 2xx; Rule lists the reply URL; login row cleared | Stop; nothing published |
| S2 | me | Replace the 3 workflows with the live build; verify node for node | Identical (Lead Follow-Up keeps no manual runs); all unpublished | Stop; restore test-sink build |
| S3 | me | **Publish Inbound Replies.** Probe from outside | No login 401; wrong 401; Bearer 401; right login (foreign AccountSid) 403 | Unpublish at once |
| S4 | me | Run **Webhook Test** (Twilio → reply URL, no SMS) | 400 or 403: Twilio's login accepted, test payload refused by Lite | 401: unpublish, stop |
| S5 | **you** | Twilio Console › Messaging › **Try out SMS** › **Receive an SMS** › Auto-reply **Custom** › URL `https://tejesh08.app.n8n.cloud/webhook/roofops-lite/reply`, method **POST** › **Save** | "Webhook configured successfully" | Tell me |
| S6 | me | Pre-check (counts only) | 0 contacts, 0 messages, not opted out | Stop |
| S7 | me, then **you** | I pin the test lead ("ZZ Live Test", your number). You open **[Lite] Instant Lead Follow-Up** in n8n and click **Execute workflow** once | 1 outbound in Twilio's log; your phone gets Twilio's template text; Lite row **Sent** with a Message SID | 572002 = number not verified; anything but one outbound: stop |
| S8 | me | **Real receipt correlation** | Within ~2 minutes the same row becomes **Delivered**, with the same SID | Row stays Sent: receipts not authenticated (safe; noted, not a resend risk) |
| S9 | me (optional) | **Real retry safety, no SMS expected.** Only if S8 passed. I set the row to Failed by hand and tick Retry Requested; run Monitor once | Monitor asks Twilio by that SID; row "found at Twilio (delivered): not resent"; Twilio's log still has 1 outbound | Any new outbound: stop everything |
| S10 | **you** | Reply **Hello** | A **Received** row linked to ZZ Live Test within a minute | No row: Twilio's login not applied to Try out SMS replies (safe; inbound not provable on this trial) |
| S11 | **you** | Reply **STOP** | Your phone gets Twilio's unsubscribe confirmation. Lite saves an **Opt-Out** row ("from <number>") first, and the contact is **Opted Out** | No Opt-Out row: I record the STOP by hand; Twilio's block is then the only protection |
| S12 | me, and **you** | Clean up (section 7) | Inbound Replies unpublished; 3 workflows back on `c43d4d8` test sink and verified; table cleared; you set Auto-reply back to **Standard** | — |

**Overall PASS:**
- S1 to S8, S10 and S11 pass, and S9 too if it is run;
- Twilio's log shows exactly **one** outbound SMS from Lite.

**Not a FAIL:** Twilio's own STOP confirmation, which Twilio sends itself.

**After the STOP.** Twilio blocks trial SMS to your phone from that trial number. Reply START afterwards only if you
want more trial sends; Lite keeps the number suppressed either way.

## 6. Real evidence versus simulated tests

| Behaviour | Real Twilio evidence (this session) | Simulated (not Twilio evidence) |
|---|---|---|
| Receipt bound to the right message by its SID | S8 | Local fake Twilio tests |
| A retry never resends what Twilio delivered | S9 (Twilio asked by the real SID) | Local; cloud test sink 3510 |
| An Unknown or timed-out send is never resent, even if set Failed by hand | — | Local (SMS FIX 3, timeout tests); cloud test sink 3485 and 3510 |
| An early or unmatched receipt changes nothing and raises an alert | — | Local (release gate FIX 3) |
| Out-of-order receipts never downgrade | — | Local |
| Accepted message on Twilio's second history page is not resent | — | Local (SMS FIX 3) |
| Refused, then fixed: resent once | — | Local; cloud test sink 3510 |
| STOP saved first, and the number blocked for every send | S11 (saved first) | Local (11 contacts with a 503); cloud test sink 3493 and 3506 |
| Twilio's own STOP block | S11 (its confirmation on your phone) | — |

**No uncertain message is resent automatically.** Monitor resends only when Twilio refused the message when it was
sent, or reports it failed by its SID. In this session it runs only for S9, and only after S8 shows Delivered.

## 7. Trial limitations

- **Content:** Twilio sends its own template text (no business name, no STOP line), from a shared trial number Twilio
  picks.
- **Recipients:** only verified Australian numbers; any other answers 572002. 100 free SMS; 30 days.
- **Replies:** only through the Try out SMS Custom webhook, and only from the verified phone. Whether Twilio applies
  the Rule's login to them is undocumented (S10).
- **No Functions:** so no signature relay. The customer release needs the relay (upgraded account) or n8n Pro.
- **No Twilio Monitor API:** on a trial there is no API to read Twilio's error logs (20003). If S10 fails, look in
  Console › Monitor › Logs.
- **n8n Starter:** 7-day execution logs, and Inbound Replies saves none. The record is Airtable and Twilio's Console
  log.

## 8. Clean-up and rollback (S12)

**In this order:**
1. Unpublish Inbound Replies (right after S11).
2. Remove the pinned lead.
3. Replace the three workflows with `lite/dist/demo` at `c43d4d8`, and verify node for node. Backups of every earlier
   version are in `lite/dist/cloud-backup-20261021*.local/`.
4. Clear the temporary data table.
5. **You:** Try out SMS › Auto-reply › **Standard** › Save.

**Optional:**
- delete the Twilio Rule and Setting;
- delete the `ZZ Live Test` rows (they hold your number).
