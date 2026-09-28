/**
 * Read functions over the curated v_dashboard_* views. Pure (the caller supplies `query`), so the same
 * code serves the pages, the copilot tools and the tests. Dates and money come back as text from SQL
 * so every engine and timezone gives the same answer.
 */
export type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

export const PROJECT_NUMBER = /^PRJ-\d{4}-\d{4}$/;

export interface Kpis {
  as_of: string; active_projects: number; projects_at_risk: number; awaiting_materials: number;
  ready_to_invoice: number; awaiting_invoice_approval: number; open_exceptions: number;
}

export interface ProjectRow {
  project_number: string; status: string; is_active: boolean;
  customer_name: string; customer_number: string; customer_type: string; site_address: string; project_manager: string | null;
  quote_number: string; quote_version: number | null; quote_total_inc_gst: number | null; job_type: string | null; accepted_on: string | null;
  planned_start_date: string | null; planned_completion_date: string | null; actual_start_date: string | null; actual_completion_date: string | null;
  risk_level: 'HIGH' | 'LOW'; risk_reasons: string[]; delay_reason: string | null;
  material_status: string; waiting_on_materials: boolean; material_eta: string | null; purchase_orders: number;
  invoice_status: string; invoice_blocker: string | null; invoice_amount_inc_gst: number | null;
  final_invoice_number: string | null; final_invoice_sync: string | null; xero_invoice_id: string | null; xero_invoice_number: string | null;
  pending_approval_number: string | null; outstanding_inc_gst: number; has_overdue_invoice: boolean;
  open_exceptions: number; drive_folder_url: string | null; airtable_record_id: string | null; needs_attention: boolean;
}

const PROJECT_COLUMNS = `
  project_number, status, is_active, customer_name, customer_number, customer_type, site_address, project_manager,
  quote_number, quote_version, quote_total_inc_gst::text, job_type, accepted_on::text,
  planned_start_date::text, planned_completion_date::text, actual_start_date::text, actual_completion_date::text,
  risk_level, risk_reasons, delay_reason, material_status, waiting_on_materials, material_eta::text, purchase_orders::int,
  invoice_status, invoice_blocker, invoice_amount_inc_gst::text, final_invoice_number, final_invoice_sync, xero_invoice_id, xero_invoice_number,
  pending_approval_number, outstanding_inc_gst::text, has_overdue_invoice, open_exceptions::int, drive_folder_url, airtable_record_id, needs_attention`;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toProject(r: Record<string, unknown>): ProjectRow {
  return {
    ...(r as unknown as ProjectRow),
    quote_version: num(r.quote_version), quote_total_inc_gst: num(r.quote_total_inc_gst), invoice_amount_inc_gst: num(r.invoice_amount_inc_gst),
    outstanding_inc_gst: Number(r.outstanding_inc_gst ?? 0), purchase_orders: Number(r.purchase_orders ?? 0), open_exceptions: Number(r.open_exceptions ?? 0),
    risk_reasons: Array.isArray(r.risk_reasons) ? (r.risk_reasons as string[]) : [],
  };
}

export async function getKpis(q: Query): Promise<Kpis> {
  const [r] = await q<Record<string, unknown>>(`select as_of::text, active_projects, projects_at_risk, awaiting_materials, ready_to_invoice,
                                                       awaiting_invoice_approval, open_exceptions from v_dashboard_kpis`);
  const k = r ?? {};
  return {
    as_of: String(k.as_of), active_projects: Number(k.active_projects), projects_at_risk: Number(k.projects_at_risk),
    awaiting_materials: Number(k.awaiting_materials), ready_to_invoice: Number(k.ready_to_invoice),
    awaiting_invoice_approval: Number(k.awaiting_invoice_approval), open_exceptions: Number(k.open_exceptions),
  };
}

export type ProjectFilter = 'all' | 'active' | 'at_risk' | 'awaiting_materials' | 'ready_to_invoice' | 'awaiting_approval' | 'needs_attention' | 'completed';

const FILTERS: Record<ProjectFilter, string> = {
  all: 'true', active: 'is_active', completed: 'not is_active',
  at_risk: `is_active and risk_level = 'HIGH'`, awaiting_materials: 'waiting_on_materials',
  ready_to_invoice: `invoice_status = 'READY_TO_INVOICE'`, awaiting_approval: `invoice_status = 'AWAITING_APPROVAL'`,
  needs_attention: 'needs_attention',
};
export const PROJECT_FILTERS = Object.keys(FILTERS) as ProjectFilter[];

export async function listProjects(q: Query, filter: ProjectFilter = 'all'): Promise<ProjectRow[]> {
  const where = FILTERS[filter] ?? 'true';
  const rows = await q<Record<string, unknown>>(`select ${PROJECT_COLUMNS} from v_dashboard_projects where ${where}
     order by needs_attention desc, is_active desc, (risk_level = 'HIGH') desc, planned_start_date nulls last, project_number`);
  return rows.map(toProject);
}

export async function getProject(q: Query, projectNumber: string): Promise<ProjectRow | null> {
  if (!PROJECT_NUMBER.test(projectNumber)) return null;
  const [r] = await q<Record<string, unknown>>(`select ${PROJECT_COLUMNS} from v_dashboard_projects where project_number = $1`, [projectNumber]);
  return r ? toProject(r) : null;
}

