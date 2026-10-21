// Shared by every RoofOps Lite workflow. lite/build.ts inlines this file (and the chosen config) into each workflow, so
// each generated workflow is one self-contained n8n SDK file. Nothing here is specific to one business.
const CONFIG = __LITE_CONFIG__;
// Airtable table URLs (base + URL-encoded table name), computed by lite/build.ts from the config.
const T = __LITE_TABLE_URLS__;
const CRED = { airtableTokenApi: { id: CONFIG.airtable.credential.id, name: CONFIG.airtable.credential.name } };
const TWILIO = CONFIG.messaging.mode === 'twilio' ? CONFIG.messaging.twilio : null;
// Lead webhook protection (optional): n8n Header Auth with the configured credential.
const HOOK_AUTH = CONFIG.webhookAuth ? { authentication: 'headerAuth' } : {};
const HOOK_CRED = CONFIG.webhookAuth ? { credentials: { httpHeaderAuth: { id: CONFIG.webhookAuth.id, name: CONFIG.webhookAuth.name } } } : {};
// Reply webhook: Twilio's requests are checked by signature (in the Verify node), by n8n Basic Auth, or by n8n Header Auth
// (a relay that checked the signature sends the header); the test sink uses the lead webhook's setting.
const INBOUND = TWILIO ? ({ 'basic-auth': ['basicAuth', 'httpBasicAuth'], 'header-auth': ['headerAuth', 'httpHeaderAuth'] })[TWILIO.inboundAuth] : null;
const REPLY_AUTH = TWILIO ? (INBOUND ? { authentication: INBOUND[0] } : {}) : HOOK_AUTH;
const REPLY_CRED = TWILIO ? (INBOUND ? { credentials: { [INBOUND[1]]: { id: TWILIO.inboundCredential.id, name: TWILIO.inboundCredential.name } } } : {}) : HOOK_CRED;
const RAW = { response: { response: { fullResponse: true, neverError: true } }, timeout: 20000 };
const OK_IF = (name, leftValue) => ifElse({ version: 2.3, config: { name, parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr(leftValue), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });
const code = (name, js) => node({ type: 'n8n-nodes-base.code', version: 2, config: { name, parameters: { mode: 'runOnceForAllItems', jsCode: libFor(js) + js } }, output: [{ ok: true }] });
const airtableList = (name, url, formula) => node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name, onError: 'continueRegularOutput',
  parameters: { method: 'GET', url, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi', sendQuery: true,
    queryParameters: { parameters: [{ name: 'filterByFormula', value: expr(formula) }, { name: 'pageSize', value: '100' }] }, options: RAW },
  credentials: CRED }, output: [{ statusCode: 200, body: { records: [] } }] });
const airtableWrite = (name, method, url, body = '{{ JSON.stringify($json.request) }}') => node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name, onError: 'continueRegularOutput',
  parameters: { method, url, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi', sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: expr(body), options: RAW },
  credentials: CRED }, output: [{ statusCode: 200, body: { records: [{ id: 'rec' }] } }] });
// PATCH to the table each item names ({ url, request }): one node writes Message Log, Jobs and Contacts updates.
const airtablePatch = (name) => airtableWrite(name, 'PATCH', expr('{{ $json.url }}'));
// Twilio REST API calls: with n8n's own Twilio credential ("twilioApi"), or a Basic Auth credential (API Key SID + Secret).
const TW_AUTH = !TWILIO ? null : TWILIO.credentialType === 'twilioApi'
  ? { params: { authentication: 'predefinedCredentialType', nodeCredentialType: 'twilioApi' }, credentials: { twilioApi: { id: TWILIO.credential.id, name: TWILIO.credential.name } } }
  : { params: { authentication: 'genericCredentialType', genericAuthType: 'httpBasicAuth' }, credentials: { httpBasicAuth: { id: TWILIO.credential.id, name: TWILIO.credential.name } } };
const twilioCall = (name, method, url, form) => node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name, onError: 'continueRegularOutput',
  parameters: Object.assign({ method, url }, TW_AUTH.params,
    form ? { sendBody: true, contentType: 'form-urlencoded', specifyBody: 'keypair', bodyParameters: { parameters: form } } : {},
    { options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 15000 } }),
  credentials: TW_AUTH.credentials }, output: [{ statusCode: 201, body: { sid: 'SM' } }] });
