/**
 * Ad-hoc query against the HOSTED DB as owner (dev/ops tool). Prints rows only, never connection details.
 *   npx tsx scripts/sql.ts "select ..."
 *   npx tsx scripts/sql.ts -f ops/some-action.sql      (one statement, e.g. an audited CTE)
 */
import { readFileSync } from 'node:fs';
import { openPostgres } from '../src/db/db.js';
import { hostedDbConfig } from '../src/config/env.js';

const args = process.argv.slice(2);
const sql = args[0] === '-f' ? readFileSync(args[1] ?? '', 'utf8') : args.join(' ');
const cfg = hostedDbConfig();
const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
try { console.table(await db.query(sql)); } finally { await db.close(); }
