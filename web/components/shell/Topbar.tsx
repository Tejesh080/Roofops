'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, LogOut, Presentation, UserRound } from 'lucide-react';
import { logout } from '@/app/login/actions';

export function RoofMark({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path d="M3 12 12 4l9 8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 10.5V20h12v-9.5" fill="none" stroke="#fff" strokeOpacity=".85" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

const roleName = (r: string) => r.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** user: the signed-in person's name; role: set for a staff sign-in, absent for the shared demo viewer. */
export function Topbar({ user, role }: { user: string; role?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, []);
  return (
    <header className="topbar">
      <Link href="/" className="brand" aria-label="RoofOps overview">
        <span className="brand-mark"><RoofMark /></span>
        <span className="brand-name">RoofOps</span>
        <span className="brand-divider" aria-hidden />
        <span className="brand-product">Operations Control Centre</span>
      </Link>
      <div className="topbar-right">
        <span className="env-badge"><span className="dot" aria-hidden />Demo <span className="long">environment</span></span>
        <div className="menu-wrap" ref={ref}>
          <button className="btn btn-ghost btn-sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
            <UserRound size={15} aria-hidden /> {role ? user.split(' ')[0] : 'Demo'} <ChevronDown size={14} aria-hidden />
          </button>
          <AnimatePresence>
            {open && (
              <motion.div className="menu" role="menu" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }}>
                <div className="m-head">Signed in as <strong>{user}</strong><br />{role ? roleName(role) : 'Demo viewer: read only'} · synthetic demo data</div>
                <Link className="mi" role="menuitem" href="/demo" onClick={() => setOpen(false)}><Presentation size={15} aria-hidden /> Interview demo guide</Link>
                <form action={logout}><button className="mi" role="menuitem"><LogOut size={15} aria-hidden /> Sign out</button></form>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </header>
  );
}
