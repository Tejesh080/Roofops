# RoofOps Lite: clean-up after the 21 Oct live test (2026-10-29)

Master plan Task 0.6, from the ordered list in
[lite-activation-investigation-20261022.md](lite-activation-investigation-20261022.md) §6. Approved by the owner in chat
on 29 Oct ("approve lite clean up"). No SMS was sent, no Twilio or Airtable setting was changed, and nothing was deleted.
Every result below was read back from n8n after the change.

**Result: no Lite workflow is published.** Items 2–4 could not be done as written (the versions they name no longer
exist). Items 5–8 are for the owner.

## State before (read 29 Oct)

| Workflow | Id | Active | Saved versions |
|---|---|---|---|
| [Lite] Inbound Replies | `3Jeal7RQAhUmgLZ3` | **yes**, active version `3009c821-2372-45e4-83dd-bc599e0326fa` (reply webhook requires Basic Auth) | 1 (2026-10-21 13:44Z) |
| [Lite] Instant Lead Follow-Up | `9BjHeFBUKqnmQqHl` | no | 1: `bfccbea4-7f2e-4db5-a813-65184fba60b7` (2026-10-21 13:44Z) |
| [Lite] Monitor | `Tmk4lj7VrbHix9A9` | no | 1: `e7ec9940-6fb0-4ae5-9d0a-971ad21d9b1d` (2026-10-21 13:44Z) |
| [Lite] Google Review Requests, Lead Reactivation | `WzFUcqFQnpEh309s`, `FYc1hpB9RAcwg2SH` | no | not changed |
| Five Twilio helper workflows (item 9) | below | no | not read |

## Items

| # | Item | Done | Read back |
|---|---|---|---|
| 1 | Unpublish Inbound Replies | **Yes** | `active: false`, `activeVersionId: null`; the draft is still `3009c821` |
| 2 | Restore `cd14b31d-…` on Instant Lead Follow-Up | **Not possible** | Its history now holds one version (`bfccbea4`); `cd14b31d` has aged out of n8n's version history |
| 3 | Restore `ab0f14c6-…` on Monitor | **Not possible** | Same: one version (`e7ec9940`) |
| 4 | Restore `49aeb37c-…` on Inbound Replies | **Not possible** | Same: one version (`3009c821`) |
| 5 | Remove the pinned S7 test lead from Instant Lead Follow-Up | **Owner** | The read tool does not return pin data (`pinData` absent from the response), and no tool removes it. In the n8n editor: open the workflow, unpin the pinned node data, save |
| 6 | Twilio Console: Try out SMS › Auto-reply › Standard › Save | **Owner** | — |
| 7 | Delete the Twilio Webhook Rule (`EXACT_MATCH`, reply URL) and its Webhook Setting | **Owner** | — |
| 8 | Clear the Login Setup data table (`y28wzAvfOC2U7fwI`, id unverified) | **Owner** | A permanent deletion of rows; the agent does not do it, and the tools have no row delete |
| 9 | Archive the five Twilio helper workflows | **Yes** | Archived: `HWJdTkYMLBFXE5bn` Twilio Account SID, `0h3YTk1ewoemNQCq` Twilio Webhook Login Setup, `CRYdGYERCuVGcaEs` Twilio Webhook Test, `ikWTxNSgiH3u1TWr` Live Test Pre-check, `VcTE56qoxldxCeDt` Twilio Account Check. All were inactive; none is listed any more. Archived workflows can be restored from n8n's archive |
| 10 | Keep `rec4IUGCUBSSiBd4N` as evidence | Kept | Not touched |

## What remains true

- The three drafts (Instant Lead Follow-Up, Monitor, Inbound Replies) still hold the **live one-recipient build** of
  21 Oct: the Lead Follow-Up draft calls `api.twilio.com` with `allowAllRecipients: false`. Their descriptions still say
  "test sink", which is wrong. All three are unpublished, and the Twilio account is still a trial, which only sends to
  the one verified phone.
- They are replaced when Lite is rebuilt into its own Airtable base (master plan Task L3), from `lite/dist/`.
  Rebuilding them earlier, or correcting the descriptions now, is a separate change that needs its own approval.
- Lesson: n8n Cloud keeps workflow history only for a short time on this plan. A clean-up that depends on restoring a
  version has to run within days, or the version to restore must be in git (it is: `lite/dist/demo/*.json`).
