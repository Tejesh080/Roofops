import { query } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import { listProjects } from '@/lib/queries';
import { ProjectsView } from '@/components/dashboard/ProjectsView';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Projects · RoofOps' };

export default async function ProjectsPage() {
  await requireSession();
  const rows = await listProjects(query, 'all');
  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="t-page">Projects</h1>
          <div className="sub">{rows.length} projects · {rows.filter((p) => p.is_active).length} active · click a row for the full picture</div>
        </div>
      </header>
      <ProjectsView rows={rows} initial="all" />
    </>
  );
}
