'use client';

import { useActionState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { decideFinalInvoice, prepareFinalInvoice, requestXeroDraft, type ReissueActionState } from '@/app/(ops)/finance/actions';

/** Prepare the final invoice preview for one project (preview only). Disabled while sending, so a double click prepares once. */
export function PrepareInvoiceForm({ project }: { project: string }) {
  const [state, action, pending] = useActionState<ReissueActionState, FormData>(prepareFinalInvoice, {});
  if (state.ok) return <span className="resolve-done" role="status"><CheckCircle2 size={15} aria-hidden /> {state.message}</span>;
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="project" value={project} />
      <button className="btn btn-sm" disabled={pending} aria-label={`Prepare invoice for ${project}`}>
        {pending ? <><Loader2 size={14} className="spin" aria-hidden /> Preparing…</> : 'Prepare invoice'}
      </button>
      {state.message && <span className="form-error" role="alert">{state.message}</span>}
    </form>
  );
}

/** Approve (after ticking the check) or reject (with a reason) the exact preview shown; bound to its hash. */
export function DecideInvoiceForm({ approval, hash }: { approval: string; hash: string }) {
  const [state, action, pending] = useActionState<ReissueActionState, FormData>(decideFinalInvoice, {});
  if (state.ok) return <p className="resolve-done" role="status"><CheckCircle2 size={15} aria-hidden /> {state.message}</p>;
  return (
    <form action={action} className="resolve-form">
      <input type="hidden" name="approval" value={approval} />
      <input type="hidden" name="hash" value={hash} />
      <label className="check-line"><input type="checkbox" name="checked" /> I checked the customer, amount, GST and lines above</label>
      <label className="field"><span>Note (required to reject)</span><textarea name="note" rows={1} placeholder="e.g. Amount agreed with the customer" /></label>
      {state.message && <p className="form-error" role="alert">{state.message}</p>}
      <div className="form-buttons">
        <button className="btn btn-sm btn-primary" name="decision" value="approve" disabled={pending}>
          {pending ? <><Loader2 size={14} className="spin" aria-hidden /> Working…</> : `Approve ${approval}`}
        </button>
        <button className="btn btn-sm" name="decision" value="reject" disabled={pending}>Reject</button>
      </div>
    </form>
  );
}

/** Send one exact Xero draft write (invoice number + generation + the payload shown). */
export function SendToXeroForm({ invoice, generation, sha, again }: { invoice: string; generation: number; sha: string; again: boolean }) {
  const [state, action, pending] = useActionState<ReissueActionState, FormData>(requestXeroDraft, {});
  if (state.ok) return <p className="resolve-done" role="status"><CheckCircle2 size={15} aria-hidden /> {state.message}</p>;
  return (
    <form action={action} className="resolve-form">
      <input type="hidden" name="invoice" value={invoice} />
      <input type="hidden" name="generation" value={generation} />
      <input type="hidden" name="sha" value={sha} />
      <label className="check-line"><input type="checkbox" name="checked" required /> I checked the draft number, amount and customer</label>
      {state.message && <p className="form-error" role="alert">{state.message}</p>}
      <button className="btn btn-sm btn-primary" disabled={pending}>
        {pending ? <><Loader2 size={14} className="spin" aria-hidden /> Queuing…</> : again ? `Send ${invoice} to Xero again` : `Send ${invoice} to Xero`}
      </button>
    </form>
  );
}
