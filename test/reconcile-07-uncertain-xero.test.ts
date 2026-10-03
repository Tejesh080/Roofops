/**
 * AC-04, the n8n 07 side: the REAL node definitions of [RoofOps] 07 (n8n/07-reconcile.sdk.ts, loaded through a recorder)
 * run offline against a test database and a fake Xero. From "Read Request" and "Start Reconciliation Run" through
 * "External Objects To Check" and the new uncertain-Xero lookups to "Settle Uncertain Xero Writes In Postgres", items
 * follow 07's own connections. The fake Xero records every request: the lookups must be read-only GETs, by the
 * deterministic invoice number and, independently, by reference, in the write's bound (pinned) tenant.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { InvoiceRows } from './helpers/airtable04.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';
import { recorded } from './helpers/n8n-sdk-shim.js';
import { N8nRun, type HttpRequest, type Item } from './helpers/n8n-runner.js';

type R = Record<string, unknown>;
const APPROVER = 'usr7uCnNO15fCefbH';
const A = '11111111-2222-3333-4444-555555555555';   // pinned, and every write's bound tenant
const B = '99999999-8888-7777-6666-555555555555';
const TOKEN = 'test-operator-token';
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;
const uuidFor = (seed: string) => createHash('md5').update(seed).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const UNCERTAIN = ['Uncertain Xero Writes To Look Up', 'Any Uncertain Xero Writes?', 'Look Up Uncertain By Invoice Number', 'Look Up Uncertain By Reference',
  'Settle Uncertain Xero Writes In Postgres'];

/** Fake Xero: GET /Invoices by InvoiceNumbers or by where Reference=="…", per tenant; failures can be injected. */
class FakeXero {
  readonly requests: HttpRequest[] = [];
  readonly invoices = new Map<string, R[]>();
  fail: ((req: HttpRequest) => { statusCode: number } | 'network' | null) = () => null;
  handle = (req: HttpRequest) => {
    this.requests.push(req);
    const f = this.fail(req);
    if (f === 'network') throw new Error('ETIMEDOUT: socket hang up');
    if (f) return { statusCode: f.statusCode, body: { Title: 'injected', Status: f.statusCode } };
    if (req.method !== 'GET' || req.url !== 'https://api.xero.com/api.xro/2.0/Invoices') return { statusCode: 400, body: { Message: 'unexpected request' } };
    const all = this.invoices.get(req.headers['xero-tenant-id'] ?? '') ?? [];
    const statuses = (req.query.Statuses ?? '').split(',');
    let found = all.filter((i) => statuses.includes(String(i.Status)));
    if (req.query.InvoiceNumbers) found = found.filter((i) => req.query.InvoiceNumbers!.split(',').includes(String(i.InvoiceNumber)));
    else if (req.query.where) {
      const ref = /Reference=="([^"]*)"/.exec(req.query.where)?.[1];
      found = found.filter((i) => i.Type === 'ACCREC' && i.Reference === ref);
    } else return { statusCode: 400, body: { Message: 'no filter' } };
    return { statusCode: 200, body: { Invoices: found } };
  };
}

