import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * Staging gate (STAFF_XERO_DISPATCH not "on"): with n8n 09 inactive, the dashboard must not queue Xero work. Run against
 * the LOCAL rehearsal server started WITHOUT the switch (E2E_PILOT_GATE=1). Preparing and rejecting still work; approve
 * and send controls are replaced by an explanation, and a replayed approve request is refused with nothing queued.
 */
const enabled = process.env.E2E_PILOT_GATE === '1';
const env = enabled ? parseEnv(readFileSync('e2e/.auth/pilot.env', 'utf8')) : {};
test.describe.configure({ mode: 'serial' });
test.skip(!enabled, 'opt-in: E2E_PILOT_GATE=1 against the local rehearsal server with STAFF_XERO_DISPATCH off');
test.use({ storageState: { cookies: [], origins: [] } });

let db: pg.Client;
test.beforeAll(({ baseURL }) => {
  const url = new URL(env.PILOT_DB_URL ?? '');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/roofops_pilot') throw new Error('local roofops_pilot only');
  if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL ?? '').hostname)) throw new Error('local server only');
  db = new pg.Client({ connectionString: url.toString() });
  return db.connect();
});
test.afterAll(() => db?.end());

async function signIn(browser: Browser, who: 'FIN' | 'ADMIN', baseURL: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Username').fill(env[`PILOT_${who}_LOGIN`] ?? '');
  await page.getByLabel('Password').fill(env[`PILOT_${who}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  return { ctx, page };
}

test('with the switch off: prepare works, approve and send are explained instead, and a replayed approval queues nothing', async ({ browser, baseURL }) => {
  const P = 'PRJ-2026-0002';
  const fin = await signIn(browser, 'FIN', baseURL!);
  await fin.page.goto('/finance');
  await fin.page.getByRole('button', { name: `Prepare invoice for ${P}` }).click();
  await expect(fin.page.locator('#approvals .issue', { hasText: P })).toContainText('Awaiting approval');

  const admin = await signIn(browser, 'ADMIN', baseURL!);
  await admin.page.goto('/finance');
  const card = admin.page.locator('#approvals .issue', { hasText: P });
  await expect(card.getByRole('note')).toContainText('switched on together with the RoofOps automation');
  await expect(card.getByRole('button', { name: /^Approve APR-/ })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Reject' })).toBeVisible();

  // Capture the real decision request (a reject without a reason, refused in the browser's own action) and replay it as an approval.
  let captured: { url: string; action: string; contentType: string; body: string } | undefined;
  admin.page.on('request', (r) => { const h = r.headers(); if (r.method() === 'POST' && h['next-action']) captured = { url: r.url(), action: h['next-action'], contentType: h['content-type'] ?? '', body: r.postData() ?? '' }; });
  await card.getByRole('button', { name: 'Reject' }).click();
  await expect(card.locator('[role=alert]')).toContainText('Say why it is rejected');
  const c = captured!;
  const m = /name="([^"]*)approval"/.exec(c.body)!;
  const tick = `name="${m[1]}checked"\r\n\r\non\r\n--${c.contentType.split('boundary=')[1]}\r\nContent-Disposition: form-data; ${m[0]}`;
  const body = c.body.split(m[0]).join(tick).split('reject').join('approve');
  const res = await admin.ctx.request.post(c.url, { headers: { 'next-action': c.action, 'content-type': c.contentType, origin: new URL(c.url).origin, accept: 'text/x-component',
    cookie: (await admin.ctx.cookies()).map((k) => `${k.name}=${k.value}`).join('; ') }, data: body, maxRedirects: 0 });
  expect(await res.text()).toContain('switched on together with the RoofOps automation');
  expect((await db.query(`select status from approvals where business_reference = $1 and action_type = 'CREATE_INVOICE'`, [P])).rows).toEqual([{ status: 'PENDING' }]);
  expect((await db.query('select count(*)::int n from xero_dispatch_requests')).rows).toEqual([{ n: 0 }]);
  expect((await db.query(`select count(*)::int n from invoices i join projects p on p.id = i.project_id where p.project_number = $1 and i.invoice_type = 'FINAL'`, [P])).rows).toEqual([{ n: 0 }]);

  // Rejecting still works.
  await card.locator('textarea[name=note]').fill('Staging: not approving in the dashboard yet');
  await card.getByRole('button', { name: 'Reject' }).click();
  await expect(admin.page.locator('#approvals .issue', { hasText: P })).toHaveCount(0);
  expect((await db.query(`select status from approvals where business_reference = $1 and action_type = 'CREATE_INVOICE'`, [P])).rows).toEqual([{ status: 'REJECTED' }]);
  await fin.ctx.close(); await admin.ctx.close();
});
