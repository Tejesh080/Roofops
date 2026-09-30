/**
 * demo:reset follow-up (docs/defect-ledger.md, AC-03 §13): withdrawing the demo project's pending invoice preview must
 * also put its Airtable row back, through the normal verified path (n8n 07: compare, PATCH, read back, prove), without
 * touching anything else. The reset asks 07 for a repair run scoped to that row's invoice projection.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { demoReset } from '../src/demo/scenarios.js';
import { InvoiceRows } from './helpers/airtable04.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const P = 'PRJ-2026-0005';
const PROJECTS = 'tblvUPIoebC3zoacv';
const F = { status: 'fldPuGgo27oWLKB5R', amount: 'fld5JDnWI3RFehQxA', preview: 'fldt9KIOPXh3c3pGU', pEnd: 'fldvZtiassZEgLMAN' };
const TOKEN = 'test-operator-token';
const SCOPE = { kind: 'invoice_projection_reset', project: P };

const q1 = async (db: Db, sql: string, p: unknown[] = []) => (await db.query<{ r: R }>(sql, p))[0]!.r;

describe.each(TARGETS)('demo:reset puts the Airtable invoice projection back [%s]', (target) => {
  let db: Db; let rec: string; let other: string;
  const rows = new InvoiceRows();
  /** The Projects table as Airtable holds it: canonical, plus what 04 wrote on the demo row and an unrelated edit elsewhere. */
  const airtable = async (demoRow: R) => (await db.query<{ record_id: string; expected: R }>(`select record_id, expected from v_airtable_expected where table_id = $1`, [PROJECTS]))
    .map((r) => {
      const f: R = Object.fromEntries(Object.entries(r.expected).map(([k, v]) => [k, v !== null && typeof v === 'object' && !Array.isArray(v) ? null : v]));
      if (r.record_id === rec) Object.assign(f, demoRow);
      if (r.record_id === other) f[F.pEnd] = '2026-12-24';   // a missed staff edit on another project: not this run's business
      return { id: r.record_id, fields: f };
    });

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`update app_settings set value = '11111111-2222-3333-4444-555555555555' where key = 'xero.demo_tenant_id';
                   update app_settings set value = encode(sha256(convert_to('${TOKEN}', 'UTF8')), 'hex') where key = 'reconcile.trigger_token_sha256';
                   insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
    [rec, other] = await col(db, `select 'rec' || substr(md5(project_number), 1, 14) v from projects where project_number in ($1, 'PRJ-2026-0009') order by project_number`, [P]) as [string, string];
  }, 120_000);
  afterAll(async () => { await db.close(); });

  it('after demo:reset withdraws a preview Airtable shows, a reset-scoped repair restores exactly that row\'s invoice fields, verified', async () => {
    const shown = await rows.send(db, { event_id: 'airtable:achINV:txn1:' + rec, event_type: 'invoice.prepare_requested', source: 'airtable', actor_id: 'usr7uCnNO15fCefbH',
      occurred_at: new Date().toISOString(), payload: { project_number: P, airtable_record_id: rec } }, 'n8n:1');
    expect(shown).toMatchObject({ outcome: 'PREVIEW_READY' });
    const onRow = { [F.status]: 'Awaiting approval', [F.amount]: 17831.91, [F.preview]: rows.shown(rec) };
    expect((await demoReset(db)).withdrawn).toEqual([shown.approval_number]);

    // The reset's repair run: only the Projects table, only this row's invoice projection.
    const start = await q1(db, `select wf_reconcile_start('manual', 'repair', $1, $2::jsonb) r`, [TOKEN, JSON.stringify(SCOPE)]);
    expect(start).toMatchObject({ started: true, mode: 'repair', tables: [PROJECTS] });
    const r = await q1(db, `select wf_reconcile_airtable($1, $2, $3::jsonb) r`, [start.run_key, PROJECTS, JSON.stringify(await airtable(onRow))]);
    expect(r).toMatchObject({ ok: true, drift: 3, corrections: [{ id: rec, fields: { [F.status]: null, [F.amount]: null, [F.preview]: null } }] });
    expect(await col(db, `select planned_completion_date::text v from projects where project_number = 'PRJ-2026-0009'`)).not.toEqual(['2026-12-24']);   // not replayed
    // 07 PATCHes and proves the read-back like every reconciliation repair.
    expect(await q1(db, `select wf_airtable_writeback_verified($1, $2, $3, $4::jsonb) r`, [`reconcile:${String(start.run_key)}`, PROJECTS, rec,
      JSON.stringify({ [F.status]: null, [F.amount]: null, [F.preview]: null })])).toMatchObject({ verified: true });
    expect(await q1(db, `select wf_reconcile_finish($1, '{}'::jsonb, '[]'::jsonb) r`, [start.run_key])).toMatchObject({ ok: true });
    expect(await col(db, `select field || ':' || classification || '/' || action v from reconciliation_findings f join reconciliation_runs n on n.id = f.run_id
                          where n.run_key = $1 order by field`, [start.run_key]))
      .toEqual(['Invoice Amount (inc GST):SAFE_AUTO_REPAIR/REPAIRED_AIRTABLE', 'Invoice Preview:SAFE_AUTO_REPAIR/REPAIRED_AIRTABLE', 'Invoice Status:SAFE_AUTO_REPAIR/REPAIRED_AIRTABLE']);

    // Afterwards an ordinary (unscoped) dry-run finds nothing on the demo row.
    await db.exec(`update reconciliation_runs set started_at = started_at - interval '5 minutes'`);
    const dry = await q1(db, `select wf_reconcile_start('manual', 'observe', $1) r`, [TOKEN]);
    const d = await q1(db, `select wf_reconcile_airtable($1, $2, $3::jsonb) r`, [dry.run_key, PROJECTS, JSON.stringify(await airtable({ [F.status]: null, [F.amount]: null, [F.preview]: null }))]);
    expect(d.corrections).toEqual([]);
    expect(await col(db, `select f.entity_ref v from reconciliation_findings f join reconciliation_runs n on n.id = f.run_id where n.run_key = $1 and f.entity_ref = $2`, [dry.run_key, P])).toEqual([]);
    await q1(db, `select wf_reconcile_finish($1, '{}'::jsonb, '[]'::jsonb) r`, [dry.run_key]);
  });

  it('a reset-scoped run is refused while the project still has a pending preview or an invoice, and without the operator token', async () => {
    await db.exec(`update reconciliation_runs set started_at = started_at - interval '5 minutes'`);
    const shown = await rows.send(db, { event_id: 'airtable:achINV:txn2:' + rec, event_type: 'invoice.prepare_requested', source: 'airtable', actor_id: 'usr7uCnNO15fCefbH',
      occurred_at: new Date().toISOString(), payload: { project_number: P, airtable_record_id: rec } }, 'n8n:2');
    expect(shown).toMatchObject({ outcome: 'PREVIEW_READY' });
    expect(await q1(db, `select wf_reconcile_start('manual', 'repair', $1, $2::jsonb) r`, [TOKEN, JSON.stringify(SCOPE)])).toMatchObject({ started: false });   // still pending
    expect(await q1(db, `select wf_reconcile_start('schedule', 'repair', null, $1::jsonb) r`, [JSON.stringify(SCOPE)])).toMatchObject({ started: false });
    expect(await q1(db, `select wf_reconcile_start('manual', 'repair', $1, $2::jsonb) r`, [TOKEN, JSON.stringify({ kind: 'anything_else', project: P })])).toMatchObject({ started: false });
    expect(await col(db, `select count(*)::text v from reconciliation_runs where scope is not null and status = 'RUNNING'`)).toEqual(['0']);
  });
});
