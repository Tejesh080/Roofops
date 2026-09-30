/**
 * npm run demo:status   which interview scenarios are READY / ALREADY RUN / NEEDS RESET / BLOCKED
 * npm run demo:reset    withdraw pending demo invoice previews (audited, idempotent), put the demo row's Airtable invoice
 *                       fields back (07 repair run scoped to them, read back and proved), then show status
 * Hosted database (SUPABASE_DB_URL). Never prints connection details. Never deletes anything.
 */
import { openPostgres } from '../src/db/db.js';
import { hostedDbConfig } from '../src/config/env.js';
import { INVOICE_DEMO_PROJECT, demoReset, demoStatus, type DemoStatus } from '../src/demo/scenarios.js';
import { runReconciliation } from '../src/ops/reconcile-run.js';

const cmd = process.argv[2];
if (cmd !== 'status' && cmd !== 'reset') throw new Error('usage: demo.ts status|reset');

const COLOUR: Record<DemoStatus, string> = { READY: '\x1b[32m', 'ALREADY RUN': '\x1b[36m', 'NEEDS RESET': '\x1b[33m', BLOCKED: '\x1b[31m' };
const cfg = hostedDbConfig();
const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
try {
  if (cmd === 'reset') {
    const r = await demoReset(db);
    console.log(r.withdrawn.length ? `Withdrew ${r.withdrawn.length} pending preview(s): ${r.withdrawn.join(', ')} (audited as demo.reset.preview_withdrawn)` : 'Nothing to withdraw in Postgres');
    for (const n of r.notes) console.log(`NOTE: ${n}`);
    // Put the demo row's Airtable invoice fields back: [RoofOps] 07 repair run scoped to them (PATCH, read-back, proof).
    const [inFlight] = await db.query<{ v: boolean }>(`select exists (select 1 from approvals a join projects p on p.id = a.entity_id where p.project_number = $1
        and a.action_type = 'CREATE_INVOICE' and a.status = 'PENDING') or exists (select 1 from invoices i join projects p on p.id = i.project_id
        where p.project_number = $1 and i.invoice_type = 'FINAL' and i.status <> 'VOIDED') v`, [INVOICE_DEMO_PROJECT]);
    if (inFlight?.v) {
      console.log(`Airtable: ${INVOICE_DEMO_PROJECT} has an invoice; its Airtable invoice fields are left as they are`);
    } else {
      const run = await runReconciliation(db, { mode: 'repair', scope: { kind: 'invoice_projection_reset', project: INVOICE_DEMO_PROJECT }, waitForQuota: true,
                                                log: (s) => { console.log(s); } });
      const fixed = await db.query<{ field: string; actual: string }>(`select f.field, left(f.actual, 60) actual from reconciliation_findings f
          join reconciliation_runs r on r.id = f.run_id where r.run_key = $1 and f.action = 'REPAIRED_AIRTABLE' order by f.field`, [run.run_key]);
      console.log(fixed.length
        ? `Airtable: ${INVOICE_DEMO_PROJECT} ${fixed.map((f) => f.field).join(', ')} cleared, read back and proved (${run.run_key})`
        : `Airtable: ${INVOICE_DEMO_PROJECT} invoice fields were already clear (${run.run_key})`);
    }
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
