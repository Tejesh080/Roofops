/**
 * npx tsx scripts/release-rehearsal.ts <hosted dump> [--keep]
 *
 * LOCAL ONLY: the local Docker Postgres (container ROOFOPS_PG_CONTAINER, default roofops-postgres). Rehearses a release on
 * a restored hosted backup, the way the 23 Oct release was rehearsed by hand:
 *  1. restores the dump (npm run backup:hosted) into a scratch database, release_rehearsal, and records its migration
 *     head, integrity and schema;
 *  2. applies every migration the backup does not have, in order (the same migrate() as db:load), and records
 *     integrity and the privilege checks again;
 *  3. runs those migrations' rollback files newest first and compares the schema with the restored one;
 *  4. applies them again (a rollback must not leave anything that stops the next deploy);
 *  5. drops the scratch database unless --keep.
 * Prints a summary for the release evidence and exits 1 if any step does not hold. Never connects to a hosted system.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPostgres, type Db } from '../src/db/db.js';
import { MIGRATIONS_DIR, migrate } from '../src/db/migrate.js';

const ROLLBACK_DIR = 'ops/rollback';

export interface RehearsalPlan { pending: string[]; rollbacks: string[]; problems: string[] }

/** Migrations the backup lacks (in order), their rollback files newest first, and anything that stops a rehearsal. */
export function planRehearsal(applied: string[], files: string[], rollbackFiles: string[]): RehearsalPlan {
  const done = new Set(applied);
  const pending = [...files].sort().filter((f) => !done.has(f));
  const problems = applied.filter((a) => !files.includes(a)).map((a) => `the backup has ${a}, which is not in supabase/migrations`);
  for (const f of pending) {
    const down = f.replace(/\.sql$/, '.down.sql');
    if (!rollbackFiles.includes(down)) problems.push(`${f} has no ops/rollback/${down}`);
  }
  const rollbacks = [...pending].reverse().map((f) => f.replace(/\.sql$/, '.down.sql'));
  return { pending, rollbacks, problems };
}

/** pg_restore errors other than the dump's own CREATE SCHEMA public, which the scratch database already has. */
export function restoreProblems(stderr: string): string[] {
  return stderr.split('\n').map((l) => /error: could not execute query: (.*)$/.exec(l)?.[1]?.trim())
    .filter((e): e is string => e !== undefined && e !== 'ERROR:  schema "public" already exists');
}

const CONTAINER = process.env.ROOFOPS_PG_CONTAINER || 'roofops-postgres';
const DB = 'release_rehearsal';
const URL_ = `postgresql://postgres:postgres@127.0.0.1:54322/${DB}`;

