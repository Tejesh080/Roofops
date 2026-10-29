/**
 * The weekly hosted backup (scripts/backup-hosted.ts, master plan Task 1.6), with docker, icacls and the heartbeat
 * replaced by recorders: the URL never appears in a command line, a dump is kept only when pg_restore reads it back,
 * the heartbeat is called only after a backup is safely on disk, and the folder is never inside the repository.
 * The --dry-run test runs the real CLI against a hosted env file that points at a closed local port.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupDir, backupName, runBackup, withSslRequire, type BackupDeps, type Run } from '../scripts/backup-hosted.ts';

const URL_ = 'postgresql://postgres.abcdefghijklmnopqrst:s3cret-pw@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';
const NOW = new Date(2026, 10, 2, 7, 5, 9);                       // 2 Nov 2026 07:05:09 local
const LIST = ';\n; Archive created\n123; 0 16400 TABLE DATA public projects postgres\n124; 0 16401 TABLE DATA public quotes postgres\n125; 0 0 SEQUENCE SET public x postgres\n';

type Call = { cmd: string; args: string[]; env?: Record<string, string> };
const recorder = (fail?: (c: Call) => Run | undefined) => {
  const calls: Call[] = []; const pings: string[] = []; const lines: string[] = [];
  const deps: BackupDeps = {
    run: (cmd, args, env) => {
      const c = { cmd, args, ...(env ? { env } : {}) }; calls.push(c);
      const f = fail?.(c); if (f) return f;
      if (args[0] === 'cp') writeFileSync(args[2]!, 'PGDMP fake dump bytes');            // docker cp <container>:<file> <dest>
      if (args.includes('pg_restore')) return { status: 0, stdout: LIST, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    ping: (u) => { pings.push(u); return Promise.resolve(200); },
    log: (l) => { lines.push(l); },
  };
  return { deps, calls, pings, lines };
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'roofops-backup-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('runBackup', () => {
  it('dumps inside the container, reads it back, keeps it with a SHA-256, then calls the heartbeat', async () => {
    const r = recorder();
    const res = await runBackup(URL_, { dir, container: 'roofops-postgres', now: NOW, heartbeat: 'https://hc.example/ping/abc' }, r.deps);
    expect(res.file).toBe(join(dir, 'weekly-20261102-070509.dump'));
    expect(res.tableData).toBe(2);
    expect(res.heartbeat).toBe('sent');
    expect(r.pings).toEqual(['https://hc.example/ping/abc']);
    const bytes = readFileSync(res.file);
    expect(res.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(readFileSync(`${res.file}.sha256`, 'utf8')).toBe(`${res.sha256}  weekly-20261102-070509.dump\n`);
    const dump = r.calls.find((c) => c.args.includes('sh'))!;
    expect(dump.args).toEqual(['exec', '-e', 'PGURL', 'roofops-postgres', 'sh', '-c',
      'pg_dump "$PGURL" --schema=public --format=custom --no-owner --file=/tmp/weekly-20261102-070509.dump']);
    expect(dump.env?.PGURL).toContain('sslmode=require');
    expect(r.calls.at(-1)!.args).toEqual(['exec', 'roofops-postgres', 'rm', '-f', '/tmp/weekly-20261102-070509.dump']);
  });

  it('never puts the connection URL or its password on a command line', async () => {
    const r = recorder();
    await runBackup(URL_, { dir, container: 'c', now: NOW }, r.deps);
    for (const c of r.calls) expect(c.args.join(' ')).not.toMatch(/s3cret-pw|supabase\.com/);
  });

  it('a failed pg_dump keeps nothing, calls no heartbeat, and still cleans the container', async () => {
    const r = recorder((c) => (c.args.includes('sh') ? { status: 1, stdout: '', stderr: 'pg_dump: error: connection failed\n' } : undefined));
    await expect(runBackup(URL_, { dir, container: 'c', now: NOW, heartbeat: 'https://hc.example/ping/abc' }, r.deps))
      .rejects.toThrow('BACKUP_FAILED: pg_dump: pg_dump: error: connection failed');
    expect(readdirSync(dir)).toEqual([]);
    expect(r.pings).toEqual([]);
    expect(r.calls.at(-1)!.args.slice(-2)).toEqual(['-f', '/tmp/weekly-20261102-070509.dump']);
  });

  it('a dump that pg_restore cannot read, or that holds no table data, is not kept', async () => {
    const empty = recorder((c) => (c.args.includes('pg_restore') ? { status: 0, stdout: ';\n; Archive created\n', stderr: '' } : undefined));
    await expect(runBackup(URL_, { dir, container: 'c', now: NOW, heartbeat: 'h' }, empty.deps)).rejects.toThrow('no TABLE DATA entries');
    const unreadable = recorder((c) => (c.args.includes('pg_restore') ? { status: 1, stdout: '', stderr: 'pg_restore: error: input file is too short\n' } : undefined));
    await expect(runBackup(URL_, { dir, container: 'c', now: NOW, heartbeat: 'h' }, unreadable.deps)).rejects.toThrow('BACKUP_FAILED: pg_restore --list');
    expect(readdirSync(dir)).toEqual([]);
    expect([...empty.pings, ...unreadable.pings]).toEqual([]);
  });

  it('a heartbeat that does not answer 2xx is reported as failed (the backup itself is kept)', async () => {
    const r = recorder(); r.deps.ping = () => Promise.resolve(500);
    const res = await runBackup(URL_, { dir, container: 'c', now: NOW, heartbeat: 'h' }, r.deps);
    expect(res.heartbeat).toBe('failed');
    expect(existsSync(res.file)).toBe(true);
  });

  it('without a heartbeat URL nothing is called', async () => {
    const r = recorder();
    expect((await runBackup(URL_, { dir, container: 'c', now: NOW }, r.deps)).heartbeat).toBe('not configured');
    expect(r.pings).toEqual([]);
  });
});

describe('helpers', () => {
  it('backupName is weekly-YYYYMMDD-HHmmss.dump in local time', () => {
    expect(backupName(NOW)).toBe('weekly-20261102-070509.dump');
  });
  it('TLS is required for a remote database, left alone for a local rehearsal or an explicit sslmode', () => {
    expect(new URL(withSslRequire(URL_)).searchParams.get('sslmode')).toBe('require');
    expect(withSslRequire('postgresql://postgres:postgres@127.0.0.1:5432/roofops')).toBe('postgresql://postgres:postgres@127.0.0.1:5432/roofops');
    expect(new URL(withSslRequire(`${URL_}?sslmode=verify-full`)).searchParams.get('sslmode')).toBe('verify-full');
  });
  it('the backup folder is ~/roofops-backups or ROOFOPS_BACKUP_DIR, never inside the repository', () => {
    const repo = mkdtempSync(join(tmpdir(), 'roofops-repo-'));
    expect(backupDir(repo, {})).toBe(join(homedir(), 'roofops-backups'));
    expect(backupDir(repo, { ROOFOPS_BACKUP_DIR: dir })).toBe(resolve(dir));
    expect(() => backupDir(repo, { ROOFOPS_BACKUP_DIR: join(repo, 'backups') })).toThrow(/^BACKUP_DIR_INSIDE_REPO/);
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('the CLI', () => {
  it('--dry-run says what it would do, connects to nothing, writes nothing and prints no secret', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'roofops-cli-'));
    const envDir = mkdtempSync(join(tmpdir(), 'roofops-cli-env-'));
    writeFileSync(join(envDir, 'hosted.env'), 'SUPABASE_DB_URL=postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:dry-run-pw@127.0.0.1:9/postgres\n');
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !['SUPABASE_DB_URL', 'HEARTBEAT_WEEKLY_BACKUP_URL'].includes(k))),
      ROOFOPS_ENV_DIR: envDir, ROOFOPS_BACKUP_DIR: dir };
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../scripts/backup-hosted.ts', import.meta.url)), '--dry-run'], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('dry run: nothing connected, nothing written');
    expect(r.stdout).toContain(join(resolve(dir), 'weekly-'));
    expect(r.stdout + r.stderr).not.toContain('dry-run-pw');
    expect(readdirSync(dir)).toEqual([]);
    rmSync(cwd, { recursive: true, force: true }); rmSync(envDir, { recursive: true, force: true });
  }, 90_000);
});
