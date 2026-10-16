/**
 * Staff Xero dispatch switch (server-side only). Approving a final invoice in the dashboard queues its Xero draft, and
 * "Send to Xero" queues one; n8n 09 sends queued drafts. Until the owner has tested and activated 09, both stay off, so
 * nothing is queued that would fire the moment 09 is switched on. Preparing and rejecting are unaffected.
 * On: STAFF_XERO_DISPATCH=on in the dashboard's server environment (set together with activating n8n 09).
 */
export const staffDispatchEnabled = (env: Record<string, string | undefined> = process.env) => env.STAFF_XERO_DISPATCH === 'on';

export const DISPATCH_PENDING =
  'Approving and sending to Xero from the dashboard are switched on together with the RoofOps automation that sends them, after the owner has tested it. Until then, approve in Airtable (the usual way), or reject here.';
