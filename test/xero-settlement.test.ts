/**
 * AC-14: a RoofOps final invoice could be authorised and paid in Xero, but RoofOps never read that back: the invoice
 * stayed APPROVED, money owed never counted it, and Completed -> Closed (every invoice PAID) was unreachable.
 *
 * Canonical mapping (only from a VERIFIED Xero read: right tenant, the linked InvoiceID, ACCREC, the expected number and
 * total, Paid + Credited + Due = Total):
 *   DRAFT / SUBMITTED, nothing paid       -> NOT_ISSUED      RoofOps APPROVED
 *   AUTHORISED, nothing paid or credited  -> UNPAID          RoofOps ISSUED
 *   AUTHORISED, 0 < AmountDue < Total     -> PARTIALLY_PAID  RoofOps PARTIALLY_PAID
 *   PAID (AmountDue 0)                    -> PAID            RoofOps PAID
 *   VOIDED                                -> VOIDED          RoofOps VOIDED (the only void allowed past AC-05's guard)
 *   DELETED                               -> a person decides; nothing changes
 *   lookup failed / wrong tenant / mismatch / inconsistent amounts -> ambiguous: recorded, never inferred, nothing changes
 * 07 (reconciliation) reads every linked invoice; a repair run applies the verified state, a dry run only records it.
 * Closing trusts only verified state: a Xero-linked invoice must be verified PAID or VOIDED recently; a local PAID flag
 * alone is never enough.
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
const A = '11111111-2222-3333-4444-555555555555';   // pinned, and the write's bound tenant
const B = '99999999-8888-7777-6666-555555555555';
const TOKEN = 'test-operator-token';
const P = 'PRJ-2026-0004';                          // imported invoices fully paid; final 14,664.49 left to bill
const XID = 'aaaaaaaa-bbbb-cccc-dddd-0000000000a4';
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;

/** Fake Xero: GET /Invoices/{InvoiceID} per tenant; failures injectable; every request recorded. */
class FakeXero {
  readonly requests: HttpRequest[] = [];
  readonly invoices = new Map<string, R>();         // `${tenant}:${InvoiceID}`
  fail: ((req: HttpRequest) => { statusCode: number } | 'network' | null) = () => null;
  handle = (req: HttpRequest) => {
    this.requests.push(req);
    const f = this.fail(req);
    if (f === 'network') throw new Error('ETIMEDOUT: socket hang up');
    if (f) return { statusCode: f.statusCode, body: { Title: 'injected', Status: f.statusCode } };
    const m = /^https:\/\/api\.xero\.com\/api\.xro\/2\.0\/Invoices\/([0-9a-f-]{36})$/.exec(req.url);
    if (req.method !== 'GET' || !m) return { statusCode: 400, body: { Message: 'unexpected request' } };
    const inv = this.invoices.get(`${req.headers['xero-tenant-id'] ?? ''}:${m[1]!}`);
    return inv ? { statusCode: 200, body: { Invoices: [inv] } } : { statusCode: 404, body: { Title: 'Not Found' } };
  };
}

