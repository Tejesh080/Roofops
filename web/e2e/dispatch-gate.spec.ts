import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expect, test, type APIResponse, type Browser, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * Staging gate (STAFF_XERO_DISPATCH not "on"): with n8n 09 inactive, the dashboard must neither queue Xero work nor
 * start a financial step it cannot finish. Run against the LOCAL rehearsal server started WITHOUT the switch
 * (E2E_PILOT_GATE=1). Factory review, Batch 1 ("circular dashboard/Airtable approval deadlock and reissue trap"):
 *  A. Preparing a final invoice in the dashboard is not offered, and a forged prepare is refused: a dashboard-prepared
 *     preview can only be approved in the dashboard (never through the shared Airtable account), so with approving off
 *     it could never be approved anywhere.
 *  B. Requesting and approving a reissue are not offered, and a forged approval is refused: approving queues a
 *     generation-2 Xero write that nothing could send while dispatch is off.
 *  C. What already exists keeps a way out: a pending dashboard preview is rejected here (then prepared and approved in
 *     Airtable, the live path); a pending reissue request is harmless and expires; nothing financial is queued.
 * Server actions are replayed exactly as the browser sends them, by their ids in the build's action manifest.
 */
const enabled = process.env.E2E_PILOT_GATE === '1';
const env = enabled ? parseEnv(readFileSync('e2e/.auth/pilot.env', 'utf8')) : {};
test.describe.configure({ mode: 'serial' });
test.skip(!enabled, 'opt-in: E2E_PILOT_GATE=1 against the local rehearsal server with STAFF_XERO_DISPATCH off');
test.use({ storageState: { cookies: [], origins: [] } });

type R = Record<string, unknown>;
let db: pg.Client;
test.beforeAll(({ baseURL }) => {
  const url = new URL(env.PILOT_DB_URL ?? '');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/roofops_pilot') throw new Error('local roofops_pilot only');
  if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL ?? '').hostname)) throw new Error('local server only');
  db = new pg.Client({ connectionString: url.toString() });
  return db.connect();
});
test.afterAll(() => db?.end());
const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0] as R;

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
/** A database session for a pilot login (to create the state that existed before the fix, as the dashboard would have). */
const token = async (who: 'FIN' | 'ADMIN') => String(((await one('select web_staff_sign_in($1, $2) r', [env[`PILOT_${who}_LOGIN`], env[`PILOT_${who}_PASSWORD`]])).r as R).token);

/** The id the build gave a finance server action (what the browser sends in the next-action header). */
function actionId(name: string): string {
  const m = JSON.parse(readFileSync('.next/server/server-reference-manifest.json', 'utf8')) as { node: Record<string, { filename: string; exportedName: string }> };
  const hit = Object.entries(m.node).find(([, v]) => v.filename === 'app/(ops)/finance/actions.ts' && v.exportedName === name);
  if (!hit) throw new Error(`no server action ${name} in the build manifest`);
  return hit[0];
}
/** Post a finance server action with these form fields, as useActionState does (field prefix "1_", previous state "0"). */
async function callAction(ctx: BrowserContext, baseURL: string, name: string, fields: Record<string, string>): Promise<string> {
  const multipart: Record<string, string> = { '0': '[{},"$K1"]' };
  for (const [k, v] of Object.entries(fields)) multipart[`1_${k}`] = v;
  const res: APIResponse = await ctx.request.post(`${baseURL}/finance`, { headers: { 'next-action': actionId(name), origin: baseURL, accept: 'text/x-component',
    cookie: (await ctx.cookies()).map((k) => `${k.name}=${k.value}`).join('; ') }, multipart, maxRedirects: 0 });
  return res.text();
}

const P = 'PRJ-2026-0002';
const OFF_PREPARE = 'Preparing final invoices in the dashboard is off';

test('A. with the switch off, preparing in the dashboard is not offered and a forged prepare is refused (it would create a preview nobody could approve)', async ({ browser, baseURL }) => {
  const fin = await signIn(browser, 'FIN', baseURL!);
  await fin.page.goto('/finance');
  await expect(fin.page.getByRole('link', { name: P }).first()).toBeVisible();                // the ready row is there
  await expect(fin.page.getByRole('button', { name: `Prepare invoice for ${P}` })).toHaveCount(0);
  await expect(fin.page.getByRole('note', { name: 'Preparing invoices' })).toContainText(OFF_PREPARE);
  await expect(fin.page.getByRole('note', { name: 'Preparing invoices' })).toContainText('prepare and approve it in Airtable');
  const replay = await callAction(fin.ctx, baseURL!, 'prepareFinalInvoice', { project: P });
  expect(replay).toContain(OFF_PREPARE);
  expect(await one(`select count(*)::int n from approvals where business_reference = $1 and action_type = 'CREATE_INVOICE'`, [P])).toEqual({ n: 0 });
  await fin.ctx.close();
});

