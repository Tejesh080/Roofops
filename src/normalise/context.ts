import type { Bundle } from '../data/bundle.js';
import type { Row } from '../data/csv.js';

export type ScenarioTag =
  | 'DELAYED_PROJECT' | 'SUPPLIER_ACK_PENDING' | 'MISSING_COMPLIANCE_PHOTOS'
  | 'ACCEPTED_QUOTE_PROJECT_CREATION_FAILED' | 'OVERDUE_INVOICE' | 'SUPPLIER_DELIVERY_DELAY'
  | 'MISSING_INSPECTION_MEASUREMENT' | 'JOB_BEFORE_MATERIALS' | 'UNRESOLVED_AUTOMATION_EXCEPTION';

export function tagsOf(row: Row): Set<string> {
  return new Set((row.edge_case_tags ?? '').split(';').map((t) => t.trim()).filter(Boolean));
}

/** Indexes over a bundle. Scenario tags are merged per project from projects, POs and invoices. */
export class BundleIndex {
  readonly quote = new Map<string, Row>();
  readonly project = new Map<string, Row>();
  readonly supplier = new Map<string, Row>();
  readonly projectTags = new Map<string, Set<string>>();

  constructor(readonly b: Bundle) {
    for (const r of b.quotes.rows) this.quote.set(r.quote_id!, r);
    for (const r of b.projects.rows) this.project.set(r.project_id!, r);
    for (const r of b.suppliers.rows) this.supplier.set(r.supplier_id!, r);
    for (const p of b.projects.rows) this.projectTags.set(p.project_id!, tagsOf(p));
    for (const r of [...b.purchase_orders.rows, ...b.invoices.rows]) {
      for (const t of tagsOf(r)) this.projectTags.get(r.project_id!)?.add(t);
    }
  }

  projectOf(r: Row): Row {
    const p = this.project.get(r.project_id!);
    if (!p) throw new Error(`Unknown project ${r.project_id}`);
    return p;
  }

  acceptedDateOf(project: Row): string {
    const q = this.quote.get(project.quote_id!);
    if (!q?.quote_accepted_date) throw new Error(`Project ${project.project_id} has no accepted quote date`);
    return q.quote_accepted_date;
  }

  hasTag(projectId: string, tag: ScenarioTag): boolean {
    return this.projectTags.get(projectId)?.has(tag) ?? false;
  }
}

export const isCompleted = (p: Row): boolean => p.project_status === 'Completed';
export const isStarted = (p: Row): boolean => Boolean(p.actual_start_date);
export const OPEN_PO = new Set(['Draft', 'Approved', 'Sent', 'Acknowledged']);
export const DELIVERED_PO = new Set(['Delivered', 'Partially Delivered']);
/** Scenarios whose defining fact is "materials arrive after the planned start". */
export const LATE_MATERIALS_TAGS: ScenarioTag[] = ['JOB_BEFORE_MATERIALS', 'SUPPLIER_DELIVERY_DELAY'];
