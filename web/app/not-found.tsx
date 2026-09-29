import Link from 'next/link';
import { SearchX } from 'lucide-react';

export default function NotFound() {
  return (
    <main className="login">
      <div className="login-card" style={{ textAlign: 'center' }}>
        <div className="empty" style={{ padding: 8 }}>
          <div className="e-icon"><SearchX size={18} aria-hidden /></div>
          <div className="e-title">Not found</div>
          <p className="t-meta">There is nothing here. Project numbers look like PRJ-2026-0004.</p>
        </div>
        <Link className="btn btn-primary" href="/">Back to overview</Link>
      </div>
    </main>
  );
}
