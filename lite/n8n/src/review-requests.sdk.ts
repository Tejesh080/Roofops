import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';
// @include common
// @include send
// [Lite] Google Review Requests. Daily (or on demand): every job that is Completed, Invoiced or Paid and has no Review
// Status yet gets AT MOST ONE review request, once it has been finished for the configured number of days. A review
// request is a commercial message: it needs the customer's permission for review requests (consent.reviewRequests:
// "express" = Review Opt-In or Marketing Opt-In, recorded with a source and date), a consented channel, and no opt-out.
// Otherwise the job is marked Skipped with the reason. Each job carries the outcome, and the Message Log is checked by
// Dedupe Key, so a repeated or half-finished run never asks the same customer twice.

const daily = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1.3, config: { name: 'Daily 10:00',
  parameters: { rule: { interval: [{ field: 'days', triggerAtHour: 10 }] } } }, output: [{}] });
const manual = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run Now', parameters: {} }, output: [{}] });

const findJobs = airtableList('Find Finished Jobs', T.jobs, "AND(OR({Stage}='Completed',{Stage}='Invoiced',{Stage}='Paid'),{Review Status}=BLANK())");
const contactFormula = code('Contact Formula', `
const jobs = records($input.first().json, 'find finished jobs');
const ids = Array.from(new Set(jobs.map((j) => ((j.fields || {}).Contact || [])[0]).filter(Boolean)));
return [{ json: { contactFormula: ids.length ? 'OR(' + ids.map((i) => "RECORD_ID()='" + formulaText(i) + "'").join(',') + ')' : 'FALSE()' } }];`);
const findContacts = airtableList('Find Contacts', T.contacts, '{{ $json.contactFormula }}');
const findSent = airtableList('Find Earlier Requests', T.messages, "AND({Workflow}='Review Request',{Status}!='Skipped')");
const plan = code('Plan Review Requests', `
const jobs = records($('Find Finished Jobs').first().json, 'find finished jobs');
const contacts = {}; records($('Find Contacts').first().json, 'find contacts').forEach((c) => { contacts[c.id] = c; });
const earlier = {}; records($input.first().json, 'find earlier requests').forEach((m) => { const f = m.fields || {}; if (ATTEMPTED.indexOf(f.Status) >= 0) earlier[f['Dedupe Key']] = f.Status; });
const sends = []; const logs = []; const updates = [];
const summary = { finished_jobs: jobs.length, planned: 0, skipped: 0, skip_reasons: {}, not_due_yet: 0, already_requested: 0, awaiting_retry: 0, deferred_to_next_run: 0, completed_at_recorded: 0 };
const due = NOW.getTime() - days(CFG.reviews.delayDays);
for (const j of jobs) {
  const f = j.fields || {}; const key = 'review:' + j.id;
  let finished = Date.parse(f['Completed At'] || '');
  // Staff often just drag the card to Completed: the first run that sees it finished records the date for them.
  if (!finished) { finished = NOW.getTime(); summary.completed_at_recorded++; updates.push({ table: 'jobs', id: j.id, fields: { 'Completed At': iso(NOW) } }); }
  if (finished > due) { summary.not_due_yet++; continue; }
  const before = earlier[key];
  if (before === 'Failed' || before === 'Unknown' || before === 'Sending') { summary.awaiting_retry++; continue; }   // a person decides (Retry Requested); never resent by itself
  if (before) { summary.already_requested++; updates.push({ table: 'jobs', id: j.id, fields: { 'Review Status': 'Sent' } }); continue; }   // asked before; only the job was not marked
  const c = contacts[(f.Contact || [])[0]] || null;
  const base = { prefix: 'RV', workflow: 'Review Request', purpose: 'Review', key: key, jobId: j.id, contactId: c ? c.id : null, demo: !!f['Demo Data'] };
  const skip = (why) => {
    summary.skipped++; summary.skip_reasons[why] = (summary.skip_reasons[why] || 0) + 1;
    updates.push({ table: 'jobs', id: j.id, fields: { 'Review Status': 'Skipped', 'Review Skip Reason': why } });
    logs.push(skipLog(Object.assign({ reason: why }, base)));
  };
  if (!c) { skip('no contact on the job'); continue; }
  const cf = c.fields || {};
  const ch = channelFor(cf);
  const why = permission(cf, 'Review') || ch.skip;
  if (why) { skip(why); continue; }
  if (summary.planned >= CFG.reviews.maxPerRun) { summary.deferred_to_next_run++; continue; }
  const v = vars(cf, f);
  summary.planned++;
  sends.push(outMessage(Object.assign({ channel: ch.channel, to: ch.to, subject: render(CFG.reviews.emailSubject, v), body: render(ch.channel === 'SMS' ? CFG.reviews.sms : CFG.reviews.email, v),
    onSuccess: [{ table: 'jobs', id: j.id, fields: { 'Review Status': 'Sent', 'Review Requested At': iso(NOW) } }] }, base)));
}
return [{ json: { sends: sends, logs: logs, updates: updates, summary: summary } }];`);
const summary = code('Review Run Summary', `
if ($('Write Updates').isExecuted) $('Write Updates').all().forEach((i) => records(i.json, 'write updates'));
const p = $('Plan Review Requests').first().json;
const o = $('Record Results').first().json.outcome;
return [{ json: Object.assign({ ok: true, ran_at: iso(NOW), mode: CFG.messaging.mode, sent: o.sent, failed: o.failed, unknown: o.unknown, duplicates: o.duplicates, blocked: o.blocked }, p.summary) }];`);
const send = sendPipeline('Plan Review Requests', summary);

let w = workflow('roofops-lite-review-requests', '[Lite] Google Review Requests')
  .add(daily).to(findJobs)
  .add(manual).to(findJobs)
  .add(findJobs).to(contactFormula).to(findContacts).to(findSent).to(plan).to(send.chain);
for (const [from, to] of send.links) w = w.add(from).to(to);
export default w;
