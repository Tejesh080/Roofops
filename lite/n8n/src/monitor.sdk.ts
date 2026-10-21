import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';
// @include common
// @include send
// [Lite] Monitor. Uses n8n's own error handling and the Airtable CRM; no other monitoring system.
// - Workflow Failed (Error Trigger): set this workflow as the "Error workflow" of the other four (n8n.errorWorkflowId).
//   Every failed production run becomes a Lite Alerts row (workflow, execution, the node that failed, the error).
// - Every few hours (and Run Now): messages stuck in Sending become Unknown; Failed and Unknown messages, leads nobody
//   contacted, and Completed jobs without a Completed At date are raised as alerts (once each).
// - Retry Requested (ticked by staff on a Failed or Unknown message): Lite first asks Twilio whether the message went out
//   (by Message SID, or by recipient and text). Found: the row is corrected and nothing is resent. Not found: it is sent
//   again once, through the same reserve-and-confirm pipeline, so two runs cannot both resend it. Opted-out contacts,
//   Twilio "unsubscribed" (21610) errors and messages that cannot be checked are never resent.
// - New alerts can also be texted to the operator (monitoring.operatorPhone).

const failed = trigger({ type: 'n8n-nodes-base.errorTrigger', version: 1, config: { name: 'Workflow Failed', parameters: {} }, output: [{ execution: {}, workflow: {} }] });
const every = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1.3, config: { name: `Every ${CONFIG.monitoring.everyHours} Hours`,
  parameters: { rule: { interval: [{ field: 'hours', hoursInterval: CONFIG.monitoring.everyHours }] } } }, output: [{}] });
const manual = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run Now', parameters: {} }, output: [{}] });

const failureAlert = code('Failure Alert', `
const e = $input.first().json; const x = e.execution || {}; const w = e.workflow || {};
return [{ json: { alerts: [{ 'Alert Ref': logRef('AL'), Kind: 'Workflow Failed', Status: 'Open', Workflow: clean(w.name) || clean(w.id), Execution: clean(x.url || x.id),
  Detail: 'Stopped at "' + clean(x.lastNodeExecuted) + '": ' + clean((x.error || {}).message).slice(0, 2000) + (x.retryOf ? ' (retry of execution ' + x.retryOf + ')' : ''),
  'Dedupe Key': 'exec:' + clean(x.id), 'Raised At': iso(NOW), 'Demo Data': false }] } }];`);

