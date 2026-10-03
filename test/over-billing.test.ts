/**
 * AC-08 (docs/adversarial-test-catalogue.md): a project billed more than it is entitled to (quote + approved or invoiced
 * variations) was labelled "Fully invoiced", with no blocker and no attention flag, and could be CLOSED. Reproduced on the
 * imported data (and hosted): PRJ-2026-0006 billed 30,888.72 against 25,740.60 (deposit billed twice), PRJ-2026-0008
 * billed 59,687.64 against 49,739.70; invoice_final_preview said "nothing left to invoice" (amount <= 0 lumps exactly
 * billed with over-billed), the dashboard showed FULLY_INVOICED, Prepare filed that misleading message, and once the
 * invoices were paid CLOSED was accepted.
 *
 * Rule (owner decisions 2026-10-04): billed <= entitled, always. Otherwise the project is OVER_BILLED (its own status):
 * it needs attention, names the excess and the invoices, Prepare and the Copilot refuse with that reason, and CLOSED is
 * refused until a person corrects the billing (no credit-note model). Exactly fully billed stays FULLY_INVOICED.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { InvoiceRows } from './helpers/airtable04.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';
import { TOOLS, type ToolContext } from '../web/lib/copilot/tools.ts';
import type { Query } from '../web/lib/queries.ts';

type R = Record<string, unknown>;
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;

describe.each(TARGETS)('AC-08: an over-billed project is never "fully invoiced" and cannot be closed [%s]', (target) => {
  let db: Db;
  const rows = new InvoiceRows();
  let n = 0;
  const preview = async (p: string) => (await db.query<{ v: R }>(`select invoice_final_preview(id) v from projects where project_number = $1`, [p]))[0]!.v;
  const dash = async (p: string) => (await db.query<R>(`select invoice_status, invoice_blocker, needs_attention from v_dashboard_projects where project_number = $1`, [p]))[0]!;
  /** Run fn in a transaction that is always rolled back. */
  const rolledBack = async <T>(fn: () => Promise<T>) => { await db.exec('begin'); try { return await fn(); } finally { await db.exec('rollback'); } };
  const close = (p: string) => db.query(`update projects set status = 'CLOSED' where project_number = $1`, [p]).then(() => true as const, (e: unknown) => (e as Error).message);
  const payAll = (p: string) => db.query(`update invoices set status = 'PAID' where status in ('ISSUED', 'PARTIALLY_PAID') and project_id = (select id from projects where project_number = $1)`, [p]);
  /** An invoice inserted as the importer would (record_origin IMPORT), GST-inclusive; its totals derive from its one line. */
  const addInvoice = async (p: string, number: string, type: string, total: number, status = 'ISSUED') => {
    await db.query(`insert into invoices (invoice_number, project_id, customer_id, record_origin, invoice_type, status, line_amount_type, gst_rate, issue_date, due_date)
        select $2, p.id, p.customer_id, 'IMPORT', $3, $4, 'INCLUSIVE', 0.1, date '2026-09-01', date '2026-09-15' from projects p where p.project_number = $1`, [p, number, type, status]);
    await db.query(`insert into invoice_lines (invoice_id, line_no, description, quantity, unit_price) select id, 1, 'Roofing works', 1, $2 from invoices where invoice_number = $1`, [number, total]);
    expect(await col(db, `select total_inc_gst::text v from invoices where invoice_number = $1`, [number])).toEqual([total.toFixed(2)]);
  };

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`update app_settings set value = '11111111-2222-3333-4444-555555555555' where key = 'xero.demo_tenant_id';
                   insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
  }, 120_000);
  afterAll(async () => { await db.close(); });

  it('the preview names the over-billing: billed, entitled, excess and invoices (not "nothing left to invoice")', async () => {
    expect(await preview('PRJ-2026-0006')).toMatchObject({ ok: false, error_class: 'ARITHMETIC_MISMATCH', over_billed: true, over_billed_by: 5148.12,
      message: expect.stringMatching(/^PRJ-2026-0006 is over-billed: billed 30888\.72 \(INV-2026-0006, INV-2026-0036\) against quote 25740\.60 \+ approved variations 0(\.00)? = 25740\.60; over by 5148\.12/) as unknown });
    expect(await preview('PRJ-2026-0008')).toMatchObject({ over_billed: true, over_billed_by: 9947.94 });
    expect(String((await preview('PRJ-2026-0006')).message)).not.toMatch(/nothing left to invoice/);
  });

  it('the dashboard shows OVER_BILLED with the reason, and it always needs attention', async () => {
    for (const p of ['PRJ-2026-0006', 'PRJ-2026-0008']) {
      expect(await dash(p), p).toMatchObject({ invoice_status: 'OVER_BILLED', needs_attention: true, invoice_blocker: expect.stringMatching(/is over-billed: .* over by /) as unknown });
    }
    expect(await col(db, `select project_number v from v_dashboard_projects where invoice_status = 'OVER_BILLED' order by 1`)).toEqual(['PRJ-2026-0006', 'PRJ-2026-0008']);
  });

  it('Prepare refuses with the over-billing reason (one exception, no approval)', async () => {
    const r = await rows.send(db, { event_id: `EVT-AC08-${String(++n)}`, event_type: 'invoice.prepare_requested', source: 'airtable', actor_id: 'usr7uCnNO15fCefbH',
      occurred_at: new Date().toISOString(), payload: { project_number: 'PRJ-2026-0006', airtable_record_id: recFor('PRJ-2026-0006') } }, 'n8n:test');
    expect(r).toMatchObject({ outcome: 'INVALID_STATE', error_class: 'ARITHMETIC_MISMATCH', message: expect.stringMatching(/is over-billed: .*over by 5148\.12/) as unknown });
    expect(await col(db, `select error_message v from workflow_exceptions where business_reference = 'PRJ-2026-0006' and resolution_status = 'OPEN'`))
      .toEqual([expect.stringMatching(/over-billed/) as unknown]);
    expect(await col(db, `select count(*)::text v from approvals where business_reference = 'PRJ-2026-0006'`)).toEqual(['0']);
  });

  it('CLOSED is refused while over-billed, even with every invoice paid; nothing changes', async () => {
    await rolledBack(async () => {
      await payAll('PRJ-2026-0006');
      expect(await close('PRJ-2026-0006')).toMatch(/PRJ-2026-0006 cannot be closed: it is over-billed by 5148\.12 .*Correct the billing first/);
    });
    expect(await col(db, `select status v from projects where project_number = 'PRJ-2026-0006'`)).toEqual(['COMPLETED']);
  });

  it('correcting the billing (voiding the unpaid duplicate) clears it: no longer over-billed, and closing is judged on the normal rules again', async () => {
    await rolledBack(async () => {
      await db.query(`update invoices set status = 'VOIDED', voided_reason = 'Duplicate of the deposit invoice' where invoice_number = 'INV-2026-0036'`);
      expect(await preview('PRJ-2026-0006')).not.toHaveProperty('over_billed');
      expect((await dash('PRJ-2026-0006')).invoice_status).not.toBe('OVER_BILLED');
      expect(await close('PRJ-2026-0006')).toMatch(/final invoice has not been raised yet/);        // the ordinary rule, not over-billing
    });
  });

  it('exactly fully billed stays FULLY_INVOICED and may close once paid; an INVOICED variation counts as entitled (no false alarm)', async () => {
    await rolledBack(async () => {
      // PRJ-2026-0005: entitled 44,579.78; already billed 26,747.87. Bill the rest exactly.
      await addInvoice('PRJ-2026-0005', 'INV-2026-9001', 'PROGRESS', 17831.91, 'PAID');
      expect(await preview('PRJ-2026-0005')).toMatchObject({ ok: false, error_class: 'ARITHMETIC_MISMATCH' });
      expect(await preview('PRJ-2026-0005')).not.toHaveProperty('over_billed');
      expect(await dash('PRJ-2026-0005')).toMatchObject({ invoice_status: 'FULLY_INVOICED', invoice_blocker: null });
      // A variation the customer approved and that was invoiced is entitlement, not over-billing.
      await db.query(`insert into variations (variation_number, project_id, description, amount_inc_gst, status, customer_approved_at, approved_by)
                      select 'VAR-AC08-1', p.id, 'Extra flashing', 1100, 'INVOICED', now(), (select id from employees limit 1)
                        from projects p where p.project_number = 'PRJ-2026-0005'`);
      await addInvoice('PRJ-2026-0005', 'INV-2026-9002', 'VARIATION', 1100, 'PAID');
      expect((await dash('PRJ-2026-0005')).invoice_status).not.toBe('OVER_BILLED');
      await payAll('PRJ-2026-0005');
      expect(String(await close('PRJ-2026-0005'))).not.toMatch(/over-billed/);
    });
  });

  it('quote, variations and invoices are compared on the same basis (GST-inclusive), whatever the invoice\'s line-amount type', async () => {
    await rolledBack(async () => {
      // PRJ-2026-0005: entitled 44,579.78 inc GST (quote version total_inc_gst); billed 26,747.87 inc GST; 17,831.91 inc GST left.
      const invoice = async (number: string, exGst: number) => {
        await db.query(`insert into invoices (invoice_number, project_id, customer_id, record_origin, invoice_type, status, line_amount_type, gst_rate, issue_date, due_date)
            select $1, p.id, p.customer_id, 'IMPORT', 'PROGRESS', 'ISSUED', 'EXCLUSIVE', 0.1, date '2026-09-01', date '2026-09-15' from projects p where p.project_number = 'PRJ-2026-0005'`, [number]);
        await db.query(`insert into invoice_lines (invoice_id, line_no, description, quantity, unit_price) select id, 1, 'Roofing works (ex GST)', 1, $2 from invoices where invoice_number = $1`, [number, exGst]);
        return (await db.query<R>(`select subtotal_ex_gst::text ex, total_inc_gst::text inc from invoices where invoice_number = $1`, [number]))[0]!;
      };
      // Exactly the remainder, expressed ex GST (16,210.83 + 10% = 17,831.91 inc): fully invoiced, not over-billed.
      expect(await invoice('INV-2026-9101', 16210.83)).toEqual({ ex: '16210.83', inc: '17831.91' });
      expect(await preview('PRJ-2026-0005')).not.toHaveProperty('over_billed');
      expect((await dash('PRJ-2026-0005')).invoice_status).toBe('FULLY_INVOICED');
      await db.query(`update invoices set status = 'VOIDED', voided_reason = 'test' where invoice_number = 'INV-2026-9101'`);
      // 17,000.00 ex GST is below the 17,831.91 left, but 18,700.00 inc GST is above it: over-billed by 868.09 (an ex-GST comparison would miss it).
      expect(await invoice('INV-2026-9102', 17000)).toEqual({ ex: '17000.00', inc: '18700.00' });
      expect(await preview('PRJ-2026-0005')).toMatchObject({ over_billed: true, over_billed_by: 868.09, billed_inc_gst: 45447.87, entitled_inc_gst: 44579.78 });
      expect(await dash('PRJ-2026-0005')).toMatchObject({ invoice_status: 'OVER_BILLED', invoice_blocker: expect.stringMatching(/over by 868\.09/) as unknown });
    });
  });

  it('over-billing is flagged at any stage: progress invoices above the entitlement on a job still in progress', async () => {
    await rolledBack(async () => {
      const [{ p, entitled }] = await db.query<{ p: string; entitled: string }>(`select p.project_number p, qv.total_inc_gst::text entitled from projects p
          join quote_versions qv on qv.id = p.accepted_quote_version_id where p.status = 'IN_PROGRESS' order by 1 limit 1`) as [{ p: string; entitled: string }];
      await addInvoice(p, 'INV-2026-9003', 'PROGRESS', Number(entitled) + 500);
      expect(await dash(p)).toMatchObject({ invoice_status: 'OVER_BILLED', needs_attention: true });
    });
  });

  it('the Copilot shows it as over-billed and its prepare tool refuses with the reason, filing nothing', async () => {
    await db.exec('begin; set local role roofops_dashboard;');
    try {
      const query: Query = (sql, params = []) => db.query(sql, params) as never;
      const ctx: ToolContext = { query, requestId: 'ac08', lastUserMessage: 'Prepare invoice for PRJ-2026-0008' };
      const before = await col(db, `select count(*)::text v from v_dashboard_exceptions`);
      const got = (await TOOLS.prepare_invoice!.run({ project_number: 'PRJ-2026-0008' }, ctx)).data as R;
      expect(got).toMatchObject({ prepared: false, invoice_status: expect.stringMatching(/over-billed/i) as unknown, reason: expect.stringMatching(/is over-billed/) as unknown });
      expect(await col(db, `select count(*)::text v from v_dashboard_exceptions`)).toEqual(before);
      // "What needs attention today" lists both over-billed projects with the excess (PRJ-2026-0006 has no other reason to be there).
      const att = (await TOOLS.what_needs_attention_today!.run({}, ctx)).data as { over_billed?: R[] };
      expect(att.over_billed).toEqual([
        expect.objectContaining({ project: 'PRJ-2026-0006', over_by_inc_gst: 5148.12, detail: expect.stringMatching(/is over-billed/) as unknown }),
        expect.objectContaining({ project: 'PRJ-2026-0008', over_by_inc_gst: 9947.94 }),
      ]);
    } finally { await db.exec('rollback'); }
  });
});
