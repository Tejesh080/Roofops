import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import pg from 'pg';

/** Minimal database port. One connection; PGlite and node-postgres both implement it. */
export interface Db {
  readonly kind: 'pglite' | 'postgres';
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export async function withTransaction<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.exec('begin');
  try {
    const out = await fn();
    await db.exec('commit');
    return out;
  } catch (e) {
    await db.exec('rollback');
    throw e;
  }
}

export async function openPglite(dataDir?: string): Promise<Db> {
  // pgcrypto: staff sign-in checks bcrypt hashes inside the database (as Postgres and Supabase do).
  const lite = new PGlite({ ...(dataDir ? { dataDir } : {}), extensions: { pgcrypto } });
  await lite.waitReady;
  return {
    kind: 'pglite',
    exec: async (sql) => { await lite.exec(sql); },
    query: async <T>(sql: string, params: unknown[] = []) => (await lite.query<T>(sql, params)).rows,
    close: () => lite.close(),
  };
}

export interface PostgresTls {
  /** PEM of the server's root CA. When given, the certificate chain and hostname are fully verified. */
  caPem?: string;
}

/**
 * Local connections (127.0.0.1) use plain TCP. Any other host requires TLS:
 * fully verified when a CA is supplied, otherwise encrypted-but-unverified
 * (reported loudly by callers, never silently).
 */
export async function openPostgres(connectionString: string, tls?: PostgresTls): Promise<Db> {
  const url = new URL(connectionString);
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  url.search = '';   // TLS is configured explicitly below, not via sslmode query params
  const ssl = local ? undefined : tls?.caPem ? { ca: tls.caPem, rejectUnauthorized: true } : { rejectUnauthorized: false };
  const client = new pg.Client({ connectionString: url.toString(), ...(ssl ? { ssl } : {}) });
  await client.connect();
  return {
    kind: 'postgres',
    exec: async (sql) => { await client.query(sql); },
    query: async <T>(sql: string, params: unknown[] = []) =>
      (await client.query(sql, params)).rows as T[],
    close: () => client.end(),
  };
}
