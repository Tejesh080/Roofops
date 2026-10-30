import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * One synthetic roofing job from accepted quote to "ready to invoice", LOCAL rehearsal database only. Opt-in: E2E_PILOT=1.
 *
 * Real: every database function and the dashboard (staff sign-in, site visits, tasks, next steps, finance readiness).
 * Simulated at the boundary (nothing leaves this machine):
 *   - Airtable: the quote acceptance and the office's Airtable edits (project status, completion items) are delivered as
 *     the exact events n8n 01 / 06 hand to wf_quote_accepted / wf_airtable_change, run as the workflow role;
 *   - the project's Airtable record link is recorded as n8n 03's verified write-back would record it;
 *   - no Drive folder is created (02 is not run); no invoice is prepared (that path has its own journeys).
 */
const enabled = process.env.E2E_PILOT === '1';
const env = enabled ? parseEnv(readFileSync('e2e/.auth/pilot.env', 'utf8')) : {};
test.describe.configure({ mode: 'serial' });
test.skip(!enabled, 'opt-in: E2E_PILOT=1 against the local pilot rehearsal server');
test.use({ storageState: { cookies: [], origins: [] } });

type R = Record<string, unknown>;
const APPROVER = 'usr7uCnNO15fCefbH';   // the office's Airtable user, mapped to EMP-900
const F = { status: 'fldi2Qwz1dAh2tcTE', start: 'fld8rf6RZLgfs6Ron', end: 'fldvZtiassZEgLMAN', photos: 'fldbbksVL3dT6cqyS', photosNote: 'fldA77ad94yUmvnu3',
  cert: 'fldf7iJiyHFxOQgUy', certNote: 'fldLi9FkGDFAbf0QB', swms: 'fldM6kgPz6QZagPAC', materials: 'fldozWSCU877wEZHq',
  actualStart: 'fldIje5e0a72cBfVD' };   // owned by RoofOps: an edit in Airtable is put back
const REC = 'recJOURNEYQ004100';
let db: pg.Client;
let seq = 0;
test.beforeAll(async ({ baseURL }) => {
  const url = new URL(env.PILOT_DB_URL ?? '');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/roofops_pilot') throw new Error('local roofops_pilot only');
  if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL ?? '').hostname)) throw new Error('local server only');
  db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
});
test.afterAll(() => db?.end());
const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0] as R;
async function asWorkflow(fn: string, arg: R, extra: string | null = null): Promise<R> {
  await db.query('set role roofops_workflow');
  try { return (await one(`select ${fn}($1::jsonb${extra ? ', $2' : ''}) r`, extra ? [JSON.stringify(arg), extra] : [JSON.stringify(arg)])).r as R; }
  finally { await db.query('reset role'); }
}
/** An Airtable Projects edit by the office, exactly as n8n 06 delivers it. */
const airtable = (fields: R, current: R = {}) => {
  seq += 1;
  return asWorkflow('wf_airtable_change', { event_id: `airtable:achJOURNEY:txn${seq}:${REC}`, source: 'airtable', actor_id: APPROVER,
    occurred_at: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString(), table_id: 'tblvUPIoebC3zoacv', record_id: REC,
    changes: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { current: v }])), current: { ...current, ...fields } }, 'n8n:06:journey');
};

