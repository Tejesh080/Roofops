/**
 * npm run reconcile              repair run: replay missed Airtable edits through the normal validation, repair
 *                                RoofOps-owned drift, check Drive + Xero, supervise the Airtable webhooks
 * npm run reconcile -- --dry-run observe only: record drift and findings; no business data is changed anywhere
 *                                (webhook upkeep, i.e. create / refresh / wake a consumer, runs in both modes)
 *
 * Triggers [RoofOps] 07 in n8n (the same path as the daily schedule) with the operator token, then reads the
 * result from Postgres. Never prints connection details or the token.
 */
import { openPostgres } from '../src/db/db.js';
import { hostedDbConfig } from '../src/config/env.js';
import { runReconciliation } from '../src/ops/reconcile-run.js';

const mode = process.argv.includes('--dry-run') ? 'observe' : 'repair';
const cfg = hostedDbConfig();
const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);

try {
  const run = await runReconciliation(db, { mode, log: (s) => { console.log(s); } });

  console.log(`\n${run.run_key}  mode=${run.mode}  status=${run.status}`);
  console.table(await db.query(`select system, checked, drift_found, repaired, needs_person, drift_now, linked from v_consistency`));
  const findings = await db.query(`select system, entity_ref, field, expected, actual, classification, action, left(detail, 80) detail
                                     from v_reconciliation_findings_latest order by system, entity_ref, field`);
  if (findings.length) console.table(findings); else console.log('No drift found.');
  console.table(await db.query(`select h ->> 'url' as webhook, h ->> 'state' as state, h ->> 'hours_left' as hours_left, h ->> 'unread_payloads' as unread
                                  from reconciliation_runs r, jsonb_array_elements(r.summary -> 'webhooks') h where r.run_key = $1`, [run.run_key]));
} finally {
  await db.close();
}
