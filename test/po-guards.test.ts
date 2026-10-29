/**
 * AC-21 (docs/adversarial-test-catalogue.md AC-21): purchase orders still moved forward on a cancelled job, and an imported
 * Draft order could be approved by an Airtable user RoofOps cannot attribute, with no approver recorded.
 *
 * Rules (migration 20261022040000): once the job is Cancelled or Closed, an order on it may only be cancelled and its
 * Expected Delivery is locked (the supplier reference stays editable); approving an order needs an Airtable user mapped to
 * an active RoofOps employee, whatever the order's origin (ADR-015's IMPORT exemption covers only historical approvals).
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const T = { projects: 'tblvUPIoebC3zoacv', pos: 'tbluIbl4zpMiAlMVw' };
const F = { pStatus: 'fldi2Qwz1dAh2tcTE', pReason: 'fld5MhzMBtA4CBUHo', poStatus: 'fldMtDddp1Rm4tDHf', poEta: 'fldqkJourPRGAcJya', poRef: 'fldJ4Z5Rg5adnEFU0' };
const APPROVER = 'usr7uCnNO15fCefbH';            // mapped to EMP-900
const UNMAPPED = 'usrUNMAPPEDUSER01';
const recFor = (key: string) => `rec${createHash('md5').update(key).digest('hex').slice(0, 14)}`;

describe.each(TARGETS)('AC-21: purchase orders follow their job [%s]', (target) => {
  let db: Db;
  let seq = 0;
  const q = (sql: string, p: unknown[] = []) => db.query<R>(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0]!;
  const force = async (sql: string, p: unknown[] = []) => {
    await db.exec(`set session_replication_role = replica`);
    try { await q(sql, p); } finally { await db.exec(`set session_replication_role = origin`).catch(() => undefined); }
  };
  /** An Airtable edit exactly as n8n 06 hands it over. */
  const change = async (table: string, key: string, fields: R, actor = APPROVER) => {
    seq += 1;
    return (await one(`select wf_airtable_change($1::jsonb, 'test') r`, [JSON.stringify({
      event_id: `airtable:achAC21:txn${String(seq)}:${recFor(key)}`, source: 'airtable', actor_id: actor,
      occurred_at: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString(), table_id: table, record_id: recFor(key),
      changes: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { current: v }])), current: fields })])).r as R;
  };
  const po = (number: string, fields: R, actor?: string) => change(T.pos, number, fields, actor);
  const rejectedReason = (r: R) => ((r.rejected as { reason?: string }[] | undefined) ?? [])[0]?.reason ?? '';
  const poRow = async (number: string) => one(`select po.status, po.record_origin, po.expected_delivery_date::text eta, po.supplier_reference ref,
      e.employee_code approver from purchase_orders po left join employees e on e.id = po.approved_by where po.po_number = $1`, [number]);

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects
                   union all
                   select 'AIRTABLE', 'purchase_order', id, 'Record', 'rec' || substr(md5(po_number), 1, 14), now(), now() from purchase_orders`);
  }, 120_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.exec('begin'); });
  afterEach(async () => { await db.exec('rollback'); });

  it('the reproduction: PRJ-2026-0009 (Planning) has PO-2026-0009 Sent; PO-2026-0012 is an imported Draft', async () => {
    expect(await one(`select status from projects where project_number = 'PRJ-2026-0009'`)).toEqual({ status: 'PLANNING' });
    expect(await poRow('PO-2026-0009')).toMatchObject({ status: 'SENT' });
    expect(await poRow('PO-2026-0012')).toMatchObject({ status: 'DRAFT', record_origin: 'IMPORT', approver: null });
  });

  it('after the job is cancelled, its order cannot move forward and Airtable is put back; cancelling it still works', async () => {
    expect(await change(T.projects, 'PRJ-2026-0009', { [F.pStatus]: 'Cancelled', [F.pReason]: 'Customer withdrew' })).toMatchObject({ outcome: 'APPLIED' });
    for (const to of ['Delivered', 'Acknowledged', 'Partially Delivered']) {
      const r = await po('PO-2026-0009', { [F.poStatus]: to });
      expect([to, r.outcome, rejectedReason(r)]).toEqual([to, 'REJECTED', 'PRJ-2026-0009 is cancelled: an order for it can only be cancelled']);
      expect(r.corrections).toMatchObject({ [F.poStatus]: 'Sent' });
    }
    expect(await poRow('PO-2026-0009')).toMatchObject({ status: 'SENT' });
    expect(await po('PO-2026-0009', { [F.poStatus]: 'Cancelled' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await poRow('PO-2026-0009')).toMatchObject({ status: 'CANCELLED' });
  });

  it('after the job is cancelled, the Expected Delivery is locked; the supplier reference still records', async () => {
    await change(T.projects, 'PRJ-2026-0009', { [F.pStatus]: 'Cancelled', [F.pReason]: 'Customer withdrew' });
    const before = await poRow('PO-2026-0009');
    const r = await po('PO-2026-0009', { [F.poEta]: '2026-10-20' });
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', 'the delivery date is locked: PRJ-2026-0009 is cancelled']);
    expect((await poRow('PO-2026-0009')).eta).toBe(before.eta);
    expect(await po('PO-2026-0009', { [F.poRef]: 'SUP-CANCEL-1' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await poRow('PO-2026-0009')).toMatchObject({ ref: 'SUP-CANCEL-1' });
  });

  it('a closed job is the same: only Cancelled', async () => {
    await force(`update projects set status = 'CLOSED', actual_start_date = date '2026-10-01', actual_completion_date = date '2026-10-02'
                 where project_number = 'PRJ-2026-0009'`);
    expect(rejectedReason(await po('PO-2026-0009', { [F.poStatus]: 'Delivered' }))).toBe('PRJ-2026-0009 is closed: an order for it can only be cancelled');
  });

  it('an imported Draft order needs a RoofOps approver: an unmapped user is refused, a mapped one is recorded', async () => {
    const r = await po('PO-2026-0012', { [F.poStatus]: 'Approved' }, UNMAPPED);
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', 'only a RoofOps approver can approve a purchase order']);
    expect(r.corrections).toMatchObject({ [F.poStatus]: 'Draft' });
    expect(await poRow('PO-2026-0012')).toMatchObject({ status: 'DRAFT', approver: null });
    expect(await po('PO-2026-0012', { [F.poStatus]: 'Approved' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await poRow('PO-2026-0012')).toMatchObject({ status: 'APPROVED', approver: 'EMP-900' });
  });

  it('an order on a live job is unchanged: it moves forward as before', async () => {
    expect(await po('PO-2026-0009', { [F.poStatus]: 'Acknowledged' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await po('PO-2026-0009', { [F.poEta]: '2026-10-20' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await poRow('PO-2026-0009')).toMatchObject({ status: 'ACKNOWLEDGED', eta: '2026-10-20' });
  });
});
