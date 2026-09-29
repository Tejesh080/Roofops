import { query } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import { getExceptions, getKpis, listProjects } from '@/lib/queries';
import { date, money } from '@/lib/labels';
import { attentionToday, projectSeverity } from '@/lib/insights';
import { OverviewBoard } from '@/components/dashboard/OverviewBoard';
import type { TableFilter } from '@/components/dashboard/ProjectTable';
import { AttentionPanel } from '@/components/dashboard/AttentionPanel';
import type { Metric } from '@/components/dashboard/Metrics';

const VIEWS: TableFilter[] = ['active', 'attention', 'at_risk', 'awaiting_materials', 'ready_to_invoice', 'issues', 'completed', 'all'];
const isFilter = (v: string | undefined): v is TableFilter => VIEWS.includes(v as TableFilter);

export const dynamic = 'force-dynamic';

export default async function Overview({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  await requireSession();
  const { view } = await searchParams;
  const [k, rows, issues] = await Promise.all([getKpis(query), listProjects(query, 'all'), getExceptions(query, { openOnly: true })]);

  const active = rows.filter((p) => p.is_active);
  const atRisk = active.filter((p) => p.risk_level === 'HIGH');
  const ready = rows.filter((p) => p.invoice_status === 'READY_TO_INVOICE');
  const readyValue = ready.reduce((s, p) => s + (p.invoice_amount_inc_gst ?? 0), 0);
  const overdueConfirmations = rows.filter((p) => p.material_status === 'CONFIRMATION_OVERDUE').length;
  const metrics: Metric[] = [
    { key: 'active', label: 'Active projects', value: k.active_projects, icon: 'active', tone: 'neutral',
      note: `${active.filter((p) => p.needs_attention).length} require attention` },
    { key: 'at_risk', label: 'Projects at risk', value: k.projects_at_risk, icon: 'risk', tone: 'bad',
      note: `${atRisk.filter((p) => projectSeverity(p) === 'high').length} high priority` },
    { key: 'awaiting_materials', label: 'Awaiting materials', value: k.awaiting_materials, icon: 'materials', tone: 'warn',
      note: overdueConfirmations ? `${overdueConfirmations} supplier confirmations overdue` : 'All suppliers on track' },
    { key: 'ready_to_invoice', label: 'Ready to invoice', value: k.ready_to_invoice, icon: 'invoice', tone: 'good',
      note: `${money(readyValue).replace(/\.\d\d$/, '')} to bill${k.awaiting_invoice_approval ? ` · ${k.awaiting_invoice_approval} awaiting approval` : ''}` },
    { key: 'issues', label: 'Open issues', value: k.open_exceptions, icon: 'issues', tone: k.open_exceptions ? 'bad' : 'good',
      note: k.open_exceptions ? `${k.open_exceptions} need a person` : 'All automation healthy' },
  ];
  const all = attentionToday(rows, issues, 100);

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="t-page">Good morning</h1>
          <div className="sub">Operations overview for {date(k.as_of)} · live from RoofOps</div>
        </div>
      </header>
      <OverviewBoard rows={rows} metrics={metrics} initial={isFilter(view) ? view : 'active'}
        attention={<AttentionPanel items={all.slice(0, 5)} total={all.length} />} />
    </>
  );
}
