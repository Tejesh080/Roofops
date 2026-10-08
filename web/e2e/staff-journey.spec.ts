import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expect, test, type APIResponse, type Browser, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * The supervised-pilot staff journey, end to end in a real browser, against the LOCAL rehearsal database only
 * (scripts/pilot-rehearsal.ts --reset, then `next start` with web/e2e/.auth/pilot.env). Opt-in: E2E_PILOT=1.
 *
 * Two synthetic people do a reissue: Finance requests, a different Admin approves; the requester cannot approve, a
 * restricted role and the shared demo viewer cannot request or approve, even by replaying the real server-action
 * request; duplicates and concurrent submits do it once; signed-out and expired sessions are refused. The database is
 * read after each step: exactly one generation-2 Xero write is queued per approved reissue. Nothing reaches Xero.
 */
const PILOT_ENV = 'e2e/.auth/pilot.env';
const enabled = process.env.E2E_PILOT === '1';
const env = enabled ? parseEnv(readFileSync(PILOT_ENV, 'utf8')) : {};
const login = (who: 'FIN' | 'ADMIN' | 'EST' | 'DEMO') => ({ user: env[`PILOT_${who}_LOGIN`] ?? '', password: env[`PILOT_${who}_PASSWORD`] ?? '' });

test.describe.configure({ mode: 'serial' });
test.skip(!enabled, 'opt-in: E2E_PILOT=1 against the local pilot rehearsal server');
test.use({ storageState: { cookies: [], origins: [] } });

