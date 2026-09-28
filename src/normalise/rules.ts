/**
 * Date normalisation for the canonical RoofOps bundle.
 *
 * Contract:
 *  - Only columns listed in DATE_COLUMNS may change. IDs, names, amounts,
 *    statuses, relationships and scenario tags are never touched (tested).
 *  - A date changes only when it violates an invariant (see invariants.ts);
 *    otherwise it is left exactly as supplied.
 *  - Every change is logged with the rule that caused it.
 *  - Scenario placement is driven by the planted edge_case_tags, never by
 *    hard-coded record IDs.
 *  - Deterministic: same bundle + same demo date => identical output.
 */
import type { Bundle } from '../data/bundle.js';
import { cloneBundle } from '../data/bundle.js';
import type { Row } from '../data/csv.js';
import { SUPPLIER_ACK_SLA_BUSINESS_DAYS } from '../config/demo.js';
import {
  addBusinessDays, addDays, businessDaysBetween, clampDate, diffDays, maxDate, minDate, type IsoDate,
} from './dates.js';
import {
  BundleIndex, DELIVERED_PO, LATE_MATERIALS_TAGS, isCompleted, isStarted, OPEN_PO,
} from './context.js';

export type RuleId =
  | 'D1_CUSTOMER_SINCE_AFTER_FIRST_INSPECTION'
  | 'D2_ACTIVE_SCHEDULE_REANCHORED'
  | 'D3_PO_DATED_BEFORE_ACCEPTANCE'
  | 'D4_PO_ETA_ALIGNED_TO_SCHEDULE'
  | 'D5_PO_SENT_DATE_ALIGNED_TO_ACK_STATUS'
  | 'D6_PO_DATED_AFTER_ETA'
  | 'D7_INVOICE_ISSUED_BEFORE_ACCEPTANCE'
  | 'D8_INVOICE_DUE_BEFORE_ISSUE'
  | 'D9_INVOICE_PAID_BEFORE_ISSUE'
  | 'D10_INVOICE_PAID_ON_OR_AFTER_DEMO_DATE'
  | 'D11_UNPAID_INVOICE_OVERDUE_WITHOUT_SCENARIO';

export interface DateChange {
  table: string;
  recordId: string;
  field: string;
  from: string;
  to: string;
  rule: RuleId;
  reason: string;
}

/** Target start windows (days after the demo date) for active projects that need re-anchoring. */
const STATUS_WINDOWS: Record<string, { firstOffset: number; spacing: number }> = {
  Scheduled: { firstOffset: 2, spacing: 3 },          // crew booked: starts within ~2 weeks
  'Materials Pending': { firstOffset: 9, spacing: 3 }, // waiting on materials: 1–3 weeks out
  Planning: { firstOffset: 16, spacing: 4 },           // still planning: 2–5 weeks out
};

