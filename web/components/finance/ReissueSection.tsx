import Link from 'next/link';
import { RefreshCcw } from 'lucide-react';
import type { ReissueItem, ReissueOverview } from '@/lib/reissue';
import { REISSUE_CODE } from '@/lib/reissue';
import { date, money } from '@/lib/labels';
import { Badge } from '@/components/ui/Badge';
import { CardHead, Empty } from '@/components/ui/Empty';
import { ApproveReissueForm, RequestReissueForm } from './ReissueForms';

/** Where a reissue stands, in plain words, and what the signed-in person can do next. */
/** A reissue is done only when the ledger says so: the current generation CREATED with its Xero InvoiceID. */
const created = (it: ReissueItem) => it.latest_decided?.generation_status === 'CREATED' && Boolean(it.latest_decided.xero_invoice_id);

function Step({ it, me, roles }: { it: ReissueItem; me: NonNullable<ReissueOverview['me']>; roles: string }) {
  const p = it.pending;
  if (p) {
    return (
      <div className="reissue-step">
        <div className="tech-grid">
          <span className="t-meta">Replacement draft</span><span className="strong num">{p.xero_invoice_number} · {money(Number(p.amount_inc_gst))} inc GST (GST {money(Number(p.gst_amount))})</span><span />
          <span className="t-meta">Customer</span><span>{p.contact}</span><span />
          <span className="t-meta">Xero organisation</span><span>{p.tenant?.trim() || 'the pinned Xero Demo Company'}</span><span />
          <span className="t-meta">Requested</span><span>{p.requested_by_name} · {date(p.requested_at)} · {p.approval_number}</span><span />
          <span className="t-meta">Reason</span><span>{p.reason}</span><span />
        </div>
        {p.i_requested_it ? <p className="t-meta reissue-wait">You requested this. A second person ({roles}) must approve it.</p>
          : me.may_reissue ? <ApproveReissueForm approval={p.approval_number} />
          : <p className="t-meta reissue-wait">Waiting for someone else ({roles}) to approve it.</p>}
      </div>
    );
  }
  const d = it.latest_decided;
  if (d && it.status !== 'VOIDED') {
    const text = created(it) ? `Replacement draft created in Xero (InvoiceID ${d.xero_invoice_id}). Airtable shows it after the next sync.`
      : d.write_status === 'PENDING' ? 'Approved and queued. The replacement draft is created in Xero at the supervised dispatch (an operator step).'
      : d.write_status ? `The replacement draft is ${d.write_status.toLowerCase()}; see Automation if it needs a person.` : 'Decided.';
    return <p className="t-meta reissue-wait">{d.approval_number}: requested by {d.requested_by}, approved by {d.decided_by}. {text}</p>;
  }
  if (it.status === 'VOIDED') {
    if (!it.check?.ok) return <p className="t-meta reissue-wait">Cannot be reissued: {it.check?.detail ?? 'not eligible'}.</p>;
    return me.may_reissue ? <RequestReissueForm invoice={it.invoice_number} />
      : <p className="t-meta reissue-wait">Eligible for a reissue. Someone in {roles} can request it.</p>;
  }
  return null;
}

export function ReissueSection({ overview }: { overview: ReissueOverview | null }) {
  return (
    <section className="card" id="reissues">
      <CardHead icon={RefreshCcw} title="Invoice reissues"><span className="chip">Two people: one requests, another approves</span></CardHead>
      <div className="card-body">
        {!overview ? <p className="t-meta">Sign in as yourself to see and act on invoice reissues (the shared demo login cannot).</p>
          : !overview.ok ? <p className="t-meta">{overview.reason ?? REISSUE_CODE.SIGNED_OUT}</p>
          : !overview.items?.length ? <Empty icon={RefreshCcw} title="No voided final invoices" text="A final invoice deleted or voided in Xero appears here for a replacement draft." />
          : (
            <div>
              {overview.items.map((it) => (
                <div className="issue" key={it.invoice_number}>
                  <div className="issue-title">
                    {it.invoice_number} <Link href={`/projects/${it.project_number}`} className="t-meta" style={{ fontWeight: 550 }}>· {it.project_number}</Link>
                    <span className="t-meta"> · {it.customer} · {money(it.total_inc_gst)}</span>
                  </div>
                  <Badge l={it.pending ? { text: 'Awaiting approval', tone: 'warn' } : it.status === 'VOIDED' ? { text: 'Voided', tone: 'bad' }
                    : created(it) ? { text: 'Reissued', tone: 'good' } : { text: 'Approved, queued', tone: 'info' }} />
                  <div className="issue-expl">{it.voided_reason ?? ''}</div>
                  <Step it={it} me={overview.me!} roles={(overview.roles ?? 'Finance, Admin').toLowerCase()} />
                </div>
              ))}
            </div>
          )}
      </div>
    </section>
  );
}
