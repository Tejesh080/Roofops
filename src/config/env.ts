import { existsSync, readFileSync } from 'node:fs';

/**
 * Loads .env then .env.local (both gitignored) into process.env without
 * printing anything. Secrets are only ever read from the environment.
 */
export function loadLocalEnv(): void {
  for (const f of ['.env', '.env.local']) if (existsSync(f)) process.loadEnvFile(f);
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

export function hostedDbConfig(): HostedDbConfig {
  loadLocalEnv();
  const url = requireEnv('SUPABASE_DB_URL');
  const caPath = process.env.SUPABASE_CA_CERT;
  if (caPath && existsSync(caPath)) return { url, caPem: readFileSync(caPath, 'utf8'), verified: true };
  return { url, verified: false };
}
