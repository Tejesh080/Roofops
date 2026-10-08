'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, ChevronRight, FileCheck2, Loader2, Sparkles, X } from 'lucide-react';
import type { CopilotReply, ToolStep } from '@/lib/copilot/agent';
import type { PreparedInvoiceCard, ToolCard } from '@/lib/copilot/tools';
import { INVOICE_NEXT_STEP, airtableProjectUrl, date, money } from '@/lib/labels';
import { useToast } from '@/components/ui/Providers';
import { ASK_EVENT } from './AskButton';

interface Turn { role: 'user' | 'assistant'; content: string; steps?: ToolStep[]; cards?: ToolCard[]; error?: boolean }

const SUGGESTED: { label: string; q: string }[] = [
  { label: 'Projects needing attention', q: 'Which projects need attention today?' },
  { label: 'Waiting on materials', q: 'Which projects are waiting on materials?' },
  { label: 'Ready to invoice', q: 'Which projects are ready to invoice?' },
  { label: 'Why is PRJ-2026-0011 at risk?', q: 'Why is PRJ-2026-0011 at risk?' },
  { label: 'What happened to PRJ-2026-0033?', q: 'What happened to PRJ-2026-0033?' },
  { label: 'Prepare invoice for PRJ-2026-0005', q: 'Prepare invoice for PRJ-2026-0005' },
];

function evidenceText(s: ToolStep): string {
  const p = typeof s.args.project_number === 'string' ? s.args.project_number.toUpperCase() : '';
  switch (s.tool) {
    case 'business_overview': return 'Headline business numbers';
    case 'what_needs_attention_today': return "Today's risks, issues, approvals and payments";
    case 'list_projects': return `Project list · ${String(s.args.group ?? '').replace(/_/g, ' ')}`;
    case 'get_project': return `${p}: schedule, supplier status, invoices`;
    case 'get_project_history': return `${p}: automation history`;
    case 'list_open_issues': return 'Open automation issues';
    case 'prepare_invoice': return `${p}: invoice preview (no invoice created)`;
    default: return s.tool;
  }
}

