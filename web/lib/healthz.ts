/**
 * The data behind /api/healthz: the same recorded checks, integrity rules and exception backlog as the System Health
 * page, read once each (integrity_check() runs once; its dead-letter rule gives the side-effect backlog).
 */
import { healthzVerdict, type Healthz } from './health.ts';
import { getIntegrity, getServiceChecks, type Query } from './queries.ts';

export async function getHealthz(q: Query): Promise<Healthz> {
  const [checks, integrity, [backlog]] = await Promise.all([
    getServiceChecks(q),
    getIntegrity(q),
    q<{ open_exceptions: number }>(`select count(*)::int open_exceptions from v_dashboard_exceptions where resolution_status in ('OPEN', 'RETRY_QUEUED')`),
  ]);
  const deadLetters = integrity.filter((r) => r.entity === 'side_effect' && r.check_key === 'dead_letters').reduce((n, r) => n + Number(r.failing), 0);
  return healthzVerdict({ checks, integrity, deadLetters, openExceptions: backlog?.open_exceptions ?? 0 });
}
