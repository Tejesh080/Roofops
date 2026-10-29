/**
 * Copilot read coverage and guards (audit 2026-10-22): CP-03 (jobs held by the pre-start gate), CP-09 (pending quotes),
 * CP-02 / AC-22 (a second prepare in one request showed the first project's preview under the second project's name),
 * CP-05 (tool arguments were not enforced: a truncated call ran with {}, an unknown group answered "active", and an answer
 * cut off at the length limit was acted on). CP-01 (no staff prepare while dispatch is off) is in staff-invoice-approval.
 * Every tool runs with the dashboard role's privileges only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';
import { TOOLS, type ToolContext } from '../web/lib/copilot/tools.ts';
import { checkArgs, runCopilot, type ChatDeps } from '../web/lib/copilot/agent.ts';
import type { Query } from '../web/lib/queries.ts';

type R = Record<string, unknown>;
const answer = (message: object, finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ message, finish_reason }], model: 'test-model' }), { status: 200 });
const toolCall = (name: string, args: string) => ({ role: 'assistant', content: '', tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: args } }] });
/** A provider that answers from a script and keeps every request body, so the tool messages it was sent can be read. */
function provider(script: Response[]) {
  const bodies: { messages: { role: string; content: string | null }[] }[] = [];
  const deps: ChatDeps = {
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://provider.invalid' }, now: () => 0, sleep: () => Promise.resolve(),
    fetch: (_u, init) => { bodies.push(JSON.parse(init?.body as string) as never); return Promise.resolve(script.shift() ?? answer({ role: 'assistant', content: 'done' })); },
  };
  return { deps, bodies };
}

describe('checkArgs: a tool call must fit its declared parameters (CP-05)', () => {
  const schema = TOOLS.list_projects!.parameters as never;
  it('accepts a call that fits', () => {
    expect(checkArgs('{"group":"at_risk"}', schema)).toEqual({ ok: true, args: { group: 'at_risk' } });
  });
  it('refuses truncated or non-object arguments', () => {
    expect(checkArgs('{"group":"at_ri', schema)).toMatchObject({ ok: false, error: { error: 'invalid arguments', detail: 'the arguments are not valid JSON' } });
    expect(checkArgs('["at_risk"]', schema)).toMatchObject({ ok: false, error: { detail: 'the arguments must be an object' } });
  });
  it('refuses a missing required argument, an undeclared one, a wrong type and a value outside the enum', () => {
    expect(checkArgs('{}', schema)).toMatchObject({ ok: false, error: { detail: 'group is required' } });
    expect(checkArgs('{"group":"at_risk","sql":"select 1"}', schema)).toMatchObject({ ok: false, error: { detail: 'sql is not an argument of this tool' } });
    expect(checkArgs('{"group":7}', schema)).toMatchObject({ ok: false, error: { detail: 'group must be text' } });
    expect(checkArgs('{"group":"cancelled"}', schema)).toMatchObject({ ok: false, error: { detail: 'group must be one of the allowed values', allowed: expect.arrayContaining(['at_risk', 'active']) as unknown } });
  });
  it('an empty argument string is an empty object (tools without parameters)', () => {
    expect(checkArgs('', TOOLS.business_overview!.parameters as never)).toEqual({ ok: true, args: {} });
  });
});