/** Safe mini-formatter: paragraphs, bullets and **bold**. No HTML is injected. */
function Answer({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>);
  const flush = () => { if (bullets.length) { blocks.push(<ul key={blocks.length}>{bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}</ul>); bullets = []; } };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const b = /^[-*•]\s+(.*)$/.exec(line) ?? /^\d+[.)]\s+(.*)$/.exec(line);
    if (b) bullets.push(b[1]!); else { flush(); blocks.push(<p key={blocks.length}>{inline(line.replace(/^#+\s*/, ''))}</p>); }
  }
  flush();
  return <div className="answer">{blocks}</div>;
}

function InvoiceAction({ c }: { c: PreparedInvoiceCard }) {
  const p = c.preview;
  const awaiting = c.outcome === 'PREVIEW_READY' || c.outcome === 'ALREADY_PENDING';
  const at = airtableProjectUrl(c.airtable_record_id);
  return (
    <div className="action-card" role="group" aria-label="Proposed action: invoice preview">
      <div className="ac-head"><FileCheck2 size={15} aria-hidden />
        {awaiting ? 'Draft invoice prepared' : c.outcome === 'ALREADY_INVOICED' ? 'Already invoiced' : 'Invoice not prepared'}
        {awaiting && <span className="badge warn"><span className="dot" aria-hidden />Approval required</span>}
      </div>
      <div className="ac-body">
        <div className="ac-proj"><strong>{c.project}</strong>{p ? ` · ${p.customer_name}` : ''}</div>
        {p ? (
          <>
            <div className="ac-amt">{money(p.amount_inc_gst)} <small>inc GST</small></div>
            <table className="ac-rows"><tbody>
              <tr><td>Quote {p.quote_number} v{p.quote_version}</td><td>{money(p.quote_total_inc_gst)}</td></tr>
              {p.approved_variations_inc_gst > 0 && <tr><td>Approved variations</td><td>{money(p.approved_variations_inc_gst)}</td></tr>}
              <tr><td>Already invoiced</td><td>− {money(p.billed_to_date_inc_gst)}</td></tr>
              <tr><td><strong>Final amount</strong> <span className="muted">(GST {money(p.gst_amount)})</span></td><td>{money(p.amount_inc_gst)}</td></tr>
              <tr><td>Reference · due</td><td>{p.reference} · {date(p.due_date)}</td></tr>
            </tbody></table>
            {awaiting && <div className="ac-status"><span className="pulse" aria-hidden />Awaiting finance approval{c.approval_number ? ` · ${c.approval_number}` : ''}</div>}
            <div className="ac-note">{awaiting ? `Nothing has been sent to Xero. Once approved, RoofOps creates one draft invoice in ${p.xero_tenant_name || 'the Xero Demo Company'} and checks it. ${INVOICE_NEXT_STEP.approve}` : c.message}</div>
          </>
        ) : <div className="ac-note">{c.message}</div>}
      </div>
      <div className="ac-foot">
        {awaiting && at && <a className="btn btn-sm btn-primary" href={at} target="_blank" rel="noreferrer">Open approval in Airtable</a>}
        <Link className="btn btn-sm" href={`/projects/${c.project}`}>View project</Link>
      </div>
    </div>
  );
}

export function CopilotDrawer() {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const turnsRef = useRef<Turn[]>(turns);
  turnsRef.current = turns;

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' }); }, [turns, busy]);
  useEffect(() => { if (open) setTimeout(() => box.current?.focus(), 120); }, [open]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, []);

  const ask = useCallback(async (question: string) => {
    const q = question.trim();
    if (!q) return;
    setOpen(true);
    const next: Turn[] = [...turnsRef.current, { role: 'user', content: q }];
    setTurns(next); setInput(''); setBusy(true);
    try {
      const res = await fetch('/api/copilot', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.content })) }) });
      if (res.status === 401) { window.location.href = '/login'; return; }
      const body = (await res.json()) as CopilotReply & { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'The copilot is unavailable right now.');
      setTurns([...next, { role: 'assistant', content: body.reply, steps: body.steps, cards: body.cards }]);
      const prepared = body.cards.find((c) => c.data.outcome === 'PREVIEW_READY');
      if (prepared) toast({ title: 'Invoice preview prepared', sub: `${prepared.data.project} · awaiting finance approval` });
      if (body.cards.length) router.refresh();
    } catch (e) {
      setTurns([...next, { role: 'assistant', content: (e as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  }, [router, toast]);

  useEffect(() => {
    const onAsk = (e: Event) => { void ask(String((e as CustomEvent).detail ?? '')); };
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, [ask]);

  return (
    <>
      <AnimatePresence>
        {!open && (
          <motion.button type="button" className="ask-fab" onClick={() => setOpen(true)} aria-label="Ask RoofOps (open the Operations Copilot)"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} whileHover={{ y: -1 }}>
            <Sparkles size={16} aria-hidden /> Ask RoofOps
          </motion.button>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {open && (
          <>
            <motion.div className="drawer-scrim" onClick={() => setOpen(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} aria-hidden />
            <motion.aside className="drawer" role="dialog" aria-modal="true" aria-label="Operations Copilot"
              initial={{ x: 48, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 48, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 420, damping: 38, mass: 0.9 }}>
              <div className="drawer-head">
                <span className="spark"><Sparkles size={15} aria-hidden /></span>
                <div style={{ flex: 1 }}>
                  <div className="d-title">Operations Copilot</div>
                  <div className="d-sub">Answers from live RoofOps data · prepares, never sends</div>
                </div>
                {turns.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTurns([])}>New chat</button>}
                <button type="button" className="btn btn-ghost icon-btn" onClick={() => setOpen(false)} aria-label="Close copilot"><X size={17} aria-hidden /></button>
              </div>
              <div className="drawer-log" ref={log} aria-live="polite">
                {turns.length === 0 && (
                  <div className="drawer-intro">
                    <div className="q">What needs attention?</div>
                    <p className="p">Ask about projects, suppliers, invoices or what happened to a job. Invoices can be prepared for approval; only a person can approve them.</p>
                    <div className="t-label" style={{ marginBottom: 8 }}>Suggested</div>
                    <div className="suggest">{SUGGESTED.map((s) => <button key={s.q} type="button" onClick={() => void ask(s.q)}>{s.label}</button>)}</div>
                  </div>
                )}
                {turns.map((t, i) => t.role === 'user'
                  ? <motion.div key={i} className="m-user" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>{t.content}</motion.div>
                  : (
                    <motion.div key={i} className="m-ai" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                      <div className="who"><Sparkles size={12} aria-hidden /> RoofOps</div>
                      {t.error ? <div className="err-box" role="alert">{t.content}</div> : <Answer text={t.content} />}
                      {t.cards?.map((c, j) => <InvoiceAction key={j} c={c.data} />)}
                      {!!t.steps?.length && (
                        <details className="evidence">
                          <summary><ChevronRight size={12} className="chev" aria-hidden /> Checked {t.steps.length} source{t.steps.length > 1 ? 's' : ''} in RoofOps</summary>
                          <ul>{t.steps.map((s, j) => <li key={j}><span className={`tier ${s.tier === 'AMBER' ? 'prep' : 'read'}`}>{s.tier === 'AMBER' ? 'PREPARE' : 'READ'}</span>{evidenceText(s)}</li>)}</ul>
                        </details>
                      )}
                    </motion.div>
                  ))}
                {busy && <div className="m-ai"><div className="who"><Sparkles size={12} aria-hidden /> RoofOps</div><span className="typing" aria-label="Looking that up"><span /><span /><span /></span></div>}
                {turns.length > 0 && !busy && (
                  <div className="suggest">{SUGGESTED.filter((s) => !turns.some((t) => t.content === s.q)).slice(0, 3).map((s) =>
                    <button key={s.q} type="button" onClick={() => void ask(s.q)}>{s.label}</button>)}</div>
                )}
              </div>
              <form className="drawer-form" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
                <div className="composer">
                  <textarea ref={box} rows={1} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about projects, materials, invoices…"
                    aria-label="Ask the copilot" disabled={busy}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(input); } }} />
                  <button className="btn btn-primary icon-btn" disabled={busy || !input.trim()} aria-label="Send">
                    {busy ? <Loader2 size={15} className="spin" aria-hidden /> : <ArrowUp size={16} aria-hidden />}
                  </button>
                </div>
                <div className="drawer-foot-note">Read-only answers · invoice preparation needs a person&apos;s approval</div>
              </form>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
