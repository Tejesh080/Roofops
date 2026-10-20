import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';
// @include common
// [Lite] Inbound Replies (and, with Twilio, delivery receipts). Twilio POSTs every SMS a person sends to the business
// number here, and every status change of a message Lite sent (?event=status). In twilio mode each request is checked
// first: the X-Twilio-Signature (HMAC-SHA1 of the URL and parameters with the Auth Token from an n8n Variable), or n8n
// Basic Auth, and the Account SID. A refused request changes nothing.
// - A reply: STOP (or another opt-out word) marks the contact Opted Out, removes marketing permission and is logged as
//   Opt-Out; no Lite workflow messages them again. START is logged for staff (no automatic re-subscribe). Any other reply
//   is logged as Received and brings the person's open enquiry back to life (Last Activity now; a New Lead becomes Contacted).
// - A delivery receipt: the message's log row becomes Delivered or Failed (with Twilio's error code); a Twilio
//   "unsubscribed" error opts the contact out.

const hook = trigger({ type: 'n8n-nodes-base.webhook', version: 2, config: { name: 'Reply Webhook', ...REPLY_CRED,
  parameters: { httpMethod: 'POST', path: CONFIG.replies.webhookPath, responseMode: 'responseNode', ...REPLY_AUTH, options: {} } }, output: [{ body: {} }] });

const validate = code('Verify Request', `
const h = $input.first().json;
const b = h.body || {}; const q = h.query || {};
const TW = CFG.messaging.mode === 'twilio' ? CFG.messaging.twilio : null;
const reject = (status, why) => [{ json: { ok: false, response: { status: status, body: { ok: false, errors: [why] }, text: why } } }];
let reply;
if (TW) {
  const event = q.event === 'status' ? 'status' : 'message';
  if (Object.keys(q).some((k) => k !== 'event')) return reject(403, 'unexpected query parameters');
  if (TW.inboundAuth === 'signature') {
    const secret = $vars[TW.signatureVariable];
    if (!secret) return reject(503, 'Twilio signature secret is not configured (n8n Variable ' + TW.signatureVariable + ')');
    // Twilio signs the exact URL it calls plus every POST parameter, sorted by name.
    const url = CFG.n8n.baseUrl + '/webhook/' + CFG.replies.webhookPath + (event === 'status' ? '?event=status' : '');
    const data = url + Object.keys(b).sort().map((k) => k + String(b[k])).join('');
    const expected = require('crypto').createHmac('sha1', secret).update(data, 'utf8').digest('base64');
    const got = String((h.headers || {})['x-twilio-signature'] || '');
    let diff = got.length ^ expected.length;
    for (let i = 0; i < Math.min(got.length, expected.length); i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
    if (!got || diff !== 0) return reject(403, 'invalid Twilio signature');
  }
  if (b.AccountSid !== TW.accountSid) return reject(403, 'request is not for this Twilio account');
  if (event === 'status') {
    if (!/^(SM|MM)[0-9a-f]{32}$/.test(clean(b.MessageSid))) return reject(400, 'MessageSid is missing');
    return [{ json: { ok: true, event: 'status', status: { sid: clean(b.MessageSid), status: clean(b.MessageStatus).toLowerCase(), errorCode: clean(b.ErrorCode) || null },
      formula: "{Provider Message ID}='" + formulaText(b.MessageSid) + "'" } }];
  }
  reply = { from: clean(b.From), text: clean(b.Body), sid: clean(b.MessageSid) || null, demo: false };
} else reply = { from: clean(b.from), text: clean(b.text), sid: null, demo: b.demo === true };
const email = normEmail(reply.from); const phone = normPhone(reply.from);
const text = reply.text.slice(0, 2000);
const errors = [];
if (!email && !phone) errors.push('from must be the sender phone number or email address');
if (!text) errors.push('text is required');
if (errors.length) return reject(400, errors.join('; '));
return [{ json: { ok: true, event: 'message', reply: { from: email || phone, channel: email ? 'Email' : 'SMS', text: text, sid: reply.sid, demo: reply.demo },
  contactFormula: email ? "LOWER({Email})='" + formulaText(email) + "'" : "{Phone Normalized}='" + formulaText(phone) + "'" } }];`);
const valid = OK_IF('Request Valid?', '{{ $json.ok }}');
const rejected = respond('Respond Reply Rejected');

