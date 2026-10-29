import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expect, test, type APIResponse, type Browser, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * STAFF-OPS-01 in a real browser, LOCAL rehearsal database only (scripts/pilot-rehearsal.ts --reset, then `next start`
 * with web/e2e/.auth/pilot.env). Opt-in: E2E_PILOT=1. Run it on a freshly reset database.
 *
 * Finance prepares a final invoice, a different Admin approves it, and it is sent to Xero by RoofOps automation. n8n 09
 * and 05 are simulated exactly as they call Postgres (wf_xero_dispatch_next, wf_claim_side_effect, wf_fail_side_effect,
 * wf_complete_side_effect, as roofops_workflow); nothing calls Xero. Every refusal is attempted by replaying the real
 * server-action request with another person's cookies, a stale preview, at the same time, or after the session ended.
 */
const enabled = process.env.E2E_PILOT === '1';
const env = enabled ? parseEnv(readFileSync('e2e/.auth/pilot.env', 'utf8')) : {};
const login = (who: 'FIN' | 'ADMIN' | 'EST' | 'DEMO') => ({ user: env[`PILOT_${who}_LOGIN`] ?? '', password: env[`PILOT_${who}_PASSWORD`] ?? '' });
const uuidFor = (seed: string) => createHash('md5').update(seed).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

test.describe.configure({ mode: 'serial' });
test.skip(!enabled, 'opt-in: E2E_PILOT=1 against the local pilot rehearsal server');
test.use({ storageState: { cookies: [], origins: [] } });

let db: pg.Client;
test.beforeAll(({ baseURL }) => {
  const url = new URL(env.PILOT_DB_URL ?? '');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/roofops_pilot') throw new Error('PILOT_DB_URL must be the local roofops_pilot');
  if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL ?? '').hostname)) throw new Error('local server only');
  db = new pg.Client({ connectionString: url.toString() });
  return db.connect();
});
test.afterAll(() => db?.end());

type R = Record<string, unknown>;
const one = async <T = R>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0] as T;
async function asWorkflow(sql: string, p: unknown[] = []): Promise<R> {
  await db.query('set role roofops_workflow');
  try { return (await one<{ r: R }>(sql, p)).r; } finally { await db.query('reset role'); }
}
const poll09 = () => asWorkflow(`select wf_xero_dispatch_next('n8n:09:e2e') r`);
const claim05 = (key: string) => asWorkflow(`select wf_claim_side_effect($1, 'n8n:05', 120) r`, [key]);
const fail05 = (key: string, cls: string, step: string, msg: string) => asWorkflow(`select wf_fail_side_effect($1, $2, $3, null, 0) r`, [key, cls, `${step}: ${msg}`]);
async function complete05(key: string, xid: string) {
  const p = (await one<{ payload: R }>('select payload from outbox where idempotency_key = $1', [key])).payload;
  return asWorkflow('select wf_complete_side_effect($1, $2::jsonb) r', [key, JSON.stringify({ verified: true, tenant_id: p.xero_tenant_id, organisation_class: 'DEMO',
    invoice_id: xid, invoice_number: p.xero_invoice_number, reference: p.reference, status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false,
    contact_id: uuidFor(`contact:${String(p.customer_id)}`), contact_number: p.xero_contact_number, total: p.amount_inc_gst, total_tax: p.gst_amount,
    currency: 'AUD', line_amount_types: 'Inclusive', matching_invoices: 1 })]);
}
const approvalsFor = (prj: string) => db.query(`select a.approval_number, a.status, re.employee_code requested_by, de.employee_code decided_by, a.idempotency_key
    from approvals a left join employees re on re.id = a.requested_by_employee_id left join employees de on de.id = a.decided_by
   where a.action_type = 'CREATE_INVOICE' and a.business_reference = $1 order by a.created_at`, [prj]).then((r) => r.rows as R[]);
