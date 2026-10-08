import { requireSession } from '@/lib/auth';
import { query } from '@/lib/db';
import { getExceptions, getKpis, listProjects } from '@/lib/queries';
import { attentionToday } from '@/lib/insights';
import { Sidebar } from '@/components/shell/Sidebar';
import { Topbar } from '@/components/shell/Topbar';
import { CopilotDrawer } from '@/components/copilot/CopilotDrawer';
import { Info } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function OpsLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const [k, rows, issues] = await Promise.all([getKpis(query), listProjects(query, 'all'), getExceptions(query, { openOnly: true })]);
  return (
    <div className="app">
      <Topbar user={session.u} role={session.r} />
      <div className="notice" role="note"><Info size={13} aria-hidden /> Synthetic data · Business date 29 Sep 2026 · Xero Demo Company</div>
      <Sidebar counts={{ attention: attentionToday(rows, issues, 100).length, automation: k.open_exceptions }} />
      <main className="main" id="main"><div className="page">{children}</div></main>
      <CopilotDrawer />
    </div>
  );
}
