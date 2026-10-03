/**
 * Test-only stand-in for '@n8n/workflow-sdk' (not installed locally; vitest aliases it here). It records exactly what an
 * n8n/*.sdk.ts file declares: every node's configuration, and every connection (from, branch, to), so tests can check
 * the wiring and execute the real node definitions offline (see n8n-runner.ts). It builds nothing for n8n.
 */
export interface SdkNode { kind: 'node' | 'trigger' | 'if' | 'switch'; type: string; name: string; config: Record<string, unknown>; }
export interface Edge { from: string; branch: string; to: string }
interface Linkable { head: SdkNode; tail: SdkNode; to(next: Linkable): Linkable }

export const recorded: { nodes: Map<string, SdkNode>; edges: Edge[] } = { nodes: new Map(), edges: [] };
const edge = (from: SdkNode, branch: string, to: SdkNode) => {
  if (!recorded.edges.some((e) => e.from === from.name && e.branch === branch && e.to === to.name)) recorded.edges.push({ from: from.name, branch, to: to.name });
};
const chain = (head: SdkNode, tail: SdkNode): Linkable => ({
  head, tail,
  to(next: Linkable) { edge(tail, 'main', next.head); return chain(head, next.tail); },
});
const make = (kind: SdkNode['kind'], type: string, config: Record<string, unknown>) => {
  const n: SdkNode = { kind, type, name: String(config.name), config };
  recorded.nodes.set(n.name, n);
  return n;
};

export const expr = (s: string) => `=${s}`;
export const node = (o: { type: string; config: Record<string, unknown> }) => { const n = make('node', o.type, o.config); return Object.assign(chain(n, n), { node: n }); };
export const trigger = (o: { type: string; config: Record<string, unknown> }) => { const n = make('trigger', o.type, o.config); return Object.assign(chain(n, n), { node: n }); };
export const ifElse = (o: { config: Record<string, unknown> }) => {
  const n = make('if', 'n8n-nodes-base.if', o.config);
  const self = Object.assign(chain(n, n), {
    onTrue(c: Linkable) { edge(n, 'true', c.head); return self; },
    onFalse(c: Linkable) { edge(n, 'false', c.head); return self; },
  });
  return self;
};
export const switchCase = (o: { config: Record<string, unknown> }) => {
  const n = make('switch', 'n8n-nodes-base.switch', o.config);
  const self = Object.assign(chain(n, n), { onCase(i: number, c: Linkable) { edge(n, String(i), c.head); return self; } });
  return self;
};
export const workflow = (id: string, name: string) => {
  let current: SdkNode | null = null;
  const b = {
    id, name,
    add(x: Linkable) { current = x.tail; return b; },
    to(x: Linkable) { if (current) edge(current, 'main', x.head); current = x.tail; return b; },
  };
  return b;
};
