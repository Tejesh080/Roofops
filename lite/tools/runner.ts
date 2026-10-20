/**
 * Runs a Lite workflow's REAL node definitions locally, the way n8n routes items: Code nodes (their JavaScript), If
 * nodes, HTTP Request nodes (URL, query and JSON body evaluated per item, sent to a handler such as the demo Airtable),
 * triggers (pass-through) and Respond to Webhook (the HTTP answer is captured). Anything else throws, so nothing passes by
 * being skipped. Used by the local demo (lite/demo/run-demo.ts) and the tests.
 */
import { runInNewContext } from 'node:vm';
import type { LoadedWorkflow } from './load-workflow.js';
import type { RecNode } from './sdk-recorder.js';

export type Item = { json: Record<string, unknown> };
export interface HttpReq { method: string; url: string; query: Record<string, string>; body?: unknown }
export type Http = (req: HttpReq) => { statusCode: number; body: unknown };
type P = Record<string, unknown>;

export class LiteRun {
  readonly out = new Map<string, Item[]>();
  readonly executed: string[] = [];
  response: { status: number; body: unknown } | null = null;
  constructor(private wf: LoadedWorkflow, private http: Http, private executionId = 'local') {}

  private ctx(input: Item[], idx: number) {
    const ref = (name: string) => {
      const items = this.out.get(name);
      const need = () => { if (!items) throw new Error(`node "${name}" has not run`); return items; };
      return { get isExecuted() { return items !== undefined; }, first: () => need()[0]!, last: () => need()[need().length - 1]!, all: () => need() };
    };
    return { $json: input[idx]?.json ?? {}, $input: { first: () => input[0]!, all: () => input, item: input[idx]! }, $: ref, $execution: { id: this.executionId } };
  }

  private eval(value: unknown, input: Item[], idx: number): unknown {
    if (typeof value !== 'string' || !value.startsWith('=')) return value;
    const src = value.slice(1);
    const run = (c: string) => runInNewContext(`(${c})`, { ...this.ctx(input, idx) }) as unknown;
    const whole = /^\{\{([\s\S]*)\}\}$/.exec(src.trim());
    if (whole && !whole[1]!.includes('}}')) return run(whole[1]!);
    return src.replace(/\{\{([\s\S]*?)\}\}/g, (_m, c: string) => String(run(c)));
  }

  private exec(n: RecNode, input: Item[]): Record<string, Item[]> {
    const p = (n.config.parameters ?? {}) as P;
    switch (n.type) {
      case 'n8n-nodes-base.webhook': case 'n8n-nodes-base.scheduleTrigger': case 'n8n-nodes-base.manualTrigger':
        return { main: input };
      case 'n8n-nodes-base.code': {
        if (p.mode !== 'runOnceForAllItems') throw new Error(`${n.name}: unsupported code mode`);
        const c = this.ctx(input, 0);
        const res = runInNewContext(`(function () {\n${String(p.jsCode)}\n})()`, { $input: c.$input, $: c.$, $execution: c.$execution }) as Item[];
        if (!Array.isArray(res)) throw new Error(`${n.name}: a Code node must return an array of items`);
        return { main: res };
      }
      case 'n8n-nodes-base.if': {
        const cond = ((p.conditions as P).conditions as P[])[0]!;
        if ((cond.operator as P).operation !== 'true' || cond.rightValue !== true) throw new Error(`${n.name}: unsupported condition`);
        const t: Item[] = []; const f: Item[] = [];
        input.forEach((it, i) => (this.eval(cond.leftValue, input, i) === true ? t : f).push(it));
        return { true: t, false: f };
      }
      case 'n8n-nodes-base.httpRequest': {
        const kv = (list: unknown, i: number) => Object.fromEntries(((list as P | undefined)?.parameters as P[] | undefined ?? []).map((x) => [String(x.name), String(this.eval(x.value, input, i))]));
        return { main: input.map((_x, i) => {
          let body: unknown;
          if (p.sendBody) { const raw = this.eval(p.jsonBody, input, i); try { body = JSON.parse(String(raw)); } catch { body = raw; } }
          try {
            const r = this.http({ method: typeof p.method === 'string' ? p.method : 'GET', url: String(this.eval(p.url, input, i)), query: p.sendQuery ? kv(p.queryParameters, i) : {}, ...(p.sendBody ? { body } : {}) });
            return { json: { statusCode: r.statusCode, body: r.body, headers: {} } };
          } catch (e) {
            if (n.config.onError !== 'continueRegularOutput') throw e;
            return { json: { error: { message: (e as Error).message } } };
          }
        }) };
      }
      case 'n8n-nodes-base.respondToWebhook': {
        const opts = (p.options ?? {}) as P;
        const raw = this.eval(p.responseBody, input, 0);
        this.response = { status: Number(this.eval(opts.responseCode, input, 0) ?? 200), body: typeof raw === 'string' ? JSON.parse(raw) as unknown : raw };
        return { main: input };
      }
      default: throw new Error(`${n.name}: node type ${n.type} is not supported by the Lite runner`);
    }
  }

  /** Run from a trigger with its input, following the connections, until nothing more runs. */
  run(start: string, input: Item[]) {
    const queue: [string, Item[]][] = [[start, input]];
    let steps = 0;
    while (queue.length) {
      if (++steps > 500) throw new Error('more than 500 node runs: a loop?');
      const [name, items] = queue.shift()!;
      if (!items.length) continue;
      const n = this.wf.nodes.get(name);
      if (!n) throw new Error(`no node "${name}"`);
      const outputs = this.exec(n, items);
      this.executed.push(name);
      this.out.set(name, outputs.main ?? [...(outputs.true ?? []), ...(outputs.false ?? [])]);
      for (const e of this.wf.edges.filter((x) => x.from === name)) queue.push([e.to, (n.type === 'n8n-nodes-base.if' ? outputs[e.branch] : outputs.main) ?? []]);
    }
    return this;
  }
}

/** A webhook workflow answering one HTTP request, as n8n would. */
export function runWebhook(wf: LoadedWorkflow, http: Http, body: unknown, executionId?: string) {
  const start = [...wf.nodes.values()].find((n) => n.type === 'n8n-nodes-base.webhook');
  if (!start) throw new Error(`${wf.meta.name} has no webhook`);
  const r = new LiteRun(wf, http, executionId).run(start.name, [{ json: { body, headers: {}, query: {} } }]);
  if (!r.response) throw new Error(`${wf.meta.name} finished without answering the webhook`);
  return r;
}

/** A scheduled workflow, run as its "Run Now" manual trigger would; returns the last node's output too. */
export function runNow(wf: LoadedWorkflow, http: Http, executionId?: string) {
  const r = new LiteRun(wf, http, executionId).run('Run Now', [{ json: {} }]);
  const last = r.executed.at(-1)!;
  return { run: r, summary: r.out.get(last)![0]!.json };
}
