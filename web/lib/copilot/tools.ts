/**
 * The Operations Copilot's tools. DeepSeek never sees a database credential or SQL: it can only ask
 * for one of these named functions, each returning just the fields it needs, already in business words.
 *
 * Tiers:
 *   GREEN (read)     run immediately
 *   AMBER (prepare)  creates a preview only; nothing leaves RoofOps until a person approves it
 *   RED (commit)     not available to the copilot at all (invoice approval stays with a finance approver
 *                    in the existing Airtable → n8n → Xero workflow)
 */
import {
  PROJECT_FILTERS, PROJECT_NUMBER, getChecklist, getConsistency, getDrift, getExceptions, getInvoices, getKpis, getLatestReconciliation, getProject,
  getPurchaseOrders, getServiceChecks, getTimeline, listProjects, prepareInvoice, type PreparedInvoice, type ProjectFilter, type ProjectRow, type Query,
} from '../queries.ts';
import { SERVICES, consistencyLine, serviceState } from '../health.ts';
import {
  EXCEPTION_KIND, EXCEPTION_STATUS, INVOICE_LINE_STATUS, INVOICE_STATUS, MATERIAL_STATUS, PO_STATUS, PROJECT_STAGE, RISK_REASON,
  actorName, label, outcomeLabel, plainIssue, plainReason, timelineTitle,
} from '../labels.ts';

export type Tier = 'GREEN' | 'AMBER';
/** actor: who asked, for the audit trail: dashboard:copilot:<employee code> for a database-verified staff session. */
export interface ToolContext { query: Query; requestId: string; lastUserMessage: string; actor?: string }
export interface ToolCard { kind: 'invoice_preview'; data: PreparedInvoiceCard }
export interface ToolResult { data: unknown; card?: ToolCard }
export interface PreparedInvoiceCard extends PreparedInvoice { project: string; airtable_record_id: string | null; status_text: string }

