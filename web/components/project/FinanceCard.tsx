import { ChevronRight, ExternalLink, History, Receipt } from 'lucide-react';
import type { InvoiceLine, ProjectRow } from '@/lib/queries';
import { INVOICE_LINE_STATUS, INVOICE_NEXT_STEP, INVOICE_STATUS, airtableProjectUrl, date, label, money, moneyInText } from '@/lib/labels';
import { Badge } from '@/components/ui/Badge';
import { CardHead } from '@/components/ui/Empty';
import { CopyButton } from '@/components/ui/CopyButton';

/** What each earlier invoice was, from facts: issued before work started = deposit; the FINAL one = final. */
function kindOf(i: InvoiceLine, p: ProjectRow): string {
  if (i.invoice_number === p.final_invoice_number) return 'Final';
  const start = p.actual_start_date ?? p.planned_start_date;
  return start && i.issue_date && i.issue_date <= start ? 'Deposit' : 'Progress';
}

export function FinanceCard({ p, invoices }: { p: ProjectRow; invoices: InvoiceLine[] }) {
  const status = label(INVOICE_STATUS, p.invoice_status);
  const at = airtableProjectUrl(p.airtable_record_id);
  const xeroUrl = p.xero_invoice_id ? `https://go.xero.com/AccountsReceivable/Edit.aspx?InvoiceID=${p.xero_invoice_id}` : null;
  const headline = p.final_invoice_number ? 'Final invoice'
    : p.invoice_status === 'AWAITING_APPROVAL' ? 'Prepared, awaiting approval'
    : p.invoice_status === 'READY_TO_INVOICE' ? 'Ready to invoice' : null;
  return (
    <section className="card">
      <CardHead icon={Receipt} title="Finance">{p.xero_invoice_id && <span className="chip">Xero Demo</span>}</CardHead>
      <div className="card-body">
        {headline && p.invoice_amount_inc_gst !== null ? (
          <>
            <div className="t-label">{headline}</div>
            <div className="fin-amount" style={{ marginTop: 4 }}>{money(p.invoice_amount_inc_gst)} <span className="t-meta" style={{ fontSize: 13, fontWeight: 500 }}>inc GST</span></div>
            <div className="fin-ref">
              {p.xero_invoice_number && <span className="strong num">{p.xero_invoice_number}</span>}
              <Badge l={p.xero_invoice_id ? { text: 'Draft in Xero', tone: 'good' } : status} />
            </div>
          </>
        ) : (
          <>
            <div className="t-label">Invoice status</div>
            <div style={{ marginTop: 6 }}><Badge l={status} /></div>
            {p.invoice_blocker && <p className="attn-note" style={{ marginTop: 10 }}>{moneyInText(p.invoice_blocker)}</p>}
            {p.invoice_blocker && /was voided/.test(p.invoice_blocker) && (
              <p className="t-meta" style={{ marginTop: 8 }}>Next: <a href="/finance#reissues">request a reissue on the Finance page</a> (one person requests, a second approves).</p>
            )}
          </>
        )}
        {(p.invoice_status === 'READY_TO_INVOICE' || p.invoice_status === 'AWAITING_APPROVAL') && (
          <p className="t-meta" style={{ margin: '10px 0 0' }}>
            {p.invoice_status === 'READY_TO_INVOICE' ? INVOICE_NEXT_STEP.prepare : INVOICE_NEXT_STEP.approve}
          </p>
        )}
        {p.outstanding_inc_gst > 0 && (
          <p className="t-meta" style={{ margin: '10px 0 0' }}>Owed by the customer: <strong className="num" style={{ color: p.has_overdue_invoice ? 'var(--bad)' : 'var(--text)' }}>{money(p.outstanding_inc_gst)}</strong>{p.has_overdue_invoice ? ' (overdue)' : ''}</p>
        )}

        <div className="t-label" style={{ marginTop: 18 }}>Invoice history</div>
        {invoices.length === 0 ? <p className="t-meta" style={{ margin: '6px 0 0' }}>No invoices yet.</p> : (
          <table className="fin-table">
            <tbody>
              {invoices.map((i) => (
                <tr key={i.invoice_number}>
                  <td><span className="strong">{kindOf(i, p)}</span> <span className="t-meta num">· {i.invoice_number} · {date(i.issue_date)}</span></td>
                  <td className="amt">{money(i.total_inc_gst)}</td>
                  <td className="st"><Badge l={i.is_overdue ? { text: 'Overdue', tone: 'bad' } : i.invoice_number === p.final_invoice_number && p.xero_invoice_id ? { text: 'Draft', tone: 'info' } : label(INVOICE_LINE_STATUS, i.status)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="actions">
          {xeroUrl && <a className="btn btn-sm" href={xeroUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden /> Open in Xero</a>}
          {p.invoice_status === 'AWAITING_APPROVAL' && at && <a className="btn btn-sm btn-primary" href={at} target="_blank" rel="noreferrer">Open approval in Airtable</a>}
          {p.invoice_status === 'READY_TO_INVOICE' && at && <a className="btn btn-sm btn-primary" href={at} target="_blank" rel="noreferrer">Open in Airtable</a>}
          <a className="btn btn-sm btn-ghost" href="#history"><History size={14} aria-hidden /> View audit</a>
        </div>

        {(p.xero_invoice_id || p.pending_approval_number || p.final_invoice_number) && (
          <details className="tech">
            <summary><ChevronRight size={12} aria-hidden /> Technical details</summary>
            <div className="tech-grid">
              {p.final_invoice_number && <><span className="t-meta">RoofOps invoice</span><span className="mono">{p.final_invoice_number}</span><span /></>}
              {p.pending_approval_number && <><span className="t-meta">Approval ref</span><span className="mono">{p.pending_approval_number}</span><CopyButton value={p.pending_approval_number} what="Approval reference" /></>}
              {p.xero_invoice_id && <><span className="t-meta">Xero InvoiceID</span><span className="mono">{p.xero_invoice_id}</span><CopyButton value={p.xero_invoice_id} what="Xero InvoiceID" /></>}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}
