/**
 * ADR-041 (master plan Task 1.5): Airtable pings are verified inside Postgres.
 *  - wf_airtable_webhook_created stores the MAC secret Airtable returns once, at creation; no role can read it back.
 *  - wf_airtable_ping_cursor checks X-Airtable-Content-MAC (HMAC-SHA256 over the JSON body, keyed with that secret)
 *    and records a verdict for every ping. In log mode every ping proceeds; in enforce mode only a verified one gets
 *    its payload cursor (null otherwise, and the workflow stops before calling Airtable).
 *  - wf_airtable_sign_ping signs 07's own wake pings, only for a ping of that webhook.
 * The expected values are computed the way Airtable documents it (Node's createHmac over the JSON text).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { TARGETS, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const BASE = 'appMc8V0Wm29tEeHQ';
const HOOK = 'achPINGMACTEST001';
const NEXT = 'achPINGMACTEST002';
const UNKNOWN = 'achPINGMACNOSECRT';
const CHANGES = 'https://tejesh08.app.n8n.cloud/webhook/roofops/airtable/changes';
const SECRET = randomBytes(32).toString('base64');
const SECRET2 = randomBytes(32).toString('base64');
const ping = (hook: string, timestamp = '2026-10-29T03:00:00.000Z') => JSON.stringify({ base: { id: BASE }, webhook: { id: hook }, timestamp });
/** Airtable's documented computation (developers/web/api/webhooks-overview). */
const mac = (secret: string, text: string) => `hmac-sha256=${createHmac('sha256', Buffer.from(secret, 'base64')).update(text, 'ascii').digest('hex')}`;

