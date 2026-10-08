'use client';

import { CircleAlert } from 'lucide-react';

/**
 * Last-resort page when the dashboard cannot load at all (the shared layout reads the database too, so an outage or a
 * missing CA certificate lands here, not on a page's own error card). Plain words, a retry, a reference for support.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="login">
      <div className="login-card" role="alert" style={{ textAlign: 'center' }}>
        <div className="empty" style={{ padding: 8 }}>
          <div className="e-icon"><CircleAlert size={18} aria-hidden /></div>
          <div className="e-title">RoofOps cannot load right now</div>
          <p className="t-meta">The dashboard could not read the RoofOps database. Nothing was changed. Try again in a minute; if it keeps
            happening, tell the person who runs RoofOps{error.digest ? <> and quote reference <span className="mono">{error.digest}</span></> : null}.</p>
        </div>
        <button className="btn btn-primary" onClick={reset}>Try again</button>
      </div>
    </main>
  );
}
