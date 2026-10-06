/**
 * AC-14C Part B1b (docs/defect-ledger.md, the "Known follow-up" of the Part A package): a VOIDED invoice is not
 * collectible.
 *
 * AC-14C-A and AC-14B make a Xero-verified DELETED / VOIDED final invoice VOIDED in RoofOps, and AC-05 allows a
 * local void once the Xero write failed safely (dead-lettered, nothing created in Xero). In all three paths the
 * invoice is VOIDED, but v_invoice_balances kept presenting it as money owed:
 *   - the deletion path: the DELETED read is deliberately excluded from the Xero lateral (so a deletion that moved
 *     money can never zero a live debt), which leaves the local total - payments fallback: a deletion-voided final
 *     showed its whole total as outstanding (measured in Part A: 0.00 paid / 14,664.49 outstanding on a VOIDED row);
 *   - the Xero void path: RoofOps applies VOIDED from Xero's Status alone (xero_settlement), so a voided document
 *     that still carries its original amounts drove the same full outstanding;
 *   - the local dead-letter void: no Xero document exists and no read applies, so the fallback showed the whole total.
 *
 * The rule this file pins (migration 20261001160000_voided_invoice_has_no_collectible_balance.sql):
 *   v_invoice_balances keeps one row per invoice - the row, its amounts and its history stay visible - but a VOIDED
 *   invoice reports outstanding = 0 and is_overdue = false. Every other invoice keeps exactly today's semantics: the
 *   latest VERIFIED, tenant/link-bound Xero read with settlement <> 'DELETED' (amounts as Xero holds them), else the
 *   local total - payments fallback. So a refused money-moved DELETED read still cannot zero a live debt.
 * Entitlement is untouched by design: project_billing keeps the debt as "left to bill" (VOIDED is never billed), the
 * close gate keeps refusing with the left-to-bill refusal, invoice_final_preview keeps naming the voided invoice and
 * v_dashboard_projects never presents the voided generation as a live Xero draft. (VAL-BAL-006, collectibility
 * returning after a reissue, is exercised by the C lifecycle flows where the reissue facility exists.)
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { InvoiceRows } from './helpers/airtable04.js';
import { TARGETS, migratedDb } from './helpers/db.js';
import { recorded } from './helpers/n8n-sdk-shim.js';
import { N8nRun, type HttpRequest, type Item } from './helpers/n8n-runner.js';

type R = Record<string, unknown>;
const APPROVER = 'usr7uCnNO15fCefbH';
const A = '11111111-2222-3333-4444-555555555555';   // the pinned tenant and the tenant every write is bound to
const TOKEN = 'test-operator-token';
const P4 = 'PRJ-2026-0004';                          // imported invoices fully paid; final 14,664.49 left to bill
const P2 = 'PRJ-2026-0002';
const P5 = 'PRJ-2026-0005';
const XID4 = 'aaaaaaaa-bbbb-cccc-dddd-0000000000a4';
const XID2 = 'aaaaaaaa-bbbb-cccc-dddd-0000000000a2';
const XID5 = 'aaaaaaaa-bbbb-cccc-dddd-0000000000a5';
/** The dashboard states that mean "this generation is a live Xero draft"; a voided one must never show one. */
const LIVE_DRAFT_STATES = ['XERO_DRAFT_CREATED', 'CREATING_IN_XERO', 'CHECKING_WITH_XERO', 'XERO_FAILED_SAFELY'];
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

