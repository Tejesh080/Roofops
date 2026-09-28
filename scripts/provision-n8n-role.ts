/**
 * npm run db:provision-n8n [-- --rotate]
 *
 * Creates the hosted login role n8n uses (roofops_n8n), a member of roofops_workflow,
 * so it can EXECUTE the four wf_* entry points and nothing else. The generated password
 * is written only to secrets/roofops-n8n-postgres.env (gitignored) and never printed.
 * Then connects AS that role through the real pooler and proves its privileges.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openPostgres } from '../src/db/db.js';
import { hostedDbConfig } from '../src/config/env.js';

const SECRET_FILE = 'secrets/roofops-n8n-postgres.env';
const ROLE = 'roofops_n8n';
const rotate = process.argv.includes('--rotate');

const cfg = hostedDbConfig();
const admin = new URL(cfg.url);
const projectRef = decodeURIComponent(admin.username).split('.')[1];
if (!projectRef) throw new Error('SUPABASE_DB_URL must use the pooler username form postgres.<project-ref>');
const tls = cfg.caPem ? { caPem: cfg.caPem } : undefined;

const db = await openPostgres(cfg.url, tls);
let password: string;
try {
  const exists = (await db.query(`select 1 from pg_roles where rolname = $1`, [ROLE])).length > 0;
  if (exists && !rotate && existsSync(SECRET_FILE)) {
    password = /PGPASSWORD=(.*)/.exec(readFileSync(SECRET_FILE, 'utf8'))![1]!.trim();
    console.log(`${ROLE} already exists; reusing the stored password (use --rotate to replace it)`);
  } else {
    password = randomBytes(32).toString('base64url');
    const [{ sql } = { sql: '' }] = await db.query<{ sql: string }>(
      `select format('%s role %I with login password %L connection limit 10', $1::text, $2::text, $3::text) as sql`,
      [exists ? 'alter' : 'create', ROLE, password]);
    await db.exec(sql);
    await db.exec(`grant roofops_workflow to ${ROLE}; alter role ${ROLE} set search_path = public;`);
    mkdirSync('secrets', { recursive: true });
    writeFileSync(SECRET_FILE, [
      '# n8n Postgres credential for RoofOps (hosted Supabase). Gitignored. Copy into n8n; never commit.',
      `PGHOST=${admin.hostname}`, `PGPORT=${admin.port || '5432'}`, `PGDATABASE=${admin.pathname.slice(1)}`,
      `PGUSER=${ROLE}.${projectRef}`, `PGPASSWORD=${password}`, 'PGSSLMODE=require', '',
    ].join('\n'), { mode: 0o600 });
    console.log(`${exists ? 'rotated' : 'created'} ${ROLE}; credential written to ${SECRET_FILE} (not printed)`);
  }
} finally {
  await db.close();
}

// Prove the privileges by connecting AS the role, through the real pooler.
const asRole = new URL(cfg.url);
asRole.username = `${ROLE}.${projectRef}`;
asRole.password = encodeURIComponent(password);
const n8n = await openPostgres(asRole.toString(), tls);
try {
  const [who] = await n8n.query<{ u: string }>('select current_user as u');
  console.log(`connected via ${asRole.hostname} as ${who!.u}`);
  const [probe] = await n8n.query<{ r: unknown }>(`select wf_claim_side_effect('provision-probe', 'provisioner', 1) as r`);
  console.log('EXECUTE wf_claim_side_effect  ->', JSON.stringify(probe!.r));
  for (const sql of ['select count(*) from projects', 'select app_today()', `insert into audit_events(actor_type,actor_id,action,entity_type,entity_id) values ('SYSTEM','x','x','x',gen_random_uuid())`]) {
    try { await n8n.query(sql); console.log(`UNEXPECTED: allowed -> ${sql}`); process.exitCode = 1; }
    catch (e) { console.log(`denied as intended -> ${sql.slice(0, 40)}… (${(e as Error).message})`); }
  }
} finally {
  await n8n.close();
}
