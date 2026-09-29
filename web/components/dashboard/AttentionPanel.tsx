import Link from 'next/link';
import { BellRing, ChevronRight, PartyPopper } from 'lucide-react';
import type { AttentionItem } from '@/lib/insights';
import { CardHead, Empty } from '@/components/ui/Empty';

const KIND: Record<AttentionItem['kind'], string> = { risk: 'At risk', issue: 'Automation issue', approval: 'Approval', payment: 'Payment' };

export function AttentionPanel({ items, total, compact = true }: { items: AttentionItem[]; total: number; compact?: boolean }) {
  return (
    <section className="card" aria-labelledby="att-h">
      <CardHead icon={BellRing} title="Needs attention today">
        {compact && <Link href="/attention" className="btn btn-ghost btn-sm">View all{total > items.length ? ` (${total})` : ''} <ChevronRight size={14} aria-hidden /></Link>}
      </CardHead>
      {items.length === 0 ? <Empty icon={PartyPopper} title="Nothing needs you today" text="No jobs at risk and no automation issues." /> : (
        <ul className="att-list">
          {items.map((i) => (
            <li key={`${i.kind}-${i.project}`}>
              <Link className="att-item" href={`/projects/${i.project}`}>
                <span className={`sev ${i.severity === 'high' ? '' : i.kind === 'approval' ? 'info' : 'medium'}`} aria-hidden />
                <span>
                  <span className="att-title">{i.project}<span className="cust">{i.customer}</span></span>
                  <span className="att-sum"><span className="sr-only">{KIND[i.kind]}{i.severity === 'high' ? ', high priority' : ''}: </span>{i.summary}</span>
                </span>
                <ChevronRight size={16} className="chev" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
