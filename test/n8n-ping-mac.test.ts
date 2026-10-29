/**
 * ADR-041, the n8n side: the REAL node code of 00, 01, 04, 06 and 07, loaded through the recorder and run against a
 * migrated database (the signature is checked in Postgres, never in n8n).
 *  - 01, 04, 06: a correctly signed ping is fetched from the stored cursor; a forged one is fetched in log mode (and
 *    recorded) and stopped before any Airtable call in enforce mode.
 *  - 07: its wake ping is signed by Postgres and passes 06's own check; the create response's MAC secret goes to
 *    Postgres and nowhere else, and a failed create stores nothing.
 *  - 00: both create paths store their webhook's secret.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { TARGETS, migratedDb } from './helpers/db.js';
import { recorded } from './helpers/n8n-sdk-shim.js';
import { N8nRun, type HttpRequest, type Item } from './helpers/n8n-runner.js';

const BASE = 'appMc8V0Wm29tEeHQ';
const N8N = 'https://tejesh08.app.n8n.cloud/webhook/roofops/airtable/';
const loaded = new Map<string, Promise<{ nodes: typeof recorded.nodes; edges: typeof recorded.edges }>>();
const load = (file: string) => {
  if (!loaded.has(file)) loaded.set(file, (async () => {
    recorded.nodes.clear(); recorded.edges.length = 0;
    await import(/* @vite-ignore */ file);                                           // a variable: typecheck does not follow it into n8n's SDK
    return { nodes: new Map(recorded.nodes), edges: [...recorded.edges] };
  })());
  return loaded.get(file)!;
};
const mac = (secret: string, text: string) => `hmac-sha256=${createHmac('sha256', Buffer.from(secret, 'base64')).update(text, 'ascii').digest('hex')}`;
const pingBody = (hook: string) => ({ base: { id: BASE }, webhook: { id: hook }, timestamp: '2026-10-29T05:00:00.000Z' });

const CONSUMERS = [
  { wf: '01', file: '../n8n/01-quote-accepted-to-project.sdk.ts', hook: 'achPINGMACWF01AAA', url: `${N8N}quote-events`, next: 'Extract Acceptance Events' },
  { wf: '04', file: '../n8n/04-approved-project-to-xero-draft-invoice.sdk.ts', hook: 'achPINGMACWF04AAA', url: `${N8N}project-invoice-events`, next: 'Extract Invoice Actions' },
  { wf: '06', file: '../n8n/06-airtable-changes.sdk.ts', hook: 'achPINGMACWF06AAA', url: `${N8N}changes`, next: 'Extract Record Changes' },
] as const;

