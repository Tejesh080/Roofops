/**
 * A cancelled job left its site visits live (audit finding E2-VISIT-CANCEL): the crew stayed booked and could still start
 * and complete them, and no check noticed. Migration 20261022050000: cancelling a job (through the Airtable handler, as n8n
 * 06 sends it) also cancels its booked visits (Scheduled, Weather delayed), audited one row per visit; on a Cancelled or
 * Closed job web_visit_update refuses start, reschedule and weather delay (PROJECT_CLOSED); a visit already under way can
 * still be completed; integrity closed_job_has_booked_visit (FAIL).
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const PW = 'visit cancel test pw 01';
const PEOPLE = [['EMP-810', 'planner', 'Synthetic Operations Planner', 'OPERATIONS_MANAGER'], ['EMP-811', 'crew1', 'Synthetic Leading Hand', 'FIELD_CREW'],
  ['EMP-812', 'crew2', 'Synthetic Roofer', 'FIELD_CREW']] as const;
const T_PROJECTS = 'tblvUPIoebC3zoacv';
const F = { status: 'fldi2Qwz1dAh2tcTE', reason: 'fld5MhzMBtA4CBUHo' };
const APPROVER = 'usr7uCnNO15fCefbH';            // mapped to EMP-900
const recFor = (key: string) => `rec${createHash('md5').update(key).digest('hex').slice(0, 14)}`;

describe.each(TARGETS)('a cancelled job frees its site visits [%s]', (target) => {
  let db: Db;
  let seq = 0;
  let today = '';
  const tok: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => db.query<R>(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0]!;
  const call = async (sql: string, p: unknown[]) => (await one(sql, p)).r as R;
  const force = async (sql: string, p: unknown[] = []) => {
    await db.exec(`set session_replication_role = replica`);
    try { await q(sql, p); } finally { await db.exec(`set session_replication_role = origin`).catch(() => undefined); }
  };
  const at = (days: number, hour: number) => `${new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00+10:00`;
  const schedule = (prj: string, start: string, end: string, key: string, crew = ['EMP-811', 'EMP-812']) =>
    call('select web_visit_schedule($1, $2, $3, $4, $5, $6, $7, $8, $9) r', [tok.planner, prj, 'INSTALL', start, end, crew, null, null, key]);
  const visit = (t: string, job: string, action: string, reason: string | null = null, start: string | null = null, end: string | null = null) =>
    one(`select record_version v from jobs where job_number = $1`, [job]).then((r) =>
      call('select web_visit_update($1, $2, $3, $4, $5, $6, $7) r', [t, job, action, r.v, reason, start, end]));
  const job = async (n: string) => one(`select status, status_reason from jobs where job_number = $1`, [n]);
  const cancel = async (project: string) => {
    seq += 1;
    return (await one(`select wf_airtable_change($1::jsonb, 'test') r`, [JSON.stringify({
      event_id: `airtable:achVISIT:txn${String(seq)}:${recFor(project)}`, source: 'airtable', actor_id: APPROVER,
      occurred_at: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString(), table_id: T_PROJECTS, record_id: recFor(project),
      changes: { [F.status]: { current: 'Cancelled' }, [F.reason]: { current: 'Customer withdrew' } },
      current: { [F.status]: 'Cancelled', [F.reason]: 'Customer withdrew' } })])).r as R;
  };
  const integrity = async () => one(`select status, refs from integrity_check() where check_key = 'closed_job_has_booked_visit'`);

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
    for (const [code, , name, role] of PEOPLE) {
      await db.query('insert into employees (employee_code, full_name, email, role, is_active) values ($1, $2, $3, $4, true)', [code, name, `${code.toLowerCase()}@example.test`, role]);
    }
    for (const [code, login] of PEOPLE) {
      expect((await db.query<{ r: R }>('select ops_staff_set_password($1, $2, $3) r', [code, login, PW]))[0]!.r).toMatchObject({ ok: true });
      tok[login] = String((await db.query<{ r: R }>('select web_staff_sign_in($1, $2) r', [login, PW]))[0]!.r.token);
    }
    today = String((await one('select app_today()::text d')).d);
  }, 180_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.exec('begin'); });
  afterEach(async () => { await db.exec('rollback'); });

  it('cancelling the job cancels its booked visits, audited per visit, and frees the crew', async () => {
    expect(await integrity()).toMatchObject({ status: 'PASS' });
    const a = await schedule('PRJ-2026-0011', at(1, 7), at(1, 11), 'vc-key-1');
    const b = await schedule('PRJ-2026-0011', at(2, 7), at(2, 11), 'vc-key-2');
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(await visit(tok.crew1!, String(b.job_number), 'weather_delay', 'Storm warning for the coast')).toMatchObject({ ok: true, status: 'WEATHER_DELAYED' });
    expect(await cancel('PRJ-2026-0011')).toMatchObject({ outcome: 'APPLIED' });
    for (const n of [a.job_number, b.job_number]) expect(await job(String(n))).toEqual({ status: 'CANCELLED', status_reason: 'Project cancelled' });
    expect(Number((await one(`select count(*) n from audit_events where action = 'job.cancel' and actor_id = 'project_transition' and business_reference = 'PRJ-2026-0011'`)).n)).toBe(2);
    expect((await one(`select after_state from audit_events where action = 'project.status.changed' and business_reference = 'PRJ-2026-0011' order by seq desc limit 1`)).after_state)
      .toMatchObject({ status: 'CANCELLED', visits_cancelled: 2 });
    // The same crew, the same time, another job: no longer double-booked.
    expect(await schedule('PRJ-2026-0015', at(1, 7), at(1, 11), 'vc-key-3')).toMatchObject({ ok: true, status: 'SCHEDULED' });
    expect(await integrity()).toMatchObject({ status: 'PASS' });
  });

  it('a visit already under way is left for the crew to complete; a completed visit is untouched', async () => {
    const done = await schedule('PRJ-2026-0011', at(1, 7), at(1, 9), 'vc-key-4');
    const live = await schedule('PRJ-2026-0011', at(1, 10), at(1, 12), 'vc-key-5');
    expect(await visit(tok.crew1!, String(done.job_number), 'start')).toMatchObject({ ok: true });
    expect(await visit(tok.crew1!, String(done.job_number), 'complete', 'All done')).toMatchObject({ ok: true, status: 'COMPLETED' });
    expect(await visit(tok.crew1!, String(live.job_number), 'start')).toMatchObject({ ok: true, status: 'IN_PROGRESS' });
    expect(await cancel('PRJ-2026-0011')).toMatchObject({ outcome: 'APPLIED' });
    expect(await job(String(done.job_number))).toMatchObject({ status: 'COMPLETED' });
    expect(await job(String(live.job_number))).toMatchObject({ status: 'IN_PROGRESS' });
    expect(await visit(tok.crew1!, String(live.job_number), 'weather_delay', 'Rain started')).toMatchObject({ ok: false, code: 'PROJECT_CLOSED' });
    expect(await visit(tok.crew1!, String(live.job_number), 'complete', 'Made safe and left')).toMatchObject({ ok: true, status: 'COMPLETED' });
  });

  it('on a cancelled or closed job a booked visit cannot be started or rescheduled, and the integrity check FAILs on it', async () => {
    const v = await schedule('PRJ-2026-0011', at(1, 7), at(1, 11), 'vc-key-6');
    // Only reachable by bypassing the handler: the job cancelled directly, its visit still booked.
    await force(`update projects set status = 'CANCELLED', cancellation_reason = 'bypass' where project_number = 'PRJ-2026-0011'`);
    expect(await integrity()).toMatchObject({ status: 'FAIL', refs: [expect.stringMatching(new RegExp(`${String(v.job_number)} \\(PRJ-2026-0011, scheduled\\)`)) as unknown] });
    expect(await visit(tok.crew1!, String(v.job_number), 'start')).toEqual({ ok: false, code: 'PROJECT_CLOSED', detail: 'PRJ-2026-0011 is cancelled: its visits cannot be started' });
    expect(await visit(tok.planner!, String(v.job_number), 'reschedule', null, at(3, 7), at(3, 11))).toMatchObject({ ok: false, code: 'PROJECT_CLOSED' });
    expect(await visit(tok.planner!, String(v.job_number), 'cancel', 'Job cancelled by the customer')).toMatchObject({ ok: true, status: 'CANCELLED' });
    expect(await integrity()).toMatchObject({ status: 'PASS' });
  });

  it('a live job is unchanged: its visits start, move and are delayed as before', async () => {
    const v = await schedule('PRJ-2026-0011', at(1, 7), at(1, 11), 'vc-key-7');
    expect(await visit(tok.planner!, String(v.job_number), 'reschedule', null, at(4, 7), at(4, 11))).toMatchObject({ ok: true, status: 'SCHEDULED' });
    expect(await visit(tok.crew1!, String(v.job_number), 'start')).toMatchObject({ ok: true, status: 'IN_PROGRESS' });
  });
});
