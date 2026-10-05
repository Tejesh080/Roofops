import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';

const AIRTABLE = { airtableTokenApi: { id: '3XbFnHjAd7mFvBD2', name: 'Roofops Airtable Personal Access Token account' } };
const PG = { postgres: { id: 'kWqjtv0gz7ref2EN', name: 'RoofOps Postgres' } };
const BASE_ID = 'appMc8V0Wm29tEeHQ';
const API = 'https://api.airtable.com/v0/' + BASE_ID + '/';

// One base-wide webhook (created and kept alive by [RoofOps] 07). Every staff edit in Airtable, in any RoofOps table,
// is captured here and sent to ONE validated entry point, wf_airtable_change, which decides by field ownership:
// apply (with state-machine validation), refuse, revert, defer to 01, or ignore as stale/duplicate/echo.
const ping = trigger({ type: 'n8n-nodes-base.webhook', version: 2.1, config: { name: 'Airtable Change Ping',
  parameters: { httpMethod: 'POST', path: 'roofops/airtable/changes', responseMode: 'onReceived', options: { noResponseBody: true } } },
  output: [{ body: { base: { id: BASE_ID }, webhook: { id: 'achXXXXXXXXXXXXXX' }, timestamp: '2026-09-29T00:00:00.000Z' } }] });

