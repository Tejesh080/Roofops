/**
 * Date invariants the RoofOps dataset must satisfy as of the demo date.
 * Written as a specification, independently of rules.ts: the raw bundle
 * violates many of these; the normalised bundle must violate none.
 */
import type { Bundle } from '../data/bundle.js';
import { SUPPLIER_ACK_SLA_BUSINESS_DAYS } from '../config/demo.js';
import { addDays, businessDaysBetween, datePart, type IsoDate } from './dates.js';
import { BundleIndex, DELIVERED_PO, isCompleted, isStarted, LATE_MATERIALS_TAGS, OPEN_PO } from './context.js';

export interface Violation { table: string; recordId: string; message: string }

export function checkDateInvariants(b: Bundle, demo: IsoDate): Violation[] {
  const ix = new BundleIndex(b);
  const out: Violation[] = [];
  const v = (table: string, recordId: string, message: string) => { out.push({ table, recordId, message }); };

  const firstInspection = new Map<string, IsoDate>();
  for (const q of b.quotes.rows) {
    const cur = firstInspection.get(q.customer_id!);
    if (!cur || q.inspection_date! < cur) firstInspection.set(q.customer_id!, q.inspection_date!);
  }
  for (const c of b.customers.rows) {
    const f = firstInspection.get(c.customer_id!);
    if (f && c.created_date! > f) v('customers', c.customer_id!, `customer since ${c.created_date} is after first inspection ${f}`);
    if (c.created_date! > demo) v('customers', c.customer_id!, 'customer since is after demo date');
  }

  for (const q of b.quotes.rows) {
    const chain = [q.inspection_date, q.quote_created_date, q.quote_sent_date, q.quote_accepted_date].filter(Boolean) as string[];
    for (let i = 1; i < chain.length; i++) if (chain[i]! < chain[i - 1]!) v('quotes', q.quote_id!, `lifecycle dates out of order: ${chain.join(' > ')}`);
    if (chain.some((d) => d > demo)) v('quotes', q.quote_id!, 'quote date after demo date');
  }

  for (const p of b.projects.rows) {
    const id = p.project_id!;
    const accepted = ix.acceptedDateOf(p);
    const s = p.planned_start_date!, c = p.planned_completion_date!, a = p.actual_start_date, ac = p.actual_completion_date;
    if (c < s) v('projects', id, 'planned completion before planned start');
    if (s < accepted) v('projects', id, `planned start ${s} before quote accepted ${accepted}`);
    if (a && a < accepted) v('projects', id, 'actual start before quote accepted');
    if (a && a > demo) v('projects', id, 'actual start after demo date');
    if (isCompleted(p)) {
      if (!ac || ac > demo) v('projects', id, 'completed project needs an actual completion on/before demo date');
      continue;
    }
    const delayed = ix.hasTag(id, 'DELAYED_PROJECT');
    const isDelayedByDates = (!a && s < demo) || c < demo;
    if (delayed && !isDelayedByDates) v('projects', id, 'DELAYED_PROJECT scenario but dates show no delay');
    if (!delayed && isDelayedByDates) v('projects', id, `active project delayed by dates without DELAYED_PROJECT scenario (start ${s}, completion ${c})`);
    if (p.project_status === 'In Progress' && !a) v('projects', id, 'In Progress without actual start');
    if (p.project_status !== 'In Progress' && a) v('projects', id, `${p.project_status} project already has an actual start`);
    if (!delayed && p.project_status === 'In Progress' && c < demo) v('projects', id, 'In Progress past planned completion');
  }

  for (const po of b.purchase_orders.rows) {
    const p = ix.projectOf(po);
    const id = po.po_id!, pid = p.project_id!;
    const eta = po.expected_delivery_date!, pod = po.po_date!;
    if (pod < ix.acceptedDateOf(p)) v('purchase_orders', id, 'PO dated before quote acceptance');
    if (pod > demo) v('purchase_orders', id, 'PO dated after demo date');
    if (eta < pod) v('purchase_orders', id, 'delivery date before PO date');
    if (isCompleted(p)) {
      if (eta >= (p.actual_start_date || p.planned_start_date!)) v('purchase_orders', id, 'completed project: delivery date not before job start');
      continue;
    }
    const start = p.planned_start_date!;
    const late = LATE_MATERIALS_TAGS.some((t) => ix.hasTag(pid, t));
    if (late && eta <= start) v('purchase_orders', id, 'late-materials scenario but delivery is before planned start');
    if (!late && !isStarted(p) && eta >= start) v('purchase_orders', id, 'delivery on/after planned start without a late-materials scenario');
    if (DELIVERED_PO.has(po.po_status!) && eta >= demo) v('purchase_orders', id, 'delivered PO with a delivery date on/after demo date');
    if (OPEN_PO.has(po.po_status!) && !late && eta <= demo && !(ix.hasTag(pid, 'DELAYED_PROJECT') && !isStarted(p))) {
      v('purchase_orders', id, 'open PO whose delivery date has passed (unplanned late delivery)');
    }
    if (po.po_status === 'Sent') {
      const overdueAck = businessDaysBetween(pod, demo) > SUPPLIER_ACK_SLA_BUSINESS_DAYS;
      const ackScenario = ix.hasTag(pid, 'SUPPLIER_ACK_PENDING');
      if (overdueAck !== ackScenario) v('purchase_orders', id, `sent ${pod}: ack overdue=${overdueAck} but SUPPLIER_ACK_PENDING=${ackScenario}`);
    }
  }

  for (const inv of b.invoices.rows) {
    const id = inv.invoice_id!;
    const accepted = ix.acceptedDateOf(ix.projectOf(inv));
    const issue = inv.invoice_date!, due = inv.due_date!, paid = inv.paid_date;
    if (issue < accepted) v('invoices', id, `issued ${issue} before quote accepted ${accepted}`);
    if (issue > demo) v('invoices', id, 'issued after demo date');
    if (due < issue) v('invoices', id, 'due before issue');
    if (paid && paid < issue) v('invoices', id, 'paid before issue');
    if (paid && paid >= demo) v('invoices', id, `paid ${paid} on/after demo date`);
    const overdue = inv.invoice_status === 'Sent' && due < demo;
    const scenario = inv.edge_case_tags?.includes('OVERDUE_INVOICE') ?? false;
    if (overdue !== scenario) v('invoices', id, `overdue=${overdue} but OVERDUE_INVOICE=${scenario}`);
  }

  const endOfDemoDay = addDays(demo, 0);
  const stamps: [keyof Bundle, string, string][] = [
    ['project_events', 'event_id', 'occurred_at'], ['site_notes', 'site_note_id', 'created_at'],
    ['documents', 'document_id', 'uploaded_at'], ['workflow_exceptions', 'exception_id', 'created_at'],
    ['workflow_exceptions', 'exception_id', 'last_attempt_at'], ['processed_events', 'event_key', 'processed_at'],
  ];
  for (const [t, key, col] of stamps) {
    for (const r of b[t].rows) if (datePart(r[col]!) > endOfDemoDay) v(t, r[key]!, `${col} after demo date`);
  }
  return out;
}
