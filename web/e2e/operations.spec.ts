import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * Core business operations, end to end, on the LOCAL rehearsal database only (scripts/pilot-rehearsal.ts --reset).
 * Opt-in: E2E_PILOT=1. Each backend step is the real database function n8n calls, run AS the workflow role with the
 * event n8n sends; after each step the dashboard must show staff the true state and the next action. Nothing leaves
 * this machine: the Xero draft is completed with the read-back proof 05 would send (no Xero call).
 */
const enabled = process.env.E2E_PILOT === '1';
const env = enabled ? parseEnv(readFileSync('e2e/.auth/pilot.env', 'utf8')) : {};
const APPROVER = 'usr7uCnNO15fCefbH';   // the Airtable finance approver mapped to EMP-900 in the dataset
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
/** One call exactly as n8n makes it: as roofops_workflow, which can run the entry points and read nothing else. */
async function asWorkflow(fn: string, ...args: unknown[]): Promise<R> {
  await db.query('set role roofops_workflow');
  try {
    const ph = args.map((a, i) => (typeof a === 'object' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ');
    return (await one<{ r: R }>(`select ${fn}(${ph}) r`, args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a)))).r;
  } finally {
    await db.query('reset role');
  }
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(env.PILOT_ADMIN_LOGIN ?? '');
  await page.getByLabel('Password').fill(env.PILOT_ADMIN_PASSWORD ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}
const financeCard = (page: Page) => page.locator('section.card', { hasText: 'Invoice history' });

test('quote accepted → exactly one project, visible to staff with its checklist; a redelivery or a bad event changes nothing', async ({ page }) => {
  await signIn(page);
  const projectsBefore = Number((await one<{ n: string }>('select count(*)::text n from projects')).n);
  const event = { event_id: 'EVT-PILOT-Q31', correlation_id: 'CORR-PILOT-Q31', event_type: 'quote.accepted', source: 'airtable', actor_id: 'airtable-automation',
    occurred_at: new Date().toISOString(), payload: { quote_id: 'Q-2026-0031', accepted_version: 2, accepted_on: '2026-09-29', airtable_record_id: 'recPILOTQ31000001' } };
  const created = await asWorkflow('wf_quote_accepted', event);
  expect(created).toMatchObject({ status: 'CREATED' });
  const project = String(created.project_number);
  expect(await asWorkflow('wf_quote_accepted', event)).toMatchObject({ project_number: project });                     // transport redelivery
  expect(await asWorkflow('wf_quote_accepted', { ...event, event_id: 'EVT-PILOT-Q31-B' })).not.toMatchObject({ status: 'CREATED' });  // semantic duplicate
  expect(Number((await one<{ n: string }>('select count(*)::text n from projects')).n)).toBe(projectsBefore + 1);

  await page.goto('/projects');
  await page.getByRole('searchbox').fill('Q-2026-0031');
  await expect(page.locator('table.data tbody tr.clickable')).toHaveCount(1);
  await page.locator('table.data tbody tr.clickable').first().locator('td').nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project}$`));
  await expect(page.getByRole('heading', { level: 1 })).toContainText(project);
  await expect(page.locator('main')).toContainText('Q-2026-0031');
  await expect(page.getByRole('heading', { name: /Checklist/ })).toBeVisible();

  // A malformed acceptance is refused with one open issue staff can read, never a project.
  const bad = await asWorkflow('wf_quote_accepted', { ...event, event_id: 'EVT-PILOT-BAD', payload: { accepted_version: 1 } });
  expect(bad).toMatchObject({ status: 'REJECTED' });
  expect(Number((await one<{ n: string }>('select count(*)::text n from projects')).n)).toBe(projectsBefore + 1);
  await page.goto('/automation');
  await expect(page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Needs a person' }) })).toContainText('Invalid quote.accepted event: payload.quote_id: required');
});

test('ordinary final invoice: prepare → staff see it awaiting approval → approve → creating in Xero → draft in Xero; a repeat approval does nothing', async ({ page }) => {
  await signIn(page);
  const p = 'PRJ-2026-0004';
  const row = await one<{ rec: string; id: string }>(`select l.external_id rec, p.id::text id from projects p join external_links l on l.provider = 'AIRTABLE'
      and l.entity_type = 'project' and l.external_type = 'Record' and l.entity_id = p.id where p.project_number = $1`, [p]);
  const base = { source: 'airtable', actor_id: APPROVER, actor_name: 'Demo Finance Approver', payload: { project_number: p, airtable_record_id: row.rec, project_uuid: row.id } };

  await page.goto(`/projects/${p}`);
  await expect(financeCard(page)).toContainText('Ready to invoice');

  // 1. Prepare (Airtable Invoice Action), then 04's verified write-back of the preview text, as n8n does.
  const prep = await asWorkflow('wf_invoice_prepare', { ...base, event_id: 'airtable:PILOT:prep1', correlation_id: 'airtable:PILOT:prep1',
    event_type: 'invoice.prepare_requested', occurred_at: new Date().toISOString() }, 'n8n:04');
  expect(prep, JSON.stringify(prep).slice(0, 300)).toMatchObject({ outcome: 'PREVIEW_READY' });
  // Exactly the text 04 writes to the row and reads back (test/helpers/airtable04.ts); approval is bound to it.
  const pv = prep.preview as R;
  const aud = (v: unknown) => `$${Number(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  const shown = `${String(prep.preview_marker)} - awaiting approval by a finance approver\nProject: ${String(pv.project_number)}   Customer: ${String(pv.customer_name)}\n`
    + `Amount: ${aud(pv.amount_inc_gst)} inc GST  (GST ${aud(pv.gst_amount)}, ex GST ${aud(pv.amount_ex_gst)})\nTo create it, set Invoice Action = Approve Xero draft invoice.`
    + '\n[event airtable:PILOT:prep1]';
  await asWorkflow('wf_invoice_preview_verified', 'airtable:PILOT:prep1', row.rec, shown);
  await page.reload();
  await expect(financeCard(page)).toContainText('Prepared, awaiting approval');
  await expect(financeCard(page)).toContainText('Next, for a finance approver in Airtable');
  await expect(financeCard(page)).toContainText(String(prep.approval_number));
  await page.goto('/finance');
  await expect(page.locator('main')).toContainText(p);

  // 2. Approve with the text the row shows: one FINAL invoice and one queued Xero write.
  const approve = { ...base, event_id: 'airtable:PILOT:approve1', correlation_id: 'airtable:PILOT:approve1', event_type: 'invoice.approved',
    occurred_at: new Date().toISOString(), payload: { ...base.payload, displayed_preview: shown } };
  const decided = await asWorkflow('wf_invoice_decide', approve, 'n8n:04');
  expect(decided, JSON.stringify(decided).slice(0, 400)).toMatchObject({ outcome: 'APPROVED' });
  const counts = () => one<{ finals: string; writes: string }>(`select (select count(*)::text from invoices where project_id = $1 and invoice_type = 'FINAL') finals,
      (select count(*)::text from outbox o join invoices i on i.id = o.aggregate_id where i.project_id = $1 and o.topic = 'xero.create_draft_invoice') writes`, [row.id]);
  expect(await counts()).toEqual({ finals: '1', writes: '1' });
  await page.goto(`/projects/${p}`);
  await expect(financeCard(page)).toContainText('Creating in Xero');
  await expect(page.getByRole('link', { name: 'Open in Xero' })).toHaveCount(0);

  // 3. A repeat approval (redelivery and a second click) creates nothing more.
  await asWorkflow('wf_invoice_decide', approve, 'n8n:04');
  await asWorkflow('wf_invoice_decide', { ...approve, event_id: 'airtable:PILOT:approve2', correlation_id: 'airtable:PILOT:approve2' }, 'n8n:04');
  expect(await counts()).toEqual({ finals: '1', writes: '1' });

  // 4. 05 creates the draft (simulated read-back proof; no Xero call): staff see the draft, its number and the Xero link.
  const w = await one<{ key: string; payload: R; invoice: string }>(`select o.idempotency_key key, o.payload, i.invoice_number invoice from outbox o
      join invoices i on i.id = o.aggregate_id where i.project_id = $1 and o.topic = 'xero.create_draft_invoice'`, [row.id]);
  expect(await asWorkflow('wf_claim_side_effect', w.key, 'n8n:05', 120)).toMatchObject({ claimed: true });
  const xid = uuidFor(`pilot-ordinary:${w.key}`);
  const pl = w.payload;
  await asWorkflow('wf_complete_side_effect', w.key, { verified: true, tenant_id: pl.xero_tenant_id, organisation_class: 'DEMO', invoice_id: xid,
    invoice_number: pl.xero_invoice_number, reference: pl.reference, status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false,
    contact_id: uuidFor(`contact:${String(pl.customer_id)}`), contact_number: pl.xero_contact_number, total: pl.amount_inc_gst, total_tax: pl.gst_amount,
    currency: 'AUD', line_amount_types: 'Inclusive', matching_invoices: 1 });
  await page.goto(`/projects/${p}`);
  await expect(financeCard(page)).toContainText('Draft in Xero');
  await expect(financeCard(page)).toContainText(String(pl.xero_invoice_number));
  await expect(page.getByRole('link', { name: 'Open in Xero' })).toHaveAttribute('href', new RegExp(xid));
  await expect(page.getByRole('group', { name: /Xero documents for/ })).toHaveCount(0);   // one document: no reissue history
  await expect(financeCard(page)).toContainText(w.invoice);
});
