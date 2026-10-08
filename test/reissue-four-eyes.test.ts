/**
 * Separation of duties for reissues (FOUR-EYES-01): with invoice.reissue_requires_second_person on, the employee who
 * requested a reissue cannot approve it; a second person in a reissue role can. Off (the shipped default), the
 * decision behaves exactly as before. A missing setting counts as on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';
import { deletedReissueScenario, type ReissueScenario } from './helpers/reissue-scenario.js';

const FINANCE = 'EMP-900';                         // FINANCE, active: requests
const ADMIN = 'EMP-901';                           // ADMIN, active (scenario fixture): the second person
const REASON = 'Draft deleted in Xero by mistake; the verified deletion is recorded, reissue the same invoice';

describe.each(TARGETS)('reissue needs a second person [%s]', (target) => {
  let db: Db;
  const setting = (v: string | null) => v === null
    ? db.exec(`delete from app_settings where key = 'invoice.reissue_requires_second_person'`)
    : db.query(`insert into app_settings (key, value) values ('invoice.reissue_requires_second_person', $1)
                on conflict (key) do update set value = excluded.value`, [v]);
  const state = async (s: ReissueScenario, apr: string) => ({
    approval: (await col(db, `select status v from approvals where approval_number = '${apr}'`))[0],
    generations: (await col(db, `select count(*)::text v from invoice_xero_draft_generations where invoice_id = '${s.invoice.id}'`))[0],
    invoice: (await col(db, `select status v from invoices where id = '${s.invoice.id}'`))[0],
  });

  beforeAll(async () => { db = await migratedDb(target); }, 120_000);
  afterAll(async () => { await db.close(); });

  it('ships off: the setting exists and is false, so the decision is unchanged until the owner turns it on', async () => {
    expect(await col(db, `select value v from app_settings where key = 'invoice.reissue_requires_second_person'`)).toEqual(['false']);
    const s = await deletedReissueScenario(db, { project: 'PRJ-2026-0004', xid: 'aaaaaaaa-bbbb-cccc-dddd-00000000fe01' });
    const r = await s.request(FINANCE, REASON);
    expect(r).toMatchObject({ ok: true });
    expect(await s.decide(String(r.approval_number), FINANCE)).toMatchObject({ ok: true });
  }, 120_000);

  it('on: the requester is refused (SAME_PERSON) and nothing changes; a second person in a reissue role decides it', async () => {
    await setting('true');
    const s = await deletedReissueScenario(db, { project: 'PRJ-2026-0005', xid: 'aaaaaaaa-bbbb-cccc-dddd-00000000fe02' });
    const r = await s.request(FINANCE, REASON);
    const apr = String(r.approval_number);
    const before = await state(s, apr);
    const refused = await s.decide(apr, FINANCE);
    expect(refused).toMatchObject({ ok: false, code: 'SAME_PERSON', detail: expect.stringMatching(/second person/) as unknown });
    expect(await state(s, apr)).toEqual(before);                 // still PENDING, no generation added, invoice untouched
    expect(before.approval).toBe('PENDING');
    expect(await s.decide(apr, ADMIN)).toMatchObject({ ok: true });
    expect(await state(s, apr)).toMatchObject({ approval: 'EXECUTED', invoice: 'APPROVED' });
    // A repeat delivery of the decided approval gets the decision's own idempotent answer, never a new act.
    const again = await s.decide(apr, FINANCE);
    expect(again).toMatchObject({ ok: false });
    expect(again.code).not.toBe('SAME_PERSON');
  }, 120_000);

  it('a missing setting counts as on (fail closed)', async () => {
    await setting(null);
    const s = await deletedReissueScenario(db, { project: 'PRJ-2026-0001', xid: 'aaaaaaaa-bbbb-cccc-dddd-00000000fe03' });
    const r = await s.request(FINANCE, REASON);
    expect(await s.decide(String(r.approval_number), FINANCE)).toMatchObject({ ok: false, code: 'SAME_PERSON' });
  }, 120_000);

  it('neither application role may decide a reissue, and nobody but the owner calls the core directly', async () => {
    for (const role of ['roofops_workflow', 'roofops_dashboard']) {
      for (const f of ['ops_reissue_decide(text,text,text)', 'ops_reissue_decide_core(text,text,text)']) {
        expect(await col(db, `select has_function_privilege('${role}', '${f}', 'execute')::text v`), `${role} ${f}`).toEqual(['false']);
      }
    }
  });
});
