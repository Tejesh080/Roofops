import Link from 'next/link';
import { query } from '@/lib/db';
import { PROJECT_FILTERS, getExceptions, getKpis, listProjects, type ProjectFilter } from '@/lib/queries';
import { EXCEPTION_KIND, EXCEPTION_STATUS, date, label, plainIssue } from '@/lib/labels';
import { ProjectTable } from '@/components/ProjectTable';
import { Pill } from '@/components/Pill';

export const dynamic = 'force-dynamic';

const DEMO = [
  { p: 'PRJ-2026-0004', t: 'Invoiced to Xero', d: 'Completed job. The final invoice was approved and created as a draft in the Xero Demo Company, then checked.' },
  { p: 'PRJ-2026-0001', t: 'Ready to invoice', d: 'Ask the copilot: "Prepare invoice for PRJ-2026-0001". It prepares a preview and waits for approval; nothing goes to Xero.' },
  { p: 'PRJ-2026-0005', t: 'Awaiting approval', d: 'Prepared by the copilot. Waits for a finance approver in Airtable before Xero is touched.' },
  { p: 'PRJ-2026-0031', t: 'Created from Airtable', d: 'Quote Q-2026-0041 accepted in Airtable → project, Google Drive folder and Airtable record created automatically.' },
  { p: 'PRJ-2026-0032', t: 'Recovered automatically', d: 'Google Drive was briefly unavailable; RoofOps retried and finished on its own.' },
  { p: 'PRJ-2026-0033', t: 'Failed safely, then fixed', d: 'Drive stayed down, so RoofOps stopped safely and raised an issue; staff retried and it completed.' },
  { p: 'PRJ-2026-0011', t: 'At risk', d: "Start date passed and the supplier hasn't confirmed the order." },
];

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  const initial = (PROJECT_FILTERS.includes(view as ProjectFilter) ? view : 'active') as ProjectFilter;
  const [k, rows, exceptions] = await Promise.all([getKpis(query), listProjects(query, 'all'), getExceptions(query, { openOnly: true })]);

  const cards = [
    { key: 'active', n: k.active_projects, lbl: 'Active projects', hint: 'Planning to on site', tone: 'info' },
    { key: 'at_risk', n: k.projects_at_risk, lbl: 'Projects at risk', hint: 'Late start, supplier or PM flag', tone: 'bad' },
    { key: 'awaiting_materials', n: k.awaiting_materials, lbl: 'Awaiting materials', hint: 'Orders not yet delivered', tone: 'warn' },
    { key: 'ready_to_invoice', n: k.ready_to_invoice, lbl: 'Ready to invoice', hint: k.awaiting_invoice_approval ? `+${k.awaiting_invoice_approval} awaiting approval` : 'Completed, paperwork in', tone: 'good' },
    { key: 'exceptions', n: k.open_exceptions, lbl: 'Open issues', hint: 'Automation stopped safely', tone: k.open_exceptions ? 'bad' : 'good' },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Operations dashboard</h1>
          <div className="muted">As of {date(k.as_of)} · live from the RoofOps database</div>
        </div>
      </div>

      <section className="kpis" aria-label="Headline numbers">
        {cards.map((c) => (
          <Link key={c.key} href={c.key === 'exceptions' ? '/#issues' : `/?view=${c.key}#projects`} className={`kpi tone-${c.tone} ${initial === c.key ? 'active' : ''}`}>
            <div className="num">{c.n}</div>
            <div className="lbl">{c.lbl}</div>
            <div className="hint">{c.hint}</div>
          </Link>
        ))}
      </section>

      <section id="projects" style={{ marginBottom: 20 }}>
        <ProjectTable key={initial} rows={rows} initial={initial} />
      </section>

      <div className="grid-2">
        <section id="issues" className="card">
          <h2>Needs attention: automation issues</h2>
          {exceptions.length === 0 ? <p className="muted">Nothing needs attention.</p> : (
            <ul className="list">
              {exceptions.map((e) => (
                <li key={e.exception_number}>
                  <div>
                    <div><strong>{EXCEPTION_KIND[e.error_class] ?? e.error_class}</strong>{' · '}
                      {e.project_number ? <Link href={`/projects/${e.project_number}`}>{e.project_number}</Link> : <span>{e.business_reference}</span>}</div>
                    <div className="small muted">{plainIssue(e.error_message)}</div>
                    <div className="small muted">Since {e.first_failed_at} · ref {e.exception_number}</div>
                  </div>
                  <div><Pill l={label(EXCEPTION_STATUS, e.resolution_status)} /></div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section id="demo" className="card">
          <h2>Demo guide</h2>
          <p className="small muted" style={{ marginTop: -6 }}>Real examples from the live system. Click one to open it.</p>
          <div className="demo-steps">
            {DEMO.map((d) => (
              <Link key={d.p} href={`/projects/${d.p}`} className="demo-step" style={{ color: 'inherit' }}>
                <div className="t">{d.p} · {d.t}</div>
                <div className="small">{d.d}</div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
