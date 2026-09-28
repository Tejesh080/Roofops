import { PGlite } from '@electric-sql/pglite';
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
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  await lite.waitReady;
  return {
    kind: 'pglite',
    exec: async (sql) => { await lite.exec(sql); },
    query: async <T>(sql: string, params: unknown[] = []) => (await lite.query<T>(sql, params)).rows,
    close: () => lite.close(),
  };
}

export async function openPostgres(connectionString: string): Promise<Db> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return {
    kind: 'postgres',
    exec: async (sql) => { await client.query(sql); },
    query: async <T>(sql: string, params: unknown[] = []) =>
      (await client.query(sql, params)).rows as T[],
    close: () => client.end(),
  };
}