const effects = (prj: string) => one<{ finals: string; writes: string; requests: string }>(`select
    (select count(*)::text from invoices i join projects p on p.id = i.project_id where p.project_number = $1 and i.invoice_type = 'FINAL') finals,
    (select count(*)::text from outbox o join invoices i on i.id = o.aggregate_id join projects p on p.id = i.project_id where p.project_number = $1 and o.topic = 'xero.create_draft_invoice') writes,
    (select count(*)::text from xero_dispatch_requests r join invoices i on i.id = r.invoice_id join projects p on p.id = i.project_id where p.project_number = $1) requests`, [prj]);
const writeOf = (prj: string) => one<{ key: string; invoice: string; xero_number: string }>(`select o.idempotency_key key, i.invoice_number invoice, o.payload ->> 'xero_invoice_number' xero_number
    from outbox o join invoices i on i.id = o.aggregate_id join projects p on p.id = i.project_id where p.project_number = $1 and o.topic = 'xero.create_draft_invoice'`, [prj]);

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
const replay = async (ctx: BrowserContext, c: Captured, swap: [string, string][] = []): Promise<APIResponse> =>
  ctx.request.post(c.url, {
    headers: { 'next-action': c.action, 'content-type': c.contentType, origin: new URL(c.url).origin, accept: 'text/x-component',
      cookie: (await ctx.cookies()).map((k) => `${k.name}=${k.value}`).join('; ') },
    data: swap.reduce((b, [from, to]) => b.split(from).join(to), c.body),
    maxRedirects: 0,
  });
/** Adds a ticked checkbox field next to the named field, with the same encoding prefix (the captured request had none). */
function tickNextTo(c: Captured, field: string): [string, string][] {
  const m = new RegExp(`name="([^"]*)${field}"`).exec(c.body);
  if (!m) throw new Error(`no ${field} field in the captured request`);
  return [[m[0], `name="${m[1]}checked"\r\n\r\non\r\n--${c.contentType.split('boundary=')[1]}\r\nContent-Disposition: form-data; ${m[0]}`]];
}
const approvalsCard = (page: Page) => page.locator('#approvals');
const draftsCard = (page: Page) => page.locator('#xero-drafts');

