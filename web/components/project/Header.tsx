import Link from 'next/link';
import { ArrowLeft, ExternalLink, FolderOpen } from 'lucide-react';
import type { ProjectRow } from '@/lib/queries';
import { JOB_TYPE, PROJECT_STAGE, airtableProjectUrl, label, type Tone } from '@/lib/labels';
import { projectSeverity, type Health } from '@/lib/insights';
import { Badge } from '@/components/ui/Badge';
import { AskButton } from '@/components/copilot/AskButton';

export function ProjectHeader({ p }: { p: ProjectRow }) {
  const atRisk = p.is_active && p.risk_level === 'HIGH';
  const at = airtableProjectUrl(p.airtable_record_id);
  return (
    <header>
      <Link href="/projects" className="crumb"><ArrowLeft size={14} aria-hidden /> Projects</Link>
      <div className="proj-head">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h1 className="t-project num">{p.project_number}</h1>
            <Badge l={label(PROJECT_STAGE, p.status)} />
            {p.is_active && <Badge l={atRisk ? { text: 'At risk', tone: projectSeverity(p) === 'high' ? 'bad' : 'warn' } : { text: 'On track', tone: 'good' }} />}
          </div>
          <div className="who">{p.customer_name}</div>
          <div className="where">{p.site_address}</div>
          <div className="where">{JOB_TYPE(p.job_type)}{p.project_manager ? ` · PM ${p.project_manager}` : ''}</div>
        </div>
        <div className="badges">
          {p.drive_folder_url && <a className="btn btn-sm" href={p.drive_folder_url} target="_blank" rel="noreferrer"><FolderOpen size={14} aria-hidden /> Google Drive</a>}
          {at && <a className="btn btn-sm" href={at} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden /> Airtable</a>}
          <AskButton question={`What happened to ${p.project_number}?`} />
        </div>
      </div>
    </header>
  );
}

const DOT: Record<Tone, string> = { good: 'h-good', warn: 'h-warn', bad: 'h-bad', info: 'h-info', neutral: 'h-neutral' };

export function HealthStrip({ items }: { items: Health[] }) {
  return (
    <section className="card health" aria-label="Project health">
      {items.map((h) => (
        <div key={h.label}>
          <div className="t-label">{h.label}</div>
          <div className="h-val"><span className={`h-dot ${DOT[h.tone]}`} aria-hidden />{h.value}</div>
        </div>
      ))}
    </section>
  );
}
