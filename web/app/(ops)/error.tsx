'use client';

import { CircleAlert } from 'lucide-react';

export default function OpsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card" role="alert">
      <div className="empty">
        <div className="e-icon"><CircleAlert size={18} aria-hidden /></div>
        <div className="e-title">This page could not load its data</div>
        <p className="t-meta">The RoofOps database did not answer. Nothing was changed. Try again; if it keeps happening, tell the person who runs
          RoofOps{error.digest ? <> and quote reference <span className="mono">{error.digest}</span></> : null}.</p>
        <button className="btn" onClick={reset}>Try again</button>
      </div>
    </div>
  );
}
