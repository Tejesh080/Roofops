/**
 * FIN-08 (audit 2026-10-22; FIN-GST-01 follow-up): a reissue skipped the multi-line GST gate. A voided two-line final could
 * be requested, approved and queued as a generation-2 Xero write while xero.line_tax_amounts was off, although the final
 * preview stops exactly that for a new final (Xero rounds GST per line; the draft could differ by a cent after it exists).
 * Migration 20261022070000: invoice_reissue_check, which request and decide both call, refuses MULTI_LINE_GST.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';
import { deletedReissueScenario, type ReissueScenario } from './helpers/reissue-scenario.js';

const REASON = 'Xero deleted the draft; the customer still owes the job';
const setting = (db: Db, v: 'on' | 'off') => db.query(`update app_settings set value = $1 where key = 'xero.line_tax_amounts'`, [v]);

describe.each(TARGETS)('FIN-08: a multi-line invoice is reissued only with per-line GST on [%s]', (target) => {
  let db: Db;
  let s: ReissueScenario;
  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    // A two-line final: PRJ-2026-0004's quote plus an approved variation, built while per-line GST is on (as it must be).
    await setting(db, 'on');
    await db.query(`insert into variations (variation_number, project_id, description, amount_inc_gst, status, customer_approved_at, approved_by)
      select 'VAR-TEST-FIN08', p.id, 'Extra flashing', 100.05, 'APPROVED', now(), (select id from employees where employee_code = 'EMP-900')
        from projects p where p.project_number = 'PRJ-2026-0004'`);
    s = await deletedReissueScenario(db);
  }, 180_000);
  afterAll(async () => { await db.close(); });

  it('the scenario: a voided final with two lines, its Xero draft verified deleted', async () => {
    expect((await db.query<{ n: number }>(`select count(*)::int n from invoice_lines where invoice_id = $1`, [s.invoice.id]))[0]!.n).toBe(2);
    expect(await s.state()).toMatchObject({ status: 'VOIDED' });
  });

  it('with per-line GST off, the request is refused and nothing is queued', async () => {
    await setting(db, 'off');
    const before = (await s.outbox()).length;
    expect(await s.request('EMP-900', REASON)).toMatchObject({ ok: false, code: 'MULTI_LINE_GST',
      detail: expect.stringMatching(new RegExp(`${s.invoice.number} has 2 lines: a reissue cannot go to Xero yet`)) as unknown });
    expect((await s.outbox()).length).toBe(before);
  });

  it('a request made while it was on is not decided once it is off; with it on again the reissue is queued', async () => {
    await setting(db, 'on');
    const r = await s.request('EMP-900', REASON);
    expect(r).toMatchObject({ ok: true });
    await setting(db, 'off');
    const before = (await s.outbox()).length;
    expect(await s.decide(String(r.approval_number), 'EMP-901')).toMatchObject({ ok: false, code: 'MULTI_LINE_GST' });
    expect((await s.outbox()).length).toBe(before);
    await setting(db, 'on');
    expect(await s.decide(String(r.approval_number), 'EMP-901')).toMatchObject({ ok: true });
    expect((await s.outbox()).length).toBe(before + 1);
  });
});