export interface ChecklistItem { kind: 'CHECKLIST' | 'TASK'; stage: string; title: string; status: string; is_required: boolean; done_on: string | null; due_on: string | null; assignee: string | null }
export const getChecklist = (q: Query, p: string) =>
  q<ChecklistItem>(`select kind, stage, title, status, is_required, done_on::text, due_on::text, assignee from v_dashboard_project_checklist
                    where project_number = $1 order by kind desc, sort_order, title`, [p]);

export interface PurchaseOrder { po_number: string; supplier_name: string; status: string; po_date: string | null; expected_delivery_date: string | null;
  total_inc_gst: number; supplier_acknowledged: boolean; ack_overdue: boolean }
export async function getPurchaseOrders(q: Query, p: string): Promise<PurchaseOrder[]> {
  const rows = await q<Record<string, unknown>>(`select po_number, supplier_name, status, po_date::text, expected_delivery_date::text, total_inc_gst::text,
                                                        supplier_acknowledged, coalesce(ack_overdue, false) ack_overdue
                                                 from v_purchase_order_status where project_number = $1 order by po_date, po_number`, [p]);
  return rows.map((r) => ({ ...(r as unknown as PurchaseOrder), total_inc_gst: Number(r.total_inc_gst) }));
}

export interface InvoiceLine { invoice_number: string; status: string; sync_status: string; issue_date: string | null; due_date: string | null;
  total_inc_gst: number; amount_paid: number; outstanding: number; is_overdue: boolean }
export async function getInvoices(q: Query, p: string): Promise<InvoiceLine[]> {
  const rows = await q<Record<string, unknown>>(`select invoice_number, status, sync_status, issue_date::text, due_date::text, total_inc_gst::text,
                                                        amount_paid::text, outstanding::text, is_overdue
                                                 from v_invoice_balances where project_number = $1 order by issue_date nulls last, invoice_number`, [p]);
  return rows.map((r) => ({ ...(r as unknown as InvoiceLine), total_inc_gst: Number(r.total_inc_gst), amount_paid: Number(r.amount_paid), outstanding: Number(r.outstanding) }));
}

export interface TimelineEntry { source: 'EVENT' | 'AUDIT'; occurred_at: string; kind: string; status: string | null; error_class: string | null;
  actor: string | null; reference: string | null; reason: string | null; external_reference: string | null; channel: string | null }
export const getTimeline = (q: Query, p: string, limit = 60) =>
  q<TimelineEntry>(`select source, to_char(occurred_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI') occurred_at, kind, status, error_class,
                           actor, reference, reason, external_reference, channel
                    from v_dashboard_project_timeline where project_number = $1
                    order by v_dashboard_project_timeline.occurred_at desc, source limit $2`, [p, limit]);

export interface ExceptionRow { exception_number: string; project_number: string | null; business_reference: string | null; workflow_key: string | null;
  error_class: string; error_message: string; retryable: boolean; attempt_count: number; resolution_status: string;
  first_failed_at: string; last_attempt_at: string | null; resolution_note: string | null }
export const getExceptions = (q: Query, opts: { openOnly?: boolean; project?: string } = {}) =>
  q<ExceptionRow>(`select exception_number, project_number, business_reference, workflow_key, error_class, error_message, retryable, attempt_count::int,
                          resolution_status, to_char(first_failed_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI') first_failed_at,
                          to_char(last_attempt_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI') last_attempt_at, resolution_note
                   from v_dashboard_exceptions
                   where ($1::boolean is not true or resolution_status in ('OPEN', 'RETRY_QUEUED'))
                     and ($2::text is null or project_number = $2)
                   order by (resolution_status in ('OPEN', 'RETRY_QUEUED')) desc, first_failed_at desc`, [opts.openOnly ?? false, opts.project ?? null]);

/** Result of asking the control layer for an invoice preview (never creates an invoice). */
export interface PreparedInvoice {
  outcome: string; approval_number?: string; message?: string; exception_number?: string;
  preview?: {
    project_number: string; customer_name: string; customer_number: string; quote_number: string; quote_version: number;
    quote_total_inc_gst: number; approved_variations_inc_gst: number; billed_to_date_inc_gst: number; billed_invoices: { invoice: string; status: string; total: number }[];
    amount_inc_gst: number; gst_amount: number; amount_ex_gst: number; reference: string; invoice_date: string; due_date: string;
    xero_contact_name: string; xero_tenant_name: string; lines: { description: string; unit_amount: number }[];
  };
}

/**
 * "Prepare invoice": the same preview-only entry point n8n uses (wf_invoice_prepare). It records the request, checks
 * the project, and stores a hashed preview awaiting a finance approver. Creating the invoice in Xero happens only after
 * that approval, through the existing n8n workflow.
 */
export async function prepareInvoice(q: Query, projectNumber: string, requestId: string, actor: string): Promise<PreparedInvoice> {
  if (!PROJECT_NUMBER.test(projectNumber)) return { outcome: 'INVALID_EVENT', message: `${projectNumber} is not a project number (PRJ-YYYY-NNNN)` };
  const event = { event_id: `dashboard:copilot:${requestId}`, event_type: 'invoice.prepare_requested', source: 'roofops-dashboard',
                  actor_id: actor, occurred_at: new Date().toISOString(), payload: { project_number: projectNumber } };
  const [r] = await q<{ r: PreparedInvoice }>(`select wf_invoice_prepare($1::jsonb, 'dashboard') as r`, [JSON.stringify(event)]);
  return r!.r;
}