test('A + C. a preview prepared in the dashboard before the switch was off: Airtable cannot approve it, the dashboard says so and offers reject; rejecting frees the project for the Airtable path', async ({ browser, baseURL }) => {
  const prepared = (await one('select web_invoice_prepare($1, $2) r', [await token('FIN'), P])).r as R;
  expect(prepared).toMatchObject({ ok: true, outcome: 'PREVIEW_READY' });
  const apr = String(prepared.approval_number);

  // The shared Airtable account cannot approve it (the decision core refuses: two named people must be proven).
  await db.query('set role roofops_workflow');
  const viaAirtable = (await one(`select wf_invoice_decide($1::jsonb, 'n8n:04') r`, [JSON.stringify({ event_id: `airtable:gate:${apr}`, event_type: 'invoice.approved', source: 'airtable',
    actor_id: 'usr7uCnNO15fCefbH', actor_name: 'Demo Finance Approver', occurred_at: new Date().toISOString(), payload: { project_number: P } })])).r as R;
  await db.query('reset role');
  expect(['PERMISSION_DENIED', 'INVALID_STATE', 'VALIDATION_ERROR']).toContain(String(viaAirtable.outcome));
  expect(await one('select status from approvals where approval_number = $1', [apr])).toEqual({ status: 'PENDING' });

  const admin = await signIn(browser, 'ADMIN', baseURL!);
  await admin.page.goto('/finance');
  const card = admin.page.locator('#approvals .issue', { hasText: P });
  await expect(card).toContainText('Awaiting approval');
  await expect(card.getByRole('note')).toContainText('prepared in the dashboard');
  await expect(card.getByRole('note')).toContainText('Reject it here');
  await expect(card.getByRole('button', { name: /^Approve APR-/ })).toHaveCount(0);
  // A forged approval is refused and creates nothing.
  const forged = await callAction(admin.ctx, baseURL!, 'decideFinalInvoice', { approval: apr, hash: String(prepared.payload_hash), decision: 'approve', checked: 'on' });
  expect(forged).toContain('Approving final invoices in the dashboard is off');
  expect(await one('select count(*)::int n from xero_dispatch_requests')).toEqual({ n: 0 });
  expect(await one(`select count(*)::int n from invoices i join projects p on p.id = i.project_id where p.project_number = $1 and i.invoice_type = 'FINAL'`, [P])).toEqual({ n: 0 });

  // Rejecting works (double-clicked: still one decision), and the project can then be prepared through Airtable.
  await card.locator('textarea[name=note]').fill('Prepared in the dashboard while sending is off; redo it in Airtable');
  await card.getByRole('button', { name: 'Reject' }).dblclick();
  await expect(admin.page.locator('#approvals .issue', { hasText: P })).toHaveCount(0);
  expect(await one('select status from approvals where approval_number = $1', [apr])).toEqual({ status: 'REJECTED' });
  expect(await one(`select count(*)::int n from audit_events where action = 'approval.reject' and business_reference = $1`, [apr])).toEqual({ n: 1 });
  await db.query('set role roofops_workflow');
  const again = (await one(`select wf_invoice_prepare($1::jsonb, 'n8n:04') r`, [JSON.stringify({ event_id: `airtable:gate:prep:${apr}`, event_type: 'invoice.prepare_requested', source: 'airtable',
    actor_id: 'usr7uCnNO15fCefbH', actor_name: 'Demo Finance Approver', occurred_at: new Date().toISOString(), payload: { project_number: P } })])).r as R;
  await db.query('reset role');
  expect(again).toMatchObject({ outcome: 'PREVIEW_READY' });                                  // the live Airtable path is open again
  await admin.ctx.close();
});

test('B + C. with the switch off, reissues are neither requested nor approved in the dashboard; a request made before is not approvable, queues nothing, and expires', async ({ browser, baseURL }) => {
  const inv = String((await one(`select i.invoice_number from invoices i where i.status = 'VOIDED' and i.invoice_type = 'FINAL' order by 1 limit 1`)).invoice_number);
  const fin = await signIn(browser, 'FIN', baseURL!);
  await fin.page.goto('/finance');
  const item = fin.page.locator('#reissues .issue', { hasText: inv });
  await expect(item).toBeVisible();
  await expect(item.getByRole('button', { name: /Request reissue/i })).toHaveCount(0);
  await expect(item.getByRole('note')).toContainText('Reissues from the dashboard are off');
  expect(await callAction(fin.ctx, baseURL!, 'requestReissue', { invoice: inv, reason: 'Forged request while dispatch is off (test)' })).toContain('Reissues from the dashboard are off');
  expect(await one(`select count(*)::int n from approvals a join invoices i on i.id = a.entity_id where i.invoice_number = $1 and a.action_type = 'REISSUE_INVOICE' and a.status = 'PENDING'`, [inv])).toEqual({ n: 0 });

  // A request that already existed (made while the switch was on).
  const req = (await one('select web_reissue_request($1, $2, $3) r', [await token('FIN'), inv, 'Voided in Xero by mistake; replace it (test)'])).r as R;
  expect(req).toMatchObject({ ok: true });
  const apr = String(req.approval_number);
  const gens = async () => one(`select count(*)::int n from outbox o join invoices i on i.id = o.aggregate_id where i.invoice_number = $1 and o.topic = 'xero.create_draft_invoice' and o.generation >= 2`, [inv]);
  const before = await gens();
  const admin = await signIn(browser, 'ADMIN', baseURL!);
  await admin.page.goto('/finance');
  const pending = admin.page.locator('#reissues .issue', { hasText: inv });
  await expect(pending).toContainText('Awaiting approval');
  await expect(pending.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
  await expect(pending.getByRole('note')).toContainText('Approving a reissue is off');
  await expect(pending.getByRole('note')).toContainText('expires');
  expect(await callAction(admin.ctx, baseURL!, 'approveReissue', { approval: apr, checked: 'on', note: 'forged' })).toContain('Approving a reissue is off');
  expect(await gens()).toEqual(before);                                                         // no generation queued
  expect(await one('select status from approvals where approval_number = $1', [apr])).toEqual({ status: 'PENDING' });
  // It lapses on its own: once expired the database itself refuses it (nothing financial ever happened).
  await db.query(`update approvals set expires_at = now() - interval '1 minute' where approval_number = $1`, [apr]);
  const late = (await one('select web_reissue_decide($1, $2, $3) r', [await token('ADMIN'), apr, 'too late'])).r as R;
  expect(late).toMatchObject({ ok: false });
  expect(await gens()).toEqual(before);
  await fin.ctx.close(); await admin.ctx.close();
});
