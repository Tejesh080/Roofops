/**
 * REISSUE-UI-02 (migration 20261009040000): the dashboard says which Xero document is current and which a reissue replaced.
 * Found in the pilot rehearsal: while a reissue is queued the invoice keeps its verified link to the superseded document,
 * and v_dashboard_projects showed that VOIDED/DELETED document as the project's Xero draft ("Open in Xero" opened it).
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TARGETS, migratedDb } from './helpers/db.js';
import { deletedReissueScenario, type ReissueScenario } from './helpers/reissue-scenario.js';
import type { Db } from '../src/db/db.js';

type R = Record<string, unknown>;
const uuidFor = (seed: string) => createHash('md5').update(seed).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

describe.each(TARGETS)('dashboard: current and replaced Xero documents [%s]', (target) => {
  let db: Db; let s: ReissueScenario;
  const one = async (sql: string, p: unknown[] = []) => (await db.query<R>(sql, p))[0]!;
  const project = () => one(`select invoice_status, xero_invoice_id, xero_invoice_number from v_dashboard_projects where project_number = $1`, [s.project]);
  const history = () => db.query<R>(`select generation, status, is_current, xero_invoice_id, xero_status_verified, approval_kind, requested_by, approved_by
                                       from v_dashboard_invoice_xero_history where invoice_number = $1 order by generation`, [s.invoice.number]);

  beforeAll(async () => {
    db = await migratedDb(target);
    s = await deletedReissueScenario(db, { project: 'PRJ-2026-0002', xid: 'aaaaaaaa-bbbb-cccc-dddd-00000000e002' });
  }, 180_000);
  afterAll(async () => { await db.close(); });

  it('the dashboard role reads the history view; nothing else gains a privilege', async () => {
    const can = async (role: string) => String((await one(`select has_table_privilege('${role}', 'v_dashboard_invoice_xero_history', 'select') v`)).v);
    expect(await can('roofops_dashboard')).toBe('true');
    expect(await can('roofops_workflow')).toBe('false');
  });

  it('voided, not yet reissued: the project shows no Xero document; the history carries Xero\'s verified DELETED', async () => {
    expect((await project()).xero_invoice_id ?? null).toBeNull();
    expect(await history()).toEqual([expect.objectContaining({ generation: 1, is_current: true, xero_invoice_id: s.invoice.xid, xero_status_verified: 'DELETED',
                                                               approval_kind: 'CREATE_INVOICE' })]);
  });

  it('approved and queued: the project shows NO Xero document (never the deleted one) while it is created', async () => {
    const r = await s.request('EMP-900', 'Draft deleted in Xero by mistake; reissue the same invoice to the customer');
    expect(r).toMatchObject({ ok: true });
    expect(await s.decide(String(r.approval_number), 'EMP-901')).toMatchObject({ ok: true, generation: 2 });
    expect(await project()).toMatchObject({ invoice_status: 'CREATING_IN_XERO', xero_invoice_id: null, xero_invoice_number: null });
    // The kept link still names the deleted document (history, by design); the read model does not present it as current.
    expect(await s.link()).toBe(s.invoice.xid);
    const h = await history();
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ generation: 1, is_current: false, xero_invoice_id: s.invoice.xid, xero_status_verified: 'DELETED' });
    expect(h[1]).toMatchObject({ generation: 2, status: 'PENDING', is_current: true, xero_invoice_id: null, approval_kind: 'REISSUE_INVOICE', approved_by: 'Ada Admin' });
    expect(h[1]!.requested_by).toBeTruthy();
  });

  it('once the replacement exists in Xero it is the project\'s current document; the deleted one stays listed as replaced', async () => {
    const key = String((await one(`select xero_draft_outbox_key($1, 2) k`, [s.invoice.id])).k);
    const p = (await one(`select payload from outbox where idempotency_key = $1`, [key])).payload as R;
    expect((await one(`select wf_claim_side_effect($1, 'n8n:05', 120) c`, [key])).c).toMatchObject({ claimed: true, generation: 2 });
    const xid = uuidFor(`replacement:${s.invoice.id}`);
    await db.query(`select wf_complete_side_effect($1, $2::jsonb)`, [key, JSON.stringify({ verified: true, tenant_id: p.xero_tenant_id, organisation_class: 'DEMO',
      invoice_id: xid, invoice_number: p.xero_invoice_number, reference: p.reference, status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false,
      contact_id: uuidFor(`contact:${String(p.customer_id)}`), contact_number: p.xero_contact_number, total: p.amount_inc_gst, total_tax: p.gst_amount,
      currency: 'AUD', line_amount_types: 'Inclusive', matching_invoices: 1 })]);
    expect(await project()).toMatchObject({ invoice_status: 'XERO_DRAFT_CREATED', xero_invoice_id: xid, xero_invoice_number: p.xero_invoice_number });
    const h = await history();
    expect(h.map((g) => [g.generation, g.status, g.is_current, g.xero_invoice_id])).toEqual([[1, 'SUPERSEDED', false, s.invoice.xid], [2, 'CREATED', true, xid]]);
    expect(await s.integrityFails()).toEqual([]);
  });
});
