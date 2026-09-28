/**
 * Independent read-back of the HOSTED control layer for one quote (owner connection, read-only).
 *   npx tsx scripts/verify-quote-flow.ts Q-2026-0041
 * Prints JSON only: counts, statuses, external links, events and audit for the quote's project.
 * Never prints connection details.
 */
import { openPostgres } from '../src/db/db.js';
import { hostedDbConfig } from '../src/config/env.js';

const quote = process.argv[2] ?? '';
if (!/^Q-\d{4}-\d{4}$/.test(quote)) throw new Error('usage: verify-quote-flow.ts Q-YYYY-NNNN');

const cfg = hostedDbConfig();
const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
try {
  const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p))[0];
  const all = <T>(sql: string, p: unknown[] = []) => db.query<T>(sql, p);
  const q = await one<{ id: string; status: string; accepted_on: string | null }>(
    `select id, status, accepted_on::text from quotes where quote_number = $1`, [quote]);
  if (!q) throw new Error(`quote ${quote} not found`);
  const projects = await all<{ id: string; project_number: string; status: string; pm: string }>(
    `select p.id, p.project_number, p.status, e.full_name pm from projects p left join employees e on e.id = p.project_manager_id where p.quote_id = $1`, [q.id]);
  const pid = projects[0]?.id ?? null;
  const out = {
    quote: { number: quote, id: q.id, status: q.status, accepted_on: q.accepted_on },
    projects,
    tasks: pid ? await all(`select task_type, title, due_on::text due_on, dedupe_key from tasks where project_id = $1`, [pid]) : [],
    checklist_items: pid ? Number((await one<{ n: string }>(`select count(*) n from project_checklist_items where project_id = $1`, [pid]))!.n) : 0,
    outbox: pid ? await all(`select topic, status, attempts, last_error from outbox where aggregate_id = $1 order by topic`, [pid]) : [],
    external_links: pid ? await all(`select provider, external_type, external_id, external_url, verified_at is not null verified from external_links where entity_type = 'project' and entity_id = $1 order by provider, external_type`, [pid]) : [],
    workflow_runs: pid ? await all(`select status, attempt_count, last_error_class from workflow_runs where entity_id = $1`, [pid]) : [],
    run_steps: pid ? await all(`select s.seq, s.attempt, s.step_key, s.status, s.error_class, s.http_status, s.retry_delay_ms from workflow_run_steps s join workflow_runs r on r.id = s.run_id where r.entity_id = $1 order by s.seq`, [pid]) : [],
    processed_events: await all(`select idempotency_key, status, delivery_count from processed_events where idempotency_key like $1`, [`quote.accepted:${quote}:%`]),
    automation_events: await all(`select event_key, event_type, status, error_class, metadata->>'reason' reason from automation_events
                                  where business_reference = $1 or entity_id = $2 or entity_id = $3 order by occurred_at, event_key`, [quote, q.id, pid]),
    audit: await all(`select seq, action, actor_id, business_reference, external_reference from audit_events
                      where entity_id in ($1, coalesce($2::uuid, $1)) and occurred_at > now() - interval '1 day' order by seq`, [q.id, pid]),
    exceptions: await all(`select exception_number, error_class, resolution_status, attempt_count, left(error_message, 160) message from workflow_exceptions
                           where business_reference in ($1, coalesce($2, $1)) order by exception_number`, [quote, projects[0]?.project_number ?? null]),
    audit_chain: (await one<{ v: string | null }>(`select verify_audit_chain()::text v`))!.v ?? 'intact',
    totals: await one(`select (select count(*) from projects) projects, (select count(*) from tasks where task_type = 'MATERIAL_REVIEW') material_reviews,
                              (select count(*) from outbox) outbox, (select count(*) from workflow_exceptions) exceptions`),
  };
  console.log(JSON.stringify(out, null, 2));
} finally {
  await db.close();
}
