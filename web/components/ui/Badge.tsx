import type { Label } from '@/lib/labels';

/** Status badge: colour AND a dot AND words, so status never relies on colour alone. */
export function Badge({ l, title, dot = true }: { l: Label; title?: string; dot?: boolean }) {
  return (
    <span className={`badge ${l.tone}`} title={title}>
      {dot && <span className="dot" aria-hidden />}
      {l.text}
    </span>
  );
}
