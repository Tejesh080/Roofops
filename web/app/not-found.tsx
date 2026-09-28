import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="card">
      <h1>Not found</h1>
      <p className="muted">There is no project with that number. Project numbers look like PRJ-2026-0004.</p>
      <Link href="/">Back to the dashboard</Link>
    </div>
  );
}
