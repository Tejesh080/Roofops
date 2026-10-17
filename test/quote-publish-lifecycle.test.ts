/**
 * Quote publishing lifecycle (Factory review of 920e274; migration 20261017060000). The three confirmed failures:
 *  1. A new Airtable quote could have a blank Status while RoofOps reported DONE (a retry created the record without it).
 *  2. A delayed worker could overwrite a newer or Accepted quote with an older version (its write landed after another
 *     attempt had finished; Airtable cannot refuse a stale write).
 *  3. The manual re-queue could revive a superseded hand-off or break the one-open-hand-off rule.
 * The rules (see the migration): a SENT quote is final; n8n 10 never changes an existing Airtable quote record (look up,
 * create only if none, never update); DONE needs exactly one record with a valid Status; only the attempt holding a
 * hand-off can report; only the latest stopped hand-off of a sent quote's current version is re-queued.
 * The workflow scenarios run n8n 10's REAL nodes against a real migrated database (as roofops_workflow) and a scripted
 * Airtable. Nothing here talks to Airtable.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';
import { recorded } from './helpers/n8n-sdk-shim.js';
import { N8nRun, type HttpRequest } from './helpers/n8n-runner.js';

type R = Record<string, unknown>;
type Res = { statusCode: number; body: unknown; headers?: Record<string, string> };
const PW = 'publish lifecycle password 1';
const LINES = [{ line_kind: 'LABOUR', description: 'Replace tiles', quantity: '10', unit: 'hrs', unit_price: '95' }];
const VERSION = 'fldEjEqlzE8Y0M1nf', AMOUNT = 'fldbfUE8DVh1Dwjfs', STATUS = 'fldQpTa5tvrzlNg1h';
const QUOTES = 'tblzenPRNVV5O7lZP';
const QUOTE_FIELD_BY_NAME: Record<string, string> = { 'RoofOps ID': 'fldVUpqZkVKid3Fyy', 'Quote Number': 'fldyP20HNafS614d5' };

/** A scripted Airtable: list (filterByFormula on the quote's RoofOps ID / number), get, create, upsert. Every write is logged. */
class FakeAirtable {
  readonly tables = new Map<string, Map<string, { id: string; fields: R }>>();
  readonly writes: { method: string; table: string; ids: string[] }[] = [];
  /** Answers instead of the table for the requests it matches (a failure on purpose); undefined lets the request through. */
  override: (req: HttpRequest) => Res | undefined = () => undefined;
  private n = 0;
  constructor(private tag: string) {}
  table(t: string) { if (!this.tables.has(t)) this.tables.set(t, new Map()); return this.tables.get(t)!; }
  quotes() { return [...this.table(QUOTES).values()]; }
  private create(t: string, fields: R) {
    const id = `rec${this.tag}${String(++this.n).padStart(14 - this.tag.length, '0')}`;
    const rec = { id, fields: { ...fields } };
    this.table(t).set(id, rec);
    return rec;
  }
  readonly http = (req: HttpRequest): Res => {
    const o = this.override(req);
    if (o) return o;
    const m = /\/v0\/app\w+\/(tbl\w+)(?:\/(rec\w+))?$/.exec(req.url);
    if (!m) return { statusCode: 404, body: { error: 'NOT_FOUND' } };
    const [, t, rid] = m as unknown as [string, string, string | undefined];
    const tab = this.table(t);
    if (req.method === 'GET' && rid) { const r = tab.get(rid); return r ? { statusCode: 200, body: r } : { statusCode: 404, body: { error: 'NOT_FOUND' } }; }
    if (req.method === 'GET') {
      const conds = [...(req.query.filterByFormula ?? '').matchAll(/\{([^}]+)\}='([^']*)'/g)].map(([, name, v]) => [QUOTE_FIELD_BY_NAME[name!] ?? name!, v!] as const);
      return { statusCode: 200, body: { records: [...tab.values()].filter((r) => conds.some(([f, v]) => r.fields[f] === v)) } };
    }
    const body = req.body as { records: { fields: R }[]; performUpsert?: { fieldsToMergeOn: string[] } };
    if (req.method === 'POST') {
      const recs = body.records.map((r) => this.create(t, r.fields));
      this.writes.push({ method: 'POST', table: t, ids: recs.map((r) => r.id) });
      return { statusCode: 200, body: { records: recs } };
    }
    if (req.method === 'PATCH' && body.performUpsert) {
      const recs = [];
      for (const r of body.records) {
        const on = body.performUpsert.fieldsToMergeOn;
        const hit = [...tab.values()].filter((x) => on.every((f) => x.fields[f] === r.fields[f]));
        if (hit.length > 1) return { statusCode: 422, body: { error: { type: 'INVALID_REQUEST_UNKNOWN', message: 'multiple matches' } } };
        if (hit[0]) { Object.assign(hit[0].fields, r.fields); recs.push(hit[0]); } else recs.push(this.create(t, r.fields));
      }
      this.writes.push({ method: 'PATCH', table: t, ids: recs.map((r) => r.id) });
      return { statusCode: 200, body: { records: recs } };
    }
    throw new Error(`fake Airtable: unsupported ${req.method} ${req.url}`);
  };
}

