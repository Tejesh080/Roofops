'use client';

import { useActionState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { approveReissue, requestReissue, type ReissueActionState } from '@/app/(ops)/finance/actions';

/** Ask for a replacement of a voided final invoice. Disabled while sending, so a double click requests once. */
export function RequestReissueForm({ invoice }: { invoice: string }) {
  const [state, action, pending] = useActionState<ReissueActionState, FormData>(requestReissue, {});
  if (state.ok) return <p className="resolve-done" role="status"><CheckCircle2 size={15} aria-hidden /> {state.message}</p>;
  return (
    <form action={action} className="resolve-form">
      <input type="hidden" name="invoice" value={invoice} />
      <label className="field">
        <span>Why does {invoice} need a replacement draft?</span>
        <textarea name="reason" required minLength={10} rows={2} placeholder="e.g. Draft deleted in Xero by mistake; the customer still owes this amount" />
      </label>
      {state.message && <p className="form-error" role="alert">{state.message}</p>}
      <button className="btn btn-sm btn-primary" disabled={pending}>
        {pending ? <><Loader2 size={14} className="spin" aria-hidden /> Requesting…</> : 'Request reissue'}
      </button>
    </form>
  );
}

/** A second person approves the exact draft shown. They must tick that they checked it. */
export function ApproveReissueForm({ approval }: { approval: string }) {
  const [state, action, pending] = useActionState<ReissueActionState, FormData>(approveReissue, {});
  if (state.ok) return <p className="resolve-done" role="status"><CheckCircle2 size={15} aria-hidden /> {state.message}</p>;
  return (
    <form action={action} className="resolve-form">
      <input type="hidden" name="approval" value={approval} />
      <label className="check-line">
        <input type="checkbox" name="checked" required /> I checked the draft number, amount and customer above
      </label>
      <label className="field">
        <span>Note (optional)</span>
        <textarea name="note" rows={1} placeholder="e.g. Confirmed with the customer" />
      </label>
      {state.message && <p className="form-error" role="alert">{state.message}</p>}
      <button className="btn btn-sm btn-primary" disabled={pending}>
        {pending ? <><Loader2 size={14} className="spin" aria-hidden /> Approving…</> : `Approve reissue ${approval}`}
      </button>
    </form>
  );
}
