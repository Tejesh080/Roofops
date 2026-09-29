/**
 * Writes promptfoo/ground-truth.json from the HOSTED database (read-only): every business identifier and money figure
 * RoofOps holds, plus the canonical answers the Copilot regression suite checks. Synthetic data only; no secrets.
 */
import { writeFileSync } from 'node:fs';
import { openPostgres } from '../src/db/db.js';
import { hostedDbConfig } from '../src/config/env.js';

const cfg = hostedDbConfig();
const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
try {
  const col = async (sql: string) => (await db.query<{ v: string }>(sql)).map((r) => r.v);
  const ids = await col(`select project_number v from projects union all select quote_number from quotes union all select po_number from purchase_orders
    union all select invoice_number from invoices union all select 'RO-' || invoice_number from invoices union all select approval_number from approvals
    union all select exception_number from workflow_exceptions`);
  const money = await col(`select distinct round(x, 2)::text v from (
      select total_inc_gst x from quote_versions union all select subtotal_ex_gst from quote_versions union all select gst_amount from quote_versions
      union all select total_inc_gst from invoices union all select gst_amount from invoices union all select subtotal_ex_gst from invoices
      union all select total_inc_gst from purchase_orders union all select subtotal_ex_gst from purchase_orders
      union all select outstanding from v_invoice_balances union all select amount_paid from v_invoice_balances
      union all select invoice_amount_inc_gst from v_dashboard_projects union all select outstanding_inc_gst from v_dashboard_projects
      union all select (action_payload ->> 'amount_inc_gst')::numeric from approvals
      union all select (x2 ->> 'amount_inc_gst')::numeric from projects p, lateral (select invoice_final_preview(p.id) -> 'preview' x2) z
      union all select (x2 ->> 'gst_amount')::numeric from projects p, lateral (select invoice_final_preview(p.id) -> 'preview' x2) z
      union all select (x2 ->> 'amount_ex_gst')::numeric from projects p, lateral (select invoice_final_preview(p.id) -> 'preview' x2) z
      union all select open_po_value_inc_gst from v_executive_kpis union all select overdue_amount from v_executive_kpis
      union all select sum(outstanding) from v_invoice_balances where is_overdue) s where x is not null`);
  const status = Object.fromEntries((await db.query<{ k: string; v: string }>(`select project_number k, status v from projects`)).map((r) => [r.k, r.v]));
  const truth = {
    generated_at: new Date().toISOString(), ids, money, status,
    ready_to_invoice: await col(`select project_number v from v_dashboard_projects where invoice_status = 'READY_TO_INVOICE' order by 1`),
    awaiting_approval: await col(`select project_number v from v_dashboard_projects where invoice_status = 'AWAITING_APPROVAL' order by 1`),
  };
  writeFileSync('promptfoo/ground-truth.json', JSON.stringify(truth, null, 1));
  console.log(`ground truth: ${ids.length} ids, ${money.length} amounts; ready to invoice ${truth.ready_to_invoice.join(', ') || 'none'}; awaiting approval ${truth.awaiting_approval.join(', ') || 'none'}`);
} finally {
  await db.close();
}
