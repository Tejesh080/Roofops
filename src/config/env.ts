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
