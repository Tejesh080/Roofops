// Shared by every Lite workflow that sends: the planned messages of node `plan` go out at most once each.
//
// A plan node returns { sends: [outMessage...], logs: [skipLog fields...], updates: [{ table, id, fields }...], summary }.
//   1. Reserve: every planned message is written to the Message Log first (Status Sending, its Dedupe Key, the CRM
//      updates to make once it is sent), together with the Skipped rows.
//   2. Confirm: the log is read back by Dedupe Key. If another run reserved the same message earlier, this run's row
//      loses (Skipped, "duplicate") and nothing is sent: Airtable has no conditional write, so the earliest row wins.
//      In twilio mode, numbers that are not on the live test allowlist are blocked here.
//   3. Deliver: the TEST sink (Simulated Sent) or Twilio, one request per message.
//   4. Record: each row gets its outcome (Simulated Sent / Sent / Failed / Unknown, Message SID, error code), the CRM
//      updates of the messages that went out are made, and a Twilio "unsubscribed" (21610) opts the contact out.
// A message whose outcome is Unknown (a timeout) is never resent by itself: [Lite] Monitor checks with Twilio first.
const sendPipeline = (plan, summaryNode) => {
  const reserve = code('Reserve Messages', `
const p = $('${plan}').first().json;
const rows = p.logs.map((f) => ({ fields: f })).concat(p.sends.map((s) => ({ fields: Object.assign({}, s.fields, { Status: 'Sending', Attempts: 1, 'On Success': JSON.stringify(s.onSuccess) }) })));
const b = chunk(rows, 10);
return b.length ? b.map((x) => ({ json: { request: { typecast: false, records: x } } })) : [{ json: { none: true } }];`);
  const anyRows = OK_IF('Rows To Reserve?', '{{ $json.none !== true }}');
  const writeRows = airtableWrite('Write Reservations', 'POST', T.messages);
  const check = code('Reservation Check', `
const p = $('${plan}').first().json;
const created = {};
if ($('Write Reservations').isExecuted) $('Write Reservations').all().forEach((i) => records(i.json, 'reserve messages').forEach((r) => {
  if ((r.fields || {}).Status === 'Sending') created[r.fields['Dedupe Key']] = r.id; }));
const keys = p.sends.map((s) => s.key);
return [{ json: { none: !keys.length, created: created,
  formula: keys.length ? 'OR(' + keys.map((k) => "{Dedupe Key}='" + formulaText(k) + "'").join(',') + ')' : 'FALSE()' } }];`);
  const anySends = OK_IF('Messages To Confirm?', '{{ $json.none !== true }}');
  const findRows = airtableList('Find Reservations', T.messages, '{{ $json.formula }}');
  const pick = code('Pick Winners', `
const p = $('${plan}').first().json;
const created = $('Reservation Check').first().json.created;
const rows = $('Find Reservations').isExecuted ? records($('Find Reservations').first().json, 'find reservations') : [];
const T = CFG.messaging.mode === 'twilio' ? CFG.messaging.twilio : null;
const allowed = (n) => !T || T.allowAllRecipients === true || T.allowedRecipients.indexOf(n) >= 0;
const decisions = p.sends.map((s) => {
  const mine = created[s.key];
  if (!mine) throw new Error('reserve messages: no Message Log row was written for ' + s.key);
  const first = rows.filter((r) => (r.fields || {})['Dedupe Key'] === s.key && (r.fields || {}).Status !== 'Skipped')
    .sort((a, b) => (Date.parse(a.createdTime) - Date.parse(b.createdTime)) || (a.id < b.id ? -1 : 1))[0];
  const d = { key: s.key, logId: mine, channel: s.channel, to: s.to, body: s.body };
  if (first && first.id !== mine) {
    // Two copies of one form reserve within moments of each other. A message reserved long before belongs to an earlier
    // enquiry: this one is not sent again today, but it is not a duplicate of it either (its job is kept).
    const me = rows.find((r) => r.id === mine);
    const together = !me || Math.abs(Date.parse(me.createdTime) - Date.parse(first.createdTime)) <= 10 * 60000;
    const ref = first.fields['Log Ref'] || first.id;
    return Object.assign(d, together ? { action: 'lost', reason: 'duplicate: ' + ref + ' already handles this message' }
      : { action: 'repeat', reason: 'not sent: ' + ref + ' already sent this message earlier today' });
  }
  if (T && !allowed(toE164(s.to))) return Object.assign(d, { action: 'blocked', reason: 'not sent: ' + toE164(s.to) + ' is not on the live test allowlist' });
  return Object.assign(d, { action: 'deliver', to164: toE164(s.to) });
});
const go = decisions.filter((d) => d.action === 'deliver');
if (!go.length) return [{ json: { none: true, decisions: decisions } }];
return go.map((d, i) => ({ json: Object.assign({}, d, i === 0 ? { decisions: decisions } : {}) }));`);
  const anyDeliveries = OK_IF('Anything To Send?', '{{ $json.none !== true }}');
  const deliverName = TWILIO ? 'Send SMS (Twilio)' : 'Simulated Delivery';
  const deliver = TWILIO
    ? twilioCall(deliverName, 'POST', `${TWILIO_API}/Messages.json`, smsForm('{{ $json.body }}'))
    : code(deliverName, `
// The TEST message sink: records what would be sent. No provider is called; nothing reaches a real phone or inbox.
return $input.all().map((i) => ({ json: { statusCode: 201, body: { sid: 'SIM' + String(i.json.logId).slice(3), status: 'simulated' } } }));`);
  const recordResults = code('Record Results', `
const p = $('${plan}').first().json;
const decisions = $('Pick Winners').first().json.decisions;
const results = $('${deliverName}').isExecuted ? $('${deliverName}').all().map((i) => i.json) : [];
const byKey = {}; p.sends.forEach((s) => { byKey[s.key] = s; });
const list = (p.updates || []).slice();
const tally = { sent: 0, failed: 0, unknown: 0, duplicates: 0, blocked: 0, results: [] };
// On a trial account Twilio sends its own template text; the log keeps Lite's wording and says so.
const trial = CFG.messaging.mode === 'twilio' && CFG.messaging.twilio.trialTemplate ? CFG.messaging.twilio.trialTemplate : null;
let k = 0;
for (const d of decisions) {
  const s = byKey[d.key];
  let f;
  if (d.action === 'deliver') {
    const r = results[k++];
    const c = CFG.messaging.mode === 'twilio' ? classify(r) : { status: 'Simulated Sent', sid: r.body.sid, errorCode: null, reason: null };
    const note = trial && c.status === 'Sent' ? 'Twilio trial: sent as the Twilio template ' + trial + ' (a trial account cannot send this text)' : null;
    f = { Status: c.status, 'Provider Message ID': c.sid || null, 'Error Code': c.errorCode || null, Reason: c.reason || note };
    if (c.status === 'Sent' || c.status === 'Simulated Sent') { tally.sent++; s.onSuccess.forEach((x) => list.push(x)); }
    else if (c.status === 'Failed') tally.failed++;
    else tally.unknown++;
    if (c.optOut && s.contactId) list.push({ table: 'contacts', id: s.contactId, fields: { 'Opted Out': true, 'Opted Out At': iso(NOW), 'Marketing Opt-In': false } });
    tally.results.push({ key: d.key, status: c.status, reason: c.reason || null, sid: c.sid || null });
  } else {
    if (d.action === 'lost') { tally.duplicates++; s.onLost.forEach((x) => list.push(x)); } else if (d.action === 'repeat') tally.duplicates++; else tally.blocked++;
    f = { Status: 'Skipped', Reason: d.reason };
    tally.results.push({ key: d.key, status: 'Skipped', reason: d.reason });
  }
  list.push({ table: 'messages', id: d.logId, fields: f });
}
const items = patches(list);
return items.length ? items.map((x, i) => ({ json: Object.assign(x, i === 0 ? { outcome: tally } : {}) })) : [{ json: { none: true, outcome: tally } }];`);
  const anyUpdates = OK_IF('Updates To Write?', '{{ $json.none !== true }}');
  const writeUpdates = airtablePatch('Write Updates');
  // The chain, ending in the workflow's own summary node.
  const chain = reserve.to(anyRows.onTrue(writeRows.to(check)).onFalse(check));
  const links = [
    [check, anySends.onTrue(findRows.to(pick)).onFalse(pick)],
    [pick, anyDeliveries.onTrue(deliver.to(recordResults)).onFalse(recordResults)],
    [recordResults, anyUpdates.onTrue(writeUpdates.to(summaryNode)).onFalse(summaryNode)],
  ];
  return { head: reserve, chain, links };
};
