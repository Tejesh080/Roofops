import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';
// @include common
// [Lite] Inbound Replies (and, with Twilio, delivery receipts). Twilio POSTs every SMS a person sends to the business
// number here, and every status change of a message Lite sent (?event=status). In twilio mode each request is checked
// first: the X-Twilio-Signature (HMAC-SHA1 of the URL and parameters with the Auth Token from an n8n Variable), or n8n
// Basic Auth, or n8n Header Auth (sent by a relay that checked the signature), and the Account SID. A refused request
// changes nothing; one refused by n8n's Basic or Header Auth does not even start an execution.
// - A reply: STOP (or another opt-out word) marks the contact Opted Out, removes marketing permission and is logged as
//   Opt-Out; no Lite workflow messages them again. START is logged for staff (no automatic re-subscribe). Any other reply
//   is logged as Received and brings the person's open enquiry back to life (Last Activity now; a New Lead becomes Contacted).
// - A delivery receipt: the message's log row becomes Delivered or Failed (with Twilio's error code); a Twilio
//   "unsubscribed" error opts the contact out.

const hook = trigger({ type: 'n8n-nodes-base.webhook', version: 2, config: { name: 'Reply Webhook', ...REPLY_CRED,
  parameters: { httpMethod: 'POST', path: CONFIG.replies.webhookPath, responseMode: 'responseNode', ...REPLY_AUTH, options: {} } }, output: [{ body: {} }] });

// The signature check exists only in "signature" mode: it needs an n8n Variable, which n8n Cloud Starter does not have.
const SIGNATURE_CHECK = TWILIO && TWILIO.inboundAuth === 'signature' ? `
  const secret = $vars[TW.signatureVariable];
  if (!secret) return reject(503, 'Twilio signature secret is not configured (n8n Variable ' + TW.signatureVariable + ')');
  // Twilio signs the exact URL it calls plus every POST parameter, sorted by name.
  const url = CFG.n8n.baseUrl + '/webhook/' + CFG.replies.webhookPath + (event === 'status' ? '?event=status' : '');
  const data = url + Object.keys(b).sort().map((k) => k + String(b[k])).join('');
  const expected = require('crypto').createHmac('sha1', secret).update(data, 'utf8').digest('base64');
  const got = String((h.headers || {})['x-twilio-signature'] || '');
  let diff = got.length ^ expected.length;
  for (let i = 0; i < Math.min(got.length, expected.length); i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  if (!got || diff !== 0) return reject(403, 'invalid Twilio signature');` : `
  // n8n's ${TWILIO && TWILIO.inboundAuth === 'header-auth' ? 'Header Auth (the relay checked the signature)' : 'Basic Auth'} let this request in.`;
const validate = code('Verify Request', `
const h = $input.first().json;
const b = h.body || {}; const q = h.query || {};
const TW = CFG.messaging.mode === 'twilio' ? CFG.messaging.twilio : null;
const reject = (status, why) => [{ json: { ok: false, response: { status: status, body: { ok: false, errors: [why] }, text: why } } }];
let reply;
if (TW) {
  const event = q.event === 'status' ? 'status' : 'message';
  if (Object.keys(q).some((k) => k !== 'event')) return reject(403, 'unexpected query parameters');${SIGNATURE_CHECK}
  if (b.AccountSid !== TW.accountSid) return reject(403, 'request is not for this Twilio account');
  if (event === 'status') {
    if (!/^(SM|MM)[0-9a-f]{32}$/.test(clean(b.MessageSid))) return reject(400, 'MessageSid is missing');
    // The message by its SID; and Unknown sends (no SID) to this number, only to say in an alert that one may be it.
    const to = normPhone(b.To);
    return [{ json: { ok: true, event: 'status', status: { sid: clean(b.MessageSid), status: clean(b.MessageStatus).toLowerCase(), errorCode: clean(b.ErrorCode) || null, to: to },
      formula: "OR({Provider Message ID}='" + formulaText(b.MessageSid) + "'" + (to ? ",AND({Status}='Unknown',{Provider Message ID}=BLANK(),{To}='" + formulaText(to) + "')" : '') + ')' } }];
  }
  reply = { from: clean(b.From), text: clean(b.Body), sid: clean(b.MessageSid) || null, demo: false };
} else reply = { from: clean(b.from), text: clean(b.text), sid: null, demo: b.demo === true };
const email = normEmail(reply.from); const phone = normPhone(reply.from);
const text = reply.text.slice(0, 2000);
const errors = [];
if (!email && !phone) errors.push('from must be the sender phone number or email address');
if (!text) errors.push('text is required');
if (errors.length) return reject(400, errors.join('; '));
return [{ json: { ok: true, event: 'message', reply: { from: email || phone, channel: email ? 'Email' : 'SMS', text: text, sid: reply.sid, demo: reply.demo, phone: phone, email: email },
  contactFormula: email ? "LOWER({Email})='" + formulaText(email) + "'" : phoneFormula(phone),
  historyFormula: "{To}='" + formulaText(email || phone) + "'" } }];`);
