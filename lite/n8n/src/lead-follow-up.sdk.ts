import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';
// @include common
// @include send
// [Lite] Instant Lead Follow-Up. A website form (lite/dist/<client>/lead-form.html, or any system) POSTs a lead to the
// webhook. It is validated, de-duplicated against the CRM (same email or phone with an open enquiry inside the window),
// saved as Contact (with the consent given, its source, time and wording) + Property + Job (Stage New Lead), and
// acknowledged once by SMS (or email in test-sink mode) if the person consented. The acknowledgement goes through the
// shared send pipeline: logged first, sent at most once per person per day (a double-clicked form sends one message),
// and the job moves to Contacted when it went out. The caller gets a JSON answer.

const hook = trigger({ type: 'n8n-nodes-base.webhook', version: 2, config: { name: 'Lead Webhook', ...HOOK_CRED,
  parameters: { httpMethod: 'POST', path: CONFIG.leadIntake.webhookPath, responseMode: 'responseNode', ...HOOK_AUTH, options: {} } }, output: [{ body: {} }] });

const validate = code('Validate Lead', `
const b = ($input.first().json.body) || {};
// A hidden "website" field that people never fill in: bots that do get a quiet "ok" and nothing is saved.
if (clean(b.website)) return [{ json: { ok: false, response: { status: 200, body: { ok: true } } } }];
const yes = (x) => x === true || ['true', 'yes', 'on', '1'].includes(clean(x).toLowerCase());
const errors = [];
const name = clean(b.name).slice(0, 120); const email = normEmail(b.email); const phone = normPhone(b.phone);
if (name.length < 2) errors.push('name is required');
if (clean(b.email) && !email) errors.push('email is not a valid address');
if (clean(b.phone) && !phone) errors.push('phone is not a valid Australian number');
if (!email && !phone) errors.push('an email address or phone number is required');
if (errors.length) return [{ json: { ok: false, response: { status: 400, body: { ok: false, errors: errors } } } }];
const SOURCES = ['Website', 'Facebook', 'Google', 'Referral', 'Phone', 'Other'];
const source = SOURCES.find((s) => s.toLowerCase() === clean(b.source).toLowerCase()) || 'Website';
const consent = { sms: yes(b.consent_sms), email: yes(b.consent_email), reviews: yes(b.consent_reviews), marketing: yes(b.marketing_opt_in) };
// The exact words shown on the form for each box ticked (lite/dist/<client>/lead-form.html shows the same).
const by = [consent.sms ? 'SMS' : '', consent.email ? 'email' : ''].filter(Boolean);
const wording = [by.length ? CFG.consent.wording.service + ' [' + by.join(', ') + ']' : '', consent.reviews ? CFG.consent.wording.reviews : '', consent.marketing ? CFG.consent.wording.marketing : ''].filter(Boolean);
const contactConds = [email ? "LOWER({Email})='" + formulaText(email) + "'" : '', phone ? "{Phone Normalized}='" + formulaText(phone) + "'" : ''].filter(Boolean);
return [{ json: { ok: true,
  lead: { name: name, firstName: clean(b.first_name).slice(0, 60) || firstNameOf(name), email: email, phone: phone, suburb: clean(b.suburb).slice(0, 80), address: clean(b.address).slice(0, 200),
    postcode: clean(b.postcode).slice(0, 10), service: clean(b.service).slice(0, 120), message: clean(b.message).slice(0, 2000), source: source,
    consent: consent, consentWording: wording.join('\\n'), consentSource: CFG.consent.formName + ' (' + (clean(b.source_url).slice(0, 200) || CFG.leadIntake.webhookPath) + ')',
    preferred: clean(b.preferred_channel).toLowerCase() === 'email' ? 'Email' : 'SMS', demo: yes(b.demo) },
  contactFormula: contactConds.length > 1 ? 'OR(' + contactConds.join(',') + ')' : contactConds[0] } }];`);
const valid = OK_IF('Lead Valid?', '{{ $json.ok }}');
const rejected = respond('Respond Rejected');

