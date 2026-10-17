/**
 * Staff Xero dispatch switch (server-side only). Approving a final invoice in the dashboard queues its Xero draft, and
 * "Send to Xero" queues one; n8n 09 sends queued drafts. Until the owner has tested and activated 09, the switch is off.
 * On: STAFF_XERO_DISPATCH=on in the dashboard's server environment (set together with activating n8n 09).
 *
 * One policy while it is off (Factory review, Batch 1): the dashboard never starts a financial step it cannot finish.
 *  - Preparing a final invoice is off: a preview prepared in the dashboard can only be approved in the dashboard (the
 *    shared Airtable account may not approve a named person's preview), so it would be stuck. Prepare it in Airtable.
 *  - Approving a final invoice, requesting or approving a reissue, and sending to Xero are off: each queues (or leads
 *    to) a Xero write that nothing would send, and that would fire the moment n8n 09 is switched on.
 *  - Rejecting (or withdrawing) a pending preview stays on, so whatever exists always has a way out. A pending reissue
 *    request is harmless (it queues nothing) and expires by itself.
 * The database still enforces every rule (roles, two people, locks); this only decides what the dashboard offers.
 */
export const staffDispatchEnabled = (env: Record<string, string | undefined> = process.env) => env.STAFF_XERO_DISPATCH === 'on';

const WHY = 'RoofOps automation does not yet send dashboard work to Xero (the owner switches it on after testing)';

export const DISPATCH_OFF = {
  prepare: `Preparing final invoices in the dashboard is off: ${WHY}, and a preview prepared here could only be approved here. `
    + 'Until then, prepare and approve it in Airtable (Projects › Invoice Action), or ask the Copilot to prepare it and approve it in Airtable.',
  approve: `Approving final invoices in the dashboard is off: ${WHY}. Nothing was approved. If this preview was prepared in the dashboard, `
    + 'reject it here with a reason and prepare it again in Airtable; if it was prepared in Airtable or by the Copilot, approve it in Airtable.',
  reissueRequest: `Reissues from the dashboard are off: ${WHY}, so a replacement draft could not be sent. Nothing was requested. `
    + 'A reissue meanwhile is a supervised task for the owner.',
  reissueApprove: `Approving a reissue is off: ${WHY}; approving now would queue a replacement Xero draft that nothing can send. `
    + 'Nothing was approved. The request queues nothing and expires by itself.',
  send: `Sending to Xero from the dashboard is off: ${WHY}.`,
} as const;

/** What a pending final-invoice preview tells an approver while approving here is off, by where it was prepared. */
export function approveOffNote(via: 'dashboard' | 'copilot' | 'airtable'): string {
  return via === 'dashboard'
    ? `This preview was prepared in the dashboard, so only the dashboard can approve it, and approving here is off (${WHY}). `
      + 'Reject it here with a reason; it can then be prepared and approved in Airtable (Projects › Invoice Action).'
    : `Approving here is off (${WHY}). Approve it in Airtable: Prepare on the project row shows this preview, then Approve. Or reject it here.`;
}
