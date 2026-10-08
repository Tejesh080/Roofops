import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import { getChecklist, getExceptions, getInvoices, getProject, getPurchaseOrders, getTimeline, getXeroHistory } from '@/lib/queries';
import { date } from '@/lib/labels';
import { healthStrip, materialsAction } from '@/lib/insights';
import { groupTimeline } from '@/lib/timeline';
import { HealthStrip, ProjectHeader } from '@/components/project/Header';
import { ChecklistCard, InfoCards, IssuesCard, NeedsAttention } from '@/components/project/Panels';
import { MaterialsCard } from '@/components/project/MaterialsCard';
import { FinanceCard } from '@/components/project/FinanceCard';
import { Timeline } from '@/components/project/Timeline';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ number: string }> }) {
  return { title: `${decodeURIComponent((await params).number).toUpperCase()} · RoofOps` };
}

export default async function ProjectPage({ params }: { params: Promise<{ number: string }> }) {
  await requireSession();
  const p = await getProject(query, decodeURIComponent((await params).number).toUpperCase());
  if (!p) notFound();
  const n = p.project_number;
  const [checklist, pos, invoices, history, issues, xero] = await Promise.all([
    getChecklist(query, n), getPurchaseOrders(query, n), getInvoices(query, n), getTimeline(query, n, 200), getExceptions(query, { project: n }),
    getXeroHistory(query, n),
  ]);
  const openIssues = issues.filter((e) => e.resolution_status === 'OPEN' || e.resolution_status === 'RETRY_QUEUED');
  const atRisk = p.is_active && p.risk_level === 'HIGH';
  const review = checklist.find((c) => c.kind === 'TASK' && c.stage === 'MATERIAL_REVIEW');

  return (
    <div className="stack" style={{ gap: 18 }}>
      <ProjectHeader p={p} />
      <HealthStrip items={healthStrip(p, issues)} />
      {(atRisk || openIssues.length > 0) && <NeedsAttention p={p} openIssues={openIssues} action={atRisk ? materialsAction(p, pos, date) : null} />}
      <InfoCards p={p} />
      <div className="grid g-2">
        <MaterialsCard p={p} pos={pos} review={review} />
        <FinanceCard p={p} invoices={invoices} xero={xero} />
      </div>
      <div className="grid g-2-1">
        <Timeline groups={groupTimeline(history, n)} />
        <div className="stack">
          <IssuesCard issues={issues} />
          <ChecklistCard items={checklist.filter((c) => c !== review)} />
        </div>
      </div>
    </div>
  );
}
