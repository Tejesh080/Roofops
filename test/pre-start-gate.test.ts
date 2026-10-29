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
import { openPostgres, type Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const T_PROJECTS = 'tblvUPIoebC3zoacv';
const F = {
  status: 'fldi2Qwz1dAh2tcTE', reason: 'fld5MhzMBtA4CBUHo', start: 'fld8rf6RZLgfs6Ron', end: 'fldvZtiassZEgLMAN',
  swms: 'fldM6kgPz6QZagPAC', swmsNote: 'fldNcsIgH6TfQFfaU', materials: 'fldozWSCU877wEZHq', materialsNote: 'fldEtAmAokIvtzJdn',
  photos: 'fldbbksVL3dT6cqyS', photosNote: 'fldA77ad94yUmvnu3', sync: 'fldVrJOuyhbNtxnVh',
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

  it('6b. not applicable on materials review needs a reason, the same as waived', async () => {
    const P = await born();
    const r = await change(P, { [F.materials]: 'Not applicable' }, { current: { [F.materialsNote]: '  ' } });
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/needs a reason in Materials Reviewed Note/)]);
    expect((await items(P)).MATERIALS_REVIEWED).toMatchObject({ status: 'OPEN' });
  });

  it('an Actual Start written directly cannot skip the gate: the status decides, not the date', async () => {
    const P = await born();
    expect(await change(P, { [F.materials]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
    await force(`update projects set actual_start_date = app_today() where project_number = $1`, [P]);
    const r = await start(P);
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/pre-start items are still open \(Safe Work Method Statement signed\)/)]);
    expect(await status(P)).toBe('SCHEDULED');
  });

  it('AC-13C: nor on resume: Actual Start written directly, then On Hold, then In Progress with the SWMS open is refused', async () => {
    // Audit D1-ONHOLD: the gate checked only Scheduled -> In Progress, so a job given an Actual Start directly could be
    // paused and "resumed" into work it never passed the gate for (and integrity started_with_pre_start_open FAILed).
    const P = await born();
    expect(await change(P, { [F.materials]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
    await force(`update projects set actual_start_date = app_today() where project_number = $1`, [P]);
    expect(await change(P, { [F.status]: 'On Hold' }, { current: { [F.reason]: 'Waiting for the crew' } })).toMatchObject({ outcome: 'APPLIED' });
    const r = await start(P);
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/pre-start items are still open \(Safe Work Method Statement signed\)/)]);
    expect(r.corrections).toMatchObject({ [F.status]: 'On Hold' });
    expect(await status(P)).toBe('ON_HOLD');
    await expect(q(`update projects set status = 'IN_PROGRESS' where project_number = $1`, [P])).rejects.toThrow(/pre-start items are still open/);
  });

  it('AC-13C: a job that really started, then On Hold, resumes: its items were satisfied and are locked', async () => {
    const P = await born();
    await change(P, { [F.swms]: 'Done' });
    await change(P, { [F.materials]: 'Waived' }, { current: { [F.materialsNote]: 'Customer supplies all materials' } });
    expect(await start(P)).toMatchObject({ outcome: 'APPLIED' });
    expect(await change(P, { [F.status]: 'On Hold' }, { current: { [F.reason]: 'Rain' } })).toMatchObject({ outcome: 'APPLIED' });
    expect((await one(`select project_transition_guard(p, 'IN_PROGRESS') v from projects p where project_number = $1`, [P])).v).toBeNull();
    expect(await start(P)).toMatchObject({ outcome: 'APPLIED' });
    expect(await status(P)).toBe('IN_PROGRESS');
  });

  it('CC-10: an imported project has no pre-start items; the refusal names the item as Airtable does (SWMS Signed)', async () => {
    const r = await change('PRJ-2026-0011', { [F.swms]: 'Done' });
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', 'PRJ-2026-0011 has no SWMS Signed item (not required for this project)']);
    const m = await change('PRJ-2026-0011', { [F.materials]: 'Done' });
    expect([m.outcome, rejectedReason(m)]).toEqual(['REJECTED', 'PRJ-2026-0011 has no Materials Reviewed item (not required for this project)']);
  });

  it('the dashboard card follows the canonical item until work starts: a completed material-review task is not Materials Reviewed', async () => {
    const P = await born();
    await force(`update tasks set status = 'DONE', completed_at = now() where task_type = 'MATERIAL_REVIEW'
                   and project_id = (select id from projects where project_number = $1)`, [P]);
    const card = async () => (await one(`select status from v_dashboard_project_checklist where project_number = $1 and title = 'Materials reviewed and approved'`, [P])).status;
    expect(await card()).toBe('OPEN');
    await force(`update projects set actual_start_date = app_today() where project_number = $1`, [P]);
    expect(await card()).toBe('DONE');                                       // started jobs keep the 2026-10-17 display
  });

  it('only a pre-start item may be Done while Scheduled: an invoicing item keeps its work-must-start rule', async () => {
    const P = await born();
    const id = (await one(`select id from projects where project_number = $1`, [P])).id;
    const r = await one(`select checklist_apply_change($1, 'FINAL_INVOICE_APPROVED', 'Done', null, $2, $3) r`, [id, APPROVER, `k-final-${String(++seq)}`]);
    expect(String(r.r)).toMatch(/a completion item can be Done only once the job is In Progress/);
  });

  describe('a checklist Note edited on its own (AC-13B review: it used to be dropped)', () => {
    const waive = async (P: string, reason = 'Customer supplies all materials') => {
      expect(await change(P, { [F.materials]: 'Waived' }, { current: { [F.materialsNote]: reason } })).toMatchObject({ outcome: 'APPLIED' });
    };
    const lastAudit = async (P: string) =>
      one(`select actor_id, after_state from audit_events where action = 'project.checklist.changed' and business_reference = $1 order by seq desc limit 1`, [P]);

    it('replaces the recorded reason of a waived item, attributed and audited, with nothing to correct in Airtable', async () => {
      const P = await born();
      await waive(P);
      const before = await audits(P);
      const r = await change(P, { [F.materialsNote]: 'Customer supplies all materials; delivered on site' });
      expect(r).toMatchObject({ outcome: 'APPLIED', corrections: {},
        applied: [{ field: 'Materials Reviewed Note', from: 'Customer supplies all materials', to: 'Customer supplies all materials; delivered on site' }] });
      expect((await items(P)).MATERIALS_REVIEWED).toMatchObject({ status: 'WAIVED', waived_reason: 'Customer supplies all materials; delivered on site' });
      expect(await audits(P)).toBe(before + 1);
      expect(await lastAudit(P)).toMatchObject({ actor_id: APPROVER,
        after_state: { item: 'MATERIALS_REVIEWED', status: 'WAIVED', employee: 'EMP-900', reason: 'Customer supplies all materials; delivered on site' } });
    });

    it('a blank Note on a waived item is refused: the reason is kept and Airtable gets it back, with RoofOps Sync saying why', async () => {
      const P = await born();
      await waive(P);
      const r = await change(P, { [F.materialsNote]: '   ' });
      expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', 'Waived needs a reason in Materials Reviewed Note']);
      expect(r.corrections).toMatchObject({ [F.materialsNote]: 'Customer supplies all materials' });
      expect(String((r.corrections as R)[F.sync])).toMatch(/✗ Materials Reviewed Note: ".*" not applied: Waived needs a reason/);
      expect((await items(P)).MATERIALS_REVIEWED).toMatchObject({ status: 'WAIVED', waived_reason: 'Customer supplies all materials' });
    });

    it('an unmapped Airtable user cannot change a recorded reason', async () => {
      const P = await born();
      await waive(P);
      const r = await change(P, { [F.materialsNote]: 'Something else' }, { actor: UNMAPPED });
      expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/not mapped to a RoofOps employee/)]);
      expect(r.corrections).toMatchObject({ [F.materialsNote]: 'Customer supplies all materials' });
      expect((await items(P)).MATERIALS_REVIEWED).toMatchObject({ waived_reason: 'Customer supplies all materials' });
    });

    it('once work has started the pre-start reasons are locked too: refused and put back', async () => {
      const P = await born();
      await change(P, { [F.swms]: 'Done' });
      await change(P, { [F.materials]: 'Not applicable' }, { current: { [F.materialsNote]: 'Labour-only repair' } });
      expect(await start(P)).toMatchObject({ outcome: 'APPLIED' });
      const r = await change(P, { [F.materialsNote]: 'Changed after the start' });
      expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/the pre-start checklist is locked: work on .* has started/)]);
      expect(r.corrections).toMatchObject({ [F.materialsNote]: 'Labour-only repair' });
      expect((await items(P)).MATERIALS_REVIEWED).toMatchObject({ status: 'NOT_APPLICABLE', waived_reason: 'Labour-only repair' });
    });

    it('on an item that is To do or Done a Note is not a reason: nothing is recorded or corrected', async () => {
      const P = await born();
      await change(P, { [F.swms]: 'Done' });
      const before = await audits(P);
      expect(await change(P, { [F.swmsNote]: 'Signed on site by the crew lead' })).toMatchObject({ outcome: 'NO_CHANGE', corrections: {} });
      expect(await change(P, { [F.materialsNote]: 'Waiting for the supplier' })).toMatchObject({ outcome: 'NO_CHANGE', corrections: {} });
      expect(await audits(P)).toBe(before);
      expect(await items(P)).toMatchObject({ SWMS_SIGNED: { status: 'DONE', waived_reason: null }, MATERIALS_REVIEWED: { status: 'OPEN', waived_reason: null } });
    });

    it('a Note that changed together with its item is read with the item once, not applied a second time', async () => {
      const P = await born();
      const before = await audits(P);
      const r = await change(P, { [F.materials]: 'Waived', [F.materialsNote]: 'Customer supplies all materials' });
      expect(r).toMatchObject({ outcome: 'APPLIED' });
      expect((r.applied as R[]).map((a) => a.field)).toEqual(['Materials Reviewed']);
      expect(await audits(P)).toBe(before + 1);
      expect((await items(P)).MATERIALS_REVIEWED).toMatchObject({ status: 'WAIVED', waived_reason: 'Customer supplies all materials' });
    });

    it('a duplicate delivery applies once; an older Note edit delivered late is ignored', async () => {
      const P = await born();
      await waive(P);
      const before = await audits(P);
      const id = `airtable:achPRE:txnNOTE:${recFor(P)}`;
      const at = new Date(Date.UTC(2026, 9, 6)).toISOString();
      expect(await change(P, { [F.materialsNote]: 'Reason B' }, { id, at })).toMatchObject({ outcome: 'APPLIED' });
      expect(await change(P, { [F.materialsNote]: 'Reason B' }, { id, at })).toMatchObject({ duplicate: true, outcome: 'APPLIED' });
      expect(await audits(P)).toBe(before + 1);
      const late = await change(P, { [F.materialsNote]: 'Reason A (older)' }, { at: new Date(Date.UTC(2026, 9, 5)).toISOString() });
      expect(late).toMatchObject({ outcome: 'STALE', stale: [{ field: 'Materials Reviewed Note' }] });
      expect((await items(P)).MATERIALS_REVIEWED).toMatchObject({ waived_reason: 'Reason B' });
    });

    it('the same path holds for the AC-13A completion Notes', async () => {
      const P = await born();
      await change(P, { [F.swms]: 'Done' });
      await change(P, { [F.materials]: 'Done' });
      expect(await start(P)).toMatchObject({ outcome: 'APPLIED' });
      expect(await change(P, { [F.photos]: 'Not applicable' }, { current: { [F.photosNote]: 'Customer refused access for photos' } })).toMatchObject({ outcome: 'APPLIED' });
      const r = await change(P, { [F.photosNote]: 'Customer refused access for photos (email of 6 Oct)' });
      expect(r).toMatchObject({ outcome: 'APPLIED', applied: [{ field: 'Completion Photos Note' }] });
      expect((await one(`select ci.status, ci.waived_reason from project_checklist_items ci join projects p on p.id = ci.project_id
                          where p.project_number = $1 and ci.item_code = 'COMPLETION_PHOTOS'`, [P])))
        .toEqual({ status: 'NOT_APPLICABLE', waived_reason: 'Customer refused access for photos (email of 6 Oct)' });
    });
  });
});

