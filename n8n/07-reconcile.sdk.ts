import { workflow, node, trigger, ifElse, switchCase, expr } from '@n8n/workflow-sdk';

const AIRTABLE = { airtableTokenApi: { id: '3XbFnHjAd7mFvBD2', name: 'Roofops Airtable Personal Access Token account' } };
const PG = { postgres: { id: 'kWqjtv0gz7ref2EN', name: 'RoofOps Postgres' } };
const DRIVE = { googleDriveOAuth2Api: { id: 'o7IjcWsTr1ZUy9wU', name: 'RoofOps Google Drive' } };
const XERO = { xeroOAuth2Api: { id: 'rjqe50LhcU1IRLBc', name: 'RoofOps Xero' } };
const RAW = { response: { response: { fullResponse: true, neverError: true } }, timeout: 20000 };
const BASE_ID = 'appMc8V0Wm29tEeHQ';
const API = 'https://api.airtable.com/v0/' + BASE_ID + '/';
const HOOKS = 'https://api.airtable.com/v0/bases/' + BASE_ID + '/webhooks';

// Reconciliation: catches anything the webhooks missed (n8n down, ping lost, webhook expired) and anything edited
// outside the supported paths. Every decision is made in Postgres (wf_reconcile_*), by field ownership:
// missed staff edits are replayed through the SAME validation as the webhook path; RoofOps-owned drift is repaired
// in Airtable and read back; missing / unknown / ambiguous objects become actionable exceptions. Never a silent winner.
// Airtable Free plan budget: about 8 API calls per run (6 table reads + webhook list + corrections).
const daily = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1.3, config: { name: 'Daily 02:30',
  parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 2, triggerAtMinute: 30 }] } } }, output: [{}] });
const hook = trigger({ type: 'n8n-nodes-base.webhook', version: 2.1, config: { name: 'Operator Trigger (npm run reconcile)',
  parameters: { httpMethod: 'POST', path: 'roofops/reconcile', responseMode: 'onReceived', options: { noResponseBody: true } } },
  output: [{ headers: { 'x-roofops-token': 'x' }, body: { mode: 'observe' } }] });

const request = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Read Request',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const j = $input.first().json;
if (!j.headers) return [{ json: { trigger: 'schedule', mode: 'repair', token: null, scope: null } }];
const mode = (j.body || {}).mode === 'observe' ? 'observe' : 'repair';
// The token is checked in Postgres against a SHA-256 hash; it is never stored or echoed. A scope (e.g. demo:reset's one
// project invoice projection) is validated in Postgres too.
return [{ json: { trigger: 'manual', mode: mode, token: String(j.headers['x-roofops-token'] || ''), scope: (j.body || {}).scope || null } }];` } },
  output: [{ trigger: 'schedule', mode: 'repair', token: null, scope: null }] });

const start = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Start Reconciliation Run',
  parameters: { operation: 'executeQuery', query: 'select wf_reconcile_start($1, $2, nullif($3, \'\'), $4::jsonb) as r',
    options: { queryReplacement: expr("{{ [ $json.trigger, $json.mode, $json.token || '', JSON.stringify($json.scope || null) ] }}") } }, credentials: PG },
  output: [{ r: { started: true, run_key: 'RECON-x', mode: 'repair', tables: [] } }] });

const started = ifElse({ version: 2.3, config: { name: 'Run Started?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.r.started }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

const tables = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Tables To Check',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const r = $input.first().json.r;
return r.tables.map(function (t) { return { json: { table_id: t, run_key: r.run_key } }; });` } },
  output: [{ table_id: 'tblvUPIoebC3zoacv', run_key: 'RECON-x' }] });

const listRecords = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Airtable Table',
  retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  parameters: { method: 'GET', url: expr(API + '{{ $json.table_id }}'), authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendQuery: true, queryParameters: { parameters: [{ name: 'pageSize', value: '100' }, { name: 'returnFieldsByFieldId', value: 'true' }] },
    options: { timeout: 20000, pagination: { pagination: { paginationMode: 'updateAParameterInEachRequest',
      parameters: { parameters: [{ type: 'qs', name: 'offset', value: expr('{{ $response.body.offset }}') }] },
      paginationCompleteWhen: 'other', completeExpression: expr('{{ !$response.body.offset }}'), limitPagesFetched: true, maxRequests: 10 } } } },
  credentials: AIRTABLE }, output: [{ records: [] }] });

const tagPage = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Tag Page With Table',
  parameters: { mode: 'runOnceForEachItem', jsCode: `
return { json: { table_id: $('Tables To Check').item.json.table_id, records: ($json.records || []).map(function (r) { return { id: r.id, fields: r.fields || {} }; }) } };` } },
  output: [{ table_id: 'tbl', records: [] }] });

