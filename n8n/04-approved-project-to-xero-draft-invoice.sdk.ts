import { workflow, node, trigger, ifElse, switchCase, expr } from '@n8n/workflow-sdk';

const AIRTABLE = { airtableTokenApi: { id: '3XbFnHjAd7mFvBD2', name: 'Roofops Airtable Personal Access Token account' } };
const PG = { postgres: { id: 'kWqjtv0gz7ref2EN', name: 'RoofOps Postgres' } };
const BASE_ID = 'appMc8V0Wm29tEeHQ';
const PROJECTS = 'https://api.airtable.com/v0/' + BASE_ID + '/tblvUPIoebC3zoacv';
const XERO_WF = 'Y2deCFTZzpv1uo8C';

const ping = trigger({ type: 'n8n-nodes-base.webhook', version: 2.1, config: { name: 'Airtable Webhook Ping',
  parameters: { httpMethod: 'POST', path: 'roofops/airtable/project-invoice-events', responseMode: 'onReceived', options: { noResponseBody: true } } },
  output: [{ body: { base: { id: BASE_ID }, webhook: { id: 'achXXXXXXXXXXXXXX' } } }] });

const validatePing = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Validate Ping',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
// Pings carry no data; everything acted on is fetched from Airtable with our own credential.
const b = $input.first().json.body || {};
const hook = b.webhook && b.webhook.id;
if (!b.base || b.base.id !== 'appMc8V0Wm29tEeHQ' || !/^ach[A-Za-z0-9]{14}$/.test(hook || '')) return [];
const replay = Number.isInteger(b.replay_from_cursor) && b.replay_from_cursor >= 1 ? b.replay_from_cursor : null;
return [{ json: { webhook_id: hook, replay_from_cursor: replay } }];` } }, output: [{ webhook_id: 'ach' }] });

const loadCursor = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Load Payload Cursor',
  parameters: { operation: 'executeQuery', query: 'select wf_airtable_cursor($1)::text as cursor', options: { queryReplacement: expr('{{ [ $json.webhook_id ] }}') } },
  credentials: PG }, output: [{ cursor: '1' }] });

const listPayloads = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'List Airtable Payloads',
  retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  parameters: { method: 'GET', url: expr('https://api.airtable.com/v0/bases/' + BASE_ID + "/webhooks/{{ $('Validate Ping').first().json.webhook_id }}/payloads"),
    authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendQuery: true, queryParameters: { parameters: [
      { name: 'cursor', value: expr("{{ $('Validate Ping').first().json.replay_from_cursor ?? $json.cursor }}") }, { name: 'limit', value: '50' }] },
    options: { timeout: 20000, pagination: { pagination: { paginationMode: 'updateAParameterInEachRequest',
      parameters: { parameters: [{ type: 'qs', name: 'cursor', value: expr('{{ $response.body.cursor }}') }] },
      paginationCompleteWhen: 'other', completeExpression: expr('{{ !$response.body.mightHaveMore }}'), limitPagesFetched: true, maxRequests: 20 } } } },
  credentials: AIRTABLE }, output: [{ cursor: 2, mightHaveMore: false, payloads: [] }] });

const extract = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Extract Invoice Actions',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const T = 'tblvUPIoebC3zoacv';
const F = { number: 'fldhhnQXlbuFaveK3', roofopsId: 'fldc4T0AgU3zCmANC', action: 'fldYnINTdtOckOzK4' };
const TYPES = { 'Prepare Xero draft invoice': 'invoice.prepare_requested', 'Approve Xero draft invoice': 'invoice.approved', 'Reject invoice': 'invoice.rejected' };
const hook = $('Validate Ping').first().json.webhook_id;
let next = Number($('Load Payload Cursor').first().json.cursor);
const name = function (v) { return v && typeof v === 'object' ? v.name : v; };
const events = []; let payloads = 0;
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
      const action = name(cur[F.action]);
      if (!(F.action in prev) || !action || !TYPES[action]) continue;   // only a staff choice of an action counts (the workflow clearing it does not)
      const user = ((p.actionMetadata || {}).sourceMetadata || {}).user || {};
      const eventId = 'airtable:' + hook + ':txn' + p.baseTransactionNumber + ':' + rec;
      const payload = { project_number: cur[F.number] || null, airtable_record_id: rec };
      if (cur[F.roofopsId]) payload.project_uuid = cur[F.roofopsId];
      if (TYPES[action] === 'invoice.rejected') payload.reason = 'Rejected in Airtable by ' + (user.name || user.id || 'unknown');
      events.push({ kind: TYPES[action] === 'invoice.prepare_requested' ? 'prepare' : 'decide', project_record_id: rec,
        event: { event_id: eventId, correlation_id: eventId, event_type: TYPES[action], source: 'airtable', actor_id: user.id || null,
                 actor_name: user.name || null, occurred_at: p.timestamp, payload: payload } });
    }
  }
}
if (!events.length) return [{ json: { no_events: true, next_cursor: next, webhook_id: hook, payloads_read: payloads } }];
return events.map(function (e) { return { json: Object.assign(e, { next_cursor: next, webhook_id: hook }) }; });` } },
  output: [{ kind: 'prepare', event: {}, project_record_id: 'rec', next_cursor: 2 }] });

