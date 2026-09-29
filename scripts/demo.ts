/**
 * npm run demo:status   which interview scenarios are READY / ALREADY RUN / NEEDS RESET / BLOCKED
 * npm run demo:reset    withdraw pending demo invoice previews (audited, idempotent), then show status
 * Hosted database (SUPABASE_DB_URL). Never prints connection details. Never deletes anything.
 */
import { openPostgres } from '../src/db/db.js';
import { hostedDbConfig } from '../src/config/env.js';
import { demoReset, demoStatus, type DemoStatus } from '../src/demo/scenarios.js';

const cmd = process.argv[2];
if (cmd !== 'status' && cmd !== 'reset') throw new Error('usage: demo.ts status|reset');

const COLOUR: Record<DemoStatus, string> = { READY: '\x1b[32m', 'ALREADY RUN': '\x1b[36m', 'NEEDS RESET': '\x1b[33m', BLOCKED: '\x1b[31m' };
const cfg = hostedDbConfig();
const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
try {
  if (cmd === 'reset') {
    const r = await demoReset(db);
    console.log(r.withdrawn.length ? `Withdrew ${r.withdrawn.length} pending preview(s): ${r.withdrawn.join(', ')} (audited as demo.reset.preview_withdrawn)` : 'Nothing to reset (already clean)');
    for (const n of r.notes) console.log(`NOTE: ${n}`);
    console.log('');
  }
  const report = await demoStatus(db);
  for (const s of report) {
    console.log(`${s.id}  ${s.name.padEnd(26)} ${COLOUR[s.status]}${s.status.padEnd(12)}\x1b[0m ${s.detail}${s.resettable ? '' : '  [not reset by script]'}`);
  }
  if (report.some((s) => s.status === 'NEEDS RESET')) console.log('\nRun `npm run demo:reset` before rehearsing.');
} finally {
  await db.close();
}
