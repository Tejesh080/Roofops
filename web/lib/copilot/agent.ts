/**
 * Operations Copilot: DeepSeek (OpenAI-compatible chat completions with tool calling), server-side only.
 * The model chooses tools; this code runs them with the dashboard's read-only role and feeds back the results.
 * Structured results that matter (the invoice preview) are returned to the UI as cards straight from the
 * database, so the figures a person approves never come from model-generated text.
 */
import { TOOLS, toolSchemas, type ToolCard, type ToolContext } from './tools.ts';
import type { Query } from '../queries.ts';

export interface ChatTurn { role: 'user' | 'assistant'; content: string }
export interface ToolStep { tool: string; tier: string; args: Record<string, unknown>; ok: boolean }
export interface CopilotReply { reply: string; steps: ToolStep[]; cards: ToolCard[]; model: string }

interface Msg { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

const MAX_ROUNDS = 6;

function systemPrompt(today: string): string {
  return [
    'You are the RoofOps Operations Copilot for a small Australian roofing business. You speak to the owner, who is not technical.',
    `Today is ${today} (demo business date). All data is synthetic demo data for a fictional business.`,
    'Rules:',
    '- Answer ONLY from tool results. Never guess numbers, names, dates or statuses. If a tool has no data, say so.',
    '- Describe each item only with the facts given for THAT item. Never generalise across items (e.g. do not say "all" unless every item says it).',
    '- Use the status words exactly as the tools give them (e.g. "Needs attention" is not "retry in progress"; "Ready to invoice" means not prepared yet).',
    '- Always use a tool before answering a question about projects, invoices, materials, risk or history.',
    '- Use plain business English: say "needs attention", "failed safely", "duplicate ignored safely", "retry in progress". Never use words like idempotency, webhook, cursor, outbox, transaction, exception class, SQL.',
    '- Mention project numbers (PRJ-YYYY-NNNN) and customer names so the owner can find them. Use AUD with $ and two decimals.',
    '- Keep answers short: a one-line summary, then a few bullet points. No tables.',
    '- Invoices: you can only PREPARE a preview (prepare_invoice) when the user explicitly asks. You cannot create, approve, send or pay an invoice. '
      + 'After preparing, state the amount and that it now waits for a finance approver, who approves it in Airtable; only then does RoofOps create one DRAFT invoice in the Xero Demo Company.',
    '- Never offer to prepare an invoice that is already awaiting approval or already in Xero.',
    '- After prepare_invoice returns a preview, the app shows the figures in a card: reply in at most two sentences (amount, and that it now waits for a finance approver). Do not repeat the breakdown.',
    '- If asked to do anything else that changes data (approve, send, pay, delete, email), explain that it must be done by a person in the normal process.',
  ].join('\n');
}

async function chat(messages: Msg[]): Promise<{ message: Msg; model: string }> {
  const key = process.env.DEEPSEEK_API_KEY;
  const base = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash';
  if (!key) throw new Error('The copilot is not configured (DEEPSEEK_API_KEY missing on the server).');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, tools: toolSchemas(), tool_choice: 'auto', temperature: 0, max_tokens: 900 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`DeepSeek answered HTTP ${res.status}`);
  const body = (await res.json()) as { choices?: { message: Msg }[]; model?: string };
  const message = body.choices?.[0]?.message;
  if (!message) throw new Error('DeepSeek returned no answer');
  return { message, model: body.model ?? model };
}

export async function runCopilot(query: Query, history: ChatTurn[], requestId: string): Promise<CopilotReply> {
  const turns = history.filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string').slice(-10)
    .map((t) => ({ role: t.role, content: t.content.slice(0, 2000) }));
  const lastUser = [...turns].reverse().find((t) => t.role === 'user')?.content ?? '';
  const [{ today } = { today: '' }] = await query<{ today: string }>('select as_of::text as today from v_dashboard_kpis');
  const messages: Msg[] = [{ role: 'system', content: systemPrompt(today) }, ...turns];
  const ctx: ToolContext = { query, requestId, lastUserMessage: lastUser };
  const steps: ToolStep[] = [];
  const cards: ToolCard[] = [];
  let model = '';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { message, model: m } = await chat(messages);
    model = m;
    const calls = message.tool_calls ?? [];
    if (!calls.length) return { reply: (message.content ?? '').trim(), steps, cards, model };
    messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: calls });
    for (const call of calls) {
      const tool = TOOLS[call.function.name];
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>; } catch { /* treated as no args */ }
      let content: string;
      if (!tool) {
        content = JSON.stringify({ error: `Unknown tool ${call.function.name}` });
        steps.push({ tool: call.function.name, tier: 'NONE', args, ok: false });
      } else {
        try {
          const r = await tool.run(args, ctx);
          if (r.card) cards.push(r.card);
          content = JSON.stringify(r.data);
          steps.push({ tool: call.function.name, tier: tool.tier, args, ok: true });
        } catch (e) {
          content = JSON.stringify({ error: 'The data could not be read right now.' });
          steps.push({ tool: call.function.name, tier: tool.tier, args, ok: false });
          console.error(`copilot tool ${call.function.name} failed:`, (e as Error).message);
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  return { reply: 'Sorry, I could not finish that question. Please try asking it more simply.', steps, cards, model };
}
