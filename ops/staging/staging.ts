/**
 * Isolated staging for one supervised quote hand-off (n8n 10) against a SEPARATE Supabase database and a SEPARATE
 * Airtable base. The originals are never modified: staging copies of the migrations and of n8n 10 are generated with
 * every production Airtable id (base, tables, fields) and n8n credential id replaced by its staging counterpart.
 *
 *   npx tsx ops/staging/staging.ts map --staging-schema <file> [--n8n-airtable-credential <id> --n8n-postgres-credential <id>]
 *       Matches the staging base to the production schema (ops/staging/production-airtable-schema.json) by table name
 *       and field name, and writes ops/staging/out/map.json. Fails on anything unmatched or ambiguous.
 *   npx tsx ops/staging/staging.ts generate     ops/staging/out/migrations/*.sql and the staging n8n 10, then validate
 *   npx tsx ops/staging/staging.ts validate     no production id anywhere in the output; reverse-mapping the output
 *                                               gives back the originals exactly
 *   npx tsx ops/staging/staging.ts load [--local-test]          migrate the staging database from the generated
 *                                               migrations, mark it staging, add one synthetic sales login and the n8n role
 *   npx tsx ops/staging/staging.ts synthetic-quote [--local-test]   one synthetic enquiry -> customer -> site -> quote, sent
 *
 * Connection: ONLY ops/staging/.env.staging (STAGING_DB_URL, optional STAGING_CA_CERT). This file never reads
 * process.env for a database and never loads an env file into it; from src/config/env.ts it uses only hostedEnvDir(), to
 * find the production project in hosted.env so guard() can refuse it. It refuses any database that looks like
 * production (see guard()). Secrets it creates go to ops/staging/secrets/ (gitignored) and are never printed.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { hostedEnvDir } from '../../src/config/env.js';
import { openPostgres, type Db } from '../../src/db/db.js';
import { MIGRATIONS_DIR, migrate } from '../../src/db/migrate.js';

export const DIR = 'ops/staging';
export const OUT = join(DIR, 'out');
const PROD_SCHEMA = join(DIR, 'production-airtable-schema.json');
const WORKFLOW_SRC = 'n8n/10-airtable-quote-publish.sdk.ts';
export const WORKFLOW_OUT = '10-airtable-quote-publish.staging.sdk.ts';
/** Production n8n credentials referenced by n8n 10 (ids are not secrets; the staging ones replace them). */
export const PROD_CREDENTIALS = {
  airtable: { id: '3XbFnHjAd7mFvBD2', name: 'Roofops Airtable Personal Access Token account' },
  postgres: { id: 'kWqjtv0gz7ref2EN', name: 'RoofOps Postgres' },
};
const TOKEN = /\b(app|tbl|fld)[A-Za-z0-9]{14}\b/g;
const MARKER_SCHEMA = 'roofops_env';

export interface Schema { baseId: string; tables: { id: string; name: string; fields: { id: string; name: string; type?: string }[] }[] }
export interface StagingMap {
  production_base: string; staging_base: string;
  ids: Record<string, string>;                                   // production app/tbl/fld id -> staging id
  credentials: { airtable: { id: string; name: string }; postgres: { id: string; name: string } };
}

const prodSchema = (): Schema => JSON.parse(readFileSync(PROD_SCHEMA, 'utf8')) as Schema;

/** Every production id the sources use (migrations + n8n 10). */
export function sourceIds(): Set<string> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).map((f) => join(MIGRATIONS_DIR, f)).concat(WORKFLOW_SRC);
  return new Set(files.flatMap((f) => readFileSync(f, 'utf8').match(TOKEN) ?? []));
}

