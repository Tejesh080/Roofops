import { query } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import { getExceptions, listProjects } from '@/lib/queries';
import { attentionToday } from '@/lib/insights';
import { AttentionPanel } from '@/components/dashboard/AttentionPanel';
import { IssueList } from '@/components/dashboard/IssueList';
import { CardHead } from '@/components/ui/Empty';
import { Wrench } from 'lucide-react';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Attention · RoofOps' };

export default async function AttentionPage() {
  await requireSession();
  const [rows, open] = await Promise.all([listProjects(query, 'all'), getExceptions(query, { openOnly: true })]);
  const items = attentionToday(rows, open, 100);
  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="t-page">Needs attention</h1>
          <div className="sub">Everything that needs a person today, most serious first</div>
        </div>
      </header>
      <div className="grid g-2-1">
        <AttentionPanel items={items} total={items.length} compact={false} />
        <section className="card">
          <CardHead icon={Wrench} title="Automation issues" />
          <div className="card-body"><IssueList issues={open} emptyTitle="No open automation issues" /></div>
        </section>
      </div>
    </>
  );
}
