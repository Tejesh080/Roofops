'use client';

import { useActionState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { resolveException, type ResolveState } from '@/app/(ops)/automation/actions';

/** Close an issue that needs a person, with a note saying why. Disabled while sending, so a double click resolves once. */
export function ResolveForm({ exception }: { exception: string }) {
  const [state, action, pending] = useActionState<ResolveState, FormData>(resolveException, {});
  if (state.ok) return <p className="resolve-done" role="status"><CheckCircle2 size={15} aria-hidden /> {state.message}</p>;
  return (
    <form action={action} className="resolve-form">
      <input type="hidden" name="exception" value={exception} />
      <label className="field">
        <span>Resolve {exception}: what was checked or done?</span>
        <textarea name="note" required minLength={10} rows={2} placeholder="e.g. Supplier confirmed by phone; order re-sent" />
      </label>
      {state.message && <p className="form-error" role="alert">{state.message}</p>}
      <button className="btn btn-sm btn-primary" disabled={pending}>
        {pending ? <><Loader2 size={14} className="spin" aria-hidden /> Resolving…</> : 'Mark resolved'}
      </button>
    </form>
  );
}
