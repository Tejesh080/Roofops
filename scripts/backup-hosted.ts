/**
 * npm run backup:hosted                read-only dump of the hosted database to the backup folder (weekly; master plan Task 1.6)
 * npm run backup:hosted -- --dry-run   print what it would do; connects to nothing and writes nothing
 *
 * The release runbooks' procedure (ops/ac13b-deployment-runbook.md §3 B1), as one command: pg_dump runs inside the local
 * Postgres 17 container (ROOFOPS_PG_CONTAINER, default roofops-postgres) with schema public, custom format, no owner and
 * TLS required. The connection URL reaches the container as an environment variable, never as a command-line argument.
 * pg_restore --list must read the dump back before it is kept. Output: <dir>/weekly-<stamp>.dump and its .sha256, readable
 * by the owner only; <dir> is ROOFOPS_BACKUP_DIR, else ~/roofops-backups, never inside the repository. Then
 * HEARTBEAT_WEEKLY_BACKUP_URL (hosted.env), when set, is called, so a week without a backup raises an alert. Read-only on
 * the database, so no --confirm. Never prints the URL.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeUrl, hostedDbConfig, outsideRepo } from '../src/config/env.js';

export interface Run { status: number | null; stdout: string; stderr: string }
export interface BackupDeps {
  /** Runs a command; `env` adds variables for that process only. */
  run(cmd: string, args: string[], env?: Record<string, string>): Run;
  /** Calls the heartbeat URL; resolves to the HTTP status. */
  ping(url: string): Promise<number>;
  log(line: string): void;
}
export interface BackupResult { file: string; bytes: number; sha256: string; tableData: number; heartbeat: 'sent' | 'not configured' | 'failed' }

/** ~/roofops-backups unless ROOFOPS_BACKUP_DIR says otherwise; never inside the repository. */
export function backupDir(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  return outsideRepo(env.ROOFOPS_BACKUP_DIR || join(homedir(), 'roofops-backups'), cwd, 'BACKUP_DIR_INSIDE_REPO', 'ROOFOPS_BACKUP_DIR');
}

/** weekly-YYYYMMDD-HHmmss.dump, in local time. */
export function backupName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `weekly-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.dump`;
}

/** TLS is required for a remote database; a local one (a rehearsal) is left as it is. */
export function withSslRequire(url: string): string {
  const u = new URL(url);
  if (['127.0.0.1', 'localhost', '::1'].includes(u.hostname) || u.searchParams.has('sslmode')) return url;
  u.searchParams.set('sslmode', 'require');
  return u.toString();
}

export async function runBackup(url: string, opts: { dir: string; container: string; now: Date; heartbeat?: string }, deps: BackupDeps): Promise<BackupResult> {
  const name = backupName(opts.now);
  const inside = `/tmp/${name}`;
  const file = join(opts.dir, name);
  const docker = (args: string[], env?: Record<string, string>, what = args.join(' ')) => {
    const r = deps.run('docker', args, env);
    if (r.status !== 0) throw new Error(`BACKUP_FAILED: ${what}: ${r.stderr.trim().split('\n').at(-1) ?? `exit ${String(r.status)}`}`);
    return r;
  };
  try {
    docker(['exec', '-e', 'PGURL', opts.container, 'sh', '-c', `pg_dump "$PGURL" --schema=public --format=custom --no-owner --file=${inside}`],
      { PGURL: withSslRequire(url) }, 'pg_dump');
    const list = docker(['exec', opts.container, 'pg_restore', '--list', inside], undefined, 'pg_restore --list').stdout;
    const tableData = list.split('\n').filter((l) => / TABLE DATA /.test(l)).length;
    if (tableData === 0) throw new Error('BACKUP_FAILED: pg_restore --list found no TABLE DATA entries');
    mkdirSync(opts.dir, { recursive: true });
    docker(['cp', `${opts.container}:${inside}`, file], undefined, 'docker cp');
    const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
    writeFileSync(`${file}.sha256`, `${sha256}  ${basename(file)}\n`);
    for (const f of [file, `${file}.sha256`]) ownerOnly(f, deps);
    let heartbeat: BackupResult['heartbeat'] = 'not configured';
    if (opts.heartbeat) { const s = await deps.ping(opts.heartbeat).catch(() => 0); heartbeat = s >= 200 && s < 300 ? 'sent' : 'failed'; }
    return { file, bytes: statSync(file).size, sha256, tableData, heartbeat };
  } finally {
    deps.run('docker', ['exec', opts.container, 'rm', '-f', inside]);
  }
}

/** Readable by the owner only: on Windows the owner and SYSTEM (as the release backups), elsewhere 0600. */
function ownerOnly(file: string, deps: BackupDeps) {
  if (process.platform !== 'win32') { chmodSync(file, 0o600); return; }
  const user = process.env.USERNAME;
  if (!user) throw new Error('BACKUP_FAILED: USERNAME is not set, so the file could not be restricted to its owner');
  const r = deps.run('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`, '/grant:r', 'SYSTEM:F']);
  if (r.status !== 0) throw new Error(`BACKUP_FAILED: icacls: ${r.stderr.trim()}`);
}

const realDeps: BackupDeps = {
  run: (cmd, args, env) => {
    const r = spawnSync(cmd, args, { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr || (r.error?.message ?? '') };
  },
  ping: async (url) => (await fetch(url, { signal: AbortSignal.timeout(10_000) })).status,
  log: (line) => { console.log(line); },
};

async function main(argv: string[]) {
  const cfg = hostedDbConfig();
  const dir = backupDir();
  const container = process.env.ROOFOPS_PG_CONTAINER || 'roofops-postgres';
  const heartbeat = process.env.HEARTBEAT_WEEKLY_BACKUP_URL || undefined;
  const now = new Date();
  console.log(`source: HOSTED ${describeUrl(cfg.url)} (read-only pg_dump in container ${container})`);
  console.log(`output: ${join(dir, backupName(now))} (+ .sha256)`);
  console.log(`heartbeat: ${heartbeat ? 'configured' : 'not configured (HEARTBEAT_WEEKLY_BACKUP_URL)'}`);
  if (argv.includes('--dry-run')) { console.log('dry run: nothing connected, nothing written'); return; }
  if (!existsSync(dir)) console.log(`creating ${dir}`);
  const r = await runBackup(cfg.url, { dir, container, now, ...(heartbeat ? { heartbeat } : {}) }, realDeps);
  console.log(`backup: ${r.file}, ${r.bytes} bytes, SHA-256 ${r.sha256}, ${r.tableData} TABLE DATA entries; heartbeat ${r.heartbeat}`);
  if (r.heartbeat === 'failed') process.exitCode = 1;
}

/** Only when this file is the entry point: importing it (tests) has no side effect. */
const isMain = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) await main(process.argv.slice(2));
