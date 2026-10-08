import type { Query } from './queries';

/** One final invoice in the reissue view (web_reissue_overview): voided (a candidate) or with a reissue request. */
export interface ReissueItem {
  invoice_number: string; project_number: string; customer: string; status: string;
  total_inc_gst: number; gst_amount: number; voided_reason: string | null;
  check: { ok: boolean; code?: string; detail?: string; target_generation?: number } | null;
  pending: {
    approval_number: string; requested_at: string; expires_at: string; requested_by: string; requested_by_name: string;
    reason: string | null; xero_invoice_number: string | null; amount_inc_gst: string | null; gst_amount: string | null;
    contact: string | null; tenant: string | null; target_generation: string | null; i_requested_it: boolean;
  } | null;
  latest_decided: {
    approval_number: string; status: string; decided_at: string | null; decided_by: string | null; requested_by: string | null;
    generation: number | null; generation_status: string | null; xero_invoice_id: string | null; write_status: string | null; write_attempts: number | null;
  } | null;
}
export interface ReissueOverview {
  ok: boolean; reason?: string; roles?: string; items?: ReissueItem[];
  me?: { employee_code: string; name: string; role: string; may_reissue: boolean };
}

/** Postgres 42883 (undefined function): the dashboard reissue migration is not installed on this database. */
export const notInstalled = (e: unknown) => (e as { code?: string } | null)?.code === '42883';

/** Staff only (null without a staff session): the database checks the session token and answers for that employee. */
export async function getReissueOverview(q: Query, token: string | undefined): Promise<ReissueOverview | null> {
  if (!token) return null;
  try {
    const [row] = await q<{ r: ReissueOverview }>('select web_reissue_overview($1) r', [token]);
    return row?.r ?? { ok: false, reason: 'Invoice reissues could not be loaded. Reload the page.' };
  } catch (e) {
    return { ok: false, reason: notInstalled(e) ? 'Reissue from the dashboard is not available on this server yet.' : 'Invoice reissues could not be loaded. Reload the page.' };
  }
}

/** Plain words for the reissue refusal codes the database returns. */
export const REISSUE_CODE: Record<string, string> = {
  SAME_PERSON: 'You asked for this reissue, so someone else must approve it.',
  ACTOR_UNAUTHORIZED: 'Your role cannot request or approve a reissue.',
  REASON_REQUIRED: 'Say why the invoice is being reissued (at least 10 characters).',
  REISSUE_PENDING: 'A reissue request for this invoice is already waiting for approval.',
  ALREADY_PROCESSED: 'This reissue was already decided.',
  APPROVAL_EXPIRED: 'This request expired. Request it again.',
  PREVIEW_CHANGED: 'The invoice changed after the request. Request it again so the draft is current.',
  SIGNED_OUT: 'Your sign-in has ended. Sign in again as yourself.',
};
