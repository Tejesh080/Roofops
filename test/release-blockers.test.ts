/**
 * Release blockers (migration 20261017030000 + SALES-01 changes), each test stating the business rule it challenges:
 *  1. Business date: real vs explicitly synthetic; Brisbane calendar at exact instants incl. the Adelaide daylight-saving
 *     changes; overdue boundaries; switching the mode never rewrites a stored date or amount.
 *  2. GST: every Xero line carries its share of the invoice GST and the shares add up exactly (FIN-GST-01); a final with
 *     variation lines is stopped before approval until per-line GST is enabled; GST-exclusive quotes are refused at quote time.
 *  3. integrity_check fails closed for unknown topics and missing quote proof; abandoned claims are reported.
 *  4. Duplicate enquiries are shown before a second one is recorded; a customer's phone/email can be corrected without
 *     changing what was already invoiced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPostgres, type Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';
import { recorded } from './helpers/n8n-sdk-shim.js';
import { N8nRun, type HttpRequest } from './helpers/n8n-runner.js';
import { businessDateNotice, longDate } from '../web/lib/business-date.ts';

type R = Record<string, unknown>;
const PW = 'release test password 1';
const TENANT = '11111111-2222-3333-4444-555555555555';
const DEMO = '2026-09-29';

describe.each(TARGETS)('release blockers [%s]', (target) => {
  let db: Db;
  const tok: Record<string, string> = {};
  const one = async (sql: string, p: unknown[] = []) => (await db.query<R>(sql, p))[0]!;
  const call = async (sql: string, p: unknown[]) => (await one(sql, p)).r as R;
  const setting = (k: string, v: string | null) => v === null
    ? db.query('delete from app_settings where key = $1', [k])
    : db.query('insert into app_settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [k, v]);
  const today = async () => String((await one('select app_today()::text d')).d);
  const realToday = async () => String((await one(`select ((now() at time zone 'Australia/Brisbane')::date)::text d`)).d);
  const synthetic = async (d = DEMO) => { await setting('business_date_mode', 'SYNTHETIC'); await setting('business_date_override', d); };
  const asDashboard = async <T>(fn: () => Promise<T>) => { await db.exec('begin; set local role roofops_dashboard'); try { return await fn(); } finally { await db.exec('rollback'); } };
  const prepare = (prj: string) => call('select web_invoice_prepare($1, $2) r', [tok.finance, prj]);
  const approve = (p: R) => call('select web_invoice_decide($1, $2, $3, $4, $5) r', [tok.admin, p.approval_number, p.payload_hash, 'approve', null]);
  const integrity = async (key: string) => one('select status, failing, refs from integrity_check() where check_key = $1', [key]);

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.query(`update app_settings set value = $1 where key = 'xero.demo_tenant_id'`, [TENANT]);
    await db.query(`insert into employees (employee_code, full_name, email, role, is_active) values
      ('EMP-801', 'Synthetic Finance', 'f@example.test', 'FINANCE', true), ('EMP-802', 'Synthetic Admin', 'a@example.test', 'ADMIN', true)`);
    for (const [emp, login] of [['EMP-801', 'finance'], ['EMP-802', 'admin'], ['EMP-002', 'estimator']] as const) {
      await db.query('select ops_staff_set_password($1, $2, $3)', [emp, login, PW]);
      tok[login] = String((await call('select web_staff_sign_in($1, $2) r', [login, PW])).token);
    }
  }, 180_000);
  afterAll(async () => { await db.close(); });

  // ---------------------------------------------------------------------------------------------- 1. business date
  describe('1. business date', () => {
    it('a database loaded from the demo bundle runs explicitly on the synthetic date; REAL means the real Brisbane date and ignores a leftover override', async () => {
      expect(await one(`select value from app_settings where key = 'business_date_mode'`)).toEqual({ value: 'SYNTHETIC' });
      expect(await today()).toBe(DEMO);
      try {
        await setting('business_date_mode', 'REAL');
        expect(await today()).toBe(await realToday());                        // the override (still set) is ignored
        expect(await integrity('business_date')).toMatchObject({ status: 'WARNING', refs: [`ignored override ${DEMO}`] });
        await setting('business_date_override', '');
        expect(await integrity('business_date')).toMatchObject({ status: 'PASS' });
        await setting('business_date_mode', null);                              // no mode at all: real, never a guess
        expect(await today()).toBe(await realToday());
      } finally { await synthetic(); }
      expect(await integrity('business_date')).toMatchObject({ status: 'WARNING', refs: [`synthetic ${DEMO}`, `real ${await realToday()}`] });
    });

    it('SYNTHETIC without a valid date, or an unknown mode, is refused rather than silently falling back to another date', async () => {
      try {
        for (const bad of ['', 'not-a-date', '2026-02-30']) {
          await setting('business_date_override', bad);
          await expect(today()).rejects.toThrow(/business_date_override .* is not a date/);
        }
        await setting('business_date_override', DEMO); await setting('business_date_mode', 'DEMO');
        await expect(today()).rejects.toThrow(/neither REAL nor SYNTHETIC/);
      } finally { await synthetic(); }
    });

    it('the business calendar is Brisbane\'s (no daylight saving): exact instants around midnight and both Adelaide daylight-saving changes', async () => {
      const at = async (iso: string) => (await one(`select app_date_at($1::timestamptz)::text b, (($1::timestamptz) at time zone 'Australia/Adelaide')::date::text adl`, [iso])) as { b: string; adl: string };
      expect(await at('2026-09-29T13:59:59Z')).toMatchObject({ b: '2026-09-29' });        // 23:59:59 Brisbane
      expect(await at('2026-09-29T14:00:00Z')).toMatchObject({ b: '2026-09-30' });        // midnight Brisbane
      // Adelaide moves to daylight time on Sun 4 Oct 2026 (02:00 ACST -> 03:00 ACDT). 23:45 Brisbane is already 00:15 the
      // next day in Adelaide: an Adelaide user sees the Brisbane business date, not their own.
      expect(await at('2026-10-04T13:45:00Z')).toEqual({ b: '2026-10-04', adl: '2026-10-05' });
      expect(await at('2026-10-04T14:00:00Z')).toEqual({ b: '2026-10-05', adl: '2026-10-05' });
      // Adelaide leaves daylight time on Sun 5 Apr 2026 (03:00 ACDT -> 02:00 ACST).
      expect(await at('2026-04-04T13:45:00Z')).toEqual({ b: '2026-04-04', adl: '2026-04-05' });
      expect(await at('2026-04-05T13:45:00Z')).toEqual({ b: '2026-04-05', adl: '2026-04-05' });
    });

    it('overdue follows today exactly: due today is not overdue, due yesterday is one day overdue', async () => {
      const inv = await one(`select invoice_number, due_date::text due from invoices where status in ('ISSUED', 'PARTIALLY_PAID') order by due_date desc limit 1`);
      const row = async () => asDashboard(() => one(`select is_overdue, days_past_due from v_invoice_balances where invoice_number = $1`, [inv.invoice_number]));
      try {
        await synthetic(String(inv.due));
        expect(await row()).toEqual({ is_overdue: false, days_past_due: 0 });
        await synthetic(String((await one(`select ($1::date + 1)::text d`, [inv.due])).d));
        expect(await row()).toEqual({ is_overdue: true, days_past_due: 1 });
      } finally { await synthetic(); }
    });

    it('a new invoice is dated with the real date in REAL mode and the synthetic date in SYNTHETIC mode; due = date + payment terms', async () => {
      const terms = Number((await one(`select value from app_settings where key = 'invoice.payment_terms_days'`)).value);
      const preview = async () => ((await call('select invoice_final_preview(id) r from projects where project_number = $1', ['PRJ-2026-0004'])).preview as R);
      expect(await preview()).toMatchObject({ invoice_date: DEMO, due_date: String((await one(`select ($1::date + $2::int)::text d`, [DEMO, terms])).d) });
      try {
        await setting('business_date_mode', 'REAL');
        const real = await realToday();
        expect(await preview()).toMatchObject({ invoice_date: real, due_date: String((await one(`select ($1::date + $2::int)::text d`, [real, terms])).d) });
      } finally { await synthetic(); }
    });

    it('switching between synthetic and real never changes a stored date or amount (only what is derived from "today")', async () => {
      const fingerprint = async () => String((await one(`select md5(string_agg(x, '|' order by x)) h from (
        select 'i' || invoice_number || coalesce(issue_date::text, '') || coalesce(due_date::text, '') || total_inc_gst || gst_amount || status x from invoices
        union all select 'q' || quote_number || created_on || coalesce(sent_on::text, '') || coalesce(valid_until::text, '') || coalesce(accepted_on::text, '') from quotes
        union all select 'p' || project_number || coalesce(planned_start_date::text, '') || coalesce(planned_completion_date::text, '') || coalesce(actual_start_date::text, '') || coalesce(actual_completion_date::text, '') from projects
        union all select 't' || id || coalesce(due_on::text, '') || status from tasks
        union all select 'a' || approval_number || status || coalesce(decided_at::text, '') from approvals) s`)).h);
      const before = await fingerprint();
      try {
        await setting('business_date_mode', 'REAL');
        await db.query('select * from integrity_check()');
        await asDashboard(() => db.query('select * from v_dashboard_projects'));
        await asDashboard(() => db.query('select * from v_invoice_balances'));
        expect(await fingerprint()).toBe(before);
      } finally { await synthetic(); }
      expect(await fingerprint()).toBe(before);
    });

    it('the dashboard learns whether the date is real without reading settings, and the banner says so in words', async () => {
      const b = await asDashboard(() => one('select app_business_date() b')) as { b: { date: string; real_date: string; synthetic: boolean; mode: string } };
      expect(b.b).toMatchObject({ date: DEMO, synthetic: true, mode: 'SYNTHETIC', real_date: await realToday() });
      await expect(asDashboard(() => db.query(`select value from app_settings where key = 'business_date_mode'`))).rejects.toThrow(/permission denied/);
      expect(businessDateNotice({ date: DEMO, real_date: '2026-10-17', synthetic: true })).toBe('Business date 29 Sep 2026 (synthetic, for demo data; today is 17 Oct 2026)');
      expect(businessDateNotice({ date: '2026-10-17', real_date: '2026-10-17', synthetic: false })).toBe('Today 17 Oct 2026');
      expect(longDate('2027-01-05')).toBe('5 Jan 2027');
    });
  });

  // ----------------------------------------------------------------------------------------------------- 2. GST
  describe('2. GST', () => {
    const split = async (amounts: number[], gst: number) =>
      ((await call('select gst_line_tax($1::jsonb, $2) r', [JSON.stringify(amounts.map((a, i) => ({ line_no: i + 1, quantity: 1, unit_amount: a }))), gst])) as unknown as R[])
        .map((l) => Number(l.tax_amount));

    it('FIN-GST-01: two lines of $100.05 carry GST 18.19 in total (rounded once), not the 18.20 per-line rounding would give', async () => {
      // Independent arithmetic: each line's exact GST is 100.05/11 = 9.0954..; rounded per line 9.10 + 9.10 = 18.20,
      // while the invoice total 200.10/11 = 18.1909.. rounds to 18.19. Without explicit line tax Xero and RoofOps differ.
      expect(Math.round((200.10 / 11) * 100) / 100).toBe(18.19);
      const shares = await split([100.05, 100.05], 18.19);
      expect(shares).toEqual([9.10, 9.09]);
      expect(Math.round(shares.reduce((a, b) => a + b, 0) * 100)).toBe(1819);
    });

    it('for any set of lines the shares add up to the invoice GST to the cent and no share is more than a cent from its exact value', async () => {
      let seed = 20261017;
      const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      for (let k = 0; k < 120; k++) {
        const cents = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => 1 + Math.floor(rnd() * 5_000_000));
        const totalCents = cents.reduce((a, b) => a + b, 0);
        const gstCents = Math.round(totalCents / 11);                            // RoofOps: GST rounded once on the total
        const shares = await split(cents.map((c) => c / 100), gstCents / 100);
        expect(Math.round(shares.reduce((a, b) => a + b, 0) * 100), `lines ${cents.join(',')}`).toBe(gstCents);
        shares.forEach((s, i) => { expect(Math.abs(s * 100 - cents[i]! / 11), `line ${i} of ${cents.join(',')}`).toBeLessThan(1); });
      }
      expect(await split([14664.49], 1333.14)).toEqual([1333.14]);               // one line: exactly the invoice GST
    });

    it('a single-line final carries exactly its GST on the line, in the preview and in the Xero payload, and approval still agrees with the preview', async () => {
      const p = await prepare('PRJ-2026-0004');
      expect(p, JSON.stringify(p)).toMatchObject({ ok: true, outcome: 'PREVIEW_READY' });
      const ap = await one('select action_payload a from approvals where approval_number = $1', [p.approval_number]);
      const prev = ap.a as { lines: R[]; gst_amount: unknown; amount_inc_gst: unknown };
      expect(prev.lines).toHaveLength(1);
      expect(Number(prev.lines[0]!.tax_amount)).toBe(Number(prev.gst_amount));
      const d = await approve(p);
      expect(d, JSON.stringify(d)).toMatchObject({ ok: true, outcome: 'APPROVED' });
      const o = await one('select payload from outbox where idempotency_key = $1', [d.xero_key]);
      const pl = o.payload as { lines: R[]; gst_amount: unknown };
      expect(pl.lines.map((l) => Number(l.tax_amount))).toEqual([Number(pl.gst_amount)]);
      expect(await one('select gst_amount::float8 g from invoices where invoice_number = $1', [d.invoice_number])).toEqual({ g: Number(prev.gst_amount) });
    });

    it('a final with a variation line is stopped at preview (no approval, no Xero write) while per-line GST is off; once on, the shares travel to the invoice and Xero payload and add up', async () => {
      const prj = String((await one(`select project_number p from v_dashboard_projects where invoice_status = 'READY_TO_INVOICE' and project_number <> 'PRJ-2026-0004' order by 1 limit 1`)).p);
      await db.query(`insert into variations (variation_number, project_id, description, amount_inc_gst, status, customer_approved_at, approved_by)
        select 'VAR-REL-0001', id, 'Extra flashing (synthetic)', 100.05, 'APPROVED', now(), (select id from employees where employee_code = 'EMP-802') from projects where project_number = $1`, [prj]);
      const refused = await prepare(prj);
      expect(refused).toMatchObject({ ok: false });
      expect(String(refused.detail ?? refused.message)).toMatch(/variation lines .* cannot go to Xero yet/);
      expect(await one(`select count(*)::int n from approvals where business_reference = $1 and action_type = 'CREATE_INVOICE'`, [prj])).toEqual({ n: 0 });
      try {
        await setting('xero.line_tax_amounts', 'on');
        const p = await prepare(prj);
        expect(p, JSON.stringify(p)).toMatchObject({ ok: true, outcome: 'PREVIEW_READY' });
        const d = await approve(p);
        expect(d, JSON.stringify(d)).toMatchObject({ ok: true, outcome: 'APPROVED' });
        const inv = await one('select gst_amount::float8 g, total_inc_gst::float8 t from invoices where invoice_number = $1', [d.invoice_number]);
        const pl = (await one('select payload from outbox where idempotency_key = $1', [d.xero_key])).payload as { lines: R[]; gst_amount: unknown; amount_inc_gst: unknown };
        expect(pl.lines).toHaveLength(2);
        expect(Math.round(pl.lines.reduce((a, l) => a + Number(l.tax_amount), 0) * 100)).toBe(Math.round(inv.g as number * 100));
        expect(Math.round(pl.lines.reduce((a, l) => a + Number(l.quantity) * Number(l.unit_amount), 0) * 100)).toBe(Math.round(inv.t as number * 100));
        expect(Number(pl.gst_amount)).toBe(inv.g);
      } finally { await setting('xero.line_tax_amounts', 'off'); }
    });

    it('n8n 05 (its real node) sends each line\'s TaxAmount when the payload has one, and exactly the old request when it does not', async () => {
      if (!recorded.nodes.has('Create DRAFT Invoice')) {                     // the module registers its nodes once per test file
        recorded.nodes.clear(); recorded.edges.length = 0;
        const sdk = '../n8n/05-xero-draft-invoice.sdk.ts';
        await import(/* @vite-ignore */ sdk);
      }
      const body = async (lines: R[]) => {
        let sent: HttpRequest | null = null;
        const r = new N8nRun(recorded.nodes, recorded.edges, { db: { query: () => { throw new Error('no db'); } } as unknown as Db,
          http: (req) => { sent = req; return { statusCode: 200, body: { Invoices: [{ InvoiceID: 'x' }] } }; } });
        r.seed('Claim Xero Draft', [{ json: { c: { claimed: true, attempt: 1, payload: { xero_tenant_id: TENANT, xero_idempotency_key: 'k', invoice_date: DEMO, due_date: DEMO,
          xero_invoice_number: 'RO-INV-2026-0099', reference: 'PRJ-2026-0099', xero_account_code: '200', xero_tax_type: 'OUTPUT', lines } } } }]);
        await r.run('Create DRAFT Invoice', [{ json: { contact_id: 'c' } }], recorded.edges.filter((e) => e.from === 'Create DRAFT Invoice').map((e) => e.to));
        return ((sent as unknown as HttpRequest).body as { Invoices: { LineItems: R[]; LineAmountTypes: string }[] }).Invoices[0]!;
      };
      const withTax = await body([{ description: 'a', quantity: 1, unit_amount: 100.05, tax_amount: 9.10 }, { description: 'b', quantity: 1, unit_amount: 100.05, tax_amount: 9.09 }]);
      expect(withTax.LineItems.map((l) => l.TaxAmount)).toEqual([9.10, 9.09]);
      expect(withTax.LineAmountTypes).toBe('Inclusive');
      // CC-04: a single line carries its tax share too, but 05 sends it only on a multi-line draft (which the switch gates), so a
      // single-line draft is exactly today's request.
      const single = await body([{ description: 'a', quantity: 1, unit_amount: 100.05, tax_amount: 9.10 }]);
      expect(single.LineItems).toEqual([{ Description: 'a', Quantity: 1, UnitAmount: 100.05, AccountCode: '200', TaxType: 'OUTPUT' }]);
      const old = await body([{ description: 'a', quantity: 1, unit_amount: 100.05 }]);
      expect(old.LineItems).toEqual([{ Description: 'a', Quantity: 1, UnitAmount: 100.05, AccountCode: '200', TaxType: 'OUTPUT' }]);
    });

    it('a GST-exclusive or GST-free quote is refused when it is saved, long before invoicing; a legacy exclusive quote is still refused at the invoice preview', async () => {
      const lead = await call('select web_lead_create($1,$2,$3,$4,$5,$6,$7,$8,$9) r', [tok.estimator, 'Gina Gst', '0411 222 333', null, '5 Tax St', 'PHONE', null, 'rel-lead-gst-01', false]);
      expect(lead).toMatchObject({ ok: true });
      await call('select web_lead_convert($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) r', [tok.estimator, lead.lead_number, 1, null,
        JSON.stringify({ display_name: 'Gina Gst', customer_type: 'RESIDENTIAL', phone: '0411 222 333' }), JSON.stringify({ address_line1: '5 Tax St', suburb: 'Avoca', state: 'QLD', postcode: '4670' }), true]);
      for (const t of ['EXCLUSIVE', 'NO_TAX']) {
        expect(await call('select web_quote_save($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) r', [tok.estimator, lead.lead_number, null, null, 'LEAK_REPAIR', t, null,
          JSON.stringify([{ line_kind: 'LABOUR', description: 'Work', quantity: '1', unit: 'hrs', unit_price: '100' }]), `rel-quote-gst-${t}`]))
          .toMatchObject({ ok: false, code: 'INVALID', detail: expect.stringMatching(/prices must include GST/) as unknown });
      }
      expect(await one(`select count(*)::int n from quotes q join leads l on l.id = q.lead_id where l.lead_number = $1`, [lead.lead_number])).toEqual({ n: 0 });
      // Backstop: an exclusive accepted quote that exists anyway (imported) never reaches an invoice.
      await db.query(`update quote_versions set line_amount_type = 'EXCLUSIVE' where id = (select accepted_quote_version_id from projects where project_number = 'PRJ-2026-0002')`);
      expect(await call('select invoice_final_preview(id) r from projects where project_number = $1', ['PRJ-2026-0002'])).toMatchObject({ ok: false, error_class: 'SCHEMA_MISMATCH' });
    });
  });

  // ------------------------------------------------------------------------------------------------ 3. integrity
  describe('3. integrity_check', () => {
    it('a DONE side effect of an unknown topic fails (it used to pass); a DONE quote hand-off needs its quote, customer and property records', async () => {
      expect(await integrity('done_has_proof')).toMatchObject({ status: 'PASS' });
      const q = await one(`select q.id, q.customer_id, q.property_id, q.quote_number from quotes q order by quote_number limit 1`);
      await db.query(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, status)
        values ('mystery.topic', 'quote', $1, gen_random_uuid(), 'rel:mystery', '{}', 'DONE')`, [q.id]);
      expect(await integrity('done_has_proof')).toMatchObject({ status: 'FAIL', refs: [`mystery.topic:${String(q.id)}`] });
      await db.query(`delete from outbox where idempotency_key = 'rel:mystery'`);
      await db.query(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, status)
        values ('airtable.quote_publish', 'quote', $1, gen_random_uuid(), 'rel:qp', jsonb_build_object('quote_number', $2::text, 'customer_id', $3::text, 'property_id', $4::text), 'DONE')`,
        [q.id, q.quote_number, q.customer_id, q.property_id]);
      const hasLinks = Number((await one(`select count(*)::int n from external_links where provider = 'AIRTABLE' and external_type = 'Record' and verified_at is not null
        and entity_id in ($1, $2, $3)`, [q.id, q.customer_id, q.property_id])).n);
      expect(await integrity('done_has_proof')).toMatchObject({ status: hasLinks === 3 ? 'PASS' : 'FAIL' });
      await db.query(`delete from external_links where provider = 'AIRTABLE' and entity_id = $1`, [q.id]);
      expect(await integrity('done_has_proof')).toMatchObject({ status: 'FAIL', refs: [`airtable.quote_publish:${String(q.quote_number)}`] });
      await db.query(`delete from outbox where idempotency_key = 'rel:qp'`);
      expect(await integrity('done_has_proof')).toMatchObject({ status: 'PASS' });
    });

    it('a side effect a worker claimed and abandoned (lease over 15 minutes ago) is reported; one being worked on is not', async () => {
      const p = await one(`select id, project_number from projects order by project_number limit 1`);
      await db.query(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, status, locked_until, attempts)
        values ('drive.ensure_project_folder', 'project', $1, gen_random_uuid(), 'rel:abandoned', jsonb_build_object('project_number', $2::text), 'DISPATCHING', now() + interval '2 minutes', 1)`, [p.id, p.project_number]);
      expect(await integrity('claimed_and_abandoned')).toMatchObject({ status: 'PASS' });
      await db.query(`update outbox set locked_until = now() - interval '16 minutes' where idempotency_key = 'rel:abandoned'`);
      expect(await integrity('claimed_and_abandoned')).toMatchObject({ status: 'WARNING', refs: [`drive.ensure_project_folder:${String(p.project_number)}`] });
      await db.query(`delete from outbox where idempotency_key = 'rel:abandoned'`);
    });

    it('every existing integration still refuses to record success without its proof (one shared completion function)', async () => {
      const p = await one(`select id from projects order by project_number limit 1`);
      for (const topic of ['drive.ensure_project_folder', 'airtable.project_writeback', 'airtable.quote_publish']) {
        const key = `rel:noproof:${topic}`;
        await db.query(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, status, locked_until, attempts)
          values ($1, 'project', $2, gen_random_uuid(), $3, '{}', 'DISPATCHING', now() + interval '2 minutes', 1)`, [topic, p.id, key]);
        for (const proof of [{}, { verified: true }]) {
          await expect(db.query('select wf_complete_side_effect($1, $2::jsonb)', [key, JSON.stringify(proof)]), `${topic} ${JSON.stringify(proof)}`).rejects.toThrow();
        }
        expect(await one('select status from outbox where idempotency_key = $1', [key])).toEqual({ status: 'DISPATCHING' });
        await db.query('delete from outbox where idempotency_key = $1', [key]);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------ 4. employees
  describe('4. employee-facing', () => {
    const lead = (o: { name: string; phone?: string | null; email?: string | null; key: string; confirm?: boolean; t?: string }) =>
      call('select web_lead_create($1,$2,$3,$4,$5,$6,$7,$8,$9) r', [o.t ?? tok.estimator, o.name, o.phone ?? null, o.email ?? null, null, 'PHONE', null, o.key, o.confirm ?? false]);

    it('a second enquiry for the same person (phone written differently) is shown first and recorded only when confirmed as separate; closed enquiries and other people do not block', async () => {
      const first = await lead({ name: 'Dora Double', phone: '0412 555 001', key: 'rel-dup-0001' });
      expect(first).toMatchObject({ ok: true });
      const again = await lead({ name: 'D. Double', phone: '(04) 1255-5001', key: 'rel-dup-0002' });
      expect(again).toMatchObject({ ok: false, code: 'POSSIBLE_DUPLICATE_ENQUIRY', similar_enquiries: [{ lead_number: first.lead_number, reasons: ['same phone'] }] });
      expect(await lead({ name: 'Dora Double', email: 'other@example.test', key: 'rel-dup-0003' })).toMatchObject({ ok: false, code: 'POSSIBLE_DUPLICATE_ENQUIRY' });   // same name
      const confirmed = await lead({ name: 'D. Double', phone: '(04) 1255-5001', key: 'rel-dup-0002', confirm: true });
      expect(confirmed).toMatchObject({ ok: true, confirmed_separate: true });
      expect(await one(`select reason from audit_events where action = 'lead.created' and business_reference = $1`, [confirmed.lead_number]))
        .toEqual({ reason: 'Enquiry from D. Double (confirmed as separate from an open enquiry)' });
      expect(await lead({ name: 'D. Double', phone: '(04) 1255-5001', key: 'rel-dup-0002', confirm: true })).toMatchObject({ ok: true, duplicate: true, lead_number: confirmed.lead_number });
      expect(await lead({ name: 'Somebody Else', phone: '0499 000 777', key: 'rel-dup-0004' })).toMatchObject({ ok: true });
      for (const n of [first.lead_number, confirmed.lead_number]) {
        const v = Number((await one('select record_version v from leads where lead_number = $1', [n])).v);
        expect(await call('select web_lead_update($1,$2,$3,$4,$5) r', [tok.estimator, n, 'disqualify', v, 'Duplicate (test)'])).toMatchObject({ ok: true });
      }
      expect(await lead({ name: 'Dora Double', phone: '0412 555 001', key: 'rel-dup-0005' })).toMatchObject({ ok: true });   // only closed ones left
    });

    it('a customer\'s phone and email can be corrected by a manager with a reason; refused for others, stale screens and bad input; the invoice payload already made keeps the old email', async () => {
      const c = await one(`select customer_number, record_version v, email, phone from customers where customer_number = 'CUST-0004'`);
      const fix = (t: string, v: number, phone: string | null, email: string | null, reason: string) =>
        call('select web_customer_correct_contact($1,$2,$3,$4,$5,$6) r', [t, 'CUST-0004', v, phone, email, reason]);
      const v = Number(c.v);
      expect(await fix(tok.estimator!, v, '0400 123 456', 'ella@example.test', 'New number')).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
      expect(await fix(tok.admin!, v - 1, '0400 123 456', 'ella@example.test', 'New number')).toMatchObject({ ok: false, code: 'STALE' });
      expect(await fix(tok.admin!, v, '12', null, 'New number')).toMatchObject({ ok: false, code: 'INVALID' });
      expect(await fix(tok.admin!, v, '0400 123 456', 'not-an-email', 'New number')).toMatchObject({ ok: false, code: 'INVALID' });
      expect(await fix(tok.admin!, v, '0400 123 456', 'ella@example.test', 'x')).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
      const payloadBefore = await one(`select payload ->> 'customer_email' e from outbox where topic = 'xero.create_draft_invoice' and payload ->> 'customer_number' = 'CUST-0004' order by created_at desc limit 1`);
      const ok = await fix(tok.admin!, v, '0400 123 456', 'Ella.New@Example.test', 'Customer gave a new number and email');
      expect(ok).toMatchObject({ ok: true, customer_number: 'CUST-0004', phone: '0400 123 456', email: 'ella.new@example.test' });
      expect(await one(`select before_state, after_state, actor_id from audit_events where action = 'customer.contact_corrected' and business_reference = 'CUST-0004'`))
        .toEqual({ before_state: { phone: c.phone, email: c.email }, after_state: { phone: '0400 123 456', email: 'ella.new@example.test' }, actor_id: 'EMP-802' });
      expect(await one(`select payload ->> 'customer_email' e from outbox where topic = 'xero.create_draft_invoice' and payload ->> 'customer_number' = 'CUST-0004' order by created_at desc limit 1`)).toEqual(payloadBefore);
      expect(await fix(tok.admin!, Number(ok.record_version), '0400 123 456', 'ella.new@example.test', 'Same again')).toMatchObject({ ok: true, unchanged: true });
    });
  });
});

