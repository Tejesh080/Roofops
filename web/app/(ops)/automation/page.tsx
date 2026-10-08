import Link from 'next/link';
import { Activity, ShieldCheck, Wrench } from 'lucide-react';
import { query } from '@/lib/db';
import { requireSession, staffIdentity } from '@/lib/auth';
import { getExceptions, recentActivity } from '@/lib/queries';
import { outcomeLabel, timelineTitle } from '@/lib/labels';
import { Badge } from '@/components/ui/Badge';
import { CardHead, Empty } from '@/components/ui/Empty';
import { IssueList } from '@/components/dashboard/IssueList';
import { ResolveForm } from '@/components/dashboard/ResolveForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Automation · RoofOps' };

export default async function AutomationPage() {
  const session = await requireSession();
  const me = await staffIdentity(session.t);
  const [issues, activity] = await Promise.all([getExceptions(query), recentActivity(query, 30)]);
  const open = issues.filter((e) => e.resolution_status === 'OPEN' || e.resolution_status === 'RETRY_QUEUED');
  const resolved = issues.filter((e) => !open.includes(e));
  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="t-page">Automation</h1>
          <div className="sub">What RoofOps did on its own, and anything it stopped safely for a person</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Badge l={open.length ? { text: `${open.length} need a person`, tone: 'bad' } : { text: 'All healthy', tone: 'good' }} />
          <Badge l={{ text: `${resolved.length} resolved`, tone: 'good' }} />
        </div>
      </header>
      <div className="grid g-2-1">
        <div className="stack">
          <section className="card">
            <CardHead icon={Wrench} title="Needs a person" />
            <div className="card-body">
              {open.length > 0 && !me?.may_resolve_exceptions && (
                <p className="t-meta resolve-hint">{me ? `Resolving issues needs a finance, admin, operations manager or project manager sign-in; you are signed in as ${me.role.toLowerCase().replace(/_/g, ' ')}.`
                  : 'To resolve an issue, sign in as yourself (the shared demo login is read only).'}</p>
              )}
              <IssueList issues={open} emptyTitle="Nothing needs a person"
                action={me?.may_resolve_exceptions ? (e) => e.resolution_status === 'OPEN' ? <ResolveForm exception={e.exception_number} /> : null : undefined} />
            </div>
          </section>
          <section className="card">
            <CardHead icon={ShieldCheck} title="Resolved" />
            <div className="card-body"><IssueList issues={resolved} emptyTitle="No resolved issues yet" /></div>
          </section>
        </div>
        <section className="card" style={{ alignSelf: 'start' }}>
          <CardHead icon={Activity} title="Recent activity" />
          <div className="card-body">
            {activity.length === 0 ? <Empty icon={Activity} title="No recent activity" /> : (
              <ul className="rows">
                {activity.map((a, i) => (
                  <li key={i}>
                    <div style={{ minWidth: 0 }}>
                      <div className="row-main" style={{ fontSize: 13.5 }}>{timelineTitle(a.kind)}</div>
                      <div className="row-sub"><Link href={`/projects/${a.project_number}`}>{a.project_number}</Link> · {a.occurred_at.slice(5).replace(' ', ' at ')}</div>
                    </div>
                    <Badge l={outcomeLabel(a.kind, a.status)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

