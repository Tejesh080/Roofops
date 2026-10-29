import Link from 'next/link';
import { CalendarClock, ListChecks, UserRound } from 'lucide-react';
import { query } from '@/lib/db';
import { requireSession, staffIdentity } from '@/lib/auth';
import { getChecklist, listProjects } from '@/lib/queries';
import { label, PROJECT_STAGE } from '@/lib/labels';
import { loadOps } from '@/lib/ops-load';
import { getTasks, getVisits } from '@/lib/ops';
import { nextSteps } from '@/lib/next-step';
import { Badge } from '@/components/ui/Badge';
import { CardHead, Empty } from '@/components/ui/Empty';
import { TaskRow, VisitRow } from '@/components/ops/OpsCards';
import { NewTaskForm } from '@/components/ops/OpsForms';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'My work · RoofOps' };

/** For the signed-in employee: their visits, their tasks, the projects they manage and what each needs next; planners see the whole schedule. */
export default async function WorkPage() {
  const session = await requireSession();
  const me = await staffIdentity(session.t);
  const ops = await loadOps({ live: true });
  if (!ops.installed) return <div className="stack"><h1 className="t-page">My work</h1><p className="t-meta">Site visits and tasks are not available on this server yet.</p></div>;
  const planner = !!me && ops.roles.planner.includes(me.role);
  const manager = !!me && ops.roles.taskManager.includes(me.role);
  const mineVisits = me ? ops.visits.filter((v) => v.crew.some((c) => c.code === me.employee_code)) : [];
  const myTasks = me ? ops.tasks.filter((t) => t.assignee_code === me.employee_code && (t.status === 'OPEN' || t.status === 'IN_PROGRESS')) : [];
  const unassigned = manager ? ops.tasks.filter((t) => !t.assignee_code && (t.status === 'OPEN' || t.status === 'IN_PROGRESS')) : [];
  const managed = me ? (await listProjects(query, 'active')).filter((p) => p.project_manager === me.name) : [];
  const managedSteps = await Promise.all(managed.map(async (p) => {
    const [checklist, visits, tasks] = await Promise.all([getChecklist(query, p.project_number), getVisits(query, { project: p.project_number }), getTasks(query, { project: p.project_number })]);
    return { p, step: nextSteps(p, checklist, visits, tasks, ops.today)[0]! };
  }));
  const horizon = new Date(Date.parse(`${ops.today}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
  const schedule = ops.visits.filter((v) => v.visit_date <= horizon || v.status !== 'SCHEDULED');

  return (
    <div className="stack" style={{ gap: 18 }}>
      <header className="page-head"><div>
        <h1 className="t-page">My work</h1>
        <div className="sub">{me ? <>Signed in as <strong>{me.name}</strong> · business date {ops.today}</> : 'Sign in as yourself to see your visits and tasks; the shared demo login sees the schedule only.'}</div>
      </div></header>
      {me && (
        <div className="grid g-2">
          <section className="card" aria-label="My site visits">
            <CardHead icon={CalendarClock} title="My site visits"><span className="chip num">{mineVisits.length}</span></CardHead>
            <div className="card-body">
              {mineVisits.length === 0 ? <Empty icon={CalendarClock} title="No visits booked for you" />
                : mineVisits.map((v) => <VisitRow key={v.job_number} v={v} me={me} roles={ops.roles} showProject />)}
            </div>
          </section>
          <section className="card" aria-label="My tasks">
            <CardHead icon={ListChecks} title="My tasks"><span className="chip num">{myTasks.length} open</span></CardHead>
            <div className="card-body">
              {myTasks.length === 0 ? <Empty icon={ListChecks} title="Nothing assigned to you" />
                : myTasks.map((t) => <TaskRow key={t.task_number} t={t} me={me} roles={ops.roles} staff={ops.staff} today={ops.today} showProject />)}
              {manager && <NewTaskForm project={null} staff={ops.staff} today={ops.today} />}
            </div>
          </section>
        </div>
      )}
      {managed.length > 0 && (
        <section className="card" aria-label="Projects I manage">
          <CardHead icon={UserRound} title="Projects I manage"><span className="chip num">{managed.length} active</span></CardHead>
          <div className="card-body">
            {managedSteps.map(({ p, step }) => (
              <div className="issue" key={p.project_number}>
                <div className="issue-title"><Link href={`/projects/${p.project_number}`}>{p.project_number}</Link> <span className="t-meta">{p.customer_name} · {p.site_address}</span></div>
                <Badge l={label(PROJECT_STAGE, p.status)} />
                <div className="issue-expl"><strong>Next:</strong> {step.title}{step.detail ? <span className="t-meta"> · {step.detail}</span> : null}</div>
              </div>
            ))}
          </div>
        </section>
      )}
      {unassigned.length > 0 && (
        <section className="card" aria-label="Tasks nobody has">
          <CardHead icon={ListChecks} title="Tasks nobody has yet"><span className="chip num">{unassigned.length}</span></CardHead>
          <div className="card-body">{unassigned.map((t) => <TaskRow key={t.task_number} t={t} me={me} roles={ops.roles} staff={ops.staff} today={ops.today} showProject />)}</div>
        </section>
      )}
      <section className="card" aria-label="Schedule">
        <CardHead icon={CalendarClock} title="Schedule (next 14 days)"><span className="chip num">{schedule.length} visits</span></CardHead>
        <div className="card-body">
          {schedule.length === 0 ? <Empty icon={CalendarClock} title="Nothing scheduled" text={planner ? 'Schedule visits from a project page (Site visits).' : undefined} />
            : schedule.map((v) => <VisitRow key={v.job_number} v={v} me={me} roles={ops.roles} showProject />)}
        </div>
      </section>
    </div>
  );
}
