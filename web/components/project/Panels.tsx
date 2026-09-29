import { CalendarDays, CircleAlert, ClipboardCheck, FileText, UserRound, Wrench } from 'lucide-react';
import type { ChecklistItem, ExceptionRow, ProjectRow } from '@/lib/queries';
import { CHECK_STATUS, JOB_TYPE, date, label, money } from '@/lib/labels';
import { RISK_SHORT, describeIssue, riskSeverity } from '@/lib/insights';
import { Badge } from '@/components/ui/Badge';
import { CardHead, Empty } from '@/components/ui/Empty';
import { IssueList } from '@/components/dashboard/IssueList';

export function NeedsAttention({ p, action, openIssues }: { p: ProjectRow; action: string | null; openIssues: ExceptionRow[] }) {
  const reasons = [...p.risk_reasons].sort((a, b) => (riskSeverity(a) === 'high' ? -1 : 1) - (riskSeverity(b) === 'high' ? -1 : 1));
  return (
    <section className="card attn" aria-labelledby="attn-h">
      <div className="card-body">
        <h2 id="attn-h" className="t-section" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <CircleAlert size={16} color="var(--bad)" aria-hidden /> Needs attention
        </h2>
        <ul className="attn-list">
          {p.is_active && reasons.map((r) => (
            <li key={r}><span className={`sev ${riskSeverity(r) === 'high' ? '' : 'medium'}`} aria-hidden />{RISK_SHORT[r] ?? r}
              <span className="sr-only">{riskSeverity(r) === 'high' ? ' (high priority)' : ' (watch)'}</span></li>
          ))}
          {openIssues.map((e) => <li key={e.exception_number}><span className="sev medium" aria-hidden />{describeIssue(e).title}</li>)}
        </ul>
        {action && <p className="attn-note"><strong>Next step:</strong> {action}</p>}
        {p.is_active && p.delay_reason && <p className="attn-note"><strong>Project manager note:</strong> {p.delay_reason}</p>}
      </div>
    </section>
  );
}

export function InfoCards({ p }: { p: ProjectRow }) {
  const type = p.customer_type ? p.customer_type.charAt(0) + p.customer_type.slice(1).toLowerCase() : '—';
  return (
    <div className="grid g-3">
      <section className="card">
        <CardHead icon={UserRound} title="Customer" />
        <div className="card-body"><dl className="kv">
          <dt>Name</dt><dd>{p.customer_name}</dd>
          <dt>Customer no.</dt><dd className="num">{p.customer_number}</dd>
          <dt>Type</dt><dd>{type}</dd>
          <dt>Site</dt><dd>{p.site_address}</dd>
        </dl></div>
      </section>
      <section className="card">
        <CardHead icon={FileText} title="Quote" />
        <div className="card-body"><dl className="kv">
          <dt>Quote</dt><dd className="num">{p.quote_number} {p.quote_version ? <span className="t-meta">v{p.quote_version}</span> : null}</dd>
          <dt>Value</dt><dd className="num">{money(p.quote_total_inc_gst)} <span className="t-meta">inc GST</span></dd>
          <dt>Work</dt><dd>{JOB_TYPE(p.job_type)}</dd>
          <dt>Accepted</dt><dd>{date(p.accepted_on)}</dd>
        </dl></div>
      </section>
      <section className="card">
        <CardHead icon={CalendarDays} title="Schedule" />
        <div className="card-body"><dl className="kv">
          <dt>Planned start</dt><dd>{date(p.planned_start_date)}</dd>
          <dt>Planned finish</dt><dd>{date(p.planned_completion_date)}</dd>
          <dt>Started</dt><dd>{p.actual_start_date ? date(p.actual_start_date) : <span className="t-meta">Not started</span>}</dd>
          <dt>Finished</dt><dd>{p.actual_completion_date ? date(p.actual_completion_date) : <span className="t-meta">In progress</span>}</dd>
        </dl></div>
      </section>
    </div>
  );
}

export function ChecklistCard({ items }: { items: ChecklistItem[] }) {
  const done = items.filter((c) => c.status === 'DONE' || c.status === 'WAIVED' || c.status === 'NOT_APPLICABLE').length;
  return (
    <section className="card">
      <CardHead icon={ClipboardCheck} title="Checklist & tasks">{items.length > 0 && <span className="chip num">{done} of {items.length} done</span>}</CardHead>
      <div className="card-body">
        {items.length === 0 ? <Empty icon={ClipboardCheck} title="No checklist recorded" text="Imported projects don't carry a checklist; new projects get one automatically." /> : (
          <ul className="rows">
            {items.map((c, i) => (
              <li key={i}>
                <div style={{ minWidth: 0 }}>
                  <div className="row-main" style={{ fontWeight: c.kind === 'TASK' ? 600 : 500 }}>{c.title}</div>
                  {c.kind === 'TASK' && <div className="row-sub">{[c.due_on ? `Due ${date(c.due_on)}` : null, c.assignee].filter(Boolean).join(' · ')}</div>}
                </div>
                <Badge l={label(CHECK_STATUS, c.status)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function IssuesCard({ issues }: { issues: ExceptionRow[] }) {
  return (
    <section className="card">
      <CardHead icon={Wrench} title="Automation issues" />
      <div className="card-body"><IssueList issues={issues} showWhere={false} /></div>
    </section>
  );
}
