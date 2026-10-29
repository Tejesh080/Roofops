/**
 * [RoofOps] 95, the error workflow (master plan Task 1.2): the REAL node code, loaded through the recorder and run
 * against a migrated database. A failed production execution becomes one failed n8n health check carrying the
 * workflow, execution, node and a bounded message (never the stack), so System Health shows it and /api/healthz needs
 * attention when n8n fails three times before 08's next OK.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { healthzVerdict } from '../web/lib/health.ts';
import { getHealthz } from '../web/lib/healthz.ts';
import { TARGETS, migratedDb } from './helpers/db.js';
import { recorded } from './helpers/n8n-sdk-shim.js';
import { N8nRun } from './helpers/n8n-runner.js';

type R = Record<string, unknown>;
const load = (async () => {
  recorded.nodes.clear(); recorded.edges.length = 0;
  const file = '../n8n/95-error-alert.sdk.ts';
  await import(/* @vite-ignore */ file);                                             // a variable: typecheck does not follow it into n8n's SDK
  return { nodes: new Map(recorded.nodes), edges: [...recorded.edges] };
})();

const failure = (o: R = {}) => ({ json: { execution: { id: '4321', url: 'https://x.app.n8n.cloud/execution/4321', mode: 'webhook',
  lastNodeExecuted: 'Apply Change In Postgres', error: { message: 'connection terminated unexpectedly', stack: 'Error: connection terminated\n    at secret/path.js:1' } },
  workflow: { id: 'lD6BOf2dhZZpSoEH', name: '[RoofOps] 06 Airtable Changes -> Postgres' }, ...o } });

describe.each(TARGETS)('95 records a failed execution as a failed n8n check (%s)', (target) => {
  let db: Db;
  beforeAll(async () => { db = await migratedDb(target); });
  afterAll(async () => { await db.close(); });
  const latestN8n = async () => (await db.query<{ ok: boolean; detail: R }>(
    `select ok, detail from integration_health where service = 'n8n' order by id desc limit 1`))[0];
  const send = async (item: { json: R }) => {
    const wf = await load;
    const r = new N8nRun(wf.nodes, wf.edges, { db, http: () => { throw new Error('no HTTP expected'); } });
    await r.run('Build Failure Record', [item], []);
    return r;
  };

  it('one failure: ok=false with the workflow, execution, node and message; no stack', async () => {
    const r = await send(failure());
    expect(r.executed).toEqual(['Build Failure Record', 'Record Failure In Postgres']);
    expect(await latestN8n()).toEqual({ ok: false, detail: { source: 'error-workflow', workflow: '[RoofOps] 06 Airtable Changes -> Postgres',
      workflow_id: 'lD6BOf2dhZZpSoEH', execution_id: '4321', node: 'Apply Change In Postgres', mode: 'webhook', message: 'connection terminated unexpectedly' } });
    expect(JSON.stringify(await latestN8n())).not.toContain('secret/path');
  });

  it('a failure inside a trigger (no execution) is recorded too, and a long message is cut to 300 characters', async () => {
    await send({ json: { trigger: { mode: 'trigger', error: { message: 'x'.repeat(1000) } }, workflow: { id: 'w', name: 'n' } } });
    const d = (await latestN8n())!.detail;
    expect(d).toMatchObject({ source: 'error-workflow', workflow: 'n', mode: 'trigger' });
    expect(String(d.message)).toHaveLength(300);
    expect(d).not.toHaveProperty('execution_id');
  });

  it('three failures in a row make /api/healthz need attention; the next OK health run clears it', async () => {
    const q = <T,>(sql: string, params: unknown[] = []) => db.query<T>(sql, params);
    const ok = (service: string) => ({ service, ok: true });
    await db.query(`select wf_record_health($1::jsonb)`, [JSON.stringify(['airtable', 'airtable_webhooks', 'n8n', 'google_drive', 'deepseek'].map(ok))]);
    for (let i = 0; i < 3; i++) await send(failure());
    expect((await getHealthz(q)).services.n8n).toBe('Needs attention');
    expect((await getHealthz(q)).reasons).toContain('n8n: 3 failed checks in a row');
    await db.query(`select wf_record_health($1::jsonb)`, [JSON.stringify([ok('n8n')])]);
    expect((await getHealthz(q)).services.n8n).toBe('Healthy');
  });
});

it('healthzVerdict is what the route serves (the route only adds 200/503 and no-store)', () => {
  expect(healthzVerdict({ checks: [], integrity: [], deadLetters: 0, openExceptions: 0 }).status).toBe('attention');
});
