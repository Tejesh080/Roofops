import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../data/bundle.js';
import { withTransaction, type Db } from './db.js';

export const MIGRATIONS_DIR = 'supabase/migrations';

export interface MigrationResult { applied: string[]; skipped: string[] }

/**
 * Applies supabase/migrations/*.sql in filename order, each in its own transaction.
 * A migration whose content changed after being applied is refused (drift), not re-run.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  await db.exec(`create table if not exists schema_migrations (
    version text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  const done = new Map((await db.query<{ version: string; checksum: string }>('select version, checksum from schema_migrations'))
    .map((r) => [r.version, r.checksum]));
  const result: MigrationResult = { applied: [], skipped: [] };
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const checksum = sha256(sql.replace(/\r\n/g, '\n'));
    const prior = done.get(file);
    if (prior) {
      if (prior !== checksum) throw new Error(`Migration ${file} was modified after it was applied (checksum drift)`);
      result.skipped.push(file);
      continue;
    }
    await withTransaction(db, async () => {
      await db.exec(sql);
      await db.query('insert into schema_migrations (version, checksum) values ($1, $2)', [file, checksum]);
    });
    result.applied.push(file);
  }
  return result;
}
