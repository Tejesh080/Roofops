import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { getChecklist, getExceptions, getInvoices, getProject, getPurchaseOrders, getTimeline } from '@/lib/queries';
import {
  CHECK_STATUS, EXCEPTION_KIND, EXCEPTION_STATUS, INVOICE_LINE_STATUS, INVOICE_STATUS, JOB_TYPE, MATERIAL_STATUS, PO_STATUS,
  PROJECT_STAGE, RISK_REASON, actorName, airtableProjectUrl, date, label, money, outcomeLabel, plainIssue, plainReason, plainResolution, timelineTitle,
} from '@/lib/labels';
import { Pill } from '@/components/Pill';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  const p = await getProject(query, decodeURIComponent(number).toUpperCase());
  if (!p) notFound();
  const n = p.project_number;
  const [checklist, pos, invoices, history, issues] = await Promise.all([
    getChecklist(query, n), getPurchaseOrders(query, n), getInvoices(query, n), getTimeline(query, n, 80), getExceptions(query, { project: n }),
  ]);
  const openIssues = issues.filter((e) => e.resolution_status === 'OPEN' || e.resolution_status === 'RETRY_QUEUED');
  const atRisk = p.is_active && p.risk_level === 'HIGH';
  const airtable = airtableProjectUrl(p.airtable_record_id);

  return (
    <>
      <Link href="/" className="back">← Dashboard</Link>
      <div className="page-head">
        <div>
          <h1>{n} · {p.customer_name}</h1>
          <div className="muted">{p.site_address} · {JOB_TYPE(p.job_type)}{p.project_manager ? ` · PM ${p.project_manager}` : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Pill l={label(PROJECT_STAGE, p.status)} />
          {p.is_active && <Pill l={atRisk ? { text: 'At risk', tone: 'bad' } : { text: 'On track', tone: 'good' }} />}
        </div>
      </div>

      <div className="stack">
        {atRisk && (
          <div className="alert bad">
            <strong>Why this project is at risk</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {p.risk_reasons.map((r) => <li key={r}>{RISK_REASON[r] ?? r}</li>)}
              {p.delay_reason && <li>Project manager note: {p.delay_reason}</li>}
            </ul>
          </div>
        )}
        {openIssues.length > 0 && (
          <div className="alert warn"><strong>{openIssues.length} automation issue{openIssues.length > 1 ? 's' : ''} need{openIssues.length > 1 ? '' : 's'} attention</strong> (see “Automation issues” below).</div>
        )}
        {p.invoice_status === 'AWAITING_APPROVAL' && (
          <div className="alert info"><strong>Invoice {money(p.invoice_amount_inc_gst)} is waiting for approval</strong> ({p.pending_approval_number}). A finance approver approves it in Airtable; RoofOps then creates the draft in Xero.
            {airtable && <> <a href={airtable} target="_blank" rel="noreferrer">Open in Airtable →</a></>}</div>
        )}

        <div className="grid-3">
          <section className="card">
            <h3>Customer</h3>
            <dl className="kv">
              <dt>Name</dt><dd>{p.customer_name}</dd>
              <dt>Customer no.</dt><dd>{p.customer_number}</dd>
              <dt>Type</dt><dd>{p.customer_type ? p.customer_type.charAt(0) + p.customer_type.slice(1).toLowerCase() : '—'}</dd>
              <dt>Site</dt><dd>{p.site_address}</dd>
            </dl>
          </section>
          <section className="card">
            <h3>Quote</h3>
            <dl className="kv">
              <dt>Quote</dt><dd>{p.quote_number}{p.quote_version ? ` (version ${p.quote_version})` : ''}</dd>
              <dt>Value</dt><dd>{money(p.quote_total_inc_gst)} inc GST</dd>
              <dt>Work</dt><dd>{JOB_TYPE(p.job_type)}</dd>
              <dt>Accepted</dt><dd>{date(p.accepted_on)}</dd>
            </dl>
          </section>
          <section className="card">
            <h3>Schedule</h3>
            <dl className="kv">
              <dt>Planned start</dt><dd>{date(p.planned_start_date)}</dd>
              <dt>Planned finish</dt><dd>{date(p.planned_completion_date)}</dd>
              <dt>Started</dt><dd>{date(p.actual_start_date)}</dd>
              <dt>Finished</dt><dd>{date(p.actual_completion_date)}</dd>
            </dl>
          </section>
        </div>

        <div className="grid-2">
          <section className="card">
            <h2>Materials <Pill l={label(MATERIAL_STATUS, p.material_status)} /></h2>
            {pos.length === 0 ? <p className="muted small">No purchase orders for this project.</p> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Order</th><th>Supplier</th><th>Status</th><th>Expected</th><th>Value</th></tr></thead>
                <tbody>{pos.map((o) => (
                  <tr key={o.po_number}>
                    <td>{o.po_number}</td><td>{o.supplier_name}</td>
                    <td><Pill l={label(PO_STATUS, o.status)} />{o.ack_overdue && <div className="risk-reason">Confirmation overdue</div>}</td>
                    <td>{date(o.expected_delivery_date)}</td><td>{money(o.total_inc_gst)}</td>
                  </tr>))}
                </tbody>
              </table></div>
            )}
            <h3 style={{ marginTop: 16 }}>Checklist and material review</h3>
            {checklist.length === 0 ? <p className="muted small">No checklist recorded for this project (imported history).</p> : (
              <ul className="list">
                {checklist.map((c, i) => (
                  <li key={i}>
                    <span>{c.title}{c.kind === 'TASK' && c.due_on && <span className="small muted"> · due {date(c.due_on)}{c.assignee ? ` · ${c.assignee}` : ''}</span>}</span>
                    <Pill l={label(CHECK_STATUS, c.status)} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h2>Invoicing <Pill l={label(INVOICE_STATUS, p.invoice_status)} /></h2>
            <dl className="kv">
              {p.invoice_amount_inc_gst !== null && <><dt>{p.final_invoice_number ? 'Final invoice' : 'Amount to invoice'}</dt><dd>{money(p.invoice_amount_inc_gst)} inc GST</dd></>}
              {p.final_invoice_number && <><dt>RoofOps invoice</dt><dd>{p.final_invoice_number}</dd></>}
              {p.xero_invoice_number && <><dt>Xero invoice</dt><dd>{p.xero_invoice_number} <span className="small muted">(draft, Xero Demo Company)</span></dd></>}
              {p.xero_invoice_id && <><dt>Xero invoice ID</dt><dd className="small" style={{ wordBreak: 'break-all' }}>{p.xero_invoice_id}</dd></>}
              {p.invoice_blocker && <><dt>Why not ready</dt><dd>{p.invoice_blocker}</dd></>}
              {p.outstanding_inc_gst > 0 && <><dt>Owed to us</dt><dd>{money(p.outstanding_inc_gst)}{p.has_overdue_invoice ? ' (overdue)' : ''}</dd></>}
            </dl>
            {p.invoice_status === 'READY_TO_INVOICE' && <p className="small muted">Ask the copilot “Prepare invoice for {n}” to prepare it for approval.</p>}
            <h3 style={{ marginTop: 16 }}>Invoices</h3>
            {invoices.length === 0 ? <p className="muted small">No invoices yet.</p> : (
              <ul className="list">
                {invoices.map((i) => (
                  <li key={i.invoice_number}>
                    <span>{i.invoice_number} <span className="small muted">· {date(i.issue_date)}</span></span>
                    <span>{money(i.total_inc_gst)} <Pill l={i.is_overdue ? { text: 'Overdue', tone: 'bad' } : label(INVOICE_LINE_STATUS, i.status)} /></span>
                  </li>
                ))}
              </ul>
            )}
            <h3 style={{ marginTop: 16 }}>Links</h3>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {p.drive_folder_url ? <a className="btn secondary" href={p.drive_folder_url} target="_blank" rel="noreferrer">Google Drive folder</a>
                : <span className="small muted">No Google Drive folder (created automatically for new projects).</span>}
              {airtable && <a className="btn secondary" href={airtable} target="_blank" rel="noreferrer">Airtable record</a>}
            </div>
          </section>
        </div>

        <section className="card">
          <h2>Automation issues</h2>
          {issues.length === 0 ? <p className="muted small">No automation issues for this project.</p> : (
            <ul className="list">
              {issues.map((e) => (
                <li key={e.exception_number}>
                  <div>
                    <strong>{EXCEPTION_KIND[e.error_class] ?? e.error_class}</strong>
                    <div className="small muted">{plainIssue(e.error_message)}</div>
                    <div className="small muted">Raised {e.first_failed_at} · tried {e.attempt_count}× · ref {e.exception_number}{e.resolution_note ? ` · ${plainResolution(e.resolution_note)}` : ''}</div>
                  </div>
                  <Pill l={label(EXCEPTION_STATUS, e.resolution_status)} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2>Automation history</h2>
          {history.length === 0 ? <p className="muted small">No history recorded.</p> : (
            <ul className="timeline">
              {history.map((h, i) => (
                <li key={i}>
                  <span className="when">{h.occurred_at}</span>
                  <span>
                    {timelineTitle(h.kind)}
                    <div className="note">{[actorName(h.actor, h.channel), h.reference !== n ? h.reference : null, plainReason(h.reason)].filter(Boolean).join(' · ')}</div>
                  </span>
                  <span><Pill l={outcomeLabel(h.kind, h.status)} /></span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
