/**
 * Owner-only staff administration (hosted by default: SUPABASE_DB_URL, verified TLS when SUPABASE_CA_CERT is set;
 * --local uses DATABASE_URL). Never prints a password.
 *
 * npm run staff:add-employee -- EMP-101 --name "Full Name" --email person@company.example --role FINANCE [--local]
 *   Adds one active employee (a real person) with one audit row. Roles: ADMIN, OPERATIONS_MANAGER, PROJECT_MANAGER,
 *   ESTIMATOR, PURCHASING, FINANCE, FIELD_CREW, VIEWER. Reissue needs FINANCE or ADMIN (invoice.reissue_roles).
 *
 * STAFF_PASSWORD=… npm run staff:set-password -- EMP-101 --login <login> [--local]
 *   Creates or resets that employee's dashboard login through ops_staff_set_password: an active employee, 12-72
 *   characters, a bcrypt hash stored in Postgres, existing sessions signed out, one audit row. The password comes
 *   only from STAFF_PASSWORD and is never printed.
 */
import { openPostgres } from '../src/db/db.js';
import { describeUrl, hostedDbConfig, loadLocalEnv } from '../src/config/env.js';

const ROLES = ['ADMIN', 'OPERATIONS_MANAGER', 'PROJECT_MANAGER', 'ESTIMATOR', 'PURCHASING', 'FINANCE', 'FIELD_CREW', 'VIEWER'];
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const [cmd, employee] = args;
loadLocalEnv();

const local = args.includes('--local');
const target = () => {
  const cfg = local ? { url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/roofops', caPem: undefined } : hostedDbConfig();
  console.log(`target: ${local ? 'local' : 'HOSTED'} ${describeUrl(cfg.url)}`);
  return cfg;
};

if (cmd === 'add-employee') {
  const name = opt('--name')?.trim(); const email = opt('--email')?.trim().toLowerCase(); const role = opt('--role')?.trim().toUpperCase();
  if (!employee || !/^EMP-\d{3,}$/.test(employee) || !name || name.length < 3 || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !role || !ROLES.includes(role)) {
    throw new Error(`usage: staff.ts add-employee EMP-NNN --name "Full Name" --email person@company.example --role ${ROLES.join('|')} [--local]`);
  }
  const cfg = target();
  const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
  try {
    const [r] = await db.query<{ code: string }>(
      `with e as (insert into employees (employee_code, full_name, email, role, is_active) values ($1, $2, $3, $4, true) returning id, employee_code, role)
       insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
       select 'SYSTEM', 'ops:staff', 'employee.created', 'employee', e.id, e.employee_code, jsonb_build_object('role', e.role, 'email', $3::text),
              'Employee added by the owner for dashboard sign-in' from e returning business_reference as code`, [employee, name, email, role]);
    console.log(`${r!.code} added: ${name}, ${role}, active. Next: STAFF_PASSWORD=… npm run staff:set-password -- ${r!.code} --login <login>${local ? ' --local' : ''}`);
  } catch (e) {
    throw new Error(`Not added: ${(e as Error).message}`, { cause: e });   // e.g. a duplicate code, name or email (unique constraints)
  } finally {
    await db.close();
  }
} else if (cmd === 'set-password') {
  const login = opt('--login');
  const password = process.env.STAFF_PASSWORD;
  if (!employee || !login || !password) throw new Error('usage: STAFF_PASSWORD=<12-72 characters> tsx scripts/staff.ts set-password EMP-NNN --login <login> [--local]');
  const cfg = target();
  const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
  try {
    const [{ r }] = await db.query<{ r: { ok: boolean; reason?: string; login?: string } }>(
      'select ops_staff_set_password($1, $2, $3) r', [employee, login, password]) as [{ r: { ok: boolean; reason?: string; login?: string } }];
    if (!r.ok) throw new Error(`Not set: ${r.reason ?? 'refused'}`);
    console.log(`${employee} can now sign in to the dashboard as "${r.login}" (password not shown; earlier sessions signed out)`);
  } finally {
    await db.close();
  }
} else {
  throw new Error('usage: staff.ts add-employee … | set-password … (see the header of scripts/staff.ts)');
}