describe.each(TARGETS)('n8n and the ping signature (%s)', (target) => {
  let db: Db;
  const secrets = new Map<string, string>();
  beforeAll(async () => {
    db = await migratedDb(target);
    for (const c of CONSUMERS) {
      const s = randomBytes(32).toString('base64');
      secrets.set(c.hook, s);
      await db.query(`select wf_airtable_webhook_created($1, $2, $3)`, [c.hook, c.url, s]);
      await db.query(`select wf_airtable_cursor_advance($1, 5)`, [c.hook]);
    }
  });
  afterAll(async () => { await db.close(); });
  const mode = (m: 'log' | 'enforce') => db.query(`update app_settings set value = $1 where key = 'airtable.ping_mac'`, [m]);
  const lastVerdict = async () => (await db.query<{ webhook_id: string; verdict: string; accepted: boolean }>(
    `select webhook_id, verdict, accepted from airtable_ping_checks order by id desc limit 1`))[0];

  /** Runs a consumer from its ping; returns the Airtable payload requests it made (stopped right after). */
  const deliver = async (c: (typeof CONSUMERS)[number], ping: Item) => {
    const wf = await load(c.file);
    const fetched: HttpRequest[] = [];
    const r = new N8nRun(wf.nodes, wf.edges, { db, http: (req) => { fetched.push(req); throw new Error('captured'); } });
    await r.run('Validate Ping', [ping], [c.next]).catch((e: unknown) => { if ((e as Error).message !== 'captured') throw e; });
    return { fetched, r };
  };

  describe.each(CONSUMERS)('$wf', (c) => {
    const signed = () => ({ json: { headers: { 'x-airtable-content-mac': mac(secrets.get(c.hook)!, JSON.stringify(pingBody(c.hook))) }, body: pingBody(c.hook) } });
    const forged = () => ({ json: { headers: { 'x-airtable-content-mac': mac(randomBytes(32).toString('base64'), JSON.stringify(pingBody(c.hook))) }, body: pingBody(c.hook) } });

    it('enforce: a correctly signed ping is fetched from the stored cursor', async () => {
      await mode('enforce');
      const { fetched } = await deliver(c, signed());
      expect(fetched).toHaveLength(1);
      expect(fetched[0]!.url).toContain(`/webhooks/${c.hook}/payloads`);
      expect(fetched[0]!.query.cursor).toBe('5');
      expect(await lastVerdict()).toEqual({ webhook_id: c.hook, verdict: 'VALID', accepted: true });
    });

    it('enforce: a forged or unsigned ping is stopped before any Airtable call', async () => {
      await mode('enforce');
      const bad = await deliver(c, forged());
      expect(bad.fetched).toEqual([]);
      expect(bad.r.executed).toEqual(['Validate Ping', 'Load Payload Cursor', 'Ping Verified?']);
      expect(await lastVerdict()).toEqual({ webhook_id: c.hook, verdict: 'MAC_MISMATCH', accepted: false });
      const unsigned = await deliver(c, { json: { body: pingBody(c.hook) } });
      expect(unsigned.fetched).toEqual([]);
      expect(await lastVerdict()).toMatchObject({ verdict: 'MAC_MISSING', accepted: false });
    });

    it('log: a forged ping is recorded and still proceeds (the rollout stage)', async () => {
      await mode('log');
      const { fetched } = await deliver(c, forged());
      expect(fetched).toHaveLength(1);
      expect(await lastVerdict()).toEqual({ webhook_id: c.hook, verdict: 'MAC_MISMATCH', accepted: true });
    });
  });

  it("07's wake ping is signed by Postgres and passes 06's check in enforce mode", async () => {
    await mode('enforce');
    const hook = CONSUMERS[2].hook;
    const wf07 = await load('../n8n/07-reconcile.sdk.ts');
    const sent: HttpRequest[] = [];
    const r = new N8nRun(wf07.nodes, wf07.edges, { db, http: (req) => { sent.push(req); return { statusCode: 200, body: {} }; } });
    await r.run('Build Wake Ping', [{ json: { kind: 'drain', id: hook, url: `${N8N}changes` } }], ['Check Maintenance Result']);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${N8N}changes`);
    const header = sent[0]!.headers['X-Airtable-Content-MAC']!;
    expect(header).toBe(mac(secrets.get(hook)!, JSON.stringify(sent[0]!.body)));
    const { fetched } = await deliver(CONSUMERS[2], { json: { headers: { 'x-airtable-content-mac': header }, body: sent[0]!.body } });
    expect(fetched).toHaveLength(1);
    expect(await lastVerdict()).toEqual({ webhook_id: hook, verdict: 'VALID', accepted: true });
  });

  it("07's create: the secret goes to Postgres and no further; a failed create stores nothing", async () => {
    const wf07 = await load('../n8n/07-reconcile.sdk.ts');
    const secret = randomBytes(32).toString('base64');
    const r = new N8nRun(wf07.nodes, wf07.edges, { db, http: () => { throw new Error('no HTTP expected'); } });
    await r.run('Store Webhook Secret', [{ json: { statusCode: 200, body: { id: 'achPINGMACWF07NEW', macSecretBase64: secret, expirationTime: '2026-11-05T00:00:00.000Z' } } }],
      ['Check Maintenance Result']);
    const out = r.out.get('Store Webhook Secret')!;
    expect(out).toEqual([{ json: { statusCode: 200, s: { stored: true, webhook_id: 'achPINGMACWF07NEW' } } }]);
    expect(JSON.stringify(out)).not.toContain(secret);
    const body = JSON.stringify(pingBody('achPINGMACWF07NEW'));
    expect((await db.query<{ s: string }>(`select wf_airtable_sign_ping($1, $2) s`, ['achPINGMACWF07NEW', body]))[0]!.s).toBe(mac(secret, body));

    const failed = new N8nRun(wf07.nodes, wf07.edges, { db, http: () => { throw new Error('no HTTP expected'); } });
    await failed.run('Store Webhook Secret', [{ json: { statusCode: 422, body: { error: { type: 'INVALID_REQUEST' } } } }], ['Check Maintenance Result']);
    expect(failed.out.get('Store Webhook Secret')).toEqual([{ json: { statusCode: 422, s: { stored: false, reason: 'NO_WEBHOOK' } } }]);
  });

  it("00's two create paths store their webhook's secret for their own notification URL", async () => {
    const wf00 = await load('../n8n/00-setup-and-maintenance.sdk.ts');
    for (const [node, url, id] of [['Store Webhook Secret', `${N8N}quote-events`, 'achPINGMACWF00QTE'], ['Store Invoice Webhook Secret', `${N8N}project-invoice-events`, 'achPINGMACWF00INV']] as const) {
      const secret = randomBytes(32).toString('base64');
      const r = new N8nRun(wf00.nodes, wf00.edges, { db, http: () => { throw new Error('no HTTP expected'); } });
      await r.run(node, [{ json: { statusCode: 200, body: { id, macSecretBase64: secret } } }], [node === 'Store Webhook Secret' ? 'Read Back Airtable Webhooks' : 'Read Back Invoice Webhook']);
      expect(r.out.get(node)).toEqual([{ json: { s: { stored: true, webhook_id: id } } }]);
      expect(await db.query(`select webhook_id from integration_webhook_secrets where notification_url = $1`, [url])).toEqual([{ webhook_id: id }]);
    }
  });
});
