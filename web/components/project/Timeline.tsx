'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, Check, ChevronDown, Circle, Copy, History, RotateCw } from 'lucide-react';
import type { TimelineGroup, TimelineTone } from '@/lib/timeline';
import { timelineTitle } from '@/lib/labels';
import { CardHead, Empty } from '@/components/ui/Empty';

const ICON: Record<TimelineTone, React.ReactNode> = {
  done: <Check size={14} aria-hidden />, retry: <RotateCw size={13} aria-hidden />, attention: <AlertCircle size={14} aria-hidden />,
  recorded: <Circle size={9} aria-hidden />, duplicate: <Copy size={12} aria-hidden />,
};
const TONE_TEXT: Record<TimelineTone, string> = { done: 'Completed', retry: 'Retried', attention: 'Needs attention or stopped safely', recorded: 'Recorded', duplicate: 'Duplicate ignored safely' };

function when(g: TimelineGroup) {
  const [d, t] = g.when.split(' ');
  const [y, m, day] = (d ?? '').split('-').map(Number);
  const nice = new Date(Date.UTC(y!, m! - 1, day!)).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return <><span>{t}</span><span className="d">{nice}</span></>;
}

function Item({ g }: { g: TimelineGroup }) {
  const [open, setOpen] = useState(false);
  const many = g.entries.length > 1;
  return (
    <motion.li className="tl-item" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <div className="tl-time num">{when(g)}</div>
      <div className="tl-node"><span className={`tl-icon ${g.tone}`} title={TONE_TEXT[g.tone]}>{ICON[g.tone]}<span className="sr-only">{TONE_TEXT[g.tone]}</span></span></div>
      <div style={{ minWidth: 0 }}>
        <div className="tl-title">{g.title}</div>
        {g.detail && <div className="tl-detail">{g.detail}</div>}
        {g.lines.length > 0 && <ul className="tl-lines">{g.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
        {many && (
          <>
            <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? 'Hide' : 'View'} {g.tone === 'attention' || g.tone === 'retry' ? 'attempts' : 'steps'}
              <ChevronDown size={13} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} aria-hidden />
            </button>
            <AnimatePresence initial={false}>
              {open && (
                <motion.ul className="tl-sub" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden' }}>
                  {g.entries.map((e, i) => (
                    <li key={i}><span className="num muted">{e.occurred_iso.slice(11, 19)}</span><span>{timelineTitle(e.kind)}</span></li>
                  ))}
                </motion.ul>
              )}
            </AnimatePresence>
          </>
        )}
      </div>
    </motion.li>
  );
}

export function Timeline({ groups, initial = 5 }: { groups: TimelineGroup[]; initial?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? groups : groups.slice(0, initial);
  return (
    <section className="card" id="history">
      <CardHead icon={History} title="Automation history"><span className="t-meta">{groups.length} events</span></CardHead>
      <div className="card-body">
        {groups.length === 0 ? <Empty icon={History} title="No history yet" /> : (
          <>
            <ol className="tl">
              <AnimatePresence initial={false}>
                {shown.map((g) => <Item key={g.id} g={g} />)}
              </AnimatePresence>
            </ol>
            {groups.length > initial && (
              <div className="tl-more">
                <button type="button" className="btn btn-sm" aria-expanded={all} onClick={() => setAll(!all)}>
                  {all ? 'Show latest only' : `Show full history (${groups.length - initial} more)`}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