const valid = OK_IF('Request Valid?', '{{ $json.ok }}');
const rejected = respond('Respond Reply Rejected');

// Delivery receipts (twilio mode only).
const isStatus = OK_IF('Delivery Receipt?', "{{ $json.event === 'status' }}");
const findSent = airtableList('Find Sent Message', T.messages, '{{ $json.formula }}');
const applyStatus = code('Apply Delivery Status', `
const s = $('Verify Request').first().json.status;
const found = records($input.first().json, 'find sent message');
// A receipt changes only the message with its exact Message SID. One that overtakes Lite's own record of the send, or
// belongs to no message Lite knows, changes nothing: a failure, or any receipt while an unconfirmed message to the same
// number exists, is raised as an alert for a person instead. Matching it by number could settle or fail the wrong message.
const bySid = found.filter((r) => clean((r.fields || {})['Provider Message ID']) === s.sid);
const pending = found.filter((r) => !clean((r.fields || {})['Provider Message ID']));
const rows = bySid;
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
const failed = s.status === 'failed' || s.status === 'undelivered';
const alert = !rows.length && (failed || pending.length) ? { 'Alert Ref': logRef('AL'), Kind: failed ? 'Delivery Failed' : 'Delivery Unknown', Status: 'Open', Workflow: 'Inbound Reply', 'Record Ref': s.sid,
  Detail: 'Twilio reported message ' + s.sid + ' to ' + (s.to || 'an unknown number') + ' as ' + s.status + (s.errorCode ? ' (error ' + s.errorCode + ')' : '')
    + ', but no message in the Message Log has this Message SID (it may not have been recorded yet), so Lite changed nothing.'
    + (pending.length ? ' ' + pending.length + ' unconfirmed message(s) to this number may or may not be this one.' : '')
    + ' Check this SID in Twilio against the Message Log before ticking Retry Requested on anything.',
  'Dedupe Key': 'receipt:' + s.sid + ':' + s.status, 'Raised At': iso(NOW), 'Demo Data': false } : null;
return [{ json: { items: patches(list), hasAlert: !!alert, alertRequest: alert ? { typecast: false, records: [{ fields: alert }] } : null } }];`);
const needAlert = OK_IF('Receipt Alert?', '{{ $json.hasAlert }}');
const saveAlert = airtableWrite('Save Receipt Alert', 'POST', T.alerts, '{{ JSON.stringify($json.alertRequest) }}');
const receiptUpdates = code('Receipt Updates', `
if ($('Save Receipt Alert').isExecuted) records($('Save Receipt Alert').first().json, 'save receipt alert');
const items = $('Apply Delivery Status').first().json.items;
return items.length ? items.map((x) => ({ json: x })) : [{ json: { none: true } }];`);
const anyStatus = OK_IF('Status Changes?', '{{ $json.none !== true }}');
const writeStatus = airtablePatch('Write Delivery Status');
const statusResponse = code('Status Response', `
if ($('Write Delivery Status').isExecuted) $('Write Delivery Status').all().forEach((i) => records(i.json, 'write delivery status'));
return [{ json: { response: { status: 200, body: { ok: true }, text: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>' } } }];`);
const respondStatus = respond('Respond Reply Status');