const findContact = airtableList('Find Contact', T.contacts, '{{ $json.contactFormula }}');
const jobsFormula = code('Contact Jobs Formula', `
// The contact's jobs, through Airtable's back-link (Lite Contacts > Lite Jobs): also jobs that staff created by hand.
const c = records($input.first().json, 'find contact')[0];
const ids = c ? ((c.fields || {})['Lite Jobs'] || []) : [];
return [{ json: { jobFormula: ids.length ? 'OR(' + ids.map((i) => "RECORD_ID()='" + formulaText(i) + "'").join(',') + ')' : 'FALSE()' } }];`);
const findJobs = airtableList('Find Recent Jobs', T.jobs, '{{ $json.jobFormula }}');
const decide = code('Decide', `
const L = $('Validate Lead').first().json.lead;
const contacts = records($('Find Contact').first().json, 'find contact');
const jobs = records($input.first().json, 'find recent jobs');
const since = NOW.getTime() - days(CFG.leadIntake.dedupeWindowDays);
const open = jobs.filter((j) => { const f = j.fields || {}; return Date.parse(f['Lead Received At'] || '') >= since && ['Paid', 'Lost'].indexOf(f.Stage) < 0; });
const contact = contacts[0] || null;
if (open.length) {
  const j = open[0];
  const log = skipLog({ prefix: 'LM', workflow: 'Lead Follow-Up', purpose: 'Operational', key: 'lead-repeat:' + j.id + ':' + iso(NOW).slice(0, 10), jobId: j.id, contactId: contact ? contact.id : null,
    reason: 'repeat enquiry within ' + CFG.leadIntake.dedupeWindowDays + ' days of ' + (j.fields['Job Ref'] || j.id), demo: L.demo });
  return [{ json: { duplicate: true, job: j, contact: contact, request: { typecast: false, records: [{ fields: log }] } } }];
}
// Consent given on this form, with its evidence. Nothing is recorded when no box was ticked.
const C = L.consent;
const given = { 'Consent SMS': C.sms, 'Consent Email': C.email, 'Review Opt-In': C.reviews, 'Marketing Opt-In': C.marketing };
const evidence = L.consentWording ? { 'Consent Source': L.consentSource, 'Consent Recorded At': iso(NOW), 'Consent Wording': L.consentWording } : {};
let write = null;
if (!contact) {
  const fields = Object.assign({ Name: L.name, 'First Name': L.firstName, Source: L.source, 'Preferred Channel': L.preferred, 'Demo Data': L.demo }, given, evidence);
  if (L.email) fields.Email = L.email;
  if (L.phone) { fields.Phone = L.phone; fields['Phone Normalized'] = L.phone; }
  if (L.suburb) fields.Suburb = L.suburb;
  write = { method: 'POST', url: TABLE_URL.contacts, request: { typecast: false, records: [{ fields: fields }] } };
} else {
  // A returning person: new consent is added (never removed). An opt-out stands until staff confirm the person wants messages again.
  const cf = contact.fields || {};
  const added = Object.keys(given).filter((k) => given[k] && !cf[k]);
  if (added.length && !cf['Opted Out']) {
    const fields = Object.assign({}, evidence); added.forEach((k) => { fields[k] = true; });
    write = { method: 'PATCH', url: TABLE_URL.contacts, request: { typecast: false, records: [{ id: contact.id, fields: fields }] } };
  }
}
return [{ json: { duplicate: false, newContact: !contact, contact: contact, hasWrite: !!write, write: write } }];`);
const duplicate = OK_IF('Duplicate?', '{{ $json.duplicate }}');
const logDuplicate = airtableWrite('Log Duplicate', 'POST', T.messages);
const duplicateResponse = code('Duplicate Response', `
records($input.first().json, 'log duplicate');
const d = $('Decide').first().json;
return [{ json: { response: { status: 200, body: { ok: true, duplicate: true, job_ref: d.job.fields['Job Ref'] || null,
  message: 'We already have this enquiry and will be in touch.' } } } }];`);
const respondDuplicate = respond('Respond Duplicate');

const needWrite = OK_IF('Save Contact?', '{{ $json.hasWrite }}');
const saveContact = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Save Contact', onError: 'continueRegularOutput',
  parameters: { method: expr('{{ $json.write.method }}'), url: expr('{{ $json.write.url }}'), authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: expr('{{ JSON.stringify($json.write.request) }}'), options: RAW },
  credentials: CRED }, output: [{ statusCode: 200, body: { records: [{ id: 'rec' }] } }] });