describe.each(TARGETS)('Copilot read models and guards, as the dashboard role [%s]', (target) => {
  let db: Db;
  let asDashboard: Query;
  const ctx = (msg: string, id = 'test'): ToolContext => ({ query: asDashboard, requestId: id, lastUserMessage: msg });
  const run = async (tool: string, args: R, msg = 'question', id = 'test') => TOOLS[tool]!.run(args, ctx(msg, id));
  /** Counted as the owner (the dashboard role may not read approvals), then back to the dashboard role. */
  const approvals = async () => {
    await db.exec('reset role');
    try { return (await db.query<{ n: number }>(`select count(*)::int n from approvals where action_type = 'CREATE_INVOICE'`))[0]!.n; }
    finally { await db.exec('set local role roofops_dashboard'); }
  };

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    // A quote-born job: both pre-start items open, held by the gate.
    await db.query(`select wf_quote_accepted($1::jsonb)`, [JSON.stringify({ event_id: 'EVT-COPILOT-PRE', correlation_id: 'CORR-COPILOT-PRE', event_type: 'quote.accepted',
      source: 'airtable', actor_id: 'airtable-automation', occurred_at: '2026-09-29T09:00:00+10:00',
      payload: { quote_id: 'Q-2026-0041', accepted_version: 1, accepted_on: '2026-09-29', airtable_record_id: 'recTESTTESTTEST01' } })]);
    asDashboard = (sql, params = []) => db.query(sql, params) as never;
  }, 120_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.exec('begin; set local role roofops_dashboard;'); });
  afterEach(async () => { await db.exec('rollback'); });

  it('jobs held by the pre-start gate: the quote-born job with both open items; imported jobs never appear (CP-03)', async () => {
    const d = (await run('list_jobs_held_by_pre_start', {})).data as { count: number; jobs: R[] };
    expect(d.count).toBe(1);
    expect(d.jobs[0]).toMatchObject({ project: 'PRJ-2026-0031', stage: 'Planning',
      still_open: ['Materials reviewed and approved', 'Safe Work Method Statement signed'] });
    expect(String(d.jobs[0]!.how_it_is_cleared)).toMatch(/SWMS Signed must be Done/);
  });

  it('pending quotes: drafts and sent quotes only, each in plain words; an accepted quote is not pending (CP-09)', async () => {
    const d = (await run('list_pending_quotes', {})).data as { count: number; quotes: R[] };
    const expected = (await db.query<{ n: number }>(`select count(*)::int n from v_dashboard_quotes where status in ('DRAFT', 'SENT')`))[0]!.n;
    expect(d.count).toBe(expected);
    expect(d.quotes.map((x) => x.quote)).not.toContain('Q-2026-0041');
    expect(d.count).toBeGreaterThan(0);
    for (const x of d.quotes) expect(['draft, not sent yet', 'sent, waiting for the customer']).toContain(x.state);
  });

  it('an unknown project group is an error naming the allowed groups, never another group\'s answer (CP-05)', async () => {
    expect((await run('list_projects', { group: 'cancelled' })).data).toMatchObject({ error: 'Unknown group "cancelled"', allowed: expect.arrayContaining(['active']) as unknown });
  });

  it('two projects prepared in one request each get their own preview and card (AC-22)', async () => {
    const msg = 'Prepare invoice for PRJ-2026-0005 and PRJ-2026-0002';
    const a = await run('prepare_invoice', { project_number: 'PRJ-2026-0005' }, msg, 'same-request');
    const b = await run('prepare_invoice', { project_number: 'PRJ-2026-0002' }, msg, 'same-request');
    const card = (x: typeof a) => x.card!.data as unknown as { project: string; approval_number: string; preview: { project_number: string } };
    expect([card(a).project, card(a).preview.project_number]).toEqual(['PRJ-2026-0005', 'PRJ-2026-0005']);
    expect([card(b).project, card(b).preview.project_number]).toEqual(['PRJ-2026-0002', 'PRJ-2026-0002']);
    expect(card(a).approval_number).not.toBe(card(b).approval_number);
    // The same project again in the same request is the same preview (the stored result is returned), not a second one.
    const before = await approvals();
    const again = await run('prepare_invoice', { project_number: 'PRJ-2026-0005' }, msg, 'same-request');
    expect(card(again).approval_number).toBe(card(a).approval_number);
    expect(await approvals()).toBe(before);
  });

  it('a truncated tool call is answered with an error and the tool never runs (CP-05)', async () => {
    const p = provider([answer(toolCall('list_projects', '{"group":"at_ri')), answer({ role: 'assistant', content: 'Please ask again.' })]);
    const r = await runCopilot(asDashboard, [{ role: 'user', content: 'Which jobs are at risk?' }], 'req-truncated', undefined, p.deps);
    expect(r.steps).toEqual([{ tool: 'list_projects', tier: 'GREEN', args: {}, ok: false }]);
    const toolMsg = p.bodies[1]!.messages.find((m) => m.role === 'tool')!;
    expect(JSON.parse(String(toolMsg.content))).toMatchObject({ error: 'invalid arguments', detail: 'the arguments are not valid JSON' });
  });

  it('an answer cut off at the length limit is never acted on: no prepare, a data-only answer instead (CP-05)', async () => {
    const before = await approvals();
    const p = provider([answer(toolCall('prepare_invoice', '{"project_number":"PRJ-2026-0005"}'), 'length')]);
    const r = await runCopilot(asDashboard, [{ role: 'user', content: 'Prepare invoice for PRJ-2026-0005' }], 'req-cut', undefined, p.deps);
    expect(r.fallback).toBe('bad_answer');
    expect(r.cards).toEqual([]);
    expect(await approvals()).toBe(before);
  });
});
