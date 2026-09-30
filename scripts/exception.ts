/**
 * npm run exception:resolve -- EXC-0018 --by EMP-900 --note "Why it needs no further action"
 *   Resolves an OPEN exception through ops_resolve_exception: an active employee in an allowed role
 *   (app_settings exception.resolver_roles), a real note, OPEN -> RESOLVED, one audit row. Nothing is deleted.
 * Hosted database (SUPABASE_DB_URL). Never prints connection details.
 */
import { openPostgres } from '../src/db/db.js';
import { hostedDbConfig } from '../src/config/env.js';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const [cmd, exception] = args;
const by = opt('--by'); const note = opt('--note');
if (cmd !== 'resolve' || !exception || !by || !note) throw new Error('usage: exception.ts resolve EXC-NNNN --by EMP-NNN --note "why"');

const cfg = hostedDbConfig();
const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
const show = () => db.query(`select x.exception_number, x.resolution_status, x.business_reference, x.error_class, left(x.error_message, 90) error_message,
    (select employee_code from employees e where e.id = x.resolved_by) resolved_by, x.resolved_by_system,
    to_char(x.resolved_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI') resolved_at, x.resolution_note
    from workflow_exceptions x where x.exception_number = $1`, [exception]);
try {
  console.table(await show());
  const [r] = await db.query<{ r: { resolved: boolean; reason?: string } }>(`select ops_resolve_exception($1, $2, $3) r`, [exception, by, note]);
  if (!r!.r.resolved) throw new Error(`Not resolved: ${r!.r.reason ?? 'refused'}`);
  console.log(`${exception} resolved by ${by} (audited as exception.resolved)`);
  console.table(await show());
} finally {
  await db.close();
}
