import type { Db } from '../db/db.js';
import { requireEnv } from '../config/env.js';

export interface RunResult { run_key: string; mode: string; status: string }
export type RunScope = { kind: 'invoice_projection_reset'; project: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Asks [RoofOps] 07 in n8n for a reconciliation run (the same path as the daily schedule) with the operator token, and
 * waits for the run it records in Postgres. `scope` limits a repair run to one project's invoice projection. The
 * Airtable quota guard allows one run every 2 minutes: with `waitForQuota`, a refused start is retried once it has
 * passed. Never prints connection details or the token.
 */
export async function runReconciliation(db: Db, o: { mode: 'observe' | 'repair'; scope?: RunScope; waitForQuota?: boolean; log?: (s: string) => void }): Promise<RunResult> {
  const token = requireEnv('RECONCILE_TRIGGER_TOKEN');
  const base = process.env.N8N_BASE_URL ?? 'https://tejesh08.app.n8n.cloud';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [{ since }] = await db.query<{ since: string }>(`select now()::text since`) as [{ since: string }];
    const res = await fetch(`${base}/webhook/roofops/reconcile`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-roofops-token': token }, body: JSON.stringify({ mode: o.mode, scope: o.scope ?? null }) });
    if (!res.ok) throw new Error(`n8n did not accept the trigger: HTTP ${res.status}`);
    o.log?.(`Reconciliation (${o.mode}${o.scope ? `, scoped to ${o.scope.project} invoice fields` : ''}) requested; waiting for [RoofOps] 07…`);

    let run: RunResult | undefined;
    for (let i = 0; i < 90 && !(run && run.status !== 'RUNNING'); i += 1) {
      await sleep(2000);
      [run] = await db.query<RunResult>(`select run_key, mode, status from reconciliation_runs where started_at >= $1::timestamptz
                                          and (scope is null) = $2 order by started_at desc limit 1`, [since, !o.scope]);
      if (!run && i === 15) break;
    }
    if (run) {
      if (run.status !== 'COMPLETED') throw new Error(`Run ${run.run_key} is ${run.status}; see the n8n execution of [RoofOps] 07`);
      return run;
    }
    // Refused by the quota guard if a run had started less than 2 minutes before this request (judged at request time).
    const [recent] = await db.query<{ guarded: boolean; wait: number }>(`select count(*) > 0 guarded,
        greatest(0, ceil(extract(epoch from max(started_at) + interval '2 minutes' - now())))::int wait
        from reconciliation_runs where started_at > $1::timestamptz - interval '2 minutes' and started_at < $1::timestamptz`, [since]);
    if (!recent?.guarded) throw new Error('Not started: the operator token was refused, the scope was refused, or [RoofOps] 07 is not published');
    if (!o.waitForQuota) throw new Error('Not started: a reconciliation ran less than 2 minutes ago (Airtable quota guard)');
    o.log?.(`A reconciliation ran less than 2 minutes ago (Airtable quota guard): retrying in ${String(recent.wait + 5)} s`);
    await sleep((recent.wait + 5) * 1000);
  }
  throw new Error('Not started after waiting for the Airtable quota guard');
}
