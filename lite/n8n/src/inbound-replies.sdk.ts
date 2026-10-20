import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';
// @include common
// [Lite] Inbound Replies (part of Lead Reactivation). The messaging provider (or the TEST sink, or a person testing)
// POSTs a reply here. STOP (or another opt-out word) marks the contact Opted Out, removes marketing permission and is
// logged as Opt-Out: no Lite workflow will message them again. Any other reply is logged as Received and brings the
// person's open enquiry back to life (Last Activity now; a New Lead becomes Contacted) so staff can call them.

const hook = trigger({ type: 'n8n-nodes-base.webhook', version: 2, config: { name: 'Reply Webhook', ...HOOK_CRED,
  parameters: { httpMethod: 'POST', path: CONFIG.replies.webhookPath, responseMode: 'responseNode', ...HOOK_AUTH, options: {} } }, output: [{ body: {} }] });

const validate = code('Validate Reply', `
const b = ($input.first().json.body) || {};
const email = normEmail(b.from); const phone = normPhone(b.from);
const text = clean(b.text).slice(0, 2000);
const errors = [];
if (!email && !phone) errors.push('from must be the sender phone number or email address');
if (!text) errors.push('text is required');
if (errors.length) return [{ json: { ok: false, response: { status: 400, body: { ok: false, errors: errors } } } }];
return [{ json: { ok: true, reply: { from: email || phone, channel: email ? 'Email' : 'SMS', text: text, demo: b.demo === true },
  contactFormula: email ? "LOWER({Email})='" + formulaText(email) + "'" : "{Phone Normalized}='" + formulaText(phone) + "'" } }];`);
const valid = OK_IF('Reply Valid?', '{{ $json.ok }}');
const rejected = respond('Respond Reply Rejected');
const findContact = airtableList('Find Sender', T.contacts, '{{ $json.contactFormula }}');
const jobsFormula = code('Sender Jobs Formula', `
// The contact's jobs, through Airtable's back-link (Lite Contacts > Lite Jobs): also jobs that staff created by hand.
const c = records($input.first().json, 'find sender')[0];
const ids = c ? ((c.fields || {})['Lite Jobs'] || []) : [];
return [{ json: { jobFormula: ids.length ? 'OR(' + ids.map((i) => "RECORD_ID()='" + formulaText(i) + "'").join(',') + ')' : 'FALSE()' } }];`);
const findJobs = airtableList('Find Sender Jobs', T.jobs, '{{ $json.jobFormula }}');
const classify = code('Classify Reply', `
const R = $('Validate Reply').first().json.reply;
const contact = records($('Find Sender').first().json, 'find sender')[0] || null;
const jobs = records($input.first().json, 'find sender jobs');
const words = R.text.toUpperCase().replace(/[^A-Z ]/g, ' ').split(' ').filter(Boolean).join(' ');
const optOut = CFG.replies.optOutKeywords.some((k) => words === k || words.indexOf(k + ' ') === 0);
const recent = (x) => Date.parse((x.fields || {})['Lead Received At'] || '') || 0;
const open = jobs.filter((j) => ['Paid', 'Lost', 'Completed', 'Invoiced'].indexOf((j.fields || {}).Stage) < 0).sort((a, b) => recent(b) - recent(a));
const job = open[0] || null;
const contactUpdate = contact && optOut ? { typecast: false, records: [{ id: contact.id, fields: { 'Opted Out': true, 'Opted Out At': iso(NOW), 'Marketing Opt-In': false } }] } : null;
const jf = { 'Last Activity At': iso(NOW) };
if (job && job.fields.Stage === 'New Lead') jf.Stage = 'Contacted';
const jobUpdate = job && contact && !optOut ? { typecast: false, records: [{ id: job.id, fields: jf }] } : null;
const lf = { 'Log Ref': logRef('IN'), Workflow: 'Inbound Reply', Channel: R.channel, To: 'from ' + R.from, Body: R.text,
  Status: optOut ? 'Opt-Out' : 'Received', Reason: !contact ? 'sender is not in the CRM' : optOut ? 'contact opted out of all messages' : 'reply recorded; enquiry reopened for a call',
  'Dedupe Key': 'reply:' + R.from + ':' + iso(NOW), Provider: CFG.messaging.provider, 'Attempted At': iso(NOW), 'Demo Data': R.demo };
if (contact) lf.Contact = [contact.id];
if (job) lf.Job = [job.id];
return [{ json: { known: !!contact, optOut: optOut, contactUpdate: contactUpdate, jobUpdate: jobUpdate, hasContactUpdate: !!contactUpdate, hasJobUpdate: !!jobUpdate,
  job_ref: job ? job.fields['Job Ref'] : null, log: { typecast: false, records: [{ fields: lf }] } } }];`);
const needOptOut = OK_IF('Opt Out Contact?', '{{ $json.hasContactUpdate }}');
const optOutContact = airtableWrite('Opt Out Contact', 'PATCH', T.contacts, "{{ JSON.stringify($('Classify Reply').first().json.contactUpdate) }}");
const afterContact = code('After Contact', `
if ($('Opt Out Contact').isExecuted) records($('Opt Out Contact').first().json, 'opt out contact');
return [{ json: { hasJobUpdate: $('Classify Reply').first().json.hasJobUpdate } }];`);
const needJob = OK_IF('Reopen Job?', '{{ $json.hasJobUpdate }}');
const reopenJob = airtableWrite('Reopen Job', 'PATCH', T.jobs, "{{ JSON.stringify($('Classify Reply').first().json.jobUpdate) }}");
const logRequest = code('Log Reply Request', `
if ($('Reopen Job').isExecuted) records($('Reopen Job').first().json, 'reopen job');
return [{ json: { request: $('Classify Reply').first().json.log } }];`);
const writeLog = airtableWrite('Write Reply Log', 'POST', T.messages);
const replyResponse = code('Reply Response', `
records($input.first().json, 'write reply log');
const c = $('Classify Reply').first().json;
return [{ json: { response: { status: 200, body: { ok: true, known_contact: c.known, opted_out: c.optOut, job_ref: c.job_ref } } } }];`);
const respondOk = respond('Respond Reply');

export default workflow('roofops-lite-inbound-replies', '[Lite] Inbound Replies')
  .add(hook).to(validate).to(valid
    .onTrue(findContact.to(jobsFormula).to(findJobs).to(classify).to(needOptOut.onTrue(optOutContact.to(afterContact)).onFalse(afterContact)))
    .onFalse(rejected))
  .add(afterContact).to(needJob.onTrue(reopenJob.to(logRequest)).onFalse(logRequest))
  .add(logRequest).to(writeLog).to(replyResponse).to(respondOk);
