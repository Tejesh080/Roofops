import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';
// @include common
// [Lite] Instant Lead Follow-Up. A website form (or any system) POSTs a lead to the webhook. It is validated and
// normalised, de-duplicated against the CRM (same email or phone with an open enquiry inside the window), saved as
// Contact + Property + Job (Stage New Lead), acknowledged on the channel the person consented to (TEST sink: nothing is
// really sent), logged in the Message Log, and the job moves to Contacted. The caller gets a JSON answer.

const hook = trigger({ type: 'n8n-nodes-base.webhook', version: 2, config: { name: 'Lead Webhook', ...HOOK_CRED,
  parameters: { httpMethod: 'POST', path: CONFIG.leadIntake.webhookPath, responseMode: 'responseNode', ...HOOK_AUTH, options: {} } }, output: [{ body: {} }] });

const validate = code('Validate Lead', `
const b = ($input.first().json.body) || {};
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
const contactConds = [email ? "LOWER({Email})='" + formulaText(email) + "'" : '', phone ? "{Phone Normalized}='" + formulaText(phone) + "'" : ''].filter(Boolean);
return [{ json: { ok: true,
  lead: { name: name, firstName: clean(b.first_name).slice(0, 60) || firstNameOf(name), email: email, phone: phone, suburb: clean(b.suburb).slice(0, 80), address: clean(b.address).slice(0, 200),
    postcode: clean(b.postcode).slice(0, 10), service: clean(b.service).slice(0, 120), message: clean(b.message).slice(0, 2000), source: source,
    consentSms: yes(b.consent_sms), consentEmail: yes(b.consent_email), marketing: yes(b.marketing_opt_in),
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
  return [{ json: { duplicate: true, job: j, contact: contact, request: { typecast: false, records: [{ fields: Object.assign({ 'Log Ref': logRef('LM'), Workflow: 'Lead Follow-Up',
    Job: [j.id], Status: 'Skipped', Reason: 'repeat enquiry within ' + CFG.leadIntake.dedupeWindowDays + ' days of ' + (j.fields['Job Ref'] || j.id),
    'Dedupe Key': 'lead-repeat:' + j.id + ':' + iso(NOW).slice(0, 10), Provider: CFG.messaging.provider, 'Attempted At': iso(NOW), 'Demo Data': L.demo },
    contact ? { Contact: [contact.id] } : {}) }] } } }];
}
const fields = { Name: L.name, 'First Name': L.firstName, Source: L.source, 'Preferred Channel': L.preferred,
  'Consent SMS': L.consentSms, 'Consent Email': L.consentEmail, 'Marketing Opt-In': L.marketing, 'Demo Data': L.demo };
if (L.email) fields.Email = L.email;
if (L.phone) { fields.Phone = L.phone; fields['Phone Normalized'] = L.phone; }
if (L.suburb) fields.Suburb = L.suburb;
return [{ json: { duplicate: false, newContact: !contact, contact: contact, request: contact ? null : { typecast: false, records: [{ fields: fields }] } } }];`);
const duplicate = OK_IF('Duplicate?', '{{ $json.duplicate }}');
const logDuplicate = airtableWrite('Log Duplicate', 'POST', T.messages);
const duplicateResponse = code('Duplicate Response', `
records($input.first().json, 'log duplicate');
const d = $('Decide').first().json;
return [{ json: { response: { status: 200, body: { ok: true, duplicate: true, job_ref: d.job.fields['Job Ref'] || null,
  message: 'We already have this enquiry and will be in touch.' } } } }];`);
const respondDuplicate = respond('Respond Duplicate');

const newContact = OK_IF('New Contact?', '{{ $json.newContact }}');
const createContact = airtableWrite('Create Contact', 'POST', T.contacts);
const contactReady = code('Contact Ready', `
const d = $('Decide').first().json; const L = $('Validate Lead').first().json.lead;
// An existing contact is reused as it is: consent it already has stays, an opt-out always stands (staff change consent).
const contact = d.newContact ? records($('Create Contact').first().json, 'create contact')[0] : d.contact;
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
const compose = code('Compose Acknowledgement', `
const job = records($input.first().json, 'create job')[0];
const contact = $('Contact Ready').first().json.contact; const cf = contact.fields || {};
const L = $('Validate Lead').first().json.lead;
const v = vars(cf, job.fields || {});
const ch = channelFor(cf);
let d = null; let status = 'Skipped'; let reason = null;
if (ch.skip) reason = ch.skip;
else {
  const subject = ch.channel === 'Email' ? render(CFG.leadIntake.emailSubject, v) : null;
  d = deliver(ch.channel, ch.to, subject, render(ch.channel === 'SMS' ? CFG.leadIntake.sms : CFG.leadIntake.email, v));
  status = d.status;
}
const fields = { 'Log Ref': logRef('LM'), Workflow: 'Lead Follow-Up', Job: [job.id], Contact: [contact.id], Status: status,
  'Dedupe Key': 'lead-ack:' + job.id, Provider: CFG.messaging.provider, 'Attempted At': iso(NOW), 'Demo Data': L.demo };
if (d) { fields.Channel = d.channel; fields.To = d.to; fields.Body = (d.subject ? 'Subject: ' + d.subject + '\\n\\n' : '') + d.body; }
if (reason) fields.Reason = reason;
return [{ json: { job: job, delivery: d, status: status, reason: reason, request: { typecast: false, records: [{ fields: fields }] } } }];`);
const logDelivery = airtableWrite('Log Delivery', 'POST', T.messages);
const jobUpdate = code('Job Update', `
records($input.first().json, 'log delivery');
const a = $('Compose Acknowledgement').first().json;
const fields = { 'Last Activity At': iso(NOW) };
if (a.status === 'Simulated Sent') fields.Stage = 'Contacted';
return [{ json: { request: { typecast: false, records: [{ id: a.job.id, fields: fields }] } } }];`);
const updateJob = airtableWrite('Update Job', 'PATCH', T.jobs);
const buildResponse = code('Build Response', `
records($input.first().json, 'update job');
const a = $('Compose Acknowledgement').first().json;
return [{ json: { response: { status: 200, body: { ok: true, duplicate: false, job_ref: a.job.fields['Job Ref'], new_contact: $('Decide').first().json.newContact,
  stage: a.status === 'Simulated Sent' ? 'Contacted' : 'New Lead',
  acknowledgement: { status: a.status, channel: a.delivery ? a.delivery.channel : null, reason: a.reason } } } } }];`);
const respondAccepted = respond('Respond Accepted');

export default workflow('roofops-lite-lead-follow-up', '[Lite] Instant Lead Follow-Up')
  .add(hook).to(validate).to(valid
    .onTrue(findContact.to(jobsFormula).to(findJobs).to(decide).to(duplicate
      .onTrue(logDuplicate.to(duplicateResponse).to(respondDuplicate))
      .onFalse(newContact.onTrue(createContact.to(contactReady)).onFalse(contactReady))))
    .onFalse(rejected))
  .add(contactReady).to(hasAddress.onTrue(createProperty.to(jobRequest)).onFalse(jobRequest))
  .add(jobRequest).to(createJob).to(compose).to(logDelivery).to(jobUpdate).to(updateJob).to(buildResponse).to(respondAccepted);
