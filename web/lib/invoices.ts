import type { Query } from './queries';
import { notInstalled } from './reissue';

/** A final-invoice preview waiting for a decision (web_invoice_overview). The figures are the approved action payload. */
export interface PendingInvoice {
  approval_number: string; project_number: string; payload_hash: string; requested_at: string; expires_at: string;
  requested_by: string | null; i_requested_it: boolean; requested_via: 'dashboard' | 'copilot' | 'airtable';
  preview: {
    customer_name: string; customer_number: string; amount_inc_gst: number; gst_amount: number; amount_ex_gst: number;
    invoice_date: string; due_date: string; reference: string; xero_contact_name: string; quote_number: string; quote_version: number;
    billed_to_date_inc_gst: number; lines: { line_no: number; description: string; quantity: number; unit_amount: number }[];
  };
}
export type DraftState = 'READY_TO_SEND' | 'QUEUED' | 'STARTING' | 'SENDING' | 'STUCK' | 'CREATED' | 'RETRY_LATER' | 'FAILED' | 'STOPPED' | 'UNCERTAIN' | 'VOIDED';
/** One queued Xero draft write and where it stands (xero_draft_progress: outbox, invoice sync state, staff request). */
export interface DraftProgress {
  invoice_number: string; project_number: string; customer: string; amount_inc_gst: string; xero_invoice_number: string; generation: number;
  state: DraftState; attempts: number; next_attempt_at: string | null; last_error: string; payload_sha256: string; xero_invoice_id: string | null;
  request: { status: string; requested_by: string | null; requested_at: string; reason: string; closed_reason: string | null } | null;
  problem: { code: string; detail: string } | null;
}
export interface InvoiceOverview {
  ok: boolean; code?: string; reason?: string;
  me?: { employee_code: string; name: string; role: string; may_prepare: boolean; may_approve: boolean; may_dispatch: boolean };
  pending?: PendingInvoice[]; drafts?: DraftProgress[];
}

/** Staff only (null without a staff session); the database checks the session token and answers for that employee. */
export async function getInvoiceOverview(q: Query, token: string | undefined): Promise<InvoiceOverview | null> {
  if (!token) return null;
  try {
    const [row] = await q<{ r: InvoiceOverview }>('select web_invoice_overview($1) r', [token]);
    return row?.r ?? { ok: false, reason: 'Invoices could not be loaded. Reload the page.' };
  } catch (e) {
    return { ok: false, reason: notInstalled(e) ? 'Approving invoices in the dashboard is not available on this server yet (approve them in Airtable).' : 'Invoices could not be loaded. Reload the page.' };
  }
}

/** Plain words for every refusal the invoice and dispatch functions return. */
export const INVOICE_CODE: Record<string, string> = {
  SIGNED_OUT: 'Your sign-in has ended. Sign in again as yourself.',
  ACTOR_UNAUTHORIZED: 'Your role cannot do this.',
  SAME_PERSON: 'You prepared this invoice, so someone else must approve it.',
  REQUESTER_UNKNOWN: 'Nobody signed in asked for this preview (it came from the shared Airtable account), so two people cannot be proven.',
  PREVIEW_CHANGED: 'The preview changed since you opened it. Reload and check it again.',
  ALREADY_PROCESSED: 'This preview was already decided.',
  NOT_FOUND: 'That invoice or preview no longer exists. Reload the page.',
  CHECK_REQUIRED: 'Tick that you checked the draft first.',
  NOT_CURRENT_GENERATION: 'That is not the current Xero draft of this invoice. Reload the page.',
  NO_WRITE: 'Nothing is queued for Xero for this invoice.',
  ALREADY_CREATED: 'The Xero draft already exists.',
  ALREADY_QUEUED: 'It is already waiting to be sent.',
  UNCERTAIN: 'Xero may already have created it, so it is not sent again. RoofOps checks Xero at the next reconciliation.',
  IN_PROGRESS: 'It is being created in Xero right now.',
  STUCK: 'Its creation started and never reported back, so Xero may have it. It is not sent again; reconciliation checks Xero.',
  REQUESTER_INACTIVE: 'The person who asked is no longer active. Ask again.',
  STOPPED: 'It stopped after repeated failures. See the issue on Automation.',
  NOT_DUE: 'It cannot be retried yet.',
  NOT_PROVEN: 'The replacement draft does not match its approval, so it is not sent.',
  NOT_APPROVED: 'There is no approval behind this draft.',
  VOIDED: 'This invoice is voided, so it is not sent. A replacement goes through Invoice reissues.',
  PAYLOAD_CHANGED: 'The draft changed since you looked at it. Reload and check it again.',
};
export const invoiceRefusal = (r: { code?: string; detail?: string; message?: string }) =>
  (r.code && INVOICE_CODE[r.code] ? `${INVOICE_CODE[r.code]}${r.detail && !['SIGNED_OUT'].includes(r.code) ? ` (${r.detail})` : ''}` : (r.message ?? r.detail ?? 'Not done.'));

/** What a Xero draft write means to staff, and what they can do next. */
export const DRAFT_STATE: Record<DraftState, { badge: string; tone: 'good' | 'warn' | 'bad' | 'info' | 'neutral'; text: string }> = {
  READY_TO_SEND: { badge: 'Approved, not sent', tone: 'warn', text: 'Approved, not in Xero yet. A Finance or Admin person sends it.' },
  QUEUED: { badge: 'Waiting to send', tone: 'info', text: 'Waiting for RoofOps automation to pick it up (usually within a minute).' },
  STARTING: { badge: 'Starting', tone: 'info', text: 'Automation has picked it up and is about to create it in Xero.' },
  SENDING: { badge: 'Creating in Xero', tone: 'info', text: 'Being created in Xero right now.' },
  STUCK: { badge: 'No answer', tone: 'bad', text: 'Its creation started and never reported back, so Xero may have it. Do not send it again: RoofOps checks Xero at the next reconciliation.' },
  CREATED: { badge: 'Draft in Xero', tone: 'good', text: 'The draft exists in Xero.' },
  RETRY_LATER: { badge: 'Retry later', tone: 'warn', text: 'Xero did not take it last time; it can be sent again after the time shown.' },
  FAILED: { badge: 'Not sent', tone: 'warn', text: 'Xero did not take it last time. Check the reason, then send it again.' },
  STOPPED: { badge: 'Stopped', tone: 'bad', text: 'It stopped after repeated failures. The issue on Automation says why; nothing more is sent until a person fixes it.' },
  UNCERTAIN: { badge: 'Unclear', tone: 'bad', text: 'Xero may or may not have created it (its answer was lost). Do not send it again: RoofOps checks Xero at the next reconciliation and records the result.' },
  VOIDED: { badge: 'Voided', tone: 'bad', text: 'Its Xero document was voided or deleted. It is not sent again; a replacement goes through Invoice reissues.' },
};