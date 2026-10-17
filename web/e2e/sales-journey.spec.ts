import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * SALES-01 in a real browser, LOCAL rehearsal database only (scripts/pilot-rehearsal.ts --reset). Opt-in: E2E_PILOT=1.
 * The synthetic estimator takes an enquiry to a sent quote in the dashboard. Simulated at the boundary (nothing leaves
 * this machine): n8n 10's Airtable hand-off (claim + verified proof, as the workflow role) and the office's Airtable
 * acceptance (the n8n 01 event to wf_quote_accepted, as the workflow role).
 */
const enabled = process.env.E2E_PILOT === '1';
const env = enabled ? parseEnv(readFileSync('e2e/.auth/pilot.env', 'utf8')) : {};
test.describe.configure({ mode: 'serial' });
test.skip(!enabled, 'opt-in: E2E_PILOT=1 against the local pilot rehearsal server');
test.use({ storageState: { cookies: [], origins: [] } });

type R = Record<string, unknown>;
let db: pg.Client;
test.beforeAll(async ({ baseURL }) => {
  const url = new URL(env.PILOT_DB_URL ?? '');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/roofops_pilot') throw new Error('local roofops_pilot only');
  if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL ?? '').hostname)) throw new Error('local server only');
  db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
});
test.afterAll(() => db?.end());
const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0] as R;
async function asWorkflow(sql: string, p: unknown[]): Promise<R> {
  await db.query('set role roofops_workflow');
  try { return (await one(sql, p)).r as R; } finally { await db.query('reset role'); }
}
async function signIn(browser: Browser, who: 'EST' | 'CREW' | 'ADMIN', baseURL: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Username').fill(env[`PILOT_${who}_LOGIN`] ?? '');
  await page.getByLabel('Password').fill(env[`PILOT_${who}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  return { ctx, page };
}
const nextStep = (page: Page) => page.getByRole('region', { name: 'Next step' });

test('enquiry → customer and site → inspection → quote → sent → in Airtable → accepted → project; refusals keep what was typed', async ({ browser, baseURL }) => {
  const est = await signIn(browser, 'EST', baseURL!);
  const page = est.page;
  await page.goto('/sales');
  const form = page.getByRole('form', { name: 'New enquiry' });
  await form.getByLabel('Name', { exact: true }).fill('Iris Journey');
  await form.getByLabel('Where it came from').selectOption('WEBSITE_FORM');
  await form.getByLabel('Phone', { exact: true }).fill('0433 222 111');
  await form.getByLabel('Email', { exact: true }).fill('iris.journey@example.test');
  await form.getByLabel('Address of the job (as they said it)').fill('7 Wattle Ct, Bundaberg East');
  await form.getByLabel('What they need').fill('Leak over the kitchen after the storm');
  await form.getByRole('button', { name: 'Record enquiry' }).dblclick();
  await expect(form.getByRole('status')).toContainText(/LEAD-\d{4}-\d{4} recorded/);
  expect(await one(`select count(*)::int n from leads where contact_name = 'Iris Journey'`)).toEqual({ n: 1 });
  const L = String((await one(`select lead_number from leads where contact_name = 'Iris Journey'`)).lead_number);
  await form.getByRole('link', { name: `Open ${L}` }).click();
  await expect(page).toHaveURL(new RegExp(`/sales/${L}$`));
  await expect(nextStep(page)).toContainText('Record the customer and the site');

  // 1. Contacted.
  await page.getByRole('region', { name: '1. Enquiry' }).getByRole('button', { name: 'Mark contacted' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Contacted');

  // 2. Customer and site (new customer; the postcode is checked before anything is written, and what was typed stays).
  const conv = page.getByRole('form', { name: `Customer and site for ${L}` });
  await conv.getByLabel('Street address').fill('7  Wattle Court');
  await conv.getByLabel('Suburb').fill('bundaberg east');
  await conv.getByLabel('Postcode').fill('4670');
  await conv.getByLabel('Access notes (optional)').fill('Side gate; dog in the yard');
  await conv.getByRole('button', { name: 'Save customer and site' }).click();
  // The form gives way to what was saved (the confirmation).
  await expect(page.getByRole('region', { name: '2. Customer and site' })).toContainText(/Iris Journey \(CUST-\d{4}\)/);
  const lead = await one(`select c.customer_number, c.display_name, pr.address_line1, pr.suburb, pr.access_notes from leads l join customers c on c.id = l.customer_id
                          join properties pr on pr.id = l.property_id where l.lead_number = $1`, [L]);
  expect(lead).toMatchObject({ display_name: 'Iris Journey', address_line1: '7 Wattle Court', suburb: 'Bundaberg East', access_notes: 'Side gate; dog in the yard' });
  await page.reload();
  await expect(page.getByRole('region', { name: '2. Customer and site' })).toContainText(`Iris Journey (${String(lead.customer_number)})`);
  await expect(nextStep(page)).toContainText('Book the inspection');

  // 3. Inspection: booked, then recorded (an area needs its measuring method: refused, the findings stay).
  const bookF = page.getByRole('form', { name: `Book the inspection for ${L}` });
  await bookF.getByLabel('Inspector').selectOption({ label: 'Synthetic Estimator' });
  await bookF.getByRole('button', { name: 'Book inspection' }).click();
  await expect(page.getByRole('region', { name: '3. Inspection' })).toContainText(/INS-\d{4}-\d{4}/);
  await expect(nextStep(page)).toContainText('booked');
  const ins = String((await one(`select i.inspection_number from inspections i join leads l on l.id = i.lead_id where l.lead_number = $1`, [L])).inspection_number);
  const rec = page.getByRole('form', { name: `Record ${ins}` });
  await rec.getByLabel('Roof type').selectOption('TERRACOTTA_TILE');
  await rec.getByLabel('Roof area m² (optional)').fill('182.4');
  await rec.getByLabel('What you found').fill('Six cracked tiles above the kitchen; ridge mortar failing');
  await rec.getByRole('button', { name: 'Save findings' }).click();
  await expect(rec.getByRole('alert')).toContainText('say how the area was measured');
  await expect(rec.getByLabel('What you found')).toHaveValue('Six cracked tiles above the kitchen; ridge mortar failing');
  await rec.getByLabel('Measured by (needed with an area)').selectOption('TAPE');
  await rec.getByRole('button', { name: 'Save findings' }).click();
  await expect(page.getByRole('region', { name: '3. Inspection' }).locator(`[data-inspection="${ins}"]`)).toContainText('Done');
  await expect(nextStep(page)).toContainText('Prepare the quote');

  // 4. The quote: two lines (labour, a catalogue material); the total is worked out as you type; a material needs its product.
  const qb = page.getByRole('form', { name: `Quote for ${L}` });
  await qb.getByLabel('Line 1 description').fill('Replace cracked tiles and re-point the ridge');
  await qb.getByLabel('Line 1 quantity').fill('12');
  await qb.getByLabel('Line 1 price').fill('95');
  await qb.getByRole('button', { name: 'Add line' }).click();
  await qb.getByLabel('Line 2 kind').selectOption('MATERIAL');
  await qb.getByLabel('Line 2 description').fill('Ridge capping');
  await qb.getByLabel('Line 2 quantity').fill('4');
  await qb.getByLabel('Line 2 price').fill('62.50');
  await expect(qb.locator('.quote-totals')).toContainText('Total $1,390.00');
  await qb.getByRole('button', { name: 'Save draft quote' }).click();
  await expect(qb.getByRole('alert')).toContainText('pick the product for a material line');
  await expect(qb.getByLabel('Line 1 description')).toHaveValue('Replace cracked tiles and re-point the ridge');   // nothing lost
  await qb.getByLabel('Line 2 product').selectOption('PROD-0002');
  await qb.getByRole('button', { name: 'Save draft quote' }).click();
  // Saved: the draft shows as its own card (the builder becomes "Revise").
  await expect(page.getByRole('region', { name: '4. Quote' }).locator('[data-quote]')).toContainText('Total $1,390.00');
  const Q = String((await one(`select q.quote_number from quotes q join leads l on l.id = q.lead_id where l.lead_number = $1`, [L])).quote_number);
  expect(await one(`select v.total_inc_gst::text t, v.gst_amount::text g, count(ln.*)::int n from quote_versions v join quotes q on q.id = v.quote_id
                    left join quote_version_lines ln on ln.quote_version_id = v.id where q.quote_number = $1 group by 1, 2`, [Q])).toEqual({ t: '1390.00', g: '126.36', n: 2 });
  await page.reload();
  const qcard = page.getByRole('region', { name: '4. Quote' }).locator(`[data-quote="${Q}"]`);
  await expect(qcard).toContainText('Draft');
  await expect(qcard).toContainText('Total $1,390.00');
  await expect(nextStep(page)).toContainText(`Check and send ${Q}`);

  // Send it (ticked): Sent, and handed to Airtable once.
  const sendF = qcard.getByRole('form', { name: `Send ${Q}` });
  await sendF.getByRole('button', { name: `Send ${Q}` }).click();
  await expect(sendF.getByRole('alert')).toContainText('Tick that you checked');
  await sendF.getByRole('checkbox').check();
  await sendF.getByRole('button', { name: `Send ${Q}` }).click();
  await expect(qcard).toContainText('valid until');
  expect(await one(`select q.status, (select count(*)::int from outbox o where o.topic = 'airtable.quote_publish' and o.aggregate_id = q.id) handoffs from quotes q where q.quote_number = $1`, [Q]))
    .toEqual({ status: 'SENT', handoffs: 1 });
  await page.reload();
  await expect(nextStep(page)).toContainText('being added to Airtable');

  // n8n 10 (simulated): the first try fails (Airtable 502) and is retried; the page says so and never claims it was added.
  const key = String(((await asWorkflow(`select wf_quote_publish_next('n8n:10:e2e') r`, [])).writes as R[])[0]!.key);
  expect(await asWorkflow(`select wf_claim_side_effect($1, 'n8n:10', 120) r`, [key])).toMatchObject({ claimed: true });
  expect(await asWorkflow(`select wf_quote_publish_fail($1, 'UPSTREAM_5XX', 'upsert quote: HTTP 502', 502, null) r`, [key])).toMatchObject({ retry: true });
  await page.reload();
  await expect(nextStep(page)).toContainText('The last try failed (upsert quote: HTTP 502); RoofOps tries again automatically.');
  await expect(qcard).toContainText('Airtable: being added; retrying after: upsert quote: HTTP 502');
  await expect(qcard).not.toContainText('Airtable: added');
  // The retry claims it again and records verified proof; the page then says what the office does.
  await db.query(`update outbox set next_attempt_at = now() where idempotency_key = $1`, [key]);
  expect(await asWorkflow(`select wf_claim_side_effect($1, 'n8n:10', 120) r`, [key])).toMatchObject({ claimed: true, attempt: 2 });
  const p = (await one('select payload from outbox where idempotency_key = $1', [key])).payload as R;
  expect(await asWorkflow(`select wf_complete_side_effect($1, $2::jsonb) r`, [key, JSON.stringify({ verified: true, quote_number: Q, customer_number: p.customer_number,
    property_number: p.property_number, quote_record_id: 'recE2EQUOTE000001', customer_record_id: 'recE2ECUSTOMER001', property_record_id: 'recE2EPROPERTY001',
    quote_customer_link_ids: ['recE2ECUSTOMER001'], quote_property_link_ids: ['recE2EPROPERTY001'],
    // The three records as Airtable holds them, read back by n8n 10 (required since 20261017040000).
    customer_read_back: { id: 'recE2ECUSTOMER001', roofops_id: p.customer_id, number: p.customer_number },
    property_read_back: { id: 'recE2EPROPERTY001', roofops_id: p.property_id, number: p.property_number, owner_link_ids: ['recE2ECUSTOMER001'] },
    quote_read_back: { id: 'recE2EQUOTE000001', roofops_id: p.quote_id, number: Q, version: (p.quote_fields as R).fldEjEqlzE8Y0M1nf, amount: (p.quote_fields as R).fldbfUE8DVh1Dwjfs,
      customer_link_ids: ['recE2ECUSTOMER001'], property_link_ids: ['recE2EPROPERTY001'] } })])).toMatchObject({ status: 'RECORDED' });
  await page.reload();
  await expect(nextStep(page)).toContainText(`Waiting for the customer to accept ${Q}`);
  await expect(qcard).toContainText('Airtable: added');

  // The customer accepts; the office sets Accepted in Airtable -> n8n 01 -> wf_quote_accepted (simulated delivery).
  const today = String((await one('select app_today()::text d')).d);
  const acc = await asWorkflow('select wf_quote_accepted($1::jsonb) r', [JSON.stringify({ event_id: 'EVT-E2E-SALES', correlation_id: 'CORR-E2E-SALES', event_type: 'quote.accepted',
    source: 'airtable', actor_id: 'airtable-automation', occurred_at: new Date().toISOString(), payload: { quote_id: Q, accepted_version: 1, accepted_on: today, airtable_record_id: 'recE2EQUOTE000001' } })]);
  expect(acc).toMatchObject({ status: 'CREATED' });
  await page.reload();
  await expect(nextStep(page)).toContainText(`Won: project ${String(acc.project_number)}`);
  await nextStep(page).getByRole('link', { name: `Open project ${String(acc.project_number)}` }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(String(acc.project_number));
  await expect(page.locator('main')).toContainText('Iris Journey');
  await page.goto('/sales');
  await expect(page.getByRole('region', { name: 'Won' })).toContainText('Iris Journey');
  // The accepted quote won the enquiry itself (not still "Quoted").
  await expect(page.getByRole('region', { name: 'Won' }).locator('.issue', { hasText: 'Iris Journey' })).not.toContainText('Quoted');
  expect((await one('select status from leads where contact_name = $1', ['Iris Journey'])).status).toBe('WON');

  // A look-alike: Noah Richards is already a customer. Adding him as new is refused; "Use" picks the existing one.
  await page.getByRole('form', { name: 'New enquiry' }).getByLabel('Name', { exact: true }).fill('Noah Richards');
  await page.getByRole('form', { name: 'New enquiry' }).getByLabel('Phone', { exact: true }).fill('0400 000003');
  await page.getByRole('form', { name: 'New enquiry' }).getByRole('button', { name: 'Record enquiry' }).click();
  await expect(page.getByRole('form', { name: 'New enquiry' }).getByRole('note')).toContainText('Possibly an existing customer: Noah Richards (CUST-0003');
  const L2 = String((await one(`select lead_number from leads where contact_name = 'Noah Richards' order by received_at desc limit 1`)).lead_number);
  await page.goto(`/sales/${L2}`);
  const c2 = page.getByRole('form', { name: `Customer and site for ${L2}` });
  await c2.getByLabel('Street address').fill('3 Coral Gum Drive');
  await c2.getByLabel('Suburb').fill('Bundaberg West');
  await c2.getByLabel('Postcode').fill('4670');
  await c2.getByRole('button', { name: 'Save customer and site' }).click();
  await expect(c2.getByRole('alert')).toContainText('already looks like Noah Richards (CUST-0003)');
  await expect(c2.getByLabel('Street address')).toHaveValue('3 Coral Gum Drive');   // kept
  await c2.getByRole('button', { name: 'Use Noah Richards (CUST-0003)' }).click();
  await c2.getByRole('button', { name: 'Save customer and site' }).click();
  await expect(page.getByRole('region', { name: '2. Customer and site' })).toContainText('Noah Richards (CUST-0003)');
  expect(await one(`select count(*)::int n from customers where display_name = 'Noah Richards'`)).toEqual({ n: 1 });

  // Field crew can look but not record.
  const crew = await signIn(browser, 'CREW', baseURL!);
  await crew.page.goto('/sales');
  await expect(crew.page.getByRole('form', { name: 'New enquiry' })).toHaveCount(0);
  await crew.page.goto(`/sales/${L2}`);
  await expect(crew.page.getByRole('button')).not.toContainText(['Mark contacted']);
  for (const c of [est.ctx, crew.ctx]) await c.close();
});

test('a second enquiry for the same caller is shown first and recorded only when confirmed; an admin corrects a phone number, and a stale screen never claims success', async ({ browser, baseURL }) => {
  const est = await signIn(browser, 'EST', baseURL!);
  const page = est.page;
  await page.goto('/sales');
  const form = page.getByRole('form', { name: 'New enquiry' });
  // Noah Richards has an open enquiry (from the journey above); the same phone, written differently, is caught.
  const open = String((await one(`select lead_number from leads where contact_name = 'Noah Richards' and status not in ('LOST', 'DISQUALIFIED', 'WON') order by received_at desc limit 1`)).lead_number);
  await form.getByLabel('Name', { exact: true }).fill('N Richards');
  await form.getByLabel('Phone', { exact: true }).fill('(04) 0000-0003');
  await form.getByRole('button', { name: 'Record enquiry' }).click();
  await expect(form.getByRole('alert')).toContainText('This person already has an open enquiry');
  await expect(form.getByRole('note', { name: 'Open enquiries for this person' })).toContainText(open);
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('N Richards');                 // kept after the refusal
  expect(await one(`select count(*)::int n from leads where contact_name = 'N Richards'`)).toEqual({ n: 0 });
  await form.getByLabel('This is a separate job: record it anyway').check();
  await form.getByRole('button', { name: 'Record enquiry' }).click();
  await expect(form.getByRole('status')).toContainText(/LEAD-\d{4}-\d{4} recorded/);
  expect(await one(`select count(*)::int n from leads where contact_name = 'N Richards'`)).toEqual({ n: 1 });

  // The estimator may not correct customer details; an admin may. A screen opened before someone else's change is refused.
  const L = String((await one(`select lead_number from leads where contact_name = 'Iris Journey'`)).lead_number);
  await page.goto(`/sales/${L}`);
  await expect(page.getByText('Correct phone or email')).toHaveCount(0);
  const admin = await signIn(browser, 'ADMIN', baseURL!);
  await admin.page.goto(`/sales/${L}`);
  const card = admin.page.getByRole('region', { name: '2. Customer and site' });
  await card.getByText('Correct phone or email').click();
  const fix = admin.page.getByRole('form', { name: /^Correct CUST-/ });
  await db.query(`update customers set phone = '0433 222 999' where display_name = 'Iris Journey'`);   // someone else, meanwhile
  await fix.getByLabel('Phone').fill('0433 222 112');
  await fix.getByLabel('Why (kept in the audit trail)').fill('Typo in the number');
  await fix.getByRole('button', { name: 'Save correction' }).click();
  await expect(fix.getByRole('alert')).toContainText('Someone changed this since you opened the page');
  await expect(card).not.toContainText('corrected');
  expect((await one(`select phone from customers where display_name = 'Iris Journey'`)).phone).toBe('0433 222 999');
  await admin.page.reload();
  await card.getByText('Correct phone or email').click();
  await fix.getByLabel('Phone').fill('0433 222 112');
  await fix.getByLabel('Why (kept in the audit trail)').fill('Typo in the number');
  await fix.getByRole('button', { name: 'Save correction' }).click();
  await expect(card).toContainText('corrected');
  expect(await one(`select c.phone, a.actor_id from customers c join audit_events a on a.entity_id = c.id and a.action = 'customer.contact_corrected' where c.display_name = 'Iris Journey' order by a.occurred_at desc limit 1`))
    .toMatchObject({ phone: '0433 222 112' });
});

test('a sent quote revised in the dashboard is not shown as in Airtable until the new version is there, and the old version cannot be accepted', async ({ browser, baseURL }) => {
  // Setup as the dashboard would have done it: Noah's enquiry (from the journey) quoted, sent and published to Airtable.
  const est = await signIn(browser, 'EST', baseURL!);
  const L = String((await one(`select lead_number from leads where contact_name = 'Noah Richards' and customer_id is not null order by received_at desc limit 1`)).lead_number);
  const tok = String(((await one('select web_staff_sign_in($1, $2) r', [env.PILOT_EST_LOGIN, env.PILOT_EST_PASSWORD])).r as R).token);
  const q = (await one(`select web_quote_save($1, $2, null, null, 'LEAK_REPAIR', 'INCLUSIVE', null, $3::jsonb, 'e2e-rev-quote-0001') r`,
    [tok, L, JSON.stringify([{ line_kind: 'LABOUR', description: 'Re-bed ridge', quantity: '10', unit: 'hrs', unit_price: '95' }])])).r as R;
  const Q = String(q.quote_number);
  const sent = (await one('select web_quote_send($1, $2, $3) r', [tok, Q, (await one('select record_version::int v from quotes where quote_number = $1', [Q])).v])).r as R;
  const key = String(sent.airtable_key);
  await asWorkflow(`select wf_claim_side_effect($1, 'n8n:10', 120) r`, [key]);
  const p = (await one('select payload from outbox where idempotency_key = $1', [key])).payload as R;
  const ids = { q: 'recE2EREVQUOTE001', c: 'recE2EREVCUST0001', p: 'recE2EREVPROP0001' };
  expect(await asWorkflow(`select wf_complete_side_effect($1, $2::jsonb) r`, [key, JSON.stringify({ verified: true, quote_number: Q, customer_number: p.customer_number,
    property_number: p.property_number, quote_record_id: ids.q, customer_record_id: ids.c, property_record_id: ids.p, quote_customer_link_ids: [ids.c], quote_property_link_ids: [ids.p],
    customer_read_back: { id: ids.c, roofops_id: p.customer_id, number: p.customer_number },
    property_read_back: { id: ids.p, roofops_id: p.property_id, number: p.property_number, owner_link_ids: [ids.c] },
    quote_read_back: { id: ids.q, roofops_id: p.quote_id, number: Q, version: 1, amount: 950, customer_link_ids: [ids.c], property_link_ids: [ids.p] } })])).toMatchObject({ status: 'RECORDED' });

  const page = est.page;
  await page.goto(`/sales/${L}`);
  const qcard = page.locator(`[data-quote="${Q}"]`);
  await expect(qcard).toContainText('Airtable: added');
  // The estimator revises the sent quote (more labour).
  await page.getByRole('region', { name: '4. Quote' }).getByText(`Revise ${Q}`).click();
  const form = page.getByRole('form', { name: `Revise ${Q}` });
  await form.getByLabel('Line 1 quantity').fill('12');
  await form.getByRole('button', { name: 'Save as version 2' }).click();
  await expect(page.locator(`[data-quote="${Q}"]`)).toContainText('version 2');
  await expect(page.locator(`[data-quote="${Q}"]`)).toContainText('Airtable: being added');
  await expect(page.locator(`[data-quote="${Q}"]`)).not.toContainText('Airtable: added');
  await expect(page.getByRole('region', { name: 'Next step' })).toContainText('being added to Airtable');
  expect(await one('select status, (payload -> \'quote_fields\' ->> \'fldEjEqlzE8Y0M1nf\')::int v from outbox where idempotency_key = $1', [`${key}:v2`])).toEqual({ status: 'PENDING', v: 2 });
  // The office accepts what Airtable still shows (version 1): refused, no project.
  const acc = await asWorkflow('select wf_quote_accepted($1::jsonb) r', [JSON.stringify({ event_id: 'EVT-E2E-REV-OLD', correlation_id: 'CORR-E2E-REV', event_type: 'quote.accepted',
    source: 'airtable', actor_id: 'airtable-automation', occurred_at: new Date().toISOString(), payload: { quote_id: Q, accepted_version: 1 } })]);
  expect(acc).toMatchObject({ status: 'REJECTED', error_class: 'INVALID_STATE' });
  expect(await one('select count(*)::int n from projects p join quotes q on q.id = p.quote_id where q.quote_number = $1', [Q])).toEqual({ n: 0 });
});
