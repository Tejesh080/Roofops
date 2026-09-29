/**
 * Business-facing words for the codes the database uses. Presentation only: no state lives here.
 * Audience: a roofing business owner, so no automation jargon.
 */
export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';
export interface Label { text: string; tone: Tone }

const L = (text: string, tone: Tone): Label => ({ text, tone });

export const PROJECT_STAGE: Record<string, Label> = {
  PLANNING: L('Planning', 'neutral'),
  MATERIALS_PENDING: L('Waiting on materials', 'warn'),
  SCHEDULED: L('Scheduled', 'info'),
  IN_PROGRESS: L('On site', 'info'),
  COMPLETED: L('Completed', 'good'),
  CLOSED: L('Closed', 'neutral'),
  CANCELLED: L('Cancelled', 'neutral'),
};

export const MATERIAL_STATUS: Record<string, Label> = {
  JOB_COMPLETE: L('Job complete', 'neutral'),
  REVIEW_PENDING: L('Material review pending', 'warn'),
  NOT_ORDERED: L('Not ordered yet', 'neutral'),
  CONFIRMATION_OVERDUE: L("Supplier hasn't confirmed", 'bad'),
  DELIVERED: L('Delivered', 'good'),
  PART_DELIVERED: L('Part delivered', 'info'),
  AWAITING_CONFIRMATION: L('Ordered, awaiting supplier', 'warn'),
  ORDER_IN_PREPARATION: L('Order being prepared', 'neutral'),
  CONFIRMED: L('Confirmed by supplier', 'good'),
};

export const INVOICE_STATUS: Record<string, Label> = {
  XERO_DRAFT_CREATED: L('Draft invoice in Xero', 'good'),
  CREATING_IN_XERO: L('Creating in Xero', 'info'),
  CHECKING_WITH_XERO: L('Checking with Xero', 'warn'),
  XERO_FAILED_SAFELY: L('Xero failed safely: needs attention', 'bad'),
  FINAL_INVOICED: L('Final invoice raised', 'good'),
  AWAITING_APPROVAL: L('Awaiting approval', 'warn'),
  READY_TO_INVOICE: L('Ready to invoice', 'info'),
  FULLY_INVOICED: L('Fully invoiced', 'good'),
  NOT_READY: L('Not ready to invoice', 'bad'),
  PAYMENT_OVERDUE: L('Payment overdue', 'bad'),
  PROGRESS_INVOICED: L('Progress invoiced', 'neutral'),
  NOT_YET_DUE: L('Not yet due', 'neutral'),
};

export const RISK_REASON: Record<string, string> = {
  START_DATE_PASSED: "Start date has passed and work hasn't started",
  PAST_PLANNED_COMPLETION: 'Past the planned finish date',
  MATERIALS_DUE_AFTER_START: 'Materials arrive after the planned start',
  SUPPLIER_DELIVERY_AFTER_START: 'Supplier delivery is after the planned start',
  SUPPLIER_ACK_OVERDUE: "Supplier hasn't confirmed the order",
  PM_FLAGGED: 'Project manager flagged a risk',
};

export const PO_STATUS: Record<string, Label> = {
  DRAFT: L('Draft', 'neutral'), PENDING_APPROVAL: L('Awaiting approval', 'warn'), APPROVED: L('Approved, not sent', 'neutral'),
  SENT: L('Sent to supplier', 'warn'), ACKNOWLEDGED: L('Confirmed by supplier', 'good'), PARTIALLY_DELIVERED: L('Part delivered', 'info'),
  DELIVERED: L('Delivered', 'good'), CANCELLED: L('Cancelled', 'neutral'),
};

export const INVOICE_LINE_STATUS: Record<string, Label> = {
  DRAFT: L('Draft', 'neutral'), PENDING_APPROVAL: L('Awaiting approval', 'warn'), APPROVED: L('Approved', 'info'),
  ISSUED: L('Sent to customer', 'info'), PARTIALLY_PAID: L('Part paid', 'warn'), PAID: L('Paid', 'good'), VOIDED: L('Voided', 'neutral'),
};

