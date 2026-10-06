/**
 * AC-13B (docs/adversarial-test-catalogue.md AC-13, pre-start half): a job could go Scheduled -> In Progress with the
 * required PRE_START items (SWMS signed, materials reviewed) still OPEN: the transition checked only Planned Start, and
 * nothing could set the items at all.
 *
 * Invariant: a project enters In Progress only if every required PRE_START item is Done, or Waived / Not applicable with
 * a reason where the business rules allow it (SWMS: Done only, setting checklist.not_waivable; materials review: Done,
 * Waived or Not applicable). Pre-start items change only through Airtable (SWMS Signed / Materials Reviewed + a Note
 * each); Postgres enforces the checklist state machine, the reason, attribution to a mapped RoofOps employee, and a lock
 * once work has started (or the job is Closed / Cancelled). Completion items stay AC-13A's.
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const T_PROJECTS = 'tblvUPIoebC3zoacv';
const F = {
  status: 'fldi2Qwz1dAh2tcTE', reason: 'fld5MhzMBtA4CBUHo', start: 'fld8rf6RZLgfs6Ron', end: 'fldvZtiassZEgLMAN',
  swms: 'fldM6kgPz6QZagPAC', swmsNote: 'fldNcsIgH6TfQFfaU', materials: 'fldozWSCU877wEZHq', materialsNote: 'fldEtAmAokIvtzJdn',
};
const APPROVER = 'usr7uCnNO15fCefbH';            // mapped to EMP-900
const UNMAPPED = 'usrSTAFFMEMBER01';
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;

describe.each(TARGETS)('AC-13B: no job starts before its pre-start items are satisfied [%s]', (target) => {
  let db: Db;
  let seq = 0;
  const q = (sql: string, p: unknown[] = []) => db.query<R>(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0]!;
  const call = async (fn: string, ...a: unknown[]) =>
    (await one(`select ${fn}(${a.map((_, i) => `$${String(i + 1)}`).join(', ')}) r`, a.map((x) => (x !== null && typeof x === 'object' ? JSON.stringify(x) : x)))).r as R;
  const force = async (sql: string, p: unknown[] = []) => {
    await db.exec(`set session_replication_role = replica`);
    try { await q(sql, p); } finally { await db.exec(`set session_replication_role = origin`).catch(() => undefined); }
  };
  /** An Airtable Projects edit exactly as n8n 06 hands it over. */
  const change = (project: string, fields: R, o: { actor?: string; at?: string; id?: string; current?: R; source?: string } = {}) => {
    seq += 1;
    return call('wf_airtable_change', {
      event_id: o.id ?? `airtable:achPRE:txn${String(seq)}:${recFor(project)}`, source: o.source ?? 'airtable', actor_id: o.actor ?? APPROVER,
      occurred_at: o.at ?? new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString(), table_id: T_PROJECTS, record_id: recFor(project),
      changes: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { current: v }])), current: { ...(o.current ?? {}), ...fields },
    }, o.source === 'reconciler' ? 'reconciler' : 'test');
  };
  const rejectedReason = (r: R) => ((r.rejected as { reason?: string }[] | undefined) ?? [])[0]?.reason ?? '';
  const items = async (project: string) => Object.fromEntries((await q(`
      select ci.item_code, ci.status, ci.completed_on::text completed_on, e.employee_code completed_by, ci.waived_reason
        from project_checklist_items ci join projects p on p.id = ci.project_id left join employees e on e.id = ci.completed_by
       where p.project_number = $1 and ci.stage = 'PRE_START'`, [project])).map((r) => [String(r.item_code), r]));
  const status = async (project: string) => String((await one(`select status from projects where project_number = $1`, [project])).status);
  const audits = async (project: string) => Number((await one(`select count(*)::int n from audit_events where action = 'project.checklist.changed' and business_reference = $1`, [project])).n);
  /** A fresh project born from quote acceptance (both PRE_START items OPEN), linked to Airtable and Scheduled with a Planned Start. */
  const born = async (scheduled = true) => {
    const quote = 'Q-2026-0041';                                  // every test runs in its own rolled-back transaction
    const r = await call('wf_quote_accepted', { event_id: `EVT-PRE-${quote}`, correlation_id: `CORR-PRE-${quote}`, event_type: 'quote.accepted', source: 'airtable',
      actor_id: 'airtable-automation', occurred_at: '2026-09-29T09:00:00+10:00', payload: { quote_id: quote, accepted_version: 1, accepted_on: '2026-09-29', airtable_record_id: 'recTESTTESTTEST01' } });
    const P = String(r.project_number);
    expect(P).toMatch(/^PRJ-2026-\d{4}$/);
    await q(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
             select 'AIRTABLE', 'project', id, 'Record', $2, now(), now() from projects where project_number = $1`, [P, recFor(P)]);
    expect(await change(P, { [F.start]: '2026-10-05', [F.end]: '2026-10-20' })).toMatchObject({ outcome: 'APPLIED' });
    if (scheduled) expect(await change(P, { [F.status]: 'Scheduled' })).toMatchObject({ outcome: 'APPLIED' });
    return P;
  };
  const start = (P: string) => change(P, { [F.status]: 'In Progress' });

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
  }, 120_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.exec('begin'); });
  afterEach(async () => { await db.exec('rollback'); });

  it('the two pre-start fields are supported staff edits, projected to Airtable; SWMS is not waivable', async () => {
    const P = await born(false);
    expect(await items(P)).toMatchObject({ SWMS_SIGNED: { status: 'OPEN' }, MATERIALS_REVIEWED: { status: 'OPEN' } });
    expect((await one(`select x.expected from v_airtable_expected x join projects p on p.id = x.entity_id where p.project_number = $1`, [P])).expected)
      .toMatchObject({ [F.swms]: 'To do', [F.materials]: 'To do' });
    expect(await q(`select airtable_name, owner, reconcile from field_contract where airtable_field_id = any($1) order by airtable_name`, [[F.swms, F.swmsNote, F.materials, F.materialsNote]])).toEqual([
      { airtable_name: 'Materials Reviewed', owner: 'AIRTABLE_EDIT', reconcile: 'APPLY_VIA_HANDLER' },
      { airtable_name: 'Materials Reviewed Note', owner: 'INPUT', reconcile: 'IGNORE' },
      { airtable_name: 'SWMS Signed', owner: 'AIRTABLE_EDIT', reconcile: 'APPLY_VIA_HANDLER' },
      { airtable_name: 'SWMS Signed Note', owner: 'INPUT', reconcile: 'IGNORE' }]);
    expect((await one(`select value from app_settings where key = 'checklist.not_waivable'`)).value).toBe('SWMS_SIGNED');
  });

  it('1 + 12. a satisfied checklist: both Done (even while Planning), then Scheduled -> In Progress applies', async () => {
    const P = await born(false);
    expect(await change(P, { [F.swms]: 'Done' })).toMatchObject({ outcome: 'APPLIED', corrections: {} });       // before scheduling is fine
    expect(await change(P, { [F.status]: 'Scheduled' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await change(P, { [F.materials]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await items(P)).toMatchObject({ SWMS_SIGNED: { status: 'DONE', completed_by: 'EMP-900' }, MATERIALS_REVIEWED: { status: 'DONE', completed_by: 'EMP-900' } });
    expect(await start(P)).toMatchObject({ outcome: 'APPLIED' });
    expect(await status(P)).toBe('IN_PROGRESS');
  });

  it('2 + 11. SWMS not signed: In Progress is refused, the row stays Scheduled and Airtable is corrected', async () => {
    const P = await born();
    expect(await change(P, { [F.materials]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
    const r = await start(P);
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/Safe Work Method Statement signed/)]);
    expect(r.corrections).toMatchObject({ [F.status]: 'Scheduled' });
    expect(await status(P)).toBe('SCHEDULED');
    expect((await one(`select actual_start_date from projects where project_number = $1`, [P])).actual_start_date).toBeNull();
  });

  it('3. materials not reviewed: In Progress is refused', async () => {
    const P = await born();
    expect(await change(P, { [F.swms]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
    const r = await start(P);
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/Materials reviewed and approved/)]);
    expect(await status(P)).toBe('SCHEDULED');
  });

  it('4. materials review waived with a reason: recorded and attributed, and the job may start', async () => {
    const P = await born();
    expect(await change(P, { [F.swms]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await change(P, { [F.materials]: 'Waived' }, { current: { [F.materialsNote]: 'Customer supplies all materials' } })).toMatchObject({ outcome: 'APPLIED' });
    expect((await items(P)).MATERIALS_REVIEWED).toMatchObject({ status: 'WAIVED', waived_reason: 'Customer supplies all materials' });
    expect(await one(`select actor_id, after_state from audit_events where action = 'project.checklist.changed' and business_reference = $1 order by seq desc limit 1`, [P]))
      .toMatchObject({ actor_id: APPROVER, after_state: { item: 'MATERIALS_REVIEWED', status: 'WAIVED', employee: 'EMP-900', reason: 'Customer supplies all materials' } });
    expect(await start(P)).toMatchObject({ outcome: 'APPLIED' });
  });

  it('5. waived without a reason is refused; the job still cannot start', async () => {
    const P = await born();
    await change(P, { [F.swms]: 'Done' });
    const r = await change(P, { [F.materials]: 'Waived' }, { current: { [F.materialsNote]: '  ' } });
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/Materials Reviewed Note/)]);
    expect(r.corrections).toMatchObject({ [F.materials]: 'To do' });
    expect(await start(P)).toMatchObject({ outcome: 'REJECTED' });
  });

  it('6. not applicable: allowed for materials review with a reason; never for the SWMS (Done only)', async () => {
    const P = await born();
    expect(await change(P, { [F.materials]: 'Not applicable' }, { current: { [F.materialsNote]: 'Labour-only repair' } })).toMatchObject({ outcome: 'APPLIED' });
    for (const v of ['Not applicable', 'Waived']) {
      const r = await change(P, { [F.swms]: v }, { current: { [F.swmsNote]: 'Small job' } });
      expect([v, r.outcome, rejectedReason(r)]).toEqual([v, 'REJECTED', expect.stringMatching(/cannot be waived or marked not applicable/)]);
    }
    expect((await items(P)).SWMS_SIGNED).toMatchObject({ status: 'OPEN' });
    expect(await start(P)).toMatchObject({ outcome: 'REJECTED' });
    await change(P, { [F.swms]: 'Done' });
    expect(await start(P)).toMatchObject({ outcome: 'APPLIED' });
  });

  it('7. an unmapped Airtable user cannot sign off a pre-start item', async () => {
    const P = await born();
    const r = await change(P, { [F.swms]: 'Done' }, { actor: UNMAPPED });
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/not mapped to a RoofOps employee/)]);
    expect(r.corrections).toMatchObject({ [F.swms]: 'To do' });
    expect((await items(P)).SWMS_SIGNED).toMatchObject({ status: 'OPEN' });
  });

  it('8 + 9. a duplicate delivery applies once; an older edit delivered late is ignored', async () => {
    const P = await born();
    const before = await audits(P);
    const id = `airtable:achPRE:txnDUP:${recFor(P)}`;
    const at = new Date(Date.UTC(2026, 9, 5)).toISOString();
    expect(await change(P, { [F.swms]: 'Done' }, { id, at })).toMatchObject({ outcome: 'APPLIED' });
    expect(await change(P, { [F.swms]: 'Done' }, { id, at })).toMatchObject({ duplicate: true });
    expect(await audits(P)).toBe(before + 1);
    const late = await change(P, { [F.swms]: 'To do' }, { at: new Date(Date.UTC(2026, 9, 2)).toISOString() });
    expect(late.stale).toHaveLength(1);
    expect((await items(P)).SWMS_SIGNED).toMatchObject({ status: 'DONE' });
  });

  it('10. a missed edit replayed by reconciliation has no Airtable user: not applied, Airtable corrected, the job cannot start', async () => {
    const P = await born();
    const r = await change(P, { [F.swms]: 'Done' }, { source: 'reconciler', actor: 'reconciliation', id: `reconcile:RECON-PRE:${recFor(P)}:${F.swms}` });
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/attribut/)]);
    expect(r.corrections).toMatchObject({ [F.swms]: 'To do' });
    expect((await items(P)).SWMS_SIGNED).toMatchObject({ status: 'OPEN' });
    expect(await start(P)).toMatchObject({ outcome: 'REJECTED' });
  });

  it('13. a cancelled project: the pre-start checklist is locked (cancelling itself is never blocked by it)', async () => {
    const P = await born();
    expect(await change(P, { [F.status]: 'Cancelled' }, { current: { [F.reason]: 'Customer withdrew' } })).toMatchObject({ outcome: 'APPLIED' });
    const r = await change(P, { [F.swms]: 'Done' });
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/cancelled/i)]);
  });

  it('14. once work has started the pre-start checklist is locked (it was the gate), also while On Hold', async () => {
    const P = await born();
    await change(P, { [F.swms]: 'Done' });
    await change(P, { [F.materials]: 'Done' });
    expect(await start(P)).toMatchObject({ outcome: 'APPLIED' });
    const r = await change(P, { [F.swms]: 'To do' });
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/work on .* has started/)]);
    expect(r.corrections).toMatchObject({ [F.swms]: 'Done' });
    expect(await change(P, { [F.status]: 'On Hold' }, { current: { [F.reason]: 'Rain' } })).toMatchObject({ outcome: 'APPLIED' });
    expect(await change(P, { [F.materials]: 'To do' })).toMatchObject({ outcome: 'REJECTED' });
    expect(await start(P)).toMatchObject({ outcome: 'APPLIED' });                    // resume: the gate was passed at the first start
  });

  it('15. invalid orderings stay refused: Planning -> In Progress, no Planned Start, never-started On Hold -> In Progress', async () => {
    const P = await born(false);
    await change(P, { [F.swms]: 'Done' });
    await change(P, { [F.materials]: 'Done' });
    expect(await start(P)).toMatchObject({ outcome: 'REJECTED' });                  // Planning -> In Progress is not a transition
    expect(await status(P)).toBe('PLANNING');
    const Q = P;
    await change(Q, { [F.status]: 'Scheduled' });
    expect(await change(Q, { [F.status]: 'On Hold' }, { current: { [F.reason]: 'Waiting' } })).toMatchObject({ outcome: 'APPLIED' });
    expect(rejectedReason(await start(Q))).toMatch(/never started/);
    expect(await status(Q)).toBe('ON_HOLD');
  });

  it('the guard itself (any path, not just Airtable): open pre-start items refuse IN_PROGRESS, even by direct update', async () => {
    const P = await born();
    expect(String((await one(`select project_transition_guard(p, 'IN_PROGRESS') v from projects p where project_number = $1`, [P])).v)).toMatch(/pre-start items are still open/);
    await expect(q(`update projects set status = 'IN_PROGRESS' where project_number = $1`, [P])).rejects.toThrow(/pre-start items are still open/);
  });

  it('imported projects without pre-start items keep their historical behaviour (known limitation, owner decision)', async () => {
    expect(await q(`select count(*)::int n from project_checklist_items ci join projects p on p.id = ci.project_id where p.project_number = 'PRJ-2026-0011' and ci.stage = 'PRE_START'`)).toEqual([{ n: 0 }]);
    expect((await one(`select project_transition_guard(p, 'IN_PROGRESS') v from projects p where project_number = 'PRJ-2026-0011'`)).v).toBeNull();
  });

  it('integrity: a started project with open pre-start items is a FAIL (only reachable by bypassing the guard)', async () => {
    expect(await one(`select status from integrity_check() where check_key = 'started_with_pre_start_open'`)).toMatchObject({ status: 'PASS' });
    const P = await born();
    await db.exec('savepoint s');
    try {
      await force(`update projects set status = 'IN_PROGRESS', actual_start_date = app_today() where project_number = $1`, [P]);
      expect(await one(`select status, refs from integrity_check() where check_key = 'started_with_pre_start_open'`)).toMatchObject({ status: 'FAIL', refs: [expect.stringMatching(new RegExp(P)) as unknown] });
    } finally { await db.exec('rollback to savepoint s'); }
  });
});
