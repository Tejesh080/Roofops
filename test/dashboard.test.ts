import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';

const prepareEvent = (id: string, project: string) => JSON.stringify({
  event_id: id, event_type: 'invoice.prepare_requested', source: 'roofops-dashboard', actor_id: 'dashboard:copilot',
  occurred_at: '2026-09-29T09:00:00+10:00', payload: { project_number: project },
});

describe.each(TARGETS)('dashboard read models [%s]', (target) => {
  let db: Db;
  beforeAll(async () => { db = await migratedDb(target); await importBundle(db); });
  afterAll(async () => { await db.close(); });

  const row = async (project: string) =>
    (await db.query(`select * from v_dashboard_projects where project_number = $1`, [project]))[0]!;

  it('headline numbers agree with the existing executive KPIs', async () => {
    const [k] = await db.query<Record<string, string>>(`select d.active_projects::text a, d.projects_at_risk::text r, d.awaiting_materials::text m,
        d.open_exceptions::text x, e.active_projects::text ea, e.projects_at_risk::text er, e.projects_waiting_on_materials::text em,
        e.open_automation_exceptions::text ex from v_dashboard_kpis d, v_executive_kpis e`);
    expect([k!.a, k!.r, k!.m, k!.x]).toEqual([k!.ea, k!.er, k!.em, k!.ex]);
    expect(Number(await col(db, `select count(*) v from v_dashboard_projects`).then((r) => r[0]))).toBe(30);
  });

  it('ready to invoice = completed, documents in, nothing billed twice (same rule as the invoice preview)', async () => {
    expect(await col(db, `select project_number v from v_dashboard_projects where invoice_status = 'READY_TO_INVOICE' order by 1`))
      .toEqual(['PRJ-2026-0001', 'PRJ-2026-0002', 'PRJ-2026-0004', 'PRJ-2026-0005']);
    expect(await row('PRJ-2026-0004')).toMatchObject({ invoice_amount_inc_gst: expect.anything() as unknown });
    expect(Number((await row('PRJ-2026-0004')).invoice_amount_inc_gst)).toBe(14664.49);
    expect(await row('PRJ-2026-0007')).toMatchObject({ invoice_status: 'NOT_READY', invoice_blocker: expect.stringMatching(/completion documents/) as unknown });
    expect(await row('PRJ-2026-0003')).toMatchObject({ invoice_status: 'NOT_READY', invoice_blocker: expect.stringMatching(/unapproved invoices/) as unknown });
    expect(await row('PRJ-2026-0006')).toMatchObject({ invoice_status: 'FULLY_INVOICED', invoice_blocker: null });
  });

  it('needs_attention is always true/false (never unknown), so attention sorts first', async () => {
    expect(await col(db, `select count(*)::text v from v_dashboard_projects where needs_attention is null`)).toEqual(['0']);
    expect(await col(db, `select (count(*) filter (where needs_attention))::text v from v_dashboard_projects where is_active and risk_level = 'HIGH'`))
      .toEqual(await col(db, `select count(*)::text v from v_dashboard_projects where is_active and risk_level = 'HIGH'`));
  });

  it('money owed counts only invoices sent to the customer, not approved drafts', async () => {
    expect(await col(db, `select (outstanding_inc_gst = coalesce((select sum(outstanding) from v_invoice_balances b
                                   where b.project_number = d.project_number and b.status in ('ISSUED', 'PARTIALLY_PAID')), 0))::text v
                          from v_dashboard_projects d group by 1`)).toEqual(['true']);
  });

  it('risk and materials are named from facts', async () => {
    expect(await row('PRJ-2026-0011')).toMatchObject({ risk_level: 'HIGH', material_status: 'CONFIRMATION_OVERDUE' });
    expect((await row('PRJ-2026-0011')).risk_reasons).toEqual(['START_DATE_PASSED', 'SUPPLIER_ACK_OVERDUE', 'PM_FLAGGED']);
    expect(await row('PRJ-2026-0004')).toMatchObject({ material_status: 'JOB_COMPLETE', is_active: false });
    expect(await col(db, `select distinct material_status v from v_dashboard_projects where waiting_on_materials order by 1`))
      .not.toContain('DELIVERED');
  });

  describe('as the web server role', () => {
    beforeAll(async () => { await db.exec('begin; set local role roofops_dashboard;'); });
    afterAll(async () => { await db.exec('rollback'); });

    it('can read the dashboard views but no table', async () => {
      expect((await col(db, `select project_number v from v_dashboard_projects limit 1`)).length).toBe(1);
      expect((await col(db, `select kind v from v_dashboard_project_timeline limit 1`)).length).toBe(1);
      await db.exec('savepoint s');
      for (const sql of ['select * from projects limit 1', 'select * from customers limit 1', 'select * from approvals limit 1', 'select * from audit_events limit 1']) {
        await expect(db.query(sql)).rejects.toThrow(/permission denied/);
        await db.exec('rollback to savepoint s');
      }
    });

    it('can prepare a preview (the same entry point n8n uses) but can never approve or write', async () => {
      const [r] = await db.query<{ r: Record<string, unknown> }>(`select wf_invoice_prepare($1::jsonb, 'dashboard') r`, [prepareEvent('dashboard:copilot:t1', 'PRJ-2026-0005')]);
      expect(r!.r).toMatchObject({ outcome: 'PREVIEW_READY', preview: { amount_inc_gst: 17831.91, reference: 'PRJ-2026-0005' } });
      expect(await row('PRJ-2026-0005')).toMatchObject({ invoice_status: 'AWAITING_APPROVAL', pending_approval_number: r!.r.approval_number, needs_attention: true });
      expect(await col(db, `select kind v from v_dashboard_project_timeline where project_number = 'PRJ-2026-0005' and kind like 'invoice.%' order by occurred_at`))
        .toEqual(expect.arrayContaining(['invoice.prepare_requested', 'invoice.preview_prepared']));
      await db.exec('savepoint s');
      const approve = JSON.stringify({ event_id: 'dashboard:t2', event_type: 'invoice.approved', source: 'roofops-dashboard', actor_id: 'x',
                                      occurred_at: '2026-09-29T09:00:00+10:00', payload: { project_number: 'PRJ-2026-0005' } });
      for (const [sql, p] of [[`select wf_invoice_decide($1::jsonb, 'x')`, [approve]], [`select wf_invoice_prepare_core($1::jsonb, 'x')`, [approve]],
                              [`select wf_complete_side_effect('k', '{}'::jsonb)`, []], [`update app_settings set value = 'x' where key = 'xero.demo_tenant_id'`, []]] as const) {
        await expect(db.query(sql, [...p])).rejects.toThrow(/permission denied/);
        await db.exec('rollback to savepoint s');
      }
    });
  });
});
