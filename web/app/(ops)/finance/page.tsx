import Link from 'next/link';
import { BadgeDollarSign, CheckCircle2, ChevronRight, Clock3, FileWarning, Receipt } from 'lucide-react';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import { listOverdueInvoices, listProjects, type ProjectRow } from '@/lib/queries';
import { INVOICE_NEXT_STEP, date, money } from '@/lib/labels';
import { CardHead, Empty } from '@/components/ui/Empty';
import { AskButton } from '@/components/copilot/AskButton';
import { ReissueSection } from '@/components/finance/ReissueSection';
import { getReissueOverview } from '@/lib/reissue';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Finance · RoofOps' };

function Rows({ rows, right }: { rows: ProjectRow[]; right: (p: ProjectRow) => React.ReactNode }) {
  return (
    <ul className="rows">
      {rows.map((p) => (
        <li key={p.project_number}>
          <div style={{ minWidth: 0 }}>
            <Link className="pn" href={`/projects/${p.project_number}`}>{p.project_number}</Link>
            <div className="row-sub">{p.customer_name}</div>
          </div>
          <div className="row-right">{right(p)}</div>
        </li>
      ))}
    </ul>
  );
}

export default async function FinancePage() {
  const session = await requireSession();
  const [rows, overdue, reissues] = await Promise.all([listProjects(query, 'all'), listOverdueInvoices(query), getReissueOverview(query, session.t)]);
  const ready = rows.filter((p) => p.invoice_status === 'READY_TO_INVOICE');
  const awaiting = rows.filter((p) => p.invoice_status === 'AWAITING_APPROVAL');
  const inXero = rows.filter((p) => p.xero_invoice_id);
  const sum = (xs: ProjectRow[]) => xs.reduce((s, p) => s + (p.invoice_amount_inc_gst ?? 0), 0);
  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="t-page">Finance</h1>
          <div className="sub">Final invoices move: ready → prepared (AI or staff) → approved by finance → draft in Xero</div>
        </div>
      </header>
      <div className="grid g-2">
        <section className="card">
          <CardHead icon={BadgeDollarSign} title="Ready to invoice"><span className="chip num">{money(sum(ready))}</span></CardHead>
          <div className="card-body">
            {ready.length === 0 ? <Empty icon={CheckCircle2} title="Nothing waiting to be invoiced" /> :
              <Rows rows={ready} right={(p) => <>
                <span className="strong num">{money(p.invoice_amount_inc_gst)}</span>
                <AskButton question={`Prepare invoice for ${p.project_number}`} text="Prepare with Copilot" />
              </>} />}
          </div>
        </section>
        <section className="card">
          <CardHead icon={Clock3} title="Awaiting finance approval"><span className="chip num">{money(sum(awaiting))}</span></CardHead>
          <div className="card-body">
            {awaiting.length === 0 ? <Empty icon={CheckCircle2} title="No invoices awaiting approval" text="Prepared invoices wait here until a finance approver approves them in Airtable." /> :
              <Rows rows={awaiting} right={(p) => <><span className="strong num">{money(p.invoice_amount_inc_gst)}</span><span className="row-sub">{p.pending_approval_number} · {INVOICE_NEXT_STEP.approveShort}</span></>} />}
          </div>
        </section>
        <section className="card">
          <CardHead icon={Receipt} title="Draft invoices in Xero"><span className="chip">Xero Demo Company</span></CardHead>
          <div className="card-body">
            {inXero.length === 0 ? <Empty icon={Receipt} title="No drafts in Xero yet" /> :
              <Rows rows={inXero} right={(p) => <><span className="strong num">{money(p.invoice_amount_inc_gst)}</span><span className="row-sub num">{p.xero_invoice_number} · draft</span></>} />}
          </div>
        </section>
        <section className="card">
          <CardHead icon={FileWarning} title="Overdue payments"><span className="chip num">{money(overdue.reduce((s, i) => s + i.outstanding, 0))}</span></CardHead>
          <div className="card-body">
            {overdue.length === 0 ? <Empty icon={CheckCircle2} title="No overdue payments" /> : (
              <ul className="rows">
                {overdue.map((i) => (
                  <li key={i.invoice_number}>
                    <div><Link className="pn" href={`/projects/${i.project_number}`}>{i.project_number}</Link><div className="row-sub num">{i.invoice_number} · due {date(i.due_date)}</div></div>
                    <div className="row-right"><span className="strong num" style={{ color: 'var(--bad)' }}>{money(i.outstanding)}</span><span className="row-sub">outstanding</span></div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
      <div style={{ marginTop: 16 }}><ReissueSection overview={reissues} /></div>
      <p className="t-meta" style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
        <ChevronRight size={13} aria-hidden /> The Copilot can only prepare an invoice. Approval, and the draft in Xero, always need a person.
      </p>
    </>
  );
}
