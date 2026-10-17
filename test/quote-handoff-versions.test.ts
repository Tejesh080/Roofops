/**
 * Factory review of 9b3caa2: quote hand-off versions and workflow 10's error path (migration 20261017050000).
 *  1. A revision after failed v1 attempts must start a fresh hand-off: its first attempt is not a retry, it gets the
 *     full retry budget, old attempts do not dead-letter it, open exceptions are not duplicated, and Status is never
 *     written once the Airtable quote row may exist (an Accepted there is kept). The latest hand-off is chosen by
 *     version, never by timestamp; at most one hand-off per quote is open.
 *  2. Workflow 10: a failed or malformed Upsert Quote goes to the failure path before any read-back runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';
import { recorded } from './helpers/n8n-sdk-shim.js';
import { N8nRun, type HttpRequest, type Item } from './helpers/n8n-runner.js';

type R = Record<string, unknown>;
const PW = 'handoff versions password 1';
const LINES = [{ line_kind: 'LABOUR', description: 'Replace tiles', quantity: '10', unit: 'hrs', unit_price: '95' }];
const VERSION = 'fldEjEqlzE8Y0M1nf', AMOUNT = 'fldbfUE8DVh1Dwjfs', STATUS = 'fldQpTa5tvrzlNg1h';

function proofFor(p: R): R {
  const d = String(p.quote_number).replace(/\D/g, '').padEnd(12, '0').slice(0, 12);
  const [QU, CU, PR] = [`recQV${d}`, `recCV${d}`, `recPV${d}`];
  const qf = p.quote_fields as R;
  return { verified: true, quote_number: p.quote_number, customer_number: p.customer_number, property_number: p.property_number,
    quote_record_id: QU, customer_record_id: CU, property_record_id: PR, quote_customer_link_ids: [CU], quote_property_link_ids: [PR],
    customer_read_back: { id: CU, roofops_id: p.customer_id, number: p.customer_number },
    property_read_back: { id: PR, roofops_id: p.property_id, number: p.property_number, owner_link_ids: [CU] },
    quote_read_back: { id: QU, roofops_id: p.quote_id, number: p.quote_number, version: qf[VERSION], amount: qf[AMOUNT], customer_link_ids: [CU], property_link_ids: [PR] } };
}

describe.each(TARGETS)('quote hand-off versions [%s]', (target) => {
  let db: Db;
  let est = '';
  let maxAttempts = 0;
  const one = async (sql: string, p: unknown[] = []) => (await db.query<R>(sql, p))[0]!;
  const call = async (sql: string, p: unknown[]) => (await one(sql, p)).r as R;
  const asWorkflow = async (sql: string, p: unknown[]) => { await db.exec('set role roofops_workflow'); try { return await call(sql, p); } finally { await db.exec('reset role'); } };
  let n = 0;
  const sentQuote = async () => {
    n++;
    const name = `Hv ${target} ${n}`;
    const lead = await call('select web_lead_create($1,$2,$3,$4,$5,$6,$7,$8,$9) r', [est, name, `0477 20${n} 1${n}0`, null, null, 'PHONE', null, `hv-lead-${target}-${n}`, true]);
    await call('select web_lead_convert($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) r', [est, lead.lead_number, 1, null,
      JSON.stringify({ display_name: name, customer_type: 'RESIDENTIAL', phone: `0477 20${n} 1${n}0` }), JSON.stringify({ address_line1: `${n} Version Way ${target}`, suburb: 'Avoca', state: 'QLD', postcode: '4670' }), true]);
    const q = await call('select web_quote_save($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) r', [est, lead.lead_number, null, null, 'LEAK_REPAIR', 'INCLUSIVE', null, JSON.stringify(LINES), `hv-quote-${target}-${n}`]);
    const s = await call('select web_quote_send($1,$2,$3) r', [est, q.quote_number, (await one('select record_version::int v from quotes where quote_number = $1', [q.quote_number])).v]);
    return { quote: String(q.quote_number), key: String(s.airtable_key) };
  };
  const revise = async (quote: string, hours: string, key: string) => call('select web_quote_save($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) r', [est, null, quote,
    (await one('select record_version::int v from quotes where quote_number = $1', [quote])).v, 'LEAK_REPAIR', 'INCLUSIVE', null, JSON.stringify([{ ...LINES[0]!, quantity: hours }]), key]);
  const claim = (key: string) => asWorkflow(`select wf_claim_side_effect($1, 'n8n:10', 180) r`, [key]);
  const fail = (key: string, cls: string) => asWorkflow('select wf_quote_publish_fail($1, $2, $3, $4, null) r', [key, cls, `upsert quote: ${cls}`, cls === 'VALIDATION_ERROR' ? 422 : 502]);
  const due = (key: string) => db.query(`update outbox set next_attempt_at = now() where idempotency_key = $1 and next_attempt_at <> 'infinity'`, [key]);
  const handoffs = async (quote: string) => (await db.query<R>(`select o.idempotency_key k, o.status, o.attempts::int a, o.next_attempt_at = 'infinity' stopped,
      (o.payload -> 'quote_fields' ->> '${VERSION}')::int v, o.payload ->> 'write_status' ws from outbox o join quotes q on q.id = o.aggregate_id
      where o.topic = 'airtable.quote_publish' and q.quote_number = $1 order by (o.payload -> 'quote_fields' ->> '${VERSION}')::int, o.idempotency_key`, [quote]));
  const open = (quote: string) => one(`select count(*)::int n from outbox o join quotes q on q.id = o.aggregate_id where o.topic = 'airtable.quote_publish' and q.quote_number = $1
      and (o.status in ('PENDING', 'DISPATCHING') or (o.status = 'FAILED' and o.next_attempt_at <> 'infinity'))`, [quote]);
  const openExceptions = (quote: string) => one(`select count(*)::int n from workflow_exceptions e join quotes q on q.id = e.entity_id
      where e.entity_type = 'quote' and q.quote_number = $1 and e.resolution_status in ('OPEN', 'RETRY_QUEUED')`, [quote]);

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.query('select ops_staff_set_password($1, $2, $3)', ['EMP-002', 'estimator', PW]);
    est = String((await call('select web_staff_sign_in($1, $2) r', ['estimator', PW])).token);
    maxAttempts = Number((await one(`select value from app_settings where key = 'wf.side_effect.max_attempts'`)).value);
  }, 180_000);
  afterAll(async () => { await db.close(); });

  it('after failed v1 attempts a revision is a fresh hand-off: attempt 1, the full retry budget, v1 kept as history and no longer handed out', async () => {
    expect(maxAttempts).toBeGreaterThanOrEqual(3);
    const s = await sentQuote();
    for (let i = 1; i < maxAttempts; i++) {                                   // v1 fails, retryably, all but its last attempt
      expect(await claim(s.key)).toMatchObject({ claimed: true, attempt: i });
      expect(await fail(s.key, 'UPSTREAM_5XX')).toMatchObject({ retry: true });
      await due(s.key);
    }
    expect(await revise(s.quote, '12', `hv-rev-${target}-a`)).toMatchObject({ ok: true, version: 2 });
    const hs = await handoffs(s.quote);
    expect(hs).toHaveLength(2);
    expect(hs[0]).toMatchObject({ k: s.key, v: 1, status: 'FAILED', stopped: true, a: maxAttempts - 1 });   // history, never handed out again
    expect(hs[1]).toMatchObject({ v: 2, status: 'PENDING', a: 0 });
    expect(await open(s.quote)).toEqual({ n: 1 });
    const k2 = String(hs[1]!.k);
    // v2's first attempt is attempt 1, and one failure does not dead-letter it (the old attempts are not carried over).
    expect(await claim(k2)).toMatchObject({ claimed: true, attempt: 1 });
    expect(await fail(k2, 'UPSTREAM_5XX')).toMatchObject({ retry: true, attempt: 1 });
    expect((await asWorkflow(`select wf_quote_publish_next('n8n:10:t') r`, [])).writes).toEqual([]);   // v1 is not handed out
  });

  it('Status is written only when the Airtable quote row cannot exist yet: never after an earlier attempt or a finished hand-off (an Accepted there is kept)', async () => {
    const fresh = await sentQuote();
    expect((await handoffs(fresh.quote))[0]).toMatchObject({ ws: null });          // first send: nothing in Airtable yet
    const s = await sentQuote();
    await claim(s.key);
    expect(await asWorkflow('select wf_complete_side_effect($1, $2::jsonb) r', [s.key, JSON.stringify(proofFor((await one('select payload from outbox where idempotency_key = $1', [s.key])).payload as R))]))
      .toMatchObject({ status: 'RECORDED' });
    expect(await revise(s.quote, '13', `hv-rev-${target}-b`)).toMatchObject({ ok: true });
    expect((await handoffs(s.quote))[1]).toMatchObject({ v: 2, ws: 'false' });
    const f = await sentQuote();                                                   // a failed attempt may have created the row
    await claim(f.key); await fail(f.key, 'TIMEOUT'); await due(f.key);
    expect(await revise(f.quote, '13', `hv-rev-${target}-c`)).toMatchObject({ ok: true });
    expect((await handoffs(f.quote))[1]).toMatchObject({ v: 2, ws: 'false', a: 0 });
  });

  it('a stopped v1 with an open exception, then a revision that fails too: one open exception for the quote, not two', async () => {
    const s = await sentQuote();
    await claim(s.key);
    expect(await fail(s.key, 'VALIDATION_ERROR')).toMatchObject({ retry: false });
    expect(await openExceptions(s.quote)).toEqual({ n: 1 });
    expect(await revise(s.quote, '14', `hv-rev-${target}-d`)).toMatchObject({ ok: true });
    const k2 = String((await handoffs(s.quote))[1]!.k);
    await claim(k2);
    expect(await fail(k2, 'VALIDATION_ERROR')).toMatchObject({ retry: false });
    expect(await openExceptions(s.quote)).toEqual({ n: 1 });
  });

  it('the latest hand-off is chosen by version even when timestamps are equal (one transaction), and at most one is ever open', async () => {
    const s = await sentQuote();
    await db.exec('begin');
    try {
      await db.query(`update outbox set created_at = now() where idempotency_key = $1`, [s.key]);   // every row of this quote at one instant
      await claim(s.key);
      await asWorkflow('select wf_complete_side_effect($1, $2::jsonb) r', [s.key, JSON.stringify(proofFor((await one('select payload from outbox where idempotency_key = $1', [s.key])).payload as R))]);
      expect(await revise(s.quote, '11', `hv-rev-${target}-e`)).toMatchObject({ ok: true, version: 2 });
      expect(await revise(s.quote, '12', `hv-rev-${target}-f`)).toMatchObject({ ok: true, version: 3 });
      expect(await revise(s.quote, '13', `hv-rev-${target}-g`)).toMatchObject({ ok: true, version: 4 });
      expect(await open(s.quote)).toEqual({ n: 1 });
      const hs = await handoffs(s.quote);
      expect(hs.filter((h) => h.status === 'PENDING').map((h) => h.v)).toEqual([4]);
      expect(await one(`select airtable_handoff, in_airtable from v_dashboard_quotes where quote_number = $1`, [s.quote])).toEqual({ airtable_handoff: 'PENDING', in_airtable: false });
    } finally { await db.exec('commit'); }
    // The database itself refuses a second open hand-off for one quote.
    await expect(db.query(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload)
      select 'airtable.quote_publish', 'quote', id, gen_random_uuid(), 'hv:second-open', '{}' from quotes where quote_number = $1`, [s.quote])).rejects.toThrow(/duplicate key|one_open/);
  });
});

/** Workflow 10's real nodes, from Upsert Quote on, against a scripted Airtable and a recording database. */
describe('workflow 10 after Upsert Quote', () => {
  const job = { quote_number: 'Q-2026-0901', quote_id: 'aaaaaaaa-0000-0000-0000-000000000001', customer_number: 'CUST-0901', customer_id: 'bbbbbbbb-0000-0000-0000-000000000001',
    property_number: 'PROP-0901', property_id: 'cccccccc-0000-0000-0000-000000000001', quote_fields: { [VERSION]: 1, [AMOUNT]: 950 } };
  const ids = { q: 'recQ0000000000001', c: 'recC0000000000001', p: 'recP0000000000001' };
  const records: Record<string, unknown> = {
    [ids.q]: { id: ids.q, fields: { fldyP20HNafS614d5: job.quote_number, fldVUpqZkVKid3Fyy: job.quote_id, fld4LsEu8c9EMFj0h: [ids.c], fldisUv1ckHz2Detv: [ids.p], [VERSION]: 1, [AMOUNT]: 950 } },
    [ids.c]: { id: ids.c, fields: { fldzmWSHtLVZ4OTmZ: job.customer_number, fldDClu1e0ffwnojn: job.customer_id } },
    [ids.p]: { id: ids.p, fields: { fldIy8ab7Ky67jL31: job.property_number, fldm6rtleyV6yp8ZS: job.property_id, fldVpX0MOcA8TnGvo: [ids.c] } },
  };
  type Upsert = (req: HttpRequest) => { statusCode: number; body: unknown; headers?: Record<string, string> };
  const run = async (upsert: Upsert) => {
    if (!recorded.nodes.has('Upsert Quote')) {
      recorded.nodes.clear(); recorded.edges.length = 0;
      const sdk = '../n8n/10-airtable-quote-publish.sdk.ts';
      await import(/* @vite-ignore */ sdk);
    }
    const gets: string[] = []; const sql: { q: string; p: unknown[] }[] = [];
    const r = new N8nRun(recorded.nodes, recorded.edges, {
      db: { query: (q: string, p: unknown[] = []) => { sql.push({ q, p }); return Promise.resolve(q.includes('wf_quote_publish_fail') ? [{ f: { retry: true } }] : [{ r: { status: 'RECORDED' } }]); } } as unknown as Db,
      http: (req) => {
        if (req.method === 'PATCH') return upsert(req);
        gets.push(req.url);
        const id = req.url.split('/').pop()!;
        return records[id] ? { statusCode: 200, body: records[id] } : { statusCode: 404, body: { error: 'NOT_FOUND' } };
      } });
    const seed = (name: string, items: Item[]) => { r.seed(name, items); };
    seed('Claim Quote Publish', [{ json: { c: { claimed: true, attempt: 1, payload: job } } }]);
    seed('Write To Publish', [{ json: { key: 'airtable:quote-publish:test' } }]);
    seed('Build Quote', [{ json: { ok: true, customer_record_id: ids.c, property_record_id: ids.p, request: {} } }]);
    await r.run('Upsert Quote', [{ json: { ok: true, customer_record_id: ids.c, property_record_id: ids.p, request: { records: [{ fields: {} }] } } }],
      ['Proof Refused By Postgres']);   // the runner does not tell a node's error output from its main one: stop at the error-only node
    const failed = sql.find((s) => s.q.includes('wf_quote_publish_fail'));
    return { gets, failedClass: failed ? String(failed.p[1]) : null, completed: sql.some((s) => s.q.includes('wf_complete_side_effect')) };
  };

  it.each([
    ['a timeout (no response)', (() => { throw new Error('ETIMEDOUT: socket hang up'); }), 'TIMEOUT'],
    ['HTTP 429 (rate limited)', (() => ({ statusCode: 429, body: { errors: [{ error: 'RATE_LIMIT' }] }, headers: { 'retry-after': '30' } })), 'RATE_LIMITED'],
    ['HTTP 502', (() => ({ statusCode: 502, body: 'Bad Gateway' })), 'UPSTREAM_5XX'],
    ['a 200 with no records (malformed)', (() => ({ statusCode: 200, body: {} })), 'RECONCILIATION_MISMATCH'],
    ['a 200 with a text body (malformed)', (() => ({ statusCode: 200, body: '<html>oops</html>' })), 'RECONCILIATION_MISMATCH'],
  ])('%s: recorded as a failure (%s path), no read-back attempted, never DONE', async (_what, upsert, cls) => {
    const out = await run(upsert);
    expect(out).toEqual({ gets: [], failedClass: cls, completed: false });
  });

  it('a successful upsert reads back the quote, customer and property and records the verified proof', async () => {
    const out = await run(() => ({ statusCode: 200, body: { records: [{ id: ids.q, fields: {} }] } }));
    expect(out.failedClass).toBeNull();
    expect(out.completed).toBe(true);
    expect(out.gets.map((u) => u.split('/').pop())).toEqual([ids.q, ids.c, ids.p]);
  });

  it('Build Quote writes Status only on the first attempt of a hand-off that may write it', async () => {
    const build = async (attempt: number, payload: R) => {
      const r = new N8nRun(recorded.nodes, recorded.edges, { db: { query: () => { throw new Error('no db'); } } as unknown as Db, http: () => { throw new Error('no http'); } });
      r.seed('Claim Quote Publish', [{ json: { c: { claimed: true, attempt, payload } } }]);
      r.seed('Build Property', [{ json: { ok: true, customer_record_id: ids.c } }]);
      await r.run('Build Quote', [{ json: { statusCode: 200, body: { records: [{ id: ids.p }] } } }], recorded.edges.filter((e) => e.from === 'Build Quote').map((e) => e.to));
      return ((r.out.get('Build Quote')![0]!.json as R).request as { records: { fields: R }[] }).records[0]!.fields;
    };
    const qf = { [STATUS]: 'Sent', [VERSION]: 2 };
    expect(await build(1, { quote_fields: qf })).toHaveProperty(STATUS, 'Sent');                    // first send
    expect(await build(1, { quote_fields: qf, write_status: false })).not.toHaveProperty(STATUS);    // the row may exist (revision)
    expect(await build(2, { quote_fields: qf })).not.toHaveProperty(STATUS);                         // a retry
  });
});
