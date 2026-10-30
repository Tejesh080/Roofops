/**
 * npm run n8n:drift                       compare what runs in n8n with the workflow files (read-only)
 * npm run n8n:drift -- <saved.json> ...   the same, against saved workflow JSON (the API's or the n8n MCP's) instead
 *
 * docs/master-plan.md Task 3.2. For every workflow in n8n that has a file (n8n/*.sdk.ts, loaded through the test SDK
 * recorder, and lite/dist/demo/*.json), compares the published version node for node: type, version, parameters,
 * credentials (by id), node settings, and every connection. Ignored: ids, positions, credential names, webhook ids, and
 * a parameter n8n fills in with its default (DEFAULTS). Exit code 1 when anything differs.
 *
 * Reads N8N_BASE_URL and N8N_API_KEY from the environment (CI) or from the hosted env file; only GET requests.
 */
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadHostedEnv } from '../src/config/env.js';
import { recorded, type Edge, type SdkNode } from '../test/helpers/n8n-sdk-shim.js';

type R = Record<string, unknown>;
export interface FlowNode { type: string; typeVersion: number | null; parameters: unknown; credentials: Record<string, string>; settings: R }
export interface Flow { name: string; nodes: Map<string, FlowNode>; edges: Set<string> }
interface LiveNode { name: string; type: string; typeVersion?: number; parameters?: unknown; credentials?: unknown; [k: string]: unknown }
type Connections = Record<string, { main?: ({ node: string }[] | null)[] }>;
export interface LiveWorkflow { name: string; active?: boolean; nodes: LiveNode[]; connections: Connections;
  activeVersion?: { sameAsDraft?: boolean; nodes?: LiveNode[]; connections?: Connections } | null }

const SETTINGS = ['onError', 'retryOnFail', 'maxTries', 'waitBetweenTries', 'executeOnce', 'alwaysOutputData', 'disabled'] as const;
/** Parameters n8n stores with their default value when a file leaves them out: not drift. */
export const DEFAULTS: Record<string, R> = {
  'n8n-nodes-base.httpRequest': { method: 'GET' },
  'n8n-nodes-base.code': { mode: 'runOnceForAllItems' },
};

