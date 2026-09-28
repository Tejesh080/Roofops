import { workflow, node, trigger, ifElse, switchCase, expr } from '@n8n/workflow-sdk';

const AIRTABLE = { airtableApi: { id: '9oxseGuocpt3UtcB', name: 'Roofops Airtable account' } };
const PG = { postgres: { id: 'kWqjtv0gz7ref2EN', name: 'RoofOps Postgres' } };
const RAW = { response: { response: { fullResponse: true, neverError: true } }, timeout: 20000 };
const BASE_ID = 'appMc8V0Wm29tEeHQ';
const QUOTES = 'https://api.airtable.com/v0/' + BASE_ID + '/tblzenPRNVV5O7lZP';
const DRIVE_WF = '9Sf3qrNhb31KMrrF';
const AIRTABLE_WF = 'gtUffpzbdGa0vbYj';

const ping = trigger({ type: 'n8n-nodes-base.webhook', version: 2.1, config: { name: 'Airtable Webhook Ping',
  parameters: { httpMethod: 'POST', path: 'roofops/airtable/quote-events', responseMode: 'onReceived', options: { noResponseBody: true } } },
  output: [{ body: { base: { id: BASE_ID }, webhook: { id: 'achXXXXXXXXXXXXXX' }, timestamp: '2026-09-29T00:00:00.000Z' } }] });

const validatePing = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Validate Ping',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
// Airtable pings carry no record data: they only say "new payloads exist". Everything we act on is
// fetched from Airtable with our own credential, so a forged ping can at worst cause one extra read.
const b = $input.first().json.body || {};
const hook = b.webhook && b.webhook.id;
if (!b.base || b.base.id !== 'appMc8V0Wm29tEeHQ' || !/^ach[A-Za-z0-9]{14}$/.test(hook || '')) return [];
const replay = Number.isInteger(b.replay_from_cursor) && b.replay_from_cursor >= 1 ? b.replay_from_cursor : null;
return [{ json: { webhook_id: hook, replay_from_cursor: replay, ping_timestamp: b.timestamp || null } }];` } },
  output: [{ webhook_id: 'achXXXXXXXXXXXXXX', replay_from_cursor: null }] });

const loadCursor = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Load Payload Cursor',
  parameters: { operation: 'executeQuery', query: 'select wf_airtable_cursor($1)::text as cursor',
    options: { queryReplacement: expr('{{ [ $json.webhook_id ] }}') } }, credentials: PG },
  output: [{ cursor: '1' }] });

const listPayloads = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'List Airtable Payloads',
  retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  parameters: { method: 'GET', url: expr("https://api.airtable.com/v0/bases/" + BASE_ID + "/webhooks/{{ $('Validate Ping').first().json.webhook_id }}/payloads"),
    authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableApi',
    sendQuery: true, queryParameters: { parameters: [
      { name: 'cursor', value: expr("{{ $('Validate Ping').first().json.replay_from_cursor ?? $json.cursor }}") },
      { name: 'limit', value: '50' }] },
    options: { timeout: 20000, pagination: { pagination: { paginationMode: 'updateAParameterInEachRequest',
      parameters: { parameters: [{ type: 'qs', name: 'cursor', value: expr('{{ $response.body.cursor }}') }] },
      paginationCompleteWhen: 'other', completeExpression: expr('{{ !$response.body.mightHaveMore }}'), limitPagesFetched: true, maxRequests: 20 } } } },
  credentials: AIRTABLE }, output: [{ cursor: 2, mightHaveMore: false, payloads: [] }] });

const extract = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Extract Acceptance Events',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const T = 'tblzenPRNVV5O7lZP';
const F = { number: 'fldyP20HNafS614d5', status: 'fldQpTa5tvrzlNg1h', version: 'fldEjEqlzE8Y0M1nf', roofopsId: 'fldVUpqZkVKid3Fyy', acceptedOn: 'fldfhsHggkGd8GKVq' };
const hook = $('Validate Ping').first().json.webhook_id;
let next = Number($('Load Payload Cursor').first().json.cursor);
const name = function (v) { return v && typeof v === 'object' ? v.name : v; };
const events = [];
let payloads = 0;
for (const it of $input.all()) {
  const page = it.json;
  if (page.cursor) next = Math.max(next, Number(page.cursor));
  for (const p of (page.payloads || [])) {
    payloads++;
    const t = (p.changedTablesById || {})[T];
    if (!t) continue;
    for (const rec of Object.keys(t.changedRecordsById || {})) {
      const ch = t.changedRecordsById[rec];
      const prev = (ch.previous || {}).cellValuesByFieldId || {};
      const cur = Object.assign({}, (ch.unchanged || {}).cellValuesByFieldId, (ch.current || {}).cellValuesByFieldId);
      if (!(F.status in prev) || name(cur[F.status]) !== 'Accepted' || name(prev[F.status]) === 'Accepted') continue;
      const payload = { quote_id: cur[F.number] === undefined ? null : cur[F.number], accepted_version: cur[F.version] === undefined ? null : cur[F.version], airtable_record_id: rec };
      if (cur[F.roofopsId]) payload.quote_uuid = cur[F.roofopsId];
      if (cur[F.acceptedOn]) payload.accepted_on = cur[F.acceptedOn];
      const eventId = 'airtable:' + hook + ':txn' + p.baseTransactionNumber + ':' + rec;
      const user = ((p.actionMetadata || {}).sourceMetadata || {}).user || {};
      events.push({ event: { event_id: eventId, correlation_id: eventId, event_type: 'quote.accepted', source: 'airtable',
        actor_id: user.id || (p.actionMetadata || {}).source || 'airtable', occurred_at: p.timestamp, payload: payload },
        quote_record_id: rec, quote_number: payload.quote_id });
    }
  }
}
if (events.length === 0) return [{ json: { no_events: true, next_cursor: next, webhook_id: hook, payloads_read: payloads } }];
return events.map(function (e) { return { json: Object.assign(e, { next_cursor: next, webhook_id: hook, payloads_read: payloads }) }; });` } },
  output: [{ event: { event_id: 'airtable:ach:txn1:rec' }, quote_record_id: 'rec', next_cursor: 2, webhook_id: 'ach' }] });