// Replies. The sender is every contact with this number or email (duplicates included), and every contact Lite has
// messaged at it before: a number changed in the CRM since does not make their STOP go unheard. Both lists are read to
// the end (every page), so STOP reaches all of them.
const findHistory = airtableListAll('Find Number History', T.messages, '{{ $json.historyFormula }}');
const senderFormula = code('Sender Formula', `
const v = $('Verify Request').first().json;
const ids = Array.from(new Set(allRecords($input.all(), 'find number history').map((m) => ((m.fields || {}).Contact || [])[0]).filter(Boolean)));
if (ids.length > 100) throw new Error('find number history: Lite has messaged ' + ids.length + ' contacts at ' + v.reply.from + ', more than one reply can handle (100); deal with this reply by hand');
return [{ json: { formula: ids.length ? 'OR(' + [v.contactFormula].concat(ids.map((i) => "RECORD_ID()='" + formulaText(i) + "'")).join(',') + ')' : v.contactFormula } }];`);
const findContact = airtableListAll('Find Sender', T.contacts, '{{ $json.formula }}');
const jobsFormula = code('Sender Jobs Formula', `
// The contact's jobs, through Airtable's back-link (Lite Contacts > Lite Jobs): also jobs that staff created by hand.
const R = $('Verify Request').first().json.reply;
const list = allRecords($input.all(), 'find sender');
const c = pickContact(list, R.phone, R.email) || list[0];
const ids = c ? ((c.fields || {})['Lite Jobs'] || []) : [];
return [{ json: { jobFormula: ids.length ? 'OR(' + ids.map((i) => "RECORD_ID()='" + formulaText(i) + "'").join(',') + ')' : 'FALSE()' } }];`);
const findJobs = airtableList('Find Sender Jobs', T.jobs, '{{ $json.jobFormula }}');
const classify = code('Classify Reply', `
const R = $('Verify Request').first().json.reply;
const senders = allRecords($('Find Sender').all(), 'find sender');
const contact = pickContact(senders, R.phone, R.email) || senders[0] || null;
const jobs = records($input.first().json, 'find sender jobs');
const words = R.text.toUpperCase().replace(/[^A-Z ]/g, ' ').split(' ').filter(Boolean).join(' ');
const optOut = CFG.replies.optOutKeywords.some((k) => words === k || words.indexOf(k + ' ') === 0);
const optIn = !optOut && (words === 'START' || words === 'UNSTOP');
const recent = (x) => Date.parse((x.fields || {})['Lead Received At'] || '') || 0;
const open = jobs.filter((j) => ['Paid', 'Lost', 'Completed', 'Invoiced'].indexOf((j.fields || {}).Stage) < 0).sort((a, b) => recent(b) - recent(a));
// The reply is logged on their open job, or else on their latest finished one (which is not reopened).
const job = open[0] || jobs.slice().sort((a, b) => recent(b) - recent(a))[0] || null;
const reopen = !!job && open.indexOf(job) >= 0;
// STOP opts out every one of them (in batches of 10, Airtable's limit), so a duplicate record of the same person cannot be messaged either.
const stopped = senders.filter((c) => !(c.fields || {})['Opted Out']);
const optOutRequests = optOut ? chunk(stopped.map((c) => ({ id: c.id, fields: { 'Opted Out': true, 'Opted Out At': iso(NOW), 'Marketing Opt-In': false } })), 10).map((x) => ({ typecast: false, records: x })) : [];
const jf = { 'Last Activity At': iso(NOW) };
if (job && job.fields.Stage === 'New Lead') jf.Stage = 'Contacted';
const jobUpdate = reopen && contact && !optOut && !optIn ? { typecast: false, records: [{ id: job.id, fields: jf }] } : null;
const reason = !contact ? 'sender is not in the CRM' : optOut ? 'contact opted out of all messages'
  : optIn ? 'asked to receive messages again: staff must confirm and untick Opted Out (Lite never does this automatically)'
  : job && !reopen ? 'reply recorded on the finished job (not reopened)' : 'reply recorded; enquiry reopened for a call';
const lf = { 'Log Ref': logRef('IN'), Workflow: 'Inbound Reply', Purpose: 'Inbound', Channel: R.channel, To: 'from ' + R.from, Body: R.text,
  Status: optOut ? 'Opt-Out' : 'Received', Reason: reason, 'Dedupe Key': 'reply:' + (R.sid || R.from + ':' + iso(NOW)), 'Provider Message ID': R.sid,
  Provider: CFG.messaging.provider, 'Attempted At': iso(NOW), 'Demo Data': R.demo };
if (contact) lf.Contact = [contact.id];
if (job) lf.Job = [job.id];
return [{ json: { known: !!contact, optOut: optOut, from: R.from, optOutRequests: optOutRequests, jobUpdate: jobUpdate, hasContactUpdate: optOutRequests.length > 0, hasJobUpdate: !!jobUpdate,
  job_ref: job ? job.fields['Job Ref'] : null, log: { typecast: false, records: [{ fields: lf }] } } }];`);