const TWILIO_API = TWILIO ? `https://api.twilio.com/2010-04-01/Accounts/${TWILIO.accountSid}` : '';
// Delivery receipts go to the reply webhook. The URL never carries a password: with Basic Auth, Twilio sends the
// credentials from a Twilio Webhook Rule for the n8n address.
const STATUS_CALLBACKS = TWILIO ? (TWILIO.statusCallbacks ?? TWILIO.inboundAuth === 'signature') : false;
// The "create message" form. A trial account may only send To, a Twilio template key as Body, and StatusCallback
// (Twilio picks its trial number as the sender).
const smsForm = (bodyExpr, receipts = true) => [{ name: 'To', value: expr('{{ $json.to164 }}') },
  ...(TWILIO.trialTemplate ? [] : [TWILIO.from ? { name: 'From', value: TWILIO.from } : { name: 'MessagingServiceSid', value: TWILIO.messagingServiceSid }]),
  { name: 'Body', value: TWILIO.trialTemplate || expr(bodyExpr) },
  ...(receipts && STATUS_CALLBACKS ? [{ name: 'StatusCallback', value: TWILIO.statusCallbackUrl || `${CONFIG.n8n.baseUrl}/webhook/${CONFIG.replies.webhookPath}?event=status` }] : [])];
const respond = (name) => TWILIO && name.startsWith('Respond Reply')
  ? node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.1, config: { name,   // Twilio expects TwiML (an empty <Response/> sends nothing back)
    parameters: { respondWith: 'text', responseBody: expr('{{ $json.response.text }}'), options: { responseCode: expr('{{ $json.response.status }}'),
      responseHeaders: { entries: [{ name: 'content-type', value: 'text/xml; charset=utf-8' }] } } } }, output: [{}] })
  : node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.1, config: { name,
    parameters: { respondWith: 'json', responseBody: expr('{{ JSON.stringify($json.response.body) }}'), options: { responseCode: expr('{{ $json.response.status }}') } } }, output: [{}] });