interface ToolDef {
  tier: Tier;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

const projectArg = { type: 'object', properties: { project_number: { type: 'string', description: 'Project number, e.g. PRJ-2026-0004' } },
                     required: ['project_number'], additionalProperties: false };

function normaliseProject(v: unknown): string {
  const s = String(v ?? '').trim().toUpperCase();
  const m = /^(?:PRJ-?)?(\d{4})-?(\d{1,4})$/.exec(s) ?? /^(?:PRJ-?)?(\d{1,4})$/.exec(s);
  if (!m) return s;
  return m.length === 3 ? `PRJ-${m[1]}-${m[2]!.padStart(4, '0')}` : `PRJ-2026-${m[1]!.padStart(4, '0')}`;
}

/**
 * Freshness and agreement with Airtable, as facts. The model may only repeat these; it never decides which system is right.
 * RoofOps (Postgres) is canonical; Airtable's last observed value is reported only when it differs.
 */
export function syncOf(p: ProjectRow) {
  if (!p.status_out_of_sync) return { in_sync: true };
  return { in_sync: false, roofops_canonical_status: label(PROJECT_STAGE, p.status).text, airtable_currently_reports: p.airtable_status_seen,
           airtable_seen_at: p.airtable_status_seen_at, last_reconciliation: p.last_reconciled_at ?? 'never',
           what_happens_next: 'The Airtable change is checked against the business rules at the next sync; RoofOps keeps its status until then.' };
}
export const freshness = (p: ProjectRow) => ({ canonical_source: 'postgres', status_updated_at: p.status_changed_at, last_reconciled_at: p.last_reconciled_at,
  verified: p.last_reconciled_at !== null && !p.status_out_of_sync && p.drift_fields === 0 });

const brief = (p: ProjectRow) => ({
  project: p.project_number, customer: p.customer_name, stage: label(PROJECT_STAGE, p.status).text,
  ...(p.is_active ? { scheduled_start: p.planned_start_date, planned_finish: p.planned_completion_date }
                  : { actually_finished: p.actual_completion_date }),
  ...(p.invoice_amount_inc_gst !== null && p.invoice_status !== 'NOT_READY' ? { invoice_amount_inc_gst: p.invoice_amount_inc_gst } : {}),
  materials: label(MATERIAL_STATUS, p.material_status).text, invoice: label(INVOICE_STATUS, p.invoice_status).text,
  at_risk: p.is_active && p.risk_level === 'HIGH', risk_reasons: p.risk_reasons.map((r) => RISK_REASON[r] ?? r),
  open_issues: p.open_exceptions,
  ...(p.status_out_of_sync ? { airtable_sync: syncOf(p) } : {}),
});

export const TOOLS: Record<string, ToolDef> = {
  business_overview: {
    tier: 'GREEN',
    description: "Headline numbers for the business today: active projects, projects at risk, awaiting materials, ready to invoice, invoices awaiting approval, open automation issues, and today's date.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_a, { query }) => ({ data: await getKpis(query) }),
  },

  list_projects: {
    tier: 'GREEN',
    description: 'List projects in one group: at_risk, awaiting_materials, ready_to_invoice, awaiting_approval, active or completed. '
      + 'For "what needs attention today" use what_needs_attention_today instead (it also covers quotes, issues and payments).',
    parameters: { type: 'object', properties: { group: { type: 'string', enum: PROJECT_FILTERS.filter((f) => f !== 'all' && f !== 'needs_attention') } }, required: ['group'], additionalProperties: false },
    run: async (a, { query }) => {
      const group = (PROJECT_FILTERS.includes(a.group as ProjectFilter) ? a.group : 'active') as ProjectFilter;
      const rows = await listProjects(query, group);
      return { data: { group, count: rows.length, projects: rows.slice(0, 30).map(brief) } };
    },
  },

  what_needs_attention_today: {
    tier: 'GREEN',
    description: 'Everything that needs a person today: at-risk jobs with reasons, open automation issues, invoices waiting for approval, jobs ready to invoice, over-billed jobs, overdue payments.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_a, { query }) => {
      const [k, rows, exc] = await Promise.all([getKpis(query), listProjects(query, 'all'), getExceptions(query, { openOnly: true })]);
      return { data: {
        today: k.as_of,
        at_risk: rows.filter((p) => p.is_active && p.risk_level === 'HIGH').map(brief),
        invoices_awaiting_approval: rows.filter((p) => p.invoice_status === 'AWAITING_APPROVAL').map((p) => ({ project: p.project_number, customer: p.customer_name, amount_inc_gst: p.invoice_amount_inc_gst })),
        ready_to_invoice: rows.filter((p) => p.invoice_status === 'READY_TO_INVOICE').map((p) => ({ project: p.project_number, customer: p.customer_name, amount_inc_gst: p.invoice_amount_inc_gst,
                                                                                                    state: 'not prepared yet' })),
        over_billed: rows.filter((p) => p.invoice_status === 'OVER_BILLED').map((p) => ({ project: p.project_number, customer: p.customer_name,
          over_by_inc_gst: Number(/over by ([0-9]+(?:\.[0-9]+)?)/.exec(p.invoice_blocker ?? '')?.[1] ?? NaN), detail: p.invoice_blocker })),
        overdue_payments: rows.filter((p) => p.has_overdue_invoice).map((p) => ({ project: p.project_number, customer: p.customer_name, outstanding_inc_gst: p.outstanding_inc_gst })),
        open_automation_issues: exc.map((e) => ({ project_or_quote: e.project_number ?? e.business_reference,
                                                   status: label(EXCEPTION_STATUS, e.resolution_status).text,
                                                   what: EXCEPTION_KIND[e.error_class] ?? e.error_class, detail: plainIssue(e.error_message), since: e.first_failed_at })),
      } };
    },
  },