function docker(args: string[], input?: Buffer | string) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr || (r.error?.message ?? '') };
}
const psql = (sql: string, db = 'postgres') => {
  const r = docker(['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-Atc', sql]);
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}`);
  return r.stdout.trim();
};
/** Schema only, without the random \restrict key pg_dump 17.6+ writes into every dump. */
const schema = () => {
  const r = docker(['exec', CONTAINER, 'pg_dump', '-U', 'postgres', '--schema-only', '--no-owner', DB]);
  if (r.status !== 0) throw new Error(`pg_dump: ${r.stderr.trim()}`);
  return r.stdout.split('\n').filter((l) => !/^\\(un)?restrict /.test(l)).join('\n');
};

async function facts(db: Db) {
  const [head] = await db.query<{ n: number; head: string }>(`select count(*)::int n, max(version) head from schema_migrations`);
  const integrity = await db.query<{ status: string; n: number }>(`select status, count(*)::int n from integrity_check() group by status order by status`);
  const failing = await db.query<{ k: string }>(`select entity || '.' || check_key k from integrity_check() where status = 'FAIL' order by 1`);
  const one = async (sql: string) => (await db.query<{ v: string }>(sql)).map((r) => r.v);
  const PUB = `from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`;
  return {
    migrations: `${head!.n}, head ${head!.head}`,
    integrity: integrity.map((i) => `${i.n} ${i.status}`).join(' / '),
    failing: failing.map((f) => f.k),
    publicExecute: await one(`select p.proname v ${PUB} and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                where a.grantee = 0 and a.privilege_type = 'EXECUTE')`),
    withoutRls: await one(`select c.relname v from pg_class c join pg_namespace n on n.oid = c.relnamespace
                             where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`),
    workflowNonWf: await one(`select p.proname v ${PUB} and has_function_privilege('roofops_workflow', p.oid, 'execute') and p.proname not like 'wf\\_%'`),
  };
}

async function main(argv: string[]) {
  const dump = argv.find((a) => !a.startsWith('--'));
  if (!dump || !existsSync(dump)) throw new Error('usage: npx tsx scripts/release-rehearsal.ts <hosted dump> [--keep]');
  const keep = argv.includes('--keep');
  const out: string[] = [`Release rehearsal on ${basename(dump)} (local ${CONTAINER}, database ${DB})`];
  let failed = false;
  const check = (ok: boolean, line: string) => { out.push(`${ok ? 'OK  ' : 'FAIL'}  ${line}`); if (!ok) failed = true; };

  psql(`drop database if exists ${DB} with (force)`);
  psql(`create database ${DB}`);
  // As on Supabase: pgcrypto lives in the extensions schema, outside the dumped public schema.
  psql('create schema if not exists extensions; create extension if not exists pgcrypto schema extensions', DB);
  const copied = docker(['cp', dump, `${CONTAINER}:/tmp/release-rehearsal.dump`]);
  if (copied.status !== 0) throw new Error(`docker cp: ${copied.stderr.trim()}`);
  const restored = docker(['exec', CONTAINER, 'pg_restore', '-U', 'postgres', '-d', DB, '--no-owner', '/tmp/release-rehearsal.dump']);
  docker(['exec', CONTAINER, 'rm', '-f', '/tmp/release-rehearsal.dump']);
  const restoreErrors = restoreProblems(restored.stderr);
  check(restoreErrors.length === 0, `restore: ${restoreErrors.length ? restoreErrors.join('; ') : 'clean (only the expected CREATE SCHEMA public)'}`);

  const db = await openPostgres(URL_);
  try {
    const applied = (await db.query<{ version: string }>('select version from schema_migrations order by version')).map((r) => r.version);
    const plan = planRehearsal(applied, readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')),
      readdirSync(ROLLBACK_DIR).filter((f) => f.endsWith('.down.sql')));
    for (const p of plan.problems) check(false, p);
    const before = await facts(db);
    out.push(`backup: ${before.migrations}; integrity ${before.integrity}`);
    out.push(`pending: ${plan.pending.length ? plan.pending.join(', ') : 'none'}`);
    if (plan.problems.length || plan.pending.length === 0) { finish(); return; }
    const restoredSchema = schema();

    const up = await migrate(db);
    check(up.applied.join() === plan.pending.join(), `applied ${up.applied.length} migration(s), exactly the pending ones, in order`);
    const after = await facts(db);
    out.push(`after: ${after.migrations}; integrity ${after.integrity}`);
    check(after.failing.length === 0, `integrity FAIL rules: ${after.failing.join(', ') || 'none'}`);
    check(after.publicExecute.length === 0, `functions executable by PUBLIC: ${after.publicExecute.join(', ') || 'none'}`);
    check(after.withoutRls.length === 0, `tables without row level security: ${after.withoutRls.join(', ') || 'none'}`);
    check(after.workflowNonWf.length === 0, `workflow role runs only wf_* functions: ${after.workflowNonWf.join(', ') || 'yes'}`);

    for (const down of plan.rollbacks) {
      const r = docker(['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-q', '-v', 'ON_ERROR_STOP=1'], readFileSync(join(ROLLBACK_DIR, down)));
      check(r.status === 0, `rollback ${down}${r.status === 0 ? '' : `: ${r.stderr.trim().split('\n').at(-1) ?? ''}`}`);
      if (r.status !== 0) { finish(); return; }
    }
    const rolledBack = await facts(db);
    check(rolledBack.migrations === before.migrations && rolledBack.integrity === before.integrity,
      `after the rollbacks: ${rolledBack.migrations}; integrity ${rolledBack.integrity} (backup: ${before.integrity})`);
    const back = schema();
    check(back === restoredSchema, `schema after the rollbacks equals the restored backup (${restoredSchema.split('\n').length} lines)`);

    const again = await migrate(db);
    const reapplied = await facts(db);
    check(again.applied.length === plan.pending.length && reapplied.integrity === after.integrity,
      `re-applied ${again.applied.length}; integrity ${reapplied.integrity}`);
    finish();
  } finally {
    await db.close();
    if (!keep) psql(`drop database if exists ${DB} with (force)`);
  }

  function finish() {
    out.push(failed ? 'RESULT: FAIL' : 'RESULT: every check held');
    console.log(out.join('\n'));
    if (failed) process.exitCode = 1;
  }
}

/** Only when this file is the entry point: importing it (tests) has no side effect. */
const isMain = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) await main(process.argv.slice(2));
