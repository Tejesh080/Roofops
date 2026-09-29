import { Package, PackageCheck } from 'lucide-react';
import type { ChecklistItem, ProjectRow, PurchaseOrder } from '@/lib/queries';
import { MATERIAL_STATUS, PO_STATUS, date, label, money } from '@/lib/labels';
import { Badge } from '@/components/ui/Badge';
import { CardHead, Empty } from '@/components/ui/Empty';

const CONFIRMED = new Set(['ACKNOWLEDGED', 'PARTIALLY_DELIVERED', 'DELIVERED']);

export function MaterialsCard({ p, pos, review }: { p: ProjectRow; pos: PurchaseOrder[]; review: ChecklistItem | undefined }) {
  const live = pos.filter((o) => o.status !== 'CANCELLED');
  const confirmed = live.filter((o) => CONFIRMED.has(o.status)).length;
  const pct = live.length ? Math.round((confirmed / live.length) * 100) : 0;
  const problem = (o: PurchaseOrder) => !p.is_active ? null : o.ack_overdue ? 'Confirmation overdue'
    : p.is_active && o.status !== 'DELIVERED' && o.expected_delivery_date && p.planned_start_date && o.expected_delivery_date > p.planned_start_date ? 'Arrives after planned start' : null;
  return (
    <section className="card">
      <CardHead icon={Package} title="Materials"><Badge l={label(MATERIAL_STATUS, p.material_status)} /></CardHead>
      <div className="card-body">
        {p.is_active && live.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="t-label">Materials readiness</span>
              <span className="num strong" style={{ fontSize: 13 }}>{confirmed} of {live.length} confirmed</span>
            </div>
            <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Orders confirmed by suppliers">
              <span style={{ width: `${pct}%`, background: pct === 100 ? 'var(--good)' : pct >= 50 ? '#3f8f6a' : '#e39a3b' }} />
            </div>
          </div>
        )}
        {review && review.status !== 'DONE' && (
          <div className="attn-note" style={{ marginTop: 0, marginBottom: 12 }}>
            <strong>Material review pending</strong>{review.due_on ? ` · due ${date(review.due_on)}` : ''}{review.assignee ? ` · ${review.assignee}` : ''}
          </div>
        )}
        {live.length === 0 ? <Empty icon={PackageCheck} title="No purchase orders" text={p.is_active ? 'Orders appear here once materials are reviewed.' : 'No orders were recorded for this job.'} /> : (
          <ul className="rows">
            {live.map((o) => {
              const issue = problem(o);
              return (
                <li key={o.po_number}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row-main">{o.supplier_name.replace(/ Demo$/, '')}</div>
                    <div className="row-sub num">{o.po_number} · {money(o.total_inc_gst)}</div>
                  </div>
                  <div className="row-right">
                    {issue ? <span className="problem-note">{issue}</span> : <Badge l={label(PO_STATUS, o.status)} />}
                    <span className="row-sub">{o.status === 'DELIVERED' ? 'Delivered' : `Expected ${date(o.expected_delivery_date)}`}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
