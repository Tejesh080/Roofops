/**
 * Site visits (crew scheduling) and tasks: read models (v_dashboard_site_visits, v_dashboard_tasks, v_dashboard_staff,
 * v_dashboard_ops_roles) and the words staff see. Pure: the caller supplies `query`. Writes go through the web_visit_* and
 * web_task_* functions (app/(ops)/work/actions.ts), which hold every rule.
 */
import type { Query } from './queries.ts';

export interface CrewMember { code: string; name: string; crew_role: 'LEADING_HAND' | 'CREW' | 'APPRENTICE' | 'SUBCONTRACTOR' }
export interface Visit {
  job_number: string; project_number: string; customer_name: string; site: string; project_manager: string | null;
  job_type: string; status: VisitStatus; scheduled_start: string; scheduled_end: string; actual_start: string | null; actual_end: string | null;
  notes: string | null; status_reason: string | null; record_version: number; visit_date: string; crew: CrewMember[];
}
export type VisitStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'WEATHER_DELAYED' | 'CANCELLED';
export interface Task {
  task_number: string; project_number: string | null; task_type: string; title: string; description: string | null; status: TaskStatus;
  due_on: string | null; status_note: string | null; record_version: number; assignee_code: string | null; assignee_name: string | null;
  created_by_name: string | null; overdue: boolean;
}
export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
export interface StaffMember { employee_code: string; full_name: string; role: string }
export interface OpsRoles { planner: string[]; taskManager: string[] }

// Times are shown and entered in Brisbane time (the business's), whatever the server's zone.
const VISIT_COLUMNS = `job_number, project_number, customer_name, site, project_manager, job_type, status,
  to_char(scheduled_start at time zone 'Australia/Brisbane', 'YYYY-MM-DD"T"HH24:MI') scheduled_start,
  to_char(scheduled_end at time zone 'Australia/Brisbane', 'YYYY-MM-DD"T"HH24:MI') scheduled_end,
  to_char(actual_start at time zone 'Australia/Brisbane', 'YYYY-MM-DD"T"HH24:MI') actual_start,
  to_char(actual_end at time zone 'Australia/Brisbane', 'YYYY-MM-DD"T"HH24:MI') actual_end,
  notes, status_reason, record_version::int, visit_date::text, crew`;
const TASK_COLUMNS = `task_number, project_number, task_type, title, description, status, due_on::text, status_note, record_version::int,
  assignee_code, assignee_name, created_by_name, overdue`;

export const getVisits = (q: Query, o: { project?: string; employee?: string; from?: string; to?: string; live?: boolean } = {}) => {
  const where: string[] = []; const p: unknown[] = [];
  if (o.project) { p.push(o.project); where.push(`project_number = $${p.length}`); }
  if (o.employee) { p.push(o.employee); where.push(`crew @> jsonb_build_array(jsonb_build_object('code', $${p.length}::text))`); }
  if (o.from) { p.push(o.from); where.push(`visit_date >= $${p.length}::date`); }
  if (o.to) { p.push(o.to); where.push(`visit_date <= $${p.length}::date`); }
  if (o.live) where.push(`status in ('SCHEDULED', 'IN_PROGRESS', 'WEATHER_DELAYED')`);
  return q<Visit>(`select ${VISIT_COLUMNS} from v_dashboard_site_visits ${where.length ? `where ${where.join(' and ')}` : ''}
                   order by scheduled_start, job_number`, p);
};

export const getTasks = (q: Query, o: { project?: string; assignee?: string; open?: boolean } = {}) => {
  const where: string[] = []; const p: unknown[] = [];
  if (o.project) { p.push(o.project); where.push(`project_number = $${p.length}`); }
  if (o.assignee) { p.push(o.assignee); where.push(`assignee_code = $${p.length}`); }
  if (o.open) where.push(`status in ('OPEN', 'IN_PROGRESS')`);
  return q<Task>(`select ${TASK_COLUMNS} from v_dashboard_tasks ${where.length ? `where ${where.join(' and ')}` : ''}
                  order by (status in ('OPEN', 'IN_PROGRESS')) desc, overdue desc, due_on nulls last, task_number`, p);
};

export const getStaff = (q: Query) => q<StaffMember>('select employee_code, full_name, role from v_dashboard_staff order by full_name');

