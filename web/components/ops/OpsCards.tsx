import Link from 'next/link';
import { CalendarClock, ListChecks, Signpost } from 'lucide-react';
import type { StaffIdentity } from '@/lib/auth';
import type { OpsRoles, StaffMember, Task, Visit } from '@/lib/ops';
import { TASK_STATUS, TASK_TYPE, VISIT_STATUS, VISIT_TYPE, visitWhen } from '@/lib/ops';
import type { NextStep } from '@/lib/next-step';
import { airtableProjectUrl } from '@/lib/labels';
import { Badge } from '@/components/ui/Badge';
import { CardHead, Empty } from '@/components/ui/Empty';
import { NewTaskForm, ScheduleVisitForm, TaskActions, VisitActions } from './OpsForms';

const WHERE: Record<NextStep['where'], string> = { airtable: 'In Airtable', dashboard: 'Here', finance: 'Finance page', none: '' };

/** The project's next steps, first one first, each saying where it is done. */
export function NextStepsCard({ steps, airtableRecord }: { steps: NextStep[]; airtableRecord: string | null }) {
  const at = airtableProjectUrl(airtableRecord);
  return (
    <section className="card" aria-label="Next steps">
      <CardHead icon={Signpost} title="Next steps">{at && <a className="chip" href={at} target="_blank" rel="noreferrer">Open in Airtable</a>}</CardHead>
      <div className="card-body">
        <ol className="next-steps">
          {steps.map((s, i) => (
            <li key={i} className={i === 0 ? 'first' : undefined}>
              <div className="next-title"><Badge l={{ text: i === 0 ? 'Now' : 'Then', tone: i === 0 ? s.tone : 'neutral' }} /> <strong>{s.title}</strong>
                {s.where !== 'none' && s.where !== 'dashboard' && (s.where === 'finance'
                  ? <Link href="/finance" className="chip">{WHERE.finance}</Link> : <span className="chip">{WHERE[s.where]}</span>)}</div>
              {s.detail && <p className="t-meta">{s.detail}</p>}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function CrewLine({ v }: { v: Visit }) {
  return <span>{v.crew.map((c, i) => <span key={c.code}>{i > 0 && ', '}{c.name}{c.crew_role === 'LEADING_HAND' ? ' (leading hand)' : ''}</span>)}</span>;
}

/** One visit: when, what, crew, state, the latest reason, and the buttons this person may use. */
export function VisitRow({ v, me, roles, showProject = false }: { v: Visit; me: StaffIdentity | null; roles: OpsRoles; showProject?: boolean }) {
  const s = VISIT_STATUS[v.status];
  const planner = !!me && roles.planner.includes(me.role);
  const crew = !!me && v.crew.some((c) => c.code === me.employee_code);
  return (
    <div className="issue" data-visit={v.job_number}>
      <div className="issue-title">
        {v.job_number} · {VISIT_TYPE[v.job_type] ?? v.job_type}
        {showProject && <> · <Link href={`/projects/${v.project_number}`}>{v.project_number}</Link> <span className="t-meta">{v.customer_name}</span></>}
      </div>
      <Badge l={{ text: s.text, tone: s.tone }} />
      <div className="issue-expl">
        <strong>{visitWhen(v.scheduled_start, v.scheduled_end)}</strong>{showProject && v.site ? ` · ${v.site}` : ''}
        <br />Crew: <CrewLine v={v} />
        {v.notes && <><br />Note: {v.notes}</>}
        {v.status_reason && <><br />{v.status === 'COMPLETED' ? 'Done' : 'Reason'}: {v.status_reason}</>}
        {v.actual_start && <><br /><span className="t-meta">Started {v.actual_start.replace('T', ' ')}{v.actual_end ? `, finished ${v.actual_end.replace('T', ' ')}` : ''}</span></>}
      </div>
      {me && <VisitActions job={v.job_number} status={v.status} version={v.record_version} planner={planner} crew={crew} start={v.scheduled_start} end={v.scheduled_end} />}
    </div>
  );
}

export function VisitsCard({ project, visits, me, roles, staff, today, open }: { project: string; visits: Visit[]; me: StaffIdentity | null; roles: OpsRoles; staff: StaffMember[]; today: string; open: boolean }) {
  const planner = !!me && roles.planner.includes(me.role);
  const live = visits.filter((v) => v.status !== 'COMPLETED' && v.status !== 'CANCELLED');
  const past = visits.filter((v) => v.status === 'COMPLETED' || v.status === 'CANCELLED');
  return (
    <section className="card" id="site-visits" aria-label="Site visits">
      <CardHead icon={CalendarClock} title="Site visits"><span className="chip num">{live.length} upcoming or on site</span></CardHead>
      <div className="card-body">
        {visits.length === 0 ? <Empty icon={CalendarClock} title="No site visits yet" text={open ? 'A planner schedules the crew here.' : 'This project is closed.'} />
          : <>{live.map((v) => <VisitRow key={v.job_number} v={v} me={me} roles={roles} />)}
            {past.length > 0 && <details className="tech"><summary className="t-meta">{past.length} completed or cancelled</summary>{past.map((v) => <VisitRow key={v.job_number} v={v} me={me} roles={roles} />)}</details>}</>}
        {!me && <p className="t-meta">Sign in as yourself to schedule or update visits.</p>}
        {me && open && planner && <ScheduleVisitForm project={project} staff={staff} defaultDay={today} />}
        {me && open && !planner && <p className="t-meta">A planner (admin, operations or project manager) schedules visits; the crew starts and completes them.</p>}
      </div>
    </section>
  );
}

export function TaskRow({ t, me, roles, staff, today, showProject = false }: { t: Task; me: StaffIdentity | null; roles: OpsRoles; staff: StaffMember[]; today: string; showProject?: boolean }) {
  const s = TASK_STATUS[t.status];
  const manager = !!me && roles.taskManager.includes(me.role);
  const mine = !!me && t.assignee_code === me.employee_code;
  return (
    <div className="issue" data-task={t.task_number}>
      <div className="issue-title">{t.title}
        <span className="t-meta"> · {t.task_number}{showProject && t.project_number ? <> · <Link href={`/projects/${t.project_number}`}>{t.project_number}</Link></> : null}</span></div>
      <Badge l={t.overdue ? { text: 'Overdue', tone: 'bad' } : { text: s.text, tone: s.tone }} />
      <div className="issue-expl">
        {TASK_TYPE[t.task_type] ?? t.task_type} · {t.assignee_name ? <>for <strong>{t.assignee_name}</strong></> : 'nobody assigned'}{t.due_on ? ` · due ${t.due_on}` : ''}
        {t.description && <><br />{t.description}</>}
        {t.status_note && <><br /><span className="t-meta">{t.status === 'CANCELLED' ? 'Cancelled: ' : 'Note: '}{t.status_note}</span></>}
      </div>
      {me && <TaskActions task={t.task_number} status={t.status} version={t.record_version} manager={manager} mine={mine} staff={staff} today={today} />}
    </div>
  );
}

export function TasksCard({ project, tasks, me, roles, staff, today, open }: { project: string | null; tasks: Task[]; me: StaffIdentity | null; roles: OpsRoles; staff: StaffMember[]; today: string; open: boolean }) {
  const manager = !!me && roles.taskManager.includes(me.role);
  const active = tasks.filter((t) => t.status === 'OPEN' || t.status === 'IN_PROGRESS');
  const closed = tasks.filter((t) => t.status === 'DONE' || t.status === 'CANCELLED');
  return (
    <section className="card" id="tasks" aria-label="Tasks">
      <CardHead icon={ListChecks} title="Tasks"><span className="chip num">{active.length} open</span></CardHead>
      <div className="card-body">
        {tasks.length === 0 ? <Empty icon={ListChecks} title="No tasks" text="Add one for anything that has to be done by someone, by a date." />
          : <>{active.map((t) => <TaskRow key={t.task_number} t={t} me={me} roles={roles} staff={staff} today={today} />)}
            {closed.length > 0 && <details className="tech"><summary className="t-meta">{closed.length} done or cancelled</summary>{closed.map((t) => <TaskRow key={t.task_number} t={t} me={me} roles={roles} staff={staff} today={today} />)}</details>}</>}
        {me && open && manager && <NewTaskForm project={project} staff={staff} today={today} />}
      </div>
    </section>
  );
}
