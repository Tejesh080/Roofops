'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BellRing, FolderKanban, HeartPulse, LayoutDashboard, Package, Presentation, Receipt, Workflow, type LucideIcon } from 'lucide-react';

interface Item { href: string; text: string; icon: LucideIcon; count?: number }

export function Sidebar({ counts }: { counts: { attention: number; automation: number } }) {
  const path = usePathname();
  const items: Item[] = [
    { href: '/', text: 'Overview', icon: LayoutDashboard },
    { href: '/projects', text: 'Projects', icon: FolderKanban },
    { href: '/attention', text: 'Attention', icon: BellRing, count: counts.attention },
    { href: '/materials', text: 'Materials', icon: Package },
    { href: '/finance', text: 'Finance', icon: Receipt },
    { href: '/automation', text: 'Automation', icon: Workflow, count: counts.automation },
    { href: '/health', text: 'System health', icon: HeartPulse },
  ];
  const on = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  const link = (i: Item) => (
    <Link key={i.href} href={i.href} className={`nav-item ${on(i.href) ? 'on' : ''}`} aria-current={on(i.href) ? 'page' : undefined} title={i.text}>
      <i.icon size={17} aria-hidden />
      <span className="nav-text">{i.text}</span>
      {!!i.count && <span className="nav-count" aria-label={`${i.count} items`}>{i.count}</span>}
    </Link>
  );
  return (
    <nav className="sidebar" aria-label="Main">
      {items.map(link)}
      <div className="nav-sep" />
      <div className="nav-caption">Interview</div>
      {link({ href: '/demo', text: 'Demo guide', icon: Presentation })}
    </nav>
  );
}
