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
import { hostedDbConfig, requireEnv } from '../src/config/env.js';

const mode = process.argv.includes('--dry-run') ? 'observe' : 'repair';
const cfg = hostedDbConfig();
const token = requireEnv('RECONCILE_TRIGGER_TOKEN');
const base = process.env.N8N_BASE_URL ?? 'https://tejesh08.app.n8n.cloud';
const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  const [{ since }] = await db.query<{ since: string }>(`select now()::text since`) as [{ since: string }];
  const res = await fetch(`${base}/webhook/roofops/reconcile`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-roofops-token': token }, body: JSON.stringify({ mode }) });
  if (!res.ok) throw new Error(`n8n did not accept the trigger: HTTP ${res.status}`);
  console.log(`Reconciliation (${mode}) requested; waiting for [RoofOps] 07…`);

  let run: { run_key: string; mode: string; status: string } | undefined;
  for (let i = 0; i < 90 && !(run && run.status !== 'RUNNING'); i += 1) {
    await sleep(2000);
    [run] = await db.query<{ run_key: string; mode: string; status: string }>(`select run_key, mode, status, summary, finished_at from reconciliation_runs where started_at >= $1::timestamptz order by started_at desc limit 1`, [since]);
    if (!run && i === 15) {
      const [recent] = await db.query<{ n: number }>(`select count(*)::int n from reconciliation_runs where started_at > now() - interval '2 minutes'`);
      throw new Error(recent!.n > 0 ? 'Not started: a reconciliation ran less than 2 minutes ago (Airtable quota guard)'
                                    : 'Not started: the operator token was refused, or [RoofOps] 07 is not published');
    }
  }
  if (!run) throw new Error('No run recorded within 3 minutes');
  if (run.status !== 'COMPLETED') throw new Error(`Run ${run.run_key} is ${run.status}; see the n8n execution of [RoofOps] 07`);

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
