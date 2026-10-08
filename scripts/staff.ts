/**
 * STAFF_PASSWORD=… npm run staff:set-password -- EMP-900 --login finance.approver [--local]
 *   Creates or resets one employee's dashboard login through ops_staff_set_password (owner-only): an active employee,
 *   at least 12 characters, a bcrypt hash stored in Postgres, existing sessions signed out, one audit row.
 *   The password comes only from STAFF_PASSWORD and is never printed. Hosted database by default (SUPABASE_DB_URL,
 *   verified TLS when SUPABASE_CA_CERT is set); --local uses DATABASE_URL.
 */
import { openPostgres } from '../src/db/db.js';
import { describeUrl, hostedDbConfig, loadLocalEnv } from '../src/config/env.js';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const [cmd, employee] = args;
const login = opt('--login');
loadLocalEnv();
const password = process.env.STAFF_PASSWORD;
if (cmd !== 'set-password' || !employee || !login || !password) {
  throw new Error('usage: STAFF_PASSWORD=<12+ characters> tsx scripts/staff.ts set-password EMP-NNN --login <login> [--local]');
}

const local = args.includes('--local');
const cfg = local ? { url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/roofops', caPem: undefined } : hostedDbConfig();
console.log(`target: ${local ? 'local' : 'HOSTED'} ${describeUrl(cfg.url)}`);
const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
try {
  const [{ r }] = await db.query<{ r: { ok: boolean; reason?: string; login?: string } }>(
    'select ops_staff_set_password($1, $2, $3) r', [employee, login, password]) as [{ r: { ok: boolean; reason?: string; login?: string } }];
  if (!r.ok) throw new Error(`Not set: ${r.reason ?? 'refused'}`);
  console.log(`${employee} can now sign in to the dashboard as "${r.login}" (password not shown; earlier sessions signed out)`);
} finally {
  await db.close();
}
