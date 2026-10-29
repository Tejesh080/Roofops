import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Keys that reach a hosted system. They live only in the hosted env file (hostedEnvDir()), never in the repository,
 * so nothing working inside the repository picks them up by accident (docs/master-plan.md Task 0.1).
 */
export const HOSTED_ONLY_KEYS = [
  'SUPABASE_DB_URL', 'N8N_API_KEY', 'RECONCILE_TRIGGER_TOKEN', 'REISSUE_DISPATCH_TOKEN', 'LITE_REPLY_WEBHOOK_PASSWORD', 'LITE_LIVE_TEST_TO',
] as const;

/**
 * Loads .env then .env.local (both gitignored) into process.env without
 * printing anything. Secrets are only ever read from the environment.
 * Refuses a file that holds a hosted credential (HOSTED_ONLY_KEYS), naming the key and never its value.
 */
export function loadLocalEnv(cwd = process.cwd()): void {
  for (const f of ['.env', '.env.local']) {
    const path = join(cwd, f);
    if (!existsSync(path)) continue;
    const hosted = Object.keys(parseEnv(readFileSync(path, 'utf8'))).filter((k) => (HOSTED_ONLY_KEYS as readonly string[]).includes(k));
    if (hosted.length) {
      throw new Error(`HOSTED_ENV_INSIDE_REPO: ${f} defines ${hosted.join(', ')}. Hosted credentials live outside the repository: `
        + `move those lines to ${join(hostedEnvDir(cwd), 'hosted.env')} (docs/master-plan.md Task 0.1)`);
    }
    process.loadEnvFile(path);
  }
}

/** Where the hosted env files live: ROOFOPS_ENV_DIR, else ~/.roofops. Never inside the repository. */
export function hostedEnvDir(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const dir = resolve(env.ROOFOPS_ENV_DIR || join(homedir(), '.roofops'));
  const rel = relative(resolve(cwd), dir);
  if (rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..')) {
    throw new Error(`HOSTED_ENV_INSIDE_REPO: the hosted env directory ${dir} is inside ${resolve(cwd)}; set ROOFOPS_ENV_DIR to a folder outside the repository`);
  }
  return dir;
}

export type HostedTarget = 'hosted' | 'staging';

/** Reads <hostedEnvDir()>/<target>.env and adds its keys to process.env (a key already set wins, as with --env-file). */
export function loadHostedEnv(target: HostedTarget = 'hosted', cwd = process.cwd()): NodeJS.Dict<string> {
  const path = join(hostedEnvDir(cwd), `${target}.env`);
  if (!existsSync(path)) throw new Error(`HOSTED_ENV_MISSING: ${path} does not exist (docs/master-plan.md Task 0.1)`);
  const vars = parseEnv(readFileSync(path, 'utf8'));
  for (const [k, v] of Object.entries(vars)) process.env[k] ??= v;
  return vars;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (set it in .env.local)`);
  return v;
}

/**
 * Sets KEY=value lines in the text of an env file, keeping every other line (comments, other keys) as it was.
 * A key that already exists is replaced in place; a new key is appended. Used when a script owns only some keys.
 */
export function mergeEnvFile(existing: string, updates: Record<string, string>): string {
  const lines = existing.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const left = new Map(Object.entries(updates));
  const out = lines.map((line) => {
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key === undefined || !left.has(key)) return line;
    const v = left.get(key)!; left.delete(key);
    return `${key}=${v}`;
  });
  for (const [k, v] of left) out.push(`${k}=${v}`);
  return out.join('\n') + '\n';
}

/** Host only: safe to log. Never log the full URL (it may embed a password). */
export function describeUrl(u: string): string {
  const url = new URL(u);
  return `${url.hostname}:${url.port || '(default)'}${url.pathname}`;
}

export interface HostedDbConfig { url: string; caPem?: string; verified: boolean }

/**
 * The hosted database, from the hosted env file only (a SUPABASE_DB_URL in the shell is ignored). A relative
 * SUPABASE_CA_CERT is read from the env directory.
 */
export function hostedDbConfig(target: HostedTarget = 'hosted', cwd = process.cwd()): HostedDbConfig {
  loadLocalEnv(cwd);
  const vars = loadHostedEnv(target, cwd);
  const url = vars.SUPABASE_DB_URL;
  if (!url) throw new Error(`Missing SUPABASE_DB_URL in ${join(hostedEnvDir(cwd), `${target}.env`)}`);
  const ca = vars.SUPABASE_CA_CERT;
  const caPath = ca && (isAbsolute(ca) ? ca : join(hostedEnvDir(cwd), ca));
  if (caPath && existsSync(caPath)) return { url, caPem: readFileSync(caPath, 'utf8'), verified: true };
  return { url, verified: false };
}

/** The Supabase project a connection string names: the pooler user <role>.<ref>, the direct host db.<ref>.supabase.co, else the host. */
export function supabaseProjectRef(url: string): string {
  const u = new URL(url);
  const user = decodeURIComponent(u.username);
  if (u.hostname.endsWith('.pooler.supabase.com') && user.includes('.')) return user.slice(user.indexOf('.') + 1);
  return /^db\.([a-z0-9]+)\.supabase\.co$/.exec(u.hostname)?.[1] ?? u.hostname;
}

/**
 * A hosted write runs only when its command line names the target: --confirm <Supabase project ref>. Whoever approves
 * the command sees which project it writes to, and no script writes to a hosted database by default or by accident.
 * The errors never print the expected ref.
 */
export function confirmHostedWrite(url: string, argv: readonly string[]): void {
  const i = argv.indexOf('--confirm');
  const given = i >= 0 ? argv[i + 1] : undefined;
  if (!given || given.startsWith('--')) {
    throw new Error('HOSTED_CONFIRM_REQUIRED: this command writes to the hosted database. Re-run it with --confirm <Supabase project ref> (Supabase › Project Settings › General)');
  }
  if (given !== supabaseProjectRef(url)) throw new Error(`HOSTED_CONFIRM_MISMATCH: --confirm ${given} does not name the project in the hosted env file`);
}