describe.each(TARGETS)('Airtable ping authenticity (%s)', (target) => {
  let db: Db;
  beforeAll(async () => { db = await migratedDb(target); });
  afterAll(async () => { await db.close(); });
  const one = async <T = R>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params))[0]!;
  const created = async (id: string | null, url: string, secret: string | null) =>
    (await one<{ r: R }>(`select wf_airtable_webhook_created($1, $2, $3) r`, [id, url, secret])).r;
  const cursor = async (id: string, body: string, m: string | null) =>
    (await one<{ c: string | null }>(`select wf_airtable_ping_cursor($1, $2, $3)::text c`, [id, body, m])).c;
  const last = () => one<{ webhook_id: string; verdict: string; mode: string; accepted: boolean }>(
    `select webhook_id, verdict, mode, accepted from airtable_ping_checks order by id desc limit 1`);
  const mode = (m: string) => db.query(`update app_settings set value = $1 where key = 'airtable.ping_mac'`, [m]);

  it('the migration starts in log mode', async () => {
    expect(await one(`select value from app_settings where key = 'airtable.ping_mac'`)).toEqual({ value: 'log' });
  });

  it('stores the secret at creation and returns only that it did; the audit row names the webhook, never the secret', async () => {
    const r = await created(HOOK, CHANGES, SECRET);
    expect(r).toEqual({ stored: true, webhook_id: HOOK });
    expect(await one(`select count(*)::int n from integration_webhook_secrets where webhook_id = $1`, [HOOK])).toEqual({ n: 1 });
    const audit = await one<{ action: string; business_reference: string; after_state: R }>(
      `select action, business_reference, after_state from audit_events where action = 'integration.webhook_secret_stored' order by seq desc limit 1`);
    expect(audit).toMatchObject({ business_reference: HOOK, after_state: { notification_url: CHANGES } });
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  it('a create that failed (no webhook id) stores nothing', async () => {
    expect(await created(null, CHANGES, null)).toEqual({ stored: false, reason: 'NO_WEBHOOK' });
  });

  it('refuses a notification URL RoofOps does not expect, and a secret that is not base64 or too short', async () => {
    await expect(created(NEXT, 'https://evil.example/webhook', SECRET)).rejects.toThrow(/unexpected Airtable notification URL/);
    await expect(created(NEXT, CHANGES, 'not base64!!')).rejects.toThrow(/invalid Airtable MAC secret/);
    await expect(created(NEXT, CHANGES, Buffer.from('short').toString('base64'))).rejects.toThrow(/invalid Airtable MAC secret/);
  });

  it('a webhook re-created for the same URL replaces the old secret (one per URL)', async () => {
    await created(NEXT, CHANGES, SECRET2);
    expect(await db.query(`select webhook_id from integration_webhook_secrets where notification_url = $1`, [CHANGES])).toEqual([{ webhook_id: NEXT }]);
    await created(HOOK, CHANGES, SECRET);                                              // back to HOOK for the rest
    expect(await db.query(`select webhook_id from integration_webhook_secrets where notification_url = $1`, [CHANGES])).toEqual([{ webhook_id: HOOK }]);
  });

  it('a correctly signed ping returns the stored cursor and is recorded VALID', async () => {
    await db.query(`select wf_airtable_cursor_advance($1, 7)`, [HOOK]);
    expect(await cursor(HOOK, ping(HOOK), mac(SECRET, ping(HOOK)))).toBe('7');
    expect(await last()).toEqual({ webhook_id: HOOK, verdict: 'VALID', mode: 'log', accepted: true });
  });

  it('log mode: a wrong, missing or unknown-webhook signature is recorded and the ping still proceeds', async () => {
    await mode('log');
    expect(await cursor(HOOK, ping(HOOK), mac(SECRET2, ping(HOOK)))).toBe('7');
    expect(await last()).toMatchObject({ verdict: 'MAC_MISMATCH', accepted: true });
    expect(await cursor(HOOK, ping(HOOK), null)).toBe('7');
    expect(await last()).toMatchObject({ verdict: 'MAC_MISSING', accepted: true });
    expect(await cursor(UNKNOWN, ping(UNKNOWN), mac(SECRET, ping(UNKNOWN)))).toBe('1');
    expect(await last()).toMatchObject({ webhook_id: UNKNOWN, verdict: 'NO_SECRET', accepted: true });
  });

  it('enforce mode: anything but a valid signature gets no cursor', async () => {
    await mode('enforce');
    expect(await cursor(HOOK, ping(HOOK), mac(SECRET2, ping(HOOK)))).toBeNull();
    expect(await last()).toEqual({ webhook_id: HOOK, verdict: 'MAC_MISMATCH', mode: 'enforce', accepted: false });
    expect(await cursor(HOOK, ping(HOOK), '')).toBeNull();
    expect(await last()).toMatchObject({ verdict: 'MAC_MISSING', accepted: false });
    expect(await cursor(UNKNOWN, ping(UNKNOWN), mac(SECRET, ping(UNKNOWN)))).toBeNull();
    expect(await last()).toMatchObject({ verdict: 'NO_SECRET', accepted: false });
    expect(await cursor(HOOK, ping(HOOK), mac(SECRET, ping(HOOK)))).toBe('7');
    expect(await last()).toMatchObject({ verdict: 'VALID', mode: 'enforce', accepted: true });
  });

  it('the signature covers the exact body: a valid MAC replayed on a changed body is refused', async () => {
    await mode('enforce');
    expect(await cursor(HOOK, ping(HOOK, '2026-10-29T04:00:00.000Z'), mac(SECRET, ping(HOOK)))).toBeNull();
    expect(await last()).toMatchObject({ verdict: 'MAC_MISMATCH' });
  });

  it('an unrecognised mode setting fails closed (enforce)', async () => {
    await mode('off');
    expect(await cursor(HOOK, ping(HOOK), null)).toBeNull();
    expect(await last()).toMatchObject({ verdict: 'MAC_MISSING', mode: 'enforce', accepted: false });
    await mode('log');
  });

  it('a malformed webhook id is an error, not a verdict', async () => {
    await expect(cursor('not-a-hook', ping('x'), null)).rejects.toThrow(/invalid Airtable webhook id/);
  });

  it("signs 07's wake ping exactly as Airtable signs, only for a ping of that webhook", async () => {
    const sign = async (id: string, body: string) => (await one<{ s: string | null }>(`select wf_airtable_sign_ping($1, $2) s`, [id, body])).s;
    expect(await sign(HOOK, ping(HOOK))).toBe(mac(SECRET, ping(HOOK)));
    await expect(sign(HOOK, ping(NEXT))).rejects.toThrow(/not a ping for achPINGMACTEST001/);
    await expect(sign(HOOK, 'not json')).rejects.toThrow(/not a ping for achPINGMACTEST001/);
    expect(await sign(UNKNOWN, ping(UNKNOWN))).toBeNull();
  });

  it('no app role can read a secret or the verdicts; only the workflow role runs the three functions', async () => {
    for (const role of ['roofops_workflow', 'roofops_dashboard']) {
      for (const t of ['integration_webhook_secrets', 'airtable_ping_checks']) {
        expect(await one(`select has_table_privilege($1, $2, 'select') or has_table_privilege($1, $2, 'insert') p`, [role, t])).toEqual({ p: false });
      }
    }
    for (const fn of ['wf_airtable_webhook_created(text, text, text)', 'wf_airtable_ping_cursor(text, text, text)', 'wf_airtable_sign_ping(text, text)']) {
      expect(await one(`select has_function_privilege('roofops_workflow', $1, 'execute') w, has_function_privilege('roofops_dashboard', $1, 'execute') d`, [fn]))
        .toEqual({ w: true, d: false });
    }
  });

  it('verdicts are kept for 7 days', async () => {
    await db.query(`insert into airtable_ping_checks (webhook_id, verdict, mode, accepted, checked_at) values ($1, 'VALID', 'log', true, now() - interval '8 days')`, [HOOK]);
    await cursor(HOOK, ping(HOOK), mac(SECRET, ping(HOOK)));
    expect(await one(`select count(*)::int n from airtable_ping_checks where checked_at < now() - interval '7 days'`)).toEqual({ n: 0 });
  });

  it('System Health counts the pings of the last 24 hours and the unverified ones', async () => {
    const want = await one<{ events: number; problems: number }>(`select count(*)::int events, (count(*) filter (where verdict <> 'VALID'))::int problems
      from airtable_ping_checks where checked_at > now() - interval '24 hours'`);
    expect(await one(`select events_24h, problems_24h from v_integration_activity where channel = 'airtable-pings'`))
      .toEqual({ events_24h: want.events, problems_24h: want.problems });
    expect(want.problems).toBeGreaterThan(0);
  });
});