const group = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Group Records By Table',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const by = {};
for (const it of $input.all()) by[it.json.table_id] = (by[it.json.table_id] || []).concat(it.json.records);
const expected = $('Tables To Check').all().map(function (i) { return i.json.table_id; });
// A table that could not be read is a failure, not "every record deleted".
for (const t of expected) if (!by[t]) throw new Error('Airtable table ' + t + ' was not read; stopping before any comparison');
return expected.map(function (t) { return { json: { table_id: t, records: by[t] } }; });` } },
  output: [{ table_id: 'tbl', records: [] }] });

const reconcileTable = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Reconcile Table In Postgres',
  parameters: { operation: 'executeQuery', query: 'select wf_reconcile_airtable($1, $2, $3::jsonb) as r',
    options: { queryReplacement: expr("{{ [ $('Start Reconciliation Run').first().json.r.run_key, $json.table_id, JSON.stringify($json.records) ] }}") } },
  credentials: PG }, output: [{ r: { ok: true, table_id: 'tbl', records: 0, drift: 0, corrections: [] } }] });

const batches = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Plan Correction Batches',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const stats = []; const out = [];
for (const it of $input.all()) {
  const r = it.json.r || {};
  if (!r.ok) throw new Error('reconciliation refused table ' + r.table_id + ': ' + JSON.stringify(r).slice(0, 200));
  stats.push({ table_id: r.table_id, records: r.records, fields_checked: r.fields_checked, drift: r.drift });
  const c = r.corrections || [];
  for (let i = 0; i < c.length; i += 10) out.push({ table_id: r.table_id, records: c.slice(i, i + 10) });   // Airtable: 10 records per PATCH
}
if (out.length === 0) return [{ json: { none: true, stats: stats } }];
return out.map(function (b) { return { json: Object.assign(b, { stats: stats }) }; });` } },
  output: [{ none: true, stats: [] }] });

const anyCorrections = ifElse({ version: 2.3, config: { name: 'Airtable Needs Repair?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.none !== true }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

const patch = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Write Repairs To Airtable',
  retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  parameters: { method: 'PATCH', url: expr(API + '{{ $json.table_id }}'), authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: expr('{{ JSON.stringify({ returnFieldsByFieldId: true, records: $json.records }) }}'), options: { timeout: 20000 } },
  credentials: AIRTABLE }, output: [{ records: [] }] });

// The PATCH response is Airtable's stored state after the write (read-back without spending another API call).
const proof = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Record Repair Read-Back',
  parameters: { operation: 'executeQuery',
    query: "select jsonb_agg(wf_airtable_writeback_verified($1, $2, x ->> 'id', x -> 'fields')) as v from jsonb_array_elements($3::jsonb) x",
    options: { queryReplacement: expr("{{ (() => { const b = $('Plan Correction Batches').item.json; const got = {}; ($json.records || []).forEach(r => { got[r.id] = r.fields || {}; }); " +
      "const rb = b.records.map(s => { const f = {}; Object.keys(s.fields).forEach(k => { f[k] = got[s.id] && got[s.id][k] !== undefined ? got[s.id][k] : null; }); return { id: s.id, fields: f }; }); " +
      "return [ 'reconcile:' + $('Start Reconciliation Run').first().json.r.run_key, b.table_id, JSON.stringify(rb) ]; })() }}") } },
  credentials: PG }, output: [{ v: [{ verified: true }] }] });

const checkProof = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Verify Repairs',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const bad = [];
for (const it of $input.all()) for (const v of (it.json.v || [])) if (!v.verified) bad.push(v.mismatched_fields);
if (bad.length) throw new Error('Airtable repairs did not read back as canonical: ' + JSON.stringify(bad).slice(0, 300));
return [{ json: { repaired_batches: $input.all().length } }];` } }, output: [{ repaired_batches: 1 }] });

const targets = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'External Objects To Check', executeOnce: true,
  parameters: { operation: 'executeQuery', query: 'select wf_reconcile_targets($1) as t',
    options: { queryReplacement: expr("{{ [ $('Start Reconciliation Run').first().json.r.run_key ] }}") } }, credentials: PG },
  output: [{ t: { drive: [], xero: [] } }] });

const findRoot = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Find Drive Root', executeOnce: true,
  parameters: { method: 'GET', url: 'https://www.googleapis.com/drive/v3/files', authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendQuery: true, queryParameters: { parameters: [
      { name: 'q', value: "appProperties has { key='roofops_role' and value='root' } and mimeType='application/vnd.google-apps.folder' and trashed=false" },
      { name: 'fields', value: 'files(id)' }] }, options: RAW }, credentials: DRIVE }, output: [{ statusCode: 200, body: { files: [{ id: 'root' }] } }] });

const driveItems = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Drive Folders To Read',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const r = $input.first().json;
const roots = (r.body && r.body.files) || [];
if (r.statusCode !== 200 || roots.length !== 1) throw new Error('Drive root not found exactly once (HTTP ' + r.statusCode + ', ' + roots.length + ' roots); not comparing folders');
const d = $('External Objects To Check').first().json.t.drive || [];
if (d.length === 0) return [{ json: { folder_id: '__none__' } }];
return d.map(function (x) { return { json: Object.assign({}, x, { expected_parent: roots[0].id }) }; });` } },
  output: [{ folder_id: 'f', project_number: 'PRJ', expected_parent: 'root' }] });