const anyEvents = ifElse({ version: 2.3, config: { name: 'Any Invoice Actions?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.no_events !== true }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

const byKind = switchCase({ version: 3.4, config: { name: 'Prepare Or Decide?',
  parameters: { mode: 'expression', numberOutputs: 2, output: expr("{{ $json.kind === 'prepare' ? 0 : 1 }}") } } });

const prepare = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Prepare Invoice Preview In Postgres',
  parameters: { operation: 'executeQuery', query: 'select wf_invoice_prepare($1::jsonb, $2) as r, $3::text as project_record_id, $4::text as event_id',
    options: { queryReplacement: expr("{{ [ JSON.stringify($json.event), 'n8n:' + $execution.id, $json.project_record_id, $json.event.event_id ] }}") } },
  credentials: PG }, output: [{ r: { outcome: 'PREVIEW_READY' } }] });

const decide = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Decide Approval In Postgres',
  parameters: { operation: 'executeQuery', query: 'select wf_invoice_decide($1::jsonb, $2) as r, $3::text as project_record_id, $4::text as event_id',
    options: { queryReplacement: expr("{{ [ JSON.stringify($json.event), 'n8n:' + $execution.id, $json.project_record_id, $json.event.event_id ] }}") } },
  credentials: PG }, output: [{ r: { outcome: 'APPROVED' } }] });

const advance = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Advance Payload Cursor', executeOnce: true,
  parameters: { operation: 'executeQuery', query: 'select wf_airtable_cursor_advance($1, $2::bigint)::text as cursor',
    options: { queryReplacement: expr("{{ [ $('Extract Invoice Actions').first().json.webhook_id, String($('Extract Invoice Actions').first().json.next_cursor) ] }}") } },
  credentials: PG }, output: [{ cursor: '2' }] });

const normalise = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Normalise Invoice Outcome',
  parameters: { mode: 'runOnceForEachItem', jsCode: `
const r = $json.r || {};
const pending = (r.pending_side_effects || []).filter(function (p) { return p.topic === 'xero.create_draft_invoice'; });
const needs = r.outcome === 'APPROVED' || (r.outcome === 'ALREADY_PROCESSED' && pending.length > 0);
return { json: { outcome: r.outcome, r: r, needs_xero: needs, event_id: $json.event_id, project_record_id: $json.project_record_id,
  project_number: r.project_number, xero_key: r.xero_key || (pending[0] || {}).key || null } };` } },
  output: [{ outcome: 'APPROVED', needs_xero: true }] });

const needsXero = switchCase({ version: 3.4, config: { name: 'Create In Xero Now?',
  parameters: { mode: 'expression', numberOutputs: 2, output: expr('{{ $json.needs_xero ? 0 : 1 }}') } } });

const runXero = node({ type: 'n8n-nodes-base.executeWorkflow', version: 1.3, config: { name: 'Run Xero Draft Invoice',
  parameters: { mode: 'each', source: 'database', workflowId: { __rl: true, mode: 'id', value: XERO_WF }, options: { waitForSubWorkflow: true } } },
  output: [{ xero: { status: 'DONE' } }] });

