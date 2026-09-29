import type { LucideIcon } from 'lucide-react';

export function Empty({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text?: string }) {
  return (
    <div className="empty">
      <div className="e-icon"><Icon size={18} aria-hidden /></div>
      <div className="e-title">{title}</div>
      {text && <div className="t-meta">{text}</div>}
    </div>
  );
}

export function CardHead({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: React.ReactNode }) {
  return (
    <div className="card-head">
      <span className="icon"><Icon size={15} aria-hidden /></span>
      <h2 className="t-section">{title}</h2>
      {children}
    </div>
  );
}