  get_project: {
    tier: 'GREEN',
    description: 'Full picture of one project: customer, quote, stage, dates, why it is (or is not) at risk, materials and purchase orders, checklist, invoice status incl. Xero, open issues.',
    parameters: projectArg,
    run: async (a, { query }) => {
      const n = normaliseProject(a.project_number);
      const p = await getProject(query, n);
      if (!p) return { data: { error: `No project ${n}` } };
      const [pos, inv, checklist, exc] = await Promise.all([getPurchaseOrders(query, n), getInvoices(query, n), getChecklist(query, n), getExceptions(query, { project: n, openOnly: true })]);
      return { data: {
        ...brief(p), site: p.site_address, project_manager: p.project_manager,
        quote: { number: p.quote_number, version: p.quote_version, total_inc_gst: p.quote_total_inc_gst, job: p.job_type, accepted_on: p.accepted_on },
        actual_start: p.actual_start_date, actual_finish: p.actual_completion_date, delay_note: p.delay_reason,
        purchase_orders: pos.map((o) => ({ po: o.po_number, supplier: o.supplier_name, status: label(PO_STATUS, o.status).text, expected_delivery: o.expected_delivery_date,
                                            total_inc_gst: o.total_inc_gst, supplier_confirmation_overdue: o.ack_overdue })),
        invoice_detail: { status: label(INVOICE_STATUS, p.invoice_status).text, why_not_ready: p.invoice_blocker, amount_inc_gst: p.invoice_amount_inc_gst,
                          xero_invoice_number: p.xero_invoice_number, xero_invoice_id: p.xero_invoice_id, awaiting_approval: p.pending_approval_number,
                          invoices: inv.map((i) => ({ invoice: i.invoice_number, status: label(INVOICE_LINE_STATUS, i.status).text, total_inc_gst: i.total_inc_gst,
                                                     owed_by_customer: ['ISSUED', 'PARTIALLY_PAID'].includes(i.status) ? i.outstanding : 0,
                                                     ...(['DRAFT', 'APPROVED', 'PENDING_APPROVAL'].includes(i.status) ? { note: 'not sent to the customer yet' } : {}),
                                                     overdue: i.is_overdue })) },
        checklist: checklist.map((c) => ({ item: c.title, status: c.status === 'DONE' ? 'done' : c.status.toLowerCase(), due: c.due_on })),
        google_drive_folder: p.drive_folder_url ? 'yes' : 'none',
        airtable_sync: syncOf(p), _meta: freshness(p),
        open_issues: exc.map((e) => ({ id: e.exception_number, what: EXCEPTION_KIND[e.error_class] ?? e.error_class, detail: plainIssue(e.error_message) })),
      } };
    },
  },

  get_project_history: {
    tier: 'GREEN',
    description: 'What happened to a project, newest first: quote acceptance, automation steps, duplicates safely ignored, retries, approvals, Xero, payments.',
    parameters: projectArg,
    run: async (a, { query }) => {
      const n = normaliseProject(a.project_number);
      const [t, p] = await Promise.all([getTimeline(query, n, 40), getProject(query, n)]);
      if (!t.length || !p) return { data: { error: `No history for ${n}` } };
      return { data: { project: n,
        where_it_stands_now: { ...brief(p), xero_invoice_number: p.xero_invoice_number, final_invoice: p.final_invoice_number,
                               final_invoice_amount_inc_gst: p.final_invoice_number ? p.invoice_amount_inc_gst : null },
        events: t.map((e) => ({ when: e.occurred_at, what: timelineTitle(e.kind), by: actorName(e.actor, e.channel),
                                                           outcome: outcomeLabel(e.kind, e.status).text, note: plainReason(e.reason) })) } };
    },
  },

