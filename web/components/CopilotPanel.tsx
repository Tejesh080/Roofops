'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CopilotReply } from '@/lib/copilot/agent';
import type { PreparedInvoiceCard, ToolCard } from '@/lib/copilot/tools';
import { airtableProjectUrl, date, money } from '@/lib/labels';

interface Turn { role: 'user' | 'assistant'; content: string; steps?: CopilotReply['steps']; cards?: ToolCard[]; error?: boolean }

const SUGGESTIONS = [
  'Which projects need attention today?',
  'Why is PRJ-2026-0011 at risk?',
  'Which projects are waiting on materials?',
  'Which projects are ready to invoice?',
  'What happened to PRJ-2026-0004?',
  'Prepare invoice for PRJ-2026-0001',
];

const STEP_TEXT: Record<string, string> = {
  business_overview: 'business overview', list_projects: 'project list', what_needs_attention_today: "today's attention list",
  get_project: 'project details', get_project_history: 'project history', list_open_issues: 'open issues', prepare_invoice: 'invoice preview',
};

/** Tiny, safe formatter for the copilot's plain text: paragraphs, "- " bullets and **bold**. No HTML is injected. */
function Rich({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>);
  const flush = () => { if (bullets.length) { blocks.push(<ul key={blocks.length}>{bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}</ul>); bullets = []; } };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const b = /^[-*•]\s+(.*)$/.exec(line) ?? /^\d+[.)]\s+(.*)$/.exec(line);
    if (b) bullets.push(b[1]!);
    else { flush(); blocks.push(<p key={blocks.length}>{inline(line.replace(/^#+\s*/, ''))}</p>); }
  }
  flush();
  return <>{blocks}</>;
}

function InvoicePreview({ c }: { c: PreparedInvoiceCard }) {
  const p = c.preview;
  const at = airtableProjectUrl(c.airtable_record_id);
  const awaiting = c.outcome === 'PREVIEW_READY' || c.outcome === 'ALREADY_PENDING';
  return (
    <div className="preview-card">
      <div className="small" style={{ fontWeight: 700, color: 'var(--warn)' }}>INVOICE PREVIEW · {c.status_text.toUpperCase()}</div>
      {p ? (
        <>
          <div className="amt">{money(p.amount_inc_gst)} <span className="small muted">inc GST</span></div>
          <dl className="kv">
            <dt>Project</dt><dd>{p.project_number}</dd>
            <dt>Customer</dt><dd>{p.customer_name}</dd>
            <dt>GST / ex GST</dt><dd>{money(p.gst_amount)} / {money(p.amount_ex_gst)}</dd>
            <dt>How calculated</dt><dd>Quote {p.quote_number} {money(p.quote_total_inc_gst)}{p.approved_variations_inc_gst ? ` + variations ${money(p.approved_variations_inc_gst)}` : ''} − already invoiced {money(p.billed_to_date_inc_gst)}</dd>
            <dt>Reference</dt><dd>{p.reference}</dd>
            <dt>Due</dt><dd>{date(p.due_date)}</dd>
            <dt>Xero organisation</dt><dd>{p.xero_tenant_name || 'not connected'}</dd>
            {c.approval_number && <><dt>Approval ref</dt><dd>{c.approval_number}</dd></>}
          </dl>
        </>
      ) : <p>{c.message}</p>}
      {awaiting && (
        <p className="small" style={{ marginTop: 8 }}>
          <strong>Not created yet.</strong> A finance approver must approve it. Once approved, RoofOps creates one <em>draft</em> invoice in the Xero Demo Company and checks it.
          {at && <> <a href={at} target="_blank" rel="noreferrer">Approve in Airtable →</a></>}
        </p>
      )}
    </div>
  );
}

export function CopilotPanel() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' }); }, [turns, busy]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    const next: Turn[] = [...turns, { role: 'user', content: q }];
    setTurns(next); setInput(''); setBusy(true);
    try {
      const res = await fetch('/api/copilot', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.content })) }) });
      const body = (await res.json()) as CopilotReply & { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'The copilot is unavailable right now.');
      setTurns([...next, { role: 'assistant', content: body.reply, steps: body.steps, cards: body.cards }]);
      if (body.cards.length) router.refresh();
    } catch (e) {
      setTurns([...next, { role: 'assistant', content: (e as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!open && <button className="btn copilot-toggle" onClick={() => setOpen(true)}>Ask RoofOps</button>}
      <aside className={`copilot ${open ? 'open' : ''}`} aria-label="Operations Copilot">
        <div className="copilot-head">
          <div className="title">Operations Copilot <button className="copilot-close" onClick={() => setOpen(false)} aria-label="Close copilot">×</button></div>
          <div className="small muted">Answers from live RoofOps data. It can prepare an invoice for approval, but never creates or sends one.</div>
        </div>
        <div className="copilot-log" ref={log}>
          {!turns.length && (
            <>
              <p className="small muted" style={{ margin: 0 }}>Try one of these:</p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => <button key={s} className="suggestion" onClick={() => void ask(s)}>{s}</button>)}
              </div>
            </>
          )}
          {turns.map((t, i) => (
            <div key={i} className={`msg ${t.role}`} style={t.error ? { background: 'var(--bad-bg)', color: 'var(--bad)' } : undefined}>
              {t.role === 'assistant' ? <Rich text={t.content} /> : t.content}
              {t.cards?.map((c, j) => <div key={j} style={{ marginTop: 8 }}><InvoicePreview c={c.data} /></div>)}
              {!!t.steps?.length && (
                <div className="steps">Checked: {[...new Set(t.steps.map((s) => STEP_TEXT[s.tool] ?? s.tool))].join(' · ')}</div>
              )}
            </div>
          ))}
          {busy && <div className="msg assistant muted">Looking that up…</div>}
          {!!turns.length && !busy && (
            <div className="suggestions">
              {SUGGESTIONS.filter((s) => !turns.some((t) => t.content === s)).slice(0, 3).map((s) =>
                <button key={s} className="suggestion" onClick={() => void ask(s)}>{s}</button>)}
            </div>
          )}
        </div>
        <form className="copilot-form" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about projects, materials, invoices…" aria-label="Ask the copilot" disabled={busy} />
          <button className="btn" disabled={busy || !input.trim()}>Ask</button>
        </form>
      </aside>
    </>
  );
}
