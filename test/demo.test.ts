import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { demoReset, demoStatus } from '../src/demo/scenarios.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';

const prepare = (db: Db, id: string, project: string) => db.query(`select wf_invoice_prepare($1::jsonb, 'test')`, [JSON.stringify({
  event_id: id, event_type: 'invoice.prepare_requested', source: 'roofops-dashboard', actor_id: 'dashboard:copilot',
  occurred_at: '2026-09-29T09:00:00+10:00', payload: { project_number: project } })]);
const finance = async (db: Db) => (await demoStatus(db)).find((s) => s.id === '04')!;

describe.each(TARGETS)('interview demo status and reset [%s]', (target) => {
  let db: Db;
  beforeAll(async () => { db = await migratedDb(target); await importBundle(db); });
  afterAll(async () => { await db.close(); });

  it('reports every scenario; finance is BLOCKED while no Xero Demo tenant is pinned', async () => {
    const s = await demoStatus(db);
    expect(s.map((x) => x.id)).toEqual(['01', '02', '03', '04']);
    expect(s[0]).toMatchObject({ status: 'READY', detail: expect.stringContaining('Q-2026-0050') as unknown });
    expect(s[1]).toMatchObject({ status: 'READY' });
    expect(s[2]).toMatchObject({ status: 'BLOCKED' });   // the live failure/recovery history exists only in the hosted DB
    expect(s[3]).toMatchObject({ status: 'BLOCKED', detail: expect.stringMatching(/tenant/) as unknown });
  });

  it('prepare -> NEEDS RESET -> reset -> ready again; idempotent, audited, and scoped to the demo project', async () => {
    await db.exec(`update app_settings set value = '11111111-2222-3333-4444-555555555555' where key = 'xero.demo_tenant_id'`);
    await prepare(db, 'demo:t1', 'PRJ-2026-0005');
    await prepare(db, 'demo:t2', 'PRJ-2026-0001');   // a non-demo project: must be left alone
    expect(await finance(db)).toMatchObject({ status: 'NEEDS RESET', resettable: true });

    const first = await demoReset(db);
    expect(first.withdrawn).toHaveLength(1);
    expect(await demoReset(db)).toEqual({ withdrawn: [], notes: [] });
    expect(await col(db, `select a.status v from approvals a join projects p on p.id = a.entity_id where p.project_number = 'PRJ-2026-0005'`)).toEqual(['CANCELLED']);
    expect(await col(db, `select a.status v from approvals a join projects p on p.id = a.entity_id where p.project_number = 'PRJ-2026-0001'`)).toEqual(['PENDING']);
    expect(await col(db, `select business_reference v from audit_events where action = 'demo.reset.preview_withdrawn'`)).toEqual(first.withdrawn);
    expect(await col(db, `select coalesce(verify_audit_chain()::text, 'intact') v`)).toEqual(['intact']);

    // The same preview can be prepared again afterwards (a new approval, same amount).
    await prepare(db, 'demo:t3', 'PRJ-2026-0005');
    expect(await col(db, `select string_agg(a.status, ',' order by a.created_at) v from approvals a join projects p on p.id = a.entity_id where p.project_number = 'PRJ-2026-0005'`))
      .toEqual(['CANCELLED,PENDING']);
  });

  it('never withdraws an approved preview: an invoiced demo project is ALREADY RUN, not reset', async () => {
    // The approver shows the Copilot's pending preview on the Airtable row (Prepare: same preview), then approves it (AC-03).
    await db.exec(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'recDEMOPRJ000005', now(), now() from projects where project_number = 'PRJ-2026-0005'`);
    const row = { project_number: 'PRJ-2026-0005', airtable_record_id: 'recDEMOPRJ000005' };
    const [shown] = await db.query<{ r: { outcome: string } }>(`select wf_invoice_prepare($1::jsonb, 'test') r`, [JSON.stringify({ event_id: 'demo:t4p',
      event_type: 'invoice.prepare_requested', source: 'airtable', actor_id: 'usr7uCnNO15fCefbH', occurred_at: new Date().toISOString(), payload: row })]);
    expect(shown!.r.outcome).toBe('ALREADY_PENDING');
    await db.query(`select wf_invoice_decide($1::jsonb, 'test')`, [JSON.stringify({ event_id: 'demo:t4', event_type: 'invoice.approved', source: 'airtable',
      actor_id: 'usr7uCnNO15fCefbH', occurred_at: new Date(Date.now() + 1000).toISOString(), payload: row })]);
    expect(await finance(db)).toMatchObject({ status: 'ALREADY RUN', resettable: false });
    expect(await demoReset(db)).toEqual({ withdrawn: [], notes: [] });
    expect(await col(db, `select count(*)::text v from invoices i join projects p on p.id = i.project_id where p.project_number = 'PRJ-2026-0005' and i.invoice_type = 'FINAL'`)).toEqual(['1']);
  });
});