/** Production -> staging ids by table name and field name. Throws on anything the sources need that is unmatched. */
export function buildMap(prod: Schema, staging: Schema, credentials: StagingMap['credentials']): StagingMap {
  const problems: string[] = [];
  const ids: Record<string, string> = { [prod.baseId]: staging.baseId };
  for (const t of prod.tables) {
    const st = staging.tables.filter((x) => x.name === t.name);
    if (st.length !== 1) { problems.push(`table "${t.name}": ${st.length} in the staging base`); continue; }
    ids[t.id] = st[0]!.id;
    for (const f of t.fields) {
      const sf = st[0]!.fields.filter((x) => x.name === f.name);
      if (sf.length !== 1) { problems.push(`field "${t.name}.${f.name}": ${sf.length} in the staging base`); continue; }
      if (f.type && sf[0]!.type && f.type !== sf[0]!.type) problems.push(`field "${t.name}.${f.name}": type ${sf[0]!.type}, production ${f.type}`);
      ids[f.id] = sf[0]!.id;
    }
  }
  const needed = [...sourceIds()].filter((id) => !(id in ids));
  if (needed.length) problems.push(`ids used by the sources but not in the production schema: ${needed.join(', ')}`);
  const values = Object.values(ids);
  if (new Set(values).size !== values.length) problems.push('two production ids map to the same staging id');
  const prodIds = new Set(Object.keys(ids));
  const clash = values.filter((v) => prodIds.has(v));
  if (clash.length) problems.push(`staging ids equal to production ids (is this the production base?): ${clash.slice(0, 5).join(', ')}`);
  for (const c of [credentials.airtable.id, credentials.postgres.id]) {
    if (!/^[A-Za-z0-9]{16}$/.test(c)) problems.push(`n8n credential id "${c}" is not a 16-character n8n id`);
    if (c === PROD_CREDENTIALS.airtable.id || c === PROD_CREDENTIALS.postgres.id) problems.push(`n8n credential ${c} is a PRODUCTION credential`);
  }
  if (problems.length) throw new Error(`staging map refused:\n  - ${problems.join('\n  - ')}`);
  return { production_base: prod.baseId, staging_base: staging.baseId, ids, credentials };
}

const swap = (text: string, ids: Record<string, string>, file: string) => text.replace(TOKEN, (t) => {
  const s = ids[t];
  if (!s) throw new Error(`${file}: ${t} has no staging id`);
  return s;
});

/** The deliberate, reversible renames in the staging workflow (applied after the id swap). */
const workflowRenames = (m: StagingMap): [string, string][] => [
  [`id: '${PROD_CREDENTIALS.airtable.id}', name: '${PROD_CREDENTIALS.airtable.name}'`, `id: '${m.credentials.airtable.id}', name: '${m.credentials.airtable.name}'`],
  [`id: '${PROD_CREDENTIALS.postgres.id}', name: '${PROD_CREDENTIALS.postgres.name}'`, `id: '${m.credentials.postgres.id}', name: '${m.credentials.postgres.name}'`],
  [`workflow('roofops-airtable-quote-publish', '[RoofOps] 10 Airtable Quote Publish')`, `workflow('roofops-staging-airtable-quote-publish', '[STAGING] 10 Airtable Quote Publish')`],
  [`// [RoofOps] 10 Airtable Quote Publish (SALES-01).`, `// [STAGING] GENERATED by ops/staging/staging.ts from n8n/10-airtable-quote-publish.sdk.ts: staging base and credentials only.\n// [RoofOps] 10 Airtable Quote Publish (SALES-01).`],
];
const replaceOnce = (text: string, a: string, b: string, file: string) => {
  const n = text.split(a).length - 1;
  if (n !== 1) throw new Error(`${file}: expected one "${a.slice(0, 60)}", found ${n}`);
  return text.replace(a, () => b);
};