describe.each(TARGETS)('[RoofOps] 07 settles uncertain Xero writes, offline [%s]', (target) => {
  const rows = new InvoiceRows();
  let n = 0;
  let db: Db;
  let xero: FakeXero;

  beforeAll(async () => {
    const sdk = '../n8n/07-reconcile.sdk.ts';                                       // a variable: typecheck does not follow it into n8n's SDK
    await import(/* @vite-ignore */ sdk);                                          // records 07's nodes and connections
  });
  beforeEach(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`update app_settings set value = '${A}' where key = 'xero.demo_tenant_id';
                   update app_settings set value = encode(sha256(convert_to('${TOKEN}', 'UTF8')), 'hex') where key = 'reconcile.trigger_token_sha256';
                   insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
    xero = new FakeXero();
  }, 120_000);
  afterEach(async () => { await db.close(); });

  const q1 = async (sql: string, p: unknown[] = []) => (await db.query<{ r: R }>(sql, p))[0]!.r;
  /** Approve PRJ's final invoice (as 04 does), claim it, lose the create answer, and fail it until dead-lettered: UNKNOWN. */
  const uncertainWrite = async (project: string, dead = true) => {
    const ev = (type: string, dt = 0) => ({ event_id: `EVT-07U-${String(++n)}`, event_type: type, source: 'airtable', actor_id: APPROVER,
      occurred_at: new Date(Date.now() + dt).toISOString(), payload: { project_number: project, airtable_record_id: recFor(project) } });
    await rows.send(db, ev('invoice.prepare_requested'), 'n8n:test');
    const r = await rows.send(db, ev('invoice.approved', 1000), 'n8n:test');
    const [job] = await db.query<{ key: string; payload: R }>(`select idempotency_key key, payload from outbox where aggregate_id = $1`, [r.invoice_id]);
    const a = { project, invoice: String(r.invoice_number), id: String(r.invoice_id), key: job!.key, payload: job!.payload };
    await q1(`select wf_claim_side_effect($1, 'n8n:05', 120) r`, [a.key]);
    await q1(`select wf_fail_side_effect($1, 'TIMEOUT', 'create draft invoice: ETIMEDOUT after 20s', null, 0) r`, [a.key]);
    for (let i = 0; dead && i < 4; i++) {
      await db.query(`update outbox set next_attempt_at = now() where idempotency_key = $1`, [a.key]);
      await q1(`select wf_claim_side_effect($1, 'n8n:05', 120) r`, [a.key]);
      await q1(`select wf_fail_side_effect($1, 'RATE_LIMITED', 'search by invoice number: HTTP 429', 429, 0) r`, [a.key]);
    }
    return a;
  };
  /** A draft as Xero's GET /Invoices returns it: the live probe (execution 2141) showed the field set; SentToContact is omitted unless true. */
  const draft = (a: { id: string; payload: R }, o: R = {}) => ({ InvoiceID: uuidFor(`x:${a.id}:${JSON.stringify(o)}`), InvoiceNumber: a.payload.xero_invoice_number,
    Reference: a.payload.reference, Type: 'ACCREC', Status: 'DRAFT', Total: a.payload.amount_inc_gst, TotalTax: a.payload.gst_amount, AmountPaid: 0,
    CurrencyCode: 'AUD', LineAmountTypes: 'Inclusive', Contact: { ContactID: uuidFor(`c:${String(a.payload.customer_id)}`), ContactNumber: a.payload.xero_contact_number }, ...o });
  /** Rows that must not change in a dry run: the invoice, its outbox row, its approval and its Xero links. */
  const snapshot = (a: { id: string }) => col(db, `select to_jsonb(i)::text || to_jsonb(o)::text || to_jsonb(ap)::text
      || coalesce((select jsonb_agg(to_jsonb(l) order by l.provider, l.external_type)::text from external_links l where l.entity_id = i.id), '') v
      from invoices i join outbox o on o.aggregate_id = i.id join approvals ap on ap.id = i.approval_id where i.id = $1`, [a.id]);
  const state = async (a: { id: string }) => (await db.query<R>(`select i.sync_status, o.status outbox, ap.status approval,
      (select external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id) xero_link
      from invoices i join outbox o on o.aggregate_id = i.id join approvals ap on ap.id = i.approval_id where i.id = $1`, [a.id]))[0]!;
  const exceptions = (a: { invoice: string }) => col(db, `select error_class v from workflow_exceptions where business_reference = $1 and resolution_status = 'OPEN' order by created_at`, [a.invoice]);

  /**
   * One 07 run, real nodes: Read Request -> Start Reconciliation Run -> External Objects To Check, then (after the
   * Drive and linked-Xero checks, which these tests do not exercise) Record Xero Findings -> the uncertain lookups ->
   * Settle, stopping at List Airtable Webhooks. `tamper` may rewrite the targets (to simulate a wrong tenant).
   */
  const run07 = async (mode: 'repair' | 'observe', tamper?: (t: R) => void) => {
    await db.exec(`update reconciliation_runs set started_at = started_at - interval '10 minutes', status = case when status = 'RUNNING' then 'FAILED' else status end`);
    const r = new N8nRun(recorded.nodes, recorded.edges, { db, http: xero.handle });
    const trigger: Item[] = mode === 'repair' ? [{ json: {} }] : [{ json: { headers: { 'x-roofops-token': TOKEN }, body: { mode: 'observe' } } }];
    await r.run('Read Request', trigger, ['Run Started?']);
    expect((r.out.get('Start Reconciliation Run')![0]!.json.r as R).started).toBe(true);
    await r.run('External Objects To Check', r.out.get('Start Reconciliation Run')!, ['Find Drive Root']);
    if (tamper) tamper(r.out.get('External Objects To Check')![0]!.json.t as R);
    r.seed('Record Xero Findings', [{ json: { r: { ok: true, verified: 0, drift: 0 } } }]);
    await r.run('Uncertain Xero Writes To Look Up', r.out.get('Record Xero Findings')!, ['List Airtable Webhooks']);
    const settled = r.out.get('Settle Uncertain Xero Writes In Postgres');
    expect(settled, 'Settle must run on every 07 run').toBeDefined();
    return { r, u: settled![0]!.json.u as R, targets: (r.out.get('External Objects To Check')![0]!.json.t as R).xero_uncertain as R[] };
  };

  it('07 wiring: Record Xero Findings -> lookups (number, then reference) -> Settle -> List Airtable Webhooks; none uncertain -> straight to Settle', () => {
    const e = (from: string, branch = 'main') => recorded.edges.filter((x) => x.from === from && x.branch === branch).map((x) => x.to);
    expect(e('Record Xero Findings')).toEqual(['Uncertain Xero Writes To Look Up']);
    expect(e('Uncertain Xero Writes To Look Up')).toEqual(['Any Uncertain Xero Writes?']);
    expect(e('Any Uncertain Xero Writes?', 'true')).toEqual(['Look Up Uncertain By Invoice Number']);
    expect(e('Any Uncertain Xero Writes?', 'false')).toEqual(['Settle Uncertain Xero Writes In Postgres']);
    expect(e('Look Up Uncertain By Invoice Number')).toEqual(['Look Up Uncertain By Reference']);
    expect(e('Look Up Uncertain By Reference')).toEqual(['Settle Uncertain Xero Writes In Postgres']);
    expect(e('Settle Uncertain Xero Writes In Postgres')).toEqual(['List Airtable Webhooks']);
    for (const name of UNCERTAIN.slice(2, 4)) {
      const node = recorded.nodes.get(name)!;
      expect((node.config.parameters as R).method, name).toBe('GET');
      expect(node.config.onError, name).toBe('continueRegularOutput');                  // a failed lookup reaches Postgres
    }
  });

  it('zero uncertain targets: no Xero request; Settle runs with nothing', async () => {
    const { r, u, targets } = await run07('repair');
    expect(targets).toEqual([]);
    expect(xero.requests).toEqual([]);
    expect(r.executed).not.toContain('Look Up Uncertain By Invoice Number');
    expect(u).toMatchObject({ ok: true, checked: 0 });
  });

  it('one target, one exact match: two read-only GETs in the pinned tenant, by number and by reference; the draft is linked, SYNCED', async () => {
    const a = await uncertainWrite('PRJ-2026-0004');
    const d = draft(a);
    xero.invoices.set(A, [d]);
    const { u, targets } = await run07('repair');
    expect(targets).toEqual([expect.objectContaining({ key: a.key, tenant_id: A })]);
    expect(xero.requests.map((q) => ({ m: q.method, t: q.headers['xero-tenant-id'], q: q.query }))).toEqual([
      { m: 'GET', t: A, q: { InvoiceNumbers: a.payload.xero_invoice_number, Statuses: 'DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED' } },
      { m: 'GET', t: A, q: { where: `Type=="ACCREC" AND Reference=="${String(a.payload.reference)}"`, Statuses: 'DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED' } },
    ]);
    expect(u).toMatchObject({ recovered: 1, items: [{ invoice_number: a.invoice, outcome: 'RECOVERED' }] });
    expect(await state(a)).toMatchObject({ sync_status: 'SYNCED', outbox: 'DONE', approval: 'EXECUTED', xero_link: d.InvoiceID });
  });

  it('no match in either successful lookup: proven absent (the dead letter fails safely)', async () => {
    const a = await uncertainWrite('PRJ-2026-0004');
    const { u } = await run07('repair');
    expect(u).toMatchObject({ proven_absent: 1, items: [{ outcome: 'PROVEN_ABSENT' }] });
    expect(await state(a)).toMatchObject({ sync_status: 'FAILED', approval: 'EXECUTION_FAILED', xero_link: null });
  });

  it('number and reference lookups disagree: a person decides, nothing linked', async () => {
    const a = await uncertainWrite('PRJ-2026-0004');
    // The number finds a draft whose reference is another project; the reference finds another invoice for this one.
    xero.invoices.set(A, [draft(a, { Reference: 'PRJ-2026-0999' }), draft(a, { InvoiceID: uuidFor('other'), InvoiceNumber: 'INV-0042' })]);
    const { u } = await run07('repair');
    expect(u).toMatchObject({ needs_person: 1, items: [{ outcome: 'NEEDS_PERSON' }] });
    expect(await state(a)).toMatchObject({ sync_status: 'UNKNOWN', xero_link: null });
    expect(await exceptions(a)).toContain('RECONCILIATION_MISMATCH');
  });

  it('multiple candidates with its number: a person decides, never a guess', async () => {
    const a = await uncertainWrite('PRJ-2026-0004');
    xero.invoices.set(A, [draft(a), draft(a, { InvoiceID: uuidFor('twin') })]);
    const { u } = await run07('repair');
    expect(u).toMatchObject({ needs_person: 1, recovered: 0 });
    expect(await state(a)).toMatchObject({ sync_status: 'UNKNOWN', xero_link: null });
  });

  it('a Xero lookup failure (429 on the number lookup, 5xx on the reference lookup, or no answer) leaves it UNKNOWN', async () => {
    const a = await uncertainWrite('PRJ-2026-0004');
    xero.invoices.set(A, [draft(a)]);
    for (const fail of [(q: HttpRequest) => (q.query.InvoiceNumbers ? { statusCode: 429 } : null), (q: HttpRequest) => (q.query.where ? { statusCode: 503 } : null),
                        (q: HttpRequest) => (q.query.InvoiceNumbers ? 'network' as const : null)]) {
      xero.fail = fail;
      const { u } = await run07('repair');
      expect(u).toMatchObject({ recovered: 0, proven_absent: 0, items: [{ outcome: 'LOOKUP_FAILED', applied: false }] });
      expect(await state(a)).toMatchObject({ sync_status: 'UNKNOWN', xero_link: null });
    }
  });

  it('wrong tenant: a lookup made in a tenant other than the bound, pinned one settles nothing, stays UNKNOWN, and opens an exception', async () => {
    const a = await uncertainWrite('PRJ-2026-0004');
    xero.invoices.set(B, [draft(a)]);
    const { u } = await run07('repair', (t) => { (t.xero_uncertain as R[]).forEach((x) => { x.tenant_id = B; }); });
    expect(xero.requests.every((q) => q.headers['xero-tenant-id'] === B)).toBe(true);
    expect(u).toMatchObject({ recovered: 0, items: [{ outcome: 'WRONG_TENANT' }] });
    expect(await state(a)).toMatchObject({ sync_status: 'UNKNOWN', xero_link: null });
    expect(await exceptions(a)).toContain('PERMISSION_DENIED');
  });

  it('a write 05 is processing (claimed) is not looked up and not touched', async () => {
    const a = await uncertainWrite('PRJ-2026-0004', false);                          // retry scheduled, UNKNOWN
    await db.query(`update outbox set next_attempt_at = now() where idempotency_key = $1`, [a.key]);
    expect(await q1(`select wf_claim_side_effect($1, 'n8n:05', 120) r`, [a.key])).toMatchObject({ claimed: true });
    xero.invoices.set(A, [draft(a)]);
    const before = await snapshot(a);
    const { u, targets } = await run07('repair');
    expect(targets).toEqual([]);
    expect(xero.requests).toEqual([]);
    expect(u).toMatchObject({ checked: 0 });
    expect(await snapshot(a)).toEqual(before);
  });

  it('dry run: it looks up, reports what it would do, and changes no invoice, outbox, approval or link', async () => {
    const a = await uncertainWrite('PRJ-2026-0004');
    xero.invoices.set(A, [draft(a)]);
    const before = await snapshot(a);
    const { u } = await run07('observe');
    expect(xero.requests).toHaveLength(2);
    expect(u).toMatchObject({ recovered: 0, items: [{ outcome: 'WOULD_RECOVER', applied: false }] });
    expect(await snapshot(a)).toEqual(before);
  });

  it('repeated repair runs are idempotent: once settled it is no longer a target, and nothing changes again', async () => {
    const a = await uncertainWrite('PRJ-2026-0004');
    xero.invoices.set(A, [draft(a)]);
    expect((await run07('repair')).u).toMatchObject({ recovered: 1 });
    const after = await snapshot(a);
    const audits = await col(db, `select count(*)::text v from audit_events`);
    xero.requests.length = 0;
    const again = await run07('repair');
    expect(again.targets).toEqual([]);
    expect(xero.requests).toEqual([]);
    expect(again.u).toMatchObject({ checked: 0 });
    expect(await snapshot(a)).toEqual(after);
    expect(await col(db, `select count(*)::text v from audit_events`)).toEqual(audits);
  });
});
