import type { Label } from '@/lib/labels';

export function Pill({ l, title }: { l: Label; title?: string }) {
  return <span className={`pill ${l.tone}`} title={title}>{l.text}</span>;
}
