import { describe, expect, it } from 'vitest';
import { SERVICES, consistencyLine, overallState, serviceState } from '../web/lib/health.ts';
import { freshness, syncOf } from '../web/lib/copilot/tools.ts';
import { groupTimeline } from '../web/lib/timeline.ts';
import type { ProjectRow, ServiceCheck, TimelineEntry } from '../web/lib/queries.ts';

const drive = SERVICES.find((s) => s.service === 'google_drive')!;
const check = (o: Partial<ServiceCheck>): ServiceCheck => ({ service: 'google_drive', ok: true, checked_at: '2026-09-29 12:00', last_ok_at: '2026-09-29 12:00',
  age_seconds: 60, consecutive_failures: 0, detail: {}, ...o });

describe('System Health never fakes health', () => {
  it('no check, or a stale check, is Unknown, not Healthy', () => {
    expect(serviceState(undefined, drive)).toBe('Unknown');
    expect(serviceState(check({ age_seconds: 3 * 3600 }), drive)).toBe('Unknown');
  });
  it('a fresh OK is Healthy; one failure after success is Degraded; repeated or never-OK failures need attention', () => {
    expect(serviceState(check({}), drive)).toBe('Healthy');
    expect(serviceState(check({ ok: false, consecutive_failures: 1 }), drive)).toBe('Degraded');
    expect(serviceState(check({ ok: false, consecutive_failures: 3 }), drive)).toBe('Needs attention');
    expect(serviceState(check({ ok: false, consecutive_failures: 1, last_ok_at: null }), drive)).toBe('Needs attention');
  });
  it('overall state is the worst one, and Unknown beats Healthy', () => {
    expect(overallState(['Healthy', 'Unknown'])).toBe('Unknown');
    expect(overallState(['Healthy', 'Degraded', 'Unknown'])).toBe('Degraded');
    expect(overallState(['Healthy', 'Needs attention'])).toBe('Needs attention');
  });
  it('consistency reads "N / M in sync" from the last check and live drift', () => {
    const base = { system: 'AIRTABLE', checked: 231, drift_found: 4, repaired: 4, needs_person: 0, drift_now: 0, linked: 231, checked_at: '2026-09-29 12:14' };
    expect(consistencyLine(base)).toMatchObject({ value: '231 / 231 in sync', state: 'Healthy' });
    expect(consistencyLine({ ...base, drift_now: 1 })).toMatchObject({ value: '230 / 231 in sync', state: 'Degraded' });
    expect(consistencyLine({ ...base, needs_person: 1 })).toMatchObject({ state: 'Needs attention' });
    expect(consistencyLine({ ...base, checked_at: null })).toMatchObject({ state: 'Unknown', value: 'Not checked yet' });
  });
});

const p = (o: Partial<ProjectRow>) => ({ project_number: 'PRJ-2026-0001', status: 'COMPLETED', status_out_of_sync: false, airtable_status_seen: 'Completed',
  airtable_status_seen_at: '2026-09-29 12:01', last_reconciled_at: '2026-09-29 12:01', status_changed_at: '2026-06-25 17:00', drift_fields: 0, ...o }) as ProjectRow;

describe('Copilot freshness facts (the model repeats these; it never decides)', () => {
  it('out of sync: both values, canonical first, and when it was last checked', () => {
    expect(syncOf(p({ status_out_of_sync: true, airtable_status_seen: 'Cancelled' }))).toMatchObject({
      in_sync: false, roofops_canonical_status: 'Completed', airtable_currently_reports: 'Cancelled', last_reconciliation: '2026-09-29 12:01' });
    expect(freshness(p({ status_out_of_sync: true }))).toMatchObject({ canonical_source: 'postgres', verified: false });
  });
  it('in sync after the change was applied: just the status, marked verified', () => {
    expect(syncOf(p({ status: 'CANCELLED', airtable_status_seen: 'Cancelled' }))).toEqual({ in_sync: true });
    expect(freshness(p({}))).toMatchObject({ verified: true });
    expect(freshness(p({ last_reconciled_at: null })).verified).toBe(false);
  });
});

describe('timeline: Airtable changes read as one step each', () => {
  const e = (t: string, kind: string, source: 'EVENT' | 'AUDIT', status: string | null, reason: string | null): TimelineEntry => ({
    source, occurred_at: `2026-09-29 ${t.slice(0, 5)}`, occurred_iso: `2026-09-29T${t}`, kind, status, error_class: null, actor: 'usr7uCnNO15fCefbH',
    reference: 'PRJ-2026-0009', reason, external_reference: null, channel: 'airtable' });
  it('the audit row mirrors the change event, and our own echo is hidden', () => {
    const g = groupTimeline([
      e('12:16:52', 'airtable.record_changed', 'EVENT', 'INFO', null),
      e('12:16:49', 'project.status.changed', 'AUDIT', null, 'Changed in Airtable [airtable:achrbwFiSoL4y5RXM:txn71:recmN6VfWE5JgFNfe]'),
      e('12:16:49', 'airtable.record_changed', 'EVENT', 'SUCCEEDED', '✓ Status: Planning → Scheduled applied'),
    ], 'PRJ-2026-0009');
    expect(g.map((x) => [x.title, x.detail])).toEqual([['Change made in Airtable', 'Office staff (Airtable) · ✓ Status: Planning → Scheduled applied']]);
  });
});
