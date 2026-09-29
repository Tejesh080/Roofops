import Link from 'next/link';
import { ChevronRight, PackageCheck, Truck } from 'lucide-react';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import { listOpenOrders } from '@/lib/queries';
import { PO_STATUS, date, label, money } from '@/lib/labels';
import { Badge } from '@/components/ui/Badge';
import { CardHead, Empty } from '@/components/ui/Empty';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Materials · RoofOps' };

export default async function MaterialsPage() {
  await requireSession();
  const orders = await listOpenOrders(query);
  const overdue = orders.filter((o) => o.ack_overdue).length;
  const late = orders.filter((o) => !o.ack_overdue && o.after_start).length;
  const value = orders.reduce((s, o) => s + o.total_inc_gst, 0);
  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="t-page">Materials</h1>
          <div className="sub">Undelivered orders on active jobs · problems first</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span className="chip num">{orders.length} open orders · {money(value).replace(/\.\d\d$/, '')}</span>
          {overdue > 0 && <span className="badge bad"><span className="dot" aria-hidden />{overdue} confirmations overdue</span>}
          {late > 0 && <span className="badge warn"><span className="dot" aria-hidden />{late} arriving after start</span>}
        </div>
      </header>
      <section className="card">
        <CardHead icon={Truck} title="Open purchase orders" />
        {orders.length === 0 ? <Empty icon={PackageCheck} title="Everything is delivered" /> : (
          <div className="table-scroll">
            <table className="data">
              <thead><tr><th scope="col">Supplier</th><th scope="col">Project</th><th scope="col">Status</th><th scope="col">Expected</th><th scope="col">Job starts</th><th scope="col" className="right">Value</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.po_number}>
                    <td><div className="cell-main">{o.supplier_name.replace(/ Demo$/, '')}</div><div className="cell-sub num">{o.po_number}</div></td>
                    <td><Link className="pn" href={`/projects/${o.project_number}`}>{o.project_number}</Link><div className="cell-sub">{o.customer_name}</div></td>
                    <td>{o.ack_overdue ? <Badge l={{ text: 'Confirmation overdue', tone: 'bad' }} /> : o.after_start ? <Badge l={{ text: 'Arrives after start', tone: 'warn' }} /> : <Badge l={label(PO_STATUS, o.status)} />}</td>
                    <td className="num">{date(o.expected_delivery_date)}</td>
                    <td className="num">{date(o.planned_start_date)}</td>
                    <td className="num right">{money(o.total_inc_gst)}</td>
                    <td className="right"><Link href={`/projects/${o.project_number}`} aria-label={`Open ${o.project_number}`}><ChevronRight size={16} className="chev" aria-hidden /></Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
