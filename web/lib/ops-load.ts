import 'server-only';
import { query } from './db';
import { getOpsRoles, getStaff, getTasks, getVisits, opsMissing, type OpsRoles, type StaffMember, type Task, type Visit } from './ops';

export interface OpsData { installed: boolean; visits: Visit[]; tasks: Task[]; staff: StaffMember[]; roles: OpsRoles; today: string }

/** Visits, tasks, the people who can be booked, the roles that may plan, and the business date. Missing migration = empty, said once. */
export async function loadOps(o: { project?: string; employee?: string; from?: string; live?: boolean; openTasks?: boolean }): Promise<OpsData> {
  const today = (await query<{ d: string }>('select app_today()::text d'))[0]?.d ?? '';
  try {
    const [visits, tasks, staff, roles] = await Promise.all([
      getVisits(query, { project: o.project, employee: o.employee, from: o.from, live: o.live }),
      getTasks(query, { project: o.project, assignee: o.employee, open: o.openTasks }),
      getStaff(query), getOpsRoles(query)]);
    return { installed: true, visits, tasks, staff, roles, today };
  } catch (e) {
    if (!opsMissing(e)) throw e;
    return { installed: false, visits: [], tasks: [], staff: [], roles: { planner: [], taskManager: [] }, today };
  }
}
