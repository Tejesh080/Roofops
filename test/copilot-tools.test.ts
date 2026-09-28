import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';
import { TOOLS, toolSchemas, type ToolContext } from '../web/lib/copilot/tools.ts';
import type { Query } from '../web/lib/queries.ts';

const JARGON = /idempot|webhook|cursor|outbox|side[_ ]?effect|\bclaim|transaction|payload|event_id/i;

describe.each(TARGETS)('Operations Copilot tools, as the dashboard role [%s]', (target) => {
  let db: Db;
  let asDashboard: Query;
  const ctx = (msg: string, id = 'test'): ToolContext => ({ query: asDashboard, requestId: id, lastUserMessage: msg });
  const run = async (tool: string, args: Record<string, unknown>, msg = 'question') => (await TOOLS[tool]!.run(args, ctx(msg))).data as Record<string, unknown>;

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec('begin; set local role roofops_dashboard;');   // every tool runs with the web server's privileges only
    asDashboard = (sql, params = []) => db.query(sql, params) as never;
  });
  afterAll(async () => { await db.exec('rollback'); await db.close(); });

  it('offers read tools and one prepare tool; no tool can approve, send, pay or write', () => {
    expect(Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, t.tier]))).toEqual({
      business_overview: 'GREEN', list_projects: 'GREEN', what_needs_attention_today: 'GREEN', get_project: 'GREEN',
      get_project_history: 'GREEN', list_open_issues: 'GREEN', prepare_invoice: 'AMBER',
    });
    expect(toolSchemas().map((s) => s.function.name).join(' ')).not.toMatch(/approve|send|pay|delete|update|sql|query/i);
  });

  it('answers "why is PRJ-2026-0011 at risk?" with the named reasons, and accepts loose project numbers', async () => {
    const p = await run('get_project', { project_number: 'prj-2026-11' });
    expect(p).toMatchObject({ project: 'PRJ-2026-0011', at_risk: true, materials: "Supplier hasn't confirmed" });
    expect(p.risk_reasons).toEqual(["Start date has passed and work hasn't started", "Supplier hasn't confirmed the order", 'Project manager flagged a risk']);
    expect((await run('get_project', { project_number: '4' })).project).toBe('PRJ-2026-0004');
    expect(await run('get_project', { project_number: 'PRJ-2026-9999' })).toEqual({ error: 'No project PRJ-2026-9999' });
  });

  it('lists groups consistently with the headline numbers', async () => {
    const k = (await run('business_overview', {})) as Record<string, number>;
    for (const [group, kpi] of [['at_risk', 'projects_at_risk'], ['awaiting_materials', 'awaiting_materials'], ['ready_to_invoice', 'ready_to_invoice'], ['active', 'active_projects']] as const) {
      expect((await run('list_projects', { group })).count, group).toBe(k[kpi]);
    }
  });

  it("today's attention list states each item's own status, in plain words", async () => {
    const a = await run('what_needs_attention_today', {});
    expect((a.ready_to_invoice as { state: string }[]).every((r) => r.state.startsWith('not prepared'))).toBe(true);
    expect((a.open_automation_issues as { status: string }[]).map((e) => e.status)).toContain('Needs attention');
    expect(JSON.stringify(a)).not.toMatch(JARGON);
    expect(JSON.stringify(await run('get_project_history', { project_number: 'PRJ-2026-0004' }))).not.toMatch(JARGON);
  });

  it('prepare_invoice only runs when explicitly asked, and never for a job that is not ready', async () => {
    const approvals = () => col(db, `select count(*)::text v from v_dashboard_projects where invoice_status = 'AWAITING_APPROVAL'`);
    const issues = () => col(db, `select count(*)::text v from v_dashboard_exceptions`);
    const issuesBefore = await issues();
    expect(await run('prepare_invoice', { project_number: 'PRJ-2026-0005' }, 'Which projects are ready to invoice?')).toHaveProperty('refused');
    const notReady = await run('prepare_invoice', { project_number: 'PRJ-2026-0009' }, 'Prepare invoice for PRJ-2026-0009');
    expect(notReady).toMatchObject({ prepared: false, reason: expect.stringMatching(/only completed jobs/) as unknown });
    expect(await approvals()).toEqual(['0']);
    expect(await issues()).toEqual(issuesBefore);   // explained, not filed as a new automation issue
  });

  it('"Prepare invoice for PRJ-2026-0005" returns the preview for approval and creates nothing else', async () => {
    const r = await TOOLS.prepare_invoice!.run({ project_number: 'PRJ-2026-0005' }, ctx('Prepare invoice for PRJ-2026-0005', 'p1'));
    expect(r.data).toMatchObject({ project: 'PRJ-2026-0005', outcome: 'Prepared: awaiting approval', requires_human_approval: true,
      preview: { amount_inc_gst: 17831.91, gst: 1621.08, reference: 'PRJ-2026-0005' } });
    expect(r.card).toMatchObject({ kind: 'invoice_preview', data: { outcome: 'PREVIEW_READY', preview: { amount_inc_gst: 17831.91 } } });
    const again = await TOOLS.prepare_invoice!.run({ project_number: 'PRJ-2026-0005' }, ctx('prepare the invoice for PRJ-2026-0005 again', 'p2'));
    expect(again.data).toMatchObject({ outcome: 'Already prepared: awaiting approval', approval_reference: (r.data as { approval_reference: string }).approval_reference });
    expect(await col(db, `select invoice_status || '|' || coalesce(final_invoice_number, 'none') v from v_dashboard_projects where project_number = 'PRJ-2026-0005'`))
      .toEqual(['AWAITING_APPROVAL|none']);
  });
});