const contactReady = code('Contact Ready', `
const d = $('Decide').first().json; const L = $('Validate Lead').first().json.lead;
const contact = d.hasWrite ? records($('Save Contact').first().json, 'save contact')[0] : d.contact;
const fields = { Address: L.address, Contact: [contact.id], 'Demo Data': L.demo };
if (L.suburb) fields.Suburb = L.suburb;
if (L.postcode) fields.Postcode = L.postcode;
return [{ json: { contact: contact, hasAddress: !!L.address, request: L.address ? { typecast: false, records: [{ fields: fields }] } : null } }];`);
const hasAddress = OK_IF('Has Address?', '{{ $json.hasAddress }}');
const createProperty = airtableWrite('Create Property', 'POST', T.properties);
const jobRequest = code('Job Request', `
const c = $('Contact Ready').first().json; const L = $('Validate Lead').first().json.lead;
const prop = c.hasAddress ? records($('Create Property').first().json, 'create property')[0] : null;
const ref = 'LJ-' + iso(NOW).slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
const fields = { 'Job Ref': ref, Contact: [c.contact.id], Stage: 'New Lead', Source: L.source, 'Lead Received At': iso(NOW), 'Last Activity At': iso(NOW),
  'Invoice Status': 'Not Invoiced', 'Demo Data': L.demo };
if (prop) fields.Property = [prop.id];
if (L.service) fields.Service = L.service;
if (L.message) fields['Enquiry Message'] = L.message;
return [{ json: { ref: ref, request: { typecast: false, records: [{ fields: fields }] } } }];`);
const createJob = airtableWrite('Create Job', 'POST', T.jobs);
const plan = code('Plan Acknowledgement', `
const job = records($input.first().json, 'create job')[0];
const contact = $('Contact Ready').first().json.contact; const cf = contact.fields || {};
const L = $('Validate Lead').first().json.lead;
const v = vars(cf, job.fields || {});
const ch = channelFor(cf);
const why = permission(cf, 'Operational') || ch.skip;
// One acknowledgement per person per day: a form sent twice at once still sends one message.
const key = 'lead-ack:' + (L.phone || L.email) + ':' + iso(NOW).slice(0, 10);
const base = { prefix: 'LM', workflow: 'Lead Follow-Up', purpose: 'Operational', key: key, jobId: job.id, contactId: contact.id, demo: L.demo };
if (why) return [{ json: { job: job, sends: [], logs: [skipLog(Object.assign({ reason: why }, base))], updates: [], skipReason: why } }];
const subject = ch.channel === 'Email' ? render(CFG.leadIntake.emailSubject, v) : null;
const m = outMessage(Object.assign({ channel: ch.channel, to: ch.to, subject: subject, body: render(ch.channel === 'SMS' ? CFG.leadIntake.sms : CFG.leadIntake.email, v),
  onSuccess: [{ table: 'jobs', id: job.id, fields: { Stage: 'Contacted', 'Last Activity At': iso(NOW) } }],
  onLost: [{ table: 'jobs', id: job.id, fields: { Stage: 'Lost' } }] }, base));
return [{ json: { job: job, sends: [m], logs: [], updates: [], skipReason: null } }];`);
const buildResponse = code('Build Response', `
if ($('Write Updates').isExecuted) $('Write Updates').all().forEach((i) => records(i.json, 'write updates'));
const a = $('Plan Acknowledgement').first().json;
const r = $('Record Results').first().json.outcome.results[0] || null;
if (r && r.reason && r.reason.indexOf('duplicate:') === 0)   // the same form arrived twice at once: the other request answered it
  return [{ json: { response: { status: 200, body: { ok: true, duplicate: true, job_ref: null, message: 'We already have this enquiry and will be in touch.' } } } }];
const status = r ? r.status : 'Skipped';
const sent = status === 'Sent' || status === 'Simulated Sent';
return [{ json: { response: { status: 200, body: { ok: true, duplicate: false, job_ref: a.job.fields['Job Ref'], new_contact: $('Decide').first().json.newContact,
  stage: sent ? 'Contacted' : 'New Lead', acknowledgement: { status: status, channel: a.sends.length ? a.sends[0].channel : null, reason: r ? r.reason : a.skipReason } } } } }];`);
const respondAccepted = respond('Respond Accepted');
const send = sendPipeline('Plan Acknowledgement', buildResponse);

let w = workflow('roofops-lite-lead-follow-up', '[Lite] Instant Lead Follow-Up')
  .add(hook).to(validate).to(valid
    .onTrue(findContact.to(jobsFormula).to(findJobs).to(decide).to(duplicate
      .onTrue(logDuplicate.to(duplicateResponse).to(respondDuplicate))
      .onFalse(needWrite.onTrue(saveContact.to(contactReady)).onFalse(contactReady))))
    .onFalse(rejected))
  .add(contactReady).to(hasAddress.onTrue(createProperty.to(jobRequest)).onFalse(jobRequest))
  .add(jobRequest).to(createJob).to(plan).to(send.chain);
for (const [from, to] of send.links) w = w.add(from).to(to);
export default w.add(buildResponse).to(respondAccepted);