const isObj = (v: unknown): v is R => typeof v === 'object' && v !== null && !Array.isArray(v);
const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const show = (v: unknown) => (v === undefined ? 'undefined' : JSON.stringify(v));
const settingsOf = (o: R): R => Object.fromEntries(SETTINGS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const credentialIds = (c: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(isObj(c) ? c : {}).map(([k, v]) => [k, isObj(v) && typeof v.id === 'string' ? v.id : '']));
const edgeKey = (from: string, branch: string, to: string) => `${from}|${branch}|${to}`;

/** What a workflow file declares, as recorded by the SDK recorder. An if node's plain `.to()` is its true branch. */
export function fromFile(rec: { nodes: Map<string, SdkNode>; edges: Edge[]; workflow?: { name: string } | undefined }): Flow {
  const nodes = new Map<string, FlowNode>();
  for (const [name, x] of rec.nodes) {
    nodes.set(name, { type: x.type, typeVersion: x.version ?? null, parameters: x.config.parameters ?? {},
      credentials: credentialIds(x.config.credentials), settings: settingsOf(x.config) });
  }
  const branch = (from: string, b: string) => (b !== 'main' ? b : rec.nodes.get(from)?.kind === 'if' ? 'true' : rec.nodes.get(from)?.kind === 'switch' ? '0' : 'main');
  return { name: rec.workflow?.name ?? '(unnamed)', nodes, edges: new Set(rec.edges.map((e) => edgeKey(e.from, branch(e.from, e.branch), e.to))) };
}

/** A workflow as n8n stores it (nodes and connections), whatever its publish state. */
export function fromNodes(name: string, list: LiveNode[], connections: Connections): Flow {
  const nodes = new Map<string, FlowNode>();
  for (const x of list) {
    nodes.set(x.name, { type: x.type, typeVersion: x.typeVersion ?? null, parameters: x.parameters ?? {},
      credentials: credentialIds(x.credentials), settings: settingsOf(x) });
  }
  const branch = (from: string, i: number) => {
    const t = nodes.get(from)?.type;
    if (t === 'n8n-nodes-base.if') return ['true', 'false', 'error'][i] ?? String(i);
    if (t === 'n8n-nodes-base.switch') return String(i);
    return i === 0 ? 'main' : 'error';
  };
  const edges = new Set<string>();
  for (const [from, c] of Object.entries(connections)) {
    (c.main ?? []).forEach((targets, i) => { for (const t of targets ?? []) edges.add(edgeKey(from, branch(from, i), t.node)); });
  }
  return { name, nodes, edges };
}

/** What runs: the published version (activeVersion when it differs from the draft); undefined when nothing is published. */
export function fromLive(w: LiveWorkflow): Flow | undefined {
  if (w.activeVersion === null || (w.activeVersion === undefined && w.active === false)) return undefined;
  const v = w.activeVersion?.sameAsDraft === false && w.activeVersion.nodes ? w.activeVersion : w;
  return fromNodes(w.name, v.nodes ?? [], v.connections ?? {});
}

function compareParams(f: unknown, l: unknown, defaults: R, path: string): string[] {
  if (!isObj(f) || !isObj(l)) return same(f, l) ? [] : [`parameter ${path} differs`];
  const out: string[] = [];
  const at = (k: string) => (path ? `${path}.${k}` : k);
  for (const k of Object.keys(f)) out.push(...(k in l ? compareParams(f[k], l[k], {}, at(k)) : [`parameter ${at(k)} only in the file`]));
  for (const k of Object.keys(l)) {
    if (!(k in f) && !(k in defaults && same(defaults[k], l[k]))) out.push(`parameter ${at(k)} only in n8n`);
  }
  return out;
}

/** Every difference between a workflow file and what runs, one line each; empty when they match. */
export function diffFlows(file: Flow, live: Flow): string[] {
  const out: string[] = [];
  for (const [name, f] of file.nodes) {
    const l = live.nodes.get(name);
    if (!l) { out.push(`${name}: only in the file`); continue; }
    if (f.type !== l.type) out.push(`${name}: type ${f.type} in the file, ${l.type} in n8n`);
    if (f.typeVersion !== null && f.typeVersion !== l.typeVersion) out.push(`${name}: version ${String(f.typeVersion)} in the file, ${String(l.typeVersion)} in n8n`);
    out.push(...compareParams(f.parameters, l.parameters, DEFAULTS[f.type] ?? {}, '').map((d) => `${name}: ${d}`));
    for (const k of new Set([...Object.keys(f.credentials), ...Object.keys(l.credentials)])) {
      if (f.credentials[k] !== l.credentials[k]) out.push(`${name}: credential ${k} differs`);
    }
    for (const k of SETTINGS) {
      if (!same(f.settings[k], l.settings[k])) out.push(`${name}: setting ${k} is ${show(f.settings[k])} in the file, ${show(l.settings[k])} in n8n`);
    }
  }
  for (const name of live.nodes.keys()) if (!file.nodes.has(name)) out.push(`${name}: only in n8n`);
  const arrow = (e: string) => { const [from, b, to] = e.split('|'); return `${from ?? ''} -(${b ?? ''})-> ${to ?? ''}`; };
  for (const e of file.edges) if (!live.edges.has(e)) out.push(`connection ${arrow(e)}: only in the file`);
  for (const e of live.edges) if (!file.edges.has(e)) out.push(`connection ${arrow(e)}: only in n8n`);
  return out;
}

async function fetchLive(): Promise<LiveWorkflow[]> {
  if (!process.env.N8N_API_KEY || !process.env.N8N_BASE_URL) loadHostedEnv('hosted');
  const base = process.env.N8N_BASE_URL, key = process.env.N8N_API_KEY;
  if (!base || !key) throw new Error('N8N_BASE_URL and N8N_API_KEY are needed (CI secrets, or the hosted env file)');
  const all: LiveWorkflow[] = [];
  let cursor: string | undefined;
  do {
    const r = await fetch(`${base}/api/v1/workflows?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      { headers: { 'X-N8N-API-KEY': key, accept: 'application/json' } });
    if (!r.ok) throw new Error(`n8n API: HTTP ${String(r.status)}`);
    const page = await r.json() as { data: LiveWorkflow[]; nextCursor?: string | null };
    all.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return all;
}

async function main(argv: string[]) {
  const files = new Map<string, Flow>();
  for (const f of readdirSync('n8n').filter((x) => x.endsWith('.sdk.ts')).sort()) {
    recorded.nodes.clear(); recorded.edges.length = 0; recorded.workflow = undefined;
    await import(pathToFileURL(join('n8n', f)).href);
    const flow = fromFile(recorded);
    files.set(flow.name, flow);
  }
  for (const f of readdirSync('lite/dist/demo').filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(join('lite/dist/demo', f), 'utf8')) as LiveWorkflow;
    files.set(j.name, fromNodes(j.name, j.nodes, j.connections));
  }
  const saved = argv.filter((a) => !a.startsWith('--'));
  const live = saved.length
    ? saved.map((p) => { const j = JSON.parse(readFileSync(p, 'utf8')) as { workflow?: LiveWorkflow } & LiveWorkflow; return j.workflow ?? j; })
    : await fetchLive();
  let drifted = 0;
  for (const w of live.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = files.get(w.name);
    if (!file) { console.log(`?  ${w.name}: in n8n, no file`); continue; }
    const flow = fromLive(w);
    if (!flow) { console.log(`-  ${w.name}: not published`); continue; }
    const report = diffFlows(file, flow);
    console.log(report.length ? `✗  ${w.name}: ${String(report.length)} difference(s)` : `✓  ${w.name}`);
    for (const line of report) console.log(`     ${line}`);
    if (report.length) drifted += 1;
  }
  console.log(drifted ? `\n${String(drifted)} workflow(s) differ from their files` : '\nevery published workflow matches its file');
  if (drifted) process.exitCode = 1;
}

/** Only when this file is the entry point: importing it (tests) has no side effect. */
const isMain = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) await main(process.argv.slice(2));
