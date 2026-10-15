/**
 * The Copilot when the AI provider fails (preview 2026-10-15: DeepSeek answered 503 "Service is too busy").
 * Retries are bounded; then the copilot answers straight from RoofOps data with the read-only tools, never prepares or
 * changes anything, and keeps (never repeats) a preview prepared before the failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';
import { RETRY, chat, runCopilot, type ChatDeps } from '../web/lib/copilot/agent.ts';
import type { Query } from '../web/lib/queries.ts';
import { PROJECT_STAGE, label } from '../web/lib/labels.ts';

const ok = (message: object) => new Response(JSON.stringify({ choices: [{ message }], model: 'test-model' }), { status: 200 });
const status = (code: number, headers: Record<string, string> = {}) => new Response('{"error":"busy"}', { status: code, headers });

/** A provider that answers from a script, a clock that only moves when the code sleeps. */
function provider(script: (Response | Error)[]) {
  let t = 0;
  const calls: number[] = []; const sleeps: number[] = [];
  const deps: ChatDeps = {
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://provider.invalid' },
    now: () => t,
    sleep: (ms) => { sleeps.push(ms); t += ms; return Promise.resolve(); },
    fetch: () => {
      calls.push(t);
      const next = script.shift() ?? status(503);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  return { deps, calls, sleeps, advance: (ms: number) => { t += ms; } };
}
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

describe('Copilot provider calls: bounded retries', () => {
  it('a busy provider is retried with backoff and then succeeds', async () => {
    const p = provider([status(503), status(429), ok({ role: 'assistant', content: 'hello' })]);
    expect((await chat([], p.deps)).message.content).toBe('hello');
    expect(p.calls).toHaveLength(3);
    expect(p.sleeps).toEqual(RETRY.backoffMs);
  });
  it('gives up after 3 attempts with a "busy" reason', async () => {
    const p = provider([status(503), status(502), status(500)]);
    await expect(chat([], p.deps)).rejects.toMatchObject({ reason: 'busy', message: 'DeepSeek answered HTTP 500' });
    expect(p.calls).toHaveLength(RETRY.attempts);
  });
  it('a request the provider rejects (401, 400) is not retried', async () => {
    const p = provider([status(401)]);
    await expect(chat([], p.deps)).rejects.toMatchObject({ reason: 'busy', message: 'DeepSeek answered HTTP 401' });
    expect(p.calls).toHaveLength(1);
  });
  it('honours Retry-After, capped so the request never hangs', async () => {
    const p = provider([status(429, { 'retry-after': '2' }), status(503, { 'retry-after': '120' }), ok({ role: 'assistant', content: 'x' })]);
    await chat([], p.deps);
    expect(p.sleeps).toEqual([2_000, RETRY.maxRetryAfterMs]);
  });
  it('timeouts are retried and reported as "timeout"; the overall deadline stops further attempts', async () => {
    const p = provider([timeoutError(), timeoutError(), timeoutError()]);
    await expect(chat([], p.deps)).rejects.toMatchObject({ reason: 'timeout' });
    const slow = provider([]);
    let attempts = 0;
    slow.deps.fetch = () => { attempts++; slow.advance(RETRY.attemptMs); return Promise.reject(timeoutError()); };
    await expect(chat([], slow.deps)).rejects.toMatchObject({ reason: 'timeout' });
    expect(attempts).toBe(2);   // two 25 s attempts use up the 45 s deadline: no third
  });
  it('no key: "not_configured" without calling anyone; an unreadable answer: "bad_answer"', async () => {
    const p = provider([]);
    await expect(chat([], { ...p.deps, env: {} })).rejects.toMatchObject({ reason: 'not_configured' });
    expect(p.calls).toHaveLength(0);
    await expect(chat([], provider([new Response('<html>gateway</html>', { status: 200 })]).deps)).rejects.toMatchObject({ reason: 'bad_answer' });
  });
});

describe.each(TARGETS)('Copilot without the AI provider, as the dashboard role [%s]', (target) => {
  let db: Db; let asDashboard: Query;
  const ask = (q: string, script: (Response | Error)[] = []) => runCopilot(asDashboard, [{ role: 'user', content: q }], 'resilience-test', 'dashboard:copilot:test', provider(script).deps);
  // Counted as the owner (the dashboard role cannot read approvals), then back to the dashboard role.
  const approvals = async () => {
    await db.exec('reset role');
    const n = Number((await db.query<{ n: string }>(`select count(*)::text n from approvals`))[0]!.n);
    await db.exec('set local role roofops_dashboard');
    return n;
  };

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec('begin; set local role roofops_dashboard;');
    asDashboard = (sql, params = []) => db.query(sql, params) as never;
  });
  afterAll(async () => { await db.exec('rollback'); await db.close(); });

  it('a project question is answered from RoofOps data, with the canonical status and no write', async () => {
    const before = await approvals();
    const r = await ask("What's the status of PRJ-2026-0001 currently?");
    expect(r.fallback).toBe('busy');
    expect(r.reply).toContain('The AI assistant is unavailable right now (the provider is busy)');
    const [row] = await asDashboard<{ status: string }>(`select status from v_dashboard_projects where project_number = 'PRJ-2026-0001'`);
    expect(r.reply).toContain(`**PRJ-2026-0001** · Oliver Grant: status **${label(PROJECT_STAGE, row!.status).text}**.`);
    expect(r.steps).toEqual([expect.objectContaining({ tool: 'get_project', tier: 'GREEN', ok: true })]);
    expect(await approvals()).toBe(before);
  });
  it('"what needs attention today" and "open issues" are answered without the AI', async () => {
    expect((await ask('What needs attention today?')).reply).toContain('**At risk (');
    expect((await ask('Any open issues?')).reply).toMatch(/Open automation issues|no open automation issues/);
    expect((await ask('Tell me a joke')).reply).toContain('Every page of the dashboard works as usual');
  });
  it('asked to prepare an invoice, it prepares nothing and says how to do it the normal way', async () => {
    const before = await approvals();
    const r = await ask('Prepare invoice for PRJ-2026-0005');
    expect(r.reply).toContain('Nothing was prepared');
    expect(r.reply).toContain('Airtable');
    expect(r.cards).toEqual([]);
    expect(await approvals()).toBe(before);
  });
  it('a preview prepared before the provider failed is reported once, never prepared again', async () => {
    const before = await approvals();
    const call = { id: 'c1', type: 'function', function: { name: 'prepare_invoice', arguments: '{"project_number":"PRJ-2026-0005"}' } };
    const r = await ask('Prepare invoice for PRJ-2026-0005', [ok({ role: 'assistant', content: '', tool_calls: [call] }), status(503), status(503), status(503)]);
    expect(r.fallback).toBe('busy');
    expect(r.cards).toHaveLength(1);
    expect(r.reply).toContain(`PRJ-2026-0005: ${r.cards[0]!.data.status_text}`);
    expect(r.steps.filter((s) => s.tool === 'prepare_invoice')).toHaveLength(1);
    expect(await approvals()).toBe(before + (r.cards[0]!.data.outcome === 'PREVIEW_READY' ? 1 : 0));
  });
});
