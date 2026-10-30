/**
 * The n8n drift check (docs/master-plan.md Task 3.2): what runs in n8n, compared node for node with the workflow file.
 * Offline: the n8n side is built here from the file itself (as n8n stores a workflow: ids, positions, credential names,
 * webhook ids added) or written as a small fixture. Nothing here talks to n8n.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { diffFlows, fromFile, fromLive, type Flow, type LiveWorkflow } from '../scripts/n8n-drift.js';
import { recorded } from './helpers/n8n-sdk-shim.js';

type R = Record<string, unknown>;
const n = (name: string, type: string, parameters: R, more: R = {}) => ({ id: randomUUID(), name, type, typeVersion: 1, position: [0, 0], parameters, ...more });
const wf = (nodes: R[], connections: R = {}, extra: R = {}) =>
  ({ id: 'w1', name: '[RoofOps] 99 Test', active: true, nodes, connections, ...extra }) as unknown as LiveWorkflow;
const to = (node: string) => ({ node, type: 'main', index: 0 });

/** A workflow file as n8n stores it once published: what n8n adds is noise the check must ignore. */
function asStored(f: Flow): LiveWorkflow {
  const nodes = [...f.nodes].map(([name, x], i) => ({
    id: randomUUID(), name, type: x.type, typeVersion: x.typeVersion, position: [i * 224, 96], parameters: structuredClone(x.parameters),
    ...(Object.keys(x.credentials).length ? { credentials: Object.fromEntries(Object.entries(x.credentials).map(([k, id]) => [k, { id, name: `${k} account` }])) } : {}),
    ...x.settings, ...(x.type === 'n8n-nodes-base.webhook' ? { webhookId: randomUUID() } : {}),
  }));
  const index = (from: string, branch: string) => {
    if (branch === 'true' || branch === 'main') return 0;
    if (branch === 'false') return 1;
    if (branch === 'error') return f.nodes.get(from)!.type === 'n8n-nodes-base.if' ? 2 : 1;
    return Number(branch);
  };
  const connections: Record<string, { main: R[][] }> = {};
  for (const e of [...f.edges].map((s) => s.split('|'))) {
    const [from, branch, target] = e as [string, string, string];
    const outputs = (connections[from] ??= { main: [] }).main;
    const i = index(from, branch);
    while (outputs.length <= i) outputs.push([]);
    outputs[i]!.push(to(target));
  }
  return wf(nodes, connections, { name: f.name, activeVersion: { sameAsDraft: true } });
}

/** A module runs once per process, so each file's recording is kept the first time it is loaded. */
const loaded = new Map<string, Flow>();
const loadFile = async (path: string) => {
  if (!loaded.has(path)) {
    recorded.nodes.clear(); recorded.edges.length = 0; recorded.workflow = undefined;
    await import(/* @vite-ignore */ path);
    loaded.set(path, fromFile(recorded));
  }
  return loaded.get(path)!;
};

