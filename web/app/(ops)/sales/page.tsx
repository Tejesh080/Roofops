import Link from 'next/link';
import { Inbox, PhoneCall } from 'lucide-react';
import { query } from '@/lib/db';
import { requireSession, staffIdentity } from '@/lib/auth';
import { LEAD_STATUS, SOURCE, getSalesRoles, listLeads, salesMissing, type Lead } from '@/lib/sales';
import { Badge } from '@/components/ui/Badge';
import { CardHead } from '@/components/ui/Empty';
import { NewLeadForm } from '@/components/sales/SalesForms';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sales · RoofOps' };

const STAGES: { key: string; title: string; match: (l: Lead) => boolean }[] = [
  { key: 'new', title: 'New enquiries', match: (l) => l.status === 'NEW' },
  { key: 'working', title: 'Contacted and inspecting', match: (l) => l.status === 'CONTACTED' || l.status === 'INSPECTION_BOOKED' },
  { key: 'quoted', title: 'Quoted', match: (l) => l.status === 'QUOTED' && !l.project_number },
  { key: 'won', title: 'Won', match: (l) => !!l.project_number || l.status === 'WON' },
  { key: 'closed', title: 'Lost or not a job', match: (l) => l.status === 'LOST' || l.status === 'DISQUALIFIED' },
];

/** Enquiries from first call to accepted quote: record a new one here; each opens to its next step. */
export default async function SalesPage() {
  const session = await requireSession();
  const me = await staffIdentity(session.t);
  let leads: Lead[] = [];
  try { leads = await listLeads(query); } catch (e) {
    if (!salesMissing(e)) throw e;
    return <div className="stack"><h1 className="t-page">Sales</h1><p className="t-meta">Enquiries and quotes are not available on this server yet.</p></div>;
  }
  const roles = await getSalesRoles(query);
  const mayEdit = !!me && roles.includes(me.role);
  return (
    <div className="stack" style={{ gap: 18 }}>
      <header className="page-head"><div>
        <h1 className="t-page">Sales</h1>
        <div className="sub">Enquiry → customer and site → inspection → quote → accepted (in Airtable) → project</div>
      </div></header>
      <div className="grid g-2-1">
        <div className="stack">
          {STAGES.map((s) => {
            const rows = leads.filter(s.match);
            if (!rows.length && (s.key === 'won' || s.key === 'closed')) return null;
            return (
              <section className="card" key={s.key} aria-label={s.title}>
                <CardHead icon={Inbox} title={s.title}><span className="chip num">{rows.length}</span></CardHead>
                <div className="card-body">
                  {rows.length === 0 ? <p className="t-meta">None.</p> : rows.map((l) => (
                    <div className="issue" key={l.lead_number} data-lead={l.lead_number}>
                      <div className="issue-title"><Link href={`/sales/${l.lead_number}`}>{l.contact_name}</Link>
                        <span className="t-meta"> · {l.lead_number} · {SOURCE[l.source] ?? l.source}</span></div>
                      <Badge l={LEAD_STATUS[l.status]} />
                      <div className="issue-expl">{l.site ?? l.property_address_text ?? 'No address yet'}{l.notes ? ` · ${l.notes}` : ''}
                        <br /><span className="t-meta">Received {l.received_at}{l.customer_number ? ` · ${l.customer_name} (${l.customer_number})` : ''}{l.project_number ? ` · project ${l.project_number}` : ''}</span></div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
        <section className="card sales-new" aria-label="Record an enquiry">
          <CardHead icon={PhoneCall} title="Record an enquiry" />
          <div className="card-body">
            {mayEdit ? <NewLeadForm /> : <p className="t-meta">{me ? 'Estimators, project managers, operations managers and admins record enquiries.' : 'Sign in as yourself to record enquiries (the shared demo login can only look).'}</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
