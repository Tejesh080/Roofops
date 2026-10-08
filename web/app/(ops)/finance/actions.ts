'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/session';
import { query } from '@/lib/db';
import { REISSUE_CODE } from '@/lib/reissue';

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

export async function requestReissue(_prev: ReissueActionState, form: FormData): Promise<ReissueActionState> {
  const invoice = String(form.get('invoice') ?? '');
  const reason = String(form.get('reason') ?? '').trim();
  if (reason.length < 10) return { message: REISSUE_CODE.REASON_REQUIRED };
  try {
    const r = await asStaff('select web_reissue_request($1, $2, $3) r', [invoice, reason]);
    if ('signedOut' in r) return { message: 'Sign in as yourself to request a reissue (the shared demo login cannot).' };
    if (!r.ok) return { message: refusal(r) };
    revalidatePath('/', 'layout');
    return { ok: true, message: `${r.approval_number ?? 'The request'} is waiting for a second person in Finance or Admin to approve it.` };
  } catch {
    return { message: 'Reissue from the dashboard is not available on this server yet.' };
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
    return { ok: true, message: `${approval} approved: generation ${r.generation ?? 2} is queued. The replacement draft is created in Xero at the supervised dispatch.` };
  } catch {
    return { message: 'Reissue from the dashboard is not available on this server yet.' };
  }
}
