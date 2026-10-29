/**
 * /api/healthz (master plan Task 1.2): one public answer an outside uptime monitor can watch. It is "attention" (HTTP
 * 503) only when a person is needed now: a recorded check has gone stale (the health run or the nightly reconciliation
 * stopped), a service failed three times in a row, an integrity rule FAILs, or a side effect is dead-lettered. It
 * carries states and counts only, never a record, a name or a check's detail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { healthzVerdict, SERVICES } from '../web/lib/health.ts';
import { getHealthz } from '../web/lib/healthz.ts';
import type { ServiceCheck } from '../web/lib/queries.ts';
import { TARGETS, migratedDb } from './helpers/db.js';

const fresh = (service: string, o: Partial<ServiceCheck> = {}): ServiceCheck => ({ service, ok: true, checked_at: '2026-10-29 12:00',
  last_ok_at: '2026-10-29 12:00', age_seconds: 60, consecutive_failures: 0, detail: { note: 'detail-must-not-leak' }, ...o });
const allFresh = () => SERVICES.map((s) => fresh(s.service));
const base = { checks: allFresh(), integrity: [{ status: 'PASS' as const }, { status: 'WARNING' as const }], deadLetters: 0, openExceptions: 0 };

describe('healthzVerdict', () => {
  it('everything checked recently and passing is ok, with every service named', () => {
    const v = healthzVerdict(base);
    expect(v.status).toBe('ok');
    expect(v.reasons).toEqual([]);
    expect(Object.keys(v.services).sort()).toEqual(SERVICES.map((s) => s.service).sort());
    expect(v.integrity).toEqual({ pass: 1, warning: 1, fail: 0 });
  });

  it('a check that has gone stale (a stopped health run or reconciliation) needs attention', () => {
    const n8n = SERVICES.find((s) => s.service === 'n8n')!;
    const v = healthzVerdict({ ...base, checks: allFresh().map((c) => (c.service === 'n8n' ? { ...c, age_seconds: n8n.maxAgeSeconds + 1 } : c)) });
    expect(v.status).toBe('attention');
    expect(v.services.n8n).toBe('Unknown');
    expect(v.reasons).toEqual(['n8n: no recorded check within 2 hours']);
  });

  it('a service never checked needs attention', () => {
    const v = healthzVerdict({ ...base, checks: allFresh().filter((c) => c.service !== 'xero') });
    expect(v.status).toBe('attention');
    expect(v.reasons).toEqual(['xero: no recorded check within 2 hours']);
  });

  it('one or two failures are Degraded and reported, not a page; three in a row need attention', () => {
    const one = healthzVerdict({ ...base, checks: allFresh().map((c) => (c.service === 'google_drive' ? { ...c, ok: false, consecutive_failures: 1 } : c)) });
    expect(one.status).toBe('ok');
    expect(one.services.google_drive).toBe('Degraded');
    const three = healthzVerdict({ ...base, checks: allFresh().map((c) => (c.service === 'google_drive' ? { ...c, ok: false, consecutive_failures: 3 } : c)) });
    expect(three.status).toBe('attention');
    expect(three.reasons).toEqual(['google_drive: 3 failed checks in a row']);
  });

  it('an integrity FAIL needs attention; WARNINGs do not', () => {
    const v = healthzVerdict({ ...base, integrity: [{ status: 'FAIL' }, { status: 'FAIL' }, { status: 'WARNING' }] });
    expect(v.status).toBe('attention');
    expect(v.reasons).toEqual(['integrity: 2 rules fail']);
  });

  it('a dead-lettered side effect needs attention; open exceptions are reported only', () => {
    expect(healthzVerdict({ ...base, deadLetters: 1 }).reasons).toEqual(['side effects: 1 dead-lettered']);
    const v = healthzVerdict({ ...base, openExceptions: 4 });
    expect(v.status).toBe('ok');
    expect(v.open_exceptions).toBe(4);
  });

  it('carries no check detail and nothing but states and counts', () => {
    const v = healthzVerdict({ ...base, checks: allFresh().map((c) => ({ ...c, ok: false, consecutive_failures: 5 })) });
    expect(JSON.stringify(v)).not.toContain('detail-must-not-leak');
    expect(Object.keys(v).sort()).toEqual(['dead_letters', 'integrity', 'open_exceptions', 'reasons', 'services', 'status']);
  });
});

describe.each(TARGETS)('getHealthz against a migrated database (%s)', (target) => {
  let db: Db;
  beforeAll(async () => { db = await migratedDb(target); await importBundle(db); });
  afterAll(async () => { await db.close(); });
  const q = <T,>(sql: string, params: unknown[] = []) => db.query<T>(sql, params);

  it('with no recorded checks every service is Unknown and the answer is attention', async () => {
    const v = await getHealthz(q);
    expect(v.status).toBe('attention');
    expect(Object.values(v.services).every((s) => s === 'Unknown')).toBe(true);
  });

  it('after a health run that records every service as ok, the services are Healthy', async () => {
    const checks: Record<string, unknown>[] = ['airtable', 'airtable_webhooks', 'n8n', 'google_drive', 'deepseek'].map((service) => ({ service, ok: true, latency_ms: 10 }));
    await db.query(`select wf_record_health($1::jsonb)`, [JSON.stringify(checks)]);
    const v = await getHealthz(q);
    expect(v.services).toMatchObject({ postgres: 'Healthy', airtable: 'Healthy', n8n: 'Healthy', google_drive: 'Healthy', deepseek: 'Healthy' });
    expect(v.integrity.pass + v.integrity.warning + v.integrity.fail).toBeGreaterThan(30);
  });
});
