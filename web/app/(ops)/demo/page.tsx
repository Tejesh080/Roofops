import Link from 'next/link';
import { AlertTriangle, ArrowRight, FileCheck2, RefreshCcw, Workflow } from 'lucide-react';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import { getProject } from '@/lib/queries';
import { INVOICE_STATUS, label } from '@/lib/labels';
import { Badge } from '@/components/ui/Badge';
import { AskButton } from '@/components/copilot/AskButton';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Interview demo · RoofOps' };

export default async function DemoGuide() {
  await requireSession();
  const [p31, p11, p33, p4, p5] = await Promise.all(['PRJ-2026-0031', 'PRJ-2026-0011', 'PRJ-2026-0033', 'PRJ-2026-0004', 'PRJ-2026-0005'].map((n) => getProject(query, n)));
  const fiveReady = p5?.invoice_status === 'READY_TO_INVOICE';
  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="t-page">Interview demo</h1>
          <div className="sub">Four real scenarios from the live system. Each one takes about ninety seconds.</div>
        </div>
        <span className="chip">Rehearse with <span className="mono" style={{ marginLeft: 4 }}>npm run demo:status</span></span>
      </header>
      <div className="scenarios">
        <article className="card scenario">
          <span className="s-icon"><Workflow size={22} aria-hidden /></span>
          <div>
            <div className="no"><span className="big">01</span>QUOTE → PROJECT</div>
            <h2 className="s-title">An accepted quote becomes a project</h2>
            <p className="s-text">Show how an accepted quote automatically becomes a project, with its Google Drive folder and Airtable record, exactly once.</p>
            <ol className="steps-list">
              <li>Open PRJ-2026-0031: created from quote Q-2026-0041 the moment it was accepted.</li>
              <li>Live option: in Airtable, set a <em>Sent</em> quote to <em>Accepted</em> (<span className="mono">demo:status</span> names the next one). The project appears here in about 15 seconds.</li>
            </ol>
            <div className="s-links">
              <Link className="btn btn-primary btn-sm" href="/projects/PRJ-2026-0031">Open PRJ-2026-0031 <ArrowRight size={14} aria-hidden /></Link>
              {p31 && <Badge l={p31.drive_folder_url ? { text: 'Drive folder linked', tone: 'good' } : { text: 'No Drive folder', tone: 'warn' }} />}
            </div>
          </div>
        </article>

        <article className="card scenario">
          <span className="s-icon"><AlertTriangle size={22} aria-hidden /></span>
          <div>
            <div className="no"><span className="big">02</span>PROJECT AT RISK</div>
            <h2 className="s-title">Problems surface before they cost money</h2>
            <p className="s-text">Show how RoofOps surfaces supplier and schedule problems, and what to do next, without anyone digging through spreadsheets.</p>
            <ol className="steps-list">
              <li>Overview → “Needs attention today” → PRJ-2026-0011.</li>
              <li>Ask the Copilot: “Why is PRJ-2026-0011 at risk?”</li>
            </ol>
            <div className="s-links">
              <Link className="btn btn-primary btn-sm" href="/projects/PRJ-2026-0011">Open PRJ-2026-0011 <ArrowRight size={14} aria-hidden /></Link>
              <AskButton question="Why is PRJ-2026-0011 at risk?" text="Ask why" />
              {p11 && <Badge l={p11.risk_level === 'HIGH' ? { text: `${p11.risk_reasons.length} risk reasons`, tone: 'bad' } : { text: 'On track now', tone: 'good' }} />}
            </div>
          </div>
        </article>

        <article className="card scenario">
          <span className="s-icon"><RefreshCcw size={22} aria-hidden /></span>
          <div>
            <div className="no"><span className="big">03</span>FAILURE → RECOVERY</div>
            <h2 className="s-title">An outage without duplicated work</h2>
            <p className="s-text">Show how the system handles an external service outage: it retries, stops safely, and finishes once the service is back, without duplicating anything.</p>
            <ol className="steps-list">
              <li>Open PRJ-2026-0033 → Automation history: 5 attempts, stopped safely, retried by staff, completed.</li>
              <li>Point out “Repeated requests ignored safely”: nothing was created twice.</li>
            </ol>
            <div className="s-links">
              <Link className="btn btn-primary btn-sm" href="/projects/PRJ-2026-0033">Open PRJ-2026-0033 <ArrowRight size={14} aria-hidden /></Link>
              {p33 && <Badge l={p33.open_exceptions === 0 ? { text: 'Recovered', tone: 'good' } : { text: 'Issue open', tone: 'warn' }} />}
            </div>
          </div>
        </article>

        <article className="card scenario">
          <span className="s-icon"><FileCheck2 size={22} aria-hidden /></span>
          <div>
            <div className="no"><span className="big">04</span>FINANCE + HUMAN APPROVAL</div>
            <h2 className="s-title">AI prepares, a person approves, Xero gets a draft</h2>
            <p className="s-text">Show an invoice prepared by the AI and approved by a person before it reaches Xero.</p>
            <ol className="steps-list">
              <li>PRJ-2026-0004: approved in Airtable → one draft invoice in the Xero Demo Company, checked and recorded.</li>
              <li>Ask the Copilot: “Prepare invoice for PRJ-2026-0005”. It prepares a preview and stops for approval.</li>
            </ol>
            <div className="s-links">
              <Link className="btn btn-primary btn-sm" href="/projects/PRJ-2026-0004">Open PRJ-2026-0004 <ArrowRight size={14} aria-hidden /></Link>
              <AskButton question="Prepare invoice for PRJ-2026-0005" text="Prepare PRJ-2026-0005" />
              {p4 && <Badge l={label(INVOICE_STATUS, p4.invoice_status)} />}
              {p5 && <Badge l={fiveReady ? { text: 'PRJ-2026-0005 ready for live demo', tone: 'good' } : { text: `PRJ-2026-0005: ${label(INVOICE_STATUS, p5.invoice_status).text.toLowerCase()} (run demo:reset)`, tone: 'warn' }} />}
            </div>
          </div>
        </article>
      </div>
    </>
  );
}
