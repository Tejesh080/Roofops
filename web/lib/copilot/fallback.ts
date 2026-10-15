/**
 * When the AI provider is unavailable, the copilot still answers the common questions straight from RoofOps data, using
 * the same GREEN (read-only) tools the model would have called. Deterministic: no model, no guessing, no writes. It
 * never prepares, approves or changes anything; it says how to do that the normal way.
 */
import { money } from '../labels.ts';
import { TOOLS, normaliseProject, type ToolContext } from './tools.ts';
import type { CopilotReply, ToolStep } from './agent.ts';

export type Unavailable = 'busy' | 'timeout' | 'not_configured' | 'bad_answer';

const WHY: Record<Unavailable, string> = {
  busy: 'The AI assistant is unavailable right now (the provider is busy)',
  timeout: 'The AI assistant did not answer in time',
  not_configured: 'The AI assistant is not set up on this server',
  bad_answer: 'The AI assistant gave an unusable answer',
};

/** The normal path that needs no assistant (INVOICE_NEXT_STEP.prepare also offers the Copilot, which is the thing that is down). */
const PREPARE_WITHOUT_AI = 'Prepare it the normal way: in Airtable, set the project’s Invoice Action to “Prepare Xero draft invoice”. A finance approver then checks and approves it.';

type R = Record<string, unknown>;
const list = (v: unknown) => (Array.isArray(v) ? (v as R[]) : []);
const projectIn = (q: string) => /\bPRJ[-\s]?\d{4}[-\s]?\d{1,4}\b/i.exec(q)?.[0].replace(/\s/g, '-');

async function run(name: string, args: R, ctx: ToolContext, steps: ToolStep[]): Promise<R> {
  const tool = TOOLS[name]!;
  const r = await tool.run(args, ctx);
  steps.push({ tool: name, tier: tool.tier, args, ok: true });
  return r.data as R;
}

function projectAnswer(d: R): string {
  if (d.error) return `${String(d.error)}. Project numbers look like PRJ-2026-0004.`;
  const inv = (d.invoice_detail ?? {}) as R;
  const lines = [`**${String(d.project)}** · ${String(d.customer)}: status **${String(d.stage)}**.`];
  lines.push(`- Materials: ${String(d.materials)}`);
  lines.push(`- Invoice: ${String(inv.status ?? d.invoice)}${inv.why_not_ready ? ` (${String(inv.why_not_ready)})` : ''}`
    + `${inv.xero_invoice_number ? `; Xero ${String(inv.xero_invoice_number)}` : ''}`);
  const reasons = list(d.risk_reasons).map(String);
  if (d.at_risk) lines.push(`- At risk: ${reasons.join('; ') || 'yes'}`);
  const issues = list(d.open_issues);
  lines.push(`- Open issues: ${issues.length ? issues.map((i) => `${String(i.id)} ${String(i.what)}`).join('; ') : 'none'}`);
  const sync = (d.airtable_sync ?? {}) as R;
  if (sync.in_sync === false) lines.push(`- Airtable currently shows "${String(sync.airtable_currently_reports)}"; RoofOps keeps "${String(sync.roofops_canonical_status)}" until the next sync checks it.`);
  return lines.join('\n');
}

function attentionAnswer(d: R): string {
  const sec = (title: string, rows: R[], fmt: (r: R) => string) => (rows.length ? [`**${title} (${rows.length})**`, ...rows.slice(0, 8).map((r) => `- ${fmt(r)}`)] : []);
  const out = [
    ...sec('At risk', list(d.at_risk), (r) => `${String(r.project)} ${String(r.customer)}: ${list(r.risk_reasons).map(String).join('; ')}`),
    ...sec('Open automation issues', list(d.open_automation_issues), (r) => `${String(r.project_or_quote ?? '')} ${String(r.what)}: ${String(r.detail)}`),
    ...sec('Invoices awaiting approval', list(d.invoices_awaiting_approval), (r) => `${String(r.project)} ${String(r.customer)} ${money(Number(r.amount_inc_gst))}`),
    ...sec('Ready to invoice (not prepared yet)', list(d.ready_to_invoice), (r) => `${String(r.project)} ${String(r.customer)} ${money(Number(r.amount_inc_gst))}`),
    ...sec('Overdue payments', list(d.overdue_payments), (r) => `${String(r.project)} ${String(r.customer)} owes ${money(Number(r.outstanding_inc_gst))}`),
  ];
  return out.length ? out.join('\n') : 'Nothing needs a person today.';
}

function issuesAnswer(d: R): string {
  const items = list(d.items ?? d.issues ?? d);
  return items.length ? [`**Open automation issues (${items.length})**`, ...items.slice(0, 10).map((i) =>
    `- ${String(i.id ?? i.exception ?? '')} ${String(i.project_or_quote ?? i.project ?? '')}: ${String(i.what ?? '')} ${String(i.detail ?? '')}`.replace(/\s+/g, ' '))].join('\n')
    : 'There are no open automation issues.';
}

/** A plain answer from RoofOps data, or guidance when the question needs the assistant. Throws only if the data cannot be read. */
export async function answerWithoutAi(lastUser: string, ctx: ToolContext, why: Unavailable, done: { steps?: ToolStep[]; cards?: CopilotReply['cards'] } = {}): Promise<CopilotReply> {
  const steps: ToolStep[] = [...(done.steps ?? [])];
  const cards = done.cards ?? [];
  const q = lastUser.toLowerCase();
  const head = `${WHY[why]}, so this answer comes straight from RoofOps data.`;
  let body: string;
  if (cards.length) {
    // A preview was already prepared before the assistant failed: report it, never prepare it again.
    body = cards.map((c) => `${c.data.project}: ${c.data.status_text}`).join('\n');
  } else if (/\b(prepare|raise|create|make|draft)\b.*\binvoice|\binvoice\b.*\b(prepare|raise)/.test(q)) {
    body = `Nothing was prepared: preparing an invoice here needs the assistant. ${PREPARE_WITHOUT_AI}`;
  } else if (projectIn(lastUser)) {
    body = projectAnswer(await run('get_project', { project_number: normaliseProject(projectIn(lastUser)) }, ctx, steps));
  } else if (/attention|today|urgent|priorit|at risk|overdue/.test(q)) {
    body = attentionAnswer(await run('what_needs_attention_today', {}, ctx, steps));
  } else if (/\bissue|exception|failed|stuck|error/.test(q)) {
    body = issuesAnswer(await run('list_open_issues', {}, ctx, steps));
  } else {
    body = 'Without the assistant I can answer: a project number (for example "PRJ-2026-0004"), "what needs attention today" or "open issues". '
      + 'Every page of the dashboard works as usual; nothing needs the assistant.';
  }
  return { reply: `${head}\n\n${body}`, steps, cards, model: 'none (RoofOps data, no AI)', fallback: why };
}