export const CHECK_STATUS: Record<string, Label> = {
  DONE: L('Done', 'good'), OPEN: L('To do', 'warn'), WAIVED: L('Waived', 'neutral'), NOT_APPLICABLE: L('Not needed', 'neutral'),
  IN_PROGRESS: L('In progress', 'info'), CANCELLED: L('Cancelled', 'neutral'),
};

/** What the automation outcome means for the business. */
export const OUTCOME: Record<string, Label> = {
  SUCCEEDED: L('Completed', 'good'),
  DUPLICATE_IGNORED: L('Duplicate ignored safely', 'neutral'),
  REJECTED: L('Stopped: needs attention', 'bad'),
  FAILED: L('Failed safely', 'bad'),
  RECEIVED: L('In progress', 'info'),
  PROCESSING: L('In progress', 'info'),
};

export const EXCEPTION_STATUS: Record<string, Label> = {
  OPEN: L('Needs attention', 'bad'), RETRY_QUEUED: L('Retry in progress', 'warn'), RESOLVED: L('Resolved', 'good'),
  IGNORED: L('Dismissed', 'neutral'),
};

export const EXCEPTION_KIND: Record<string, string> = {
  INVALID_STATE: 'Not allowed in its current state', MISSING_DOCUMENT: 'Missing paperwork', TIMEOUT: 'A connected service did not answer in time',
  VALIDATION_ERROR: 'Incomplete information', PERMISSION_DENIED: 'Not authorised', NOT_FOUND: 'Record not found', RATE_LIMITED: 'Service busy, retried',
  SERVICE_UNAVAILABLE: 'Connected service unavailable', RECONCILIATION_MISMATCH: 'Records did not match', NETWORK: 'Connection problem',
};

/** Timeline wording for automation events and audit actions. */
const TIMELINE: Record<string, string> = {
  'lead.created': 'Enquiry received', 'inspection.completed': 'Roof inspection completed', 'quote.sent': 'Quote sent to customer',
  'quote.accepted': 'Quote accepted by customer', 'quote.accept': 'Quote marked accepted', 'project.created': 'Project created',
  'project.create': 'Project set up', 'task.create': 'Material review task created', 'materials.review_requested': 'Material review requested',
  'drive.project_folder.verified': 'Google Drive folder created and checked', 'drive.folder.link': 'Google Drive folder linked',
  'airtable.project_writeback.verified': 'Airtable updated and checked', 'airtable.project.writeback': 'Airtable project record updated',
  'po.drafted': 'Purchase order drafted', 'po.approved': 'Purchase order approved', 'po.sent': 'Purchase order sent to supplier',
  'supplier.acknowledged': 'Supplier confirmed the order', 'job.scheduled': 'Job scheduled', 'job.started': 'Work started on site',
  'job.completed': 'Job completed', 'site.note.created': 'Site note added',
  'invoice.drafted': 'Invoice drafted', 'invoice.created': 'Invoice created', 'invoice.paid': 'Payment received',
  'invoice.prepare_requested': 'Invoice preview requested', 'invoice.preview_prepared': 'Invoice preview prepared for approval',
  'invoice.approved': 'Invoice approval received', 'invoice.rejected': 'Invoice rejected by approver',
  'approval.approve': 'Invoice approved', 'invoice.create': 'Final invoice created in RoofOps',
  'xero.invoice.draft_created': 'Draft invoice created in Xero and checked', 'xero.create_draft_invoice.verified': 'Xero draft invoice verified',
  'automation.retry_scheduled': 'Temporary problem, retry scheduled', 'automation.failed': 'Automation stopped safely after retries',
  'exception.retry_queued': 'Retry requested by staff', 'exception.fold_duplicate': 'Duplicate alert merged',
  'airtable.record_changed': 'Change made in Airtable', 'airtable.writeback.verified': 'Airtable corrected and checked',
  'airtable.edit_reverted': 'Airtable edit put back (managed by RoofOps)', 'project.status.changed': 'Project status changed',
  'project.planned_start_date.changed': 'Planned start changed', 'project.planned_completion_date.changed': 'Planned finish changed',
  'project.project_manager.changed': 'Project manager changed', 'approval.withdrawn': 'Invoice preview withdrawn',
  'purchase_order.status.changed': 'Purchase order status changed', 'purchase_order.expected_delivery_date.changed': 'Delivery date changed',
  'purchase_order.supplier_reference.changed': 'Supplier reference changed', 'quote.status.changed': 'Quote status changed',
};

