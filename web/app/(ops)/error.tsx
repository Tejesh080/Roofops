'use client';

import { CircleAlert } from 'lucide-react';

export default function OpsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card" role="alert">
      <div className="empty">
        <div className="e-icon"><CircleAlert size={18} aria-hidden /></div>
        <div className="e-title">This page could not load its data</div>
        <p className="t-meta">The RoofOps database did not answer in time. Nothing was changed.</p>
        <button className="btn" onClick={reset}>Try again</button>
      </div>
    </div>
  );
}