describe.each(TARGETS)('AC-14C B1b: a voided invoice has no collectible balance [%s]', (target) => {
  const rows = new InvoiceRows();
  let n = 0;
  let db: Db;
  let xero: FakeXero;
  /** A final invoice as RoofOps creates it: prepared, approved, queued; complete() then creates the DRAFT in Xero. */
  type Built = { id: string; number: string; project: string; key: string; payload: R; total: number; xeroNumber: string; xid: string };

  beforeAll(async () => {
    const sdk = '../n8n/07-reconcile.sdk.ts';                                       // a variable: typecheck does not follow it into n8n's SDK
    await import(/* @vite-ignore */ sdk);
  });
  const q1 = async (sql: string, p: unknown[] = []) => (await db.query<{ r: R }>(sql, p))[0]!.r;
  const one = async (sql: string, p: unknown[] = []) => (await db.query<R>(sql, p))[0]!;

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

  /** Prepare and approve a project's final invoice exactly as n8n 04 does; the Xero write is queued, not claimed. */
  const buildFinal = async (project: string, xid: string): Promise<Built> => {
    const ev = (type: string, dt = 0) => ({ event_id: `EVT-BAL-${String(++n)}`, event_type: type, source: 'airtable', actor_id: APPROVER,
      occurred_at: new Date(Date.now() + dt).toISOString(), payload: { project_number: project, airtable_record_id: recFor(project) } });
    expect(await rows.send(db, ev('invoice.prepare_requested'), 'n8n:test')).toMatchObject({ outcome: 'PREVIEW_READY' });
    const r = await rows.send(db, ev('invoice.approved', 1000), 'n8n:test');
    expect(r).toMatchObject({ outcome: 'APPROVED' });
    const [job] = await db.query<{ key: string; payload: R }>(`select idempotency_key key, payload from outbox where aggregate_id = $1`, [r.invoice_id]);
    const p = job!.payload;
    return { id: String(r.invoice_id), number: String(r.invoice_number), project, key: job!.key, payload: p,
      total: Number(p.amount_inc_gst), xeroNumber: String(p.xero_invoice_number), xid };
  };
  /** [RoofOps] 05 creates the draft in Xero and reads it back: the write is DONE, the link verified, sync SYNCED. */
  const complete = async (a: Built) => {
    await q1(`select wf_claim_side_effect($1, 'n8n:05', 120) r`, [a.key]);
    const done = await q1(`select wf_complete_side_effect($1, $2::jsonb) r`, [a.key, JSON.stringify({
      verified: true, tenant_id: A, organisation_class: 'DEMO', invoice_id: a.xid, invoice_number: a.xeroNumber, reference: a.payload.reference,
      status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false, contact_id: `ffffffff-1111-2222-3333-${a.xid.slice(-12)}`,
      contact_number: a.payload.xero_contact_number, total: a.payload.amount_inc_gst, total_tax: a.payload.gst_amount, currency: 'AUD',
      line_amount_types: 'Inclusive', matching_invoices: 1 })]);
    expect(done).toMatchObject({ status: 'RECORDED' });
    xero.invoices.set(`${A}:${a.xid}`, xinv(a));
  };
  /** 05 refuses the write for good (a validation error is not retryable): dead-lettered, nothing created in Xero. */
  const deadLetter = async (a: Built) => {
    await q1(`select wf_claim_side_effect($1, 'n8n:05', 120) r`, [a.key]);
    return q1(`select wf_fail_side_effect($1, 'VALIDATION_ERROR', 'create contact: Xero refused the contact', null, null) r`, [a.key]);
  };
  /** What an operator can do: void it directly (with the required reason). null on success, or Postgres's refusal. */
  const voidLocally = (a: Built) => db.query(`update invoices set status = 'VOIDED', voided_reason = 'Customer cancelled the job' where id = $1`, [a.id])
    .then(() => null, (e: unknown) => (e as Error).message);

  /** The invoice as Xero's GET /Invoices/{id} returns it (amounts per state). */
  const xinv = (a: Built, o: R = {}) => ({ InvoiceID: a.xid, Type: 'ACCREC', InvoiceNumber: a.xeroNumber, Reference: a.project, Status: 'DRAFT',
    CurrencyCode: 'AUD', LineAmountTypes: 'Inclusive', Date: '2026-10-06', DueDate: '2026-10-20', Total: a.total, AmountDue: a.total,
    AmountPaid: 0, AmountCredited: 0, Payments: [], UpdatedDateUTC: '/Date(1791244800000+0000)/', ...o });
  const paid = (a: Built, amount: number, o: R = {}) => xinv(a, { Status: amount >= a.total ? 'PAID' : 'AUTHORISED', AmountPaid: amount,
    AmountDue: Math.round((a.total - amount) * 100) / 100, Payments: amount > 0 ? [{ PaymentID: 'bbbbbbbb-0000-0000-0000-000000000001', Amount: amount, Date: '2026-10-10' }] : [],
    ...(amount >= a.total ? { FullyPaidOnDate: '2026-10-10' } : {}), ...o });
  const setX = (a: Built, inv: R) => { xero.invoices.set(`${A}:${a.xid}`, inv); };

  /** One 07 run with the real nodes from Read Request through Record Xero Findings (linked invoices only). */
  const run07 = async (mode: 'repair' | 'observe') => {
    await db.exec(`update reconciliation_runs set started_at = started_at - interval '10 minutes', status = case when status = 'RUNNING' then 'FAILED' else status end`);
    const r = new N8nRun(recorded.nodes, recorded.edges, { db, http: xero.handle });
    const trigger: Item[] = mode === 'repair' ? [{ json: {} }] : [{ json: { headers: { 'x-roofops-token': TOKEN }, body: { mode: 'observe' } } }];
    await r.run('Read Request', trigger, ['Run Started?']);
    await r.run('External Objects To Check', r.out.get('Start Reconciliation Run')!, ['Find Drive Root']);
    await r.run('Xero Invoices To Read', [{ json: {} }], ['Uncertain Xero Writes To Look Up']);
    expect(r.executed, 'Record Xero Findings must run, whatever Xero answered').toContain('Record Xero Findings');
    return (r.out.get('Record Xero Findings')![0]!.json.r as R);
  };

  const inv = (a: Built) => one(`select status, sync_status, voided_reason from invoices where id = $1`, [a.id]);
  /** The balance row as an operator reads it: money, owed and overdue (numeric(12,2) so both engines print alike). */
  const balance = (a: Built) => one(`select amount_paid::numeric(12,2)::text paid, outstanding::numeric(12,2)::text outstanding,
                                            is_overdue, days_past_due::text days
                                       from v_invoice_balances where id = $1`, [a.id]);
  const balanceRows = async (a: Built) => Number((await one(`select count(*)::int n from v_invoice_balances where id = $1`, [a.id])).n);
  const balanceRow = (a: Built) => one(`select invoice_number, status, total_inc_gst::text total from v_invoice_balances where id = $1`, [a.id]);
  const latest = (a: Built) => one(`select verdict, settlement, xero_status, amount_due::text due, tenant_id from xero_invoice_observations
                                      where invoice_id = $1 order by observed_at desc, id desc limit 1`, [a.id]);
  const obsCount = async (a: Built) => Number((await one(`select count(*)::int n from xero_invoice_observations where invoice_id = $1`, [a.id])).n);
  const applyCount = async (a: Built) => Number((await one(`select count(*)::int n from audit_events where entity_id = $1 and action = 'invoice.xero_settlement_applied'`, [a.id])).n);
  const xeroLink = (a: Built) => one(`select external_id, verified_at is not null verified from external_links
                                       where provider = 'XERO' and external_type = 'Invoice' and entity_id = $1`, [a.id]);
  const billing = async (project: string) => (await one(`select project_billing(p.id) b from projects p where p.project_number = $1`, [project])).b as R;
  const close = async (project: string) => (await one(`select project_transition_guard(p, 'CLOSED') v from projects p where p.project_number = $1`, [project])).v as string | null;
  const preview = async (project: string) => (await one(`select invoice_final_preview(p.id) x from projects p where p.project_number = $1`, [project])).x as R;
  const leftAfterFinal = async (project: string) => (await one(`select project_left_to_bill_after_final(p.id) x from projects p where p.project_number = $1`, [project])).x as R | null;
  const dash = (project: string) => one(`select invoice_status, invoice_blocker, needs_attention, final_invoice_sync, xero_invoice_id,
                                                outstanding_inc_gst, has_overdue_invoice from v_dashboard_projects where project_number = $1`, [project]);
  const overdueAmount = async () => Number((await one(`select overdue_amount from v_executive_kpis`)).overdue_amount);
  /** An invoice the customer has not paid by its due date (the row a void must stop counting as overdue money). */
  const backdate = (a: Built, daysPastDue: number) => db.query(`update invoices set issue_date = app_today() - ${daysPastDue + 20},
      due_date = app_today() - ${daysPastDue} where id = $1`, [a.id]);

  // -----------------------------------------------------------------------------------------------------------------
  // VAL-BAL-001: the AC-14C-A deletion path (verified Xero DELETED, no money movement).
  // -----------------------------------------------------------------------------------------------------------------
  it('VAL-BAL-001 a deletion-voided invoice reports outstanding 0 and is not overdue, while the row and its history stay visible', async () => {
    const a = await buildFinal(P4, XID4);
    await complete(a);
    setX(a, xinv(a, { Status: 'AUTHORISED' }));                                        // ISSUED first, overdue: the row that used to stay counted
    await run07('repair');
    await backdate(a, 5);
    expect(await inv(a)).toMatchObject({ status: 'ISSUED' });
    expect(await balance(a)).toEqual({ paid: '0.00', outstanding: a.total.toFixed(2), is_overdue: true, days: '5' });
    const overdueBefore = await overdueAmount();

    setX(a, xinv(a, { Status: 'DELETED', AmountDue: 0 }));                             // deleted in Xero, nothing paid or credited anywhere
    await run07('repair');
    expect(await latest(a)).toMatchObject({ verdict: 'VERIFIED', settlement: 'DELETED', xero_status: 'DELETED', tenant_id: A });
    expect(await inv(a)).toMatchObject({ status: 'VOIDED', sync_status: 'SYNCED',
      voided_reason: expect.stringMatching(/^Deleted in Xero \(verified by reconciliation /) as unknown });

    expect(await balance(a)).toEqual({ paid: '0.00', outstanding: '0.00', is_overdue: false, days: '5' });
    expect(await balanceRows(a)).toBe(1);                                              // the row is still there (history), it just owes nothing
    expect(await balanceRow(a)).toMatchObject({ invoice_number: a.number, status: 'VOIDED', total: a.total.toFixed(2) });
    expect(await obsCount(a)).toBe(2);                                                 // both reads stay queryable
    expect(await applyCount(a)).toBe(2);                                               // APPROVED -> ISSUED -> VOIDED, once each
    expect(await xeroLink(a)).toMatchObject({ external_id: a.xid, verified: true });   // the Xero identity is still recorded
    expect(Math.round((await overdueAmount()) * 100)).toBe(Math.round(overdueBefore * 100) - Math.round(a.total * 100));   // the executive KPIs stop counting the voided row
  });

  // -----------------------------------------------------------------------------------------------------------------
  // VAL-BAL-002: the AC-14B Xero void path, with the voided document still carrying its original amounts.
  // -----------------------------------------------------------------------------------------------------------------
  it('VAL-BAL-002 a Xero-voided invoice reports outstanding 0 and is not overdue, even when the voided document still shows its amounts', async () => {
    const a = await buildFinal(P4, XID4);
    await complete(a);
    setX(a, xinv(a, { Status: 'AUTHORISED' }));
    await run07('repair');
    await backdate(a, 5);
    expect(await balance(a)).toMatchObject({ outstanding: a.total.toFixed(2), is_overdue: true });

    setX(a, xinv(a, { Status: 'VOIDED', AmountDue: a.total }));                        // voided in Xero; the read still carries the total
    await run07('repair');
    expect(await latest(a)).toMatchObject({ verdict: 'VERIFIED', settlement: 'VOIDED', xero_status: 'VOIDED', due: a.total.toFixed(2) });
    expect(await inv(a)).toMatchObject({ status: 'VOIDED', voided_reason: expect.stringMatching(/^Voided in Xero \(verified by reconciliation /) as unknown });

    expect(await balance(a)).toEqual({ paid: '0.00', outstanding: '0.00', is_overdue: false, days: '5' });
    expect(await balanceRow(a)).toMatchObject({ status: 'VOIDED', total: a.total.toFixed(2) });
  });

  // -----------------------------------------------------------------------------------------------------------------
  // VAL-BAL-003: the local void (dead-lettered write, no Xero document, AC-05).
  // -----------------------------------------------------------------------------------------------------------------
  it('VAL-BAL-003 a locally voided invoice (dead-lettered write, no Xero document) reports outstanding 0 and is not overdue', async () => {
    const a = await buildFinal(P2, XID2);
    expect(await deadLetter(a)).toMatchObject({ retry: false });
    expect(await inv(a)).toMatchObject({ status: 'APPROVED', sync_status: 'FAILED' });
    expect(await voidLocally(a)).toBeNull();                                           // the guard allows it: nothing was created in Xero

    expect(await inv(a)).toMatchObject({ status: 'VOIDED', voided_reason: 'Customer cancelled the job' });
    expect(await obsCount(a)).toBe(0);                                                 // there is no Xero read at all
    expect(await balance(a)).toMatchObject({ paid: '0.00', outstanding: '0.00', is_overdue: false });
    expect(await balanceRows(a)).toBe(1);
    expect(await balanceRow(a)).toMatchObject({ invoice_number: a.number, status: 'VOIDED', total: a.total.toFixed(2) });
  });

  // -----------------------------------------------------------------------------------------------------------------
  // VAL-BAL-004: entitlement survives every void.
  // -----------------------------------------------------------------------------------------------------------------
  it('VAL-BAL-004 entitlement survives every void: the money stays owed, the preview names the voided invoice, and the close gate refuses', async () => {
    const d = await buildFinal(P4, XID4); await complete(d);                           // deletion void
    const x = await buildFinal(P2, XID2); await complete(x);                           // Xero void
    const l = await buildFinal(P5, XID5);                                              // local dead-letter void
    expect(await deadLetter(l)).toMatchObject({ retry: false });
    expect(await voidLocally(l)).toBeNull();
    setX(d, xinv(d, { Status: 'DELETED', AmountDue: 0 }));
    setX(x, xinv(x, { Status: 'VOIDED', AmountDue: 0 }));
    await run07('repair');

    for (const [a, project] of [[d, P4], [x, P2], [l, P5]] as const) {
      expect(await inv(a), `${project} must be voided`).toMatchObject({ status: 'VOIDED' });
      expect(await balance(a), `${project} must owe nothing`).toMatchObject({ outstanding: '0.00', is_overdue: false });
      const b = await billing(project);
      expect(Number(b.remaining), `${project} still has the debt`).toBeGreaterThan(0);  // VOIDED is not billed, so entitlement stays
      expect((b.billed_invoices as { invoice: string }[]).map((x) => x.invoice), `${project}: the voided invoice is never "billed"`).not.toContain(a.number);
      // The close gate refuses every voided project (its own progress invoice can be the first blocker for some).
      expect(String(await close(project)), `${project} cannot close while the money is owed`)
        .toMatch(/not every invoice is paid yet|left to bill/);
      const pv = await preview(project);
      expect(pv, `${project} has no second final invoice`).toMatchObject({ ok: false, final_voided: true });
      expect(String(pv.message)).toMatch(/was voided/);
      // Unchanged by design: with no live FINAL invoice there is nothing to measure "left after final" against; the
      // debt stays visible through project_billing, the preview refusal and the close gate (architecture §4.3).
      expect(await leftAfterFinal(project)).toBeNull();
    }
    // The deletion-voided project has nothing else outstanding, so the left-to-bill class is the refusal itself.
    expect(String(await close(P4))).toMatch(/left to bill/);
    // ... and its debt is exactly the entitlement it always had.
    expect(Number((await billing(P4)).remaining)).toBe(14664.49);
  });

  // -----------------------------------------------------------------------------------------------------------------
  // VAL-BAL-005: a money-moved deletion changes nothing and stays fully collectible.
  // -----------------------------------------------------------------------------------------------------------------
  it('VAL-BAL-005 a DELETED read that moved money is refused: nothing changes and the debt stays fully collectible', async () => {
    const a = await buildFinal(P4, XID4);
    await complete(a);
    setX(a, xinv(a, { Status: 'AUTHORISED' }));
    await run07('repair');
    expect(await inv(a)).toMatchObject({ status: 'ISSUED' });

    setX(a, xinv(a, { Status: 'DELETED', AmountDue: 0, AmountPaid: 5000,                                 // Xero says money moved
      Payments: [{ PaymentID: 'bbbbbbbb-0000-0000-0000-000000000002', Amount: 5000, Date: '2026-10-10' }] }));
    await run07('repair');
    expect(await latest(a)).toMatchObject({ verdict: 'VERIFIED', settlement: 'DELETED' });
    expect(await inv(a)).toMatchObject({ status: 'ISSUED', sync_status: 'SYNCED' });   // the read applied nothing
    expect(await balance(a)).toEqual({ paid: '0.00', outstanding: a.total.toFixed(2), is_overdue: false, days: '0' });
    expect(String(await close(P4))).toMatch(new RegExp(`${a.number}.*deleted in Xero`));   // fully collectible: the customer still owes it
  });

  it('VAL-BAL-005 a deletion refused for a credit or a local payment likewise writes nothing off', async () => {
    const a = await buildFinal(P4, XID4);
    await complete(a);
    setX(a, xinv(a, { Status: 'DELETED', AmountDue: 0, AmountCredited: 100 }));        // a credit is money too
    await run07('repair');
    expect(await latest(a)).toMatchObject({ verdict: 'VERIFIED', settlement: 'DELETED' });
    expect(await inv(a)).toMatchObject({ status: 'APPROVED' });
    expect(await balance(a)).toEqual({ paid: '0.00', outstanding: a.total.toFixed(2), is_overdue: false, days: '0' });

    await db.query(`insert into payments (invoice_id, amount, received_on, method, source) values ($1, 100, app_today(), 'BANK_TRANSFER', 'MANUAL')`, [a.id]);
    setX(a, xinv(a, { Status: 'DELETED', AmountDue: 0 }));
    await run07('repair');
    expect(await inv(a)).toMatchObject({ status: 'APPROVED' });                        // a local payment row blocks the write-off
    expect(await balance(a)).toEqual({ paid: '100.00', outstanding: (a.total - 100).toFixed(2), is_overdue: false, days: '0' });
    expect(await obsCount(a)).toBe(2);                                                 // both refused reads are still recorded
  });

  // -----------------------------------------------------------------------------------------------------------------
  // VAL-BAL-007: the dashboard never shows a live Xero draft for the voided generation.
  // -----------------------------------------------------------------------------------------------------------------
  it('VAL-BAL-007 the dashboard shows the voided generation truthfully, never as a live Xero draft', async () => {
    const a = await buildFinal(P4, XID4);
    await complete(a);
    expect(await dash(P4)).toMatchObject({ invoice_status: 'XERO_DRAFT_CREATED', final_invoice_sync: 'SYNCED',
      xero_invoice_id: a.xid, needs_attention: false });                               // a live draft does show as one

    setX(a, xinv(a, { Status: 'DELETED', AmountDue: 0 }));
    await run07('repair');
    const d = await dash(P4);
    expect(LIVE_DRAFT_STATES).not.toContain(d.invoice_status);
    expect(d).toMatchObject({ invoice_status: 'NOT_READY', final_invoice_sync: null, xero_invoice_id: null });
    expect(String(d.invoice_blocker)).toMatch(/was voided/);                           // the reason a person is needed
    expect(Number(d.outstanding_inc_gst)).toBe(0);
    expect(Number(d.has_overdue_invoice)).toBe(0);
  });

  // -----------------------------------------------------------------------------------------------------------------
  // The change touches VOIDED rows only: today's collectible semantics, state by state.
  // -----------------------------------------------------------------------------------------------------------------
  it('APPROVED, ISSUED, PARTIALLY_PAID and PAID rows keep exactly today\'s collectible semantics', async () => {
    const a = await buildFinal(P4, XID4);
    await complete(a);
    expect(await balance(a)).toEqual({ paid: '0.00', outstanding: a.total.toFixed(2), is_overdue: false, days: '0' });  // no read yet: the local fallback

    await run07('repair');                                                             // Xero still shows the DRAFT: NOT_ISSUED, APPROVED
    expect(await inv(a)).toMatchObject({ status: 'APPROVED' });
    expect(await balance(a)).toEqual({ paid: '0.00', outstanding: a.total.toFixed(2), is_overdue: false, days: '0' });

    setX(a, xinv(a, { Status: 'AUTHORISED' }));                                        // UNPAID -> ISSUED
    await run07('repair');
    expect(await inv(a)).toMatchObject({ status: 'ISSUED' });
    await backdate(a, 3);
    expect(await balance(a)).toEqual({ paid: '0.00', outstanding: a.total.toFixed(2), is_overdue: true, days: '3' });

    setX(a, paid(a, 5000));                                                            // PARTIALLY_PAID: outstanding is what Xero says is due
    await run07('repair');
    expect(await inv(a)).toMatchObject({ status: 'PARTIALLY_PAID' });
    expect(await balance(a)).toEqual({ paid: '5000.00', outstanding: (a.total - 5000).toFixed(2), is_overdue: true, days: '3' });

    setX(a, paid(a, a.total));                                                         // PAID: nothing outstanding
    await run07('repair');
    expect(await inv(a)).toMatchObject({ status: 'PAID' });
    expect(await balance(a)).toEqual({ paid: a.total.toFixed(2), outstanding: '0.00', is_overdue: false, days: '3' });
    expect(await close(P4)).toBeNull();                                                // and only then may the project close
  });
});