const compose = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Compose Airtable Invoice Fields',
  parameters: { mode: 'runOnceForEachItem', jsCode: `
const j = $json; const r = j.r || {}; const p = r.preview || {}; const x = j.xero || {};
const aud = function (v) { const s = Number(v || 0).toFixed(2).split('.'); return '$' + s[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '.' + s[1]; };
const lines = function () {
  return [
    'Project: ' + p.project_number + '   Customer: ' + p.customer_name + ' (' + p.customer_number + ')',
    'Amount: ' + aud(p.amount_inc_gst) + ' inc GST  (GST ' + aud(p.gst_amount) + ', ex GST ' + aud(p.amount_ex_gst) + ')',
    'Basis: quote ' + p.quote_number + ' v' + p.quote_version + ' ' + aud(p.quote_total_inc_gst) + (Number(p.approved_variations_inc_gst) ? ' + variations ' + aud(p.approved_variations_inc_gst) : '')
      + ' - already invoiced ' + aud(p.billed_to_date_inc_gst) + ' (' + (p.billed_invoices || []).map(function (b) { return b.invoice + ' ' + b.status; }).join(', ') + ')',
    'Xero: DRAFT sales invoice, reference ' + p.reference + ', contact ' + p.xero_contact_name + ' (' + p.xero_contact_number + '), account ' + p.xero_account_code + ' / ' + p.xero_tax_type,
    'Xero organisation: ' + (p.xero_tenant_name || '(not pinned)') + '  (Demo Company only; draft only, never sent or paid)',
  ].join('\\n');
};
let status; let text; const f = { fldYnINTdtOckOzK4: null };
// A duplicate for a project whose draft already exists keeps reporting the real (verified) invoice state.
const xs = r.xero_state || {};
const synced = function (why) {
  status = 'Xero draft created';
  text = 'XERO DRAFT ' + xs.xero_invoice_number + ' (InvoiceID ' + xs.xero_invoice_id + ') in ' + xs.xero_tenant_name + '\\nDuplicate ignored: ' + why
    + '. Nothing was created twice.\\n' + lines();
  f.fld3sDI9LIX8Voo4u = xs.xero_invoice_id; f.fldgkN0Vm6k1MZLJp = xs.xero_invoice_number; f.fld5JDnWI3RFehQxA = Number(xs.total_inc_gst);
};
const isSynced = xs.sync_status === 'SYNCED' && !!xs.xero_invoice_id;
switch (j.outcome) {
  case 'PREVIEW_READY': case 'ALREADY_PENDING':
    status = 'Awaiting approval';
    text = 'PREVIEW ' + r.approval_number + ' - awaiting approval by a finance approver\\n' + lines() + '\\nTo create it, set Invoice Action = Approve Xero draft invoice.';
    f.fld5JDnWI3RFehQxA = Number(p.amount_inc_gst); break;
  case 'APPROVED': case 'ALREADY_PROCESSED':
    if (j.needs_xero && x.status === 'DONE') {
      status = 'Xero draft created';
      text = 'XERO DRAFT ' + x.invoice_number + ' (InvoiceID ' + x.invoice_id + ') in ' + x.tenant_name + '\\nApproved by ' + (r.decided_by || 'finance') + ' under ' + r.approval_number
        + (x.adopted_existing_draft ? '\\nReconciled: the draft already existed in Xero from an earlier attempt; nothing was created twice.' : '') + '\\n' + lines();
      f.fld3sDI9LIX8Voo4u = x.invoice_id; f.fldgkN0Vm6k1MZLJp = x.invoice_number; f.fld5JDnWI3RFehQxA = Number(x.total);
    } else if (j.needs_xero) {
      status = x.status === 'FAILED' ? 'Failed' : 'Approved - creating in Xero';
      text = r.invoice_number + ' approved; Xero draft ' + x.status + (x.exception_number ? ' (exception ' + x.exception_number + ')' : '') + (x.message ? ': ' + x.message : '') + '. It will not be created twice.';
    } else if (isSynced) {
      synced(r.approval_number + ' was already ' + (r.first_outcome || 'processed') + ' (' + (r.delivery_count || 2) + ' deliveries)');
    } else {
      status = 'Duplicate ignored';
      text = 'Already decided: ' + r.approval_number + ' was ' + (r.first_outcome || 'processed') + (r.invoice_number ? ' as ' + r.invoice_number + ' (Xero RO-' + r.invoice_number + ')' : '')
        + '. Nothing was created twice.';
    }
    break;
  case 'ALREADY_INVOICED':
    if (isSynced) { synced(r.message || 'already invoiced'); break; }
    status = 'Duplicate ignored'; text = (r.message || 'Already invoiced') + '. No second invoice.'; break;
  case 'REJECTED_BY_APPROVER':
    status = 'Rejected by approver'; text = r.approval_number + ' rejected by ' + r.decided_by + '. Nothing was sent to Xero.'; break;
  case 'PERMISSION_DENIED':
    status = 'Not authorised'; text = r.message + '. Exception ' + r.exception_number + '. Nothing was sent to Xero.'; break;
  default:
    status = 'Not eligible'; text = (r.message || (r.issues || []).join('; ')) + (r.exception_number ? '. Exception ' + r.exception_number : '') + '. Nothing was sent to Xero.';
}
f.fldPuGgo27oWLKB5R = status;
f.fldt9KIOPXh3c3pGU = text + '\\n[event ' + j.event_id + ']';
return { json: Object.assign({}, j, { airtable_fields: f, invoice_status: status }) };` } },
  output: [{ airtable_fields: {}, invoice_status: 'Awaiting approval' }] });