export function normaliseDates(input: Bundle, demoDate: IsoDate): { bundle: Bundle; changes: DateChange[] } {
  const b = cloneBundle(input);
  const ix = new BundleIndex(b);
  const changes: DateChange[] = [];

  const set = (table: string, idField: string, row: Row, field: string, value: string, rule: RuleId, reason: string) => {
    const from = row[field] ?? '';
    if (from === value) return;
    row[field] = value;
    changes.push({ table, recordId: row[idField]!, field, from, to: value, rule, reason });
  };

  // ---- D1 customers: "customer since" cannot be after their first inspection ----
  const firstInspection = new Map<string, IsoDate>();
  for (const q of b.quotes.rows) {
    const cur = firstInspection.get(q.customer_id!);
    if (!cur || q.inspection_date! < cur) firstInspection.set(q.customer_id!, q.inspection_date!);
  }
  for (const c of b.customers.rows) {
    const first = firstInspection.get(c.customer_id!);
    if (first && c.created_date! > first) {
      set('customers', 'customer_id', c, 'created_date', first, 'D1_CUSTOMER_SINCE_AFTER_FIRST_INSPECTION',
        `customer record dated after first inspection (${first}); set to first inspection date`);
    }
  }

  // ---- D2 active project schedules re-anchored to the demo date ----
  const shift = (p: Row, delta: number, reason: string) => {
    if (delta === 0) return;
    for (const f of ['planned_start_date', 'actual_start_date', 'planned_completion_date'] as const) {
      if (p[f]) set('projects', 'project_id', p, f, addDays(p[f], delta), 'D2_ACTIVE_SCHEDULE_REANCHORED', reason);
    }
  };
  const active = [...b.projects.rows].filter((p) => !isCompleted(p)).sort((x, y) => x.project_id!.localeCompare(y.project_id!));
  const ordinal = new Map<string, number>();
  const next = (key: string) => { const n = ordinal.get(key) ?? 0; ordinal.set(key, n + 1); return n; };

  for (const p of active) {
    const id = p.project_id!;
    const start = p.planned_start_date!;
    const delayed = ix.hasTag(id, 'DELAYED_PROJECT');
    const nextWeekScenario = !delayed && (LATE_MATERIALS_TAGS.some((t) => ix.hasTag(id, t)) || ix.hasTag(id, 'SUPPLIER_ACK_PENDING'));

    if (delayed && isStarted(p)) {
      // In progress but past planned completion.
      const target = addDays(demoDate, -4);
      shift(p, diffDays(target, p.planned_completion_date!), 'DELAYED_PROJECT (in progress): planned completion 4 days before demo date');
    } else if (delayed) {
      // Start date has passed without the job starting.
      const target = addDays(demoDate, -(2 + next('delayed-not-started')));
      shift(p, diffDays(target, start), 'DELAYED_PROJECT (not started): planned start already passed as of demo date');
    } else if (nextWeekScenario) {
      const target = addDays(demoDate, 6 + next('next-week-scenario'));
      shift(p, diffDays(target, start), 'materials/supplier scenario: planned start falls in the coming week');
    } else if (p.project_status === 'In Progress') {
      const a = p.actual_start_date!, c = p.planned_completion_date!;
      if (!(a <= demoDate && demoDate <= c)) {
        const target = addDays(demoDate, -Math.floor(diffDays(c, a) / 2));
        shift(p, diffDays(target, a), 'In Progress: job window re-anchored so the demo date falls mid-job');
      }
    } else {
      const w = STATUS_WINDOWS[p.project_status!];
      if (!w) throw new Error(`No schedule window for status '${p.project_status}' (${id})`);
      if (!(start > demoDate && !p.actual_start_date)) {
        const target = addDays(demoDate, w.firstOffset + w.spacing * next(p.project_status!));
        shift(p, diffDays(target, start), `${p.project_status}: planned start moved into the ${p.project_status} window after the demo date`);
      }
    }
  }

  // ---- D3–D6 purchase orders ----
  for (const po of b.purchase_orders.rows) {
    const p = ix.projectOf(po);
    const pid = p.project_id!;
    const accepted = ix.acceptedDateOf(p);
    const lead = Number(ix.supplier.get(po.supplier_id!)?.default_lead_time_days ?? 0);
    const S = (f: string, v: string, rule: RuleId, why: string) => { set('purchase_orders', 'po_id', po, f, v, rule, why); };

    if (po.po_date! < accepted) S('po_date', accepted, 'D3_PO_DATED_BEFORE_ACCEPTANCE', `PO dated before quote acceptance (${accepted})`);

    const eta = po.expected_delivery_date!;
    if (isCompleted(p)) {
      const bound = addDays(p.actual_start_date || p.planned_start_date!, -1);
      if (eta > bound) S('expected_delivery_date', bound, 'D4_PO_ETA_ALIGNED_TO_SCHEDULE', 'completed project: materials must have been due before the job started');
    } else {
      const start = p.planned_start_date!;
      const needBy = addDays(start, -1);
      if (LATE_MATERIALS_TAGS.some((t) => ix.hasTag(pid, t))) {
        if (eta <= start) S('expected_delivery_date', addDays(start, 2), 'D4_PO_ETA_ALIGNED_TO_SCHEDULE', 'scenario: materials arrive after the planned start');
      } else if (DELIVERED_PO.has(po.po_status!)) {
        const upper = minDate(needBy, addDays(demoDate, -1));
        if (eta > upper) S('expected_delivery_date', upper, 'D4_PO_ETA_ALIGNED_TO_SCHEDULE', 'delivered PO: delivery date must be in the past and before the job start');
      } else if (OPEN_PO.has(po.po_status!)) {
        if (ix.hasTag(pid, 'DELAYED_PROJECT') && !isStarted(p)) {
          if (eta > needBy) S('expected_delivery_date', needBy, 'D4_PO_ETA_ALIGNED_TO_SCHEDULE', 'delayed project: materials were due before the (missed) start');
        } else if (isStarted(p)) {
          const hi = maxDate(p.planned_completion_date!, addDays(demoDate, 1));
          const v = clampDate(eta, addDays(demoDate, 1), hi);
          if (v !== eta) S('expected_delivery_date', v, 'D4_PO_ETA_ALIGNED_TO_SCHEDULE', 'open PO on a job in progress: delivery still to come, before planned completion');
        } else {
          const lo = addDays(demoDate, 1), hi = maxDate(needBy, lo);
          if (eta < lo || eta > hi) {
            // Out of window: schedule the drop 2 days before the start (the usual site-delivery lead),
            // rather than clamping every past ETA onto the same day.
            S('expected_delivery_date', clampDate(addDays(start, -2), lo, hi), 'D4_PO_ETA_ALIGNED_TO_SCHEDULE',
              'open PO: delivery still to come, set 2 days before the planned start');
          }
        }
      }
    }

    // D5: sent-date consistent with the planted "awaiting supplier confirmation" status.
    if (!isCompleted(p) && po.po_status === 'Sent') {
      const age = businessDaysBetween(po.po_date!, demoDate);
      const ackPending = ix.hasTag(pid, 'SUPPLIER_ACK_PENDING');
      if (!ackPending && age > SUPPLIER_ACK_SLA_BUSINESS_DAYS) {
        S('po_date', addBusinessDays(demoDate, -1), 'D5_PO_SENT_DATE_ALIGNED_TO_ACK_STATUS',
          'project not flagged as awaiting supplier confirmation: PO sent within the acknowledgement SLA');
      } else if (ackPending && age <= SUPPLIER_ACK_SLA_BUSINESS_DAYS) {
        S('po_date', addBusinessDays(demoDate, -(SUPPLIER_ACK_SLA_BUSINESS_DAYS + 3)), 'D5_PO_SENT_DATE_ALIGNED_TO_ACK_STATUS',
          'SUPPLIER_ACK_PENDING: PO sent longer ago than the acknowledgement SLA');
      }
    }

    // D6: a PO cannot be raised after its own delivery date.
    if (po.po_date! > po.expected_delivery_date!) {
      S('po_date', maxDate(accepted, addDays(po.expected_delivery_date!, -lead)), 'D6_PO_DATED_AFTER_ETA',
        `PO dated after its delivery date; set to delivery date minus supplier lead time (${lead}d)`);
    }
  }

  // ---- D7–D11 invoices ----
  const lastPaidDay = addDays(demoDate, -1);
  for (const inv of b.invoices.rows) {
    const p = ix.projectOf(inv);
    const accepted = ix.acceptedDateOf(p);
    const S = (f: string, v: string, rule: RuleId, why: string) => { set('invoices', 'invoice_id', inv, f, v, rule, why); };
    const origIssue = inv.invoice_date!;
    const terms = Math.max(0, diffDays(inv.due_date!, origIssue));
    const lag = inv.paid_date ? Math.max(0, diffDays(inv.paid_date, origIssue)) : 0;

    if (origIssue < accepted) S('invoice_date', accepted, 'D7_INVOICE_ISSUED_BEFORE_ACCEPTANCE', `invoice dated before quote acceptance (${accepted})`);
    const issue = inv.invoice_date!;
    if (inv.due_date! < issue) S('due_date', addDays(issue, terms), 'D8_INVOICE_DUE_BEFORE_ISSUE', `due date before issue date; original ${terms}-day terms kept`);
    if (inv.paid_date && inv.paid_date < issue) S('paid_date', addDays(issue, lag), 'D9_INVOICE_PAID_BEFORE_ISSUE', `paid before issue date; original ${lag}-day payment lag kept`);
    if (inv.paid_date && inv.paid_date > lastPaidDay) {
      S('paid_date', maxDate(issue, lastPaidDay), 'D10_INVOICE_PAID_ON_OR_AFTER_DEMO_DATE', 'payment dated on/after the demo date; moved to the day before');
    }
    const overdueScenario = inv.edge_case_tags?.includes('OVERDUE_INVOICE') ?? false;
    if (inv.invoice_status === 'Sent' && !overdueScenario && inv.due_date! < demoDate) {
      S('due_date', addDays(demoDate, 7), 'D11_UNPAID_INVOICE_OVERDUE_WITHOUT_SCENARIO', 'unpaid invoice would be overdue without an OVERDUE_INVOICE scenario');
    }
  }

  return { bundle: b, changes };
}
