/**
 * npm run db:load     migrate + import data/normalised into DATABASE_URL (idempotent)
 * npm run db:reset    drop and rebuild the schema first (local databases only)
 */
import { openPostgres } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { importBundle } from '../src/import/importer.js';

const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/roofops';
const reset = process.argv.includes('--reset');
const host = new URL(url).hostname;

if (reset && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.error(`Refusing --reset against non-local host ${host}`);
  process.exit(1);
}

const db = await openPostgres(url);
try {
  if (reset) {
    await db.exec('drop schema if exists staging cascade; drop schema public cascade; create schema public;');
    console.log('schema reset');
  }
  const m = await migrate(db);
  console.log(`migrations applied: ${m.applied.length ? m.applied.join(', ') : 'none'} (skipped ${m.skipped.length})`);
  const r = await importBundle(db);
  if (r.status === 'IMPORTED') {
    console.log(`imported batch ${r.batchId} (dataset ${r.datasetSha256.slice(0, 12)}…)`);
    for (const [t, n] of Object.entries(r.rowCounts)) console.log(`  ${t.padEnd(28)} ${n}`);
  } else {
    console.log(`dataset ${r.datasetSha256.slice(0, 12)}… already imported (batch ${r.batchId}); nothing to do`);
  }
  const [k] = await db.query('select * from v_executive_kpis');
  console.log('executive KPIs as of demo date:', k);
} finally {
  await db.close();
}
