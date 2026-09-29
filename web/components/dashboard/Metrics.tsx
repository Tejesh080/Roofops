'use client';

import { AlertTriangle, BadgeDollarSign, CircleAlert, HardHat, PackageSearch, type LucideIcon } from 'lucide-react';
import type { Tone } from '@/lib/labels';
import type { TableFilter } from './ProjectTable';

export interface Metric { key: TableFilter; label: string; value: number; note: string; tone: Tone; icon: 'active' | 'risk' | 'materials' | 'invoice' | 'issues' }
const ICONS: Record<Metric['icon'], LucideIcon> = { active: HardHat, risk: AlertTriangle, materials: PackageSearch, invoice: BadgeDollarSign, issues: CircleAlert };

export function Metrics({ items, selected, onSelect }: { items: Metric[]; selected: TableFilter; onSelect: (k: TableFilter) => void }) {
  return (
    <section className="metrics" aria-label="Headline numbers">
      {items.map((m) => {
        const Icon = ICONS[m.icon];
        return (
          <button key={m.key} type="button" className={`metric tone-${m.tone} ${selected === m.key ? 'sel' : ''}`} aria-pressed={selected === m.key}
            onClick={() => onSelect(m.key)} aria-label={`${m.label}: ${m.value}. ${m.note}. Show these projects.`}>
            <span className="m-bar" aria-hidden />
            <span className="m-top"><span className="m-icon"><Icon size={15} aria-hidden /></span><span className="t-label">{m.label}</span></span>
            <span className="m-value">{m.value}</span>
            <span className="m-note">{m.note}</span>
          </button>
        );
      })}
    </section>
  );
}
