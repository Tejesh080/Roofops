/**
 * Phase 6 live verification on the HOSTED database (RUN_HOSTED_TESTS=1). Read-only: the one write-path check
 * (invoice preparation on a cancelled job) runs inside a transaction that is rolled back.
 *
 * PRJ-2026-0001 was set to Cancelled in Airtable before any webhook watched Projects.Status. The first reconciliation
 * (observe) reported it out of sync; the repair run replayed the edit through wf_airtable_change, i.e. the same
 * validation a staff edit gets, without any direct UPDATE. Airtable itself was read back independently (see
 * docs/phase6-status.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { HOSTED, col, openHosted } from './helpers/db.js';

describe.runIf(HOSTED)('Phase 6 live state integrity [hosted]', () => {
  let db: Db;
  beforeAll(async () => { db = await openHosted(); });
  afterAll(async () => { await db.close(); });
  const one = async (sql: string, p: unknown[] = []) => (await col(db, sql, p))[0];

  it('PRJ-2026-0001 is CANCELLED in RoofOps, with the reason, through the audited handler', async () => {
    expect(await one(`select status v from projects where project_number = 'PRJ-2026-0001'`)).toBe('CANCELLED');
    expect(await one(`select cancellation_reason v from projects where project_number = 'PRJ-2026-0001'`)).toMatch(/Cancelled in Airtable/);
    expect(await col(db, `select actor_id || '|' || (before_state ->> 'status') || '>' || (after_state ->> 'status') v from audit_events
                           where action = 'project.status.changed' and business_reference = 'PRJ-2026-0001'`)).toEqual(['reconciliation|COMPLETED>CANCELLED']);
    expect(await one(`select count(*)::text v from reconciliation_findings where entity_ref = 'PRJ-2026-0001' and action = 'APPLIED_TO_POSTGRES'`)).toBe('1');
    expect(await one(`select count(*)::text v from reconciliation_findings where entity_ref = 'PRJ-2026-0001' and action = 'NONE_OBSERVE_ONLY'`)).toBe('1');
  });

  it('the dashboard reads Cancelled, it is not ready to invoice, and Airtable was last seen agreeing', async () => {
    expect(await one(`select status || '|' || invoice_status || '|' || coalesce(airtable_status_seen, '') || '|' || drift_fields v
                      from v_dashboard_projects where project_number = 'PRJ-2026-0001'`)).toMatch(/^CANCELLED\|(?!READY_TO_INVOICE)[A-Z_]+\|Cancelled\|0$/);
    expect(await col(db, `select project_number v from v_dashboard_projects where invoice_status = 'READY_TO_INVOICE'`)).not.toContain('PRJ-2026-0001');
  });

  it('invoice preparation is refused (attempted in a rolled-back transaction)', async () => {
    await db.exec('begin');
    try {
      const [r] = await db.query<{ r: Record<string, unknown> }>(`select wf_invoice_prepare($1::jsonb, 'phase6-test') r`, [JSON.stringify({
        event_id: `phase6:prepare-cancelled:${Date.now()}`, event_type: 'invoice.prepare_requested', source: 'roofops-dashboard', actor_id: 'dashboard:copilot',
        occurred_at: new Date().toISOString(), payload: { project_number: 'PRJ-2026-0001' } })]);
      expect(r!.r.outcome).not.toBe('PREVIEW_READY');
      expect(JSON.stringify(r!.r)).toMatch(/CANCELLED; only a COMPLETED project can be final-invoiced/);
    } finally { await db.exec('rollback'); }
    expect(await one(`select count(*)::text v from approvals a join projects p on p.id = a.entity_id where p.project_number = 'PRJ-2026-0001'`)).toBe('0');
  });

  it('history is preserved: both earlier invoices are untouched', async () => {
    expect(await col(db, `select i.invoice_number || '|' || i.status v from invoices i join projects p on p.id = i.project_id
                           where p.project_number = 'PRJ-2026-0001' order by 1`)).toHaveLength(2);
  });

  it('every business rule holds and nothing is out of sync after the repair run', async () => {
    expect(await col(db, `select entity || '.' || check_key v from integrity_check() where status = 'FAIL'`)).toEqual([]);
    expect(await col(db, `select business_key || ':' || field v from v_state_drift`)).toEqual([]);
    expect(await one(`select (drift_now = 0 and checked = linked)::text v from v_consistency where system = 'AIRTABLE'`)).toBe('true');
  });

  it('the change webhook exists and is consumed; health is recorded from real checks', async () => {
    expect(await one(`select count(*)::text v from integration_cursors where provider = 'AIRTABLE' and cursor_key = 'achrbwFiSoL4y5RXM'`)).toBe('1');
    expect(await col(db, `select service v from v_system_health where ok and service in ('google_drive', 'xero', 'deepseek', 'postgres', 'n8n') order by 1`))
      .toEqual(['deepseek', 'google_drive', 'n8n', 'postgres', 'xero']);
    expect(await one(`select (detail ->> 'pinned_demo_tenant_connected') v from v_system_health where service = 'xero'`)).toBe('true');
  });
});