const readFolder = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Drive Folder',
  parameters: { method: 'GET', url: expr('https://www.googleapis.com/drive/v3/files/{{ $json.folder_id }}'), authentication: 'predefinedCredentialType',
    nodeCredentialType: 'googleDriveOAuth2Api', sendQuery: true, queryParameters: { parameters: [{ name: 'fields', value: 'id,trashed,parents' }] }, options: RAW },
  credentials: DRIVE }, output: [{ statusCode: 200, body: { id: 'f', trashed: false, parents: ['root'] } }] });

const recordDrive = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Record Drive Findings', executeOnce: true,
  parameters: { operation: 'executeQuery', query: "select wf_reconcile_external($1, 'DRIVE', $2::jsonb) as r",
    options: { queryReplacement: expr("{{ [ $('Start Reconciliation Run').first().json.r.run_key, JSON.stringify($('Drive Folders To Read').all().map((it, i) => { " +
      "const res = $('Read Drive Folder').all()[i].json; const b = res.body || {}; return Object.assign({}, it.json, { http: res.statusCode, trashed: b.trashed === true, parents: b.parents || [] }); })" +
      ".filter(x => x.folder_id !== '__none__')) ] }}") } },
  credentials: PG }, output: [{ r: { ok: true, verified: 0, drift: 0 } }] });

const xeroItems = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Xero Invoices To Read',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const x = $('External Objects To Check').first().json.t.xero || [];
if (x.length === 0) return [{ json: { invoice_id: '__none__' } }];
// Read-only GETs against the PINNED Demo tenant only (tenant id comes from Postgres, never from input).
return x.map(function (i) { return { json: i }; });` } },
  output: [{ invoice_id: 'x', tenant_id: 't' }] });

const hasXero = ifElse({ version: 2.3, config: { name: 'Any Xero Invoices?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr("{{ $json.invoice_id !== '__none__' && !!$json.tenant_id }}"), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

const readInvoice = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Xero Invoice',
  parameters: { method: 'GET', url: expr('https://api.xero.com/api.xro/2.0/Invoices/{{ $json.invoice_id }}'), authentication: 'predefinedCredentialType',
    nodeCredentialType: 'xeroOAuth2Api', sendHeaders: true,
    headerParameters: { parameters: [{ name: 'xero-tenant-id', value: expr('{{ $json.tenant_id }}') }, { name: 'Accept', value: 'application/json' }] }, options: RAW },
  credentials: XERO }, output: [{ statusCode: 200, body: { Invoices: [{ Status: 'DRAFT', Total: 1, Reference: 'PRJ' }] } }] });

const recordXero = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Record Xero Findings', executeOnce: true,
  parameters: { operation: 'executeQuery', query: "select wf_reconcile_external($1, 'XERO', $2::jsonb) as r",
    options: { queryReplacement: expr("{{ [ $('Start Reconciliation Run').first().json.r.run_key, JSON.stringify(!$('Read Xero Invoice').isExecuted ? [] : $('Xero Invoices To Read').all().map((it, i) => { " +
      "const res = $('Read Xero Invoice').all()[i].json; const inv = ((res.body || {}).Invoices || [])[0] || {}; " +
      "return { invoice_number: it.json.invoice_number, project_number: it.json.project_number, invoice_id: it.json.invoice_id, xero_invoice_number: it.json.xero_invoice_number, " +
      "http: res.statusCode, status: inv.Status || null, total: inv.Total, expected_total: it.json.total, reference: inv.Reference || null, expected_reference: it.json.reference }; })) ] }}") } },
  credentials: PG }, output: [{ r: { ok: true, verified: 0, drift: 0 } }] });

const listHooks = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'List Airtable Webhooks', executeOnce: true,
  parameters: { method: 'GET', url: HOOKS, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi', options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { webhooks: [] } }] });

const checkHooks = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Check Webhooks In Postgres',
  parameters: { operation: 'executeQuery', query: 'select wf_webhook_check($1::jsonb) as w',
    options: { queryReplacement: expr("{{ [ JSON.stringify($json.statusCode === 200 ? ($json.body.webhooks || []) : []) ] }}") } }, credentials: PG },
  output: [{ w: { ok: true, hooks: [], drain: [], refresh: [], missing: [] } }] });

const finish = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Finish Run And Record Health',
  parameters: { operation: 'executeQuery', query: 'select wf_record_health($1::jsonb) as h, wf_reconcile_finish($2, $3::jsonb, $4::jsonb) as r',
    options: { queryReplacement: expr("{{ (() => { const stats = $('Plan Correction Batches').first().json.stats; const w = $json.w; " +
      "const health = [{ service: 'airtable', ok: $('List Airtable Webhooks').first().json.statusCode === 200, detail: { check: 'reconciliation read ' + stats.reduce((a, s) => a + s.records, 0) + ' records' } }, " +
      "{ service: 'n8n', ok: true, detail: { check: '[RoofOps] 07 completed' } }]; " +
      "return [ JSON.stringify(health), $('Start Reconciliation Run').first().json.r.run_key, JSON.stringify({ tables: stats }), JSON.stringify(w.hooks) ]; })() }}") } },
  credentials: PG }, output: [{ r: { ok: true } }] });

const actions = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Plan Webhook Maintenance',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const w = $('Check Webhooks In Postgres').first().json.w;
const CHANGES = 'https://tejesh08.app.n8n.cloud/webhook/roofops/airtable/changes';
const out = [];
if ((w.missing || []).includes(CHANGES)) out.push({ kind: 'create' });
for (const id of (w.refresh || [])) out.push({ kind: 'refresh', id: id });
// A consumer with unread payloads missed a ping (n8n down, ping lost): wake it; it resumes from its durable cursor.
for (const d of (w.drain || [])) out.push({ kind: 'drain', id: d.id, url: d.url });
if (out.length === 0) out.push({ kind: 'none' });
return out.map(function (o) { return { json: o }; });` } }, output: [{ kind: 'none' }] });

