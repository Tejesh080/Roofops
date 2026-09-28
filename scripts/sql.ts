/** Ad-hoc read query against the HOSTED DB as owner (dev tool). Prints rows only, never connection details. */
import { openPostgres } from '../src/db/db.js';
import { hostedDbConfig } from '../src/config/env.js';
const cfg = hostedDbConfig();
const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
const sql = process.argv.slice(2).join(' ');
try { console.table(await db.query(sql)); } finally { await db.close(); }