const anyEvents = ifElse({ version: 2.3, config: { name: 'Any Acceptance Events?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.no_events !== true }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

const accept = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Accept Quote In Postgres',
  parameters: { operation: 'executeQuery',
    query: 'select wf_quote_accepted($1::jsonb, $2) as r, $3::text as quote_record_id, $4::text as event_id',
    options: { queryReplacement: expr("{{ [ JSON.stringify($json.event), 'n8n:' + $execution.id, $json.quote_record_id, $json.event.event_id ] }}") } },
  credentials: PG }, output: [{ r: { status: 'CREATED', outcome: 'CREATED' }, quote_record_id: 'rec', event_id: 'airtable:x' }] });

const advance = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Advance Payload Cursor', executeOnce: true,
  parameters: { operation: 'executeQuery', query: 'select wf_airtable_cursor_advance($1, $2::bigint)::text as cursor',
    options: { queryReplacement: expr("{{ [ $('Extract Acceptance Events').first().json.webhook_id, String($('Extract Acceptance Events').first().json.next_cursor) ] }}") } },
  credentials: PG }, output: [{ cursor: '2' }] });

const normalise = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Normalise Outcome',
  parameters: { mode: 'runOnceForEachItem', jsCode: `
const r = $json.r;
const pending = (r.pending_side_effects || []).map(function (p) { return p.topic; });
const needs = r.outcome === 'CREATED' || (r.outcome === 'ALREADY_PROCESSED' && pending.length > 0);
return { json: { outcome: r.outcome, needs_side_effects: needs, pending_topics: pending, r: r,
  event_id: $json.event_id, quote_record_id: $json.quote_record_id, project_id: r.project_id || null, project_number: r.project_number || null,
  quote_number: r.quote_number || null,
  drive_key: r.project_id ? 'drive:project-folder:' + r.project_id : null,
  airtable_key: r.project_id ? 'airtable:project-writeback:' + r.project_id : null } };` } },
  output: [{ outcome: 'CREATED', needs_side_effects: true, project_id: 'uuid' }] });

const route = switchCase({ version: 3.4, config: { name: 'Side Effects Needed?',
  parameters: { mode: 'expression', numberOutputs: 2, output: expr('{{ $json.needs_side_effects ? 0 : 1 }}') } } });

const runDrive = node({ type: 'n8n-nodes-base.executeWorkflow', version: 1.3, config: { name: 'Run Drive Project Folder',
  parameters: { mode: 'each', source: 'database', workflowId: { __rl: true, mode: 'id', value: DRIVE_WF }, options: { waitForSubWorkflow: true } } },
  output: [{ drive: { status: 'DONE' } }] });

