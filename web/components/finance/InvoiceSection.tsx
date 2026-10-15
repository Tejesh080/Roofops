import Link from 'next/link';
import { CloudUpload, FileCheck2 } from 'lucide-react';
import type { DraftProgress, InvoiceOverview, PendingInvoice } from '@/lib/invoices';
import { DRAFT_STATE } from '@/lib/invoices';
import { date, money } from '@/lib/labels';
import { Badge } from '@/components/ui/Badge';
import { CardHead, Empty } from '@/components/ui/Empty';
import { DecideInvoiceForm, SendToXeroForm } from './InvoiceForms';

const VIA: Record<PendingInvoice['requested_via'], string> = { dashboard: 'in the dashboard', copilot: 'with the Copilot', airtable: 'in Airtable (shared account)' };

/** Everything an approver checks, from the immutable preview (the figures that will be invoiced). */
function Preview({ p }: { p: PendingInvoice }) {
  const v = p.preview;
  return (
    <div className="reissue-step">
      <div className="tech-grid">
        <span className="t-meta">Customer</span><span>{v.customer_name} · Xero contact {v.xero_contact_name}</span><span />
        <span className="t-meta">Amount</span><span className="strong num">{money(v.amount_inc_gst)} inc GST · GST {money(v.gst_amount)} · {money(v.amount_ex_gst)} ex GST</span><span />
        <span className="t-meta">Dates</span><span>Invoice {date(v.invoice_date)} · due {date(v.due_date)} · reference {v.reference}</span><span />
        <span className="t-meta">Basis</span><span>Quote {v.quote_number} v{v.quote_version}; already invoiced {money(v.billed_to_date_inc_gst)}</span><span />
        <span className="t-meta">Invoice number</span><span>Given when it is approved (RO-INV-…)</span><span />
        <span className="t-meta">Requested</span><span>{p.requested_by ?? 'nobody signed in'} {VIA[p.requested_via]} · {date(p.requested_at)} · {p.approval_number}</span><span />
      </div>
      <table className="fin-table" aria-label={`Lines of ${p.approval_number}`}>
        <tbody>
          {v.lines.map((l) => (
            <tr key={l.line_no}><td>{l.description}</td><td className="amt">{l.quantity} × {money(l.unit_amount)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Decision({ p, me, roles }: { p: PendingInvoice; me: NonNullable<InvoiceOverview['me']>; roles: string }) {
  if (!me.may_approve) return <p className="t-meta reissue-wait">Waiting for an approver ({roles}).</p>;
  if (p.i_requested_it) return <p className="t-meta reissue-wait">You prepared this. A second person ({roles}) must approve it; you can still reject (withdraw) it.</p>;
  return <DecideInvoiceForm approval={p.approval_number} hash={p.payload_hash} />;
}

function Draft({ d, me }: { d: DraftProgress; me: NonNullable<InvoiceOverview['me']> }) {
  const s = DRAFT_STATE[d.state];
  const canSend = me.may_dispatch && (d.state === 'READY_TO_SEND' || d.state === 'FAILED') && !d.problem;
  return (
    <div className="issue">
      <div className="issue-title">
        {d.xero_invoice_number} <Link href={`/projects/${d.project_number}`} className="t-meta" style={{ fontWeight: 550 }}>· {d.project_number}</Link>
        <span className="t-meta"> · {d.customer} · {money(Number(d.amount_inc_gst))}{d.generation > 1 ? ` · replacement (generation ${d.generation})` : ''}</span>
      </div>
      <Badge l={{ text: s.badge, tone: s.tone }} />
      <div className="issue-expl">
        {s.text}
        {d.state === 'RETRY_LATER' && d.next_attempt_at ? ` Next try from ${new Date(d.next_attempt_at).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', dateStyle: 'medium', timeStyle: 'short' })}.` : ''}
        {d.state === 'CREATED' && d.xero_invoice_id ? ` InvoiceID ${d.xero_invoice_id}.` : ''}
      </div>
      {(d.last_error && d.state !== 'CREATED') || d.request ? (
        <p className="t-meta reissue-wait">
          {d.last_error && d.state !== 'CREATED' ? <>Last answer: {d.last_error}. </> : null}
          {d.request ? <>Last request: {d.request.requested_by ?? 'someone'}, {date(d.request.requested_at)} ({d.request.status.toLowerCase().replace('_', ' ')}{d.request.closed_reason ? `: ${d.request.closed_reason}` : ''}).</> : null}
        </p>
      ) : null}
      {canSend ? <SendToXeroForm invoice={d.invoice_number} generation={d.generation} sha={d.payload_sha256} again={d.state === 'FAILED'} />
        : (d.state === 'READY_TO_SEND' || d.state === 'FAILED') && !me.may_dispatch ? <p className="t-meta reissue-wait">A Finance or Admin person sends it to Xero.</p> : null}
    </div>
  );
}

/** Final invoices awaiting a decision, and Xero drafts not yet settled. Staff only: the demo viewer is told to sign in. */
export function InvoiceSection({ overview }: { overview: InvoiceOverview | null }) {
  const me = overview?.me;
  return (
    <div className="grid g-2" style={{ marginTop: 16 }}>
      <section className="card" id="approvals">
        <CardHead icon={FileCheck2} title="Invoice approvals"><span className="chip">Two people: one prepares, another approves</span></CardHead>
        <div className="card-body">
          {!overview ? <p className="t-meta">Sign in as yourself to prepare, approve or reject invoices (the shared demo login cannot).</p>
            : !overview.ok || !me ? <p className="t-meta">{overview.reason ?? 'Sign in again as yourself.'}</p>
            : !overview.pending?.length ? <Empty icon={FileCheck2} title="Nothing to approve" text="Prepared invoices wait here for a second person." />
            : overview.pending.map((p) => (
              <div className="issue" key={p.approval_number}>
                <div className="issue-title">{p.approval_number} <Link href={`/projects/${p.project_number}`} className="t-meta" style={{ fontWeight: 550 }}>· {p.project_number}</Link>
                  <span className="t-meta"> · {p.preview.customer_name} · {money(p.preview.amount_inc_gst)}</span></div>
                <Badge l={{ text: 'Awaiting approval', tone: 'warn' }} />
                <Preview p={p} />
                <Decision p={p} me={me} roles="finance, admin, operations manager" />
              </div>
            ))}
        </div>
      </section>
      <section className="card" id="xero-drafts">
        <CardHead icon={CloudUpload} title="Xero drafts"><span className="chip">Sent by RoofOps automation</span></CardHead>
        <div className="card-body">
          {!overview ? <p className="t-meta">Sign in as yourself to send invoices to Xero.</p>
            : !overview.ok || !me ? <p className="t-meta">{overview.reason ?? 'Sign in again as yourself.'}</p>
            : !overview.drafts?.length ? <Empty icon={CloudUpload} title="Nothing waiting for Xero" text="Approved invoices appear here until their draft exists in Xero." />
            : overview.drafts.map((d) => <Draft key={`${d.invoice_number}:${d.generation}`} d={d} me={me} />)}
        </div>
      </section>
    </div>
  );
}