export function generate(m: StagingMap, out = OUT): void {
  rmSync(join(out, 'migrations'), { recursive: true, force: true });
  mkdirSync(join(out, 'migrations'), { recursive: true });
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    writeFileSync(join(out, 'migrations', f), swap(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'), m.ids, f));
  }
  let wf = swap(readFileSync(WORKFLOW_SRC, 'utf8'), m.ids, WORKFLOW_SRC);
  for (const [a, b] of workflowRenames(m)) wf = replaceOnce(wf, a, b, WORKFLOW_OUT);
  writeFileSync(join(out, WORKFLOW_OUT), wf);
}

/** Independent check of the generated files. Returns a summary; throws on any problem. */
export function validate(m: StagingMap, out = OUT): { migrations: number; ids_replaced: number; workflow_ids: number } {
  const problems: string[] = [];
  const prod = prodSchema();
  const forbidden = new Set<string>([prod.baseId, ...prod.tables.flatMap((t) => [t.id, ...t.fields.map((f) => f.id)]),
    PROD_CREDENTIALS.airtable.id, PROD_CREDENTIALS.postgres.id, PROD_CREDENTIALS.airtable.name, PROD_CREDENTIALS.postgres.name]);
  const staging = new Set(Object.values(m.ids));
  const back = Object.fromEntries(Object.entries(m.ids).map(([p, s]) => [s, p]));
  let replaced = 0;
  const srcFiles = readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort();
  const outFiles = existsSync(join(out, 'migrations')) ? readdirSync(join(out, 'migrations')).filter((x) => x.endsWith('.sql')).sort() : [];
  if (srcFiles.join() !== outFiles.join()) problems.push(`migration files differ: ${srcFiles.length} originals, ${outFiles.length} generated`);
  const check = (file: string, text: string, original: string, reverse: (t: string) => string) => {
    for (const f of forbidden) if (text.includes(f)) problems.push(`${file}: still contains production ${f}`);
    for (const t of text.match(TOKEN) ?? []) if (!staging.has(t)) problems.push(`${file}: ${t} is not a staging id`);
    if (reverse(text) !== original) problems.push(`${file}: reverse-mapped it does not equal the original (something other than ids changed)`);
    replaced += (text.match(TOKEN) ?? []).length;
  };
  for (const f of outFiles) {
    check(f, readFileSync(join(out, 'migrations', f), 'utf8'), readFileSync(join(MIGRATIONS_DIR, f), 'utf8'),
      (t) => t.replace(TOKEN, (x) => back[x] ?? x));
  }
  const wfPath = join(out, WORKFLOW_OUT);
  if (!existsSync(wfPath)) problems.push(`${WORKFLOW_OUT} was not generated`);
  const wf = existsSync(wfPath) ? readFileSync(wfPath, 'utf8') : '';
  check(WORKFLOW_OUT, wf, readFileSync(WORKFLOW_SRC, 'utf8'), (t) => {
    let r = t;
    for (const [a, b] of workflowRenames(m).reverse()) r = r.replace(b, () => a);
    return r.replace(TOKEN, (x) => back[x] ?? x);
  });
  if (!wf.includes(`https://api.airtable.com/v0/${m.staging_base}`)) problems.push('the staging workflow does not target the staging base');
  if (!wf.includes(`'[STAGING] 10 Airtable Quote Publish'`) || !wf.includes(`disabled: true`)) problems.push('the staging workflow is not named [STAGING] or its trigger is not disabled');
  const wfIds = wf.match(TOKEN) ?? [];
  if (problems.length) throw new Error(`staging output refused:\n  - ${[...new Set(problems)].slice(0, 30).join('\n  - ')}`);
  return { migrations: outFiles.length, ids_replaced: replaced, workflow_ids: wfIds.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Database: guarded connection to the staging database only.

/** The staging connection, from ops/staging/.env.staging only. */
export function stagingEnv(file = join(DIR, '.env.staging')): { url: string; caPem: string | undefined } {
  if (!existsSync(file)) throw new Error(`${file} is missing (copy ops/staging/env.staging.example)`);
  const env = parseEnv(readFileSync(file, 'utf8'));
  if (!env.STAGING_DB_URL) throw new Error(`${file} has no STAGING_DB_URL`);
  return { url: env.STAGING_DB_URL, caPem: env.STAGING_CA_CERT ? readFileSync(env.STAGING_CA_CERT, 'utf8') : undefined };
}

/**
 * Production identifiers, read (never used to connect) from the production env and secret files, if present: the
 * hosted env file outside the repository (where Task 0.1 keeps SUPABASE_DB_URL) and the older files inside it.
 */
function productionFingerprints(root = '.', envDir = hostedEnvDir(root)): string[] {
  const out: string[] = [];
  const files: [string, string][] = [[join(envDir, 'hosted.env'), 'SUPABASE_DB_URL'], [join(root, '.env.local'), 'SUPABASE_DB_URL'],
    [join(root, '.env'), 'SUPABASE_DB_URL'], [join(root, 'web/.env.local'), 'DASHBOARD_DATABASE_URL']];
  for (const [p, key] of files) {
    if (!existsSync(p)) continue;
    const v = parseEnv(readFileSync(p, 'utf8'))[key];
    if (!v) continue;
    try {
      const u = new URL(v);
      const ref = decodeURIComponent(u.username).split('.')[1];
      if (ref) out.push(ref);
      if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname)) out.push(`${u.hostname}${u.pathname}|${decodeURIComponent(u.username)}`);
    } catch { /* not a URL */ }
  }
  const n8n = join(root, 'secrets/roofops-n8n-postgres.env');
  if (existsSync(n8n)) { const ref = (parseEnv(readFileSync(n8n, 'utf8')).PGUSER ?? '').split('.')[1]; if (ref) out.push(ref); }
  return out;
}

/** Refuses anything that is not clearly the staging database, before and after connecting. */
export async function guard(url: string, opts: { localTest: boolean; caPem?: string | undefined; envDir?: string }, root = '.'): Promise<Db> {
  const u = new URL(url);
  const local = ['127.0.0.1', 'localhost', '::1'].includes(u.hostname);
  if (opts.localTest !== local) throw new Error(opts.localTest ? '--local-test only runs against a local database' : 'refusing a local database without --local-test');
  const user = decodeURIComponent(u.username);
  for (const f of productionFingerprints(root, opts.envDir)) {
    if (f.includes('|') ? `${u.hostname}${u.pathname}|${user}` === f : user.split('.')[1] === f || u.hostname.includes(f)) {
      throw new Error('refusing: STAGING_DB_URL points at the PRODUCTION Supabase project');
    }
  }
  const db = await openPostgres(url, opts.caPem ? { caPem: opts.caPem } : undefined);
  try {
    const [s] = await db.query<{ marked: boolean; tables: number }>(
      `select exists (select 1 from information_schema.tables where table_schema = '${MARKER_SCHEMA}' and table_name = 'marker') marked,
              (select count(*)::int from information_schema.tables where table_schema = 'public') tables`);
    if (s!.marked) {
      const [m] = await db.query<{ env: string }>(`select env from ${MARKER_SCHEMA}.marker limit 1`);
      if (m?.env !== 'staging') throw new Error('refusing: the database marker does not say staging');
    } else if (s!.tables > 0) {
      throw new Error(`refusing: this database already has ${s!.tables} tables and is not marked staging (production or another database?). Use an empty database.`);
    } else {
      await db.exec(`create schema ${MARKER_SCHEMA}; create table ${MARKER_SCHEMA}.marker (env text not null check (env = 'staging'), marked_at timestamptz not null default now());
                     insert into ${MARKER_SCHEMA}.marker (env) values ('staging');`);
    }
    return db;
  } catch (e) { await db.close(); throw e; }
}

export const SECRETS = join(DIR, 'secrets');
const secret = (dir: string, file: string, lines: string[]) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), lines.join('\n') + '\n', { mode: 0o600 });
};
export const STAFF = { code: 'EMP-901', name: 'Synthetic Staging Estimator', email: 'staging.estimator@example.test', role: 'ESTIMATOR', login: 'staging.estimator' };