let db: pg.Client;
test.beforeAll(({ baseURL }) => {
  const url = new URL(env.PILOT_DB_URL ?? '');
  const base = new URL(baseURL ?? '');
  // Refuse anything but the local rehearsal database and a local server.
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/roofops_pilot') throw new Error('PILOT_DB_URL must be the local roofops_pilot');
  if (!['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('the staff journey runs against a local server only');
  db = new pg.Client({ connectionString: url.toString() });
  return db.connect();
});
test.afterAll(() => db?.end());

const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0] as T;
const approvals = (invoice: string) => db.query(
  `select a.approval_number, a.status, re.employee_code requested_by, de.employee_code decided_by
     from approvals a left join employees re on re.id = a.requested_by_employee_id left join employees de on de.id = a.decided_by
    where a.action_type = 'REISSUE_INVOICE' and a.business_reference = $1 order by a.created_at`, [invoice]).then((r) => r.rows);
/** Generation-2 Xero writes of an invoice: the ledger row and every create-draft outbox write for it. */
const gen2 = async (invoice: string) => one<{ ledger: string; writes: string; pending: string }>(
  `select (select count(*) from invoice_xero_draft_generations g where g.invoice_id = i.id and g.generation = 2)::text ledger,
          (select count(*) from outbox o where o.topic = 'xero.create_draft_invoice' and o.aggregate_id = i.id and o.generation = 2)::text writes,
          (select count(*) from outbox o where o.topic = 'xero.create_draft_invoice' and o.aggregate_id = i.id and o.generation = 2 and o.status = 'PENDING')::text pending
     from invoices i where i.invoice_number = $1`, [invoice]);

async function signIn(browser: Browser, who: 'FIN' | 'ADMIN' | 'EST' | 'DEMO', baseURL: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  const { user, password } = login(who);
  await page.goto('/login');
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  return { ctx, page };
}

/** The last server-action request a page sent: replayed below with other cookies, values, origins and timing. */
interface Captured { url: string; action: string; contentType: string; body: string }
function recordActions(page: Page): () => Captured {
  let last: Captured | undefined;
  page.on('request', (r) => {
    const h = r.headers();
    if (r.method() === 'POST' && h['next-action']) last = { url: r.url(), action: h['next-action'], contentType: h['content-type'] ?? '', body: r.postData() ?? '' };
  });
  return () => { if (!last) throw new Error('no server action was sent'); return last; };
}
// The session cookie is Secure; Playwright's API client does not send it over local http by itself, so pass it explicitly.
const replay = async (ctx: BrowserContext, c: Captured, swap: [string, string][] = [], origin = new URL(c.url).origin): Promise<APIResponse> =>
  ctx.request.post(c.url, {
    headers: {
      'next-action': c.action, 'content-type': c.contentType, origin, accept: 'text/x-component',
      cookie: (await ctx.cookies()).map((k) => `${k.name}=${k.value}`).join('; '),
    },
    data: swap.reduce((b, [from, to]) => b.split(from).join(to), c.body),
    maxRedirects: 0,
  });

const reissues = (page: Page) => page.locator('#reissues');
const item = (page: Page, invoice: string) => reissues(page).locator('.issue', { hasText: invoice });

test('staff journey: Finance requests, the requester cannot approve, a different Admin approves; one generation-2 write', async ({ browser, baseURL }) => {
  const fin = await signIn(browser, 'FIN', baseURL!);
  await fin.page.getByRole('button', { name: /Synthetic/ }).click();
  await expect(fin.page.getByRole('menu')).toContainText('Synthetic Finance Requester');
  await expect(fin.page.getByRole('menu')).toContainText('Finance');
  await fin.page.keyboard.press('Escape');

  // 1. Finance requests the reissue of the voided INV-2026-0039 through the dashboard.
  await fin.page.goto('/finance#reissues');
  const finRequests = recordActions(fin.page);
  const inv39 = item(fin.page, 'INV-2026-0039');
  await expect(inv39).toContainText('Voided');
  await expect(inv39).toContainText('Deleted in Xero');
  await inv39.locator('textarea[name=reason]').fill('Synthetic pilot rehearsal: the draft was deleted in Xero by mistake');
  await inv39.getByRole('button', { name: 'Request reissue' }).click();
  await expect(inv39).toContainText('Awaiting approval');
  await expect(inv39).toContainText('You requested this. A second person (finance, admin) must approve it.');
  await expect(inv39).toContainText('Synthetic Finance Requester');
  await expect(inv39.getByRole('button', { name: /Approve reissue/ })).toHaveCount(0);
  const request = finRequests();
  const [pending] = await approvals('INV-2026-0039');
  expect(await approvals('INV-2026-0039')).toEqual([{ approval_number: pending!.approval_number, status: 'PENDING', requested_by: 'EMP-801', decided_by: null }]);
  const apr = String(pending!.approval_number);

  // 2. A repeat of the same request (a double submit) is refused: still one request.
  expect(await (await replay(fin.ctx, request)).text()).toContain('already waiting for approval');
  expect(await approvals('INV-2026-0039')).toHaveLength(1);
  // 3. The server checks the reason itself (the browser's minLength is bypassed here).
  expect(await (await replay(fin.ctx, request, [['INV-2026-0039', 'INV-2026-0040'], ['Synthetic pilot rehearsal: the draft was deleted in Xero by mistake', 'short']])).text())
    .toContain('at least 10 characters');
  // 4. A cross-site replay of the request (CSRF) is rejected before the action runs.
  const forged = await replay(fin.ctx, request, [['INV-2026-0039', 'INV-2026-0040']], 'https://attacker.example');
  expect(forged.status()).not.toBe(200);
  expect(await approvals('INV-2026-0040')).toHaveLength(0);

  // 5. The restricted role and the shared demo viewer see no controls, and replaying the real request is refused.
  const est = await signIn(browser, 'EST', baseURL!);
  await est.page.goto('/finance#reissues');
  await expect(item(est.page, 'INV-2026-0040')).toContainText('Eligible for a reissue. Someone in finance, admin can request it.');
  await expect(item(est.page, 'INV-2026-0039')).toContainText('Waiting for someone else (finance, admin) to approve it.');
  await expect(reissues(est.page).locator('textarea, button')).toHaveCount(0);
  expect(await (await replay(est.ctx, request, [['INV-2026-0039', 'INV-2026-0040']])).text()).toContain('Your role cannot request or approve a reissue.');
  const demo = await signIn(browser, 'DEMO', baseURL!);
  await demo.page.goto('/finance#reissues');
  await expect(reissues(demo.page)).toContainText('Sign in as yourself to see and act on invoice reissues');
  expect(await (await replay(demo.ctx, request, [['INV-2026-0039', 'INV-2026-0040']])).text()).toContain('the shared demo login cannot');
  expect(await approvals('INV-2026-0040')).toHaveLength(0);

  // 6. A different person (Admin) sees exactly what is approved. The server insists on the "I checked" box.
  const admin = await signIn(browser, 'ADMIN', baseURL!);
  await admin.page.goto('/finance#reissues');
  const adminApproves = recordActions(admin.page);
  const a39 = item(admin.page, 'INV-2026-0039');
  await expect(a39).toContainText('Awaiting approval');
  await expect(a39).toContainText('RO-INV-2026-0039');
  await expect(a39).toContainText('$30,886.06 inc GST');
  await expect(a39).toContainText('Oliver Grant');
  await expect(a39).toContainText(`Synthetic Finance Requester`);
  await expect(a39).toContainText(apr);
  await a39.locator('input[name=checked]').evaluate((el) => el.removeAttribute('required'));
  await a39.getByRole('button', { name: `Approve reissue ${apr}` }).click();
  await expect(a39.locator('[role=alert]')).toContainText('Confirm that you checked the draft');
  const approve = adminApproves();
  expect((await approvals('INV-2026-0039'))[0]!.status).toBe('PENDING');

  // 7. The requester, the restricted role and the demo viewer replay the approval with the box ticked: all refused.
  //    (The captured request has no "checked" field; add one next to the "approval" field, same encoding prefix.)
  const field = /name="([^"]*)approval"/.exec(approve.body);
  expect(field, 'approval request shape').not.toBeNull();
  expect(approve.body).not.toContain(`name="${field![1]}checked"`);
  const tick: [string, string][] = [[field![0],
    `name="${field![1]}checked"\r\n\r\non\r\n--${approve.contentType.split('boundary=')[1]}\r\nContent-Disposition: form-data; ${field![0]}`]];
  expect(await (await replay(fin.ctx, approve, tick)).text()).toContain('You asked for this reissue, so someone else must approve it.');
  expect(await (await replay(est.ctx, approve, tick)).text()).toContain('Your role cannot request or approve a reissue.');
  expect(await (await replay(demo.ctx, approve, tick)).text()).toContain('the shared demo login cannot');
  expect((await approvals('INV-2026-0039'))[0]!.status).toBe('PENDING');
  expect(await gen2('INV-2026-0039')).toEqual({ ledger: '0', writes: '0', pending: '0' });

  // 8. The Admin approves through the dashboard: exactly one generation-2 write is queued (nothing sent to Xero here).
  await a39.locator('input[name=checked]').check();
  await a39.locator('textarea[name=note]').fill('Synthetic rehearsal: number, amount and customer checked');
  await a39.getByRole('button', { name: `Approve reissue ${apr}` }).click();
  await expect(a39).toContainText('Approved, queued');
  await expect(a39).toContainText(`${apr}: requested by Synthetic Finance Requester, approved by Synthetic Admin Approver.`);
  await expect(a39).toContainText('The replacement draft is created in Xero at the supervised dispatch');
  expect(await approvals('INV-2026-0039')).toEqual([{ approval_number: apr, status: 'EXECUTED', requested_by: 'EMP-801', decided_by: 'EMP-802' }]);
  expect(await gen2('INV-2026-0039')).toEqual({ ledger: '1', writes: '1', pending: '1' });

  // 9. A repeat approval (double click, a second tab) is refused and queues nothing more.
  expect(await (await replay(admin.ctx, approve, tick)).text()).toContain('This reissue was already decided.');
  expect(await gen2('INV-2026-0039')).toEqual({ ledger: '1', writes: '1', pending: '1' });

  // 10. The requester sees the outcome, who decided and the next step.
  await fin.page.reload();   // a fresh render, as the requester sees it when they come back
  await expect(inv39).toContainText('Approved, queued');
  await expect(inv39).toContainText('approved by Synthetic Admin Approver');

  // 11. Concurrent requests and concurrent approvals of INV-2026-0040: each happens exactly once.
  const swap40: [string, string][] = [['INV-2026-0039', 'INV-2026-0040']];
  const both = await Promise.all([replay(fin.ctx, request, swap40), replay(fin.ctx, request, swap40)]);
  const texts = await Promise.all(both.map((r) => r.text()));
  expect(texts.filter((t) => t.includes('is waiting for a second person to approve it'))).toHaveLength(1);
  const requested40 = await approvals('INV-2026-0040');
  expect(requested40).toHaveLength(1);
  const apr40 = String(requested40[0]!.approval_number);
  const decide40 = await Promise.all([0, 1].map(() => replay(admin.ctx, approve, [...tick, [apr, apr40]])));
  const decided = await Promise.all(decide40.map((r) => r.text()));
  expect(decided.filter((t) => t.includes(`${apr40} approved: generation 2 is queued`))).toHaveLength(1);
  expect(await approvals('INV-2026-0040')).toEqual([{ approval_number: apr40, status: 'EXECUTED', requested_by: 'EMP-801', decided_by: 'EMP-802' }]);
  expect(await gen2('INV-2026-0040')).toEqual({ ledger: '1', writes: '1', pending: '1' });

  // 11b. The project page never presents the voided document as current while the replacement is queued.
  await admin.page.goto('/projects/PRJ-2026-0005');
  const docs = admin.page.getByRole('group', { name: 'Xero documents for INV-2026-0040' });
  await expect(docs).toContainText('Replacement queued');
  await expect(docs).toContainText(`Reissue ${apr40}: requested by Synthetic Finance Requester, approved by Synthetic Admin Approver.`);
  await expect(docs).toContainText('aaaaaaaa-bbbb-cccc-dddd-00000000f005');
  await expect(docs).toContainText('voided in Xero: no longer a valid invoice. Do not use it.');
  await expect(admin.page.getByText('Creating in Xero').first()).toBeVisible();
  await expect(admin.page.getByRole('link', { name: 'Open in Xero' })).toHaveCount(0);

  // 11c. The financial exception the void raised is closed through the dashboard by an authorised person, once.
  const voided = async (inv: string) => one<{ exception_number: string; resolution_status: string }>(
    `select exception_number, resolution_status from v_dashboard_exceptions where error_message like $1 order by first_failed_at desc limit 1`,
    [`Final invoice ${inv} was voided%`]);
  const exc39 = (await voided('INV-2026-0039')).exception_number;
  const exc40 = (await voided('INV-2026-0040')).exception_number;
  await est.page.goto('/automation');
  await expect(est.page.getByText('you are signed in as estimator')).toBeVisible();
  await expect(est.page.getByRole('button', { name: 'Mark resolved' })).toHaveCount(0);
  await fin.page.goto('/automation');
  const finResolves = recordActions(fin.page);
  const issue = fin.page.locator('.issue', { hasText: exc39 });
  await expect(issue).toContainText('INV-2026-0039');
  await issue.locator('textarea[name=note]').fill(`Reissued under ${apr}; the replacement draft is created in Xero`);
  await issue.getByRole('button', { name: 'Mark resolved' }).click();
  await expect.poll(async () => (await voided('INV-2026-0039')).resolution_status).toBe('RESOLVED');
  await expect(fin.page.locator('section.card', { hasText: 'Resolved' }).locator('.issue', { hasText: exc39 })).toContainText(apr);
  const resolve = finResolves();
  expect(await (await replay(fin.ctx, resolve)).text()).toContain(`${exc39} is already RESOLVED`);
  expect(await (await replay(est.ctx, resolve, [[exc39, exc40]])).text()).toContain('EMP-803 (ESTIMATOR) may not resolve exceptions');
  expect(await (await replay(demo.ctx, resolve, [[exc39, exc40]])).text()).toContain('the shared demo login cannot');
  expect((await voided('INV-2026-0040')).resolution_status).toBe('OPEN');
  expect(await one(`select actor_id from audit_events where action = 'exception.resolved' and business_reference = $1`, [exc39]))
    .toEqual({ actor_id: 'EMP-801' });

  // 12. Signing out ends the session in the database: the old cookie no longer works, even by replay.
  const oldCookies = await fin.ctx.cookies();
  await fin.page.getByRole('button', { name: /Synthetic/ }).click();
  await fin.page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(fin.page).toHaveURL(/\/login$/);
  const stale = await browser.newContext({ baseURL });
  await stale.addCookies(oldCookies);
  const stalePage = await stale.newPage();
  await stalePage.goto('/finance');
  await expect(stalePage).toHaveURL(/\/login$/);
  expect(await (await replay(stale, request, swap40)).text()).toContain('Your sign-in has ended');

  // 13. An expired session (the database's clock, not the cookie's) is refused at the next request.
  await db.query(`update staff_sessions set expires_at = now() - interval '1 second'
                   where employee_id = (select id from employees where employee_code = 'EMP-803') and revoked_at is null`);
  await est.page.goto('/finance');
  await expect(est.page).toHaveURL(/\/login$/);

  for (const c of [fin.ctx, est.ctx, demo.ctx, admin.ctx, stale]) await c.close();
});