describe.each(TARGETS)('AC-14: verified Xero settlement drives invoice state and project closure [%s]', (target) => {
  const rows = new InvoiceRows();
  let n = 0;
  let db: Db;
  let xero: FakeXero;
  let fin: { id: string; number: string; total: number; xeroNumber: string };

  beforeAll(async () => {
    const sdk = '../n8n/07-reconcile.sdk.ts';                                       // a variable: typecheck does not follow it into n8n's SDK
    await import(/* @vite-ignore */ sdk);
  });
  const q1 = async (sql: string, p: unknown[] = []) => (await db.query<{ r: R }>(sql, p))[0]!.r;
  const one = async (sql: string, p: unknown[] = []) => (await db.query<R>(sql, p))[0]!;
  const force = async (sql: string, p: unknown[] = []) => {
    await db.exec(`set session_replication_role = replica`);
    try { await db.query(sql, p); } finally { await db.exec(`set session_replication_role = origin`).catch(() => undefined); }
  };

  /** PRJ-2026-0004's final invoice as RoofOps creates it: prepared, approved, claimed by 05, created as a DRAFT in tenant A, read back. */
  beforeEach(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`update app_settings set value = '${A}' where key = 'xero.demo_tenant_id';
                   update app_settings set value = encode(sha256(convert_to('${TOKEN}', 'UTF8')), 'hex') where key = 'reconcile.trigger_token_sha256';
                   insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
    const ev = (type: string, dt = 0) => ({ event_id: `EVT-14-${String(++n)}`, event_type: type, source: 'airtable', actor_id: APPROVER,
      occurred_at: new Date(Date.now() + dt).toISOString(), payload: { project_number: P, airtable_record_id: recFor(P) } });
    await rows.send(db, ev('invoice.prepare_requested'), 'n8n:test');
    const r = await rows.send(db, ev('invoice.approved', 1000), 'n8n:test');
    const [job] = await db.query<{ key: string; payload: R }>(`select idempotency_key key, payload from outbox where aggregate_id = $1`, [r.invoice_id]);
    const p = job!.payload;
    await q1(`select wf_claim_side_effect($1, 'n8n:05', 120) r`, [job!.key]);
    const done = await q1(`select wf_complete_side_effect($1, $2::jsonb) r`, [job!.key, JSON.stringify({
      verified: true, tenant_id: A, organisation_class: 'DEMO', invoice_id: XID, invoice_number: p.xero_invoice_number, reference: p.reference,
      status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false, contact_id: 'ffffffff-1111-2222-3333-444444444444',
      contact_number: p.xero_contact_number, total: p.amount_inc_gst, total_tax: p.gst_amount, currency: 'AUD', line_amount_types: 'Inclusive', matching_invoices: 1 })]);
    expect(done).toMatchObject({ status: 'RECORDED' });
    fin = { id: String(r.invoice_id), number: String(r.invoice_number), total: Number(p.amount_inc_gst), xeroNumber: String(p.xero_invoice_number) };
    xero = new FakeXero();
    xero.invoices.set(`${A}:${XID}`, xinv());
  }, 120_000);
  afterEach(async () => { await db.close(); });

  /** The invoice as Xero's GET /Invoices/{id} returns it (amounts per state). */
  const xinv = (o: R = {}) => ({ InvoiceID: XID, Type: 'ACCREC', InvoiceNumber: fin.xeroNumber, Reference: P, Status: 'DRAFT', CurrencyCode: 'AUD',
    LineAmountTypes: 'Inclusive', Date: '2026-10-06', DueDate: '2026-10-20', Total: fin.total, AmountDue: fin.total, AmountPaid: 0, AmountCredited: 0,
    Payments: [], UpdatedDateUTC: '/Date(1791244800000+0000)/', ...o });
  const paid = (amount: number, o: R = {}) => xinv({ Status: amount >= fin.total ? 'PAID' : 'AUTHORISED', AmountPaid: amount,
    AmountDue: Math.round((fin.total - amount) * 100) / 100, Payments: amount > 0 ? [{ PaymentID: 'bbbbbbbb-0000-0000-0000-000000000001', Amount: amount, Date: '2026-10-10' }] : [],
    ...(amount >= fin.total ? { FullyPaidOnDate: '2026-10-10' } : {}), ...o });
  const setX = (inv: R) => { xero.invoices.set(`${A}:${XID}`, inv); };

  /** One 07 run with the real nodes from Read Request through Record Xero Findings (linked invoices only). */
  const run07 = async (mode: 'repair' | 'observe', tamper?: (t: R) => void) => {
    await db.exec(`update reconciliation_runs set started_at = started_at - interval '10 minutes', status = case when status = 'RUNNING' then 'FAILED' else status end`);
    const r = new N8nRun(recorded.nodes, recorded.edges, { db, http: xero.handle });
    const trigger: Item[] = mode === 'repair' ? [{ json: {} }] : [{ json: { headers: { 'x-roofops-token': TOKEN }, body: { mode: 'observe' } } }];
    await r.run('Read Request', trigger, ['Run Started?']);
    await r.run('External Objects To Check', r.out.get('Start Reconciliation Run')!, ['Find Drive Root']);
    if (tamper) tamper(r.out.get('External Objects To Check')![0]!.json.t as R);
    await r.run('Xero Invoices To Read', [{ json: {} }], ['Uncertain Xero Writes To Look Up']);
    expect(r.executed, 'Record Xero Findings must run, whatever Xero answered').toContain('Record Xero Findings');
    return (r.out.get('Record Xero Findings')![0]!.json.r as R);
  };
  const inv = () => one(`select status, sync_status, voided_reason from invoices where id = $1`, [fin.id]);
  const balance = () => one(`select amount_paid::text paid, outstanding::text outstanding from v_invoice_balances where id = $1`, [fin.id]);
  const close = async () => (await one(`select project_transition_guard(p, 'CLOSED') v from projects p where project_number = $1`, [P])).v as string | null;
  const latest = () => one(`select verdict, settlement, xero_status, amount_due::text due, tenant_id from xero_invoice_observations where invoice_id = $1 order by observed_at desc, id desc limit 1`, [fin.id]);
  const audits = async () => Number((await one(`select count(*)::int n from audit_events where action = 'invoice.xero_settlement_applied' and entity_id = $1`, [fin.id])).n);
  const openExc = () => col(db, `select error_class v from workflow_exceptions where business_reference in ($1, $2) and resolution_status = 'OPEN' order by created_at`, [fin.number, P]);
  // AC-14B (integrity): the states the real nodes cannot produce - a void verified in the wrong tenant, a void of a
  // different Xero invoice, or a later verified read that contradicts the void - are inserted directly.
  const insertObs = async (o: { verdict: string; settlement: string | null; tenantId: string | null; xeroInvoiceId: string | null }) => {
    const run = (await db.query<{ id: string }>(
      `insert into reconciliation_runs (run_key, trigger, mode, status) values ('INTEG-14B-' || gen_random_uuid(), 'test', 'observe', 'COMPLETED') returning id::text id`))[0]!;
    await db.query(`insert into xero_invoice_observations (invoice_id, run_id, tenant_id, bound_tenant_id, xero_invoice_id, verdict, settlement, xero_status, detail)
                    values ($1, $2, $3, $4, $5, $6, $7, $7, 'synthetic observation for the AC-14B integrity tests')`,
      [fin.id, run.id, o.tenantId, A, o.xeroInvoiceId, o.verdict, o.settlement]);
  };
  const voidedCheck = () => one(`select status, refs from integrity_check() where check_key = 'voided_invoice_has_no_xero_write'`);
  const bypassVoid = () => force(`update invoices set status = 'VOIDED', voided_reason = 'bypass' where id = $1`, [fin.id]);

  it('1. a Xero DRAFT is NOT_ISSUED: RoofOps stays APPROVED, nothing owed, the project cannot close', async () => {
    await run07('repair');
    expect(await latest()).toMatchObject({ verdict: 'VERIFIED', settlement: 'NOT_ISSUED', xero_status: 'DRAFT', tenant_id: A });
    expect(await inv()).toMatchObject({ status: 'APPROVED', sync_status: 'SYNCED' });
    expect(await close()).toMatch(new RegExp(`${fin.number}.*not issued`));
  });

  it('2. AUTHORISED and unpaid: ISSUED, owed in full (a dry run records it but changes nothing)', async () => {
    setX(xinv({ Status: 'AUTHORISED' }));
    await run07('observe');
    expect(await latest()).toMatchObject({ verdict: 'VERIFIED', settlement: 'UNPAID' });
    expect((await inv()).status).toBe('APPROVED');                                     // dry run: recorded, not applied
    await run07('repair');
    expect(await inv()).toMatchObject({ status: 'ISSUED' });
    expect(await balance()).toEqual({ paid: '0.00', outstanding: fin.total.toFixed(2) });
    expect(await close()).toMatch(new RegExp(`${fin.number}.*unpaid`));
  });

  it('3. partially paid: PARTIALLY_PAID, outstanding is what Xero says is due', async () => {
    setX(paid(5000));
    await run07('repair');
    expect(await latest()).toMatchObject({ settlement: 'PARTIALLY_PAID', due: (fin.total - 5000).toFixed(2) });
    expect(await inv()).toMatchObject({ status: 'PARTIALLY_PAID' });
    expect(await balance()).toEqual({ paid: '5000.00', outstanding: (fin.total - 5000).toFixed(2) });
    expect(await close()).toMatch(new RegExp(`${fin.number}.*partially paid`));
  });

  it('4 + 11. fully paid and verified: PAID, nothing outstanding, and the project may close', async () => {
    setX(paid(fin.total));
    await run07('repair');
    expect(await latest()).toMatchObject({ verdict: 'VERIFIED', settlement: 'PAID', due: '0.00' });
    expect(await inv()).toMatchObject({ status: 'PAID' });
    expect(await balance()).toEqual({ paid: fin.total.toFixed(2), outstanding: '0.00' });
    expect(await close()).toBeNull();
  });

  it('5 + 13. voided in Xero: VOIDED in RoofOps (verified), a person decides the replacement; a local void without Xero proof stays refused (AC-05)', async () => {
    await expect(db.query(`update invoices set status = 'VOIDED', voided_reason = 'local attempt' where id = $1`, [fin.id])).rejects.toThrow(/Void or delete it in Xero first/);
    await run07('repair');                                                             // verified, but a DRAFT: still no local void
    await expect(db.query(`update invoices set status = 'VOIDED', voided_reason = 'local attempt' where id = $1`, [fin.id])).rejects.toThrow(/Void or delete it in Xero first/);
    setX(xinv({ Status: 'VOIDED', AmountDue: 0 }));
    await run07('repair');
    expect(await latest()).toMatchObject({ verdict: 'VERIFIED', settlement: 'VOIDED' });
    expect(await inv()).toMatchObject({ status: 'VOIDED', voided_reason: expect.stringMatching(/Voided in Xero/) as unknown });
    expect(await openExc()).toContain('EXTERNAL_MISSING');
    expect(await close()).toMatch(/left to bill/);                                     // the voided final no longer bills the customer
  });

  it('6. a payment reversed in Xero: PAID regresses to ISSUED, a person is told, and the project cannot close', async () => {
    setX(paid(fin.total));
    await run07('repair');
    expect((await inv()).status).toBe('PAID');
    setX(paid(0, { Status: 'AUTHORISED' }));
    await run07('repair');
    expect(await inv()).toMatchObject({ status: 'ISSUED' });
    expect(await openExc()).toContain('RECONCILIATION_MISMATCH');
    expect(await close()).toMatch(/unpaid/);
  });

  it('6b. a regression on an already CLOSED project is an integrity FAIL', async () => {
    setX(paid(fin.total));
    await run07('repair');
    await db.query(`update projects set status = 'CLOSED' where project_number = $1`, [P]);
    expect((await one(`select status from integrity_check() where check_key = 'closed_project_settled'`)).status).toBe('PASS');
    setX(paid(0, { Status: 'AUTHORISED' }));
    await run07('repair');
    expect(await one(`select status, refs from integrity_check() where check_key = 'closed_project_settled'`)).toMatchObject({ status: 'FAIL', refs: [P] });
  });

  it('7. a Xero lookup failure (HTTP 500, or a network error) is recorded, never inferred; the run goes on; closing waits', async () => {
    setX(paid(fin.total));
    await run07('repair');
    expect((await inv()).status).toBe('PAID');
    xero.fail = () => ({ statusCode: 500 });
    await run07('repair');
    expect(await latest()).toMatchObject({ verdict: 'LOOKUP_FAILED', settlement: null });
    expect((await inv()).status).toBe('PAID');                                         // unchanged
    expect(await close()).toMatch(/last Xero check failed/);
    xero.fail = () => 'network';
    await run07('repair');
    expect(await latest()).toMatchObject({ verdict: 'LOOKUP_FAILED' });
  });

  it('8 + 14. the wrong tenant: a read in another tenant, or the pin moved after the write, is refused and changes nothing (AC-06)', async () => {
    xero.invoices.set(`${B}:${XID}`, paid(fin.total));
    await run07('repair', (t) => { for (const x of t.xero as R[]) x.tenant_id = B; });
    expect(await latest()).toMatchObject({ verdict: 'WRONG_TENANT', settlement: null });
    expect((await inv()).status).toBe('APPROVED');
    expect(await openExc()).toContain('PERMISSION_DENIED');
    await db.query(`update app_settings set value = $1 where key = 'xero.demo_tenant_id'`, [B]);       // the write is DONE: the pin may move (AC-06)
    await run07('repair');
    expect(await latest()).toMatchObject({ verdict: 'WRONG_TENANT' });
    expect((await inv()).status).toBe('APPROVED');
    expect(await close()).not.toBeNull();
  });

  it('9. repeated reconciliation is idempotent: one transition, one audit, the same state', async () => {
    setX(paid(fin.total));
    await run07('repair');
    await run07('repair');
    await run07('repair');
    expect(await inv()).toMatchObject({ status: 'PAID' });
    expect(await audits()).toBe(2);                                                    // APPROVED -> ISSUED -> PAID, once
    expect(Number((await one(`select count(*)::int n from xero_invoice_observations where invoice_id = $1`, [fin.id])).n)).toBe(3);
  });

  it('10. paid after RoofOps last looked: closing is refused on the stale observation until reconciliation verifies the payment', async () => {
    setX(xinv({ Status: 'AUTHORISED' }));
    await run07('repair');
    setX(paid(fin.total));                                                             // paid in Xero; RoofOps has not looked yet
    expect(await close()).toMatch(/unpaid/);
    await run07('repair');
    expect(await close()).toBeNull();
  });

  it('11. closing never trusts a local PAID flag or an old verification', async () => {
    await force(`update invoices set status = 'PAID' where id = $1`, [fin.id]);           // PAID locally, never verified in Xero
    expect(await close()).toMatch(new RegExp(`${fin.number}.*not verified`));
    setX(paid(fin.total));
    await run07('repair');
    expect(await close()).toBeNull();
    await db.query(`update xero_invoice_observations set observed_at = observed_at - interval '3 days' where invoice_id = $1`, [fin.id]);
    expect(await close()).toMatch(/older than/);
  });

  it('identity and arithmetic: a different invoice number, or amounts that do not add up, are never applied', async () => {
    setX(paid(fin.total, { InvoiceNumber: 'RO-INV-9999' }));
    await run07('repair');
    expect(await latest()).toMatchObject({ verdict: 'MISMATCH' });
    setX(paid(fin.total, { AmountDue: 100 }));                                         // PAID with 100 still due: inconsistent
    await run07('repair');
    expect(await latest()).toMatchObject({ verdict: 'INCONSISTENT' });
    setX(paid(5000, { AmountDue: fin.total }));                                        // 5,000 paid but the whole total still due: does not add up
    await run07('repair');
    expect(await latest()).toMatchObject({ verdict: 'INCONSISTENT', settlement: null });
    expect((await inv()).status).toBe('APPROVED');
  });

  it('DELETED in Xero: a person decides; nothing changes', async () => {
    setX(xinv({ Status: 'DELETED' }));
    await run07('repair');
    expect(await latest()).toMatchObject({ verdict: 'VERIFIED', settlement: 'DELETED' });
    expect((await inv()).status).toBe('APPROVED');
    expect(await openExc()).toContain('EXTERNAL_MISSING');
  });

  it('12. AC-04: an UNKNOWN write is never read as settled, and the project cannot close', async () => {
    setX(paid(fin.total));
    await force(`update invoices set sync_status = 'UNKNOWN' where id = $1`, [fin.id]);
    await run07('repair');
    expect((await inv()).status).toBe('APPROVED');
    expect(await close()).toMatch(/in flight or uncertain/);
  });

  it('integrity: a linked invoice whose RoofOps state differs from verified Xero state is flagged', async () => {
    setX(paid(fin.total));
    await run07('observe');
    expect(await one(`select status, refs from integrity_check() where check_key = 'xero_invoice_state_verified'`)).toMatchObject({ status: 'WARNING', refs: [expect.stringMatching(new RegExp(fin.number)) as unknown] });
    await run07('repair');
    expect((await one(`select status from integrity_check() where check_key = 'xero_invoice_state_verified'`)).status).toBe('PASS');
  });

  // AC-14B: AC-14 legitimately follows a verified Xero void (APPROVED -> VOIDED), but AC-05's integrity check still
  // called every voided, linked RoofOps invoice a failure, so the correctness gate (scripts/integrity-check.ts) went
  // red in a state the fix deliberately creates. The rule: a void is valid when the exact linked Xero invoice was
  // verified VOIDED in the invoice's bound tenant, and no later verified read of that linked invoice says otherwise.
  it('15. AC-14B: a void verified in Xero is not an integrity failure, and a later failed read does not make it one', async () => {
    setX(xinv({ Status: 'VOIDED', AmountDue: 0 }));
    await run07('repair');
    expect(await inv()).toMatchObject({ status: 'VOIDED', sync_status: 'SYNCED' });
    for (const key of ['voided_invoice_has_no_xero_write', 'xero_invoice_state_verified', 'closed_project_settled'])
      expect((await one(`select status from integrity_check() where check_key = $1`, [key])).status).toBe('PASS');
    xero.fail = () => ({ statusCode: 500 });                                           // a transient read of the now-voided invoice
    await run07('repair');
    expect(await latest()).toMatchObject({ verdict: 'LOOKUP_FAILED' });
    expect(await voidedCheck()).toMatchObject({ status: 'PASS' });                     // a Xero void is irreversible: still valid
  });

  it('16. AC-14B: the local void the guard allows (a verified Xero void, observed first) is not an integrity failure', async () => {
    setX(xinv({ Status: 'VOIDED', AmountDue: 0 }));
    await run07('observe');                                                            // recorded, never applied by a dry run
    expect(await latest()).toMatchObject({ verdict: 'VERIFIED', settlement: 'VOIDED' });
    expect((await inv()).status).toBe('APPROVED');
    await db.query(`update invoices set status = 'VOIDED', voided_reason = 'Voided in Xero by the accountant' where id = $1`, [fin.id]);
    expect(await inv()).toMatchObject({ status: 'VOIDED', voided_reason: 'Voided in Xero by the accountant' });
    expect(await voidedCheck()).toMatchObject({ status: 'PASS' });
  });

  it('17. AC-14B: a bypass void whose last verified read is not a void is still an integrity failure', async () => {
    await run07('repair');                                                             // Xero is a DRAFT: VERIFIED NOT_ISSUED
    expect(await latest()).toMatchObject({ verdict: 'VERIFIED', settlement: 'NOT_ISSUED' });
    await bypassVoid();
    expect(await voidedCheck()).toMatchObject({ status: 'FAIL', refs: [fin.number] });
  });

  it('18. AC-14B: a verified void recorded in another tenant does not excuse a bypass void', async () => {
    await insertObs({ verdict: 'VERIFIED', settlement: 'VOIDED', tenantId: B, xeroInvoiceId: XID });
    await bypassVoid();
    expect(await voidedCheck()).toMatchObject({ status: 'FAIL', refs: [fin.number] });
  });

  it('19. AC-14B: a verified void of a different Xero invoice does not excuse a bypass void', async () => {
    await insertObs({ verdict: 'VERIFIED', settlement: 'VOIDED', tenantId: A, xeroInvoiceId: 'aaaaaaaa-bbbb-cccc-dddd-0000000000ff' });
    await bypassVoid();
    expect(await voidedCheck()).toMatchObject({ status: 'FAIL', refs: [fin.number] });
  });

  it('20. AC-14B: a later verified read that contradicts the void puts the invoice back in the FAIL list', async () => {
    setX(xinv({ Status: 'VOIDED', AmountDue: 0 }));
    await run07('repair');
    expect(await voidedCheck()).toMatchObject({ status: 'PASS' });
    await insertObs({ verdict: 'VERIFIED', settlement: 'PAID', tenantId: A, xeroInvoiceId: XID });   // same linked invoice, later, PAID
    expect(await voidedCheck()).toMatchObject({ status: 'FAIL', refs: [fin.number] });
  });
});
