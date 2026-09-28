'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ProjectFilter, ProjectRow } from '@/lib/queries';
import { INVOICE_STATUS, MATERIAL_STATUS, PROJECT_STAGE, RISK_REASON, date, label } from '@/lib/labels';
import { Pill } from './Pill';

const TABS: { key: ProjectFilter; text: string; test: (p: ProjectRow) => boolean }[] = [
  { key: 'active', text: 'Active', test: (p) => p.is_active },
  { key: 'needs_attention', text: 'Needs attention', test: (p) => p.needs_attention },
  { key: 'at_risk', text: 'At risk', test: (p) => p.is_active && p.risk_level === 'HIGH' },
  { key: 'awaiting_materials', text: 'Awaiting materials', test: (p) => p.waiting_on_materials },
  { key: 'ready_to_invoice', text: 'Ready to invoice', test: (p) => p.invoice_status === 'READY_TO_INVOICE' },
  { key: 'completed', text: 'Completed', test: (p) => !p.is_active },
  { key: 'all', text: 'All projects', test: () => true },
];

export function ProjectTable({ rows, initial }: { rows: ProjectRow[]; initial: ProjectFilter }) {
  const router = useRouter();
  const [tab, setTab] = useState<ProjectFilter>(TABS.some((t) => t.key === initial) ? initial : 'active');
  const [text, setText] = useState('');
  const shown = useMemo(() => {
    const t = TABS.find((x) => x.key === tab) ?? TABS[0]!;
    const s = text.trim().toLowerCase();
    return rows.filter((p) => t.test(p) && (!s || `${p.project_number} ${p.customer_name} ${p.site_address} ${p.quote_number}`.toLowerCase().includes(s)));
  }, [rows, tab, text]);

  return (
    <div className="card">
      <div className="toolbar">
        {TABS.map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>
            {t.text} <span className="muted">({rows.filter(t.test).length})</span>
          </button>
        ))}
        <input className="search" placeholder="Search project, customer, address…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search projects" />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Project</th><th>Customer</th><th>Stage</th><th>Scheduled</th><th>Materials</th><th>Invoice</th><th>Risk</th></tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const atRisk = p.is_active && p.risk_level === 'HIGH';
              return (
                <tr key={p.project_number} className="row" onClick={() => router.push(`/projects/${p.project_number}`)}>
                  <td><a className="pn" href={`/projects/${p.project_number}`} onClick={(e) => e.stopPropagation()}>{p.project_number}</a>
                    {p.open_exceptions > 0 && <div className="small" style={{ color: 'var(--bad)' }}>{p.open_exceptions} issue{p.open_exceptions > 1 ? 's' : ''} to review</div>}</td>
                  <td>{p.customer_name}<div className="small muted">{p.site_address}</div></td>
                  <td><Pill l={label(PROJECT_STAGE, p.status)} /></td>
                  <td>{p.is_active ? date(p.planned_start_date) : <span className="muted">Done {date(p.actual_completion_date)}</span>}</td>
                  <td><Pill l={label(MATERIAL_STATUS, p.material_status)} />{p.waiting_on_materials && p.material_eta && <div className="small muted">ETA {date(p.material_eta)}</div>}</td>
                  <td><Pill l={label(INVOICE_STATUS, p.invoice_status)} title={p.invoice_blocker ?? undefined} />
                    {p.xero_invoice_number && <div className="small muted">{p.xero_invoice_number}</div>}</td>
                  <td>{atRisk
                    ? <><span className="dot bad" />At risk{p.risk_reasons.map((r) => <div key={r} className="risk-reason">{RISK_REASON[r] ?? r}</div>)}</>
                    : <span className="muted"><span className="dot good" />{p.is_active ? 'On track' : '—'}</span>}</td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={7} className="muted">No projects match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
