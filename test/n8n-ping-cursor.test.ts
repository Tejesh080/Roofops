/**
 * INT-03, second part: an Airtable ping is unauthenticated, so nothing in its body may choose what n8n 01 and 04 read.
 * The REAL node code of both workflows, loaded through the recorder: a ping that carries replay_from_cursor still has
 * the payloads fetched from the durable Postgres cursor. (Operator replays go through ops/requeue-*.sql, never a ping.)
 */
import { describe, expect, it } from 'vitest';
import { recorded } from './helpers/n8n-sdk-shim.js';
import { N8nRun, type HttpRequest } from './helpers/n8n-runner.js';

const BASE = 'appMc8V0Wm29tEeHQ';
const HOOK = 'achPINGCURSOR0001';
const loaded = new Map<string, Promise<{ nodes: typeof recorded.nodes; edges: typeof recorded.edges }>>();
const load = (file: string) => {
  if (!loaded.has(file)) loaded.set(file, (async () => {
    recorded.nodes.clear(); recorded.edges.length = 0;
    await import(/* @vite-ignore */ file);                                           // a variable: typecheck does not follow it into n8n's SDK
    return { nodes: new Map(recorded.nodes), edges: [...recorded.edges] };
  })());
  return loaded.get(file)!;
};

describe.each([
  ['01 Quote Accepted', '../n8n/01-quote-accepted-to-project.sdk.ts'],
  ['04 Approved Project to Xero', '../n8n/04-approved-project-to-xero-draft-invoice.sdk.ts'],
])('%s: the ping body cannot choose the payload cursor', (_name, file) => {
  /** The cursor the payload fetch asks Airtable for, after a ping with `body` and a stored cursor of 7. */
  const fetchedCursor = async (body: Record<string, unknown>) => {
    const wf = await load(file);
    const seen: HttpRequest[] = [];
    const r = new N8nRun(wf.nodes, wf.edges, { db: undefined as never, http: (req) => { seen.push(req); throw new Error('captured'); } });
    await r.run('Validate Ping', [{ json: { body } }], ['Load Payload Cursor']);
    const ping = r.out.get('Validate Ping')!;
    if (ping.length === 0) return { ping, cursor: undefined };
    await r.run('List Airtable Payloads', [{ json: { cursor: '7' } }], []).catch((e: unknown) => {
      if ((e as Error).message !== 'captured') throw e;
    });
    expect(seen).toHaveLength(1);
    return { ping, cursor: seen[0]!.query.cursor };
  };

  it('a ping reads from the stored cursor', async () => {
    const { cursor } = await fetchedCursor({ base: { id: BASE }, webhook: { id: HOOK }, timestamp: '2026-10-29T00:00:00.000Z' });
    expect(cursor).toBe('7');
  });

  it('replay_from_cursor in the body is ignored: the fetch still starts at the stored cursor', async () => {
    const { ping, cursor } = await fetchedCursor({ base: { id: BASE }, webhook: { id: HOOK }, timestamp: '2026-10-29T00:00:00.000Z', replay_from_cursor: 1 });
    expect(ping[0]!.json).not.toHaveProperty('replay_from_cursor');
    expect(cursor).toBe('7');
  });

  it('a ping for another base or a malformed webhook id does nothing', async () => {
    expect((await fetchedCursor({ base: { id: 'appSOMEOTHERBASE0' }, webhook: { id: HOOK }, replay_from_cursor: 1 })).ping).toEqual([]);
    expect((await fetchedCursor({ base: { id: BASE }, webhook: { id: 'not-a-hook' }, replay_from_cursor: 1 })).ping).toEqual([]);
  });
});