test('final invoice: Finance prepares, a different Admin approves, RoofOps automation creates the Xero draft; every bypass is refused', async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const P = 'PRJ-2026-0002';

  // 1. Finance prepares from the Finance page (a double click prepares once).
  const fin = await signIn(browser, 'FIN', baseURL!);
  await fin.page.goto('/finance');
  await fin.page.getByRole('button', { name: `Prepare invoice for ${P}` }).dblclick();
  const card = approvalsCard(fin.page).locator('.issue', { hasText: P });
  await expect(card).toContainText('Awaiting approval');
  const [prepared] = await approvalsFor(P);
  expect(await approvalsFor(P)).toHaveLength(1);
  expect(prepared).toMatchObject({ status: 'PENDING', requested_by: 'EMP-801' });
  expect(String(prepared!.idempotency_key)).toMatch(/^approval:dashboard:prepare:/);
  const apr = String(prepared!.approval_number);
  // Everything an approver checks: customer, amount, GST, dates, lines; who asked and how.
  const preview = (await one<{ p: R }>('select action_payload p from approvals where approval_number = $1', [apr])).p;
  await expect(card).toContainText(String(preview.customer_name));
  await expect(card).toContainText(`GST ${Number(preview.gst_amount).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })}`);
  await expect(card).toContainText('Requested');
  await expect(card).toContainText('Synthetic Finance Requester in the dashboard');
  await expect(card.getByRole('table', { name: `Lines of ${apr}` })).toBeVisible();
  await expect(card).toContainText('You prepared this. A second person');
  await expect(card.getByRole('button', { name: `Approve ${apr}` })).toHaveCount(0);
  await expect(card.getByRole('checkbox')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Reject' })).toBeVisible();   // the requester may withdraw it (test 2)

  // 2. A role that cannot approve, and the demo viewer, get no controls.
  const est = await signIn(browser, 'EST', baseURL!);
  await est.page.goto('/finance');
  await expect(approvalsCard(est.page).locator('.issue', { hasText: P })).toContainText('Waiting for an approver');
  await expect(approvalsCard(est.page).locator('button')).toHaveCount(0);
  const demo = await signIn(browser, 'DEMO', baseURL!);
  await demo.page.goto('/finance');
  await expect(approvalsCard(demo.page)).toContainText('Sign in as yourself to prepare, approve or reject invoices');

  // 3. Admin opens it; the server insists on the "I checked" box (the request is captured for the bypass attempts).
  const admin = await signIn(browser, 'ADMIN', baseURL!);
  await admin.page.goto('/finance');
  const decisions = recordActions(admin.page);
  const aCard = approvalsCard(admin.page).locator('.issue', { hasText: P });
  await aCard.getByRole('button', { name: `Approve ${apr}` }).click();
  await expect(aCard.locator('[role=alert]')).toContainText('Tick that you checked');
  const decide = decisions();
  expect(decide.body).toContain('approve');
  const tick = tickNextTo(decide, 'approval');
  const hash = String((await one<{ h: string }>('select payload_hash h from approvals where approval_number = $1', [apr])).h);
  expect(await (await replay(fin.ctx, decide, tick)).text()).toContain('You prepared this invoice, so someone else must approve it.');
  expect(await (await replay(est.ctx, decide, tick)).text()).toContain('Your role cannot do this.');
  expect(await (await replay(demo.ctx, decide, tick)).text()).toContain('the shared demo login cannot');
  expect(await (await replay(admin.ctx, decide, [...tick, [hash, 'f'.repeat(hash.length)]])).text()).toContain('The preview changed since you opened it.');
  expect((await approvalsFor(P))[0]).toMatchObject({ status: 'PENDING', decided_by: null });
  expect(await effects(P)).toEqual({ finals: '0', writes: '0', requests: '0' });

  // 4. Two approvals at the same instant (a double submit from two tabs): exactly one takes effect.
  const both = await Promise.all([replay(admin.ctx, decide, tick), replay(admin.ctx, decide, tick)]);
  const said = await Promise.all(both.map((r) => r.text()));
  expect(said.filter((t) => t.includes(`${apr} approved`))).toHaveLength(1);
  expect(said.filter((t) => t.includes('This preview was already decided.'))).toHaveLength(1);
  expect((await approvalsFor(P))[0]).toMatchObject({ status: 'EXECUTING', requested_by: 'EMP-801', decided_by: 'EMP-802' });
  expect(await effects(P)).toEqual({ finals: '1', writes: '1', requests: '1' });
  expect(await one('select actor_id from audit_events where action = $1 and business_reference = $2', ['approval.approve', apr])).toEqual({ actor_id: 'EMP-802' });
  const w = await writeOf(P);

  // 5. A reload shows the true progress: approved, waiting for automation; nobody can queue it twice.
  await admin.page.reload();
  const dCard = draftsCard(admin.page).locator('.issue', { hasText: w.xero_number });
  await expect(dCard).toContainText('Waiting to send');
  await expect(dCard).toContainText('Last request: Synthetic Admin Approver');
  await expect(approvalsCard(admin.page).locator('.issue', { hasText: P })).toHaveCount(0);

  // 6. n8n 09 picks it up (once), 05 claims it, Xero fails before the create: staff see why and when to retry.
  const n = await poll09();
  expect((n.writes as R[]).map((x) => x.xero_key)).toEqual([w.key]);
  expect(((await poll09()).writes as R[])).toEqual([]);
  await admin.page.reload();
  await expect(dCard).toContainText('Starting');
  expect(await claim05(w.key)).toMatchObject({ claimed: true });
  await admin.page.reload();
  await expect(dCard).toContainText('Creating in Xero');
  expect(await fail05(w.key, 'NETWORK', 'search by invoice number', 'ECONNRESET')).toMatchObject({ retry: true });
  await db.query(`update outbox set next_attempt_at = now() - interval '1 second' where idempotency_key = $1`, [w.key]);

  // 7. Finance sends it again (the exact invoice and generation); the estimator cannot; then 05 creates it.
  await fin.page.goto('/finance');
  const fCard = draftsCard(fin.page).locator('.issue', { hasText: w.xero_number });
  await expect(fCard).toContainText('Not sent');
  await expect(fCard).toContainText('Last answer: search by invoice number: ECONNRESET');
  const sends = recordActions(fin.page);
  await fCard.getByRole('checkbox').check();
  await fCard.getByRole('button', { name: `Send ${w.invoice} to Xero again` }).click();
  await expect(fCard).toContainText('Waiting to send');
  const send = sends();
  expect(await one(`select e.employee_code, r.status from xero_dispatch_requests r join employees e on e.id = r.requested_by
                     where r.xero_key = $1 order by r.requested_at desc limit 1`, [w.key])).toEqual({ employee_code: 'EMP-801', status: 'QUEUED' });
  expect(await (await replay(fin.ctx, send)).text()).toContain('It is already waiting to be sent.');
  await est.page.goto('/finance');
  await expect(draftsCard(est.page).locator('.issue', { hasText: w.xero_number })).toContainText('Waiting to send');
  expect(await (await replay(est.ctx, send)).text()).toContain('Your role cannot do this.');
  expect(((await poll09()).writes as R[]).map((x) => x.xero_key)).toEqual([w.key]);
  expect(await claim05(w.key)).toMatchObject({ claimed: true });
  const xid = uuidFor(`e2e-invoice-approval:${w.key}`);
  await complete05(w.key, xid);
  await fin.page.reload();
  await expect(fCard).toContainText('Draft in Xero');
  await expect(fCard).toContainText(`InvoiceID ${xid}`);
  // The request is still CLAIMED until the next 09 run settles it; staff read it as handed over, not "claimed".
  expect(await one('select status from xero_dispatch_requests where xero_key = $1 order by requested_at desc limit 1', [w.key])).toEqual({ status: 'CLAIMED' });
  await expect(fCard).toContainText('(handed over to the automation)');
  await expect(fCard).not.toContainText('claimed');
  await fin.page.goto(`/projects/${P}`);
  await expect(fin.page.getByRole('link', { name: 'Open in Xero' })).toHaveAttribute('href', new RegExp(xid));
  expect(await (await replay(fin.ctx, send)).text()).toContain('The Xero draft already exists.');

  // 8. A session that has ended is refused, even replaying a request that was valid a moment ago.
  await db.query(`update staff_sessions set expires_at = now() - interval '1 second'
                   where employee_id = (select id from employees where employee_code = 'EMP-801') and revoked_at is null`);
  expect(await (await replay(fin.ctx, send)).text()).toContain('Your sign-in has ended. Sign in again as yourself.');
  await fin.page.goto('/finance');
  await expect(fin.page).toHaveURL(/\/login$/);

  for (const c of [fin.ctx, est.ctx, demo.ctx, admin.ctx]) await c.close();
});

