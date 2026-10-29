# Airtable ping signatures: rollout checklist (ADR-041, master plan Task 1.5)

Every 🔒 step needs the owner's approval in chat, at that time. Read-only checks need none. Hosted commands take
`--confirm <project-ref>` (Task 0.1).

## Before

- [ ] Fresh backup: `npm run backup:hosted`.
- [ ] `npm run integrity:check` (0 FAIL) and `npm run security:check` (all pass).
- [ ] Record the current n8n `versionId` of 00, 01, 04, 06 and 07. These are the rollback versions.

## Steps

1. [ ] 🔒 **Migration:** `npm run db:load -- --hosted --confirm <ref>`.
   - It applies exactly `20261029120000_airtable_ping_mac.sql`.
   - `npm run security:check` then shows the two new checks passing, and the mode `log`.
2. [ ] 🔒 **n8n settings, 00 and 07:** Save successful production executions = **Do not save**. The create response's MAC secret
   then never sits in n8n's execution history (it goes only to Postgres).
3. [ ] 🔒 **Publish, in this order:**
   1. 01, 04 and 06. They call `wf_airtable_ping_cursor`, which exists after step 1.
   2. 07. Its wake pings stay unsigned until secrets exist; that is harmless in `log` mode.
   3. 00.

   Each must match its file node for node.
4. [ ] **Watch `log` mode for a day** (read-only). Expect `NO_SECRET` for all three webhooks, and real edits still applying:
   `npx tsx scripts/sql.ts --read-only "select webhook_id, verdict, count(*) from airtable_ping_checks where checked_at > now() - interval '1 day' group by 1, 2 order by 1, 2"`
5. [ ] 🔒 **Re-create each webhook, one at a time:** `changes`, then `quote-events`, then `project-invoice-events`. For each:
   1. **Read-only:** its unread payloads are 0. Check `v_reconciliation_latest.summary -> 'webhooks'`, or System Health › Webhooks. If they are not 0, wait for the next reconciliation.
   2. 🔒 **Delete it.** `DELETE https://api.airtable.com/v0/bases/appMc8V0Wm29tEeHQ/webhooks/<id>`, using the Airtable token the n8n credential uses (the owner runs it).
   3. 🔒 **Re-create it.**
      - `changes`: `npm run reconcile -- --dry-run --confirm <ref>`. 07's webhook upkeep runs even in a dry run.
      - The other two: run 00 (Run Setup Now).
   4. **Read-only:** `select webhook_id, notification_url, created_at from integration_webhook_secrets`. It should show the new id for that URL.
   5. **Read-only:** make one real Airtable edit of that kind. Its ping is recorded `VALID` for the new id, and the edit applies.

   A new webhook starts at cursor 1. Anything missed while it was deleted is repaired or reported by the nightly reconciliation.
6. [ ] 🔒 **Enforce**, once all three have logged `VALID` for a day:
   `npx tsx scripts/sql.ts --confirm <ref> "update app_settings set value = 'enforce', updated_at = now() where key = 'airtable.ping_mac'"`
7. [ ] 🔒 **Proof:**
   - **Forged ping:** POST one forged ping to the `changes` webhook (a wrong `X-Airtable-Content-MAC`).
     - Its row says `MAC_MISMATCH`, `accepted = false`.
     - The n8n execution ends at `Ping Verified?` with no Airtable call.
   - **Real edit:** one real Airtable edit still applies.
   - **Record:** write it up in `evidence/airtable-ping-mac-<date>.md`. In the ledger, INT-03 → **FIXED**.

## Rollback

- **First lever, no deploy:** set the mode back to `log`.
  `npx tsx scripts/sql.ts --confirm <ref> "update app_settings set value = 'log' where key = 'airtable.ping_mac'"`
- **Full rollback:**
  1. Restore the five n8n versions recorded under "Before".
  2. Run `ops/rollback/20261029120000_airtable_ping_mac.down.sql`.

  The stored secrets go with the table. Re-applying later needs the webhooks re-created again.
