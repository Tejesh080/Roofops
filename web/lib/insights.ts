/**
 * Business-facing interpretations of the facts in the dashboard views: short risk labels and severity,
 * the per-project health strip, the "needs attention today" list, and plain descriptions of automation
 * issues. Pure presentation logic over rows the database already derived.
 */
import type { ExceptionRow, ProjectRow, PurchaseOrder } from './queries.ts';
import { INVOICE_STATUS, label, type Tone } from './labels.ts';

export const RISK_SHORT: Record<string, string> = {
  START_DATE_PASSED: 'Start date passed', PAST_PLANNED_COMPLETION: 'Past planned finish', SUPPLIER_ACK_OVERDUE: 'Supplier confirmation overdue',
  MATERIALS_DUE_AFTER_START: 'Materials arrive after start', SUPPLIER_DELIVERY_AFTER_START: 'Delivery after scheduled start', PM_FLAGGED: 'Flagged by project manager',
};
const RED = new Set(['START_DATE_PASSED', 'PAST_PLANNED_COMPLETION', 'SUPPLIER_ACK_OVERDUE']);
export const riskSeverity = (code: string): 'high' | 'medium' => (RED.has(code) ? 'high' : 'medium');
export const projectSeverity = (p: ProjectRow): 'high' | 'medium' => (p.risk_reasons.some((r) => RED.has(r)) ? 'high' : 'medium');

export interface Health { label: string; value: string; tone: Tone }

export function healthStrip(p: ProjectRow, issues: ExceptionRow[]): Health[] {
  const has = (c: string) => p.risk_reasons.includes(c);
  const schedule: Health = !p.is_active ? { label: 'Schedule', value: 'Complete', tone: 'good' }
    : has('START_DATE_PASSED') || has('PAST_PLANNED_COMPLETION') ? { label: 'Schedule', value: 'Delayed', tone: 'bad' }
    : p.planned_start_date ? { label: 'Schedule', value: 'On schedule', tone: 'good' } : { label: 'Schedule', value: 'Not scheduled yet', tone: 'neutral' };
  const materials: Health = !p.is_active ? { label: 'Materials', value: 'Complete', tone: 'good' }
    : p.material_status === 'CONFIRMATION_OVERDUE' || has('MATERIALS_DUE_AFTER_START') || has('SUPPLIER_DELIVERY_AFTER_START') ? { label: 'Materials', value: 'At risk', tone: 'bad' }
    : p.material_status === 'REVIEW_PENDING' ? { label: 'Materials', value: 'Review pending', tone: 'warn' }
    : p.waiting_on_materials ? { label: 'Materials', value: 'Waiting on delivery', tone: 'info' }
    : p.material_status === 'NOT_ORDERED' ? { label: 'Materials', value: 'Not ordered yet', tone: 'neutral' } : { label: 'Materials', value: 'Ready', tone: 'good' };
  const inv = label(INVOICE_STATUS, p.invoice_status);
  const finance: Health = { label: 'Finance', value: inv.text.replace(/: needs attention$/, ''), tone: inv.tone };
  const open = issues.filter((e) => e.resolution_status === 'OPEN' || e.resolution_status === 'RETRY_QUEUED').length;
  const automation: Health = open ? { label: 'Automation', value: `${open} issue${open > 1 ? 's' : ''} to review`, tone: 'bad' }
    : issues.length ? { label: 'Automation', value: 'Recovered', tone: 'good' } : { label: 'Automation', value: 'Healthy', tone: 'good' };
  return [schedule, materials, finance, automation];
}

/** One actionable sentence about the purchase orders behind a risk, if there is one. */
export function materialsAction(p: ProjectRow, pos: PurchaseOrder[], fmtDate: (d: string | null) => string): string | null {
  const overdue = pos.find((o) => o.ack_overdue);
  if (overdue) return `Supplier confirmation for ${overdue.po_number} (${overdue.supplier_name}) is outstanding; delivery was expected ${fmtDate(overdue.expected_delivery_date)}.`;
  const late = pos.find((o) => o.status !== 'DELIVERED' && o.expected_delivery_date && p.planned_start_date && o.expected_delivery_date > p.planned_start_date);
  if (late) return `${late.po_number} from ${late.supplier_name} is due ${fmtDate(late.expected_delivery_date)}, after the planned start of ${fmtDate(p.planned_start_date)}.`;
  return null;
}

export interface AttentionItem { project: string; customer: string; severity: 'high' | 'medium'; summary: string; kind: 'risk' | 'issue' | 'approval' | 'payment' }

