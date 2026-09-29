import Link from 'next/link';
import { Activity, Database, GitCompare, ListChecks, Radio, ShieldCheck } from 'lucide-react';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import {
  getBacklog, getChannelActivity, getConsistency, getDrift, getIntegrity, getLatestFindings, getLatestReconciliation, getServiceChecks,
} from '@/lib/queries';
import { HEALTH_TONE, SERVICES, consistencyLine, overallState, serviceState, type HealthState } from '@/lib/health';
import { Badge } from '@/components/ui/Badge';
import { CardHead, Empty } from '@/components/ui/Empty';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'System health · RoofOps' };

const S = (s: HealthState) => <Badge l={{ text: s, tone: HEALTH_TONE[s] }} />;
const SYSTEM_NAME: Record<string, string> = { AIRTABLE: 'Airtable ↔ RoofOps', GOOGLE_DRIVE: 'Google Drive ↔ RoofOps', XERO: 'Xero ↔ RoofOps' };
const CLASS_TEXT: Record<string, string> = {
  SAFE_AUTO_REPAIR: 'Repaired automatically', REQUIRES_HUMAN: 'Needs a person', EXTERNAL_MISSING: 'Missing in the other system',
  STALE_EVENT: 'Old change ignored', UNAUTHORIZED_STATE: 'Edited where it is not allowed', UNKNOWN: 'Unknown record',
};
const ACTION_TEXT: Record<string, string> = {
  APPLIED_TO_POSTGRES: 'applied through the business rules', REJECTED_AND_REPAIRED: 'refused, Airtable put back', REPAIRED_AIRTABLE: 'Airtable put back',
  EXCEPTION_OPENED: 'issue opened for a person', NONE_OBSERVE_ONLY: 'check only, nothing changed', NONE: 'no action',
};

