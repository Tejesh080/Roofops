import 'server-only';
import pg from 'pg';
import type { Query } from './queries.ts';

/**
 * The dashboard's only database connection: the roofops_web login (member of roofops_dashboard),
 * which can read the v_dashboard_* views and request an invoice preview. Nothing else.
 * The URL lives in web/.env.local (server-side only; never NEXT_PUBLIC_).
 */
pg.types.setTypeParser(1082, (v: string) => v);  // DATE stays 'YYYY-MM-DD' (no timezone drift)

const globalForPool = globalThis as unknown as { roofopsPool?: pg.Pool };

function pool(): pg.Pool {
  if (!globalForPool.roofopsPool) {
    const connectionString = process.env.DASHBOARD_DATABASE_URL;
    if (!connectionString) throw new Error('DASHBOARD_DATABASE_URL is not set (run scripts/provision-dashboard-role.ts)');
    globalForPool.roofopsPool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 4, idleTimeoutMillis: 30_000 });
  }
  return globalForPool.roofopsPool;
}

export const query: Query = async (sql, params = []) => (await pool().query(sql, params)).rows as never;