const route = switchCase({ version: 3.4, config: { name: 'Maintenance Action',
  parameters: { mode: 'expression', numberOutputs: 4, output: expr("{{ ({ create: 0, refresh: 1, drain: 2 })[$json.kind] ?? 3 }}") } } });

// Base-wide, all cell values, previous values: one webhook for every RoofOps table (the other two stay as they are).
const createHook = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Create Change Webhook',
  parameters: { method: 'POST', url: HOOKS, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: JSON.stringify({ notificationUrl: 'https://tejesh08.app.n8n.cloud/webhook/roofops/airtable/changes', specification: { options: {
      filters: { dataTypes: ['tableData'], changeTypes: ['update'] }, includes: { includeCellValuesInFieldIds: 'all', includePreviousCellValues: true } } } }),
    options: RAW }, credentials: AIRTABLE }, output: [{ statusCode: 200, body: { id: 'ach' } }] });

const refreshHook = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Refresh Webhook',
  parameters: { method: 'POST', url: expr(HOOKS + '/{{ $json.id }}/refresh'), authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi', options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200 }] });

const drain = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Wake Consumer With Unread Payloads',
  parameters: { method: 'POST', url: expr('{{ $json.url }}'), sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: expr("{{ JSON.stringify({ base: { id: '" + BASE_ID + "' }, webhook: { id: $json.id }, timestamp: $now.toISO() }) }}"), options: RAW } },
  output: [{ statusCode: 200 }] });

const checkAction = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Check Maintenance Result',
  parameters: { mode: 'runOnceForEachItem', jsCode: `
// Only status codes leave this node: the create response contains the webhook MAC secret, which is never passed on.
if ($json.statusCode !== 200) throw new Error('webhook maintenance failed: HTTP ' + $json.statusCode);
return { json: { ok: true, status: $json.statusCode } };` } }, output: [{ ok: true }] });

export default workflow('roofops-reconcile', '[RoofOps] 07 Reconcile & Webhook Supervision')
  .add(daily).to(request)
  .add(hook).to(request)
  .add(request).to(start).to(started.onTrue(tables))
  .add(tables).to(listRecords).to(tagPage).to(group).to(reconcileTable).to(batches).to(anyCorrections
    .onTrue(patch.to(proof).to(checkProof).to(targets))
    .onFalse(targets))
  .add(targets).to(findRoot).to(driveItems).to(readFolder).to(recordDrive).to(xeroItems).to(hasXero
    .onTrue(readInvoice.to(recordXero))
    .onFalse(recordXero))
  .add(recordXero).to(listHooks).to(checkHooks).to(finish).to(actions).to(route
    .onCase(0, createHook.to(checkAction))
    .onCase(1, refreshHook.to(checkAction))
    .onCase(2, drain.to(checkAction)));
