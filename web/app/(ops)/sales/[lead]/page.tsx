import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ClipboardList, FileText, MapPin, Search, Signpost } from 'lucide-react';
import { query } from '@/lib/db';
import { requireSession, staffIdentity } from '@/lib/auth';
import { JOB_KIND, LEAD_STATUS, LINE_KIND, MEASURE, QUOTE_STATUS, ROOF_TYPE, SOURCE, getCustomerDirectory, getLead, getProducts, getQuotesForLead, getSalesRoles, leadNextStep } from '@/lib/sales';
import { getStaff } from '@/lib/ops';
import { Badge } from '@/components/ui/Badge';
import { CardHead } from '@/components/ui/Empty';
import { BookInspectionForm, ConvertForm, LeadActions, QuoteBuilder, RecordInspectionForm, SendQuoteForm } from '@/components/sales/SalesForms';

export const dynamic = 'force-dynamic';
export async function generateMetadata({ params }: { params: Promise<{ lead: string }> }) {
  return { title: `${decodeURIComponent((await params).lead).toUpperCase()} · RoofOps` };
}
const money = (n: number) => n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });

/** One enquiry, step by step: the enquiry, the customer and site, the inspection, the quote, and what happens next. */
export default async function LeadPage({ params }: { params: Promise<{ lead: string }> }) {
  const session = await requireSession();
  const me = await staffIdentity(session.t);
  const l = await getLead(query, decodeURIComponent((await params).lead).toUpperCase());
  if (!l) notFound();
  const [quotes, roles, products, staff, customers, todayRows] = await Promise.all([
    getQuotesForLead(query, l.lead_number), getSalesRoles(query), getProducts(query), getStaff(query), getCustomerDirectory(query),
    query<{ d: string }>('select app_today()::text d')]);
  const today = todayRows[0]?.d ?? '';
  const may = !!me && roles.includes(me.role);
  const closed = l.status === 'LOST' || l.status === 'DISQUALIFIED' || !!l.project_number;
  const next = leadNextStep(l, quotes);
  const booked = l.inspections.find((i) => i.status === 'SCHEDULED');
  const openQuote = quotes.find((q) => q.status === 'DRAFT' || q.status === 'SENT') ?? null;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <Link href="/sales" className="t-meta">← Sales</Link>
      <header className="page-head"><div>
        <h1 className="t-page">{l.contact_name} <Badge l={LEAD_STATUS[l.status]} /></h1>
        <div className="sub">{l.lead_number} · {SOURCE[l.source] ?? l.source} · received {l.received_at}{l.created_by_name ? ` by ${l.created_by_name}` : ''}</div>
      </div></header>

      <section className="card" aria-label="Next step">
        <CardHead icon={Signpost} title="Next step" />
        <div className="card-body"><p><strong>{next.title}</strong></p>{next.detail && <p className="t-meta">{next.detail}</p>}
          {l.project_number && <p><Link className="btn btn-sm" href={`/projects/${l.project_number}`}>Open project {l.project_number}</Link></p>}</div>
      </section>

      <div className="grid g-2">
        <section className="card" aria-label="1. Enquiry">
          <CardHead icon={ClipboardList} title="1. Enquiry" />
          <div className="card-body">
            <dl className="kv">
              <dt>Phone</dt><dd>{l.phone ?? '—'}</dd><dt>Email</dt><dd>{l.email ?? '—'}</dd>
              <dt>Address given</dt><dd>{l.property_address_text ?? '—'}</dd><dt>Needs</dt><dd>{l.notes ?? '—'}</dd>
              {l.lost_reason && <><dt>Closed because</dt><dd>{l.lost_reason}</dd></>}
            </dl>
            {may && !closed && <LeadActions lead={l.lead_number} status={l.status} version={l.record_version} />}
          </div>
        </section>

        <section className="card" aria-label="2. Customer and site">
          <CardHead icon={MapPin} title="2. Customer and site" />
          <div className="card-body">
            {l.customer_number ? (
              <dl className="kv"><dt>Customer</dt><dd>{l.customer_name} ({l.customer_number})</dd><dt>Site</dt><dd>{l.site} ({l.property_number})</dd></dl>
            ) : may && !closed ? (
              <ConvertForm lead={l.lead_number} version={l.record_version} contact={l.contact_name} phone={l.phone} email={l.email} customers={customers} />
            ) : <p className="t-meta">Not recorded yet.</p>}
          </div>
        </section>
      </div>

      <div className="grid g-2">
        <section className="card" aria-label="3. Inspection">
          <CardHead icon={Search} title="3. Inspection" />
          <div className="card-body">
            {l.inspections.map((i) => (
              <div className="issue" key={i.inspection_number} data-inspection={i.inspection_number}>
                <div className="issue-title">{i.inspection_number}<span className="t-meta"> · {i.inspector ?? 'nobody'}</span></div>
                <Badge l={i.status === 'COMPLETED' ? { text: 'Done', tone: 'good' } : i.status === 'CANCELLED' ? { text: 'Cancelled', tone: 'neutral' } : { text: 'Booked', tone: 'info' }} />
                <div className="issue-expl">
                  {i.status === 'SCHEDULED' && <>Booked for {i.scheduled_for?.replace('T', ' ')}</>}
                  {i.status === 'COMPLETED' && <>{ROOF_TYPE[i.roof_type ?? ''] ?? i.roof_type}{i.roof_area_sqm ? ` · ${i.roof_area_sqm} m² (${MEASURE[i.measurement_method ?? ''] ?? i.measurement_method})` : ' · not measured'}
                    {i.pitch_degrees ? ` · ${i.pitch_degrees}°` : ''} · inspected {i.inspected_on}</>}
                  {i.findings && <><br />{i.findings}</>}
                </div>
                {may && i.status === 'SCHEDULED' && <RecordInspectionForm inspection={i.inspection_number} version={i.record_version} />}
              </div>
            ))}
            {!l.inspections.length && <p className="t-meta">No inspection yet.</p>}
            {may && !closed && l.customer_number && !booked && !openQuote && <BookInspectionForm lead={l.lead_number} staff={staff} today={today} />}
            {!l.customer_number && <p className="t-meta">Record the customer and site first.</p>}
          </div>
        </section>

        <section className="card" aria-label="4. Quote">
          <CardHead icon={FileText} title="4. Quote" />
          <div className="card-body">
            {quotes.map((q) => (
              <div className="issue" key={q.quote_number} data-quote={q.quote_number}>
                <div className="issue-title">{q.quote_number} · version {q.version_number}<span className="t-meta"> · {JOB_KIND[q.job_type] ?? q.job_type} · {q.estimator ?? ''}</span></div>
                <Badge l={QUOTE_STATUS[q.status]} />
                <div className="issue-expl">
                  <table className="fin-table quote-lines-table" aria-label={`Lines of ${q.quote_number}`}><tbody>
                    {q.lines.map((ln) => <tr key={ln.line_no}><td>{LINE_KIND[ln.line_kind] ?? ln.line_kind}: {ln.description}{ln.product_code ? ` (${ln.product_code})` : ''}</td>
                      <td className="amt">{Number(ln.quantity)} {ln.unit} × {money(Number(ln.unit_price))}</td><td className="amt">{money(Number(ln.line_amount))}</td></tr>)}
                  </tbody></table>
                  <p className="num">Ex GST {money(q.subtotal_ex_gst)} · GST {money(q.gst_amount)} · <strong>Total {money(q.total_inc_gst)}</strong> ({q.line_amount_type === 'INCLUSIVE' ? 'prices include GST' : 'GST added'})</p>
                  {q.scope_summary && <p className="t-meta">{q.scope_summary}</p>}
                  {q.sent_on && <p className="t-meta">Sent {q.sent_on}, valid until {q.valid_until} · Airtable: {q.in_airtable ? 'added' : q.airtable_handoff === 'FAILED' ? `hand-off failed (${q.airtable_handoff_error ?? 'see Automation'})` : 'being added'}</p>}
                </div>
                {may && q.status === 'DRAFT' && <SendQuoteForm quote={q.quote_number} version={q.record_version} total={q.total_inc_gst} />}
              </div>
            ))}
            {may && !closed && l.customer_number && (!quotes.length || openQuote) && (
              <details className="ops-details" open={!quotes.length}>
                <summary className="btn btn-sm">{openQuote ? `Revise ${openQuote.quote_number}` : 'Prepare the quote'}</summary>
                <QuoteBuilder lead={l.lead_number} quote={openQuote} products={products} />
              </details>
            )}
            {!l.customer_number && <p className="t-meta">Record the customer and site first.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
