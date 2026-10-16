import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * OPS-01 in a real browser, LOCAL rehearsal database only (scripts/pilot-rehearsal.ts --reset, then the pilot server).
 * Opt-in: E2E_PILOT=1. A planner (synthetic Admin) books a site visit with crew; the synthetic Roofer runs it from My work;
 * tasks are created, worked and finished; refusals, stale screens, an ended session and a failed write are shown honestly.
 */
const enabled = process.env.E2E_PILOT === '1';
const env = enabled ? parseEnv(readFileSync('e2e/.auth/pilot.env', 'utf8')) : {};
test.describe.configure({ mode: 'serial' });
test.skip(!enabled, 'opt-in: E2E_PILOT=1 against the local pilot rehearsal server');
test.use({ storageState: { cookies: [], origins: [] } });

type R = Record<string, unknown>;
let db: pg.Client;
let tomorrow = '';
const P = 'PRJ-2026-0011';   // SCHEDULED in the synthetic data, planned start already passed, supplier not confirmed
test.beforeAll(async ({ baseURL }) => {
  const url = new URL(env.PILOT_DB_URL ?? '');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/roofops_pilot') throw new Error('local roofops_pilot only');
  if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL ?? '').hostname)) throw new Error('local server only');
  db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  tomorrow = String((await db.query(`select (app_today() + 1)::text d`)).rows[0].d);
});
test.afterAll(() => db?.end());
const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0] as R;

