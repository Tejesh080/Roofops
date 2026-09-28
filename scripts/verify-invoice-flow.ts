/**
 * Independent read-back of the HOSTED control layer for one project's invoice flow (owner connection, read-only).
 *   npx tsx scripts/verify-invoice-flow.ts PRJ-2026-0004
 * Prints JSON only: invoices, approvals, outbox, Xero external links, events, exceptions and audit. Never prints connection details.
 */
import { openPostgres } from '../src/db/db.js';
import { hostedDbConfig } from '../src/config/env.js';

const project = process.argv[2] ?? '';
if (!/^PRJ-\d{4}-\d{4}$/.test(project)) throw new Error('usage: verify-invoice-flow.ts PRJ-YYYY-NNNN');

const cfg = hostedDbConfig();
const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
try {
  const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p))[0];
  const all = <T>(sql: string, p: unknown[] = []) => db.query<T>(sql, p);
  const p = await one<{ id: string; status: string; customer_id: string }>(
    `select id, status, customer_id from public.projects where project_number = $1`, [project]);
  if (!p) throw new Error(`project ${project} not found`);
  const invoiceIds = (await all<{ id: string }>(`select id from public.invoices where project_id = $1`, [p.id])).map((r) => r.id);
  const out = {
    project: { number: project, id: p.id, status: p.status },
    pinned_tenant: await one(`select (select value from app_settings where key = 'xero.demo_tenant_id') tenant_id,
                                     (select value from app_settings where key = 'xero.demo_tenant_name') tenant_name`),
    invoices: await all(`select id, invoice_number, invoice_type, status, sync_status, total_inc_gst::text total, gst_amount::text gst,
                                subtotal_ex_gst::text ex_gst, issue_date::text, due_date::text, idempotency_key, approved_at is not null approved
                           from public.invoices where project_id = $1 order by created_at`, [p.id]),
    final_invoice_lines: await all(`select l.description, l.quantity::text, l.line_kind, l.unit_price::text, l.account_code, l.line_amount::text from invoice_lines l
                                      join public.invoices i on i.id = l.invoice_id where i.project_id = $1 and i.invoice_type = 'FINAL'`, [p.id]),
    approvals: await all(`select approval_number, action_type, status, payload_hash, decided_at is not null decided, executed_at is not null executed,
                                 action_payload->>'amount_inc_gst' amount, action_payload->>'gst_amount' gst, action_payload->>'reference' reference,
                                 action_payload->>'xero_contact_name' customer, action_payload->>'due_date' due_date,
                                 action_payload->>'xero_tenant_name' xero_org, decision_reason
                            from approvals where entity_id = $1 order by created_at`, [p.id]),
    outbox: await all(`select topic, idempotency_key, status, attempts, last_error from outbox where aggregate_id = any($1::uuid[]) or aggregate_id = $2 order by created_at`,
                      [invoiceIds, p.id]),
    xero_links: await all(`select entity_type, external_type, external_id, verified_at is not null verified from external_links
                            where provider = 'XERO' and (entity_id = any($1::uuid[]) or entity_id = $2) order by external_type`,
                          [invoiceIds, p.customer_id]),
    workflow_runs: await all(`select workflow_key, status, attempt_count, last_error_class from workflow_runs
                               where entity_id = $1 or entity_id = any($2::uuid[]) order by started_at`, [p.id, invoiceIds]),
    processed_events: await all(`select idempotency_key, status, delivery_count from processed_events
                                  where first_event_id in (select event_id from automation_events where business_reference = $1) or idempotency_key in
                                        (select 'invoice.decision:' || approval_number from approvals where entity_id = $2::uuid) order by first_seen_at`,
                                [project, p.id]),
    automation_events: await all(`select event_key, event_type, status, error_class, metadata->>'reason' reason from automation_events
                                   where business_reference = $1 and event_type like 'invoice.%' order by occurred_at, event_key`, [project]),
    exceptions: await all(`select exception_number, error_class, resolution_status, left(error_message, 160) message from workflow_exceptions
                            where business_reference = $1 order by exception_number`, [project]),
    audit: await all(`select seq, action, actor_type, actor_id, external_reference, left(reason, 140) reason from audit_events
                       where (business_reference = $1 or entity_id = $2 or entity_id = any($3::uuid[])
                              or entity_id in (select id from approvals where entity_id = $2))
                         and occurred_at > now() - interval '1 day' order by seq`, [project, p.id, invoiceIds]),
    audit_chain: (await one<{ v: string | null }>(`select verify_audit_chain()::text v`))!.v ?? 'intact',
  };
  console.log(JSON.stringify(out, null, 2));
} finally {
  await db.close();
}
