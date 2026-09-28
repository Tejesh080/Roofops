/**
 * Live smoke test of the Operations Copilot through the running dashboard (real DeepSeek, real hosted data).
 *   npm --prefix web run dev      (in another terminal)
 *   npx tsx scripts/copilot-smoke.ts [http://127.0.0.1:3000]
 * For each interview question: the expected tool must be used, and the answer must mention the facts the
 * database says are true (read from the same dashboard views as the owner connection). Writes
 * evidence/phase4-copilot-smoke.json. Re-running is safe: the prepare question on an already-prepared project
 * returns the existing preview and creates nothing.
 */
import { writeFileSync } from 'node:fs';
import { openPostgres } from '../src/db/db.js';
import { hostedDbConfig } from '../src/config/env.js';

const base = process.argv[2] ?? 'http://127.0.0.1:3000';
const cfg = hostedDbConfig();
const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
const col = async (sql: string) => (await db.query<{ v: string }>(sql)).map((r) => r.v);
const truth = {
  atRisk: await col(`select project_number v from v_dashboard_projects where is_active and risk_level = 'HIGH' order by 1`),
  waiting: await col(`select project_number v from v_dashboard_projects where waiting_on_materials order by 1`),
  ready: await col(`select project_number v from v_dashboard_projects where invoice_status = 'READY_TO_INVOICE' order by 1`),
  prj5: await col(`select coalesce(pending_approval_number, '') || '|' || invoice_amount_inc_gst::text v from v_dashboard_projects where project_number = 'PRJ-2026-0005'`),
};
const counts = async () => (await db.query<Record<string, string>>(`select (select count(*) from v_dashboard_projects where invoice_status = 'AWAITING_APPROVAL')::text approvals,
  (select count(*) from v_dashboard_projects where final_invoice_number is not null)::text final_invoices, (select count(*) from v_dashboard_exceptions)::text issues`))[0]!;
const before = await counts();

const fmt = (n: string) => Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2 });
const [apr5, amt5] = truth.prj5[0]!.split('|');
const CASES: { q: string; tool: string | string[]; mustMention: string[] }[] = [
  { q: 'Which projects need attention today?', tool: 'what_needs_attention_today', mustMention: truth.atRisk },
  { q: 'Why is PRJ-2026-0011 at risk?', tool: 'get_project', mustMention: ['PRJ-2026-0011', 'supplier', 'start'] },
  { q: 'Which projects are waiting on materials?', tool: 'list_projects', mustMention: [String(truth.waiting.length)] },
  { q: 'Which projects are ready to invoice?', tool: 'list_projects', mustMention: truth.ready },
  { q: 'What happened to PRJ-2026-0004?', tool: 'get_project_history', mustMention: ['RO-INV-2026-0039', '14,664.49', 'draft'] },
  // Already prepared by the first live demo: the copilot may re-run the preview or just look it up; either way it must
  // report the existing approval and amount, and create nothing new (checked below).
  { q: 'Prepare invoice for PRJ-2026-0005', tool: apr5 ? ['prepare_invoice', 'get_project'] : 'prepare_invoice', mustMention: [fmt(amt5!), 'approv', ...(apr5 ? [apr5] : [])] },
];

const results = [];
let failed = 0;
for (const c of CASES) {
  const t0 = Date.now();
  const res = await fetch(`${base}/api/copilot`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: c.q }] }) });
  const body = (await res.json()) as { reply?: string; steps?: { tool: string; tier: string; ok: boolean }[]; cards?: { data: { outcome: string; approval_number?: string } }[]; model?: string; error?: string };
  const reply = body.reply ?? '';
  const tools = (body.steps ?? []).map((s) => s.tool);
  const missing = c.mustMention.filter((m) => !reply.toLowerCase().includes(m.toLowerCase()));
  const ok = res.ok && [c.tool].flat().some((t) => tools.includes(t)) && (body.steps ?? []).every((s) => s.ok) && missing.length === 0;
  if (!ok) failed++;
  results.push({ question: c.q, ok, http: res.status, ms: Date.now() - t0, model: body.model, tools, missing, cards: body.cards?.map((k) => k.data.outcome), reply });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.q}  [${tools.join(', ')}]${missing.length ? `  missing: ${missing.join(', ')}` : ''}`);
}

const after = await counts();
const prepareCard = results.at(-1)?.cards?.[0];
const nothingCreated = JSON.stringify(before) === JSON.stringify(after);
console.log(`prepare card: ${prepareCard ?? 'none'} (${apr5}); records before/after identical: ${nothingCreated}`);
if (!nothingCreated) failed++;
writeFileSync('evidence/phase4-copilot-smoke.json', JSON.stringify({ ran_at: new Date().toISOString(), base, truth, before, after, results }, null, 2));
await db.close();
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