/**
 * Real concurrency (Postgres only: PGlite has one connection). A checklist change and the start of work on the same job,
 * in two transactions at once, must serialise: whichever commits first decides, and a job is never In Progress with a
 * required pre-start item open. Through Airtable both sides lock the project row in the handler; directly, the start's
 * UPDATE holds the row and checklist_apply_change locks it first (the AC-13B review fix). Each case commits for real
 * in its own throwaway database, on four imported Scheduled projects given the two pre-start items.
 */
describe.runIf(TARGETS.includes('postgres'))('AC-13B: a checklist change and the start of work serialise (two Postgres connections)', () => {
  let db: Db & { url?: string };
  let seq = 0;
  const val = async (c: Db, sql: string, p: unknown[] = []) => String(Object.values((await c.query<R>(sql, p))[0]!)[0]);
  const edit = async (c: Db, project: string, fields: R) => {
    seq += 1;
    const ev = { event_id: `airtable:achRACE:txn${String(seq)}:${recFor(project)}`, source: 'airtable', actor_id: APPROVER,
      occurred_at: new Date(Date.UTC(2026, 9, 2) + seq * 1000).toISOString(), table_id: T_PROJECTS, record_id: recFor(project),
      changes: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { current: v }])), current: fields };
    return (await c.query<{ r: R }>(`select wf_airtable_change($1::jsonb, 'race-test') r`, [JSON.stringify(ev)]))[0]!.r;
  };
  const reason = (r: R) => ((r.rejected as { reason?: string }[] | undefined) ?? [])[0]?.reason ?? '';
  const state = async (project: string) => (await db.query<R>(`select p.status, ci.status swms from projects p
      join project_checklist_items ci on ci.project_id = p.id and ci.item_code = 'SWMS_SIGNED' where p.project_number = $1`, [project]))[0];
  /** True once the backend `pid` is blocked on a lock (checked from a third connection), as in state-integrity.test.ts. */
  const waitingOnLock = async (pid: string) => {
    const w = await openPostgres(db.url!);
    try {
      for (let i = 0; i < 100; i += 1) {
        if (await val(w, `select count(*)::text v from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`, [Number(pid)]) === '1') return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    } finally { await w.close(); }
  };
  /** An imported Scheduled project given both pre-start items, both signed off through the real Airtable path. */
  const ready = async (project: string) => {
    await db.query(`insert into project_checklist_items (project_id, item_code, label, stage, sort_order)
      select id, x.code, x.label, 'PRE_START', x.ord from projects, (values ('MATERIALS_REVIEWED', 'Materials reviewed and approved', 10),
        ('SWMS_SIGNED', 'Safe Work Method Statement signed', 20)) as x(code, label, ord) where project_number = $1`, [project]);
    for (const f of [F.swms, F.materials]) expect(await edit(db, project, { [f]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await state(project)).toEqual({ status: 'SCHEDULED', swms: 'DONE' });
    return val(db, `select id::text v from projects where project_number = $1`, [project]);
  };
  /** Runs `first` in an open transaction on connection a, starts `second` on connection b, proves b waits, then commits a. */
  const race = async <T>(first: (a: Db) => Promise<unknown>, second: (b: Db) => Promise<T>) => {
    const a = await openPostgres(db.url!);
    const b = await openPostgres(db.url!);
    try {
      await a.exec('begin');
      await first(a);
      const bPid = await val(b, `select pg_backend_pid()::text v`);
      const pending = second(b);
      const waited = await waitingOnLock(bPid);
      await a.exec('commit');
      return { waited, result: await pending };
    } finally { await a.close(); await b.close(); }
  };

  beforeAll(async () => {
    db = await migratedDb('postgres');
    await importBundle(db);
    await db.exec(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
  }, 120_000);
  afterAll(async () => { await db.close(); });

  it('through Airtable, checklist first: SWMS back to To do is committing; the start waits, then is refused', async () => {
    await ready('PRJ-2026-0015');
    const { waited, result } = await race((a) => edit(a, 'PRJ-2026-0015', { [F.swms]: 'To do' }), (b) => edit(b, 'PRJ-2026-0015', { [F.status]: 'In Progress' }));
    expect(waited).toBe(true);
    expect([result.outcome, reason(result)]).toEqual(['REJECTED', expect.stringMatching(/pre-start items are still open \(Safe Work Method Statement signed\)/)]);
    expect(await state('PRJ-2026-0015')).toEqual({ status: 'SCHEDULED', swms: 'OPEN' });
  });

  it('through Airtable, start first: the job is starting; SWMS back to To do waits, then is refused as locked', async () => {
    await ready('PRJ-2026-0019');
    const { waited, result } = await race((a) => edit(a, 'PRJ-2026-0019', { [F.status]: 'In Progress' }), (b) => edit(b, 'PRJ-2026-0019', { [F.swms]: 'To do' }));
    expect(waited).toBe(true);
    expect([result.outcome, reason(result)]).toEqual(['REJECTED', expect.stringMatching(/the pre-start checklist is locked: work on PRJ-2026-0019 has started/)]);
    expect(await state('PRJ-2026-0019')).toEqual({ status: 'IN_PROGRESS', swms: 'DONE' });
  });

  it('directly, start first: the status UPDATE holds the row; checklist_apply_change waits for it (its lock), then refuses', async () => {
    const id = await ready('PRJ-2026-0023');
    const { waited, result } = await race(
      (a) => a.query(`update projects set status = 'IN_PROGRESS', actual_start_date = app_today() where id = $1`, [id]),
      async (b) => (await b.query<{ r: string | null }>(`select checklist_apply_change($1, 'SWMS_SIGNED', 'To do', null, $2, 'race:direct:1') r`, [id, APPROVER]))[0]!.r);
    expect(waited).toBe(true);
    expect(String(result)).toMatch(/the pre-start checklist is locked: work on PRJ-2026-0023 has started/);
    expect(await state('PRJ-2026-0023')).toEqual({ status: 'IN_PROGRESS', swms: 'DONE' });
    expect(await val(db, `select status from integrity_check() where check_key = 'started_with_pre_start_open'`)).toBe('PASS');
  });

  it('directly, checklist first: checklist_apply_change holds the row; the status UPDATE waits, then the gate refuses it', async () => {
    const id = await ready('PRJ-2026-0027');
    const { waited, result } = await race(
      async (a) => {
        expect((await a.query<{ r: string | null }>(`select checklist_apply_change($1, 'SWMS_SIGNED', 'To do', null, $2, 'race:direct:2') r`, [id, APPROVER]))[0]!.r).toBeNull();
      },
      (b) => b.query(`update projects set status = 'IN_PROGRESS' where id = $1`, [id]).then(() => 'committed', (e: unknown) => (e as Error).message));
    expect(waited).toBe(true);
    expect(result).toMatch(/pre-start items are still open \(Safe Work Method Statement signed\)/);
    expect(await state('PRJ-2026-0027')).toEqual({ status: 'SCHEDULED', swms: 'OPEN' });
  });
});