test('sign-in throttling: a staff login locks after 5 wrong passwords from any addresses; one address is throttled after 5 failures', async ({ page }) => {
  const { user, password } = login('EST');
  const run = Date.now() % 200;                       // fresh documentation-range addresses per run (the throttle is in memory)
  const attempt = async (from: string, u: string, p: string) => {
    await page.setExtraHTTPHeaders({ 'x-forwarded-for': from });
    await page.goto('/login');
    await page.getByLabel('Username').fill(u);
    await page.getByLabel('Password').fill(p);
    await page.getByRole('button', { name: 'Sign in' }).click();
    return page.locator('.form-error').innerText();
  };
  // One answer for an unknown login and a wrong password: nothing says a login exists.
  const generic = await attempt(`198.51.100.${run}`, 'nobody.here', 'wrong-password-123');
  expect(generic).toContain('did not match');
  // A distributed guesser (a new address each time) still locks the login in the database after 5 wrong passwords.
  for (let i = 1; i <= 5; i++) expect(await attempt(`203.0.113.${(run + i) % 250}`, user, `wrong-password-${i}xx`)).toBe(generic);
  expect((await one<{ locked: boolean }>('select locked_until > now() locked from staff_accounts where login = $1', [user])).locked).toBe(true);
  expect(await attempt('192.0.2.77', user, password)).toBe(generic);      // locked: even the right password is refused, same words
  await expect(page).toHaveURL(/\/login$/);
  // One address: after 5 failures it is throttled before any password check. A spoofed first x-forwarded-for entry
  // does not reset it (the last entry is the one the proxy appended).
  const from = `198.18.0.${run}`;
  for (let i = 0; i < 5; i++) await attempt(from, 'nobody.here', `wrong-${i}-password`);
  expect(await attempt(`10.9.9.${run}, ${from}`, 'nobody.here', 'wrong-again-password')).toContain('Too many attempts');
});
