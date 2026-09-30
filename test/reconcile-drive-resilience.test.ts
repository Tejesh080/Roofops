/**
 * n8n 07's Google Drive check (docs/defect-ledger.md, "Daily 07 Drive rate limit"). The daily runs of 2026-09-30 and
 * 2026-10-01 (n8n 1847, 1899) died at Find Drive Root on Google's HTTP 403 rateLimitExceeded (a per-minute quota of
 * the OAuth client's project, no Retry-After), after Airtable had reconciled: no Xero check, no webhook supervision,
 * no finish. 07 now asks Postgres what to do with each Drive answer (wf_drive_call_decision: go on, wait and retry,
 * or give up) and, if Drive stays unavailable, records that (wf_reconcile_drive_unavailable) and finishes the run.
 * Responses below have Google's real shape (the body of executions 1847 / 1899).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const RATE_LIMITED_403 = { error: { code: 403, status: 'PERMISSION_DENIED',
  message: "Quota exceeded for quota metric 'Queries' and limit 'Previous quota: Requests per minute' of service 'drive.googleapis.com' for consumer 'project_number:498586711441'.",
  errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded', message: 'Quota exceeded …' }],
  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED', domain: 'googleapis.com',
              metadata: { quota_limit: 'defaultPerMinutePerProject', quota_limit_value: '12000', consumer: 'projects/498586711441' } }] } };
const NO_PERMISSION_403 = { error: { code: 403, message: 'The user does not have sufficient permissions for this file.', errors: [{ domain: 'global', reason: 'insufficientPermissions' }] } };
const DAILY_403 = { error: { code: 403, message: 'Daily Limit Exceeded', errors: [{ domain: 'usageLimits', reason: 'dailyLimitExceeded' }] } };
const ROOT = { files: [{ id: 'rootFolder01' }] };

describe.each(TARGETS)('07 Google Drive check: bounded retry, and a run that survives Drive [%s]', (target) => {
  let db: Db;
  const decide = async (status: number, body: unknown, attempt: number, headers: R = {}) =>
    (await db.query<{ d: R }>(`select wf_drive_call_decision($1, $2::jsonb, $3::jsonb, $4) d`, [status, JSON.stringify(headers), JSON.stringify(body), attempt]))[0]!.d;
  const q1 = async (sql: string, p: unknown[] = []) => (await db.query<{ r: R }>(sql, p))[0]!.r;
  const driveExceptions = () => col(db, `select exception_number || ' ' || error_class || ' ' || resolution_status || ' ' || attempt_count v from workflow_exceptions
                                          where workflow_key = 'reconciliation' and business_reference = 'GOOGLE_DRIVE' order by exception_number`);
  const driveHealth = async () => (await db.query<R>(`select ok, detail from v_system_health where service = 'google_drive'`))[0]!;
  /** One 07 run up to the Drive check: Airtable Projects reconciled (0 drift), stats as 07 passes them to finish. */
  const runUpToDrive = async () => {
    await db.exec(`update reconciliation_runs set started_at = started_at - interval '10 minutes'`);
    const start = await q1(`select wf_reconcile_start('schedule', 'repair') r`);
    const records = (await db.query<{ record_id: string; expected: R }>(`select record_id, expected from v_airtable_expected where table_id = 'tblvUPIoebC3zoacv'`))
      .map((r) => ({ id: r.record_id, fields: Object.fromEntries(Object.entries(r.expected).map(([k, v]) => [k, v !== null && typeof v === 'object' && !Array.isArray(v) ? null : v])) }));
    const a = await q1(`select wf_reconcile_airtable($1, 'tblvUPIoebC3zoacv', $2::jsonb) r`, [start.run_key, JSON.stringify(records)]);
    expect(a).toMatchObject({ ok: true, drift: 0 });
    return { run: String(start.run_key), stats: [{ table_id: 'tblvUPIoebC3zoacv', records: a.records, fields_checked: a.fields_checked, drift: a.drift }] };
  };
  const finish = async (run: string, stats: unknown) => {
    await q1(`select wf_reconcile_external($1, 'XERO', '[]'::jsonb) r`, [run]);
    return q1(`select wf_reconcile_finish($1, $2::jsonb, '[]'::jsonb) r`, [run, JSON.stringify({ tables: stats })]);
  };
  const folderOk = [{ folder_id: 'fld1', project_number: 'PRJ-2026-0033', http: 200, trashed: false, parents: ['rootFolder01'], expected_parent: 'rootFolder01' }];

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
  }, 120_000);
  afterAll(async () => { await db.close(); });

  it('Drive success: the root found exactly once goes on to the folder checks', async () => {
    expect(await decide(200, ROOT, 1)).toMatchObject({ action: 'ok', root_id: 'rootFolder01' });
    expect(await decide(200, { files: [] }, 1)).toMatchObject({ action: 'fail', retry: false, error_class: 'NOT_FOUND' });   // no root: not a rate limit
  });

  it('a transient 403 rateLimitExceeded / 429 / 5xx / network error is retried with bounded exponential backoff and jitter, honouring Retry-After', async () => {
    const waits: number[][] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const d = await decide(403, RATE_LIMITED_403, attempt);
      expect(d, `attempt ${String(attempt)}`).toMatchObject({ action: 'retry', error_class: 'RATE_LIMITED', next_attempt: attempt + 1 });
      waits.push([Number(d.wait_seconds)]);
    }
    // base 15 s doubling, plus up to one base of jitter, capped at 120 s
    expect(waits[0]![0]).toBeGreaterThanOrEqual(15); expect(waits[0]![0]).toBeLessThanOrEqual(30);
    expect(waits[1]![0]).toBeGreaterThanOrEqual(30); expect(waits[1]![0]).toBeLessThanOrEqual(45);
    expect(waits[2]![0]).toBeGreaterThanOrEqual(60); expect(waits[2]![0]).toBeLessThanOrEqual(75);
    expect(await decide(429, {}, 1, { 'retry-after': '7' })).toMatchObject({ action: 'retry', wait_seconds: 7, error_class: 'RATE_LIMITED' });
    expect(await decide(429, {}, 1, { 'Retry-After': '999' })).toMatchObject({ action: 'retry', wait_seconds: 120 });           // capped
    const date = new Date(Date.now() + 40_000).toUTCString();
    const byDate = await decide(503, {}, 1, { 'retry-after': date });
    expect(byDate).toMatchObject({ action: 'retry', error_class: 'SERVICE_UNAVAILABLE' });
    expect(Number(byDate.wait_seconds)).toBeGreaterThanOrEqual(35); expect(Number(byDate.wait_seconds)).toBeLessThanOrEqual(41);
    expect(await decide(0, {}, 1)).toMatchObject({ action: 'retry', error_class: 'NETWORK' });
    // …and then success
    expect(await decide(200, ROOT, 4)).toMatchObject({ action: 'ok' });
  });

  it('a rate limit that persists exhausts the capped attempts and gives up (retryable at the next run)', async () => {
    expect(await decide(403, RATE_LIMITED_403, 4)).toMatchObject({ action: 'fail', retry: false, retryable: true, error_class: 'RATE_LIMITED', attempts: 4,
      reason: expect.stringMatching(/rate limit.*4 attempts/i) as unknown });
    expect(await decide(429, {}, 5, { 'retry-after': '5' })).toMatchObject({ action: 'fail', error_class: 'RATE_LIMITED' });
  });

  it('a permission or auth refusal (or a daily quota) is not retried blindly', async () => {
    expect(await decide(403, NO_PERMISSION_403, 1)).toMatchObject({ action: 'fail', retry: false, retryable: false, error_class: 'PERMISSION_DENIED',
      reason: expect.stringMatching(/insufficientPermissions.*"RoofOps Google Drive" credential/) as unknown });
    expect(await decide(401, { error: { code: 401, message: 'Invalid Credentials' } }, 1)).toMatchObject({ action: 'fail', retry: false, error_class: 'AUTH_FAILURE',
      reason: expect.stringMatching(/reconnect/i) as unknown });
    expect(await decide(403, DAILY_403, 1)).toMatchObject({ action: 'fail', retry: false, error_class: 'RATE_LIMITED', reason: expect.stringMatching(/daily/i) as unknown });
  });

  it('Airtable reconciliation is kept when Drive stays unavailable: the run completes, Drive is recorded failed, one exception across runs', async () => {
    const first = await runUpToDrive();
    const exhausted = await decide(403, RATE_LIMITED_403, 4);
    expect(await q1(`select wf_reconcile_drive_unavailable($1, $2::jsonb) r`, [first.run, JSON.stringify(exhausted)])).toMatchObject({ ok: true });
    expect(await finish(first.run, first.stats)).toMatchObject({ ok: true });
    const [run] = await db.query<{ status: string; summary: R }>(`select status, summary from reconciliation_runs where run_key = $1`, [first.run]);
    expect(run!.status).toBe('COMPLETED');
    expect(run!.summary).toMatchObject({ airtable: { tables: first.stats }, drive: { status: 'UNAVAILABLE', error_class: 'RATE_LIMITED', checked: 0 } });
    expect(await driveHealth()).toMatchObject({ ok: false, detail: { error_class: 'RATE_LIMITED', reason: expect.stringMatching(/rate limit/i) as unknown } });
    expect(await driveExceptions()).toEqual([expect.stringMatching(/^EXC-\d+ RATE_LIMITED OPEN 1$/)]);
    expect(await col(db, `select count(*)::text v from reconciliation_findings f join reconciliation_runs r on r.id = f.run_id where r.run_key = $1 and f.system = 'DRIVE'`, [first.run])).toEqual(['0']);

    // The next scheduled run hits it again: the same exception is updated, not duplicated.
    const second = await runUpToDrive();
    await q1(`select wf_reconcile_drive_unavailable($1, $2::jsonb) r`, [second.run, JSON.stringify(await decide(403, RATE_LIMITED_403, 4))]);
    await finish(second.run, second.stats);
    expect(await driveExceptions()).toEqual([expect.stringMatching(/^EXC-\d+ RATE_LIMITED OPEN 2$/)]);

    // The next successful Drive check clears it: health ok, the exception resolved by the workflow (history kept, audited).
    const third = await runUpToDrive();
    expect(await q1(`select wf_reconcile_external($1, 'DRIVE', $2::jsonb) r`, [third.run, JSON.stringify(folderOk)])).toMatchObject({ ok: true, verified: 1, drift: 0 });
    await finish(third.run, third.stats);
    expect(await driveExceptions()).toEqual([expect.stringMatching(/^EXC-\d+ RATE_LIMITED RESOLVED 2$/)]);
    expect(await driveHealth()).toMatchObject({ ok: true });
    expect(await col(db, `select actor_type || ' ' || actor_id v from audit_events where action = 'exception.resolved' and business_reference like 'EXC-%'
                          and reason like 'Google Drive checked successfully%'`)).toEqual(['SYSTEM workflow:reconciliation']);
  });

  it('a permission refusal opens its own actionable exception; rate-limited folder reads are Drive unavailability, not folder drift', async () => {
    const r1 = await runUpToDrive();
    await q1(`select wf_reconcile_drive_unavailable($1, $2::jsonb) r`, [r1.run, JSON.stringify(await decide(403, NO_PERMISSION_403, 1))]);
    await finish(r1.run, r1.stats);
    expect((await driveExceptions()).at(-1)).toMatch(/PERMISSION_DENIED OPEN 1$/);

    // Root found, but the folder reads come back rate limited: no "folder could not be read" drift for each project.
    const r2 = await runUpToDrive();
    const limited = [{ folder_id: 'fld1', project_number: 'PRJ-2026-0033', http: 403, reason: 'rateLimitExceeded', trashed: false, parents: [], expected_parent: 'rootFolder01' },
                     { folder_id: 'fld2', project_number: 'PRJ-2026-0032', http: 429, reason: null, trashed: false, parents: [], expected_parent: 'rootFolder01' }];
    expect(await q1(`select wf_reconcile_external($1, 'DRIVE', $2::jsonb) r`, [r2.run, JSON.stringify(limited)])).toMatchObject({ ok: true, unavailable: true, drift: 0 });
    await finish(r2.run, r2.stats);
    expect(await col(db, `select count(*)::text v from reconciliation_findings f join reconciliation_runs r on r.id = f.run_id where r.run_key = $1 and f.system = 'DRIVE'`, [r2.run])).toEqual(['0']);
    expect(await col(db, `select count(*)::text v from workflow_exceptions where business_reference in ('PRJ-2026-0033', 'PRJ-2026-0032') and workflow_key = 'reconciliation'`)).toEqual(['0']);
    expect(await driveHealth()).toMatchObject({ ok: false });
  });
});