const validatePing = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Validate Ping',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
// Pings carry no record data; everything acted on is fetched from Airtable with our own credential.
const b = $input.first().json.body || {};
const hook = b.webhook && b.webhook.id;
if (!b.base || b.base.id !== 'appMc8V0Wm29tEeHQ' || !/^ach[A-Za-z0-9]{14}$/.test(hook || '')) return [];
return [{ json: { webhook_id: hook } }];` } },
  output: [{ webhook_id: 'achXXXXXXXXXXXXXX' }] });

const loadCursor = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Load Payload Cursor',
  parameters: { operation: 'executeQuery', query: 'select wf_airtable_cursor($1)::text as cursor',
    options: { queryReplacement: expr('{{ [ $json.webhook_id ] }}') } }, credentials: PG },
  output: [{ cursor: '1' }] });

const listPayloads = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'List Airtable Payloads',
  retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  parameters: { method: 'GET', url: expr("https://api.airtable.com/v0/bases/" + BASE_ID + "/webhooks/{{ $('Validate Ping').first().json.webhook_id }}/payloads"),
    authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendQuery: true, queryParameters: { parameters: [{ name: 'cursor', value: expr('{{ $json.cursor }}') }, { name: 'limit', value: '50' }] },
    options: { timeout: 20000, pagination: { pagination: { paginationMode: 'updateAParameterInEachRequest',
      parameters: { parameters: [{ type: 'qs', name: 'cursor', value: expr('{{ $response.body.cursor }}') }] },
      paginationCompleteWhen: 'other', completeExpression: expr('{{ !$response.body.mightHaveMore }}'), limitPagesFetched: true, maxRequests: 20 } } } },
  credentials: AIRTABLE }, output: [{ cursor: 2, mightHaveMore: false, payloads: [] }] });

const extract = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Extract Record Changes',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
// Fields RoofOps checks (source: field_contract, reconcile <> IGNORE). Changes touching only other fields
// (Automation Status, Invoice Status, RoofOps Sync, inverse links: all written by RoofOps itself) are skipped here.
const WATCHED = new Set(['fldhhnQXlbuFaveK3','fld08eKCeuDCsJLjz','fldG4mPoV6sUkA9rM','fldi2Qwz1dAh2tcTE','fldnZcRBxG7hTebD5','fld8rf6RZLgfs6Ron',
  'fldvZtiassZEgLMAN','fldIje5e0a72cBfVD','fldWKRobTLlOjeN9j','fldgVDT29UOOOtlqO','fldc4T0AgU3zCmANC',
  'fldyP20HNafS614d5','fld4LsEu8c9EMFj0h','fldisUv1ckHz2Detv','fldQpTa5tvrzlNg1h','fldEjEqlzE8Y0M1nf','fldbfUE8DVh1Dwjfs','fldOaXGsOgYHuWFYg',
  'fldhY6d0ikMnsc7D3','fldLjvBaV1EFB5RMG','fld5Bz9FDhJSPibPk','flduF4QFGUWbkuR2d','fldHSFkvwuVLfAS7J','fldMnoHiondm5jBWv','fldfhsHggkGd8GKVq',
  'fld1sZibwdMVnI4Hd','fldVUpqZkVKid3Fyy',
  'fld1yW7kd8vY975Tj','fldDVMu2hgtSVuJyR','fldnYTAgdcNXWUMfP','fldMtDddp1Rm4tDHf','fldqNNcA85jAC9FxM','fldqkJourPRGAcJya','fld8Muyf7XVB91CjK',
  'fldJ4Z5Rg5adnEFU0','fldnzaXx4TTTjCakj',
  'fldzmWSHtLVZ4OTmZ','fldI46VewtlNRnwui','fldNcSkEiFnb8m4XP','fldvBKPgd3UeIDYO4','fldisVgB2WysksjwW','fldfNc5n8m2kjiRcB','fldNu4bbDXjMbwmZ8',
  'fldPXNXPyYie2kKQk','fldDClu1e0ffwnojn',
  'fldIy8ab7Ky67jL31','fldu0CsGG5uPOVbRN','fldl6gKbKuZSF9MJG','fldYjfr3STs04XDZr','flduw5J4VyRoOqEE2','fldMH8wYXmkAYXCxe','fldhsHUPCZ0pMbXeV',
  'fldP4PWGxdLZrA5ge','fldVpX0MOcA8TnGvo','fldm6rtleyV6yp8ZS',
  'fldNy5hhua9oCbrge','fldmyVulHN1hsCE8f','fldPtnT9heTBGTFEM','fldtNq7DluPgIM1rn','fldfXKzmQJYzbzgZY','fldLNYP5FsVaR6TFk',
  // AC-13A: the completion gate (Completion Photos, Compliance Certificate); their Note fields travel in "current".
  'fldbbksVL3dT6cqyS','fldf7iJiyHFxOQgUy']);
const TABLES = new Set(['tblHKX79FJFHn5FDc','tbloPJwCIcdIZQFVK','tblSYcCqId9wTMg3c','tblzenPRNVV5O7lZP','tblvUPIoebC3zoacv','tbluIbl4zpMiAlMVw']);
const hook = $('Validate Ping').first().json.webhook_id;
let next = Number($('Load Payload Cursor').first().json.cursor);
const events = [];
let payloads = 0; let skipped = 0;
for (const it of $input.all()) {
  const page = it.json;
  if (page.cursor) next = Math.max(next, Number(page.cursor));
  for (const p of (page.payloads || [])) {
    payloads++;
    const user = ((p.actionMetadata || {}).sourceMetadata || {}).user || {};
    for (const tableId of Object.keys(p.changedTablesById || {})) {
      if (!TABLES.has(tableId)) continue;
      const t = p.changedTablesById[tableId];
      for (const rec of Object.keys(t.changedRecordsById || {})) {
        const ch = t.changedRecordsById[rec];
        const cur = (ch.current || {}).cellValuesByFieldId || {};
        const prev = (ch.previous || {}).cellValuesByFieldId || {};
        const keys = Array.from(new Set(Object.keys(cur).concat(Object.keys(prev))));   // a cleared cell appears only in "previous"
        if (!keys.some(function (k) { return WATCHED.has(k); })) { skipped++; continue; }
        const changes = {};
        for (const k of keys) changes[k] = { current: k in cur ? cur[k] : null, previous: k in prev ? prev[k] : null, has_previous: ch.previous !== undefined };
        const current = Object.assign({}, (ch.unchanged || {}).cellValuesByFieldId || {}, cur);
        for (const k of keys) if (!(k in cur)) current[k] = null;
        events.push({ event: { event_id: 'airtable:' + hook + ':txn' + p.baseTransactionNumber + ':' + rec, source: 'airtable',
          actor_id: user.id || (p.actionMetadata || {}).source || 'airtable', origin: (p.actionMetadata || {}).source || null,
          occurred_at: p.timestamp, table_id: tableId, record_id: rec,
          changes: changes, current: current } });
      }
    }
  }
}
const meta = { next_cursor: next, webhook_id: hook, payloads_read: payloads, echoes_skipped: skipped };
if (events.length === 0) return [{ json: Object.assign({ no_events: true }, meta) }];
return events.map(function (e) { return { json: Object.assign(e, meta) }; });` } },
  output: [{ event: { event_id: 'airtable:ach:txn1:rec', table_id: 'tbl', record_id: 'rec' }, next_cursor: 2, webhook_id: 'ach' }] });

