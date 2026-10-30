/**
 * AC-15 (docs/adversarial-test-catalogue.md AC-15): the Completed → Cancelled guard looked only for an invoice typed
 * FINAL, and every imported invoice is untyped. So a completed job billed to (or past) its value, such as PRJ-2026-0008
 * ($49,739.70 still owed), could be cancelled from Airtable, leaving its receivable on a Cancelled job.
 *
 * Owner rule (docs/archive/phase6-status.md §4): Completed → Cancelled is allowed until a non-void final invoice exists; earlier
 * invoices are kept. Invariant: a job whose valid bills reach what it is entitled to (AC-09 project_billing) has been
 * finally billed in substance, whatever its invoices' type, so it is not cancelled; void the bill first. A partly billed
 * job may still be cancelled (PRJ-2026-0001 was, in Phase 6). The same reading as AC-13A: fully billed is billed,
 * whatever the paperwork.
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const T_PROJECTS = 'tblvUPIoebC3zoacv';
const F = { status: 'fldi2Qwz1dAh2tcTE', reason: 'fld5MhzMBtA4CBUHo', sync: 'fldVrJOuyhbNtxnVh' };
const APPROVER = 'usr7uCnNO15fCefbH';            // mapped to EMP-900
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;

describe.each(TARGETS)('AC-15: a fully billed job is not cancelled, whatever its invoices are typed [%s]', (target) => {
  let db: Db;
  let seq = 0;
  const q = (sql: string, p: unknown[] = []) => db.query<R>(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0]!;
  const force = async (sql: string, p: unknown[] = []) => {
    await db.exec(`set session_replication_role = replica`);
    try { await q(sql, p); } finally { await db.exec(`set session_replication_role = origin`).catch(() => undefined); }
  };
  /** An Airtable Projects edit exactly as n8n 06 hands it over. */
  const change = async (project: string, fields: R) => {
    seq += 1;
    return (await one(`select wf_airtable_change($1::jsonb, 'test') r`, [JSON.stringify({
      event_id: `airtable:achAC15:txn${String(seq)}:${recFor(project)}`, source: 'airtable', actor_id: APPROVER,
      occurred_at: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString(), table_id: T_PROJECTS, record_id: recFor(project),
      changes: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { current: v }])), current: fields })])).r as R;
  };
  const cancel = (project: string) => change(project, { [F.status]: 'Cancelled', [F.reason]: 'Customer withdrew' });
  const rejectedReason = (r: R) => ((r.rejected as { reason?: string }[] | undefined) ?? [])[0]?.reason ?? '';
  const status = async (project: string) => String((await one(`select status from projects where project_number = $1`, [project])).status);
  const billing = async (project: string) => (await one(`select project_billing(id) b from projects where project_number = $1`, [project])).b as R;
  const invoiceTypes = async (project: string) => (await q(`select i.invoice_number, i.invoice_type, i.status from invoices i join projects p on p.id = i.project_id
      where p.project_number = $1 order by 1`, [project]));

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
  }, 120_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.exec('begin'); });
  afterEach(async () => { await db.exec('rollback'); });

  it('the reproduction: PRJ-2026-0008 is completed, over-billed by imported invoices that carry no type', async () => {
    expect(await status('PRJ-2026-0008')).toBe('COMPLETED');
    expect(await invoiceTypes('PRJ-2026-0008')).toEqual([
      { invoice_number: 'INV-2026-0008', invoice_type: null, status: 'PAID' },
      { invoice_number: 'INV-2026-0038', invoice_type: null, status: 'ISSUED' }]);
    expect(Number((await billing('PRJ-2026-0008')).remaining)).toBeLessThan(0);
  });

  it('an over-billed imported job: Cancelled from Airtable is refused, it stays Completed, and Airtable is put back', async () => {
    const r = await cancel('PRJ-2026-0008');
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/PRJ-2026-0008 is fully billed .*INV-2026-0038.*void .* first, then cancel/)]);
    expect(r.corrections).toMatchObject({ [F.status]: 'Completed' });
    expect(await status('PRJ-2026-0008')).toBe('COMPLETED');
  });

  it('a job billed exactly to its value is refused too (billed is billed, whatever the invoices are typed)', async () => {
    // PRJ-2026-0005 is partly billed; an untyped Issued bill for exactly what is left makes it fully billed, as an
    // imported final bill would.
    const left = String((await billing('PRJ-2026-0005')).remaining);
    await force(`insert into invoices (invoice_number, project_id, customer_id, record_origin, status, total_inc_gst, gst_amount, subtotal_ex_gst, issue_date, due_date)
                 select 'INV-TEST-UNTYPED', id, customer_id, 'IMPORT', 'ISSUED', $2::numeric, round($2::numeric * 0.1 / 1.1, 2),
                        $2::numeric - round($2::numeric * 0.1 / 1.1, 2), date '2026-09-01', date '2026-09-15'
                   from projects where project_number = $1`, ['PRJ-2026-0005', left]);
    expect(Number((await billing('PRJ-2026-0005')).remaining)).toBe(0);
    const r = await cancel('PRJ-2026-0005');
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/PRJ-2026-0005 is fully billed .*INV-TEST-UNTYPED/)]);
    expect(await status('PRJ-2026-0005')).toBe('COMPLETED');
  });

  it('the guard holds for every path: a direct UPDATE of a fully billed job is refused', async () => {
    expect(String((await one(`select project_transition_guard(p, 'CANCELLED') v from projects p where project_number = 'PRJ-2026-0008'`)).v)).toMatch(/is fully billed/);
    await expect(q(`update projects set status = 'CANCELLED' where project_number = 'PRJ-2026-0008'`)).rejects.toThrow(/is fully billed/);
  });

  it('a partly billed completed job may still be cancelled (owner rule; earlier invoices are kept)', async () => {
    const before = await invoiceTypes('PRJ-2026-0005');
    expect(Number((await billing('PRJ-2026-0005')).remaining)).toBeGreaterThan(0);
    expect(await cancel('PRJ-2026-0005')).toMatchObject({ outcome: 'APPLIED' });
    expect(await status('PRJ-2026-0005')).toBe('CANCELLED');
    expect(await invoiceTypes('PRJ-2026-0005')).toEqual(before);
  });

  it('once the excess bill is voided the job is no longer fully billed, and it may be cancelled', async () => {
    await force(`update invoices set status = 'VOIDED', voided_reason = 'test: duplicate bill' where invoice_number = 'INV-2026-0038'`);
    expect(Number((await billing('PRJ-2026-0008')).remaining)).toBeGreaterThan(0);
    expect(await cancel('PRJ-2026-0008')).toMatchObject({ outcome: 'APPLIED' });
  });

  it('a partly paid final bill is still billed: the job stays uncancellable', async () => {
    await force(`update invoices set status = 'PARTIALLY_PAID' where invoice_number = 'INV-2026-0038'`);
    const r = await cancel('PRJ-2026-0008');
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/PRJ-2026-0008 is fully billed/)]);
  });

  it('a bill that is not billed yet (draft) does not count: the job is only partly billed and may be cancelled', async () => {
    const left = String((await billing('PRJ-2026-0005')).remaining);
    await force(`insert into invoices (invoice_number, project_id, customer_id, record_origin, status, total_inc_gst, gst_amount, subtotal_ex_gst)
                 select 'INV-TEST-DRAFT', id, customer_id, 'IMPORT', 'DRAFT', $2::numeric, round($2::numeric * 0.1 / 1.1, 2), $2::numeric - round($2::numeric * 0.1 / 1.1, 2)
                   from projects where project_number = $1`, ['PRJ-2026-0005', left]);
    expect(String((await billing('PRJ-2026-0005')).remaining)).toBe(left);
    expect(await cancel('PRJ-2026-0005')).toMatchObject({ outcome: 'APPLIED' });
  });

  it('the entitlement includes approved variations: work still to bill keeps the job only partly billed', async () => {
    // PRJ-2026-0008 is over-billed by 9,947.94; an approved variation of 10,000.00 means 52.06 is still to bill.
    await force(`insert into variations (variation_number, project_id, description, amount_inc_gst, status, customer_approved_at, approved_by)
                 select 'VAR-TEST-AC15', p.id, 'Extra flashing', 10000.00, 'APPROVED', now(), (select id from employees where employee_code = 'EMP-900')
                   from projects p where p.project_number = 'PRJ-2026-0008'`);
    expect(Number((await billing('PRJ-2026-0008')).remaining)).toBeCloseTo(52.06, 2);
    expect(await cancel('PRJ-2026-0008')).toMatchObject({ outcome: 'APPLIED' });
  });

  it('a typed final invoice still refuses with its own message (unchanged)', async () => {
    await db.exec(`insert into invoices (invoice_number, project_id, customer_id, invoice_type) select 'INV-TEST-FINAL', id, customer_id, 'FINAL' from projects where project_number = 'PRJ-2026-0005'`);
    expect(rejectedReason(await cancel('PRJ-2026-0005'))).toMatch(/a final invoice \(INV-TEST-FINAL\) already exists; void it first, then cancel/);
  });

  it('integrity: a cancelled job that is fully billed is a FAIL (only reachable by bypassing the guard)', async () => {
    expect(await one(`select status from integrity_check() where check_key = 'cancelled_job_fully_billed'`)).toMatchObject({ status: 'PASS' });
    await db.exec('savepoint s');
    try {
      await force(`update projects set status = 'CANCELLED', cancellation_reason = 'bypass' where project_number = 'PRJ-2026-0008'`);
      expect(await one(`select status, refs from integrity_check() where check_key = 'cancelled_job_fully_billed'`))
        .toMatchObject({ status: 'FAIL', refs: [expect.stringMatching(/PRJ-2026-0008/) as unknown] });
    } finally { await db.exec('rollback to savepoint s'); }
  });

  /**
   * AC-15B (audit FIN-01 / CC-01): the refusal covered only Completed → Cancelled, while `cancelled_job_fully_billed`
   * FAILs for every cancelled job that is fully billed. So a job fully billed by progress or deposit bills before it was
   * completed (PRJ-2026-0012 In Progress, PRJ-2026-0015 Scheduled, PRJ-2026-0022 and PRJ-2026-0030 Materials Pending, all
   * billed exactly to their value by one untyped imported bill) could be cancelled, and the integrity check then failed.
   * The guard must not allow a state the integrity check fails: every transition into Cancelled is refused the same way.
   */
  const integrity = async () => (await one(`select status from integrity_check() where check_key = 'cancelled_job_fully_billed'`)).status;

  it.each([
    ['PRJ-2026-0012', 'IN_PROGRESS', 'In Progress'],
    ['PRJ-2026-0015', 'SCHEDULED', 'Scheduled'],
    ['PRJ-2026-0022', 'MATERIALS_PENDING', 'Materials Pending'],
    ['PRJ-2026-0030', 'MATERIALS_PENDING', 'Materials Pending'],
  ])('AC-15B: %s (%s, fully billed before completion): Cancelled from Airtable is refused, Airtable is put back, integrity stays PASS', async (project, from, label) => {
    expect(await status(project)).toBe(from);
    const b = await billing(project);
    expect([Number(b.billed) > 0, Number(b.remaining)]).toEqual([true, 0]);
    const r = await cancel(project);
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED',
      expect.stringMatching(new RegExp(`${project} is fully billed \\(billed .* against .*: INV-2026-\\d{4}\\); a fully billed job is not cancelled: void the final bill first, then cancel`))]);
    expect(r.corrections).toMatchObject({ [F.status]: label });
    expect(await status(project)).toBe(from);
    expect(await integrity()).toBe('PASS');
  });

  it('AC-15B: an On Hold job that is fully billed is refused too', async () => {
    expect(await change('PRJ-2026-0012', { [F.status]: 'On Hold', [F.reason]: 'Rain' })).toMatchObject({ outcome: 'APPLIED' });
    const r = await cancel('PRJ-2026-0012');
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/PRJ-2026-0012 is fully billed/)]);
    expect(r.corrections).toMatchObject({ [F.status]: 'On Hold' });
    expect(await status('PRJ-2026-0012')).toBe('ON_HOLD');
    expect(await integrity()).toBe('PASS');
  });

  it('AC-15B: a Planning job billed to its value by an untyped bill is refused too', async () => {
    const left = String((await billing('PRJ-2026-0009')).remaining);
    await force(`insert into invoices (invoice_number, project_id, customer_id, record_origin, status, total_inc_gst, gst_amount, subtotal_ex_gst, issue_date, due_date)
                 select 'INV-TEST-PREPAID', id, customer_id, 'IMPORT', 'ISSUED', $2::numeric, round($2::numeric * 0.1 / 1.1, 2),
                        $2::numeric - round($2::numeric * 0.1 / 1.1, 2), date '2026-09-01', date '2026-09-15'
                   from projects where project_number = $1`, ['PRJ-2026-0009', left]);
    expect(Number((await billing('PRJ-2026-0009')).remaining)).toBe(0);
    const r = await cancel('PRJ-2026-0009');
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/PRJ-2026-0009 is fully billed .*INV-TEST-PREPAID/)]);
    expect(r.corrections).toMatchObject({ [F.status]: 'Planning' });
    expect(await status('PRJ-2026-0009')).toBe('PLANNING');
  });

  it('AC-15B: the guard holds for every path: a direct UPDATE of a fully billed In Progress job is refused', async () => {
    expect(String((await one(`select project_transition_guard(p, 'CANCELLED') v from projects p where project_number = 'PRJ-2026-0012'`)).v)).toMatch(/PRJ-2026-0012 is fully billed/);
    await expect(q(`update projects set status = 'CANCELLED', cancellation_reason = 'direct' where project_number = 'PRJ-2026-0012'`)).rejects.toThrow(/is fully billed/);
  });

  it.each([
    ['PRJ-2026-0011', 'SCHEDULED'],
    ['PRJ-2026-0013', 'PLANNING'],
    ['PRJ-2026-0016', 'IN_PROGRESS'],
    ['PRJ-2026-0014', 'MATERIALS_PENDING'],
  ])('AC-15B: a partly billed job may still be cancelled from any state: %s (%s)', async (project, from) => {
    expect(await status(project)).toBe(from);
    expect(Number((await billing(project)).remaining)).toBeGreaterThan(0);
    expect(await cancel(project)).toMatchObject({ outcome: 'APPLIED' });
    expect(await status(project)).toBe('CANCELLED');
    expect(await integrity()).toBe('PASS');
  });

  it('AC-15B: a partly billed job may still be cancelled from On Hold (PRJ-2026-0016)', async () => {
    expect(await change('PRJ-2026-0016', { [F.status]: 'On Hold', [F.reason]: 'Rain' })).toMatchObject({ outcome: 'APPLIED' });
    expect(Number((await billing('PRJ-2026-0016')).remaining)).toBeGreaterThan(0);
    expect(await cancel('PRJ-2026-0016')).toMatchObject({ outcome: 'APPLIED' });
    expect(await status('PRJ-2026-0016')).toBe('CANCELLED');
    expect(await integrity()).toBe('PASS');
  });
});