/** Real concurrency: two people record the same caller at the same moment; exactly one enquiry is created. */
describe.runIf(TARGETS.includes('postgres'))('duplicate enquiries under real concurrency [postgres]', () => {
  let db: Db & { url?: string };
  let token = '';
  beforeAll(async () => {
    db = await migratedDb('postgres');
    await importBundle(db);
    await db.query('select ops_staff_set_password($1, $2, $3)', ['EMP-002', 'estimator', PW]);
    token = String((await db.query<{ r: R }>('select web_staff_sign_in($1, $2) r', ['estimator', PW]))[0]!.r.token);
  }, 180_000);
  afterAll(async () => { await db.close(); });

  it('two simultaneous enquiries for one phone: one is recorded, the other is shown the first', async () => {
    const [a, b] = [await openPostgres(db.url!), await openPostgres(db.url!)];
    try {
      const sql = `select web_lead_create($1, $2, '0433 999 111', null, null, 'PHONE', null, $3, false) r`;
      const out = (await Promise.all([a.query<{ r: R }>(sql, [token, 'Race One', 'race-dup-0001']), b.query<{ r: R }>(sql, [token, 'Race Two', 'race-dup-0002'])])).map((x) => x[0]!.r);
      expect(out.filter((r) => r.ok)).toHaveLength(1);
      expect(out.filter((r) => r.code === 'POSSIBLE_DUPLICATE_ENQUIRY')).toHaveLength(1);
      expect((await db.query<R>(`select count(*)::int n from leads where phone = '0433 999 111'`))[0]).toEqual({ n: 1 });
    } finally { await a.close(); await b.close(); }
  });
});