const findProblems = airtableList('Find Message Problems', T.messages, "OR({Status}='Sending',{Status}='Failed',{Status}='Unknown',{Retry Requested})");
const contactFormula = code('Retry Contacts Formula', `
const msgs = records($input.first().json, 'find message problems');
const ids = Array.from(new Set(msgs.filter((m) => (m.fields || {})['Retry Requested']).map((m) => ((m.fields || {}).Contact || [])[0]).filter(Boolean)));
return [{ json: { formula: ids.length ? 'OR(' + ids.map((i) => "RECORD_ID()='" + formulaText(i) + "'").join(',') + ')' : 'FALSE()' } }];`);
const findContacts = airtableList('Find Retry Contacts', T.contacts, '{{ $json.formula }}');
const findJobs = airtableList('Find Stale Jobs', T.jobs, "OR({Stage}='New Lead',AND({Stage}='Completed',{Completed At}=BLANK()))");
const planHealth = code('Plan Health', `
const msgs = records($('Find Message Problems').first().json, 'find message problems');
const contacts = {}; records($('Find Retry Contacts').first().json, 'find retry contacts').forEach((c) => { contacts[c.id] = c; });
const jobs = records($input.first().json, 'find stale jobs');
const M = CFG.monitoring; const alerts = []; const updates = []; const retries = [];
const summary = { problem_messages: msgs.length, stuck_sending: 0, failed: 0, unknown: 0, retry_requests: 0, stale_leads: 0, incomplete_jobs: 0 };
const recent = (f, m) => NOW.getTime() - (Date.parse(f['Attempted At'] || m.createdTime) || 0) < days(14);   // older problems were raised already
const alert = (kind, ref, key, detail, demo, wf) => alerts.push({ 'Alert Ref': logRef('AL'), Kind: kind, Status: 'Open', Detail: detail, Workflow: wf || '', 'Record Ref': clean(ref),
  'Dedupe Key': key, 'Raised At': iso(NOW), 'Demo Data': !!demo });
for (const m of msgs) {
  const f = m.fields || {}; let status = f.Status; let reason = f.Reason; const ref = f['Log Ref'] || m.id;
  if (status === 'Sending' && NOW.getTime() - (Date.parse(f['Attempted At'] || m.createdTime) || 0) > M.stuckSendingMinutes * 60000) {
    summary.stuck_sending++; status = 'Unknown';   // the alert below reports the reason written now, not the empty one read
    reason = 'no result recorded ' + M.stuckSendingMinutes + ' minutes after sending started: it may have been sent; check before retrying';
    updates.push({ table: 'messages', id: m.id, fields: { Status: 'Unknown', 'Error Code': 'stuck', Reason: reason } });
  }
  if (status === 'Failed') { summary.failed++; if (recent(f, m)) alert('Delivery Failed', ref, 'msg:' + m.id + ':failed', f.Workflow + ' message to ' + clean(f.To) + ' failed: ' + clean(reason || f['Error Code']) + '. Fix the cause, then tick Retry Requested.', f['Demo Data'], f.Workflow); }
  if (status === 'Unknown') { summary.unknown++; if (recent(f, m)) alert('Delivery Unknown', ref, 'msg:' + m.id + ':unknown', f.Workflow + ' message to ' + clean(f.To) + ' has no confirmed result: ' + clean(reason || f['Error Code']) + '. Tick Retry Requested: Lite checks with Twilio before resending.', f['Demo Data'], f.Workflow); }
  if (f['Retry Requested']) {
    summary.retry_requests++;
    const c = contacts[(f.Contact || [])[0]];
    let why = null;
    if (status !== 'Failed' && status !== 'Unknown') why = 'not retried: the message is ' + status;
    else if (f['Error Code'] === '21610') why = 'not retried: the person unsubscribed from this number (Twilio 21610)';
    else if (c && (c.fields || {})['Opted Out']) why = 'not retried: the contact has opted out';
    else if (CHANNELS.indexOf(f.Channel) < 0 || (f.Channel === 'SMS' && !normPhone(f.To))) why = 'not retried: no usable ' + (f.Channel || 'channel');
    if (why) updates.push({ table: 'messages', id: m.id, fields: { 'Retry Requested': false, Reason: why } });
    else retries.push({ id: m.id, ref: ref, fields: f });
  }
}
for (const j of jobs) {
  const f = j.fields || {};
  if (f.Stage === 'New Lead' && NOW.getTime() - (Date.parse(f['Lead Received At'] || j.createdTime) || 0) > M.staleLeadHours * 3600000) {
    summary.stale_leads++; alert('Stuck Lead', f['Job Ref'], 'job:' + j.id + ':stale', 'New Lead for more than ' + M.staleLeadHours + ' hours: nobody has contacted them yet.', f['Demo Data']); }
  if (f.Stage === 'Completed' && !f['Completed At']) {
    summary.incomplete_jobs++; alert('Incomplete Job', f['Job Ref'], 'job:' + j.id + ':no-completed-at', 'Completed without a Completed At date: the review request will never go out.', f['Demo Data']); }
}
return [{ json: { alerts: alerts, updates: updates, retries: retries, summary: summary } }];`);