export default async function HealthPage() {
  await requireSession();
  const [checks, cons, drift, run, findings, activity, integrity, backlog] = await Promise.all([
    getServiceChecks(query), getConsistency(query), getDrift(query), getLatestReconciliation(query), getLatestFindings(query),
    getChannelActivity(query), getIntegrity(query), getBacklog(query)]);
  const services = SERVICES.map((d) => ({ d, c: checks.find((x) => x.service === d.service) })).map((x) => ({ ...x, state: serviceState(x.c, x.d) }));
  const consistency = cons.map((c) => ({ c, ...consistencyLine(c) }));
  const fails = integrity.filter((i) => i.status === 'FAIL');
  const warns = integrity.filter((i) => i.status === 'WARNING');
  const integrityState: HealthState = fails.length ? 'Needs attention' : warns.length ? 'Degraded' : 'Healthy';
  const overall = overallState([...services.map((s) => s.state), ...consistency.map((c) => c.state), integrityState]);
  const lastAirtable = activity.find((a) => a.channel === 'airtable');

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="t-page">System health</h1>
          <div className="sub">Whether the connected systems are up, and whether they agree with RoofOps. Every state below comes from a recorded check.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{S(overall)}</div>
      </header>

      <div className="stack">
        <section className="card">
          <CardHead icon={Radio} title="Services" />
          <div className="card-body">
            <div className="svc-grid">
              {services.map(({ d, c, state }) => (
                <div className="svc" key={d.service}>
                  <div className="svc-top"><span className="svc-name">{d.name}</span>{S(state)}</div>
                  <div className="svc-note">{d.what}</div>
                  <div className="svc-note">
                    {c?.checked_at ? `Last checked ${c.checked_at}` : 'Never checked'}
                    {c && !c.ok && c.last_ok_at ? ` · last OK ${c.last_ok_at}` : ''}
                    {c && c.consecutive_failures > 0 ? ` · ${c.consecutive_failures} failed check(s) in a row` : ''}
                  </div>
                  {d.service === 'airtable_webhooks' && lastAirtable?.last_event_at && <div className="svc-note">Last change received {lastAirtable.last_event_at} · {lastAirtable.events_24h} in 24h</div>}
                  <div className="svc-note" style={{ opacity: 0.8 }}>Checked by: {d.how}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="grid g-3">
          {consistency.map(({ c, value, state, note }) => (
            <section className="card" key={c.system}>
              <CardHead icon={GitCompare} title={SYSTEM_NAME[c.system] ?? c.system}>{S(state)}</CardHead>
              <div className="card-body">
                <div className="cons-value">{value}</div>
                <div className="svc-note">{note}</div>
                <div className="svc-note">{c.checked_at ? `Checked ${c.checked_at}` : 'Not checked yet'}</div>
              </div>
            </section>
          ))}
        </div>

        <div className="grid g-2-1">
          <section className="card">
            <CardHead icon={Activity} title="Out of sync right now" />
            <div className="card-body">
              {drift.length === 0 ? <Empty icon={ShieldCheck} title="Nothing out of sync" text="Every value RoofOps last saw in Airtable matches RoofOps." /> : (
                <div className="table-scroll">
                  <table className="data">
                    <thead><tr><th>Record</th><th>Field</th><th>RoofOps (canonical)</th><th>Airtable shows</th><th>Seen</th></tr></thead>
                    <tbody>
                      {drift.map((d, i) => (
                        <tr key={i}>
                          <td>{d.entity_type === 'project' ? <Link href={`/projects/${d.business_key}`}>{d.business_key}</Link> : d.business_key}</td>
                          <td>{d.field}</td><td>{d.canonical_value ?? '—'}</td><td>{d.airtable_value ?? '—'}</td><td>{d.observed_at}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          <section className="card" style={{ alignSelf: 'start' }}>
            <CardHead icon={Database} title="Backlog" />
            <div className="card-body">
              <div className="inv-row"><span className="t-label">Issues</span><span>{backlog.open_exceptions ? <Link href="/automation">{backlog.open_exceptions} waiting for a person</Link> : 'None open'}</span></div>
              <div className="inv-row"><span className="t-label">Stopped</span><span>{backlog.dead_letters ? `${backlog.dead_letters} automation step(s) stopped after retries` : 'No stopped automation steps'}</span></div>
              <div className="inv-row"><span className="t-label">Last check</span><span>{run ? `${run.finished_at} (${run.mode === 'observe' ? 'check only' : 'check and repair'}, ${run.trigger === 'schedule' ? 'nightly' : 'manual'})` : 'Never'}</span></div>
              {run?.webhooks?.map((w) => (
                <div className="inv-row" key={w.url}>
                  <span className="t-label">Alerts</span>
                  <span>{w.url.split('/').pop()}: {w.state === 'OK' ? `active, ${w.hours_left ?? '?'}h until renewal` : w.state.toLowerCase()}{w.unread_payloads ? `, ${w.unread_payloads} waiting` : ''}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="grid g-2-1">
          <section className="card">
            <CardHead icon={GitCompare} title="Last full check: what was found" />
            <div className="card-body">
              {findings.length === 0 ? <Empty icon={ShieldCheck} title={run ? 'Everything agreed' : 'No full check has run yet'} /> : (
                <div className="table-scroll">
                  <table className="data">
                    <thead><tr><th>System</th><th>Record</th><th>Field</th><th>RoofOps</th><th>Other system</th><th>Finding</th></tr></thead>
                    <tbody>
                      {findings.map((f, i) => (
                        <tr key={i}>
                          <td>{f.system === 'GOOGLE_DRIVE' || f.system === 'DRIVE' ? 'Drive' : f.system.charAt(0) + f.system.slice(1).toLowerCase()}</td>
                          <td>{f.entity_ref ?? '—'}</td><td>{f.field ?? '—'}</td><td>{f.expected ?? '—'}</td><td>{f.actual ?? '—'}</td>
                          <td><Badge l={{ text: CLASS_TEXT[f.classification] ?? f.classification, tone: ['REQUIRES_HUMAN', 'EXTERNAL_MISSING', 'UNKNOWN'].includes(f.classification) ? 'bad' : 'warn' }} />
                            <div className="row-sub">{ACTION_TEXT[f.action] ?? f.action}</div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          <section className="card" style={{ alignSelf: 'start' }}>
            <CardHead icon={ListChecks} title="Business rules">{S(integrityState)}</CardHead>
            <div className="card-body">
              <div className="svc-note" style={{ marginBottom: 8 }}>{integrity.length - fails.length - warns.length} pass · {warns.length} to look at · {fails.length} broken</div>
              {[...fails, ...warns].map((i) => (
                <div className="inv-row" key={`${i.entity}.${i.check_key}`}>
                  <Badge l={{ text: i.status === 'FAIL' ? 'Broken' : 'Look at', tone: i.status === 'FAIL' ? 'bad' : 'warn' }} />
                  <span>{i.detail}{i.refs?.length ? `: ${i.refs.slice(0, 4).join(', ')}${i.refs.length > 4 ? '…' : ''}` : ''}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