describe('the n8n drift check (master plan Task 3.2)', () => {
  it('reads what runs: the published version when it differs from the draft, otherwise the workflow itself, and nothing unpublished', () => {
    const published = [n('A', 't', { a: 1 })];
    const draft = [n('A', 't', { a: 2 })];
    expect(fromLive(wf(draft, {}, { activeVersion: { sameAsDraft: false, nodes: published, connections: {} } }))?.nodes.get('A')?.parameters).toEqual({ a: 1 });
    expect(fromLive(wf(draft, {}, { activeVersion: { sameAsDraft: true } }))?.nodes.get('A')?.parameters).toEqual({ a: 2 });
    expect(fromLive(wf(draft, {}, { active: false, activeVersion: null }))).toBeUndefined();
  });

  it('names each connection by its branch: an if node true and false, a switch case, an error output', () => {
    const f = fromLive(wf([n('If', 'n8n-nodes-base.if', {}), n('Sw', 'n8n-nodes-base.switch', {}), n('Q', 'n8n-nodes-base.postgres', {}, { onError: 'continueErrorOutput' }),
      n('T', 't', {}), n('F', 't', {}), n('C2', 't', {}), n('Ok', 't', {}), n('Err', 't', {})],
    { If: { main: [[to('T')], [to('F')]] }, Sw: { main: [[], [], [to('C2')]] }, Q: { main: [[to('Ok')], [to('Err')]] } }));
    expect([...f!.edges].sort()).toEqual(['If|false|F', 'If|true|T', 'Q|error|Err', 'Q|main|Ok', 'Sw|2|C2']);
  });

  it('a workflow file and its own n8n form show no drift: ids, positions, credential names and webhook ids are ignored', async () => {
    for (const file of ['../n8n/02-drive-project-folder.sdk.ts', '../n8n/06-airtable-changes.sdk.ts', '../n8n/07-reconcile.sdk.ts']) {
      const f = await loadFile(file);
      expect(f.nodes.size, file).toBeGreaterThan(4);
      expect(diffFlows(f, fromLive(asStored(f))!), file).toEqual([]);
    }
  });

  it('reports a changed parameter, a node only on one side, a changed credential, version or setting, and a changed connection', async () => {
    const f = await loadFile('../n8n/02-drive-project-folder.sdk.ts');
    const stored = asStored(f) as unknown as { nodes: R[]; connections: Record<string, { main: R[][] }> };
    const pg = stored.nodes.find((x) => x.type === 'n8n-nodes-base.postgres')!;
    (pg.parameters as R).query = 'select 1';
    pg.typeVersion = 9;
    (pg.credentials as Record<string, R>).postgres!.id = 'someOtherCred';
    pg.onError = 'continueRegularOutput';
    stored.nodes.push(n('Added By Hand', 'n8n-nodes-base.noOp', {}));
    const removed = stored.nodes.splice(stored.nodes.findIndex((x) => x.type === 'n8n-nodes-base.code'), 1)[0]!;
    // n8n drops a deleted node's connections with it.
    Reflect.deleteProperty(stored.connections, String(removed.name));
    for (const c of Object.values(stored.connections)) c.main = c.main.map((ts) => ts.filter((t) => t.node !== removed.name));
    const report = diffFlows(f, fromLive(stored as unknown as LiveWorkflow)!);
    const name = String(pg.name);
    expect(report).toEqual(expect.arrayContaining([
      `${name}: parameter query differs`, `${name}: version 2.7 in the file, 9 in n8n`, `${name}: credential postgres differs`,
      `${name}: setting onError is undefined in the file, "continueRegularOutput" in n8n`,
      'Added By Hand: only in n8n', `${String(removed.name)}: only in the file`,
    ]));
    expect(report.some((l) => l.startsWith('connection ') && l.includes(String(removed.name)))).toBe(true);
  });

  it('a parameter n8n fills in with its default is not drift; any other extra parameter is', () => {
    const file = fromLive(wf([n('Get', 'n8n-nodes-base.httpRequest', { url: 'https://x' }), n('Js', 'n8n-nodes-base.code', { jsCode: 'return []' })]))!;
    const defaults = fromLive(wf([n('Get', 'n8n-nodes-base.httpRequest', { url: 'https://x', method: 'GET' }), n('Js', 'n8n-nodes-base.code', { jsCode: 'return []', mode: 'runOnceForAllItems' })]))!;
    expect(diffFlows(file, defaults)).toEqual([]);
    const added = fromLive(wf([n('Get', 'n8n-nodes-base.httpRequest', { url: 'https://x', method: 'POST' }), n('Js', 'n8n-nodes-base.code', { jsCode: 'return []', mode: 'runOnceForEachItem' })]))!;
    expect(diffFlows(file, added)).toEqual(['Get: parameter method only in n8n', 'Js: parameter mode only in n8n']);
  });
});