const writeFields = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Write Project Invoice Fields',
  retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  parameters: { method: 'PATCH', url: expr(PROJECTS + '/{{ $json.project_record_id }}'), authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: expr('{{ JSON.stringify({ returnFieldsByFieldId: true, typecast: false, fields: $json.airtable_fields }) }}'),
    options: { timeout: 20000 } }, credentials: AIRTABLE }, output: [{ id: 'rec', fields: {} }] });

const readFields = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Back Project Invoice Fields',
  retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  parameters: { method: 'GET', url: expr(PROJECTS + "/{{ $('Compose Airtable Invoice Fields').item.json.project_record_id }}"), authentication: 'predefinedCredentialType',
    nodeCredentialType: 'airtableTokenApi', sendQuery: true, queryParameters: { parameters: [{ name: 'returnFieldsByFieldId', value: 'true' }] }, options: { timeout: 20000 } },
  credentials: AIRTABLE }, output: [{ id: 'rec', fields: {} }] });

const verify = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Verify Airtable Invoice Fields',
  parameters: { mode: 'runOnceForEachItem', jsCode: `
const want = $('Compose Airtable Invoice Fields').item.json;
const f = $json.fields || {};
const nm = function (v) { return v && typeof v === 'object' ? v.name : v; };
const problems = [];
for (const k of Object.keys(want.airtable_fields)) {
  const w = want.airtable_fields[k]; const g = nm(f[k]);
  if (w === null ? (g !== undefined && g !== null && g !== '') : (typeof w === 'number' ? Math.round(Number(g) * 100) !== Math.round(w * 100) : g !== w)) problems.push(k + '=' + JSON.stringify(g).slice(0, 60));
}
if (problems.length) throw new Error('Airtable project ' + want.project_record_id + ' read back differs: ' + problems.join('; '));
return { json: { verified: true, outcome: want.outcome, project: want.project_number, invoice_status: want.invoice_status, xero: want.xero || null, event_id: want.event_id } };` } },
  output: [{ verified: true }] });

export default workflow('roofops-approved-project-to-xero-draft', '[RoofOps] 04 Approved Project → Xero Draft Invoice')
  .add(ping).to(validatePing).to(loadCursor).to(listPayloads).to(extract).to(anyEvents
    .onTrue(byKind.onCase(0, prepare).onCase(1, decide))
    .onFalse(advance))
  .add(prepare).to(advance)
  .add(decide).to(advance)
  .add(prepare).to(normalise)
  .add(decide).to(normalise)
  .add(normalise).to(needsXero.onCase(0, runXero.to(compose)).onCase(1, compose))
  .add(compose).to(writeFields).to(readFields).to(verify);
