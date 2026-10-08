/**
 * LOCAL ONLY. Builds the isolated database for the supervised-pilot rehearsal (the staff journey in
 * web/e2e/staff-journey.spec.ts). Never touches hosted: the target is fixed to the local Docker Postgres.
 *
 *   npx tsx scripts/pilot-rehearsal.ts --reset
 *
 * 1. Drops and recreates the local database roofops_pilot, then migrates and imports it (npm run db:load).
 * 2. Adds two voided final invoices (synthetic: INV-2026-0039 deleted in Xero, INV-2026-0040 voided in Xero).
 * 3. Adds three clearly labelled synthetic staff through the owner CLI (--local), exactly as the owner does on hosted:
 *    EMP-801 FINANCE (requests), EMP-802 ADMIN (approves), EMP-803 ESTIMATOR (no reissue role).
 * 4. Creates or rotates the local web login role roofops_web_pilot (a member of roofops_dashboard, like roofops_web).
 * 5. Writes web/e2e/.auth/pilot.env (gitignored): the dashboard's server settings for this database plus the random
 *    test logins. Nothing secret is printed.
 *
 * Then start the production build against it and run the journey:
 *   node --env-file=web/e2e/.auth/pilot.env web/node_modules/next/dist/bin/next start web -H 127.0.0.1 -p 3100
 *   cd web && npx playwright test --project=staff-journey
 */
import { execFileSync, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openPostgres } from '../src/db/db.js';
import { deletedReissueScenario, voidedReissueScenario } from '../test/helpers/reissue-scenario.js';

const HOST = '127.0.0.1:54322';
const DB = 'roofops_pilot';
const ADMIN_URL = `postgresql://postgres:postgres@${HOST}/${DB}`;
const ENV_FILE = 'web/e2e/.auth/pilot.env';
const WEB_ROLE = 'roofops_web_pilot';
const secret = (bytes: number) => randomBytes(bytes).toString('base64url');

if (!process.argv.includes('--reset')) throw new Error('usage: npx tsx scripts/pilot-rehearsal.ts --reset (drops and rebuilds the LOCAL roofops_pilot database)');

const psql = (sql: string, db = 'postgres') =>
  execFileSync('docker', ['exec', 'roofops-postgres', 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-Atc', sql]).toString().trim();
const npm = (cmd: string, env: Record<string, string> = {}) =>
  execSync(`npm run -s ${cmd}`, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DATABASE_URL: ADMIN_URL, ...env } }).toString().trim();

psql(`drop database if exists ${DB} with (force)`);
psql(`create database ${DB}`);
console.log(npm('db:load').split('\n').filter((l) => /^(target|imported)/.test(l)).join('\n'));

const db = await openPostgres(ADMIN_URL);
try {
  const a = await deletedReissueScenario(db, { project: 'PRJ-2026-0001', xid: 'aaaaaaaa-bbbb-cccc-dddd-00000000f001' });
  const b = await voidedReissueScenario(db, { project: 'PRJ-2026-0005', xid: 'aaaaaaaa-bbbb-cccc-dddd-00000000f005' });
  console.log(`voided finals: ${a.invoice.number} (${a.project}, deleted in Xero), ${b.invoice.number} (${b.project}, voided in Xero)`);
} finally {
  await db.close();
}

const staff = [
  { code: 'EMP-801', name: 'Synthetic Finance Requester', role: 'FINANCE', login: 'synthetic.finance', key: 'FIN' },
  { code: 'EMP-802', name: 'Synthetic Admin Approver', role: 'ADMIN', login: 'synthetic.admin', key: 'ADMIN' },
  { code: 'EMP-803', name: 'Synthetic Estimator', role: 'ESTIMATOR', login: 'synthetic.estimator', key: 'EST' },
];
const env: string[] = [
  '# LOCAL ONLY: roofops_pilot rehearsal (scripts/pilot-rehearsal.ts). Synthetic logins. Gitignored; never copy to hosted.',
];
for (const s of staff) {
  console.log(npm(`staff:add-employee -- ${s.code} --name "${s.name}" --email ${s.login}@example.test --role ${s.role} --local`).split('\n').pop());
  const password = secret(18);
  console.log(npm(`staff:set-password -- ${s.code} --login ${s.login} --local`, { STAFF_PASSWORD: password }).split('\n').pop());
  env.push(`PILOT_${s.key}_LOGIN=${s.login}`, `PILOT_${s.key}_PASSWORD=${password}`);
}

const webPassword = secret(24);
const exists = psql(`select 1 from pg_roles where rolname = '${WEB_ROLE}'`);
psql(`${exists ? 'alter' : 'create'} role ${WEB_ROLE} with login password '${webPassword}' connection limit 10`);
if (!exists) psql(`grant roofops_dashboard to ${WEB_ROLE}; alter role ${WEB_ROLE} set search_path = public`);

const demoPassword = secret(18);
env.push(
  `DASHBOARD_DATABASE_URL=postgresql://${WEB_ROLE}:${webPassword}@${HOST}/${DB}`,
  `AUTH_SECRET=${secret(48)}`,
  'DEMO_USERNAME=pilot-demo-viewer',
  `DEMO_PASSWORD=${demoPassword}`,
  `PILOT_DEMO_LOGIN=pilot-demo-viewer`,
  `PILOT_DEMO_PASSWORD=${demoPassword}`,
  `PILOT_DB_URL=${ADMIN_URL}`,
);
mkdirSync('web/e2e/.auth', { recursive: true });
writeFileSync(ENV_FILE, env.join('\n') + '\n', { mode: 0o600 });
console.log(`wrote ${ENV_FILE} (server settings and synthetic test logins; not printed)`);
