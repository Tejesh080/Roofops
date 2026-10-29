/**
 * Hosted credentials (docs/master-plan.md Task 0.1).
 *  - They live in <ROOFOPS_ENV_DIR or ~/.roofops>/<target>.env, never in the repository: a repository env file that
 *    holds one is refused, naming the key and never its value.
 *  - Every hosted write names its target on the command line (--confirm <Supabase project ref>); a read does not.
 *    The script tests run each CLI as a real process against a hosted env file that points at a closed local port,
 *    so nothing here reaches a network or a hosted system.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOSTED_ONLY_KEYS, confirmHostedWrite, hostedDbConfig, hostedEnvDir, loadLocalEnv, supabaseProjectRef } from '../src/config/env.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const REF = 'abcdefghijklmnopqrst';
const POOLER = `postgresql://postgres.${REF}:pw@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres`;
/** A hosted env file for the script tests: a pooler-style user (the provision scripts need it) on a closed local port. */
const CLOSED = 'postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:not-a-password@127.0.0.1:9/postgres';

const message = (f: () => unknown): string => {
  try { f(); } catch (e) { return (e as Error).message; }
  throw new Error('expected a throw');
};

let repo: string;
let outside: string;
const saved = { ...process.env };

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'roofops-repo-'));
  outside = mkdtempSync(join(tmpdir(), 'roofops-env-'));
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, saved);
  rmSync(join(repo, '.env'), { force: true });
  rmSync(join(repo, '.env.local'), { force: true });
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('the hosted env directory is outside the repository', () => {
  it('defaults to ~/.roofops', () => {
    expect(hostedEnvDir(repo, {})).toBe(join(homedir(), '.roofops'));
  });
  it('honours ROOFOPS_ENV_DIR', () => {
    expect(hostedEnvDir(repo, { ROOFOPS_ENV_DIR: outside })).toBe(resolve(outside));
  });
  it('refuses a directory inside the repository, or the repository itself', () => {
    expect(() => hostedEnvDir(repo, { ROOFOPS_ENV_DIR: join(repo, 'secrets') })).toThrow(/HOSTED_ENV_INSIDE_REPO/);
    expect(() => hostedEnvDir(repo, { ROOFOPS_ENV_DIR: repo })).toThrow(/HOSTED_ENV_INSIDE_REPO/);
  });
});

describe('a repository env file never holds a hosted credential', () => {
  it.each(HOSTED_ONLY_KEYS)('%s in .env.local is refused, named, and its value never printed', (key) => {
    process.env.ROOFOPS_ENV_DIR = outside;
    writeFileSync(join(repo, '.env.local'), `N8N_BASE_URL=https://example.app.n8n.cloud\n${key}=value-that-must-not-print\n`);
    const m = message(() => { loadLocalEnv(repo); });
    expect(m).toMatch(/^HOSTED_ENV_INSIDE_REPO/);
    expect(m).toContain(key);
    expect(m).toContain(join(resolve(outside), 'hosted.env'));
    expect(m).not.toContain('value-that-must-not-print');
  });
  it('the same in .env', () => {
    process.env.ROOFOPS_ENV_DIR = outside;
    writeFileSync(join(repo, '.env'), 'SUPABASE_DB_URL=postgresql://u:p@h/db\n');
    expect(() => { loadLocalEnv(repo); }).toThrow(/HOSTED_ENV_INSIDE_REPO: \.env defines SUPABASE_DB_URL/);
  });
  it('local settings still load', () => {
    writeFileSync(join(repo, '.env.local'), 'ROOFOPS_TEST_LOCAL_ONLY=yes\n');
    loadLocalEnv(repo);
    expect(process.env.ROOFOPS_TEST_LOCAL_ONLY).toBe('yes');
  });
});