/** Helpers available inside every Code node (plain JavaScript, run by n8n). */
const LIB = `
const CFG = ${JSON.stringify(CONFIG)};
const TABLE_URL = ${JSON.stringify(T)};
const NOW = new Date();
const iso = (d) => new Date(d).toISOString();
const days = (n) => n * 24 * 60 * 60 * 1000;
const clean = (s) => String(s == null ? '' : s).trim();
/** Text inside a single-quoted Airtable formula string: quotes and backslashes are escaped, never dropped (an address
 * like o'brien@ must not turn into obrien@ and match someone else). */
const formulaText = (s) => clean(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
const normEmail = (s) => { const e = clean(s).toLowerCase(); return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(e) ? e : ''; };
const normPhone = (s) => { let d = clean(s).replace(/[^0-9+]/g, ''); if (d.startsWith('+61')) d = '0' + d.slice(3); d = d.replace(/[^0-9]/g, ''); return /^0[2-478][0-9]{8}$/.test(d) ? d : ''; };
/** Australian national number (04xx xxx xxx) to E.164 (+614xxxxxxxx), as Twilio needs it. */
const toE164 = (s) => { const n = normPhone(s); return n ? '+61' + n.slice(1) : ''; };
/** Contacts with this number (Airtable formula): the normalized copy, or the Phone field itself however staff typed it,
 * so a number edited in the Interface (Phone Normalized not updated) still matches. */
const phoneFormula = (n) => { const d = formulaText(n); return "OR({Phone Normalized}='" + d + "',REGEX_REPLACE({Phone},'[^0-9]','')='" + d + "',REGEX_REPLACE({Phone},'[^0-9]','')='61" + d.slice(1) + "')"; };
/** The contact a form or a reply comes from: the one whose current phone is this number, else one with this email and no
 * other number on file. A different number on file is not merged by a web form: messages never follow it to another phone. */
const pickContact = (list, phone, email) => list.find((c) => phone && normPhone((c.fields || {}).Phone) === phone)
  || list.find((c) => email && normEmail((c.fields || {}).Email) === email && (!phone || !normPhone((c.fields || {}).Phone))) || null;
const firstNameOf = (n) => clean(n).split(/\\s+/)[0] || 'there';
const render = (tpl, v) => String(tpl).replace(/\\{(\\w+)\\}/g, (m, k) => (v[k] == null ? m : String(v[k])));
const vars = (contact, job) => ({ firstName: contact['First Name'] || firstNameOf(contact.Name), businessName: CFG.business.name, businessPhone: CFG.business.phone,
  signoff: CFG.business.signoff, service: (job && job.Service) || ('your ' + CFG.business.trade + ' job'), reviewUrl: CFG.reviews.googleReviewUrl });
/** An Airtable answer, or an Error that fails the execution (n8n records it; nothing is marked done). */
const records = (r, step) => {
  if (!r || r.statusCode !== 200) { const b = (r && r.body) || {}; const e = b.error || (r && r.error) || {}; throw new Error(step + ': Airtable ' + (r && r.statusCode ? 'HTTP ' + r.statusCode : 'no response') + ' ' + clean(typeof e === 'string' ? e : (e.message || e.type))); }
  if (!r.body || !Array.isArray(r.body.records)) throw new Error(step + ': Airtable answered without a record list');
  return r.body.records;
};
/** Twilio sends SMS only; the test sink also simulates email. */
const CHANNELS = CFG.messaging.mode === 'twilio' ? ['SMS'] : ['SMS', 'Email'];
/** Which channel may carry a message to this contact: the preferred one if it is consented and reachable, else the other. */
const channelFor = (c) => {
  if (c['Opted Out']) return { skip: 'opted out' };
  const can = { SMS: CHANNELS.includes('SMS') && !!c['Consent SMS'] && !!normPhone(c.Phone), Email: CHANNELS.includes('Email') && !!c['Consent Email'] && !!normEmail(c.Email) };
  const order = c['Preferred Channel'] === 'Email' ? ['Email', 'SMS'] : ['SMS', 'Email'];
  const ch = order.find((x) => can[x]);
  if (!ch) return { skip: CHANNELS.length === 1 ? 'no SMS consent or no mobile number' : 'no consent or no reachable contact detail' };
  return { channel: ch, to: ch === 'SMS' ? normPhone(c.Phone) : normEmail(c.Email) };
};
/**
 * Whether a message of this purpose may go to this contact (null) or why not. Operational: a reply to their own enquiry
 * (channel consent is checked by channelFor). Review and Marketing are commercial messages: they need express consent for
 * that purpose, recorded with a source and a date. Nothing is assumed for contacts without that record.
 */
const permission = (c, purpose) => {
  if (c['Opted Out']) return 'opted out';
  if (purpose === 'Operational') return null;
  const evidence = !!(c['Consent Recorded At'] && clean(c['Consent Source']));
  // Evidence written by the website form lists each box ticked (its wording, tagged [reviews] / [marketing]), so it vouches
  // only for those purposes: service consent given on a form never makes an older, unrecorded marketing tick usable.
  const formOnly = clean(c['Consent Source']).split('; ').every((s) => s.indexOf(CFG.consent.formName) === 0);
  const covers = (tag, w) => { const said = clean(c['Consent Wording']); return !formOnly || said.indexOf('[' + tag + ']') >= 0 || said.indexOf(clean(w)) >= 0; };
  if (purpose === 'Review') {
    if (CFG.consent.reviewRequests === 'service') return null;
    if (!c['Review Opt-In'] && !c['Marketing Opt-In']) return 'no permission for review requests';
    if (!evidence) return 'consent not recorded (source and date)';
    return (c['Review Opt-In'] && covers('reviews', CFG.consent.wording.reviews)) || (c['Marketing Opt-In'] && covers('marketing', CFG.consent.wording.marketing)) ? null
      : 'review permission is not in the recorded consent wording';
  }
  if (!c['Marketing Opt-In']) return 'no marketing permission';
  if (!evidence) return 'consent not recorded (source and date)';
  return covers('marketing', CFG.consent.wording.marketing) ? null : 'marketing permission is not in the recorded consent wording';
};
const logRef = (prefix) => prefix + '-' + iso(NOW).replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
/** Message Log statuses that mean "this message was attempted": a run never sends that Dedupe Key again by itself. */
const ATTEMPTED = ['Simulated Sent', 'Sending', 'Sent', 'Delivered', 'Failed', 'Unknown'];
/** A message to send: its Message Log fields, and the CRM updates to make once it is sent (onSuccess) or if another run already sent it (onLost). */
const outMessage = (o) => {
  const subject = o.channel === 'Email' ? o.subject : null;
  const fields = { 'Log Ref': logRef(o.prefix), Workflow: o.workflow, Purpose: o.purpose, Channel: o.channel, To: o.to,
    Body: (subject ? 'Subject: ' + subject + '\\n\\n' : '') + o.body, 'Dedupe Key': o.key, Provider: CFG.messaging.provider, 'Attempted At': iso(NOW), 'Demo Data': !!o.demo };
  if (o.jobId) fields.Job = [o.jobId];
  if (o.contactId) fields.Contact = [o.contactId];
  return { key: o.key, purpose: o.purpose, channel: o.channel, to: o.to, body: o.body, subject: subject, contactId: o.contactId || null, fields: fields, onSuccess: o.onSuccess || [], onLost: o.onLost || [] };
};
/** A message that is not sent, with the reason, for the Message Log. */
const skipLog = (o) => {
  const f = { 'Log Ref': logRef(o.prefix), Workflow: o.workflow, Purpose: o.purpose, Status: 'Skipped', Reason: o.reason, 'Dedupe Key': o.key + ':skipped',
    Provider: CFG.messaging.provider, 'Attempted At': iso(NOW), 'Demo Data': !!o.demo };
  if (o.jobId) f.Job = [o.jobId];
  if (o.contactId) f.Contact = [o.contactId];
  return f;
};
/** CRM updates ({ table, id, fields }) as Airtable PATCH requests: one per table and 10 records, updates to one record merged. */
const patches = (list) => {
  const by = {};
  for (const u of list) { const t = (by[u.table] = by[u.table] || {}); t[u.id] = Object.assign(t[u.id] || {}, u.fields); }
  const items = [];
  for (const table of Object.keys(by)) for (const part of chunk(Object.keys(by[table]), 10))
    items.push({ url: TABLE_URL[table], request: { typecast: false, records: part.map((id) => ({ id: id, fields: by[table][id] })) } });
  return items;
};
/** Twilio error codes where sending again cannot work, with a plain reason. */
const PERMANENT = { '21211': 'invalid phone number', '21614': 'not a mobile number', '21612': 'Twilio cannot reach this number', '21408': 'sending to this country is not enabled',
  '21610': 'the person unsubscribed from this sender (replied STOP)', '21606': 'the sender number cannot send SMS', '21659': 'the sender is not a Twilio number on this account', '21617': 'message too long',
  '572002': 'trial account: the number is not a verified recipient', '21608': 'trial account: the number is not a verified recipient', '14111': 'trial account: the number is not a verified recipient', '21607': 'trial account: only the Twilio trial number can send',
  '10002': 'trial account: Twilio does not allow this until the account is upgraded' };
/**
 * The outcome of one Twilio "create message" call. Sent: Twilio accepted it (it has a Message SID). Failed: Twilio
 * refused it, so nothing was sent. Unknown: no clear answer (timeout, server error): it may have been sent, so it is
 * never resent automatically; [Lite] Monitor checks with Twilio first.
 */
const classify = (r) => {
  if (!r || r.statusCode === undefined || r.statusCode === null) return { status: 'Unknown', errorCode: 'no_response', reason: 'no answer from Twilio (' + clean((r && r.error && r.error.message) || 'timeout') + '): it may have been sent; check before retrying' };
  const b = r.body || {};
  if (r.statusCode >= 200 && r.statusCode < 300) {
    if (!b.sid) return { status: 'Unknown', errorCode: 'no_sid', reason: 'Twilio answered without a Message SID; check before retrying' };
    if (b.status === 'failed' || b.status === 'undelivered') return { status: 'Failed', sid: b.sid, errorCode: clean(b.error_code) || null, reason: clean(b.error_message) || 'Twilio could not send it' };
    return { status: 'Sent', sid: b.sid, errorCode: null, reason: null };
  }
  if (r.statusCode === 429) return { status: 'Failed', errorCode: 'http_429', reason: 'Twilio rate limit: not sent; safe to retry' };
  if (r.statusCode >= 500) return { status: 'Unknown', errorCode: 'http_' + r.statusCode, reason: 'Twilio server error: it may have been sent; check before retrying' };
  const code = b.code ? String(b.code) : 'http_' + r.statusCode;
  return { status: 'Failed', errorCode: code, reason: (PERMANENT[code] || clean(b.message) || 'refused by Twilio') + ' (not sent)', optOut: code === '21610' };
};
`;