/** Migrate from the generated migrations, then one synthetic sales login and the n8n role. Idempotent. */
export async function load(db: Db, url: string, out = OUT, secrets = SECRETS): Promise<{ applied: number; n8n_role: string }> {
  const r = await migrate(db, join(out, 'migrations'));
  const [e] = await db.query<{ n: number }>('select count(*)::int n from employees where employee_code = $1', [STAFF.code]);
  if (!e!.n) {
    await db.query(`insert into employees (employee_code, full_name, email, role, is_active) values ($1, $2, $3, $4, true)`, [STAFF.code, STAFF.name, STAFF.email, STAFF.role]);
    const password = randomBytes(18).toString('base64url');
    const [s] = await db.query<{ r: { ok: boolean; reason?: string } }>('select ops_staff_set_password($1, $2, $3) r', [STAFF.code, STAFF.login, password]);
    if (!s!.r.ok) throw new Error(`synthetic login not set: ${s!.r.reason ?? ''}`);
    secret(secrets, 'staff.env', ['# Synthetic staging sales login (staging database only). Gitignored.', `STAGING_STAFF_LOGIN=${STAFF.login}`, `STAGING_STAFF_PASSWORD=${password}`]);
  }
  // The role n8n uses: a member of roofops_workflow only (as scripts/provision-n8n-role.ts does for hosted).
  const u = new URL(url);
  const ref = decodeURIComponent(u.username).split('.')[1];
  const role = 'roofops_n8n';
  const [x] = await db.query<{ n: number }>('select count(*)::int n from pg_roles where rolname = $1', [role]);
  if (!x!.n || !existsSync(join(secrets, 'n8n-postgres.env'))) {
    const pw = randomBytes(32).toString('base64url');
    const [{ sql } = { sql: '' }] = await db.query<{ sql: string }>(`select format('%s role %I with login password %L connection limit 10', $1::text, $2::text, $3::text) as sql`,
      [x!.n ? 'alter' : 'create', role, pw]);
    await db.exec(sql);
    await db.exec(`grant roofops_workflow to ${role}; alter role ${role} set search_path = public;`);
    secret(secrets, 'n8n-postgres.env', ['# n8n Postgres credential for the STAGING database only. Gitignored; copy into the STAGING n8n credential.',
      `PGHOST=${u.hostname}`, `PGPORT=${u.port || '5432'}`, `PGDATABASE=${u.pathname.slice(1)}`, `PGUSER=${ref ? `${role}.${ref}` : role}`, `PGPASSWORD=${pw}`, 'PGSSLMODE=require']);
  }
  return { applied: r.applied.length, n8n_role: role };
}

