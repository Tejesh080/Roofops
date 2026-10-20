import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';
// @include common
// @include batch-tail
// [Lite] Google Review Requests. Daily (or on demand): every job that is Completed, Invoiced or Paid and has no Review
// Status yet gets AT MOST ONE review request, once it has been finished for the configured number of days. The request
// goes only on a channel the customer consented to and never to someone who opted out; otherwise the job is marked
// Skipped with the reason. Each job carries the outcome (Review Status), and the Message Log is checked too, so a run
// that is repeated, or that stopped half-way, never asks the same customer twice. TEST sink: nothing is really sent.

const daily = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1.3, config: { name: 'Daily 10:00',
  parameters: { rule: { interval: [{ field: 'days', triggerAtHour: 10 }] } } }, output: [{}] });
const manual = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run Now', parameters: {} }, output: [{}] });

const findJobs = airtableList('Find Finished Jobs', T.jobs, "AND(OR({Stage}='Completed',{Stage}='Invoiced',{Stage}='Paid'),{Review Status}=BLANK())");
const contactFormula = code('Contact Formula', `
const jobs = records($input.first().json, 'find finished jobs');
const ids = Array.from(new Set(jobs.map((j) => ((j.fields || {}).Contact || [])[0]).filter(Boolean)));
return [{ json: { contactFormula: ids.length ? 'OR(' + ids.map((i) => "RECORD_ID()='" + formulaText(i) + "'").join(',') + ')' : 'FALSE()' } }];`);
const findContacts = airtableList('Find Contacts', T.contacts, '{{ $json.contactFormula }}');
const findSent = airtableList('Find Sent Reviews', T.messages, "AND({Workflow}='Review Request',{Status}='Simulated Sent')");
const plan = code('Plan Review Requests', `
const jobs = records($('Find Finished Jobs').first().json, 'find finished jobs');
const contacts = {}; records($('Find Contacts').first().json, 'find contacts').forEach((c) => { contacts[c.id] = c; });
const sent = new Set(records($input.first().json, 'find sent reviews').map((m) => (m.fields || {})['Dedupe Key']));
const logs = []; const updates = [];
const summary = { finished_jobs: jobs.length, sent: 0, skipped: 0, skip_reasons: {}, not_due_yet: 0, already_requested: 0, deferred_to_next_run: 0 };
const due = NOW.getTime() - days(CFG.reviews.delayDays);
for (const j of jobs) {
  const f = j.fields || {}; const key = 'review:' + j.id;
  const finished = Date.parse(f['Completed At'] || '');
  if (!finished || finished > due) { summary.not_due_yet++; continue; }
  if (sent.has(key)) { summary.already_requested++; updates.push({ id: j.id, fields: { 'Review Status': 'Sent' } }); continue; }   // asked before; only the job was not marked
  const c = contacts[(f.Contact || [])[0]] || null;
  const skip = (why) => {
    summary.skipped++; summary.skip_reasons[why] = (summary.skip_reasons[why] || 0) + 1;
    updates.push({ id: j.id, fields: { 'Review Status': 'Skipped', 'Review Skip Reason': why } });
    const lf = { 'Log Ref': logRef('RV'), Workflow: 'Review Request', Job: [j.id], Status: 'Skipped', Reason: why, 'Dedupe Key': key + ':skipped',
      Provider: CFG.messaging.provider, 'Attempted At': iso(NOW), 'Demo Data': !!f['Demo Data'] };
    if (c) lf.Contact = [c.id];
    logs.push({ fields: lf });
  };
  if (!c) { skip('no contact on the job'); continue; }
  const ch = channelFor(c.fields || {});
  if (ch.skip) { skip(ch.skip); continue; }
  if (summary.sent >= CFG.reviews.maxPerRun) { summary.deferred_to_next_run++; continue; }
  const v = vars(c.fields || {}, f);
  const subject = ch.channel === 'Email' ? render(CFG.reviews.emailSubject, v) : null;
  const d = deliver(ch.channel, ch.to, subject, render(ch.channel === 'SMS' ? CFG.reviews.sms : CFG.reviews.email, v));
  summary.sent++;
  logs.push({ fields: { 'Log Ref': logRef('RV'), Workflow: 'Review Request', Job: [j.id], Contact: [c.id], Channel: d.channel, To: d.to,
    Body: (d.subject ? 'Subject: ' + d.subject + '\\n\\n' : '') + d.body, Status: d.status, 'Dedupe Key': key, Provider: d.provider,
    'Attempted At': iso(NOW), 'Demo Data': !!f['Demo Data'] } });
  updates.push({ id: j.id, fields: { 'Review Status': 'Sent', 'Review Requested At': iso(NOW) } });
}
return [{ json: { logs: logs, updates: updates, summary: summary } }];`);
const t = tail('Plan Review Requests', 'Review Run Summary');

export default workflow('roofops-lite-review-requests', '[Lite] Google Review Requests')
  .add(daily).to(findJobs)
  .add(manual).to(findJobs)
  .add(findJobs).to(contactFormula).to(findContacts).to(findSent).to(plan).to(t.logBatches).to(t.anyLogs
    .onTrue(t.writeLog.to(t.updateBatches))
    .onFalse(t.updateBatches))
  .add(t.updateBatches).to(t.anyUpdates.onTrue(t.updateJobs.to(t.summary)).onFalse(t.summary));