  system_health: {
    tier: 'GREEN',
    description: 'Are the connected systems healthy and in sync? Services (database, Airtable, change alerts, automation engine, Google Drive, Xero, DeepSeek), '
      + 'how many records agree between RoofOps and Airtable / Drive / Xero, anything out of sync, and when the last full check ran.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_a, { query }) => {
      const [checks, cons, drift, run] = await Promise.all([getServiceChecks(query), getConsistency(query), getDrift(query), getLatestReconciliation(query)]);
      return { data: {
        services: SERVICES.map((d) => { const c = checks.find((x) => x.service === d.service); return { service: d.name, state: serviceState(c, d), last_checked: c?.checked_at ?? 'never' }; }),
        consistency: cons.map((c) => ({ system: c.system === 'GOOGLE_DRIVE' ? 'Google Drive' : c.system === 'XERO' ? 'Xero' : 'Airtable', ...consistencyLine(c) })),
        out_of_sync_now: drift.slice(0, 20).map((d) => ({ record: d.business_key, field: d.field, roofops: d.canonical_value, airtable: d.airtable_value, seen: d.observed_at })),
        last_full_check: run ? { at: run.finished_at, mode: run.mode === 'observe' ? 'check only' : 'check and repair', findings: run.findings, need_a_person: run.needs_person } : 'never',
      } };
    },
  },

  list_open_issues: {
    tier: 'GREEN',
    description: 'Open automation issues (things the system stopped safely and needs a person for), with plain-English reasons.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_a, { query }) => ({ data: (await getExceptions(query, { openOnly: true })).map((e) => ({
      id: e.exception_number, project_or_quote: e.project_number ?? e.business_reference, status: label(EXCEPTION_STATUS, e.resolution_status).text,
      what: EXCEPTION_KIND[e.error_class] ?? e.error_class, detail: plainIssue(e.error_message), attempts: e.attempt_count, since: e.first_failed_at })) }),
  },

  prepare_invoice: {
    tier: 'AMBER',
    description: 'Prepare (preview only) the final invoice for a completed project. Use ONLY when the user explicitly asks to prepare/create/raise an invoice. '
      + 'It never creates the invoice: it returns the amount and details and waits for a finance approver.',
    parameters: projectArg,
    run: async (a, { query, requestId, lastUserMessage, actor }) => {
      if (!/invoice/i.test(lastUserMessage) || !/\b(prepare|create|raise|draft|make|generate|bill)\b/i.test(lastUserMessage)) {
        return { data: { refused: 'Invoices are only prepared when you explicitly ask, e.g. "Prepare invoice for PRJ-2026-0005".' } };
      }
      const n = normaliseProject(a.project_number);
      const p = await getProject(query, n);
      if (!p) return { data: { error: `No project ${n}` } };
      // Don't file a rejection for something we can already explain: say why it isn't ready.
      if (p.status !== 'COMPLETED' || ['NOT_READY', 'FULLY_INVOICED', 'OVER_BILLED', 'PAYMENT_OVERDUE', 'PROGRESS_INVOICED', 'NOT_YET_DUE'].includes(p.invoice_status)) {
        return { data: { project: n, prepared: false, invoice_status: label(INVOICE_STATUS, p.invoice_status).text,
                         reason: p.status === 'CANCELLED' ? `${n} is cancelled; a cancelled job is never final-invoiced (earlier invoices stay as they are)`
                           : p.invoice_blocker ?? (p.is_active ? `${n} is still ${label(PROJECT_STAGE, p.status).text.toLowerCase()}; only completed jobs get a final invoice` : 'Nothing left to invoice') } };
      }
      const r = await prepareInvoice(query, n, requestId, actor ?? 'dashboard:copilot');
      const status_text = r.outcome === 'PREVIEW_READY' ? 'Prepared: awaiting approval'
        : r.outcome === 'ALREADY_PENDING' ? 'Already prepared: awaiting approval'
        : r.outcome === 'ALREADY_INVOICED' ? 'Already invoiced: nothing new prepared' : 'Not prepared';
      const card: ToolCard = { kind: 'invoice_preview', data: { ...r, project: n, airtable_record_id: p.airtable_record_id, status_text } };
      const pv = r.preview;
      return { card, data: {
        project: n, outcome: status_text, approval_reference: r.approval_number ?? null, reason: r.message ?? null,
        requires_human_approval: r.outcome === 'PREVIEW_READY' || r.outcome === 'ALREADY_PENDING',
        how_it_gets_approved: 'A finance approver approves it in Airtable: on the project row, set Invoice Action → "Prepare Xero draft invoice" to show this same preview there (no new approval), check it, then set Invoice Action → "Approve Xero draft invoice". An Approve only ever approves the preview shown on that row. RoofOps then creates ONE draft invoice in the Xero Demo Company and checks it. Nothing has been sent to Xero yet.',
        preview: pv ? { customer: pv.customer_name, amount_inc_gst: pv.amount_inc_gst, gst: pv.gst_amount, amount_ex_gst: pv.amount_ex_gst,
                        basis: `quote ${pv.quote_number} v${pv.quote_version} ${pv.quote_total_inc_gst} + variations ${pv.approved_variations_inc_gst} - already invoiced ${pv.billed_to_date_inc_gst}`,
                        reference: pv.reference, due_date: pv.due_date, xero_organisation: pv.xero_tenant_name } : null,
      } };
    },
  },
};

export function toolSchemas() {
  return Object.entries(TOOLS).map(([name, t]) => ({ type: 'function' as const, function: { name, description: t.description, parameters: t.parameters } }));
}
