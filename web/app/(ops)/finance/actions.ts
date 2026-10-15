'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/session';
import { query } from '@/lib/db';
import { REISSUE_CODE, notInstalled } from '@/lib/reissue';
import { invoiceRefusal } from '@/lib/invoices';

export interface ReissueActionState { ok?: boolean; message?: string }
type Outcome = { ok: boolean; code?: string; detail?: string; approval_number?: string; generation?: number };

/** Runs one web_reissue_* call as the signed-in employee; the database checks the session, role and every reissue rule. */
async function asStaff(sql: string, args: unknown[]): Promise<Outcome | { signedOut: true }> {
  const s = await verifySession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!s?.t) return { signedOut: true };
  const [row] = await query<{ r: Outcome }>(sql, [s.t, ...args]);
  return row!.r;
}

const refusal = (r: Outcome) => (r.code && REISSUE_CODE[r.code]) ? `${REISSUE_CODE[r.code]}${r.detail ? ` (${r.detail})` : ''}` : (r.detail ?? 'Not done.');

/** The function is not installed: nothing happened. Anything else may have committed: re-read and say so. */
function failed(e: unknown): ReissueActionState {
  if (notInstalled(e)) return { message: 'Reissue from the dashboard is not available on this server yet.' };
  revalidatePath('/', 'layout');
  return { message: 'Could not confirm the result. Check the status below before trying again (a repeat is refused, never done twice).' };
}

export async function requestReissue(_prev: ReissueActionState, form: FormData): Promise<ReissueActionState> {
  const invoice = String(form.get('invoice') ?? '');
  const reason = String(form.get('reason') ?? '').trim();
  if (reason.length < 10) return { message: REISSUE_CODE.REASON_REQUIRED };
  try {
    const r = await asStaff('select web_reissue_request($1, $2, $3) r', [invoice, reason]);
    if ('signedOut' in r) return { message: 'Sign in as yourself to request a reissue (the shared demo login cannot).' };
    if (!r.ok) return { message: refusal(r) };
    revalidatePath('/', 'layout');
    return { ok: true, message: `${r.approval_number ?? 'The request'} is waiting for a second person to approve it.` };
  } catch (e) {
    return failed(e);
  }
}

export async function approveReissue(_prev: ReissueActionState, form: FormData): Promise<ReissueActionState> {
  const approval = String(form.get('approval') ?? '');
  if (form.get('checked') !== 'on') return { message: 'Confirm that you checked the draft (number, amount, customer) before approving.' };
  try {
    const r = await asStaff('select web_reissue_decide($1, $2, $3) r', [approval, String(form.get('note') ?? '').trim() || null]);
    if ('signedOut' in r) return { message: 'Sign in as yourself to approve a reissue (the shared demo login cannot).' };
    if (!r.ok) return { message: refusal(r) };
    revalidatePath('/', 'layout');
    return { ok: true, message: `${approval} approved: generation ${r.generation ?? 2} is queued. Send the replacement draft to Xero under Xero drafts on this page.` };
  } catch (e) {
    return failed(e);
  }
}

// ---- Final invoices (STAFF-OPS-01): prepare, decide and send to Xero as the signed-in employee. ----

type InvoiceOutcome = { ok: boolean; code?: string; detail?: string; message?: string; outcome?: string; approval_number?: string; invoice_number?: string };

async function asStaffInvoice(sql: string, args: unknown[]): Promise<InvoiceOutcome | { signedOut: true }> {
  const s = await verifySession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!s?.t) return { signedOut: true };
  const [row] = await query<{ r: InvoiceOutcome }>(sql, [s.t, ...args]);
  return row!.r;
}

/** Not installed: nothing happened. Anything else may have committed: re-read and say so (a repeat is refused). */
function invoiceFailed(e: unknown): ReissueActionState {
  if (notInstalled(e)) return { message: 'This is not available on this server yet.' };
  console.error('finance: no answer from the database', (e as Error).message);
  revalidatePath('/', 'layout');
  return { message: 'Could not confirm the result: the RoofOps database did not answer. Reload the page and check the status before trying again (a repeat is refused, never done twice).' };
}

export async function prepareFinalInvoice(_prev: ReissueActionState, form: FormData): Promise<ReissueActionState> {
  const project = String(form.get('project') ?? '');
  try {
    const r = await asStaffInvoice('select web_invoice_prepare($1, $2) r', [project]);
    if ('signedOut' in r) return { message: 'Sign in as yourself to prepare an invoice (the shared demo login cannot).' };
    if (!r.ok) return { message: invoiceRefusal(r) };
    revalidatePath('/', 'layout');
    return { ok: true, message: r.outcome === 'ALREADY_PENDING'
      ? `${r.approval_number ?? 'A preview'} is already waiting for approval (see below).`
      : `${r.approval_number ?? 'The preview'} is ready and waiting for a second person to approve it.` };
  } catch (e) {
    return invoiceFailed(e);
  }
}

export async function decideFinalInvoice(_prev: ReissueActionState, form: FormData): Promise<ReissueActionState> {
  const approval = String(form.get('approval') ?? '');
  const decision = form.get('decision') === 'reject' ? 'reject' : 'approve';
  const note = String(form.get('note') ?? '').trim();
  if (decision === 'approve' && form.get('checked') !== 'on') return { message: 'Tick that you checked the customer, amount, GST and lines before approving.' };
  if (decision === 'reject' && note.length < 5) return { message: 'Say why it is rejected (a few words), so the requester knows what to fix.' };
  try {
    const r = await asStaffInvoice('select web_invoice_decide($1, $2, $3, $4, $5) r', [approval, String(form.get('hash') ?? ''), decision, note || null]);
    if ('signedOut' in r) return { message: 'Sign in as yourself to approve or reject (the shared demo login cannot).' };
    if (!r.ok) return { message: invoiceRefusal(r) };
    revalidatePath('/', 'layout');
    return { ok: true, message: decision === 'approve'
      ? `${approval} approved: ${r.invoice_number ?? 'the invoice'} is created in RoofOps and queued for Xero (usually within a minute).`
      : `${approval} rejected. Nothing was created.` };
  } catch (e) {
    return invoiceFailed(e);
  }
}

export async function requestXeroDraft(_prev: ReissueActionState, form: FormData): Promise<ReissueActionState> {
  const invoice = String(form.get('invoice') ?? '');
  if (form.get('checked') !== 'on') return { message: 'Tick that you checked the draft (number, amount, customer) first.' };
  try {
    const r = await asStaffInvoice('select web_xero_dispatch_request($1, $2, $3, $4) r', [invoice, Number(form.get('generation')), String(form.get('sha') ?? '')]);
    if ('signedOut' in r) return { message: 'Sign in as yourself to send invoices to Xero (the shared demo login cannot).' };
    if (!r.ok) return { message: invoiceRefusal(r) };
    revalidatePath('/', 'layout');
    return { ok: true, message: `${invoice} is queued for Xero. RoofOps automation picks it up within a minute; this page shows the result.` };
  } catch (e) {
    return invoiceFailed(e);
  }
}