test('an ambiguous Xero answer is shown as unclear, cannot be re-sent, and System health flags it', async ({ browser, baseURL }) => {
  const P = 'PRJ-2026-0004';
  const fin = await signIn(browser, 'FIN', baseURL!);
  await fin.page.goto('/finance');
  // The requester withdraws a first preview (reject with a reason; never approve), then prepares it again.
  await fin.page.getByRole('button', { name: `Prepare invoice for ${P}` }).click();
  const mine = approvalsCard(fin.page).locator('.issue', { hasText: P });
  await expect(mine).toContainText('you can still withdraw it');
  await mine.locator('textarea[name=note]').fill('no');
  await mine.getByRole('button', { name: 'Reject' }).click();
  await expect(mine.locator('[role=alert]')).toContainText('Say why it is rejected');
  await expect(mine.locator('textarea[name=note]')).toHaveValue('no');   // a refusal keeps what was typed
  await mine.locator('textarea[name=note]').fill('Wrong date: preparing it again');
  await mine.getByRole('button', { name: 'Reject' }).click();
  await expect(mine).toHaveCount(0);
  expect((await approvalsFor(P)).filter((a) => String(a.idempotency_key).startsWith('approval:dashboard:prepare:'))
    .map((a) => [a.status, a.requested_by, a.decided_by])).toEqual([['REJECTED', 'EMP-801', 'EMP-801']]);
  expect(await effects(P)).toEqual({ finals: '0', writes: '0', requests: '0' });
  await fin.page.goto('/finance');
  await fin.page.getByRole('button', { name: `Prepare invoice for ${P}` }).click();
  await expect(approvalsCard(fin.page).locator('.issue', { hasText: P })).toContainText('Awaiting approval');
  const admin = await signIn(browser, 'ADMIN', baseURL!);
  await admin.page.goto('/finance');
  const aCard = approvalsCard(admin.page).locator('.issue', { hasText: P });
  await aCard.getByRole('checkbox').check();
  await aCard.getByRole('button', { name: /^Approve APR-/ }).click();
  await expect(aCard).toHaveCount(0);
  const w = await writeOf(P);
  expect(((await poll09()).writes as R[]).map((x) => x.xero_key)).toEqual([w.key]);
  expect(await claim05(w.key)).toMatchObject({ claimed: true });
  expect(await fail05(w.key, 'TIMEOUT', 'create draft invoice', 'ETIMEDOUT after 20s')).toMatchObject({ retry: true });
  await db.query(`update outbox set next_attempt_at = now() - interval '1 second' where idempotency_key = $1`, [w.key]);
  await admin.page.reload();
  const dCard = draftsCard(admin.page).locator('.issue', { hasText: w.xero_number });
  await expect(dCard).toContainText('Unclear');
  await expect(dCard).toContainText('Do not send it again');
  await expect(dCard.getByRole('button')).toHaveCount(0);
  // Even a request queued in the meantime is never handed to 05. (The claim 05 already took is settled first, as the
  // poller does at the start of every run; only then can a new request for the same write exist.)
  await db.query('select xero_dispatch_settle_claims()');
  await db.query(`insert into xero_dispatch_requests (invoice_id, generation, xero_key, payload_sha256, requested_by, reason)
                  select o.aggregate_id, o.generation, o.idempotency_key, xero_payload_sha256(o.payload), e.id, 'e2e' from outbox o, employees e
                   where o.idempotency_key = $1 and e.employee_code = 'EMP-801'`, [w.key]);
  expect(await poll09()).toMatchObject({ writes: [], refused: [{ invoice_number: w.invoice, code: 'UNCERTAIN' }] });
  await admin.page.goto('/health');
  const ops = admin.page.getByRole('region', { name: 'Operations status' });
  await expect(ops.locator('[data-ops="xero_uncertain"]')).toContainText('Stuck');
  await expect(ops.locator('[data-ops="reconciliation"]')).toContainText(/No data|Overdue|OK/);
  await fin.ctx.close(); await admin.ctx.close();
});

test('an issue from a rejected Airtable event names the Airtable record staff should look at', async ({ browser, baseURL }) => {
  const r = await asWorkflow('select wf_quote_accepted($1::jsonb) r', [JSON.stringify({ event_id: 'EVT-E2E-SRC-1', event_type: 'quote.accepted', source: 'airtable',
    actor_id: 'airtable-automation', occurred_at: new Date().toISOString(), payload: { accepted_version: 1, airtable_record_id: 'recE2ESOURCE00001' } })]);
  expect(r).toMatchObject({ status: 'REJECTED' });
  const admin = await signIn(browser, 'ADMIN', baseURL!);
  await admin.page.goto('/automation');
  const issue = admin.page.locator('.issue', { hasText: 'Airtable record recE2ESOURCE00001' });
  await expect(issue).toContainText('A quote acceptance arrived incomplete');
  await expect(issue.getByRole('button', { name: 'Mark resolved' })).toBeVisible();
  await admin.ctx.close();
});