/** Each Code node gets only the helpers it uses (and theirs): the library above, split at each top-level const. */
const LIB_PARTS = (() => {
  const parts = []; let comment = [];
  for (const line of LIB.split('\n')) {
    if (!line.trim()) continue;
    const m = /^const (\w+) =/.exec(line);
    if (m) { parts.push({ name: m[1], lines: [...comment, line] }); comment = []; }
    else if (line.startsWith('/**') || line.startsWith(' *')) comment.push(line);
    else parts[parts.length - 1].lines.push(line);
  }
  return parts.map((p) => ({ name: p.name, text: p.lines.join('\n') }));
})();
const uses = (text, name) => new RegExp('(^|[^\\w.$\'])' + name + '([^\\w]|$)').test(text);
// ...and only the config sections it reads (CFG.<section>), so a node does not carry every message template.
const cfgFor = (text) => {
  const keys = Array.from(new Set(Array.from(text.matchAll(/CFG\.(\w+)/g), (m) => m[1]))).filter((k) => k in CONFIG);
  return 'const CFG = ' + JSON.stringify(Object.fromEntries(keys.map((k) => [k, CONFIG[k]]))) + ';';
};
const libFor = (js) => {
  const need = new Set();
  const add = (part) => { if (need.has(part.name)) return; need.add(part.name); LIB_PARTS.filter((q) => q !== part && uses(part.text, q.name)).forEach(add); };
  LIB_PARTS.filter((p) => uses(js, p.name)).forEach(add);
  const parts = LIB_PARTS.filter((p) => need.has(p.name));
  const all = [js].concat(parts.map((p) => p.text)).join('\n');
  return '\n' + parts.map((p) => (p.name === 'CFG' ? cfgFor(all) : p.text)).join('\n') + '\n';
};
