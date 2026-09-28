/**
 * npm run db:load                 migrate + import data/normalised into local DATABASE_URL (idempotent)
 * npm run db:reset                drop and rebuild the local schema first (local only)
 * npm run db:load -- --hosted     same, against the hosted Supabase database (SUPABASE_DB_URL in .env.local)
 */
import { openPostgres } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { importBundle } from '../src/import/importer.js';
import { describeUrl, hostedDbConfig } from '../src/config/env.js';

const hosted = process.argv.includes('--hosted');
const reset = process.argv.includes('--reset');

let url: string, caPem: string | undefined;
if (hosted) {
  const cfg = hostedDbConfig();
  url = cfg.url; caPem = cfg.caPem;
  console.log(`target: HOSTED ${describeUrl(url)} (TLS ${cfg.verified ? 'verified against SUPABASE_CA_CERT' : 'encrypted, certificate NOT verified: set SUPABASE_CA_CERT'})`);
} else {
  url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/roofops';
  console.log(`target: local ${describeUrl(url)}`);
}
if (reset && (hosted || !['127.0.0.1', 'localhost', '::1'].includes(new URL(url).hostname))) {
  console.error('Refusing --reset against a non-local database');
  process.exit(1);
}

const db = await openPostgres(url, caPem ? { caPem } : undefined);
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