const alertKeys = code('Alert Keys', `
const alerts = $input.first().json.alerts || [];
return [{ json: { alerts: alerts, none: !alerts.length, formula: alerts.length ? 'OR(' + alerts.map((a) => "{Dedupe Key}='" + formulaText(a['Dedupe Key']) + "'").join(',') + ')' : 'FALSE()' } }];`);
const anyKeys = OK_IF('Any Alerts?', '{{ $json.none !== true }}');
const findAlerts = airtableList('Find Existing Alerts', T.alerts, '{{ $json.formula }}');
const newAlerts = code('New Alerts', `
const a = $('Alert Keys').first().json;
const seen = new Set($('Find Existing Alerts').isExecuted ? records($('Find Existing Alerts').first().json, 'find existing alerts').map((r) => (r.fields || {})['Dedupe Key']) : []);
const fresh = a.alerts.filter((x) => !seen.has(x['Dedupe Key']));   // raised once, even after someone resolved it
const b = chunk(fresh.map((f) => ({ fields: f })), 10);
return b.length ? b.map((x) => ({ json: { request: { typecast: false, records: x } } })) : [{ json: { none: true } }];`);
const anyNew = OK_IF('Alerts To Save?', '{{ $json.none !== true }}');
const saveAlerts = airtableWrite('Save Alerts', 'POST', T.alerts);
const operatorMessage = code('Operator Message', `
const saved = $('Save Alerts').isExecuted ? [].concat(...$('Save Alerts').all().map((i) => records(i.json, 'save alerts'))) : [];
const phone = CFG.monitoring.operatorPhone;
const TW = CFG.messaging.mode === 'twilio' ? CFG.messaging.twilio : null;
const allowed = !TW || TW.allowAllRecipients === true || TW.allowedRecipients.indexOf(phone) >= 0;
if (!saved.length || !phone || !allowed) return [{ json: { none: true, raised: saved.length } }];
const kinds = {}; saved.forEach((r) => { const k = (r.fields || {}).Kind; kinds[k] = (kinds[k] || 0) + 1; });
return [{ json: { raised: saved.length, to164: phone, body: CFG.business.name + ' (Lite): ' + saved.length + ' new alert' + (saved.length > 1 ? 's' : '') + ': '
  + Object.keys(kinds).map((k) => kinds[k] + ' ' + k).join(', ') + '. See Lite Alerts in Airtable.' } }];`);
const notify = OK_IF('Notify Operator?', '{{ $json.none !== true }}');
const alertOperator = TWILIO
  ? twilioCall('Alert Operator', 'POST', `${TWILIO_API}/Messages.json`, smsForm('{{ $json.body }}', false))
  : code('Alert Operator', `
// TEST sink: the alert text is not sent anywhere; the Lite Alerts rows are the record.
return $input.all().map((i) => ({ json: { statusCode: 201, body: { sid: 'SIM-operator', status: 'simulated' }, text: i.json.body } }));`);

const retryChecks = code('Retry Checks', `
if (!$('Plan Health').isExecuted) return [{ json: { none: true } }];
const h = $('Plan Health').first().json;
if (!h.retries.length || CFG.messaging.mode !== 'twilio') return [{ json: { none: true } }];
const API = 'https://api.twilio.com/2010-04-01/Accounts/' + CFG.messaging.twilio.accountSid;
// Before any resend, ask Twilio: by Message SID when there is one, else by recipient and date (a timeout leaves no SID).
return h.retries.map((r) => { const f = r.fields; const sid = clean(f['Provider Message ID']);
  const since = iso(Date.parse(f['Attempted At'] || '') - days(1)).slice(0, 10);
  return { json: { id: r.id, checkUrl: /^(SM|MM)[0-9a-f]{32}$/.test(sid) ? API + '/Messages/' + sid + '.json'
    : API + '/Messages.json?To=' + encodeURIComponent(toE164(f.To)) + '&DateSent%3E=' + since + '&PageSize=50' } }; });`);
