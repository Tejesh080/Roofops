'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, FolderSearch, Search } from 'lucide-react';
import type { ProjectRow } from '@/lib/queries';
import { INVOICE_STATUS, MATERIAL_STATUS, PROJECT_STAGE, date, label } from '@/lib/labels';
import { RISK_SHORT, projectSeverity } from '@/lib/insights';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import { Empty } from '@/components/ui/Empty';

export type TableFilter = 'active' | 'attention' | 'at_risk' | 'awaiting_materials' | 'ready_to_invoice' | 'issues' | 'completed' | 'all';

export const FILTERS: { key: TableFilter; text: string; test: (p: ProjectRow) => boolean }[] = [
  { key: 'active', text: 'Active', test: (p) => p.is_active },
  { key: 'attention', text: 'Needs attention', test: (p) => p.needs_attention },
  { key: 'at_risk', text: 'At risk', test: (p) => p.is_active && p.risk_level === 'HIGH' },
  { key: 'awaiting_materials', text: 'Awaiting materials', test: (p) => p.waiting_on_materials },
  { key: 'ready_to_invoice', text: 'Ready to invoice', test: (p) => p.invoice_status === 'READY_TO_INVOICE' },
  { key: 'issues', text: 'Open issues', test: (p) => p.open_exceptions > 0 },
  { key: 'completed', text: 'Completed', test: (p) => !p.is_active },
  { key: 'all', text: 'All', test: () => true },
];

const street = (site: string) => site.split(',')[0] ?? site;

function RiskCell({ p }: { p: ProjectRow }) {
  if (!p.is_active) return <span className="ok-text">—</span>;
  if (p.risk_level !== 'HIGH') return <span className="ok-text"><span className="dot" aria-hidden />On track</span>;
  const sev = projectSeverity(p);
  const n = p.risk_reasons.length;
  return (
    <Tooltip align="end" content={<><strong>Why it&apos;s at risk</strong><ul>{p.risk_reasons.map((r) => <li key={r}>{RISK_SHORT[r] ?? r}</li>)}</ul></>}>
      {(t) => (
        <button type="button" className="risk-btn" {...t} onClick={(e) => e.stopPropagation()} aria-label={`At risk: ${p.risk_reasons.map((r) => RISK_SHORT[r] ?? r).join(', ')}`}>
          <Badge l={{ text: 'At risk', tone: sev === 'high' ? 'bad' : 'warn' }} />
          <span className="r-reasons">{n} reason{n > 1 ? 's' : ''}</span>
        </button>
      )}
    </Tooltip>
  );
}

export function ProjectTable({ rows, filter, onFilter, title }: { rows: ProjectRow[]; filter: TableFilter; onFilter: (f: TableFilter) => void; title?: string }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter) ?? FILTERS[0]!;
    const s = text.trim().toLowerCase();
    return rows.filter((p) => f.test(p) && (!s || `${p.project_number} ${p.customer_name} ${p.site_address} ${p.quote_number}`.toLowerCase().includes(s)));
  }, [rows, filter, text]);

  return (
    <section className="card" aria-label={title ?? 'Projects'}>
      <div className="toolbar">
        <div className="segmented" role="tablist" aria-label="Filter projects">
          {FILTERS.map((f) => (
            <button key={f.key} role="tab" aria-selected={filter === f.key} className={`seg ${filter === f.key ? 'on' : ''}`} onClick={() => onFilter(f.key)}>
              {f.text} <span className="count">{rows.filter(f.test).length}</span>
            </button>
          ))}
        </div>
        <label className="search">
          <Search size={15} aria-hidden />
          <span className="sr-only">Search projects</span>
          <input type="search" placeholder="Search project, customer, address" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      </div>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Project</th><th scope="col">Customer</th><th scope="col">Stage</th><th scope="col">Scheduled</th>
              <th scope="col">Materials</th><th scope="col">Invoice</th><th scope="col">Risk</th><th scope="col"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <AnimatePresence mode="wait" initial={false}>
            <motion.tbody key={filter} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}>
              {shown.map((p) => (
                <tr key={p.project_number} className="clickable" onClick={() => router.push(`/projects/${p.project_number}`)}>
                  <td>
                    <Link className="pn" href={`/projects/${p.project_number}`} onClick={(e) => e.stopPropagation()}>{p.project_number}</Link>
                    {p.open_exceptions > 0 && <div className="cell-sub" style={{ color: 'var(--bad)' }}>{p.open_exceptions} issue to review</div>}
                  </td>
                  <td><div className="cell-main" title={p.customer_name}>{p.customer_name}</div><div className="cell-sub" title={p.site_address}>{street(p.site_address)}</div></td>
                  <td><Badge l={label(PROJECT_STAGE, p.status)} /></td>
                  <td className="num">{p.is_active ? date(p.planned_start_date) : <span className="muted">Done {date(p.actual_completion_date)}</span>}</td>
                  <td><Badge l={label(MATERIAL_STATUS, p.material_status)} />
                    {p.waiting_on_materials && p.material_eta && <div className="cell-sub">ETA {date(p.material_eta)}</div>}</td>
                  <td><Badge l={label(INVOICE_STATUS, p.invoice_status)} title={p.invoice_blocker ?? undefined} />
                    {p.xero_invoice_number && <div className="cell-sub">{p.xero_invoice_number}</div>}</td>
                  <td><RiskCell p={p} /></td>
                  <td className="right"><ChevronRight size={16} className="chev" aria-hidden /></td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={8}><Empty icon={FolderSearch} title="No projects match" text="Try another filter or clear the search." /></td></tr>}
            </motion.tbody>
          </AnimatePresence>
        </table>
      </div>
    </section>
  );
}