async function signIn(browser: Browser, who: 'ADMIN' | 'CREW' | 'FIN', baseURL: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Username').fill(env[`PILOT_${who}_LOGIN`] ?? '');
  await page.getByLabel('Password').fill(env[`PILOT_${who}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  return { ctx, page };
}
const steps = (page: Page) => page.getByRole('region', { name: 'Next steps' });
const firstStep = (page: Page) => steps(page).locator('li').first();

test('accepted quote → one project → visit booked and worked → In Progress → Completed → completion items closed with reasons → ready to invoice', async ({ browser, baseURL }) => {
  // 1. The customer accepts quote Q-2026-0041 (Airtable → n8n 01 → wf_quote_accepted): exactly one project, even redelivered.
  const event = { event_id: 'EVT-JOURNEY-Q41', correlation_id: 'CORR-JOURNEY-Q41', event_type: 'quote.accepted', source: 'airtable', actor_id: 'airtable-automation',
    occurred_at: new Date().toISOString(), payload: { quote_id: 'Q-2026-0041', accepted_version: 1, accepted_on: '2026-09-29', airtable_record_id: 'recJOURNEYQUOTE41' } };
  const created = await asWorkflow('wf_quote_accepted', event);
  expect(created).toMatchObject({ status: 'CREATED' });
  const P = String(created.project_number);
  expect(await asWorkflow('wf_quote_accepted', event)).toMatchObject({ project_number: P });
  expect(await one(`select count(*)::int n from projects p join quotes q on q.id = p.quote_id where q.quote_number = 'Q-2026-0041'`)).toEqual({ n: 1 });
  expect(await one(`select c.display_name, p.status from projects p join customers c on c.id = p.customer_id where p.project_number = $1`, [P])).toEqual({ display_name: 'Oliver Grant', status: 'PLANNING' });
  await db.query(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                  select 'AIRTABLE', 'project', id, 'Record', $2, now(), now() from projects where project_number = $1`, [P, REC]);

  // 2. The office plans it in Airtable (dates), a planner sees what is next and books the crew here.
  expect(await airtable({ [F.start]: '2026-09-30', [F.end]: '2026-10-02' })).toMatchObject({ outcome: 'APPLIED' });
  const admin = await signIn(browser, 'ADMIN', baseURL!);
  await admin.page.goto(`/projects/${P}`);
  await expect(admin.page.getByRole('heading', { level: 1 })).toContainText(P);
  await expect(steps(admin.page)).toContainText('Schedule the first site visit');
  const day = String((await one(`select (app_today() + 1)::text d`)).d);
  await admin.page.getByRole('region', { name: 'Site visits' }).getByText('Schedule a site visit').click();
  const form = admin.page.getByRole('form', { name: `Schedule a site visit for ${P}` });
  await form.getByLabel('Kind of visit').selectOption('REPAIR');
  await form.getByLabel('Start').fill(`${day}T07:00`);
  await form.getByLabel('End').fill(`${day}T15:30`);
  await form.getByRole('checkbox', { name: 'Synthetic Roofer' }).check();
  await form.getByRole('button', { name: 'Schedule visit' }).click();
  await expect(form.getByRole('status')).toContainText('scheduled');
  const job = String((await one(`select j.job_number from jobs j join projects p on p.id = j.project_id where p.project_number = $1`, [P])).job_number);
  await admin.page.reload();
  await expect(firstStep(admin.page)).toContainText(`${job} on`);

  // A task for the office: confirm the access with the customer.
  await admin.page.getByRole('region', { name: 'Tasks' }).getByText('Add a task').click();
  const tf = admin.page.getByRole('form', { name: `Add a task to ${P}` });
  await tf.getByLabel('What needs doing').fill('Confirm side-gate access with the customer');
  await tf.getByLabel('Kind').selectOption('CUSTOMER_FOLLOW_UP');
  await tf.getByLabel('Who does it (optional)').selectOption({ label: 'Synthetic Admin Approver' });
  await tf.getByRole('button', { name: 'Add task' }).click();
  await expect(tf.getByRole('status')).toContainText('created');

  // 3. On the day: the office moves the project to Scheduled then In Progress in Airtable; the roofer works the visit.
  //    The pre-start gate (AC-13B) holds the start until the SWMS is signed and the materials are reviewed.
  expect(await airtable({ [F.status]: 'Scheduled' })).toMatchObject({ outcome: 'APPLIED' });
  expect(await airtable({ [F.status]: 'In Progress' })).toMatchObject({ outcome: 'REJECTED' });
  expect(await airtable({ [F.swms]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
  expect(await airtable({ [F.materials]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
  expect(await airtable({ [F.status]: 'In Progress' })).toMatchObject({ outcome: 'APPLIED' });
  const crew = await signIn(browser, 'CREW', baseURL!);
  await crew.page.goto('/work');
  const v = crew.page.getByRole('region', { name: 'My site visits' }).locator(`[data-visit="${job}"]`);
  await v.getByRole('button', { name: 'Start visit' }).click();
  await expect(v).toContainText('On site');
  await admin.page.reload();
  await expect(firstStep(admin.page)).toContainText(`Crew on site: ${job}`);
  await v.getByRole('button', { name: 'Complete…' }).click();
  await v.getByLabel('What was done (optional, kept as a site note)').fill('Cracked tiles replaced, ridge re-pointed; photos taken on the crew phone');
  await v.getByRole('button', { name: 'Complete visit' }).click();
  await expect(crew.page.getByRole('region', { name: 'My site visits' })).not.toContainText(job);

  // The office task is done.
  const task = String((await one(`select task_number from tasks where title = 'Confirm side-gate access with the customer'`)).task_number);
  await admin.page.reload();
  await admin.page.getByRole('region', { name: 'Tasks' }).locator(`[data-task="${task}"]`).getByRole('button', { name: 'Mark done' }).click();
  await expect(admin.page.getByRole('region', { name: 'Tasks' }).locator(`[data-task="${task}"]`)).toContainText('Done');   // now under "done or cancelled"
  // The material review quote acceptance created (wf_quote_accepted) is a task like any other: the office finishes it here.
  const review = String((await one(`select t.task_number from tasks t join projects p on p.id = t.project_id where p.project_number = $1 and t.task_type = 'MATERIAL_REVIEW'`, [P])).task_number);
  await admin.page.getByRole('region', { name: 'Tasks' }).locator(`[data-task="${review}"]`).getByRole('button', { name: 'Mark done' }).click();
  await expect(admin.page.getByRole('region', { name: 'Tasks' }).getByText('0 open')).toBeVisible();
  expect(await one(`select status from v_dashboard_project_checklist where project_number = $1 and title = 'Materials reviewed and approved'`, [P])).toEqual({ status: 'DONE' });   // follows its review task

  // 4. Work finished: Next steps says to set Completed in Airtable; the office does; completion items are now the blocker.
  await admin.page.reload();
  // A completed visit is not a completed project: the first step says so and where the project is completed.
  await expect(firstStep(admin.page)).toContainText('is complete, but the project is still In progress');
  await expect(firstStep(admin.page)).toContainText('Completing a visit does not complete the project');
  expect(await airtable({ [F.status]: 'Completed' })).toMatchObject({ outcome: 'APPLIED' });
  await admin.page.reload();
  await expect(firstStep(admin.page)).toContainText('Completion item open');
  await expect(steps(admin.page)).toContainText('Completion Photos → Done once it is really there, or Waived / Not applicable');
  expect(await one(`select invoice_status from v_dashboard_projects where project_number = $1`, [P])).toEqual({ invoice_status: 'NOT_READY' });

  // 5. The office closes the completion items in Airtable, honestly: photos Waived and certificate Not applicable, each with
  //    its reason (a Waived without a reason is refused and corrected back).
  const noReason = await airtable({ [F.photos]: 'Waived' }, { [F.photosNote]: '' });
  expect(noReason).toMatchObject({ outcome: 'REJECTED' });
  expect(await airtable({ [F.photos]: 'Waived' }, { [F.photosNote]: 'Synthetic test job: photos exist only on the crew phone, not uploaded' })).toMatchObject({ outcome: 'APPLIED' });
  expect(await airtable({ [F.cert]: 'Not applicable' }, { [F.certNote]: 'Repair only: no compliance certificate for this work' })).toMatchObject({ outcome: 'APPLIED' });
  // Someone also types over a date RoofOps owns: it is put back, not applied.
  expect(await airtable({ [F.actualStart]: '2026-01-01' })).toMatchObject({ outcome: 'REVERTED' });
  expect((await db.query(`select ci.item_code, ci.status, ci.waived_reason is not null has_reason from project_checklist_items ci join projects p on p.id = ci.project_id
                          where p.project_number = $1 and ci.stage = 'COMPLETION' order by 1`, [P])).rows)
    .toEqual([{ item_code: 'COMPLETION_PHOTOS', status: 'WAIVED', has_reason: true }, { item_code: 'COMPLIANCE_CERTIFICATE', status: 'NOT_APPLICABLE', has_reason: true }]);

  // 6. Ready to invoice: Next steps points to Finance, and Finance offers Prepare for exactly this project.
  await admin.page.reload();
  await expect(firstStep(admin.page)).toContainText('Prepare the final invoice');
  expect(await one(`select invoice_status from v_dashboard_projects where project_number = $1`, [P])).toEqual({ invoice_status: 'READY_TO_INVOICE' });
  const fin = await signIn(browser, 'FIN', baseURL!);
  await fin.page.goto('/finance');
  await expect(fin.page.getByRole('button', { name: `Prepare invoice for ${P}` })).toBeVisible();

  // 7. The sync log (master plan Task 3.4, docs/editing-surfaces.md): the project's Automation history shows the office's
  //    Airtable edits, the refused ones flagged, and the edit RoofOps put back.
  await admin.page.goto(`/projects/${P}`);
  const history = admin.page.locator('#history');
  await history.getByRole('button', { name: /Show full history/ }).click();
  const entry = (note: string) => history.getByRole('listitem').filter({ hasText: note });
  for (const [note, state] of [
    ['✓ Status: Scheduled → In Progress applied', 'Completed'],
    ['✗ Status: "In Progress" not applied: pre-start items are still open', 'Needs attention or stopped safely'],
    ['✗ Completion Photos: "Waived" not applied: Waived needs a reason in Completion Photos Note', 'Needs attention or stopped safely'],
    ['↺ Actual Start is managed by RoofOps; "2026-01-01" was reverted to "2026-09-29".', 'Needs attention or stopped safely'],
  ] as const) {
    await expect(entry(note)).toHaveCount(1);
    await expect(entry(note)).toContainText('Change made in Airtable');
    await expect(entry(note)).toContainText(state);
  }

  // The whole job is on the project's audit trail, attributed.
  const actions = (await db.query(`select action, actor_id from audit_events where business_reference = $1 and action ~ '^(job|task|project\\.checklist)\\.' order by occurred_at, action`, [P])).rows
    .map((a) => `${String(a.action)}:${String(a.actor_id)}`);
  // The two pre-start sign-offs (SWMS, materials) come before the start; the two completion items at the end.
  expect(actions).toEqual(['task.create:quote_to_project@1', 'job.scheduled:EMP-802', 'task.created:EMP-802',
    `project.checklist.changed:${APPROVER}`, `project.checklist.changed:${APPROVER}`,
    'job.start:EMP-804', 'job.complete:EMP-804', 'task.done:EMP-802', 'task.done:EMP-802',
    `project.checklist.changed:${APPROVER}`, `project.checklist.changed:${APPROVER}`]);
  for (const c of [admin.ctx, crew.ctx, fin.ctx]) await c.close();
});