const anyEvents = ifElse({ version: 2.3, config: { name: 'Any Record Changes?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.no_events !== true }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

// Items run one by one, in Airtable transaction order.
const apply = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Apply Change In Postgres',
  parameters: { operation: 'executeQuery', query: 'select wf_airtable_change($1::jsonb, $2) as r',
    options: { queryReplacement: expr("{{ [ JSON.stringify($json.event), 'n8n:' + $execution.id ] }}") } },
  credentials: PG }, output: [{ r: { outcome: 'APPLIED', corrections: {} } }] });

const plan = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Plan Airtable Corrections',
  parameters: { mode: 'runOnceForEachItem', jsCode: `
const r = $json.r || {};
const ev = $('Extract Record Changes').item.json.event;
const corrections = r.corrections || {};
return { json: { event_id: ev.event_id, table_id: ev.table_id, record_id: ev.record_id, outcome: r.outcome, business_key: r.business_key || null,
  duplicate: r.duplicate === true, note: r.note || null, corrections: corrections, needs_write: Object.keys(corrections).length > 0 } };` } },
  output: [{ event_id: 'e', table_id: 'tbl', record_id: 'rec', outcome: 'APPLIED', corrections: {}, needs_write: false }] });

const needsWrite = ifElse({ version: 2.3, config: { name: 'Airtable Needs Correcting?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.needs_write }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

const patch = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Write Canonical Values To Airtable',
  retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  parameters: { method: 'PATCH', url: expr(API + '{{ $json.table_id }}/{{ $json.record_id }}'), authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: expr('{{ JSON.stringify({ returnFieldsByFieldId: true, fields: $json.corrections }) }}'), options: { timeout: 20000 } },
  credentials: AIRTABLE }, output: [{ id: 'rec', fields: {} }] });

const readBack = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Back Airtable Record',
  retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  parameters: { method: 'GET', url: expr(API + "{{ $('Plan Airtable Corrections').item.json.table_id }}/{{ $('Plan Airtable Corrections').item.json.record_id }}"),
    authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendQuery: true, queryParameters: { parameters: [{ name: 'returnFieldsByFieldId', value: 'true' }] }, options: { timeout: 20000 } },
  credentials: AIRTABLE }, output: [{ id: 'rec', fields: {} }] });

const proof = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Record Read-Back Proof',
  parameters: { operation: 'executeQuery', query: 'select wf_airtable_writeback_verified($1, $2, $3, $4::jsonb) as v',
    options: { queryReplacement: expr("{{ (() => { const p = $('Plan Airtable Corrections').item.json; const f = $json.fields || {}; const rb = {}; " +
      "Object.keys(p.corrections).forEach(k => { rb[k] = f[k] === undefined ? null : f[k]; }); return [ p.event_id, p.table_id, p.record_id, JSON.stringify(rb) ]; })() }}") } },
  credentials: PG }, output: [{ v: { verified: true, mismatched_fields: [] } }] });

const verify = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Verify Airtable Shows Canonical State',
  parameters: { mode: 'runOnceForEachItem', jsCode: `
const p = $('Plan Airtable Corrections').item.json;
const v = $json.v || {};
if (!v.verified) throw new Error('Airtable ' + p.record_id + ' (' + p.business_key + ') still differs from RoofOps after write-back: ' + JSON.stringify(v.mismatched_fields));
return { json: { verified: true, event_id: p.event_id, business_key: p.business_key, outcome: p.outcome, corrected_fields: Object.keys(p.corrections) } };` } },
  output: [{ verified: true }] });

// Runs after the correction branch (which stops the execution if any write-back fails, so the cursor is not advanced
// and the same payloads are redelivered; unverified corrections are then re-issued) and after the no-write branch.
const advance = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Advance Payload Cursor', executeOnce: true,
  parameters: { operation: 'executeQuery', query: 'select wf_airtable_cursor_advance($1, $2::bigint)::text as cursor',
    options: { queryReplacement: expr("{{ [ $('Extract Record Changes').first().json.webhook_id, String($('Extract Record Changes').first().json.next_cursor) ] }}") } },
  credentials: PG }, output: [{ cursor: '2' }] });

export default workflow('roofops-airtable-changes', '[RoofOps] 06 Airtable Changes → Postgres')
  .add(ping).to(validatePing).to(loadCursor).to(listPayloads).to(extract).to(anyEvents
    .onTrue(apply)
    .onFalse(advance))
  .add(apply).to(plan).to(needsWrite
    .onTrue(patch.to(readBack).to(proof).to(verify).to(advance))
    .onFalse(advance));
