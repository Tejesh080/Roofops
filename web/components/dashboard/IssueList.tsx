import Link from 'next/link';
import { ChevronRight, ShieldCheck } from 'lucide-react';
import type { ExceptionRow, ExceptionSource } from '@/lib/queries';
import { EXCEPTION_STATUS, label, plainResolution } from '@/lib/labels';
import { describeIssue } from '@/lib/insights';
import { Badge } from '@/components/ui/Badge';
import { Empty } from '@/components/ui/Empty';

export function IssueList({ issues, emptyTitle = 'No automation issues', showWhere = true, action, sources = {} }: { issues: ExceptionRow[]; emptyTitle?: string; showWhere?: boolean;
  action?: (e: ExceptionRow) => React.ReactNode; sources?: Record<string, ExceptionSource> }) {
  if (!issues.length) return <Empty icon={ShieldCheck} title={emptyTitle} text="Every automated step completed normally." />;
  return (
    <div>
      {issues.map((e) => {
        const d = describeIssue(e);
        const src = sources[e.exception_number];
        // Where to look: the project, else the record the event named, else the Airtable record it came from.
        const where = e.project_number ?? e.business_reference ?? src?.named_record ?? (src?.airtable_record_id ? `Airtable record ${src.airtable_record_id}` : null);
        return (
          <div className="issue" key={e.exception_number}>
            <div className="issue-title">
              {d.title}{' '}
              {showWhere && where && (e.project_number
                ? <Link href={`/projects/${e.project_number}`} className="t-meta" style={{ fontWeight: 550 }}>· {where}</Link>
                : <span className="t-meta">· {where}</span>)}
            </div>
            <Badge l={label(EXCEPTION_STATUS, e.resolution_status)} />
            <div className="issue-expl">{d.explanation}{e.resolution_note ? ` ${plainResolution(e.resolution_note)}.` : ''}</div>
            <details className="tech">
              <summary><ChevronRight size={12} aria-hidden /> Technical details</summary>
              <div className="tech-grid">
                <span className="t-meta">Reference</span><span className="mono">{e.error_class} · {e.exception_number}</span><span />
                <span className="t-meta">Raised</span><span className="mono">{e.first_failed_at} · {e.attempt_count} attempt{e.attempt_count > 1 ? 's' : ''}</span><span />
                <span className="t-meta">Message</span><span className="mono">{e.error_message}</span><span />
                {src && <><span className="t-meta">Came from</span><span className="mono">{src.source ?? 'unknown'} · {src.event_type ?? 'event'}{src.airtable_record_id ? ` · record ${src.airtable_record_id}` : ''}{src.named_record ? ` · ${src.named_record}` : ''}</span><span /></>}
              </div>
            </details>
            {action?.(e)}
          </div>
        );
      })}
    </div>
  );
}