/** One synthetic enquiry -> new customer -> new site -> quote (values Airtable has), sent. Returns the quote and its hand-off key. */
export async function syntheticQuote(db: Db, tag = String(Date.now()).slice(-6), secrets = SECRETS): Promise<{ quote: string; key: string; lead: string }> {
  const s = parseEnv(readFileSync(join(secrets, 'staff.env'), 'utf8'));
  const one = async (sql: string, p: unknown[]) => ((await db.query<{ r: Record<string, unknown> }>(sql, p))[0]!).r;
  const ok = (r: Record<string, unknown>, what: string) => { if (r.ok !== true) throw new Error(`${what} refused: ${JSON.stringify(r)}`); return r; };
  const tok = String(ok(await one('select web_staff_sign_in($1, $2) r', [s.STAGING_STAFF_LOGIN, s.STAGING_STAFF_PASSWORD]), 'sign-in').token);
  const name = `ZZ Synthetic Staging ${tag}`;
  const lead = ok(await one('select web_lead_create($1,$2,$3,$4,$5,$6,$7,$8,$9) r',
    [tok, name, '0400 000 066', `staging.${tag}@example.test`, '1 Synthetic Test Street, Bundaberg', 'REFERRAL', 'Staging test: leak over the kitchen', `staging-lead-${tag}`, true]), 'enquiry');
  ok(await one('select web_lead_convert($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) r', [tok, lead.lead_number, 1, null,
    JSON.stringify({ display_name: name, customer_type: 'RESIDENTIAL', email: `staging.${tag}@example.test`, phone: '0400 000 066', preferred_contact: 'EMAIL' }),
    JSON.stringify({ address_line1: `${tag} Synthetic Test Street`, suburb: 'Bundaberg', state: 'QLD', postcode: '4670', property_type: 'DETACHED_HOUSE' }), true]), 'customer and site');
  const q = ok(await one('select web_quote_save($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) r', [tok, lead.lead_number, null, null, 'LEAK_REPAIR', 'INCLUSIVE', 'Staging test quote',
    JSON.stringify([{ line_kind: 'LABOUR', description: 'Staging test labour', quantity: '1', unit: 'hrs', unit_price: '100' }]), `staging-quote-${tag}`]), 'quote');
  const sent = ok(await one('select web_quote_send($1,$2,$3) r', [tok, q.quote_number, q.record_version]), 'send');
  return { quote: String(q.quote_number), key: String(sent.airtable_key), lead: String(lead.lead_number) };
}

// ---------------------------------------------------------------------------------------------------------------
async function main(argv: string[]) {
  const [cmd] = argv;
  const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const mapFile = join(OUT, 'map.json');
  const readMap = () => JSON.parse(readFileSync(mapFile, 'utf8')) as StagingMap;
  if (cmd === 'map') {
    const file = opt('--staging-schema');
    if (!file) throw new Error('usage: map --staging-schema <file> --n8n-airtable-credential <id> --n8n-postgres-credential <id>');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Schema;
    const m = buildMap(prodSchema(), raw, {
      airtable: { id: opt('--n8n-airtable-credential') ?? 'PENDINGAIRTABLE0', name: 'RoofOps STAGING Airtable' },
      postgres: { id: opt('--n8n-postgres-credential') ?? 'PENDINGPOSTGRES0', name: 'RoofOps STAGING Postgres' } });
    mkdirSync(OUT, { recursive: true });
    writeFileSync(mapFile, JSON.stringify(m, null, 2) + '\n');
    console.log(`map written: ${Object.keys(m.ids).length} ids, base ${m.production_base} -> ${m.staging_base}`);
  } else if (cmd === 'generate') {
    const m = readMap(); generate(m); console.log('generated and validated:', JSON.stringify(validate(m)));
  } else if (cmd === 'validate') {
    console.log('valid:', JSON.stringify(validate(readMap())));
  } else if (cmd === 'load' || cmd === 'synthetic-quote') {
    const localTest = argv.includes('--local-test');
    const env = stagingEnv();
    validate(readMap());                                       // never load anything that is not the validated output
    const db = await guard(env.url, { localTest, caPem: env.caPem });
    try {
      if (cmd === 'load') console.log('staging database loaded:', JSON.stringify(await load(db, env.url)), '(secrets in ops/staging/secrets, not printed)');
      else console.log('synthetic quote sent:', JSON.stringify(await syntheticQuote(db)));
    } finally { await db.close(); }
  } else {
    throw new Error('usage: staging.ts map | generate | validate | load [--local-test] | synthetic-quote [--local-test]');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e: unknown) => { console.error((e as Error).message); process.exitCode = 1; });
}
