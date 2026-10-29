/**
 * npx tsx scripts/provision-dashboard-role.ts [--rotate]
 *
 * Creates the hosted login role the dashboard's web server uses (roofops_web), a member of
 * roofops_dashboard: it can read the dashboard views and ask for an invoice preview, nothing else.
 * Writes web/.env.local (gitignored) with that role's URL plus the DeepSeek settings copied from the
 * root .env. Never prints a secret. Then connects AS the role and proves its privileges.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { openPostgres } from '../src/db/db.js';
import { hostedDbConfig, mergeEnvFile, requireEnv } from '../src/config/env.js';

const WEB_ENV = 'web/.env.local';
const ROLE = 'roofops_web';
const rotate = process.argv.includes('--rotate');

const cfg = hostedDbConfig();
const admin = new URL(cfg.url);
const projectRef = decodeURIComponent(admin.username).split('.')[1];
if (!projectRef) throw new Error('SUPABASE_DB_URL must use the pooler username form postgres.<project-ref>');
const tls = cfg.caPem ? { caPem: cfg.caPem } : undefined;
const stored = existsSync(WEB_ENV) ? /DASHBOARD_DATABASE_URL=(.*)/.exec(readFileSync(WEB_ENV, 'utf8'))?.[1]?.trim() : undefined;

const db = await openPostgres(cfg.url, tls);
let url: string;
try {
  const exists = (await db.query(`select 1 from pg_roles where rolname = $1`, [ROLE])).length > 0;
  if (exists && !rotate && stored) {
    url = stored;
    console.log(`${ROLE} already exists; reusing the stored credential (use --rotate to replace it)`);
  } else {
    const password = randomBytes(32).toString('base64url');
    const [{ sql } = { sql: '' }] = await db.query<{ sql: string }>(
      `select format('%s role %I with login password %L connection limit 10', $1::text, $2::text, $3::text) as sql`,
      [exists ? 'alter' : 'create', ROLE, password]);
    await db.exec(sql);
    await db.exec(`grant roofops_dashboard to ${ROLE}; alter role ${ROLE} set search_path = public;`);
    const u = new URL(cfg.url);
    u.username = `${ROLE}.${projectRef}`;
    u.password = encodeURIComponent(password);
    url = u.toString();
    console.log(`${exists ? 'rotated' : 'created'} ${ROLE}`);
  }
} finally {
  await db.close();
}

// Only the keys this script owns are set; the sign-in settings (DEMO_*, AUTH_SECRET) and the CA setting stay as they are.
const header = '# RoofOps dashboard server-side settings. Gitignored. Never prefix any of these with NEXT_PUBLIC_.\n';
writeFileSync(WEB_ENV, mergeEnvFile(existsSync(WEB_ENV) ? readFileSync(WEB_ENV, 'utf8') : header, {
  DASHBOARD_DATABASE_URL: url,
  DEEPSEEK_API_KEY: requireEnv('DEEPSEEK_API_KEY'),
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
  ...(cfg.caPem && process.env.SUPABASE_CA_CERT && !/^DASHBOARD_DB_CA_(PEM|CERT)=/m.test(existsSync(WEB_ENV) ? readFileSync(WEB_ENV, 'utf8') : '')
    ? { DASHBOARD_DB_CA_CERT: process.env.SUPABASE_CA_CERT } : {}),
}), { mode: 0o600 });
console.log(`updated ${WEB_ENV} (only the database and DeepSeek keys; values not printed)`);

// Prove the privileges by connecting AS the role, through the real pooler.
const web = await openPostgres(url, tls);
try {
  const [who] = await web.query<{ u: string }>('select current_user as u');
  console.log(`connected as ${who!.u}`);
  const [k] = await web.query('select * from v_dashboard_kpis');
  console.log('read v_dashboard_kpis ->', JSON.stringify(k));
  for (const sql of ['select count(*) from projects', 'select count(*) from customers', `select wf_invoice_decide('{}'::jsonb, 'x')`,
                     `update app_settings set value = value where key = 'xero.demo_tenant_id'`]) {
    try { await web.query(sql); console.log(`UNEXPECTED: allowed -> ${sql}`); process.exitCode = 1; }
    catch (e) { console.log(`denied as intended -> ${sql.slice(0, 48)} (${(e as Error).message})`); }
  }
} finally {
  await web.close();
}