/** "What needs me today?": the few items worth a business owner's attention, most serious first. */
export function attentionToday(rows: ProjectRow[], issues: ExceptionRow[], max = 5): AttentionItem[] {
  const risk = rows.filter((p) => p.is_active && p.risk_level === 'HIGH')
    .map((p): AttentionItem => ({ project: p.project_number, customer: p.customer_name, severity: projectSeverity(p), kind: 'risk',
      summary: [...p.risk_reasons].sort((a, b) => Number(RED.has(b)) - Number(RED.has(a))).map((r) => RISK_SHORT[r] ?? r).join(' · ') }))
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1) || b.summary.split('·').length - a.summary.split('·').length);
  const approvals = rows.filter((p) => p.invoice_status === 'AWAITING_APPROVAL').map((p): AttentionItem => ({
    project: p.project_number, customer: p.customer_name, severity: 'medium', kind: 'approval',
    summary: `Invoice ${p.invoice_amount_inc_gst?.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' }) ?? ''} awaiting finance approval` }));
  const issueItems = issues.filter((e) => e.project_number && (e.resolution_status === 'OPEN' || e.resolution_status === 'RETRY_QUEUED'))
    .map((e): AttentionItem => ({ project: e.project_number!, customer: rows.find((r) => r.project_number === e.project_number)?.customer_name ?? '',
      severity: 'medium', kind: 'issue', summary: describeIssue(e).title }));
  return [...risk, ...approvals, ...issueItems].slice(0, max);
}

/** Business language first; the technical class and reference are for "Technical details". */
export function describeIssue(e: Pick<ExceptionRow, 'error_class' | 'error_message' | 'attempt_count'>): { title: string; explanation: string } {
  const m = e.error_message;
  switch (e.error_class) {
    case 'SERVICE_UNAVAILABLE':
      return /drive/i.test(m) ? { title: 'Google Drive was temporarily unavailable', explanation: `RoofOps tried ${e.attempt_count} times, then stopped safely instead of risking duplicate folders.` }
        : { title: 'A connected service was unavailable', explanation: 'RoofOps stopped safely and waited for a person.' };
    case 'MISSING_DOCUMENT':
      return { title: 'Completion paperwork is missing', explanation: /photos/i.test(m) ? 'Compliance photos must be uploaded before the final invoice can be prepared.' : 'A required document is missing, so the next step was held back.' };
    case 'INVALID_STATE':
      if (/quote .* is LOST/i.test(m)) return { title: 'A lost quote was marked accepted', explanation: 'RoofOps refused to create a project because the quote had already been marked lost.' };
      if (/only a COMPLETED project/i.test(m)) return { title: 'Invoice requested before the job was finished', explanation: 'Only completed jobs get a final invoice, so nothing was prepared.' };
      if (/invoice before project approval/i.test(m)) return { title: 'Invoice attempted too early', explanation: 'The project had not been approved yet, so no invoice was created.' };
      return { title: 'Action not allowed yet', explanation: 'RoofOps stopped safely because the record was not in the right state.' };
    case 'TIMEOUT': return { title: "Supplier system didn't respond", explanation: 'RoofOps stopped safely; a person needs to retry once the supplier system is back.' };
    case 'SCHEMA_MISMATCH': return { title: 'Supplier information was incomplete', explanation: 'RoofOps stopped safely because a required supplier field was missing.' };
    case 'DUPLICATE_EVENT': return { title: 'Duplicate message ignored', explanation: 'The same message arrived twice; RoofOps acted on it once.' };
    case 'RATE_LIMITED': return { title: 'Airtable asked RoofOps to slow down', explanation: 'RoofOps waited and tried again automatically.' };
    case 'VALIDATION_ERROR': return { title: 'Required information was missing', explanation: /measurement/i.test(m) ? 'A roof measurement was missing, so materials could not be ordered.' : 'Something required was missing, so nothing was changed.' };
    case 'AUTH_FAILURE': return { title: 'A connection needed re-authorising', explanation: 'An integration login expired; it was reconnected.' };
    case 'AMBIGUOUS_WRITE': return { title: 'Unclear whether a save went through', explanation: 'RoofOps checked the other system before retrying, so nothing was duplicated.' };
    case 'PERMISSION_DENIED': return { title: 'Blocked an action that needs approval', explanation: 'The assistant asked for an action only a person may take; it was blocked.' };
    case 'ARITHMETIC_MISMATCH': return { title: "Supplier totals didn't add up", explanation: 'The supplier total did not match RoofOps’ own calculation, so it was held for review.' };
    case 'RECONCILIATION_MISMATCH': return { title: 'Two systems disagreed', explanation: 'An invoice status in another system differed from RoofOps; it was reconciled.' };
    case 'NOT_FOUND': return { title: 'Record not found', explanation: 'The referenced record does not exist, so nothing was changed.' };
    default: return { title: 'Automation stopped safely', explanation: 'RoofOps paused this step for a person to review.' };
  }
}
