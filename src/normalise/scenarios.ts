import type { Bundle } from '../data/bundle.js';
import { tagsOf } from './context.js';

export interface ScenarioEntry { description: string; records: string[] }
export type ScenarioManifest = Record<string, ScenarioEntry>;

const DESCRIPTIONS: Record<string, string> = {
  DELAYED_PROJECT: 'Active project delayed as of the demo date',
  SUPPLIER_ACK_PENDING: 'Project whose sent PO is still awaiting supplier acknowledgement',
  MISSING_COMPLIANCE_PHOTOS: 'Completed project missing completion/compliance photos',
  ACCEPTED_QUOTE_PROJECT_CREATION_FAILED: 'Accepted quote for which no project was created',
  OVERDUE_INVOICE: 'Issued invoice past its due date and unpaid',
  SUPPLIER_DELIVERY_DELAY: 'Acknowledged supplier delivery lands after the planned start',
  MISSING_INSPECTION_MEASUREMENT: 'Quote whose inspection has no roof measurement',
  JOB_BEFORE_MATERIALS: 'Job scheduled to start before its materials arrive',
  UNRESOLVED_AUTOMATION_EXCEPTION: 'Project tagged with an unresolved automation exception',
  DUPLICATE_CUSTOMER_CANDIDATE: 'Customer record that duplicates another (pair)',
  DUPLICATE_WEBHOOK: 'Webhook delivery blocked as a duplicate + its idempotency ledger entry',
  FAILED_AUTOMATION_EVENT: 'Automation event recorded as failed',
  OPEN_WORKFLOW_EXCEPTION: 'Workflow exception still open',
};

/** Scenario -> source record IDs, read from the planted markers in the bundle. */
export function buildScenarioManifest(b: Bundle): ScenarioManifest {
  const m = new Map<string, Set<string>>();
  const add = (k: string, id: string) => { if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(id); };

  const tagged: [keyof Bundle, string][] = [['quotes', 'quote_id'], ['projects', 'project_id'], ['purchase_orders', 'po_id'], ['invoices', 'invoice_id']];
  for (const [t, key] of tagged) for (const r of b[t].rows) for (const tag of tagsOf(r)) add(tag, r[key]!);
  for (const c of b.customers.rows) {
    if (c.duplicate_candidate_of) { add('DUPLICATE_CUSTOMER_CANDIDATE', c.customer_id!); add('DUPLICATE_CUSTOMER_CANDIDATE', c.duplicate_candidate_of); }
  }
  for (const e of b.project_events.rows) {
    if (e.status === 'duplicate_blocked') add('DUPLICATE_WEBHOOK', e.event_id!);
    if (e.status === 'failed') add('FAILED_AUTOMATION_EVENT', e.event_id!);
  }
  for (const p of b.processed_events.rows) if (!/^EVT-/.test(p.event_key!)) add('DUPLICATE_WEBHOOK', p.event_key!);
  for (const x of b.workflow_exceptions.rows) if (x.resolution_status === 'open') add('OPEN_WORKFLOW_EXCEPTION', x.exception_id!);
  for (const x of b.workflow_exceptions.rows) add(`EXCEPTION_CLASS:${x.error_class}`, x.exception_id!);

  const out: ScenarioManifest = {};
  for (const k of [...m.keys()].sort()) {
    out[k] = { description: DESCRIPTIONS[k] ?? `Workflow exception fixture of class ${k.split(':')[1] ?? k}`, records: [...m.get(k)!].sort() };
  }
  return out;
}