describe.each(TARGETS)('quote publishing lifecycle [%s]', (target) => {
  let db: Db;
  let est = '';
  const one = async (sql: string, p: unknown[] = []) => (await db.query<R>(sql, p))[0]!;
  const call = async (sql: string, p: unknown[]) => (await one(sql, p)).r as R;
  const asWorkflow = async (sql: string, p: unknown[]) => { await db.exec('set role roofops_workflow'); try { return await call(sql, p); } finally { await db.exec('reset role'); } };
  let n = 0;
  const phone = (i: number) => `0488 ${String(100000 + i).slice(-6)}`;
  /** An enquiry converted to a new customer at a new site, quoted and sent. */
  const sentQuote = async () => {
    n++;
    const name = `Life ${target} ${n}`;
    const lead = await call('select web_lead_create($1,$2,$3,$4,$5,$6,$7,$8,$9) r', [est, name, phone(n), null, null, 'PHONE', null, `pl-lead-${target}-${n}`, true]);
    expect(await call('select web_lead_convert($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) r', [est, lead.lead_number, 1, null,
      JSON.stringify({ display_name: name, customer_type: 'RESIDENTIAL', phone: phone(n) }),
      JSON.stringify({ address_line1: `${n} Lifecycle Lane ${target}`, suburb: 'Avoca', state: 'QLD', postcode: '4670' }), true])).toMatchObject({ ok: true });
    const q = await call('select web_quote_save($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) r', [est, lead.lead_number, null, null, 'LEAK_REPAIR', 'INCLUSIVE', null, JSON.stringify(LINES), `pl-quote-${target}-${n}`]);
    const s = await call('select web_quote_send($1,$2,$3) r', [est, q.quote_number, (await one('select record_version::int v from quotes where quote_number = $1', [q.quote_number])).v]);
    expect(s).toMatchObject({ ok: true, status: 'SENT' });
    return { quote: String(q.quote_number), key: String(s.airtable_key) };
  };
  const payload = async (key: string) => (await one('select payload from outbox where idempotency_key = $1', [key])).payload as R;
  const handoff = (key: string) => one(`select status, attempts::int a, next_attempt_at = 'infinity' stopped, result from outbox where idempotency_key = $1`, [key]);
  const claim = (key: string) => asWorkflow(`select wf_claim_side_effect($1, 'n8n:10', 180) r`, [key]);
  const expire = (key: string) => db.query(`update outbox set locked_until = now() - interval '1 second' where idempotency_key = $1`, [key]);
  const due = (key: string) => db.query(`update outbox set next_attempt_at = now() where idempotency_key = $1 and next_attempt_at <> 'infinity'`, [key]);
  const fail = (key: string, cls: string, attempt: number | null) =>
    asWorkflow('select wf_quote_publish_fail($1, $2, $3, $4, null, $5) r', [key, cls, `test: ${cls}`, cls === 'VALIDATION_ERROR' ? 422 : 502, attempt]);
  /** The proof n8n 10 sends (here: exactly what Airtable would hold), for the attempt that holds the hand-off. */
  const proof = (p: R, attempt: number, o: Partial<{ quote: R; count: number }> = {}): R => {
    const qf = p.quote_fields as R;
    const d = String(p.quote_number).replace(/\D/g, '').padEnd(12, '0').slice(0, 12);
    const [QU, CU, PR] = [`recQL${d}`, `recCL${d}`, `recPL${d}`];
    return { verified: true, attempt, quote_record_count: o.count ?? 1, quote_number: p.quote_number, customer_number: p.customer_number, property_number: p.property_number,
      quote_record_id: QU, customer_record_id: CU, property_record_id: PR, quote_customer_link_ids: [CU], quote_property_link_ids: [PR],
      customer_read_back: { id: CU, roofops_id: p.customer_id, number: p.customer_number },
      property_read_back: { id: PR, roofops_id: p.property_id, number: p.property_number, owner_link_ids: [CU] },
      quote_read_back: { id: QU, roofops_id: p.quote_id, number: p.quote_number, version: qf[VERSION], amount: qf[AMOUNT], status: 'Sent',
        customer_link_ids: [CU], property_link_ids: [PR], ...o.quote } };
  };
  const complete = (key: string, pr: R) => asWorkflow('select wf_complete_side_effect($1, $2::jsonb) r', [key, JSON.stringify(pr)]);
  const openExceptions = (quote: string) => db.query<R>(`select e.error_class, e.error_message from workflow_exceptions e join quotes q on q.id = e.entity_id
      where e.entity_type = 'quote' and q.quote_number = $1 and e.resolution_status in ('OPEN', 'RETRY_QUEUED')`, [quote]);

  /** n8n 10's real nodes; its Postgres nodes run against this database as roofops_workflow. */
  const sql: { q: string; p: unknown[] }[] = [];
  const refusals: string[] = [];
  const workflowDb = { query: async (q: string, p: unknown[] = []) => {
    sql.push({ q, p });
    await db.exec('set role roofops_workflow');
    try { return await db.query(q, p); }
    catch (e) { if (!q.includes('wf_complete_side_effect')) throw e; refusals.push((e as Error).message); return []; }   // n8n: the error output
    finally { await db.exec('reset role'); }
  } } as unknown as Db;
  const STOP = ['Proof Refused By Postgres'];   // the runner does not tell a node's error output from its main one
  const worker = (air: FakeAirtable) => new N8nRun(recorded.nodes, recorded.edges, { db: workflowDb, http: air.http });
  const start = (r: N8nRun, s: { quote: string; key: string }, stopAt: string[] = STOP) =>
    r.run('Write To Publish', [{ json: { d: { writes: [{ key: s.key, quote_number: s.quote }] } } }], stopAt);
  const failures = (key: string) => sql.filter((x) => x.q.includes('wf_quote_publish_fail') && x.p[0] === key).map((x) => ({ cls: x.p[1], attempt: x.p[5] }));

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.query('select ops_staff_set_password($1, $2, $3)', ['EMP-002', 'estimator', PW]);
    est = String((await call('select web_staff_sign_in($1, $2) r', ['estimator', PW])).token);
    if (!recorded.nodes.has('Record Publish Failure')) {
      recorded.nodes.clear(); recorded.edges.length = 0;
      const sdk = '../n8n/10-airtable-quote-publish.sdk.ts';
      await import(/* @vite-ignore */ sdk);
    }
  }, 180_000);
  afterAll(async () => { await db.close(); });

  describe('a sent quote is final', () => {
    it('revising a SENT quote is refused and nothing is written (no version, no hand-off); a draft can still be revised', async () => {
      const s = await sentQuote();
      const before = await one(`select (select count(*)::int from quote_versions v join quotes q on q.id = v.quote_id where q.quote_number = $1) versions,
        (select count(*)::int from outbox o join quotes q on q.id = o.aggregate_id where q.quote_number = $1) handoffs, (select record_version::int from quotes where quote_number = $1) rv`, [s.quote]);
      const r = await call('select web_quote_save($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) r', [est, null, s.quote, before.rv, 'LEAK_REPAIR', 'INCLUSIVE', null,
        JSON.stringify([{ ...LINES[0]!, quantity: '12' }]), `pl-rev-${target}-1`]);
      expect(r).toMatchObject({ ok: false, code: 'QUOTE_SENT_FINAL' });
      expect(await one(`select (select count(*)::int from quote_versions v join quotes q on q.id = v.quote_id where q.quote_number = $1) versions,
        (select count(*)::int from outbox o join quotes q on q.id = o.aggregate_id where q.quote_number = $1) handoffs, (select record_version::int from quotes where quote_number = $1) rv`, [s.quote])).toEqual(before);
      // A draft is not in Airtable: it may change.
      const lead = await call('select web_lead_create($1,$2,$3,$4,$5,$6,$7,$8,$9) r', [est, `Draft ${target}`, '0488 399 399', null, null, 'PHONE', null, `pl-lead-draft-${target}`, true]);
      await call('select web_lead_convert($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) r', [est, lead.lead_number, 1, null, JSON.stringify({ display_name: `Draft ${target}`, customer_type: 'RESIDENTIAL', phone: '0488 399 399' }),
        JSON.stringify({ address_line1: `1 Draft St ${target}`, suburb: 'Avoca', state: 'QLD', postcode: '4670' }), true]);
      const d = await call('select web_quote_save($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) r', [est, lead.lead_number, null, null, 'LEAK_REPAIR', 'INCLUSIVE', null, JSON.stringify(LINES), `pl-draft-${target}`]);
      expect(await call('select web_quote_save($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) r', [est, null, d.quote_number, d.record_version, 'LEAK_REPAIR', 'INCLUSIVE', null,
        JSON.stringify([{ ...LINES[0]!, quantity: '12' }]), `pl-draft-rev-${target}`])).toMatchObject({ ok: true, version: 2, status: 'DRAFT' });
    });
  });

  describe('Factory 1: a published quote always has a valid Status', () => {
    it('a quote record created on a retry carries Status Sent, and DONE records it', async () => {
      const s = await sentQuote();
      const air = new FakeAirtable('S1');
      air.override = (req) => { if (req.url.includes(QUOTES)) throw new Error('ETIMEDOUT'); return undefined; };
      await start(worker(air), s);                                               // attempt 1: its first quote request times out (nothing created)
      expect(failures(s.key).map((f) => f.cls)).toEqual(['TIMEOUT']);
      expect(air.quotes()).toEqual([]);
      expect(await handoff(s.key)).toMatchObject({ status: 'FAILED', a: 1, stopped: false });
      air.override = () => undefined; await due(s.key);
      await start(worker(air), s);                                               // attempt 2: creates the record
      const [rec] = air.quotes();
      expect(air.quotes()).toHaveLength(1);
      expect(rec!.fields[STATUS]).toBe('Sent');
      expect(await handoff(s.key)).toMatchObject({ status: 'DONE', a: 2, result: { attempt: 2, quote_record_count: 1, quote_record_id: rec!.id, quote_read_back: { status: 'Sent' } } });
    });

    it('Postgres refuses DONE when the quote record read back has a blank or unknown Status, or when Airtable holds more than one record', async () => {
      const s = await sentQuote();
      expect(await claim(s.key)).toMatchObject({ claimed: true, attempt: 1 });
      const p = await payload(s.key);
      await expect(complete(s.key, proof(p, 1, { quote: { status: '' } }))).rejects.toThrow(/Status ""/);
      await expect(complete(s.key, proof(p, 1, { quote: { status: undefined } }))).rejects.toThrow(/Status/);
      await expect(complete(s.key, proof(p, 1, { quote: { status: 'Draft' } }))).rejects.toThrow(/Status "Draft"/);
      await expect(complete(s.key, proof(p, 1, { count: 2 }))).rejects.toThrow(/2 quote records/);
      const noCount = proof(p, 1); delete noCount.quote_record_count;
      await expect(complete(s.key, noCount)).rejects.toThrow(/quote records/);
      expect(await handoff(s.key)).toMatchObject({ status: 'DISPATCHING' });
      expect(await complete(s.key, proof(p, 1, { quote: { status: 'Accepted' } }))).toMatchObject({ status: 'RECORDED' });   // accepted in Airtable already: valid
    });
  });

  describe('Factory 2: a delayed worker never overwrites a quote', () => {
    it('worker A stalls before its quote write, its lease runs out, worker B publishes, the office accepts; A resumes: the Accepted record is untouched and A records nothing', async () => {
      const s = await sentQuote();
      const air = new FakeAirtable('D2');
      const write = recorded.nodes.has('Create Quote') ? 'Create Quote' : 'Upsert Quote';   // the node that writes the quote record
      const a = worker(air);
      await start(a, s, [write, ...STOP]);                                       // A: claimed, looked up, about to write ...
      expect(await handoff(s.key)).toMatchObject({ status: 'DISPATCHING', a: 1 });
      await expire(s.key);                                                       // ... and stalls past its lease
      await start(worker(air), s);                                               // B: attempt 2, the whole hand-off
      expect(await handoff(s.key)).toMatchObject({ status: 'DONE', a: 2 });
      expect(air.quotes()).toHaveLength(1);
      const r1 = air.quotes()[0]!;
      // The office accepts it in Airtable (n8n 01 -> wf_quote_accepted).
      r1.fields[STATUS] = 'Accepted';
      expect(await asWorkflow('select wf_quote_accepted($1::jsonb) r', [JSON.stringify({ event_id: `EVT-PL-${target}`, correlation_id: `CORR-PL-${target}`, event_type: 'quote.accepted',
        source: 'airtable', actor_id: 'usr7uCnNO15fCefbH', occurred_at: new Date().toISOString(), payload: { quote_id: s.quote, accepted_version: 1 } })])).toMatchObject({ status: 'CREATED' });
      const accepted = structuredClone(r1.fields);
      const writesBefore = air.writes.filter((w) => w.table === QUOTES && w.ids.includes(r1.id)).length;

      // A resumes where it stalled.
      const into = recorded.edges.find((e) => e.to === write)!.from;
      await a.run(write, a.out.get(into)!, STOP);

      expect(r1.fields).toEqual(accepted);                                        // still Accepted, same version and amount
      expect(air.writes.filter((w) => w.table === QUOTES && w.ids.includes(r1.id)).length).toBe(writesBefore);   // never written again
      expect(await handoff(s.key)).toMatchObject({ status: 'DONE', a: 2, result: { attempt: 2, quote_record_id: r1.id } });
      expect(await one(`select status from quotes where quote_number = $1`, [s.quote])).toEqual({ status: 'ACCEPTED' });
      // What Airtable cannot prevent: A's create still lands, as a SECOND record (never a change to the first). A sees two
      // and reports it; Postgres changes nothing (A is late) but a person is told to delete the duplicate.
      expect(air.quotes()).toHaveLength(2);
      expect(air.quotes()[1]!.fields[STATUS]).toBe('Sent');
      expect(failures(s.key).at(-1)).toEqual({ cls: 'AMBIGUOUS_WRITE', attempt: '1' });
      expect((await openExceptions(s.quote)).map((e) => e.error_class)).toEqual(['AMBIGUOUS_WRITE']);
      expect(await one(`select count(*)::int n from automation_events where event_type = 'automation.late_report' and business_reference = $1`, [s.quote])).toEqual({ n: 1 });
    });

    it('an existing Airtable quote record is never written, whatever it holds: Accepted is kept (DONE); a different version is reported, not "fixed"', async () => {
      for (const [tag, held, done] of [['E1', { [STATUS]: 'Accepted' }, true], ['E2', { [VERSION]: 7, [AMOUNT]: 1 }, false]] as const) {
        const s = await sentQuote();
        const air = new FakeAirtable(tag);
        const p = await payload(s.key);
        // The quote's records as an earlier publish left them (customer, site owned by it, quote linked to both).
        const cust = { id: `rec${tag}CUSTOMER0001`, fields: { ...(p.customer_fields as R) } };
        const prop = { id: `rec${tag}PROPERTY0001`, fields: { ...(p.property_fields as R), fldVpX0MOcA8TnGvo: [cust.id] } };
        const existing = { id: `rec${tag}QUOTEREC0001`, fields: { ...(p.quote_fields as R), fld4LsEu8c9EMFj0h: [cust.id], fldisUv1ckHz2Detv: [prop.id], ...held } };
        air.table('tblHKX79FJFHn5FDc').set(cust.id, cust); air.table('tblSYcCqId9wTMg3c').set(prop.id, prop); air.table(QUOTES).set(existing.id, existing);
        const snapshot = structuredClone(existing.fields);
        await start(worker(air), s);
        expect(air.writes.filter((w) => w.table === QUOTES), tag).toEqual([]);     // no create, no update
        expect(existing.fields, tag).toEqual(snapshot);
        if (done) expect(await handoff(s.key)).toMatchObject({ status: 'DONE', result: { quote_record_id: existing.id, quote_read_back: { status: 'Accepted' } } });
        else {
          expect(await handoff(s.key)).toMatchObject({ status: 'FAILED', stopped: true });
          expect(failures(s.key).at(-1)).toMatchObject({ cls: 'RECONCILIATION_MISMATCH' });
        }
      }
    });

    it('Postgres: a report from an attempt that no longer holds the hand-off changes nothing (DONE, retry or stop), whatever it says', async () => {
      const s = await sentQuote();
      expect(await claim(s.key)).toMatchObject({ attempt: 1 });
      await expire(s.key);
      expect(await claim(s.key)).toMatchObject({ attempt: 2 });                   // a newer attempt holds it
      const p = await payload(s.key);
      await expect(complete(s.key, proof(p, 1))).rejects.toThrow(/held by attempt 2.*late/);
      const noAttempt = proof(p, 1); delete noAttempt.attempt;
      await expect(complete(s.key, noAttempt)).rejects.toThrow(/late/);
      expect(await fail(s.key, 'UPSTREAM_5XX', 1)).toMatchObject({ late: true, retry: false });
      expect(await fail(s.key, 'VALIDATION_ERROR', 1)).toMatchObject({ late: true, retry: false });
      expect(await fail(s.key, 'VALIDATION_ERROR', null)).toMatchObject({ late: true });
      expect(await handoff(s.key)).toMatchObject({ status: 'DISPATCHING', a: 2, stopped: false });
      expect(await openExceptions(s.quote)).toEqual([]);
      expect(await complete(s.key, proof(p, 2))).toMatchObject({ status: 'RECORDED' });
      expect(await fail(s.key, 'UPSTREAM_5XX', 2)).toMatchObject({ late: true });   // after DONE too
      expect(await handoff(s.key)).toMatchObject({ status: 'DONE' });
    });
  });

  describe('workflow 10: the quote look-up and create fail safely', () => {
    const answers: [string, () => Res][] = [
      ['a timeout', () => { throw new Error('ETIMEDOUT: socket hang up'); }],
      ['HTTP 429', () => ({ statusCode: 429, body: { errors: [{ error: 'RATE_LIMIT' }] }, headers: { 'retry-after': '30' } })],
      ['HTTP 502', () => ({ statusCode: 502, body: 'Bad Gateway' })],
      ['a malformed 200 (no records)', () => ({ statusCode: 200, body: {} })],
      ['a malformed 200 (text)', () => ({ statusCode: 200, body: '<html>oops</html>' })],
    ];
    const classes = ['TIMEOUT', 'RATE_LIMITED', 'UPSTREAM_5XX', 'RECONCILIATION_MISMATCH', 'RECONCILIATION_MISMATCH'];
    it.each(answers.map((a, i) => [a[0], a[1], classes[i]!] as const))('%s from the look-up or the create: recorded as a failure of that attempt (%s), nothing more written, never DONE', async (_w, answer, cls) => {
      for (const step of ['find', 'create'] as const) {
        const s = await sentQuote();
        const air = new FakeAirtable(step === 'find' ? 'F1' : 'F2');
        let quoteCalls = 0;
        air.override = (req) => {
          if (!req.url.includes(QUOTES)) return undefined;
          quoteCalls++;
          return (step === 'find' && req.method === 'GET') || (step === 'create' && req.method === 'POST') ? answer() : undefined;
        };
        await start(worker(air), s);
        expect(failures(s.key), step).toEqual([{ cls, attempt: '1' }]);
        expect(quoteCalls, step).toBe(step === 'find' ? 1 : 2);                      // no read-back after the failure
        expect(sql.some((x) => x.q.includes('wf_complete_side_effect') && x.p[0] === s.key), step).toBe(false);
        expect((await handoff(s.key)).status, step).not.toBe('DONE');
      }
    });

    it('two Airtable quote records for one quote: nothing is written, the hand-off stops (AMBIGUOUS_WRITE) and a person is told', async () => {
      const s = await sentQuote();
      const air = new FakeAirtable('A1');
      const p = await payload(s.key);
      for (const id of ['recA1DUPLICATE001', 'recA1DUPLICATE002']) air.table(QUOTES).set(id, { id, fields: { ...(p.quote_fields as R) } });
      await start(worker(air), s);
      expect(air.writes.filter((w) => w.table === QUOTES)).toEqual([]);
      expect(await handoff(s.key)).toMatchObject({ status: 'FAILED', stopped: true });
      expect((await openExceptions(s.quote)).map((e) => e.error_class)).toEqual(['AMBIGUOUS_WRITE']);
    });

    it('a quote record is created once with every field, Status Sent and its links; the next attempt finds it and writes nothing', async () => {
      const s = await sentQuote();
      const air = new FakeAirtable('C1');
      air.override = (req) => (req.method === 'GET' && /\/rec\w+$/.test(req.url) && req.url.includes('tblSYcCqId9wTMg3c') ? { statusCode: 503, body: 'down' } : undefined);
      await start(worker(air), s);                                               // created, then the property read-back fails
      expect(air.writes.filter((w) => w.table === QUOTES).map((w) => w.method)).toEqual(['POST']);
      const rec = air.quotes()[0]!;
      const p = await payload(s.key);
      expect(rec.fields).toMatchObject({ ...(p.quote_fields as R), [STATUS]: 'Sent' });
      expect(await handoff(s.key)).toMatchObject({ status: 'FAILED', a: 1 });
      air.override = () => undefined; await due(s.key);
      await start(worker(air), s);
      expect(air.writes.filter((w) => w.table === QUOTES).map((w) => w.method)).toEqual(['POST']);   // not written again
      expect(await handoff(s.key)).toMatchObject({ status: 'DONE', a: 2, result: { quote_record_id: rec.id, quote_record_count: 1 } });
    });
  });

  describe('Factory 3: the manual re-queue', () => {
    const requeue = (quote: string, exc = 'EXC-0000') => one(readFileSync('ops/requeue-quote-publish.sql', 'utf8').replace(`'Q-2026-0066'`, `'${quote}'`).replace(`'EXC-0000'`, `'${exc}'`));
    /** A stopped hand-off of an earlier version, as a revision before 20261017060000 left it (a sent quote can no longer be revised). */
    const legacyV1 = async (s: { quote: string; key: string }) => {
      const p = await payload(s.key);
      const k = `${s.key}:legacy-v1`;
      await db.query(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, created_at)
        select 'airtable.quote_publish', 'quote', id, gen_random_uuid(), $2, $3::jsonb, now() - interval '1 day' from quotes where quote_number = $1`,
        [s.quote, k, JSON.stringify({ ...p, quote_fields: { ...(p.quote_fields as R), [VERSION]: 0, [AMOUNT]: 1 } })]);
      await db.query(`update outbox set status = 'DISPATCHING', attempts = 1 where idempotency_key = $1`, [k]);
      await db.query(`update outbox set status = 'FAILED', next_attempt_at = 'infinity', last_error = 'superseded by version 1 (a new hand-off)' where idempotency_key = $1`, [k]);
      return k;
    };
    const stopNow = async (key: string) => { await claim(key); expect(await fail(key, 'VALIDATION_ERROR', Number((await handoff(key)).a))).toMatchObject({ retry: false }); };

    it('a superseded hand-off is never revived: latest DONE -> refused; latest stopped -> only the latest is re-queued; latest retrying -> refused (no unique-index error)', async () => {
      const done = await sentQuote();
      await claim(done.key); await complete(done.key, proof(await payload(done.key), 1));
      const oldDone = await legacyV1(done);
      expect(await requeue(done.quote)).toMatchObject({ requeued: 0, refused_because: expect.stringMatching(/DONE, not stopped/) as unknown });
      expect(await handoff(oldDone)).toMatchObject({ status: 'FAILED', stopped: true });

      const stopped = await sentQuote();
      await stopNow(stopped.key);
      const oldStopped = await legacyV1(stopped);
      const exc = String((await one(`select e.exception_number from workflow_exceptions e join quotes q on q.id = e.entity_id where q.quote_number = $1 and e.resolution_status = 'OPEN'`, [stopped.quote])).exception_number);
      expect(await requeue(stopped.quote, exc)).toEqual({ requeued: 1, exceptions_queued: 1, audited: 1, refused_because: null });
      expect(await handoff(stopped.key)).toMatchObject({ status: 'PENDING' });
      expect(await handoff(oldStopped)).toMatchObject({ status: 'FAILED', stopped: true });
      expect(await requeue(stopped.quote, exc)).toMatchObject({ requeued: 0, refused_because: expect.stringMatching(/PENDING, not stopped/) as unknown });   // twice: refused

      const retrying = await sentQuote();
      await stopNow(retrying.key);
      const oldRetrying = await legacyV1(retrying);
      await db.query(`update outbox set next_attempt_at = now() + interval '1 hour' where idempotency_key = $1`, [retrying.key]);   // the latest is due a retry
      expect(await requeue(retrying.quote)).toMatchObject({ requeued: 0, refused_because: expect.stringMatching(/not stopped/) as unknown });
      expect(await handoff(oldRetrying)).toMatchObject({ status: 'FAILED', stopped: true });
    });

    it('refused for a quote that is not sent, for a hand-off of another version, and when another hand-off of the quote is open', async () => {
      const lost = await sentQuote();
      await stopNow(lost.key);
      await db.query(`update quotes set status = 'LOST', lost_reason = 'Customer went elsewhere' where quote_number = $1`, [lost.quote]);
      expect(await requeue(lost.quote)).toMatchObject({ requeued: 0, refused_because: expect.stringMatching(/lost, not sent/) as unknown });
      expect(await handoff(lost.key)).toMatchObject({ status: 'FAILED', stopped: true });

      const behind = await sentQuote();
      await stopNow(behind.key);
      await db.query(`update outbox set payload = jsonb_set(payload, '{quote_fields,${VERSION}}', '0') where idempotency_key = $1`, [behind.key]);   // a hand-off of another version
      expect(await requeue(behind.quote)).toMatchObject({ requeued: 0, refused_because: expect.stringMatching(/version 0, the quote is at version 1/) as unknown });
      expect(await handoff(behind.key)).toMatchObject({ status: 'FAILED', stopped: true });

      expect(await requeue('Q-1999-0001')).toMatchObject({ requeued: 0, refused_because: 'no such quote' });
      // The database itself still refuses a second open hand-off for one quote (20261017050000).
      const s = await sentQuote();
      await expect(db.query(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload)
        select 'airtable.quote_publish', 'quote', id, gen_random_uuid(), 'pl:second-open', '{}' from quotes where quote_number = $1`, [s.quote])).rejects.toThrow(/duplicate key|one_open/);
    });
  });

  it('Build Quote sends every field with Status: the request is only ever used to create a record', async () => {
    const r = new N8nRun(recorded.nodes, recorded.edges, { db: { query: () => { throw new Error('no db'); } } as unknown as Db, http: () => { throw new Error('no http'); } });
    for (const attempt of [1, 2, 5]) {
      r.seed('Claim Quote Publish', [{ json: { c: { claimed: true, attempt, payload: { quote_fields: { [STATUS]: 'Sent', [VERSION]: 1 }, write_status: false } } } }]);
      r.seed('Build Property', [{ json: { ok: true, customer_record_id: 'recC0000000000001' } }]);
      await r.run('Build Quote', [{ json: { statusCode: 200, body: { records: [{ id: 'recP0000000000001' }] } } }], recorded.edges.filter((e) => e.from === 'Build Quote').map((e) => e.to));
      const req = (r.out.get('Build Quote')![0]!.json as R).request as R;
      expect(req, `attempt ${attempt}`).not.toHaveProperty('performUpsert');
      expect((req.records as { fields: R }[])[0]!.fields).toMatchObject({ [STATUS]: 'Sent', [VERSION]: 1 });
    }
  });
});
