/**
 * System Health in business words. Pure: every state is derived from a recorded check, and a service that has not been
 * checked recently is UNKNOWN, never "healthy" by default.
 */
import type { Consistency, ServiceCheck } from './queries.ts';
import type { Tone } from './labels.ts';

export type HealthState = 'Healthy' | 'Degraded' | 'Needs attention' | 'Unknown';
export const HEALTH_TONE: Record<HealthState, Tone> = { Healthy: 'good', Degraded: 'warn', 'Needs attention': 'bad', Unknown: 'neutral' };

export interface ServiceDef { service: string; name: string; what: string; maxAgeSeconds: number; how: string }
export const SERVICES: ServiceDef[] = [
  { service: 'postgres', name: 'RoofOps database', what: 'The single source of truth', maxAgeSeconds: 7_200, how: 'written by every health run' },
  { service: 'airtable', name: 'Airtable', what: 'Where the office edits jobs', maxAgeSeconds: 26 * 3_600, how: 'read in full by the nightly reconciliation' },
  { service: 'airtable_webhooks', name: 'Airtable change alerts', what: 'How edits reach RoofOps within seconds', maxAgeSeconds: 26 * 3_600, how: 'checked by the nightly reconciliation' },
  { service: 'n8n', name: 'Automation engine (n8n)', what: 'Runs the workflows', maxAgeSeconds: 7_200, how: 'health run every 30 minutes' },
  { service: 'google_drive', name: 'Google Drive', what: 'Project folders', maxAgeSeconds: 7_200, how: 'health run every 30 minutes' },
  { service: 'xero', name: 'Xero (Demo Company)', what: 'Draft invoices', maxAgeSeconds: 7_200, how: 'health run every 30 minutes (pinned Demo tenant must be connected)' },
  { service: 'deepseek', name: 'DeepSeek', what: 'Operations Copilot answers', maxAgeSeconds: 7_200, how: 'health run every 30 minutes' },
];

export function serviceState(c: ServiceCheck | undefined, def: ServiceDef): HealthState {
  if (!c || c.ok === null || c.checked_at === null || c.age_seconds === null) return 'Unknown';
  if (c.age_seconds > def.maxAgeSeconds) return 'Unknown';
  if (c.ok) return 'Healthy';
  return c.consecutive_failures >= 3 || c.last_ok_at === null ? 'Needs attention' : 'Degraded';
}

/**
 * The public /api/healthz answer. "attention" only when a person is needed now: a stale or missing check (the health
 * run or the nightly reconciliation stopped), a service failing three times in a row or never OK, an integrity FAIL, or
 * a dead-lettered side effect. States and counts only: never a record, a name or a check's detail.
 */
export interface Healthz {
  status: 'ok' | 'attention';
  reasons: string[];
  services: Record<string, HealthState>;
  integrity: { pass: number; warning: number; fail: number };
  open_exceptions: number;
  dead_letters: number;
}

const within = (seconds: number) => (seconds % 3_600 === 0 ? `${seconds / 3_600} hours` : `${Math.round(seconds / 60)} minutes`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function healthzVerdict(i: { checks: ServiceCheck[]; integrity: { status: 'PASS' | 'FAIL' | 'WARNING' }[]; deadLetters: number; openExceptions: number }): Healthz {
  const reasons: string[] = [];
  const services: Record<string, HealthState> = {};
  for (const def of SERVICES) {
    const c = i.checks.find((x) => x.service === def.service);
    const state = serviceState(c, def);
    services[def.service] = state;
    if (state === 'Unknown') reasons.push(`${def.service}: no recorded check within ${within(def.maxAgeSeconds)}`);
    if (state === 'Needs attention') {
      reasons.push(`${def.service}: ${c?.last_ok_at === null ? 'failing and never recorded OK' : `${c?.consecutive_failures ?? 0} failed checks in a row`}`);
    }
  }
  const count = (s: 'PASS' | 'FAIL' | 'WARNING') => i.integrity.filter((r) => r.status === s).length;
  const integrity = { pass: count('PASS'), warning: count('WARNING'), fail: count('FAIL') };
  if (integrity.fail > 0) reasons.push(`integrity: ${plural(integrity.fail, 'rule fails', 'rules fail')}`);
  if (i.deadLetters > 0) reasons.push(`side effects: ${i.deadLetters} dead-lettered`);
  return { status: reasons.length ? 'attention' : 'ok', reasons, services, integrity, open_exceptions: i.openExceptions, dead_letters: i.deadLetters };
}

export function overallState(states: HealthState[]): HealthState {
  if (states.includes('Needs attention')) return 'Needs attention';
  if (states.includes('Degraded')) return 'Degraded';
  if (states.includes('Unknown')) return 'Unknown';
  return 'Healthy';
}

/** "228 / 228 in sync" style figure for one external system, from the latest reconciliation plus live drift. */
export function consistencyLine(c: Consistency): { value: string; state: HealthState; note: string } {
  if (!c.checked_at) return { value: 'Not checked yet', state: 'Unknown', note: 'No reconciliation has run' };
  const drift = c.system === 'AIRTABLE' ? (c.drift_now ?? 0) : c.drift_found;
  const inSync = Math.max(c.checked - drift, 0);
  const state: HealthState = c.needs_person > 0 ? 'Needs attention' : drift > 0 ? 'Degraded' : c.checked < c.linked ? 'Degraded' : 'Healthy';
  const note = c.system === 'AIRTABLE'
    ? `${c.drift_found} drifted at the last check, ${c.repaired} repaired${c.needs_person ? `, ${c.needs_person} need a person` : ''}`
    : `${c.linked} linked in RoofOps${c.needs_person ? `, ${c.needs_person} need a person` : ''}`;
  return { value: `${inSync} / ${c.checked} in sync`, state, note };
}
