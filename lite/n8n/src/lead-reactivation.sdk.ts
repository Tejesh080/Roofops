import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';
// @include common
// @include batch-tail
// [Lite] Lead Reactivation. Weekly (or on demand): enquiries that went quiet (still New Lead / Contacted / Quoted, no
// activity for the configured number of days) get ONE personalised follow-up, but only if the person explicitly opted
// in to marketing, has not opted out, consented to the channel, and was not reactivated within the cooldown. At most
// maxPerRun per run. Replies and STOPs come back through [Lite] Inbound Replies. TEST sink: nothing is really sent.

const weekly = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1.3, config: { name: 'Weekly Monday 09:00',
  parameters: { rule: { interval: [{ field: 'weeks', triggerAtDay: [1], triggerAtHour: 9 }] } } }, output: [{}] });
const manual = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run Now', parameters: {} }, output: [{}] });

const findJobs = airtableList('Find Quiet Leads', T.jobs, 'OR(' + CONFIG.reactivation.stages.map((s) => "{Stage}='" + s + "'").join(',') + ')');
const contactFormula = code('Contact Formula', `
const jobs = records($input.first().json, 'find quiet leads');
const ids = Array.from(new Set(jobs.map((j) => ((j.fields || {}).Contact || [])[0]).filter(Boolean)));
return [{ json: { contactFormula: ids.length ? 'OR(' + ids.map((i) => "RECORD_ID()='" + formulaText(i) + "'").join(',') + ')' : 'FALSE()' } }];`);
const findContacts = airtableList('Find Contacts', T.contacts, '{{ $json.contactFormula }}');
const findSent = airtableList('Find Sent Reactivations', T.messages, "AND({Workflow}='Reactivation',{Status}='Simulated Sent')");
const plan = code('Plan Reactivation', `
const jobs = records($('Find Quiet Leads').first().json, 'find quiet leads');
const contacts = {}; records($('Find Contacts').first().json, 'find contacts').forEach((c) => { contacts[c.id] = c; });
const sent = new Set(records($input.first().json, 'find sent reactivations').map((m) => (m.fields || {})['Dedupe Key']));
const logs = []; const updates = [];
const summary = { open_leads: jobs.length, sent: 0, still_active: 0, excluded: 0, exclusion_reasons: {}, deferred_to_next_run: 0 };
const exclude = (why) => { summary.excluded++; summary.exclusion_reasons[why] = (summary.exclusion_reasons[why] || 0) + 1; };
const period = iso(NOW).slice(0, 7);
// Oldest activity first, so the longest-waiting people are followed up first when the run is capped.
const lastOf = (f) => Date.parse(f['Last Activity At'] || f['Lead Received At'] || '');
jobs.sort((a, b) => (lastOf(a.fields || {}) || 0) - (lastOf(b.fields || {}) || 0));
for (const j of jobs) {
  const f = j.fields || {};
  const last = lastOf(f);
  if (!last || NOW.getTime() - last < days(CFG.reactivation.inactivityDays)) { summary.still_active++; continue; }
  const prev = Date.parse(f['Reactivation Sent At'] || '');
  if (prev && NOW.getTime() - prev < days(CFG.reactivation.cooldownDays)) { exclude('followed up within the cooldown'); continue; }
  const key = 'reactivation:' + j.id + ':' + period;
  if (sent.has(key)) { exclude('already followed up this month'); continue; }
  const c = contacts[(f.Contact || [])[0]] || null;
  if (!c) { exclude('no contact on the job'); continue; }
  const cf = c.fields || {};
  if (cf['Opted Out']) { exclude('opted out'); continue; }
  if (!cf['Marketing Opt-In']) { exclude('no marketing permission'); continue; }
  const ch = channelFor(cf);
  if (ch.skip) { exclude(ch.skip); continue; }
  if (summary.sent >= CFG.reactivation.maxPerRun) { summary.deferred_to_next_run++; continue; }
  const v = vars(cf, f);
  const subject = ch.channel === 'Email' ? render(CFG.reactivation.emailSubject, v) : null;
  const d = deliver(ch.channel, ch.to, subject, render(ch.channel === 'SMS' ? CFG.reactivation.sms : CFG.reactivation.email, v));
  summary.sent++;
  logs.push({ fields: { 'Log Ref': logRef('RA'), Workflow: 'Reactivation', Job: [j.id], Contact: [c.id], Channel: d.channel, To: d.to,
    Body: (d.subject ? 'Subject: ' + d.subject + '\\n\\n' : '') + d.body, Status: d.status, 'Dedupe Key': key, Provider: d.provider,
    'Attempted At': iso(NOW), 'Demo Data': !!f['Demo Data'] } });
  updates.push({ id: j.id, fields: { 'Reactivation Sent At': iso(NOW), 'Reactivation Count': (Number(f['Reactivation Count']) || 0) + 1 } });
}
return [{ json: { logs: logs, updates: updates, summary: summary } }];`);
const t = tail('Plan Reactivation', 'Reactivation Run Summary');

export default workflow('roofops-lite-lead-reactivation', '[Lite] Lead Reactivation')
  .add(weekly).to(findJobs)
  .add(manual).to(findJobs)
  .add(findJobs).to(contactFormula).to(findContacts).to(findSent).to(plan).to(t.logBatches).to(t.anyLogs
    .onTrue(t.writeLog.to(t.updateBatches))
    .onFalse(t.updateBatches))
  .add(t.updateBatches).to(t.anyUpdates.onTrue(t.updateJobs.to(t.summary)).onFalse(t.summary));