const runAirtable = node({ type: 'n8n-nodes-base.executeWorkflow', version: 1.3, config: { name: 'Run Airtable Project Write-back',
  parameters: { mode: 'each', source: 'database', workflowId: { __rl: true, mode: 'id', value: AIRTABLE_WF }, options: { waitForSubWorkflow: true } } },
  output: [{ airtable: { status: 'DONE' } }] });

const compose = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Compose Quote Status',
  parameters: { mode: 'runOnceForEachItem', jsCode: `
const j = $json;
const r = j.r || {};
let status; let msg;
if (j.outcome === 'INVALID_EVENT' || j.outcome === 'INVALID_STATE') {
  status = 'Rejected';
  msg = 'Rejected (' + r.error_class + '): ' + (r.message || (r.issues || []).join('; ')) + '. Exception ' + r.exception_number + '. No project was created.';
} else {
  const d = j.drive || {}; const a = j.airtable || {};
  const complete = !j.needs_side_effects || (d.status === 'DONE' && a.status === 'DONE');
  if (!complete) {
    status = 'Failed';
    const which = d.status !== 'DONE' ? d : a;
    msg = j.project_number + ' exists in RoofOps, but the ' + (d.status !== 'DONE' ? 'Drive folder' : 'Airtable write-back') + ' is ' + which.status +
      (which.exception_number ? ' (exception ' + which.exception_number + ')' : '') + (which.message ? ': ' + which.message : '') + '. It will not be created twice.';
  } else if (j.outcome === 'CREATED') {
    status = 'Project created';
    msg = j.project_number + ' created. Drive folder: ' + d.web_view_link + ' . Airtable project ' + a.project_record_id + '.';
  } else {
    status = 'Duplicate ignored';
    msg = 'Already processed as ' + j.project_number + ' (delivery ' + r.delivery_count + '). Nothing was re-created.' +
      (j.needs_side_effects ? ' Unfinished steps were completed: ' + j.pending_topics.join(', ') + '.' : '');
  }
}
return { json: Object.assign({}, j, { quote_status: status, quote_message: msg + ' [event ' + j.event_id + ']' }) };` } },
  output: [{ quote_status: 'Project created', quote_message: 'x', quote_record_id: 'rec' }] });

const writeStatus = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Write Quote Automation Status',
  retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  parameters: { method: 'PATCH', url: expr(QUOTES + '/{{ $json.quote_record_id }}'), authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableApi',
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: expr("{{ JSON.stringify({ returnFieldsByFieldId: true, fields: { fldVc9vw112vrP33n: $json.quote_status, fldC70PHs4gQh8M42: $json.quote_message } }) }}"),
    options: { timeout: 20000 } },
  credentials: AIRTABLE }, output: [{ id: 'rec', fields: {} }] });

const readStatus = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Back Quote Status',
  retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  parameters: { method: 'GET', url: expr(QUOTES + "/{{ $('Compose Quote Status').item.json.quote_record_id }}"), authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableApi',
    sendQuery: true, queryParameters: { parameters: [{ name: 'returnFieldsByFieldId', value: 'true' }] }, options: { timeout: 20000 } },
  credentials: AIRTABLE }, output: [{ id: 'rec', fields: {} }] });

const verifyStatus = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Verify Quote Status',
  parameters: { mode: 'runOnceForEachItem', jsCode: `
const want = $('Compose Quote Status').item.json;
const f = $json.fields || {};
const got = f.fldVc9vw112vrP33n && typeof f.fldVc9vw112vrP33n === 'object' ? f.fldVc9vw112vrP33n.name : f.fldVc9vw112vrP33n;
if (got !== want.quote_status || f.fldC70PHs4gQh8M42 !== want.quote_message) {
  throw new Error('Airtable quote ' + want.quote_record_id + ' read back "' + got + '", expected "' + want.quote_status + '"');
}
return { json: { verified: true, outcome: want.outcome, quote: want.quote_number, quote_record_id: want.quote_record_id, quote_status: got,
  project_number: want.project_number, project_id: want.project_id, drive: want.drive || null, airtable: want.airtable || null, event_id: want.event_id } };` } },
  output: [{ verified: true }] });

export default workflow('roofops-quote-accepted-to-project', '[RoofOps] 01 Quote Accepted → Project')
  .add(ping).to(validatePing).to(loadCursor).to(listPayloads).to(extract).to(anyEvents
    .onTrue(accept)
    .onFalse(advance))
  .add(accept).to(advance)
  .add(accept).to(normalise).to(route
    .onCase(0, runDrive.to(runAirtable).to(compose))
    .onCase(1, compose))
  .add(compose).to(writeStatus).to(readStatus).to(verifyStatus);