export function timelineTitle(kind: string): string {
  return TIMELINE[kind] ?? kind.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Friendly name for an automation actor/channel. */
export function actorName(actor: string | null, channel: string | null): string {
  if (!actor) return '';
  if (/^usr[A-Za-z0-9]{14}$/.test(actor)) return 'Office staff (Airtable)';
  if (actor.startsWith('dashboard:')) return 'Operations Copilot';
  if (actor === 'xero' || actor.startsWith('xero.')) return 'Xero';
  if (/@\d+$/.test(actor) || /^(n8n|drive\.|airtable|google-drive)/.test(actor)) return 'RoofOps automation';
  if (actor.startsWith('operator:')) return 'Operations team';
  if (actor === 'reconciliation' || actor === 'airtable_sync') return 'RoofOps sync check';
  if (actor.startsWith('migration:') || actor.startsWith('import')) return 'Data import';
  if (channel === 'airtable') return `${actor} (via Airtable)`;
  return actor;
}

/** Automation notes in plain words (the database records them precisely; the owner needs the gist). */
export function plainReason(reason: string | null): string | null {
  if (!reason) return null;
  if (/transport redelivery/i.test(reason)) return 'The same request arrived again; nothing was done twice';
  reason = reason.replace(/\s*\[(airtable|reconcile):[^\]]*\]/g, '').trim();
  if (!reason) return null;
  const semantic = /^semantic duplicate:\s*(.*)$/i.exec(reason);
  if (semantic) return `Asked again: ${semantic[1]}; nothing was done twice`;
  const requeued = /re-queued .* after (\d+) attempts/i.exec(reason);
  if (requeued) return `${reason.split(';')[0]}; staff asked RoofOps to try again after ${requeued[1]} attempts`;
  return reason.replace(/\bread back\b/gi, 'checked');
}

/** An automation issue in the owner's words: drop internal step names and operator instructions. */
export function plainIssue(message: string): string {
  if (/^drive\./.test(message) || /Drive root/i.test(message)) return 'Google Drive was unavailable while creating the project folder';
  if (/^airtable\./.test(message)) return 'Airtable could not be updated at the time';
  if (/^xero\./.test(message)) return 'Xero could not be reached at the time';
  return message.replace(/^[a-z_]+(\.[a-z_]+)+:\s*/i, '').replace(/\s*Restore it or run \[RoofOps\][^.]*\.?/i, '');
}

export function plainResolution(note: string | null): string | null {
  if (!note) return null;
  return note.replace(/side effect succeeded on retry/i, 'completed when RoofOps tried again').replace(/^Auto-resolved/i, 'Resolved automatically');
}

export const label = (map: Record<string, Label>, code: string | null | undefined): Label =>
  (code && map[code]) || L(code ? code.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—', 'neutral');

export const money = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });

export function date(d: string | null | undefined): string {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, day!)).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export const JOB_TYPE = (t: string | null) => (t ? t.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—');

export const airtableProjectUrl = (rec: string | null) =>
  rec ? `https://airtable.com/appMc8V0Wm29tEeHQ/tblvUPIoebC3zoacv/${rec}` : null;

/** Outcome badge for a history entry: a scheduled retry is progress, not a failure. */
export function outcomeLabel(kind: string, status: string | null): Label {
  if (kind === 'automation.retry_scheduled') return L('Retry in progress', 'warn');
  return status ? label(OUTCOME, status) : L('Recorded', 'neutral');
}