const planRetries = code('Plan Retries', `
const h = $('Plan Health').isExecuted ? $('Plan Health').first().json : { retries: [], updates: [], summary: {} };
const checks = CFG.messaging.mode === 'twilio' && $('Check Delivery').isExecuted ? $('Check Delivery').all().map((i) => i.json) : [];
const updates = h.updates.slice(); const sends = [];
const summary = Object.assign({}, h.summary, { retried: 0, found_already_sent: 0, retry_postponed: 0 });
h.retries.forEach((r, i) => {
  const f = r.fields;
  let found = null;
  if (CFG.messaging.mode === 'twilio') {
    const c = checks[i] || {}; const b = c.body || {};
    if (c.statusCode === 200) {
      const since = (Date.parse(f['Attempted At'] || '') || 0) - 120000;
      // On a trial account Twilio sent its template text, not Lite's wording: any message to them since the attempt counts.
      const sameText = (x) => (CFG.messaging.twilio.trialTemplate ? true : clean(x.body) === clean(f.Body));
      const list = b.sid ? [b] : (b.messages || []).filter((x) => sameText(x) && (Date.parse(x.date_created) || 0) >= since);
      found = list.find((x) => ['failed', 'undelivered', 'canceled'].indexOf(x.status) < 0) || null;   // failed/undelivered: Twilio confirms it did not arrive
    } else if (c.statusCode !== 404) {   // could not check (no answer, refused, test credentials): never resend blind
      summary.retry_postponed++;
      updates.push({ table: 'messages', id: r.id, fields: { Reason: 'retry postponed: could not check with Twilio (' + (c.statusCode || 'no answer') + '); Lite will try again on the next run' } });
      return;
    }
  }
  if (found) {
    summary.found_already_sent++;
    updates.push({ table: 'messages', id: r.id, fields: { Status: found.status === 'delivered' ? 'Delivered' : 'Sent', 'Provider Message ID': found.sid, 'Error Code': null,
      'Retry Requested': false, Reason: 'found at Twilio (' + found.status + '): not resent' } });
    JSON.parse(f['On Success'] || '[]').forEach((u) => updates.push(u));
    return;
  }
  const attempt = (Number(f.Attempts) || 1) + 1;
  summary.retried++;
  updates.push({ table: 'messages', id: r.id, fields: { 'Retry Requested': false, Attempts: attempt, Reason: (f.Reason ? f.Reason + '; ' : '') + 'resent as attempt ' + attempt } });
  const body = String(f.Body || '').replace(/^Subject: [^\\n]*\\n\\n/, '');
  const m = outMessage({ prefix: 'RT', workflow: f.Workflow, purpose: f.Purpose || 'Operational', key: f['Dedupe Key'] + ':retry:' + attempt, jobId: (f.Job || [])[0], contactId: (f.Contact || [])[0],
    demo: f['Demo Data'], channel: f.Channel, to: f.To, subject: null, body: body, onSuccess: JSON.parse(f['On Success'] || '[]') });
  m.fields['Retry Of'] = r.ref;
  sends.push(m);
});
return [{ json: { sends: sends, logs: [], updates: updates, summary: summary } }];`);
const summary = code('Monitor Summary', `
if ($('Write Updates').isExecuted) $('Write Updates').all().forEach((i) => records(i.json, 'write updates'));
const p = $('Plan Retries').first().json;
const o = $('Record Results').first().json.outcome;
return [{ json: Object.assign({ ok: true, ran_at: iso(NOW), mode: CFG.messaging.mode, alerts_raised: $('Operator Message').first().json.raised }, p.summary,
  { resent: o.sent, resend_failed: o.failed, resend_unknown: o.unknown }) }];`);
const send = sendPipeline('Plan Retries', summary);

let w = workflow('roofops-lite-monitor', '[Lite] Monitor')
  .add(failed).to(failureAlert).to(alertKeys)
  .add(every).to(findProblems)
  .add(manual).to(findProblems)
  .add(findProblems).to(contactFormula).to(findContacts).to(findJobs).to(planHealth).to(alertKeys)
  .add(alertKeys).to(anyKeys.onTrue(findAlerts.to(newAlerts)).onFalse(newAlerts))
  .add(newAlerts).to(anyNew.onTrue(saveAlerts.to(operatorMessage)).onFalse(operatorMessage))
  .add(operatorMessage).to(notify.onTrue(alertOperator.to(retryChecks)).onFalse(retryChecks));
if (TWILIO) {
  const anyChecks = OK_IF('Checks To Run?', '{{ $json.none !== true }}');
  const checkDelivery = twilioCall('Check Delivery', 'GET', expr('{{ $json.checkUrl }}'));
  w = w.add(retryChecks).to(anyChecks.onTrue(checkDelivery.to(planRetries)).onFalse(planRetries));
} else w = w.add(retryChecks).to(planRetries);
w = w.add(planRetries).to(send.chain);
for (const [from, to] of send.links) w = w.add(from).to(to);
export default w;
