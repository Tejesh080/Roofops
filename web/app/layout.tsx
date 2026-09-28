import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { CopilotPanel } from '@/components/CopilotPanel';

export const metadata: Metadata = {
  title: 'RoofOps Operations',
  description: 'Operations dashboard and copilot for a roofing business (demo data).',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU">
      <body>
        <div className="demo-banner" role="note">
          <strong>Demo mode</strong>
          <span>Synthetic data for a fictional roofing business. Business date: 29 Sep 2026. Xero is the Xero Demo Company.</span>
        </div>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="brand-mark" aria-hidden>▲</span> RoofOps <span className="brand-sub">Operations</span>
          </Link>
          <nav className="topnav">
            <Link href="/">Dashboard</Link>
            <Link href="/#demo">Demo guide</Link>
          </nav>
        </header>
        <div className="shell">
          <main className="content">{children}</main>
          <CopilotPanel />
        </div>
      </body>
    </html>
  );
}