// Delivery receipts (twilio mode only).
const isStatus = OK_IF('Delivery Receipt?', "{{ $json.event === 'status' }}");
const findSent = airtableList('Find Sent Message', T.messages, '{{ $json.formula }}');
const applyStatus = code('Apply Delivery Status', `
const s = $('Verify Request').first().json.status;
const rows = records($input.first().json, 'find sent message');
const list = [];
const RANK = { Sending: 0, Unknown: 0, Sent: 1, Delivered: 2, Failed: 2 };
for (const r of rows) {
  const f = r.fields || {};
  let to = null;
  if (s.status === 'delivered') to = 'Delivered';
  else if (s.status === 'failed' || s.status === 'undelivered') to = 'Failed';
  else if (s.status === 'sent') to = 'Sent';
  if (!to || (RANK[f.Status] || 0) > RANK[to] || f.Status === to) continue;   // never downgrade (receipts can arrive out of order)
  const fields = { Status: to };
  if (to === 'Failed') { fields['Error Code'] = s.errorCode; fields.Reason = 'Twilio: ' + s.status + (s.errorCode ? ' (error ' + s.errorCode + ')' : ''); }
  list.push({ table: 'messages', id: r.id, fields: fields });
  if (s.errorCode === '21610' && (f.Contact || [])[0]) list.push({ table: 'contacts', id: f.Contact[0], fields: { 'Opted Out': true, 'Opted Out At': iso(NOW), 'Marketing Opt-In': false } });
}
const items = patches(list);
return items.length ? items.map((x) => ({ json: x })) : [{ json: { none: true } }];`);
const anyStatus = OK_IF('Status Changes?', '{{ $json.none !== true }}');
const writeStatus = airtablePatch('Write Delivery Status');
const statusResponse = code('Status Response', `
if ($('Write Delivery Status').isExecuted) $('Write Delivery Status').all().forEach((i) => records(i.json, 'write delivery status'));
return [{ json: { response: { status: 200, body: { ok: true }, text: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>' } } }];`);
const respondStatus = respond('Respond Reply Status');

// Replies.
const findContact = airtableList('Find Sender', T.contacts, '{{ $json.contactFormula }}');
const jobsFormula = code('Sender Jobs Formula', `
// The contact's jobs, through Airtable's back-link (Lite Contacts > Lite Jobs): also jobs that staff created by hand.
const c = records($input.first().json, 'find sender')[0];
const ids = c ? ((c.fields || {})['Lite Jobs'] || []) : [];
return [{ json: { jobFormula: ids.length ? 'OR(' + ids.map((i) => "RECORD_ID()='" + formulaText(i) + "'").join(',') + ')' : 'FALSE()' } }];`);
const findJobs = airtableList('Find Sender Jobs', T.jobs, '{{ $json.jobFormula }}');
const classify = code('Classify Reply', `
const R = $('Verify Request').first().json.reply;
const contact = records($('Find Sender').first().json, 'find sender')[0] || null;
const jobs = records($input.first().json, 'find sender jobs');
const words = R.text.toUpperCase().replace(/[^A-Z ]/g, ' ').split(' ').filter(Boolean).join(' ');
const optOut = CFG.replies.optOutKeywords.some((k) => words === k || words.indexOf(k + ' ') === 0);
const optIn = !optOut && (words === 'START' || words === 'UNSTOP');
const recent = (x) => Date.parse((x.fields || {})['Lead Received At'] || '') || 0;
const open = jobs.filter((j) => ['Paid', 'Lost', 'Completed', 'Invoiced'].indexOf((j.fields || {}).Stage) < 0).sort((a, b) => recent(b) - recent(a));
const job = open[0] || null;
const contactUpdate = contact && optOut ? { typecast: false, records: [{ id: contact.id, fields: { 'Opted Out': true, 'Opted Out At': iso(NOW), 'Marketing Opt-In': false } }] } : null;
const jf = { 'Last Activity At': iso(NOW) };
if (job && job.fields.Stage === 'New Lead') jf.Stage = 'Contacted';
const jobUpdate = job && contact && !optOut && !optIn ? { typecast: false, records: [{ id: job.id, fields: jf }] } : null;
const reason = !contact ? 'sender is not in the CRM' : optOut ? 'contact opted out of all messages'
  : optIn ? 'asked to receive messages again: staff must confirm and untick Opted Out (Lite never does this automatically)' : 'reply recorded; enquiry reopened for a call';
const lf = { 'Log Ref': logRef('IN'), Workflow: 'Inbound Reply', Purpose: 'Inbound', Channel: R.channel, To: 'from ' + R.from, Body: R.text,
  Status: optOut ? 'Opt-Out' : 'Received', Reason: reason, 'Dedupe Key': 'reply:' + (R.sid || R.from + ':' + iso(NOW)), 'Provider Message ID': R.sid,
  Provider: CFG.messaging.provider, 'Attempted At': iso(NOW), 'Demo Data': R.demo };
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
// Twilio gets an empty TwiML answer (nothing is sent back to the person); other callers get JSON.
return [{ json: { response: { status: 200, body: { ok: true, known_contact: c.known, opted_out: c.optOut, job_ref: c.job_ref },
  text: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>' } } }];`);
const respondOk = respond('Respond Reply');

export default workflow('roofops-lite-inbound-replies', '[Lite] Inbound Replies')
  .add(hook).to(validate).to(valid
    .onTrue(isStatus
      .onTrue(findSent.to(applyStatus).to(anyStatus.onTrue(writeStatus.to(statusResponse)).onFalse(statusResponse)))
      .onFalse(findContact.to(jobsFormula).to(findJobs).to(classify).to(needOptOut.onTrue(optOutContact.to(afterContact)).onFalse(afterContact))))
    .onFalse(rejected))
  .add(statusResponse).to(respondStatus)
  .add(afterContact).to(needJob.onTrue(reopenJob.to(logRequest)).onFalse(logRequest))
  .add(logRequest).to(writeLog).to(replyResponse).to(respondOk);