// The reply is logged first. For a STOP, that row (Status Opt-Out, To "from <number>") is the number's suppression: every
// send reads it just before sending, so the STOP holds even if some contact updates below fail. Saving it is tried twice.
const logRequest = code('Log Reply Request', `
return [{ json: { request: $('Classify Reply').first().json.log } }];`);
const writeLog = airtableWrite('Write Reply Log', 'POST', T.messages);
const logSaved = OK_IF('Reply Log Saved?', '{{ $json.statusCode === 200 }}');
const writeLogAgain = airtableWrite('Write Reply Log Again', 'POST', T.messages, "{{ JSON.stringify($('Log Reply Request').first().json.request) }}");
const needOptOut = OK_IF('Opt Out Contact?', "{{ $('Classify Reply').first().json.hasContactUpdate }}");
const optOutBatches = code('Opt Out Batches', `
return $('Classify Reply').first().json.optOutRequests.map((r) => ({ json: { request: r } }));`);
const optOutContact = airtableWrite('Opt Out Contact', 'PATCH', T.contacts, undefined, { batching: { batch: { batchSize: 4, batchInterval: 1000 } } });   // within Airtable's 5 per second
const afterContact = code('After Contact', `
const c = $('Classify Reply').first().json;
// The log row must be saved (first or second try); then every contact update. Either failure fails the run with the
// reason ([Lite] Monitor raises it). The contacts are updated even when the log could not be saved.
const tries = [$('Write Reply Log').first().json].concat($('Write Reply Log Again').isExecuted ? [$('Write Reply Log Again').first().json] : []);
let saved = false; let why = '';
tries.forEach((t) => { try { records(t, 'write reply log'); saved = true; } catch (e) { why = e.message; } });
const res = $('Opt Out Contact').isExecuted ? $('Opt Out Contact').all() : []; const errors = [];
res.forEach((i) => { try { records(i.json, 'opt out contact'); } catch (e) { errors.push(e.message); } });
const contacts = errors.length + ' of ' + res.length + ' contact updates failed' + (errors.length ? ' (' + errors[0] + ')' : '');
if (!saved && c.optOut) throw new Error('STOP from ' + c.from + ' could not be saved, so the number is NOT suppressed (' + why + '); ' + contacts
  + '. Record the STOP and opt out every contact with this number by hand.');
if (!saved) throw new Error('reply from ' + c.from + ' could not be logged (' + why + ')');
if (errors.length) throw new Error('STOP from ' + c.from + ' is saved and the number is suppressed, but ' + contacts + '; tick Opted Out on the remaining contacts with this number.');
return [{ json: { hasJobUpdate: c.hasJobUpdate } }];`);
const needJob = OK_IF('Reopen Job?', '{{ $json.hasJobUpdate }}');
const reopenJob = airtableWrite('Reopen Job', 'PATCH', T.jobs, "{{ JSON.stringify($('Classify Reply').first().json.jobUpdate) }}");
const replyResponse = code('Reply Response', `
if ($('Reopen Job').isExecuted) records($('Reopen Job').first().json, 'reopen job');
const c = $('Classify Reply').first().json;
// Twilio gets an empty TwiML answer (nothing is sent back to the person); other callers get JSON.
return [{ json: { response: { status: 200, body: { ok: true, known_contact: c.known, opted_out: c.optOut, job_ref: c.job_ref },
  text: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>' } } }];`);
const respondOk = respond('Respond Reply');

export default workflow('roofops-lite-inbound-replies', '[Lite] Inbound Replies')
  .add(hook).to(validate).to(valid
    .onTrue(isStatus
      .onTrue(findSent.to(applyStatus).to(needAlert.onTrue(saveAlert.to(receiptUpdates)).onFalse(receiptUpdates)))
      .onFalse(findHistory.to(senderFormula).to(findContact).to(jobsFormula).to(findJobs).to(classify).to(logRequest).to(writeLog)
        .to(logSaved.onTrue(needOptOut.onTrue(optOutBatches.to(optOutContact).to(afterContact)).onFalse(afterContact)).onFalse(writeLogAgain))))
    .onFalse(rejected))
  .add(writeLogAgain).to(needOptOut)
  .add(receiptUpdates).to(anyStatus.onTrue(writeStatus.to(statusResponse)).onFalse(statusResponse))
  .add(statusResponse).to(respondStatus)
  .add(afterContact).to(needJob.onTrue(reopenJob.to(replyResponse)).onFalse(replyResponse))
  .add(replyResponse).to(respondOk);
