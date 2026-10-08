/**
 * Ad-hoc query against the HOSTED DB as owner (dev/ops tool). Prints rows only, never connection details.
 *   npx tsx scripts/sql.ts "select ..."
 *   npx tsx scripts/sql.ts -f ops/some-action.sql      (one statement, e.g. an audited CTE)
 *   npx tsx scripts/sql.ts --read-only -f ops/reissue-demo-preflight.sql
 *                                                       (inside a READ ONLY transaction, always rolled back: any write errors)
 */
import { readFileSync } from 'node:fs';
import { openPostgres } from '../src/db/db.js';
import { hostedDbConfig } from '../src/config/env.js';

const readOnly = process.argv[2] === '--read-only';
const args = process.argv.slice(readOnly ? 3 : 2);
const sql = args[0] === '-f' ? readFileSync(args[1] ?? '', 'utf8') : args.join(' ');
const cfg = hostedDbConfig();
const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
try {
  if (readOnly) await db.exec('begin transaction read only');
  console.table(await db.query(sql));
} finally {
  if (readOnly) await db.exec('rollback').catch(() => undefined);
  await db.close();
}
