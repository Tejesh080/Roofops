/**
 * A local stand-in for '@n8n/workflow-sdk' used by lite/build.ts: it records what a Lite workflow file declares (each
 * node's type, version and configuration, and every connection) so the build can write an n8n import JSON. It only
 * implements what the Lite workflows use.
 */
export interface RecNode { name: string; type: string; version: number; config: Record<string, unknown> }
export interface RecEdge { from: string; branch: string; to: string }
interface Linkable { head: RecNode; tail: RecNode; to(next: Linkable): Linkable }

let nodes = new Map<string, RecNode>();
let edges: RecEdge[] = [];
let meta = { id: '', name: '' };
export const take = () => { const r = { nodes, edges, meta }; nodes = new Map(); edges = []; meta = { id: '', name: '' }; return r; };

const edge = (from: RecNode, branch: string, to: RecNode) => {
  if (!edges.some((e) => e.from === from.name && e.branch === branch && e.to === to.name)) edges.push({ from: from.name, branch, to: to.name });
};
const chain = (head: RecNode, tail: RecNode): Linkable => ({ head, tail, to(next: Linkable) { edge(tail, 'main', next.head); return chain(head, next.tail); } });
const make = (type: string, version: number, config: Record<string, unknown>) => {
  const name = String(config.name);
  if (nodes.has(name)) throw new Error(`two nodes are named "${name}"`);
  const n: RecNode = { name, type, version, config };
  nodes.set(name, n);
  return n;
};

export const expr = (s: string) => `=${s}`;
export const node = (o: { type: string; version: number; config: Record<string, unknown> }) => { const n = make(o.type, o.version, o.config); return chain(n, n); };
export const trigger = node;
export const ifElse = (o: { version: number; config: Record<string, unknown> }) => {
  const n = make('n8n-nodes-base.if', o.version, o.config);
  const self = Object.assign(chain(n, n), {
    onTrue(c: Linkable) { edge(n, 'true', c.head); return self; },
    onFalse(c: Linkable) { edge(n, 'false', c.head); return self; },
  });
  return self;
};
export const workflow = (id: string, name: string) => {
  meta = { id, name };
  let current: RecNode | null = null;
  const b = {
    add(x: Linkable) { current = x.tail; return b; },
    to(x: Linkable) { if (current) edge(current, 'main', x.head); current = x.tail; return b; },
  };
  return b;
};