export async function getOpsRoles(q: Query): Promise<OpsRoles> {
  try {
    const [r] = await q<{ planner_roles: string | null; task_manager_roles: string | null }>('select planner_roles, task_manager_roles from v_dashboard_ops_roles');
    const split = (v: string | null | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return { planner: split(r?.planner_roles), taskManager: split(r?.task_manager_roles) };
  } catch {
    return { planner: [], taskManager: [] };   // not installed on this database: nobody is offered the forms
  }
}

/** Not installed yet (the migration has not been applied): the pages say so instead of failing. */
export const opsMissing = (e: unknown) => /v_dashboard_(site_visits|tasks|staff|ops_roles)|web_(visit|task)_/.test(String((e as Error)?.message ?? e)) && /does not exist/.test(String((e as Error)?.message ?? e));

export const VISIT_TYPE: Record<string, string> = {
  INSTALL: 'Install', STRIP_AND_REPLACE: 'Strip and replace', RESTORATION: 'Restoration', REPAIR: 'Repair', MAKE_SAFE: 'Make safe', RETURN_VISIT: 'Return visit',
};
export const VISIT_STATUS: Record<VisitStatus, { text: string; tone: 'good' | 'warn' | 'bad' | 'info' | 'neutral' }> = {
  SCHEDULED: { text: 'Scheduled', tone: 'info' }, IN_PROGRESS: { text: 'On site', tone: 'warn' }, COMPLETED: { text: 'Completed', tone: 'good' },
  WEATHER_DELAYED: { text: 'Weather delayed', tone: 'bad' }, CANCELLED: { text: 'Cancelled', tone: 'neutral' },
};
export const TASK_TYPE: Record<string, string> = {
  GENERAL: 'General', MATERIAL_REVIEW: 'Material review', SCHEDULE_JOB: 'Schedule the job', SUPPLIER_FOLLOW_UP: 'Supplier follow-up',
  COMPLIANCE_DOCS: 'Compliance documents', CUSTOMER_FOLLOW_UP: 'Customer follow-up', INVOICE_REVIEW: 'Invoice review', EXCEPTION_REVIEW: 'Issue review',
};
export const TASK_STATUS: Record<TaskStatus, { text: string; tone: 'good' | 'warn' | 'bad' | 'info' | 'neutral' }> = {
  OPEN: { text: 'Not started', tone: 'neutral' }, IN_PROGRESS: { text: 'In progress', tone: 'info' }, DONE: { text: 'Done', tone: 'good' },
  CANCELLED: { text: 'Cancelled', tone: 'neutral' },
};

/** What each refusal means to the person who clicked (the database's detail is appended where it adds something). */
export const OPS_CODE: Record<string, string> = {
  SIGNED_OUT: 'Your sign-in has ended. Sign in again as yourself.',
  ACTOR_UNAUTHORIZED: 'Your role cannot do this.',
  NOT_FOUND: 'That record does not exist (any more).',
  STALE: 'Someone changed this since you opened the page. Reload and check it again.',
  INVALID: 'Check the form.',
  INVALID_TIMES: 'Check the times.',
  IN_PAST: 'That date is in the past.',
  TOO_LONG: 'That visit is too long.',
  NO_CREW: 'Pick at least one person for the crew.',
  CREW_UNKNOWN: 'One of the crew cannot be booked.',
  CREW_CONFLICT: 'Someone on the crew is already booked at that time.',
  PROJECT_CLOSED: 'The project is closed or cancelled.',
  PROJECT_COMPLETED: 'The project is completed.',
  INVALID_TRANSITION: 'That is not possible in its current state.',
  REASON_REQUIRED: 'A short reason is needed.',
  ASSIGNEE_UNKNOWN: 'That person cannot be given tasks.',
  DUPLICATE_OPEN_TASK: 'That task already exists.',
};
export const opsRefusal = (r: { code?: string; detail?: string }) =>
  r.code && OPS_CODE[r.code] ? `${OPS_CODE[r.code]}${r.detail && r.code !== 'SIGNED_OUT' ? ` (${r.detail})` : ''}` : (r.detail ?? 'Not done.');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Tue 30 Sep, 07:00–15:00" (or across days), from Brisbane local "YYYY-MM-DDTHH:MI" strings. */
export function visitWhen(start: string, end: string): string {
  // Written out (not toLocaleDateString): ICU data differs between servers, and staff compare these strings.
  const d = (s: string) => { const t = new Date(`${s.slice(0, 10)}T00:00:00Z`); return `${DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`; };
  return start.slice(0, 10) === end.slice(0, 10) ? `${d(start)}, ${start.slice(11, 16)}–${end.slice(11, 16)}` : `${d(start)} ${start.slice(11, 16)} – ${d(end)} ${end.slice(11, 16)}`;
}
