import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';
// @include common
// @include send
// [Lite] Lead Reactivation. Weekly (or on demand): enquiries that went quiet (still New Lead / Contacted / Quoted, no
// activity for the configured number of days) get ONE personalised follow-up. This is marketing: it needs Marketing
// Opt-In recorded with a source and date (no consent is assumed for older contacts), a consented channel, no opt-out,
// and no follow-up within the cooldown. At most maxPerRun per run, longest-waiting first. Replies and STOPs come back
// through [Lite] Inbound Replies.

const weekly = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1.3, config: { name: 'Weekly Monday 09:00',
  parameters: { rule: { interval: [{ field: 'weeks', triggerAtDay: [1], triggerAtHour: 9 }] } } }, output: [{}] });
const manual = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run Now', parameters: {} }, output: [{}] });

const findJobs = airtableList('Find Quiet Leads', T.jobs, 'OR(' + CONFIG.reactivation.stages.map((s) => "{Stage}='" + s + "'").join(',') + ')');
const contactFormula = code('Contact Formula', `
const jobs = records($input.first().json, 'find quiet leads');
const ids = Array.from(new Set(jobs.map((j) => ((j.fields || {}).Contact || [])[0]).filter(Boolean)));
return [{ json: { contactFormula: ids.length ? 'OR(' + ids.map((i) => "RECORD_ID()='" + formulaText(i) + "'").join(',') + ')' : 'FALSE()' } }];`);
const findContacts = airtableList('Find Contacts', T.contacts, '{{ $json.contactFormula }}');
const findSent = airtableList('Find Earlier Follow-Ups', T.messages, "AND({Workflow}='Reactivation',{Status}!='Skipped')");
const plan = code('Plan Reactivation', `
const jobs = records($('Find Quiet Leads').first().json, 'find quiet leads');
const contacts = {}; records($('Find Contacts').first().json, 'find contacts').forEach((c) => { contacts[c.id] = c; });
// Every earlier follow-up for a job counts, whatever month it was in (the Dedupe Key carries the month, the Job link does not).
const earlier = {}; records($input.first().json, 'find earlier follow-ups').forEach((m) => { const f = m.fields || {}; if (ATTEMPTED.indexOf(f.Status) < 0) return;
  const jobId = (f.Job || [])[0] || clean(f['Dedupe Key']).split(':')[1]; (earlier[jobId] = earlier[jobId] || []).push(f); });
const recent = (f) => NOW.getTime() - (Date.parse(f['Attempted At'] || '') || 0) < days(CFG.reactivation.cooldownDays);
const sends = [];
const summary = { open_leads: jobs.length, planned: 0, still_active: 0, excluded: 0, exclusion_reasons: {}, deferred_to_next_run: 0 };
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
  const before = earlier[j.id] || [];
  // An attempt with no confirmed outcome (Sending, Unknown) holds the job until someone decides; a failed one, for the cooldown.
  if (before.some((x) => x.Status === 'Sending' || x.Status === 'Unknown' || (x.Status === 'Failed' && recent(x)))) { exclude('earlier attempt awaits a retry decision'); continue; }
  if (before.some(recent)) { exclude('followed up within the cooldown'); continue; }
  const key = 'reactivation:' + j.id + ':' + period;
  const c = contacts[(f.Contact || [])[0]] || null;
  if (!c) { exclude('no contact on the job'); continue; }
  const cf = c.fields || {};
  const ch = channelFor(cf);
  const why = permission(cf, 'Marketing') || ch.skip;
  if (why) { exclude(why); continue; }
  if (summary.planned >= CFG.reactivation.maxPerRun) { summary.deferred_to_next_run++; continue; }
  const v = vars(cf, f);
  summary.planned++;
  sends.push(outMessage({ prefix: 'RA', workflow: 'Reactivation', purpose: 'Marketing', key: key, jobId: j.id, contactId: c.id, demo: !!f['Demo Data'],
    channel: ch.channel, to: ch.to, subject: render(CFG.reactivation.emailSubject, v), body: render(ch.channel === 'SMS' ? CFG.reactivation.sms : CFG.reactivation.email, v),
    onSuccess: [{ table: 'jobs', id: j.id, fields: { 'Reactivation Sent At': iso(NOW), 'Reactivation Count': (Number(f['Reactivation Count']) || 0) + 1 } }] }));
}
return [{ json: { sends: sends, logs: [], updates: [], summary: summary } }];`);
const summary = code('Reactivation Run Summary', `
if ($('Write Updates').isExecuted) $('Write Updates').all().forEach((i) => records(i.json, 'write updates'));
const p = $('Plan Reactivation').first().json;
const o = $('Record Results').first().json.outcome;
return [{ json: Object.assign({ ok: true, ran_at: iso(NOW), mode: CFG.messaging.mode, sent: o.sent, failed: o.failed, unknown: o.unknown, duplicates: o.duplicates, blocked: o.blocked }, p.summary) }];`);
const send = sendPipeline('Plan Reactivation', summary);

let w = workflow('roofops-lite-lead-reactivation', '[Lite] Lead Reactivation')
  .add(weekly).to(findJobs)
  .add(manual).to(findJobs)
  .add(findJobs).to(contactFormula).to(findContacts).to(findSent).to(plan).to(send.chain);
for (const [from, to] of send.links) w = w.add(from).to(to);
export default w;
