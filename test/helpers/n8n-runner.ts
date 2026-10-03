/**
 * Offline executor for the node definitions recorded from an n8n/*.sdk.ts file (n8n-sdk-shim.ts). It runs the REAL
 * node code and expressions: Code nodes (runOnceForAllItems JavaScript), If nodes, HTTP Request nodes (URL, query and
 * headers evaluated per item, sent to a fake), Postgres executeQuery nodes (the real query and queryReplacement against a
 * test database). Items follow the recorded connections, as n8n routes them; a node that receives no items does not run.
 * Only what the tested paths use is supported; anything else throws, so a test cannot pass by skipping a node.
 */
import { runInNewContext } from 'node:vm';
import type { Db } from '../../src/db/db.js';
import type { Edge, SdkNode } from './n8n-sdk-shim.js';

export type Item = { json: Record<string, unknown> };
export interface HttpRequest { method: string; url: string; headers: Record<string, string>; query: Record<string, string> }
export type HttpHandler = (req: HttpRequest) => { statusCode: number; body: unknown; headers?: Record<string, string> };

type P = Record<string, unknown>;
const params = (n: SdkNode) => (n.config.parameters ?? {}) as P;

export class N8nRun {
  readonly out = new Map<string, Item[]>();
  readonly executed: string[] = [];
  constructor(private nodes: Map<string, SdkNode>, private edges: Edge[], private deps: { db: Db; http: HttpHandler }) {}

  seed(name: string, items: Item[]) { this.out.set(name, items); }

  private ctx(input: Item[], idx: number) {
    const ref = (name: string) => {
      const items = this.out.get(name);
      return {
        get isExecuted() { return items !== undefined; },
        first: () => { if (!items) throw new Error(`node "${name}" has not run`); return items[0]!; },
        last: () => { if (!items) throw new Error(`node "${name}" has not run`); return items[items.length - 1]!; },
        all: () => { if (!items) throw new Error(`node "${name}" has not run`); return items; },
        get item() { if (!items) throw new Error(`node "${name}" has not run`); return items[idx] ?? items[0]!; },
      };
    };
    return { $json: input[idx]?.json ?? {}, $input: { first: () => input[0]!, all: () => input, item: input[idx]! }, $: ref, $execution: { id: 'test-execution' } };
  }

  /** n8n parameter value: plain, or "=..." with {{ }} expressions (a lone {{ }} keeps its type). */
  evalParam(value: unknown, input: Item[], idx: number): unknown {
    if (typeof value !== 'string' || !value.startsWith('=')) return value;
    const src = value.slice(1);
    const c = this.ctx(input, idx);
    const run = (code: string) => runInNewContext(`(${code})`, { ...c }) as unknown;   // n8n expression, in its own context
    const whole = /^\{\{([\s\S]*)\}\}$/.exec(src.trim());
    if (whole && !whole[1]!.includes('}}')) return run(whole[1]!);
    return src.replace(/\{\{([\s\S]*?)\}\}/g, (_m, code: string) => String(run(code)));
  }

  private async execNode(n: SdkNode, input: Item[]): Promise<Record<string, Item[]>> {
    const p = params(n);
    if (n.type === 'n8n-nodes-base.code') {
      if (p.mode !== 'runOnceForAllItems') throw new Error(`${n.name}: unsupported code mode`);
      const c = this.ctx(input, 0);
      const res = runInNewContext(`(function () {
${String(p.jsCode)}
})()`, { $input: c.$input, $: c.$, $execution: c.$execution }) as Item[];
      return { main: res };
    }
    if (n.type === 'n8n-nodes-base.if') {
      const cond = ((p.conditions as P).conditions as P[])[0]!;
      if ((cond.operator as P).operation !== 'true' || cond.rightValue !== true) throw new Error(`${n.name}: unsupported condition`);
      const t: Item[] = []; const f: Item[] = [];
      input.forEach((it, i) => (this.evalParam(cond.leftValue, input, i) === true ? t : f).push(it));
      return { true: t, false: f };
    }
    if (n.type === 'n8n-nodes-base.httpRequest') {
      const res: Item[] = [];
      for (let i = 0; i < (n.config.executeOnce ? 1 : input.length); i++) {
        const kv = (list: unknown) => Object.fromEntries(((list as P | undefined)?.parameters as P[] | undefined ?? [])
          .map((x) => [String(x.name), String(this.evalParam(x.value, input, i))]));
        const req: HttpRequest = { method: typeof p.method === 'string' ? p.method : 'GET', url: String(this.evalParam(p.url, input, i)),
          headers: p.sendHeaders ? kv(p.headerParameters) : {}, query: p.sendQuery ? kv(p.queryParameters) : {} };
        try {
          const r = this.deps.http(req);
          if (!(((p.options as P | undefined)?.response as P | undefined)?.response as P | undefined)?.fullResponse) throw new Error(`${n.name}: expected fullResponse`);
          res.push({ json: { statusCode: r.statusCode, body: r.body, headers: r.headers ?? {} } });
        } catch (e) {
          if (n.config.onError !== 'continueRegularOutput') throw e;
          res.push({ json: { error: { message: (e as Error).message } } });
        }
      }
      return { main: res };
    }
    if (n.type === 'n8n-nodes-base.postgres') {
      if (p.operation !== 'executeQuery') throw new Error(`${n.name}: unsupported operation`);
      const runs = n.config.executeOnce ? [0] : input.map((_x, i) => i);
      const res: Item[] = [];
      for (const i of runs) {
        const qp = this.evalParam(((p.options as P | undefined) ?? {}).queryReplacement, input, i);
        const rows = await this.deps.db.query(String(p.query), Array.isArray(qp) ? qp : []);
        res.push(...rows.map((r) => ({ json: r })));
      }
      return { main: res };
    }
    throw new Error(`${n.name}: node type ${n.type} not supported by the test runner`);
  }

  /** Run from `start` with `input`, following the recorded connections, stopping before any node in `stopAt`. */
  async run(start: string, input: Item[], stopAt: string[]) {
    const queue: [string, Item[]][] = [[start, input]];
    while (queue.length) {
      const [name, items] = queue.shift()!;
      if (stopAt.includes(name) || items.length === 0) continue;
      const n = this.nodes.get(name);
      if (!n) throw new Error(`no node "${name}"`);
      const outputs = await this.execNode(n, items);
      this.executed.push(name);
      this.out.set(name, outputs.main ?? [...(outputs.true ?? []), ...(outputs.false ?? [])]);
      for (const e of this.edges.filter((x) => x.from === name)) {
        const routed = n.kind === 'if' ? outputs[e.branch] ?? [] : outputs.main ?? [];
        queue.push([e.to, routed]);
      }
    }
  }
}