async function signIn(browser: Browser, who: 'ADMIN' | 'CREW' | 'EST', baseURL: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Username').fill(env[`PILOT_${who}_LOGIN`] ?? '');
  await page.getByLabel('Password').fill(env[`PILOT_${who}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  return { ctx, page };
}
const visitsCard = (page: Page) => page.getByRole('region', { name: 'Site visits' });
const tasksCard = (page: Page) => page.getByRole('region', { name: 'Tasks' });

async function bookVisit(page: Page, o: { start: string; end: string; crew: string[]; note?: string; double?: boolean }) {
  const form = page.getByRole('form', { name: `Schedule a site visit for ${P}` });
  if (!(await form.isVisible())) await visitsCard(page).getByText('Schedule a site visit').click();
  await form.getByLabel('Start').fill(o.start);
  await form.getByLabel('End').fill(o.end);
  for (const c of o.crew) await form.getByRole('checkbox', { name: c }).check();
  await form.getByLabel(/^Leading hand/).selectOption({ label: o.crew.includes('Synthetic Roofer') ? 'Synthetic Roofer' : o.crew[0]! });
  if (o.note) await form.getByLabel('Note for the crew (optional)').fill(o.note);
  const btn = form.getByRole('button', { name: 'Schedule visit' });
  if (o.double) await btn.dblclick(); else await btn.click();
  return form;
}

test('site visit: a planner books the crew (a double click books once, a clash is refused and named); the roofer starts, is delayed, the planner reschedules, the roofer completes', async ({ browser, baseURL }) => {
  const admin = await signIn(browser, 'ADMIN', baseURL!);
  await admin.page.goto(`/projects/${P}`);
  const steps = admin.page.getByRole('region', { name: 'Next steps' });
  await expect(steps).toContainText('The planned start has passed');
  await expect(steps).toContainText('The supplier has not confirmed the order');
  await expect(steps).toContainText('Schedule the first site visit');

  const form = await bookVisit(admin.page, { start: `${tomorrow}T07:00`, end: `${tomorrow}T15:00`, crew: ['Synthetic Roofer', 'Synthetic Admin Approver'], note: 'Gate code 4512', double: true });
  await expect(form.getByRole('status')).toContainText(/JOB-\d{4}-\d{4} scheduled/);
  const job = String((await one(`select j.job_number from jobs j join projects p on p.id = j.project_id where p.project_number = $1`, [P])).job_number);
  expect(await one(`select count(*)::int n from jobs j join projects p on p.id = j.project_id where p.project_number = $1`, [P])).toEqual({ n: 1 });
  expect((await db.query(`select e.employee_code, a.crew_role from job_assignments a join employees e on e.id = a.employee_id join jobs j on j.id = a.job_id where j.job_number = $1 order by 1`, [job])).rows)
    .toEqual([{ employee_code: 'EMP-802', crew_role: 'CREW' }, { employee_code: 'EMP-804', crew_role: 'LEADING_HAND' }]);
  await admin.page.reload();
  const row = visitsCard(admin.page).locator(`[data-visit="${job}"]`);
  await expect(row).toContainText('Scheduled');
  await expect(row).toContainText('Synthetic Roofer (leading hand)');
  await expect(row).toContainText('Gate code 4512');
  await expect(steps).toContainText(`${job} on`);

  // The same roofer cannot be in two places: refused, named, nothing created.
  const clash = await bookVisit(admin.page, { start: `${tomorrow}T13:00`, end: `${tomorrow}T17:00`, crew: ['Synthetic Roofer'] });
  await expect(clash.getByRole('alert')).toContainText(`Synthetic Roofer is already on ${job}`);
  await expect(clash.getByRole('checkbox', { name: 'Synthetic Roofer' })).toBeChecked();   // a refusal keeps what was entered (React would reset the form)
  await expect(clash.getByLabel('Start')).toHaveValue(`${tomorrow}T13:00`);
  await clash.getByRole('checkbox', { name: 'Synthetic Roofer' }).uncheck();
  expect(await one(`select count(*)::int n from jobs j join projects p on p.id = j.project_id where p.project_number = $1`, [P])).toEqual({ n: 1 });

  // An estimator sees the visit but cannot book or move it.
  const est = await signIn(browser, 'EST', baseURL!);
  await est.page.goto(`/projects/${P}`);
  await expect(visitsCard(est.page).getByText('Schedule a site visit')).toHaveCount(0);
  await expect(visitsCard(est.page).locator(`[data-visit="${job}"]`).getByRole('button')).toHaveCount(0);

  // The roofer runs it from My work.
  const crew = await signIn(browser, 'CREW', baseURL!);
  await crew.page.goto('/work');
  const mine = crew.page.getByRole('region', { name: 'My site visits' }).locator(`[data-visit="${job}"]`);
  await expect(mine).toContainText('Gate code 4512');
  await expect(mine.getByRole('button', { name: 'Reschedule…' })).toHaveCount(0);   // planners only
  const adminStale = admin.page;   // still showing version 1
  await mine.getByRole('button', { name: 'Start visit' }).click();
  await expect(mine).toContainText('On site');
  await expect(mine.getByRole('status')).toContainText(`${job} started`);

  // A stale screen is refused, not applied.
  await adminStale.locator(`[data-visit="${job}"]`).getByRole('button', { name: 'Weather delay…' }).click();
  await adminStale.locator(`[data-visit="${job}"]`).getByLabel('Why (required)').fill('Storm warning issued');
  await adminStale.locator(`[data-visit="${job}"]`).getByRole('button', { name: 'Mark weather delayed' }).click();
  await expect(adminStale.locator(`[data-visit="${job}"]`).getByRole('alert')).toContainText('Someone changed this since you opened the page');
  expect(await one('select status from jobs where job_number = $1', [job])).toEqual({ status: 'IN_PROGRESS' });

  await mine.getByRole('button', { name: 'Weather delay…' }).click();
  await mine.getByLabel('Why (required)').fill('Heavy rain from 10am, roof too slippery');
  await mine.getByRole('button', { name: 'Mark weather delayed' }).click();
  await expect(mine).toContainText('Weather delayed');
  expect(await one(`select n.note_type, n.body from site_notes n join jobs j on j.id = n.job_id where j.job_number = $1`, [job]))
    .toEqual({ note_type: 'WEATHER', body: 'Heavy rain from 10am, roof too slippery' });

  await admin.page.reload();
  await expect(steps).toContainText(`Reschedule ${job} (weather delayed)`);
  const arow = visitsCard(admin.page).locator(`[data-visit="${job}"]`);
  await arow.getByRole('button', { name: 'Reschedule…' }).click();
  const day2 = String((await one(`select (app_today() + 2)::text d`)).d);
  await arow.getByLabel('New start').fill(`${day2}T07:00`);
  await arow.getByLabel('New end').fill(`${day2}T15:00`);
  await arow.getByRole('button', { name: 'Save new times' }).click();
  await expect(arow).toContainText('Scheduled');
  await expect(arow.getByRole('status')).toContainText(`${job} rescheduled`);

  await crew.page.reload();
  await mine.getByRole('button', { name: 'Start visit' }).click();
  await expect(mine).toContainText('On site');
  await mine.getByRole('button', { name: 'Complete…' }).click();
  await mine.getByLabel('What was done (optional, kept as a site note)').fill('Valley flashing replaced, site cleaned');
  await mine.getByRole('button', { name: 'Complete visit' }).click();
  await expect(crew.page.getByRole('region', { name: 'My site visits' })).not.toContainText(job);   // only live visits are "mine"
  expect(await one('select status, actual_end is not null finished from jobs where job_number = $1', [job])).toEqual({ status: 'COMPLETED', finished: true });
  expect((await db.query(`select action, actor_id from audit_events where entity_id = (select id from jobs where job_number = $1) order by occurred_at, action`, [job])).rows.map((a) => `${String(a.action)}:${String(a.actor_id)}`))
    .toEqual(['job.scheduled:EMP-802', 'job.start:EMP-804', 'job.weather_delay:EMP-804', 'job.reschedule:EMP-802', 'job.start:EMP-804', 'job.complete:EMP-804']);
  await admin.page.goto(`/projects/${P}`);
  await expect(visitsCard(admin.page).locator(`[data-visit="${job}"]`)).toContainText('Done: Valley flashing replaced, site cleaned');

  // An ended session cannot act, even on a screen that was valid a moment ago.
  await crew.page.goto('/work');
  const later = await bookVisit(admin.page, { start: `${day2}T16:00`, end: `${day2}T18:00`, crew: ['Synthetic Roofer'] });
  await expect(later.getByRole('status')).toContainText('scheduled');
  await crew.page.reload();
  await db.query(`update staff_sessions set expires_at = now() - interval '1 second' where employee_id = (select id from employees where employee_code = 'EMP-804') and revoked_at is null`);
  const second = crew.page.getByRole('region', { name: 'My site visits' }).locator('[data-visit]').first();
  await second.getByRole('button', { name: 'Start visit' }).click();
  await expect(second.getByRole('alert')).toContainText('Your sign-in has ended');
  for (const c of [admin.ctx, est.ctx, crew.ctx]) await c.close();
});

test('tasks: a manager adds one for the roofer (a double click adds once, a duplicate is refused); the roofer starts and finishes it; overdue work leads Next steps; a failed write never claims success and a retry adds it once', async ({ browser, baseURL }) => {
  const admin = await signIn(browser, 'ADMIN', baseURL!);
  await admin.page.goto(`/projects/${P}`);
  await tasksCard(admin.page).getByText('Add a task').click();
  const form = admin.page.getByRole('form', { name: `Add a task to ${P}` });
  await form.getByLabel('What needs doing').fill('Chase the supplier confirmation');
  await form.getByLabel('Kind').selectOption('SUPPLIER_FOLLOW_UP');
  await form.getByLabel('Due (optional)').fill(tomorrow);
  await form.getByLabel('Who does it (optional)').selectOption({ label: 'Synthetic Roofer' });
  await form.getByRole('button', { name: 'Add task' }).dblclick();
  await expect(form.getByRole('status')).toContainText(/TASK-\d{4} created/);
  expect(await one(`select count(*)::int n from tasks t join projects p on p.id = t.project_id where p.project_number = $1 and t.title = 'Chase the supplier confirmation'`, [P])).toEqual({ n: 1 });
  const task = String((await one(`select task_number from tasks where title = 'Chase the supplier confirmation'`)).task_number);

  await form.getByLabel('What needs doing').fill('chase the supplier confirmation');
  await form.getByRole('button', { name: 'Add task' }).click();
  await expect(form.getByRole('alert')).toContainText('That task already exists');
  await expect(form.getByLabel('What needs doing')).toHaveValue('chase the supplier confirmation');   // kept after a refusal

  // A failed write (the database refuses the call) is not reported as done; once it works, the same form adds the task once.
  await db.query('revoke execute on function web_task_create(text, text, text, text, text, date, text, text) from roofops_dashboard');
  try {
    await form.getByLabel('What needs doing').fill('Order the replacement ridge cap');
    await form.getByRole('button', { name: 'Add task' }).click();
    await expect(form.getByRole('alert')).toContainText('Could not confirm the result');
    expect(await one(`select count(*)::int n from tasks where title = 'Order the replacement ridge cap'`)).toEqual({ n: 0 });
  } finally {
    await db.query('grant execute on function web_task_create(text, text, text, text, text, date, text, text) to roofops_dashboard');
  }
  await form.getByRole('button', { name: 'Add task' }).click();
  await expect(form.getByRole('status')).toContainText('created');
  await form.getByRole('button', { name: 'Add task' }).click();   // the success reset the form: an empty title is refused in the browser, nothing is sent
  expect(await one(`select count(*)::int n from tasks where title = 'Order the replacement ridge cap'`)).toEqual({ n: 1 });

  const est = await signIn(browser, 'EST', baseURL!);
  await est.page.goto(`/projects/${P}`);
  await expect(tasksCard(est.page).getByText('Add a task')).toHaveCount(0);
  await expect(tasksCard(est.page).locator(`[data-task="${task}"]`).getByRole('button')).toHaveCount(0);

  const crew = await signIn(browser, 'CREW', baseURL!);
  await crew.page.goto('/work');
  const mine = crew.page.getByRole('region', { name: 'My tasks' }).locator(`[data-task="${task}"]`);
  await expect(mine).toContainText('Supplier follow-up');
  await expect(mine.getByRole('button', { name: 'Reassign…' })).toHaveCount(0);
  await mine.getByRole('button', { name: 'Start' }).click();
  await expect(mine).toContainText('In progress');

  // Overdue: once the business date passes the due date, it leads the project's next steps.
  await db.query(`update tasks set due_on = app_today() - 1 where task_number = $1`, [task]);
  await admin.page.reload();
  await expect(admin.page.getByRole('region', { name: 'Next steps' }).locator('li').first()).toContainText('Overdue task: Chase the supplier confirmation');
  await expect(tasksCard(admin.page).locator(`[data-task="${task}"]`)).toContainText('Overdue');

  await crew.page.reload();
  await mine.getByRole('button', { name: 'Mark done' }).click();
  await expect(crew.page.getByRole('region', { name: 'My tasks' })).not.toContainText('Chase the supplier confirmation');
  expect(await one(`select t.status, e.employee_code from tasks t join employees e on e.id = t.completed_by where t.task_number = $1`, [task])).toEqual({ status: 'DONE', employee_code: 'EMP-804' });
  await admin.page.reload();
  await expect(admin.page.getByRole('region', { name: 'Next steps' })).not.toContainText('Chase the supplier confirmation');
  expect((await db.query(`select action, actor_id from audit_events where entity_id = (select id from tasks where task_number = $1) order by occurred_at, action`, [task])).rows.map((a) => `${String(a.action)}:${String(a.actor_id)}`))
    .toEqual(['task.created:EMP-802', 'task.start:EMP-804', 'task.done:EMP-804']);
  for (const c of [admin.ctx, est.ctx, crew.ctx]) await c.close();
});
