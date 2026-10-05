/**
 * AC-09 (docs/adversarial-test-catalogue.md): the final invoice under-billed once a billed variation was marked INVOICED.
 * invoice_final_preview added only APPROVED variations but subtracted every billed invoice, including the variation's
 * own VARIATION invoice; reproduced on PRJ-2026-0004: 14,664.49 -> 13,564.49 (exactly the 1,100.00 variation short).
 * AC-08's project_over_billing counted APPROVED + INVOICED: two different entitlement formulas.
 *
 * Canonical rule (one calculation, reused by the preview, the dashboard, the close guard, the Copilot, integrity):
 *   total_entitlement  = accepted quote total (inc GST) + variations APPROVED or INVOICED (customer-approved)
 *                        (PROPOSED and REJECTED never count)
 *   valid_billed       = invoices APPROVED, ISSUED, PARTIALLY_PAID or PAID (inc GST; VOIDED never counts;
 *                        DRAFT / PENDING_APPROVAL block the final invoice instead)
 *   remaining_billable = total_entitlement - valid_billed       (> 0 ready, = 0 fully invoiced, < 0 over-billed)
 * The final invoice is remaining_billable, GST-inclusive, GST = round(amount / 11, 2); its lines add up to it exactly.
 *
 * The expected numbers come from an independent oracle below (integer cents, Postgres rounding), never from RoofOps.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { InvoiceRows } from './helpers/airtable04.js';
import { TARGETS, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const P = 'PRJ-2026-0004';
const APPROVER = 'usr7uCnNO15fCefbH';
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;

// ---- Independent oracle: integer cents, rounding half away from zero (Postgres numeric round) ----------------------
const cents = (x: number) => Math.round(x * 100);
const roundDiv = (n: number, d: number) => { const s = Math.sign(n); const a = Math.abs(n); const q = Math.floor(a / d); return s * (2 * (a - q * d) >= d ? q + 1 : q); };
/** An invoice's GST-inclusive total from its line sum, per line-amount type (10% GST). */
const invoiceTotal = (lineCents: number, type: 'INCLUSIVE' | 'EXCLUSIVE' | 'NO_TAX') => type === 'EXCLUSIVE' ? lineCents + roundDiv(lineCents, 10) : lineCents;
type Var = { cents: number; status: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'INVOICED' };
type Inv = { cents: number; status: 'APPROVED' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'VOIDED' };
const oracle = (quote: number, vars: Var[], invs: Inv[]) => {
  const entitlement = quote + vars.filter((v) => v.status === 'APPROVED' || v.status === 'INVOICED').reduce((a, v) => a + v.cents, 0);
  const billed = invs.filter((i) => i.status !== 'VOIDED').reduce((a, i) => a + i.cents, 0);
  const remaining = entitlement - billed;
  return { entitlement, billed, remaining, gst: remaining > 0 ? roundDiv(remaining, 11) : 0 };
};
// PRJ-2026-0004 as imported: quote 20,949.27 inc GST; INV-2026-0004 4,189.85 PAID and INV-2026-0034 2,094.93 PAID.
const QUOTE = cents(20949.27);
const IMPORTED: Inv[] = [{ cents: cents(4189.85), status: 'PAID' }, { cents: cents(2094.93), status: 'PAID' }];

