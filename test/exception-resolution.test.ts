/**
 * Exception resolution (docs/defect-ledger.md, AC-03 §15): an open exception is resolved through a supported, audited
 * path (OPEN -> RESOLVED with who, when and why), never by editing or deleting rows. History is kept.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const resolve = async (db: Db, exc: string, by: string, note: string) =>
  (await db.query<{ r: R }>(`select ops_resolve_exception($1, $2, $3) r`, [exc, by, note]))[0]!.r;

describe.each(TARGETS)('exception resolution [%s]', (target) => {
  let db: Db; let exc: string;
  const row = async () => (await db.query<R>(`select resolution_status, error_message, resolution_note, resolved_at is not null resolved,
      (select employee_code from employees e where e.id = x.resolved_by) resolved_by, resolved_by_system from workflow_exceptions x where exception_number = $1`, [exc]))[0]!;
  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    // A real exception: an invoice preview asked for a project that is not complete (opened by the normal path).
    const [{ r }] = await db.query<{ r: R }>(`select wf_invoice_prepare($1::jsonb, 'test') r`, [JSON.stringify({ event_id: 'EVT-EXC-1', event_type: 'invoice.prepare_requested',
      source: 'airtable', actor_id: 'usr7uCnNO15fCefbH', occurred_at: new Date().toISOString(), payload: { project_number: 'PRJ-2026-0009' } })]) as [{ r: R }];
    exc = String(r.exception_number);
    expect(exc).toMatch(/^EXC-/);
  }, 120_000);
  afterAll(async () => { await db.close(); });

  it('refuses a resolution without a real note, by an unknown, inactive or unauthorised person, or of an unknown exception; nothing changes', async () => {
    await db.exec(`update employees set is_active = false where employee_code = 'EMP-007'`);
    for (const [e, by, note, why] of [
      [exc, 'EMP-900', '  ', /note/], [exc, 'EMP-900', 'ok', /note/], [exc, 'EMP-999', 'Checked with the customer; not needed', /EMP-999/],
      [exc, 'EMP-007', 'Checked with the customer; not needed', /not active/], [exc, 'EMP-002', 'Checked with the customer; not needed', /may not resolve/],
      ['EXC-9999', 'EMP-900', 'Checked with the customer; not needed', /EXC-9999/],
    ] as [string, string, string, RegExp][]) {
      expect(await resolve(db, e, by, note), `${e} ${by} ${note}`).toMatchObject({ resolved: false, reason: expect.stringMatching(why) as unknown });
    }
    expect(await row()).toMatchObject({ resolution_status: 'OPEN', resolved: false, resolved_by: null, resolution_note: null });
    expect(await col(db, `select count(*)::text v from audit_events where action = 'exception.resolved'`)).toEqual(['0']);
  });

  it('OPEN -> RESOLVED records who, when and why, audits it with before and after, keeps the record, and is idempotent', async () => {
    const before = await row();
    const count = await col(db, `select count(*)::text v from workflow_exceptions`);
    const note = 'Project is still in Planning; the invoice will be prepared when it is completed';
    expect(await resolve(db, exc, 'EMP-900', note)).toMatchObject({ resolved: true, exception_number: exc, resolved_by: 'EMP-900' });
    expect(await row()).toMatchObject({ resolution_status: 'RESOLVED', resolved: true, resolved_by: 'EMP-900', resolution_note: note,
                                        error_message: before.error_message, resolved_by_system: null });   // the original failure is kept
    expect(await col(db, `select count(*)::text v from workflow_exceptions`)).toEqual(count);               // nothing deleted
    expect(await col(db, `select actor_type || ' ' || actor_id || ' ' || (before_state ->> 'resolution_status') || '->' || (after_state ->> 'resolution_status') || ' ' || reason v
                          from audit_events where action = 'exception.resolved' and business_reference = $1`, [exc]))
      .toEqual([`USER EMP-900 OPEN->RESOLVED ${note}`]);
    // Asking again changes nothing and adds no audit row.
    expect(await resolve(db, exc, 'EMP-001', 'A different note later')).toMatchObject({ resolved: false, already_resolved: true, reason: expect.stringMatching(/already RESOLVED by EMP-900/) as unknown });
    expect(await row()).toMatchObject({ resolved_by: 'EMP-900', resolution_note: note });
    expect(await col(db, `select count(*)::text v from audit_events where action = 'exception.resolved'`)).toEqual(['1']);
    expect(await col(db, `select coalesce(verify_audit_chain()::text, 'intact') v`)).toEqual(['intact']);
  });

  it('only the operator path can resolve: neither application role can call it or edit exceptions directly', async () => {
    for (const role of ['roofops_dashboard', 'roofops_workflow']) {
      expect(await col(db, `select has_function_privilege($1, 'ops_resolve_exception(text,text,text)', 'execute')::text v`, [role])).toEqual(['false']);
      expect(await col(db, `select has_table_privilege($1, 'workflow_exceptions', 'update')::text v`, [role])).toEqual(['false']);
    }
  });
});
