import { randomUUID } from 'node:crypto';
import { openPglite, openPostgres, type Db } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';

export type Target = 'pglite' | 'postgres';

/** PGlite always; real Postgres too when TEST_DATABASE_URL points at a local server. */
export const TARGETS: Target[] = process.env.TEST_DATABASE_URL ? ['pglite', 'postgres'] : ['pglite'];

/**
 * A brand-new empty database. For Postgres, each call creates its own throwaway
 * database (test files run in parallel) and drops it on close.
 */
export async function freshDb(target: Target): Promise<Db> {
  if (target === 'pglite') return openPglite();
  const adminUrl = new URL(process.env.TEST_DATABASE_URL!);
  if (!['127.0.0.1', 'localhost', '::1'].includes(adminUrl.hostname)) throw new Error(`TEST_DATABASE_URL must be local, got ${adminUrl.hostname}`);
  const name = `roofops_t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = await openPostgres(adminUrl.toString());
  await admin.exec(`create database ${name}`);
  await admin.close();
  const url = new URL(adminUrl.toString());
  url.pathname = `/${name}`;
  const db = await openPostgres(url.toString());
  return {
    ...db,
    close: async () => {
      await db.close();
      const a = await openPostgres(adminUrl.toString());
      await a.exec(`drop database if exists ${name} with (force)`);
      await a.close();
    },
  };
}

export async function migratedDb(target: Target): Promise<Db> {
  const db = await freshDb(target);
  await migrate(db);
  return db;
}

/** Numeric/date-safe single-column fetch. */
export async function col(db: Db, sql: string, params: unknown[] = []): Promise<string[]> {
  return (await db.query<{ v: unknown }>(sql, params)).map((r) => String(r.v));
}