describe.each(TARGETS)('AC-09: one canonical billing entitlement; the final invoice is never short [%s]', (target) => {
  let db: Db;
  const rows = new InvoiceRows();
  let n = 0;
  const rolledBack = async <T>(fn: () => Promise<T>) => { await db.exec('begin'); try { return await fn(); } finally { await db.exec('rollback'); } };
  const preview = async () => (await db.query<{ v: R }>(`select invoice_final_preview(id) v from projects where project_number = $1`, [P]))[0]!.v;
  const dash = async () => (await db.query<R>(`select invoice_status, invoice_amount_inc_gst::text amount from v_dashboard_projects where project_number = $1`, [P]))[0]!;
  const addVariation = (status: Var['status'], amount: number) => db.query(`insert into variations (variation_number, project_id, description, amount_inc_gst, status, customer_approved_at, approved_by)
      select 'VAR-' || $3, p.id, 'Variation ' || $3, $2, $1, case when $1 in ('APPROVED', 'INVOICED') then now() end,
             case when $1 in ('APPROVED', 'INVOICED') then (select id from employees order by id limit 1) end
        from projects p where p.project_number = '${P}' returning id`, [status, amount, String(++n)]).then((r) => String((r[0] as R).id));
  /** An invoice as the importer would hold it; its total derives from one line of `line` in the given line-amount type. */
  const addInvoice = async (type: string, status: string, line: number, lineType: 'INCLUSIVE' | 'EXCLUSIVE' = 'INCLUSIVE', variationId: string | null = null) => {
    const number = `INV-T-${String(++n)}`;
    await db.query(`insert into invoices (invoice_number, project_id, customer_id, record_origin, invoice_type, status, line_amount_type, gst_rate, issue_date, due_date, voided_reason)
        select $1, p.id, p.customer_id, 'IMPORT', $2, $3, $4, 0.1, date '2026-09-01', date '2026-09-15', case when $3 = 'VOIDED' then 'test' end
          from projects p where p.project_number = '${P}'`, [number, type, status, lineType]);
    await db.query(`insert into invoice_lines (invoice_id, line_no, description, quantity, unit_price, variation_id) select id, 1, 'Line', 1, $2, $3 from invoices where invoice_number = $1`,
      [number, line, variationId]);
    return { number, cents: Number((await db.query<{ t: string }>(`select total_inc_gst::text t from invoices where invoice_number = $1`, [number]))[0]!.t) * 100 };
  };
  /** The preview must match the oracle: amount, GST, and its lines adding up to the amount exactly. */
  const expectPreview = async (o: ReturnType<typeof oracle>) => {
    const v = await preview();
    expect(v, JSON.stringify(v).slice(0, 300)).toMatchObject({ ok: true });
    const pv = v.preview as R;
    expect(cents(Number(pv.amount_inc_gst))).toBe(o.remaining);
    expect(cents(Number(pv.gst_amount))).toBe(o.gst);
    expect(cents(Number(pv.billed_to_date_inc_gst))).toBe(o.billed);
    expect((pv.lines as R[]).reduce((a, l) => a + cents(Number(l.unit_amount)) * Number(l.quantity), 0)).toBe(o.remaining);
    expect(cents(Number((await dash()).amount))).toBe(o.remaining);                 // the dashboard reads the same calculation
  };
  const prepare = () => rows.send(db, { event_id: `EVT-AC09-${String(++n)}`, event_type: 'invoice.prepare_requested', source: 'airtable', actor_id: APPROVER,
    occurred_at: new Date().toISOString(), payload: { project_number: P, airtable_record_id: recFor(P) } }, 'n8n:test');
  const approve = () => rows.send(db, { event_id: `EVT-AC09-${String(++n)}`, event_type: 'invoice.approved', source: 'airtable', actor_id: APPROVER,
    occurred_at: new Date(Date.now() + 1000).toISOString(), payload: { project_number: P, airtable_record_id: recFor(P) } }, 'n8n:test');

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`update app_settings set value = '11111111-2222-3333-4444-555555555555' where key = 'xero.demo_tenant_id';
                   insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
  }, 120_000);
  afterAll(async () => { await db.close(); });

  it('1. no variations: quote - billed', async () => {
    await expectPreview(oracle(QUOTE, [], IMPORTED));
  });

  it('2. one approved, not yet invoiced variation is added (and shown as its own line)', async () => {
    await rolledBack(async () => {
      await addVariation('APPROVED', 1100);
      await expectPreview(oracle(QUOTE, [{ cents: 110000, status: 'APPROVED' }], IMPORTED));
      expect(((await preview()).preview as R).lines).toEqual(expect.arrayContaining([expect.objectContaining({ unit_amount: 1100, variation_id: expect.any(String) as unknown })]));
    });
  });

  it('3. a variation already invoiced (its VARIATION invoice billed, status INVOICED) is still entitlement: the final is not short', async () => {
    await rolledBack(async () => {
      const v = await addVariation('APPROVED', 1100);
      const vi = await addInvoice('VARIATION', 'PAID', 1100, 'INCLUSIVE', v);
      await db.query(`update variations set status = 'INVOICED' where id = $1`, [v]);
      await expectPreview(oracle(QUOTE, [{ cents: 110000, status: 'INVOICED' }], [...IMPORTED, { cents: vi.cents, status: 'PAID' }]));
    });
  });

  it('4 + 9. variations in mixed states: APPROVED and INVOICED count; PROPOSED and REJECTED never do', async () => {
    await rolledBack(async () => {
      await addVariation('APPROVED', 1100);
      const inv = await addVariation('APPROVED', 550);
      const vi = await addInvoice('VARIATION', 'ISSUED', 550, 'INCLUSIVE', inv);
      await db.query(`update variations set status = 'INVOICED' where id = $1`, [inv]);
      await addVariation('PROPOSED', 2200);
      await addVariation('REJECTED', 330);
      await expectPreview(oracle(QUOTE, [{ cents: 110000, status: 'APPROVED' }, { cents: 55000, status: 'INVOICED' }, { cents: 220000, status: 'PROPOSED' }, { cents: 33000, status: 'REJECTED' }],
        [...IMPORTED, { cents: vi.cents, status: 'ISSUED' }]));
    });
  });

  it('5 + 13. progress invoices + a variation + the final invoice: everything billed adds up to the entitlement exactly', async () => {
    await rolledBack(async () => {
      const pi = await addInvoice('PROGRESS', 'PAID', 5000);
      const v = await addVariation('APPROVED', 1234.57);
      const vi = await addInvoice('VARIATION', 'ISSUED', 1234.57, 'INCLUSIVE', v);
      await db.query(`update variations set status = 'INVOICED' where id = $1`, [v]);
      await addVariation('APPROVED', 99.99);                                            // approved, billed on the final
      const o = oracle(QUOTE, [{ cents: 123457, status: 'INVOICED' }, { cents: 9999, status: 'APPROVED' }],
        [...IMPORTED, { cents: pi.cents, status: 'PAID' }, { cents: vi.cents, status: 'ISSUED' }]);
      await expectPreview(o);
      expect(await prepare()).toMatchObject({ outcome: 'PREVIEW_READY' });
      expect(await approve()).toMatchObject({ outcome: 'APPROVED' });
      const [final] = await db.query<{ t: string; g: string }>(`select total_inc_gst::text t, gst_amount::text g from invoices i join projects p on p.id = i.project_id
          where p.project_number = $1 and i.invoice_type = 'FINAL'`, [P]);
      expect(cents(Number(final!.t))).toBe(o.remaining);
      expect(cents(Number(final!.g))).toBe(o.gst);
      const [{ billed }] = await db.query<{ billed: string }>(`select sum(total_inc_gst)::text billed from invoices i join projects p on p.id = i.project_id
          where p.project_number = $1 and i.status in ('APPROVED', 'ISSUED', 'PARTIALLY_PAID', 'PAID')`, [P]) as [{ billed: string }];
      expect(cents(Number(billed))).toBe(o.entitlement);                                // final + all prior valid invoices = entitlement
      expect(await db.query(`select project_over_billing(id) v from projects where project_number = $1`, [P])).toEqual([{ v: null }]);
      const check = async () => (await db.query<R>(`select status, refs from integrity_check() where check_key = 'final_invoice_settles_entitlement'`))[0]!;
      expect(await check()).toMatchObject({ status: 'PASS' });
      // A variation approved after the final invoice is entitlement left to bill: integrity says so (it needs its own invoice).
      await addVariation('APPROVED', 220);
      expect(await check()).toMatchObject({ status: 'WARNING', refs: [`${P} (220.00 left)`] });
    });
  });

  it('6. exactly fully invoiced (including an invoiced variation): FULLY_INVOICED, not ready, not over-billed', async () => {
    await rolledBack(async () => {
      const v = await addVariation('APPROVED', 1100);
      await addInvoice('VARIATION', 'PAID', 1100, 'INCLUSIVE', v);
      await db.query(`update variations set status = 'INVOICED' where id = $1`, [v]);
      const o = oracle(QUOTE, [{ cents: 110000, status: 'INVOICED' }], [...IMPORTED, { cents: 110000, status: 'PAID' }]);
      await addInvoice('PROGRESS', 'PAID', o.remaining / 100);
      expect(await preview()).toMatchObject({ ok: false, error_class: 'ARITHMETIC_MISMATCH' });
      expect(await preview()).not.toHaveProperty('over_billed');
      expect((await dash()).invoice_status).toBe('FULLY_INVOICED');
    });
  });

  it('7. over-billing stays AC-08\'s: billed above the canonical entitlement is OVER_BILLED by exactly the excess', async () => {
    await rolledBack(async () => {
      const o = oracle(QUOTE, [], IMPORTED);
      await addInvoice('PROGRESS', 'PAID', (o.remaining + 4242) / 100);
      expect(await preview()).toMatchObject({ over_billed: true, over_billed_by: 42.42 });
      expect((await dash()).invoice_status).toBe('OVER_BILLED');
    });
  });

  it('8. a voided invoice is never billed', async () => {
    await rolledBack(async () => {
      await addInvoice('PROGRESS', 'VOIDED', 5000);
      await expectPreview(oracle(QUOTE, [], [...IMPORTED, { cents: 500000, status: 'VOIDED' }]));
    });
  });

  it('10. GST-inclusive and GST-exclusive invoices are compared on their GST-inclusive totals', async () => {
    await rolledBack(async () => {
      const ex = await addInvoice('PROGRESS', 'PAID', 1000.05, 'EXCLUSIVE');            // 1,000.05 + GST 100.01 (100.005 rounded) = 1,100.06
      expect(ex.cents).toBe(invoiceTotal(100005, 'EXCLUSIVE'));
      const inc = await addInvoice('PROGRESS', 'PAID', 1100.06, 'INCLUSIVE');
      expect(inc.cents).toBe(invoiceTotal(110006, 'INCLUSIVE'));
      await expectPreview(oracle(QUOTE, [], [...IMPORTED, { cents: ex.cents, status: 'PAID' }, { cents: inc.cents, status: 'PAID' }]));
    });
  });

  it('11. one-cent boundaries: 0.01 left is ready (GST 0.00); exactly 0 is fully invoiced; 0.01 over is over-billed by 0.01', async () => {
    const base = oracle(QUOTE, [], IMPORTED);
    await rolledBack(async () => {
      const pi = await addInvoice('PROGRESS', 'PAID', (base.remaining - 1) / 100);
      await expectPreview(oracle(QUOTE, [], [...IMPORTED, { cents: pi.cents, status: 'PAID' }]));
      expect(cents(Number(((await preview()).preview as R).amount_inc_gst))).toBe(1);
    });
    await rolledBack(async () => {
      await addInvoice('PROGRESS', 'PAID', base.remaining / 100);
      expect((await dash()).invoice_status).toBe('FULLY_INVOICED');
    });
    await rolledBack(async () => {
      await addInvoice('PROGRESS', 'PAID', (base.remaining + 1) / 100);
      expect(await preview()).toMatchObject({ over_billed: true, over_billed_by: 0.01 });
    });
    // GST rounding at the half-cent: 5.50 inc -> 0.50 GST; 0.06 inc -> 0.01 GST (0.00545… rounds up); 0.05 -> 0.00.
    expect([roundDiv(550, 11), roundDiv(6, 11), roundDiv(5, 11)]).toEqual([50, 1, 0]);
    await rolledBack(async () => {
      const pi = await addInvoice('PROGRESS', 'PAID', (base.remaining - 6) / 100);
      await expectPreview(oracle(QUOTE, [], [...IMPORTED, { cents: pi.cents, status: 'PAID' }]));
      expect(cents(Number(((await preview()).preview as R).gst_amount))).toBe(1);
    });
  });

  it('12. repeated Prepare is idempotent: the same approval and the same amount', async () => {
    await rolledBack(async () => {
      const v = await addVariation('APPROVED', 1100);
      await addInvoice('VARIATION', 'PAID', 1100, 'INCLUSIVE', v);
      await db.query(`update variations set status = 'INVOICED' where id = $1`, [v]);
      const first = await prepare();
      const again = await prepare();
      expect(first).toMatchObject({ outcome: 'PREVIEW_READY' });
      expect(again).toMatchObject({ outcome: 'ALREADY_PENDING', approval_number: first.approval_number });
      const o = oracle(QUOTE, [{ cents: 110000, status: 'INVOICED' }], [...IMPORTED, { cents: 110000, status: 'PAID' }]);
      expect(cents(Number((first.preview as R).amount_inc_gst))).toBe(o.remaining);
      expect(cents(Number((again.preview as R | undefined)?.amount_inc_gst ?? (first.preview as R).amount_inc_gst))).toBe(o.remaining);
      expect(await db.query(`select count(*)::int n from approvals where business_reference = $1 and status = 'PENDING'`, [P])).toEqual([{ n: 1 }]);
    });
  });

  it('one rule everywhere: the preview, AC-08\'s over-billing and the close guard agree on the entitlement', async () => {
    await rolledBack(async () => {
      const v = await addVariation('APPROVED', 1100);
      await addInvoice('VARIATION', 'PAID', 1100, 'INCLUSIVE', v);
      await db.query(`update variations set status = 'INVOICED' where id = $1`, [v]);
      const pv = (await preview()).preview as R;
      const o = oracle(QUOTE, [{ cents: 110000, status: 'INVOICED' }], [...IMPORTED, { cents: 110000, status: 'PAID' }]);
      expect(cents(Number(pv.quote_total_inc_gst)) + cents(Number(pv.approved_variations_inc_gst))).toBe(o.entitlement);
      const [{ b }] = await db.query<{ b: R }>(`select project_billing(id) b from projects where project_number = $1`, [P]) as [{ b: R }];
      expect({ entitlement: cents(Number(b.entitlement)), billed: cents(Number(b.billed)), remaining: cents(Number(b.remaining)) })
        .toEqual({ entitlement: o.entitlement, billed: o.billed, remaining: o.remaining });
    });
  });
});
