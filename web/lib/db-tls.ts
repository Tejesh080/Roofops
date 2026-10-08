import { readFileSync } from 'node:fs';

/**
 * How the dashboard connects to its database. A local database (localhost) is plain TCP. Any other host is TLS with
 * the server certificate VERIFIED against the Supabase root CA, from DASHBOARD_DB_CA_PEM (PEM text, \n-escaped, e.g. on
 * Vercel) or DASHBOARD_DB_CA_CERT (a file path). Without a CA the dashboard refuses to connect: it never sends its
 * database password over an unverified connection. TLS comes only from here: sslmode/ssl* URL parameters are removed,
 * because pg lets them override the ssl option.
 */
export interface DbTarget { connectionString: string; ssl: false | { ca: string; rejectUnauthorized: true } }

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function dashboardDbTarget(connectionString: string, env: Record<string, string | undefined>): DbTarget {
  const url = new URL(connectionString);
  url.search = '';
  if (LOCAL.has(url.hostname)) return { connectionString: url.toString(), ssl: false };
  const ca = env.DASHBOARD_DB_CA_PEM?.replace(/\\n/g, '\n').trim()
    || (env.DASHBOARD_DB_CA_CERT ? readFileSync(env.DASHBOARD_DB_CA_CERT, 'utf8').trim() : '');
  if (!ca.includes('BEGIN CERTIFICATE')) {
    throw new Error('Database certificate cannot be verified: set DASHBOARD_DB_CA_PEM or DASHBOARD_DB_CA_CERT (Supabase root CA)');
  }
  return { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true } };
}