describe('hostedDbConfig reads only the hosted env file', () => {
  it('hosted.env by default, staging.env for staging', () => {
    process.env.ROOFOPS_ENV_DIR = outside;
    writeFileSync(join(outside, 'hosted.env'), `SUPABASE_DB_URL=${POOLER}\n`);
    writeFileSync(join(outside, 'staging.env'), 'SUPABASE_DB_URL=postgresql://postgres.stagingref:pw@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres\n');
    expect(hostedDbConfig('hosted', repo)).toEqual({ url: POOLER, verified: false });
    expect(hostedDbConfig('staging', repo).url).toContain('postgres.stagingref');
  });
  it('a SUPABASE_DB_URL from the shell is ignored', () => {
    process.env.ROOFOPS_ENV_DIR = outside;
    process.env.SUPABASE_DB_URL = 'postgresql://shell:pw@shell.example/db';
    writeFileSync(join(outside, 'hosted.env'), `SUPABASE_DB_URL=${POOLER}\n`);
    expect(hostedDbConfig('hosted', repo).url).toBe(POOLER);
  });
  it('other hosted keys reach process.env for the scripts that need them', () => {
    process.env.ROOFOPS_ENV_DIR = outside;
    writeFileSync(join(outside, 'hosted.env'), `SUPABASE_DB_URL=${POOLER}\nRECONCILE_TRIGGER_TOKEN=t0ken\n`);
    hostedDbConfig('hosted', repo);
    expect(process.env.RECONCILE_TRIGGER_TOKEN).toBe('t0ken');
  });
  it('a relative CA path is read from the env directory', () => {
    process.env.ROOFOPS_ENV_DIR = outside;
    writeFileSync(join(outside, 'ca.crt'), 'PEM');
    writeFileSync(join(outside, 'hosted.env'), `SUPABASE_DB_URL=${POOLER}\nSUPABASE_CA_CERT=ca.crt\n`);
    expect(hostedDbConfig('hosted', repo)).toEqual({ url: POOLER, caPem: 'PEM', verified: true });
  });
  it('a missing file says where it is expected', () => {
    const empty = mkdtempSync(join(tmpdir(), 'roofops-empty-'));
    process.env.ROOFOPS_ENV_DIR = empty;
    expect(() => hostedDbConfig('staging', repo)).toThrow(`HOSTED_ENV_MISSING: ${join(resolve(empty), 'staging.env')}`);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('supabaseProjectRef', () => {
  it('reads the pooler user postgres.<ref> (and any role.<ref>)', () => {
    expect(supabaseProjectRef(POOLER)).toBe(REF);
    expect(supabaseProjectRef(POOLER.replace('postgres.', 'roofops_web.'))).toBe(REF);
  });
  it('reads the direct host db.<ref>.supabase.co', () => {
    expect(supabaseProjectRef(`postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`)).toBe(REF);
  });
  it('falls back to the host name', () => {
    expect(supabaseProjectRef('postgresql://postgres:pw@127.0.0.1:5432/x')).toBe('127.0.0.1');
  });
});

describe('confirmHostedWrite', () => {
  it('requires --confirm <ref>, and never prints the expected ref', () => {
    for (const argv of [[], ['--hosted'], ['--confirm'], ['--confirm', '--hosted']]) {
      const m = message(() => { confirmHostedWrite(POOLER, argv); });
      expect(m).toMatch(/^HOSTED_CONFIRM_REQUIRED/);
      expect(m).not.toContain(REF);
    }
  });
  it('refuses a ref that is not the configured project', () => {
    const m = message(() => { confirmHostedWrite(POOLER, ['--confirm', 'some-other-project']); });
    expect(m).toMatch(/^HOSTED_CONFIRM_MISMATCH/);
    expect(m).not.toContain(REF);
  });
  it('passes when the ref matches', () => {
    expect(() => { confirmHostedWrite(POOLER, ['--hosted', '--confirm', REF]); }).not.toThrow();
  });
});

describe.concurrent('the CLIs: every hosted write needs --confirm, no read does', () => {
  let cwd: string;
  let envDir: string;
  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'roofops-cli-'));
    envDir = mkdtempSync(join(tmpdir(), 'roofops-cli-env-'));
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, 'hosted.env'), `SUPABASE_DB_URL=${CLOSED}\n`);
  });
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(envDir, { recursive: true, force: true });
  });

  const run = (script: string, args: string[]) => new Promise<{ status: number | null; stderr: string }>((done) => {
    const drop: string[] = [...HOSTED_ONLY_KEYS, 'DATABASE_URL', 'SUPABASE_CA_CERT', 'TEST_DATABASE_URL'];
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.includes(k))), ROOFOPS_ENV_DIR: envDir };
    const p = spawn(process.execPath, [TSX, join(ROOT, 'scripts', script), ...args], { cwd, env, windowsHide: true });
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    p.stdout.resume();
    const kill = setTimeout(() => { p.kill(); }, 90_000);
    p.on('close', (status) => { clearTimeout(kill); done({ status, stderr }); });
  });

  const WRITES: [string, string[]][] = [
    ['db-load.ts', ['--hosted']],
    ['sql.ts', ['select 1']],
    ['exception.ts', ['resolve', 'EXC-0001', '--by', 'EMP-900', '--note', 'a real reason']],
    ['staff.ts', ['add-employee', 'EMP-101', '--name', 'Test Person', '--email', 'test@example.com', '--role', 'VIEWER']],
    ['reconcile.ts', []],
    ['reconcile.ts', ['--dry-run']],
    ['demo.ts', ['reset']],
    ['reissue.ts', ['request', '--invoice', 'INV-2026-0004', '--by', 'EMP-900', '--reason', 'a reason long enough', '--hosted']],
    ['provision-dashboard-role.ts', []],
    ['provision-n8n-role.ts', []],
    ['verify-airtable-load.ts', ['no-such-dir']],
  ];
  it.each(WRITES)('%s %j refuses without --confirm', async (script, args) => {
    const r = await run(script, args);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('HOSTED_CONFIRM_REQUIRED');
  }, 120_000);

  it('db-load.ts --hosted refuses a wrong ref, and passes the gate with the right one', async () => {
    const wrong = await run('db-load.ts', ['--hosted', '--confirm', 'wrong-ref']);
    expect(wrong.stderr).toContain('HOSTED_CONFIRM_MISMATCH');
    const right = await run('db-load.ts', ['--hosted', '--confirm', '127.0.0.1']);
    expect(right.status).not.toBe(0);                     // the closed port, after the gate
    expect(right.stderr).not.toContain('HOSTED_CONFIRM');
  }, 120_000);

  const READS: [string, string[]][] = [
    ['sql.ts', ['--read-only', 'select 1']],
    ['integrity-check.ts', []],
    ['security-check.ts', []],
    ['reissue.ts', ['status', '--invoice', 'INV-2026-0004', '--hosted']],
    ['demo.ts', ['status']],
  ];
  it.each(READS)('%s %j needs no --confirm', async (script, args) => {
    const r = await run(script, args);
    expect(r.status).not.toBe(0);                         // the closed port
    expect(r.stderr).not.toContain('HOSTED_CONFIRM');
    expect(r.stderr).not.toContain('HOSTED_ENV');
  }, 120_000);
});
