/**
 * OPS-01 (migration 20261017010000): site visits with crew, and project tasks, run by signed-in staff. The database is the
 * only gate: session, role, transition, record version, crew double-booking and request-key idempotency. Synthetic people:
 * EMP-810 operations manager (plans), EMP-811/812 field crew, EMP-813 viewer; EMP-002 is an estimator (may do neither).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPostgres, type Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const PW = 'ops test password 01';
const PEOPLE = [['EMP-810', 'planner', 'Synthetic Operations Planner', 'OPERATIONS_MANAGER'], ['EMP-811', 'crew1', 'Synthetic Leading Hand', 'FIELD_CREW'],
  ['EMP-812', 'crew2', 'Synthetic Roofer', 'FIELD_CREW'], ['EMP-813', 'viewer', 'Synthetic Viewer', 'VIEWER']] as const;

async function setup(db: Db, tok: Record<string, string>) {
  await importBundle(db);
  for (const [code, , name, role] of PEOPLE) {
    await db.query('insert into employees (employee_code, full_name, email, role, is_active) values ($1, $2, $3, $4, true)', [code, name, `${code.toLowerCase()}@example.test`, role]);
  }
  for (const [code, login] of [...PEOPLE.filter(([, , , r]) => r !== 'VIEWER').map(([c, l]) => [c, l] as const), ['EMP-002', 'estimator'] as const]) {
    const set = (await db.query<{ r: R }>('select ops_staff_set_password($1, $2, $3) r', [code, login, PW]))[0]!.r;
    expect(set).toMatchObject({ ok: true });
    tok[login] = String((await db.query<{ r: R }>('select web_staff_sign_in($1, $2) r', [login, PW]))[0]!.r.token);
  }
}

describe.each(TARGETS)('site visits and tasks [%s]', (target) => {
  let db: Db;
  const tok: Record<string, string> = {};
  let today = '';
  const one = async (sql: string, p: unknown[] = []) => (await db.query<R>(sql, p))[0]!;
  const call = async (sql: string, p: unknown[]) => (await one(sql, p)).r as R;
  const at = (days: number, hour: number) => `${new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00+10:00`;
  const schedule = (t: string, prj: string, start: string, end: string, crew: string[], key: string, o: { type?: string; lead?: string | null; note?: string | null } = {}) =>
    call('select web_visit_schedule($1, $2, $3, $4, $5, $6, $7, $8, $9) r', [t, prj, o.type ?? 'INSTALL', start, end, crew, o.lead ?? null, o.note ?? null, key]);
  const visit = (t: string, job: string, action: string, version: number, reason: string | null = null, start: string | null = null, end: string | null = null) =>
    call('select web_visit_update($1, $2, $3, $4, $5, $6, $7) r', [t, job, action, version, reason, start, end]);
  const row = (job: string) => one('select * from v_dashboard_site_visits where job_number = $1', [job]);
  const createTask = (t: string, o: { project?: string | null; type?: string; title?: string; assignee?: string | null; due?: string | null; key: string }) =>
    call('select web_task_create($1, $2, $3, $4, $5, $6, $7, $8) r', [t, o.project ?? null, o.type ?? 'GENERAL', o.title ?? 'Check the gutter guard order', o.assignee ?? null, o.due ?? null, null, o.key]);
  const task = (t: string, n: string, action: string, version: number, o: { assignee?: string; due?: string; note?: string } = {}) =>
    call('select web_task_update($1, $2, $3, $4, $5, $6, $7) r', [t, n, action, version, o.assignee ?? null, o.due ?? null, o.note ?? null]);
  let cancelled = '';
  const projectIn = async (status: string) => String((await one(`select project_number from projects where status = $1 order by project_number limit 1`, [status])).project_number);

  beforeAll(async () => {
    db = await migratedDb(target);
    await setup(db, tok);
    today = String((await one('select app_today()::text d')).d);
    // One cancelled project (the seed has none): the last PLANNING one.
    cancelled = String((await one(`update projects set status = 'CANCELLED', cancellation_reason = 'Synthetic test: customer withdrew' where id = (select id from projects where status = 'PLANNING' order by project_number desc limit 1) returning project_number`)).project_number);
  }, 180_000);
  afterAll(async () => { await db?.close(); });

  it('privileges: the dashboard may call the web functions and read the views; the helpers are nobody\'s', async () => {
    const can = async (role: string, fn: string) => (await one(`select bool_or(has_function_privilege($1, p.oid, 'execute')) ok from pg_proc p where p.proname = $2`, [role, fn])).ok;
    for (const fn of ['web_visit_schedule', 'web_visit_update', 'web_task_create', 'web_task_update']) expect(await can('roofops_dashboard', fn), fn).toBe(true);
    for (const fn of ['staff_role_allowed', 'visit_crew_conflict', 'visit_times_problem']) {
      expect(await can('roofops_dashboard', fn), fn).toBe(false);
      expect(await can('roofops_workflow', fn), fn).toBe(false);
    }
    expect(await one(`select has_table_privilege('roofops_dashboard', 'jobs', 'select') t, has_table_privilege('roofops_dashboard', 'v_dashboard_site_visits', 'select') v`)).toEqual({ t: false, v: true });
    expect((await db.query(`select * from v_dashboard_staff where employee_code = 'EMP-813'`)).length).toBe(0);   // a viewer is never offered as crew
    // A task a workflow creates (wf_quote_accepted's material review) is numbered too, so staff see it.
    expect(String((await one(`insert into tasks (task_type, title) values ('MATERIAL_REVIEW', 'Review materials (workflow)') returning task_number`)).task_number)).toMatch(/^TASK-\d{4}$/);
  });

  it('a planner schedules a visit with its crew: one job, the leading hand first, audited on the project; a repeat submit returns the same visit', async () => {
    const prj = await projectIn('SCHEDULED');
    const r = await schedule(tok.planner!, prj, at(1, 7), at(1, 15), ['EMP-811', 'EMP-812'], 'visit-key-0001', { lead: 'EMP-812', note: 'Bring the long ladder' });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, status: 'SCHEDULED', record_version: 1 });
    const job = String(r.job_number);
    expect(job).toMatch(/^JOB-\d{4}-\d{4}$/);
    expect(await schedule(tok.planner!, prj, at(1, 7), at(1, 15), ['EMP-811', 'EMP-812'], 'visit-key-0001')).toEqual({ ok: true, duplicate: true, job_number: job, status: 'SCHEDULED' });
    expect(await one('select count(*)::int n from jobs where request_key = $1', ['visit-key-0001'])).toEqual({ n: 1 });
    const v = await row(job);
    expect(v).toMatchObject({ project_number: prj, status: 'SCHEDULED', notes: 'Bring the long ladder', visit_date: expect.anything() });
    expect((v.crew as R[]).map((c) => [c.code, c.crew_role])).toEqual([['EMP-812', 'LEADING_HAND'], ['EMP-811', 'CREW']]);
    expect(await one(`select actor_id, business_reference from audit_events where action = 'job.scheduled' and entity_id = (select id from jobs where job_number = $1)`, [job]))
      .toEqual({ actor_id: 'EMP-810', business_reference: prj });
    expect(await one(`select count(*)::int n from v_dashboard_project_timeline where project_number = $1 and kind = 'job.scheduled' and source = 'AUDIT'`, [prj])).toEqual({ n: 1 });
  });

  it('refuses: no session, a role that may not plan, bad times, the past, too long, no or unknown crew, a viewer, closed and completed projects', async () => {
    const prj = await projectIn('SCHEDULED');
    expect(await schedule('not-a-token', prj, at(2, 7), at(2, 9), ['EMP-811'], 'visit-key-r001')).toMatchObject({ ok: false, code: 'SIGNED_OUT' });
    expect(await schedule(tok.estimator!, prj, at(2, 7), at(2, 9), ['EMP-811'], 'visit-key-r002')).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    expect(await schedule(tok.crew1!, prj, at(2, 7), at(2, 9), ['EMP-811'], 'visit-key-r003')).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    expect(await schedule(tok.planner!, prj, at(2, 9), at(2, 7), ['EMP-811'], 'visit-key-r004')).toMatchObject({ ok: false, code: 'INVALID_TIMES' });
    expect(await schedule(tok.planner!, prj, at(-1, 7), at(-1, 9), ['EMP-811'], 'visit-key-r005')).toMatchObject({ ok: false, code: 'IN_PAST' });
    expect(await schedule(tok.planner!, prj, at(2, 7), at(20, 9), ['EMP-811'], 'visit-key-r006')).toMatchObject({ ok: false, code: 'TOO_LONG' });
    expect(await schedule(tok.planner!, prj, at(2, 7), at(2, 9), [], 'visit-key-r007')).toMatchObject({ ok: false, code: 'NO_CREW' });
    expect(await schedule(tok.planner!, prj, at(2, 7), at(2, 9), ['EMP-999'], 'visit-key-r008')).toMatchObject({ ok: false, code: 'CREW_UNKNOWN' });
    expect(await schedule(tok.planner!, prj, at(2, 7), at(2, 9), ['EMP-813'], 'visit-key-r009')).toMatchObject({ ok: false, code: 'CREW_UNKNOWN' });
    expect(await schedule(tok.planner!, prj, at(2, 7), at(2, 9), ['EMP-811'], 'visit-key-r010', { lead: 'EMP-812' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(await schedule(tok.planner!, prj, at(2, 7), at(2, 9), ['EMP-811'], 'visit-key-r011', { type: 'PARTY' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(await schedule(tok.planner!, cancelled, at(2, 7), at(2, 9), ['EMP-811'], 'visit-key-r012')).toMatchObject({ ok: false, code: 'PROJECT_CLOSED' });   // cancelled
    const done = await projectIn('COMPLETED');
    expect(await schedule(tok.planner!, done, at(2, 7), at(2, 9), ['EMP-811'], 'visit-key-r013')).toMatchObject({ ok: false, code: 'PROJECT_COMPLETED' });
    expect(await schedule(tok.planner!, 'PRJ-1999-9999', at(2, 7), at(2, 9), ['EMP-811'], 'visit-key-r014')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await one(`select count(*)::int n from jobs where request_key like 'visit-key-r%'`)).toEqual({ n: 0 });
    const back = await schedule(tok.planner!, done, at(3, 7), at(3, 9), ['EMP-811'], 'visit-key-r015', { type: 'RETURN_VISIT' });   // a completed job may get a return visit
    expect(back).toMatchObject({ ok: true });
    await visit(tok.planner!, String(back.job_number), 'cancel', 1, 'Customer fixed it themselves');
  });

  it('nobody is double-booked: an overlapping visit for the same person is refused and named; back-to-back is fine', async () => {
    const prj = await projectIn('PLANNING');
    const first = await schedule(tok.planner!, prj, at(4, 7), at(4, 12), ['EMP-811'], 'visit-key-c001');
    expect(first).toMatchObject({ ok: true });
    const clash = await schedule(tok.planner!, prj, at(4, 11), at(4, 15), ['EMP-812', 'EMP-811'], 'visit-key-c002');
    expect(clash).toMatchObject({ ok: false, code: 'CREW_CONFLICT', conflict: { employee: 'EMP-811', job_number: first.job_number } });
    expect(String(clash.detail)).toContain('Synthetic Leading Hand is already on');
    expect(await schedule(tok.planner!, prj, at(4, 12), at(4, 15), ['EMP-811'], 'visit-key-c003')).toMatchObject({ ok: true });   // starts when the other ends
    // Without a named leading hand, the first person given leads (the form sends them in list order).
    const order = await schedule(tok.planner!, prj, at(10, 7), at(10, 9), ['emp-812', 'EMP-811', 'EMP-812'], 'visit-key-c004');
    expect(((await row(String(order.job_number))).crew as R[]).map((c) => [c.code, c.crew_role])).toEqual([['EMP-812', 'LEADING_HAND'], ['EMP-811', 'CREW']]);
  });

  it('the crew moves a visit on (start, weather delay, complete); a planner reschedules or cancels; stale screens and wrong people are refused', async () => {
    const prj = await projectIn('IN_PROGRESS');
    const job = String((await schedule(tok.planner!, prj, at(5, 7), at(5, 15), ['EMP-811'], 'visit-key-u001')).job_number);
    expect(await visit(tok.crew2!, job, 'start', 1)).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });         // not on this crew
    expect(await visit(tok.estimator!, job, 'start', 1)).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    expect(await visit(tok.crew1!, job, 'complete', 1)).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });       // start it first
    expect(await visit(tok.crew1!, job, 'cancel', 1, 'Not needed any more')).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    expect(await visit(tok.crew1!, job, 'start', 1)).toMatchObject({ ok: true, status: 'IN_PROGRESS', record_version: 2 });
    expect(await visit(tok.crew1!, job, 'start', 1)).toMatchObject({ ok: false, code: 'STALE' });                       // a second tap from an old screen
    expect(await visit(tok.crew1!, job, 'weather_delay', 2)).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(await visit(tok.crew1!, job, 'weather_delay', 2, 'Heavy rain from 10am, roof too slippery')).toMatchObject({ ok: true, status: 'WEATHER_DELAYED' });
    expect(await one(`select n.note_type, e.employee_code from site_notes n join employees e on e.id = n.author_id where n.job_id = (select id from jobs where job_number = $1)`, [job]))
      .toEqual({ note_type: 'WEATHER', employee_code: 'EMP-811' });
    expect(await visit(tok.crew1!, job, 'reschedule', 3, null, at(6, 7), at(6, 15))).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    expect(await visit(tok.planner!, job, 'reschedule', 3, null, at(6, 15), at(6, 7))).toMatchObject({ ok: false, code: 'INVALID_TIMES' });
    expect(await visit(tok.planner!, job, 'reschedule', 3, 'Next dry day', at(6, 7), at(6, 15))).toMatchObject({ ok: true, status: 'SCHEDULED', record_version: 4 });
    expect(await one('select actual_start from jobs where job_number = $1', [job])).toEqual({ actual_start: null });
    expect(await visit(tok.crew1!, job, 'start', 4)).toMatchObject({ ok: true, status: 'IN_PROGRESS' });
    expect(await visit(tok.crew1!, job, 'complete', 5, 'Sheets fixed, site cleaned')).toMatchObject({ ok: true, status: 'COMPLETED', record_version: 6 });
    expect(await one('select actual_end is not null done from jobs where job_number = $1', [job])).toEqual({ done: true });
    expect(await visit(tok.planner!, job, 'cancel', 6, 'Too late')).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    expect((await db.query(`select action from audit_events where entity_id = (select id from jobs where job_number = $1) order by occurred_at, action`, [job])).map((a) => a.action))
      .toEqual(['job.scheduled', 'job.start', 'job.weather_delay', 'job.reschedule', 'job.start', 'job.complete']);
    // A rescheduled visit is checked for double-booking too.
    const other = String((await schedule(tok.planner!, prj, at(7, 7), at(7, 12), ['EMP-812'], 'visit-key-u002')).job_number);
    const mine = String((await schedule(tok.planner!, prj, at(8, 7), at(8, 12), ['EMP-812'], 'visit-key-u003')).job_number);
    expect(await visit(tok.planner!, mine, 'reschedule', 1, null, at(7, 9), at(7, 11))).toMatchObject({ ok: false, code: 'CREW_CONFLICT', conflict: { job_number: other } });
  });

  it('tasks: a manager creates one (repeat submits and duplicates refused); the assignee starts and finishes it; a manager reassigns, re-dates and cancels; done and cancelled are final', async () => {
    const prj = await projectIn('MATERIALS_PENDING');
    const r = await createTask(tok.planner!, { project: prj, type: 'SUPPLIER_FOLLOW_UP', title: '  Chase  the ridge capping delivery ', assignee: 'EMP-811', due: today, key: 'task-key-0001' });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, status: 'OPEN', record_version: 1 });
    const n = String(r.task_number);
    expect(n).toMatch(/^TASK-\d{4}$/);
    expect(await createTask(tok.planner!, { project: prj, key: 'task-key-0001' })).toEqual({ ok: true, duplicate: true, task_number: n });
    expect(await createTask(tok.planner!, { project: prj, title: 'chase the ridge capping delivery', key: 'task-key-0002' })).toMatchObject({ ok: false, code: 'DUPLICATE_OPEN_TASK' });
    expect(await one('select title, assignee_code, overdue from v_dashboard_tasks where task_number = $1', [n])).toEqual({ title: 'Chase the ridge capping delivery', assignee_code: 'EMP-811', overdue: false });
    for (const [o, code] of [[{ title: 'ab' }, 'INVALID'], [{ type: 'NAP' }, 'INVALID'], [{ assignee: 'EMP-813' }, 'ASSIGNEE_UNKNOWN'],
      [{ due: '2000-01-01' }, 'IN_PAST'], [{ project: cancelled }, 'PROJECT_CLOSED']] as const) {
      expect(await createTask(tok.planner!, { project: prj, ...o, title: 'title' in o ? o.title : `Another task ${code}`, key: `task-key-x-${code}-${Object.keys(o)[0]}` })).toMatchObject({ ok: false, code });
    }
    expect(await createTask(tok.estimator!, { key: 'task-key-0003' })).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    expect(await createTask(tok.crew1!, { key: 'task-key-0004' })).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });

    expect(await task(tok.crew2!, n, 'start', 1)).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });   // not theirs
    expect(await task(tok.crew1!, n, 'start', 1)).toMatchObject({ ok: true, status: 'IN_PROGRESS' });
    expect(await task(tok.crew1!, n, 'reassign', 2, { assignee: 'EMP-812' })).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    expect(await task(tok.planner!, n, 'reassign', 2, { assignee: 'EMP-812' })).toMatchObject({ ok: true, record_version: 3 });
    expect(await task(tok.crew1!, n, 'done', 3)).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });   // no longer theirs
    expect(await task(tok.planner!, n, 'due', 3, { due: '2000-01-01' })).toMatchObject({ ok: false, code: 'IN_PAST' });
    expect(await task(tok.planner!, n, 'cancel', 3)).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(await task(tok.crew2!, n, 'done', 2)).toMatchObject({ ok: false, code: 'STALE' });
    expect(await task(tok.crew2!, n, 'done', 3, { note: 'Supplier confirmed Thursday' })).toMatchObject({ ok: true, status: 'DONE' });
    expect(await one(`select t.completed_at is not null done, e.employee_code by from tasks t join employees e on e.id = t.completed_by where t.task_number = $1`, [n])).toEqual({ done: true, by: 'EMP-812' });
    expect(await task(tok.planner!, n, 'cancel', 4, { note: 'Order cancelled by the customer' })).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });   // done is final
    const second = String((await createTask(tok.planner!, { project: prj, title: 'Book the crane', assignee: 'EMP-811', key: 'task-key-0006' })).task_number);
    expect(await task(tok.planner!, second, 'cancel', 1, { note: 'Order cancelled by the customer' })).toMatchObject({ ok: true, status: 'CANCELLED' });
    expect(await task(tok.crew1!, second, 'start', 2)).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    expect((await db.query(`select action, actor_id from audit_events where entity_id = (select id from tasks where task_number = $1) order by occurred_at, action`, [n])).map((a) => `${String(a.action)}:${String(a.actor_id)}`))
      .toEqual(['task.created:EMP-810', 'task.start:EMP-811', 'task.reassign:EMP-810', 'task.done:EMP-812']);
    // A task without a project is fine (office work), and an overdue one is flagged once the business date passes its due date.
    const loose = await createTask(tok.planner!, { title: 'Renew the scaffold licence', assignee: 'EMP-810', due: today, key: 'task-key-0005' });
    expect(loose).toMatchObject({ ok: true });
    await db.query(`update tasks set due_on = app_today() - 1 where task_number = $1`, [loose.task_number]);
    expect(await one('select project_number, overdue from v_dashboard_tasks where task_number = $1', [loose.task_number])).toEqual({ project_number: null, overdue: true });
  });
});

/** Real concurrency: two planners at the same instant, on separate connections. */
describe.runIf(TARGETS.includes('postgres'))('site visits under real concurrency [postgres]', () => {
  let db: Db & { url?: string };
  const tok: Record<string, string> = {};
  beforeAll(async () => {
    db = await migratedDb('postgres');
    await setup(db, tok);
    await db.query(`insert into employees (employee_code, full_name, email, role, is_active) values ('EMP-814', 'Synthetic Second Planner', 'p2@example.test', 'PROJECT_MANAGER', true)`);
    await db.query('select ops_staff_set_password($1, $2, $3)', ['EMP-814', 'planner2', PW]);
    tok.planner2 = String((await db.query<{ r: R }>('select web_staff_sign_in($1, $2) r', ['planner2', PW]))[0]!.r.token);
  }, 180_000);
  afterAll(async () => { await db?.close(); });

  it('two planners booking the same roofer into overlapping visits at once: exactly one visit is created', async () => {
    const today = String((await db.query<R>('select app_today()::text d'))[0]!.d);
    const day = new Date(Date.parse(`${today}T00:00:00Z`) + 9 * 86_400_000).toISOString().slice(0, 10);
    const prj = String((await db.query<R>(`select project_number from projects where status = 'SCHEDULED' order by project_number limit 1`))[0]!.project_number);
    const [a, b] = [await openPostgres(db.url!), await openPostgres(db.url!)];
    try {
      const sql = 'select web_visit_schedule($1, $2, $3, $4, $5, $6, null, null, $7) r';
      const res = await Promise.all([
        a.query<{ r: R }>(sql, [tok.planner, prj, 'INSTALL', `${day}T07:00:00+10:00`, `${day}T12:00:00+10:00`, ['EMP-812'], 'race-key-0001']),
        b.query<{ r: R }>(sql, [tok.planner2, prj, 'REPAIR', `${day}T10:00:00+10:00`, `${day}T14:00:00+10:00`, ['EMP-812'], 'race-key-0002'])]);
      const out = res.map((x) => x[0]!.r);
      expect(out.filter((r) => r.ok)).toHaveLength(1);
      expect(out.filter((r) => r.code === 'CREW_CONFLICT')).toHaveLength(1);
      expect((await db.query<R>(`select count(*)::int n from jobs where request_key like 'race-key-%'`))[0]).toEqual({ n: 1 });
    } finally { await a.close(); await b.close(); }
  });
});
