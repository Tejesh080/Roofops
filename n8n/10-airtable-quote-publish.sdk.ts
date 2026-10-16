import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';

// [RoofOps] 10 Airtable Quote Publish (SALES-01). UNPUBLISHED: written for review; nothing here runs until the owner
// creates and activates it. A quote drafted and sent in the RoofOps dashboard (web_quote_send) queues ONE outbox write,
// airtable.quote_publish, carrying the customer, property and quote rows by their RoofOps numbers. Every minute this asks
// Postgres for the next due write (wf_quote_publish_next), claims it (wf_claim_side_effect), upserts the three Airtable
// records MERGED ON THEIR RoofOps ID field (a retry finds the same records, never a second one), links property -> customer
// and quote -> customer + property, reads the quote back and records the proof (wf_complete_side_effect checks numbers and
// links). A failure is recorded with its class (wf_fail_side_effect: bounded retry, then an exception). After this the quote
// is an ordinary Airtable quote: reconciliation keeps its fields canonical and Status -> Accepted runs n8n 01 unchanged.

const AIRTABLE = { airtableTokenApi: { id: '3XbFnHjAd7mFvBD2', name: 'Roofops Airtable Personal Access Token account' } };
const PG = { postgres: { id: 'kWqjtv0gz7ref2EN', name: 'RoofOps Postgres' } };
const RAW = { response: { response: { fullResponse: true, neverError: true } }, timeout: 20000 };
const BASE = 'https://api.airtable.com/v0/appMc8V0Wm29tEeHQ';
const T = { customers: BASE + '/tblHKX79FJFHn5FDc', properties: BASE + '/tblSYcCqId9wTMg3c', quotes: BASE + '/tblzenPRNVV5O7lZP' };
const ID = { customer: 'fldDClu1e0ffwnojn', property: 'fldm6rtleyV6yp8ZS', quote: 'fldVUpqZkVKid3Fyy' };
const LINK = { propertyOwner: 'fldVpX0MOcA8TnGvo', quoteCustomer: 'fld4LsEu8c9EMFj0h', quoteProperty: 'fldisUv1ckHz2Detv' };
const NUM = { customer: 'fldzmWSHtLVZ4OTmZ', property: 'fldIy8ab7Ky67jL31', quote: 'fldyP20HNafS614d5' };

const FAIL_JS = `
function fail(step, r) {
  const s = r.statusCode; const body = r.body || {}; const e = body.error || r.error || {};
  const msg = (typeof e === 'string' ? e : (e.message || e.type)) || r.message || ('HTTP ' + s);
  let cls = 'UNKNOWN'; let retryAfter = null;
  if (!s) cls = /time ?out|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED/i.test(String(msg)) ? 'TIMEOUT' : 'NETWORK';
  else if (s === 429) { cls = 'RATE_LIMITED'; retryAfter = parseInt((r.headers || {})['retry-after'], 10) || 30; }
  else if (s === 401) cls = 'AUTH_FAILURE'; else if (s === 403) cls = 'PERMISSION_DENIED'; else if (s === 404) cls = 'NOT_FOUND';
  else if (s === 400 || s === 422) cls = 'VALIDATION_ERROR'; else if (s === 503) cls = 'SERVICE_UNAVAILABLE'; else if (s >= 500) cls = 'UPSTREAM_5XX';
  return { ok: false, failure: { step: step, error_class: cls, http_status: s || null, retry_after_seconds: retryAfter, message: step + ': ' + String(msg).slice(0, 400) } };
}
function refuse(step, cls, message) { return { ok: false, failure: { step: step, error_class: cls, http_status: null, retry_after_seconds: null, message: step + ': ' + message } }; }
function one(step, r) {
  if (r.statusCode !== 200) return fail(step, r);
  const recs = (r.body || {}).records || [];
  if (recs.length !== 1) return refuse(step, 'RECONCILIATION_MISMATCH', 'upsert returned ' + recs.length + ' records');
  return { ok: true, id: recs[0].id };
}
const job = $('Claim Quote Publish').last().json.c.payload || {};
`;
const OK_IF = { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.ok }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } };
const everyMinute = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1.3, config: { name: 'Every Minute', disabled: true,   // off until the owner activates it
  parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } } }, output: [{}] });

const next = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Next Quote To Publish',
  parameters: { operation: 'executeQuery', query: 'select wf_quote_publish_next($1) as d', options: { queryReplacement: expr("{{ [ 'n8n:10:' + $execution.id ] }}") } },
  credentials: PG }, output: [{ d: { writes: [] } }] });

const pick = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Write To Publish',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const w = (($input.first().json.d || {}).writes || []).slice(0, 1);   // one per run
return w.length ? [{ json: { key: w[0].key, quote_number: w[0].quote_number } }] : [{ json: { none: true } }];` } }, output: [{ key: 'airtable:quote-publish:uuid' }] });
const any = ifElse({ version: 2.3, config: { name: 'Any Quote?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.none !== true }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

const claim = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Claim Quote Publish',
  parameters: { operation: 'executeQuery', query: 'select wf_claim_side_effect($1, $2, 180) as c',
    options: { queryReplacement: expr("{{ [ $('Write To Publish').first().json.key, 'n8n:10:' + $execution.id ] }}") } },
  credentials: PG }, output: [{ c: { claimed: true, payload: {} } }] });
const claimed = ifElse({ version: 2.3, config: { name: 'Claimed?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.c.claimed }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

const buildCustomer = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Build Customer',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
if (!job.customer_fields || !job.customer_fields['${ID.customer}']) return [{ json: refuse('build customer', 'SCHEMA_MISMATCH', 'claim carried no customer row') }];
return [{ json: { ok: true, request: { performUpsert: { fieldsToMergeOn: ['${ID.customer}'] }, returnFieldsByFieldId: true, typecast: false, records: [{ fields: job.customer_fields }] } } }];` } }, output: [{ request: {} }] });
const customerBuilt = ifElse({ version: 2.3, config: { name: 'Customer Row Built?', parameters: OK_IF } });
const upCustomer = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Upsert Customer', onError: 'continueRegularOutput',
  parameters: { method: 'PATCH', url: T.customers, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: expr('{{ JSON.stringify($json.request) }}'), options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { records: [{ id: 'rec' }] } }] });
const buildProperty = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Build Property',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const c = one('upsert customer', $input.first().json);
if (!c.ok) return [{ json: c }];
const fields = Object.assign({}, job.property_fields, { '${LINK.propertyOwner}': [c.id] });
return [{ json: { ok: true, customer_record_id: c.id, request: { performUpsert: { fieldsToMergeOn: ['${ID.property}'] }, returnFieldsByFieldId: true, typecast: false, records: [{ fields: fields }] } } }];` } }, output: [{ ok: true, request: {} }] });
const propertyOk = ifElse({ version: 2.3, config: { name: 'Customer OK?', parameters: OK_IF } });
const upProperty = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Upsert Property', onError: 'continueRegularOutput',
  parameters: { method: 'PATCH', url: T.properties, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: expr('{{ JSON.stringify($json.request) }}'), options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { records: [{ id: 'rec' }] } }] });
const buildQuote = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Build Quote',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const p = one('upsert property', $input.first().json);
if (!p.ok) return [{ json: p }];
const customer = $('Build Property').first().json.customer_record_id;
const fields = Object.assign({}, job.quote_fields, { '${LINK.quoteCustomer}': [customer], '${LINK.quoteProperty}': [p.id] });
return [{ json: { ok: true, customer_record_id: customer, property_record_id: p.id, request: { performUpsert: { fieldsToMergeOn: ['${ID.quote}'] }, returnFieldsByFieldId: true, typecast: false, records: [{ fields: fields }] } } }];` } }, output: [{ ok: true, request: {} }] });
const quoteOk = ifElse({ version: 2.3, config: { name: 'Property OK?', parameters: OK_IF } });
const upQuote = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Upsert Quote', onError: 'continueRegularOutput',
  parameters: { method: 'PATCH', url: T.quotes, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: expr('{{ JSON.stringify($json.request) }}'), options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { records: [{ id: 'rec' }] } }] });
const readQuote = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Back Quote', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: expr(T.quotes + '/{{ ($json.body.records || [{}])[0].id }}'), authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendQuery: true, queryParameters: { parameters: [{ name: 'returnFieldsByFieldId', value: 'true' }] }, options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { id: 'rec', fields: {} } }] });

const verify = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Verify Quote Read-Back',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const up = one('upsert quote', $('Upsert Quote').first().json);
if (!up.ok) return [{ json: up }];
const r = $input.first().json;
if (r.statusCode !== 200) return [{ json: fail('read back quote', r) }];
const ids = $('Build Quote').first().json;
const f = r.body.fields || {};
const problems = [];
if (r.body.id !== up.id) problems.push('read back a different record');
if (f['${NUM.quote}'] !== job.quote_number) problems.push('Quote Number is ' + f['${NUM.quote}']);
if (f['${ID.quote}'] !== job.quote_id) problems.push('RoofOps ID is ' + f['${ID.quote}']);
if (!(f['${LINK.quoteCustomer}'] || []).includes(ids.customer_record_id)) problems.push('quote is not linked to customer ' + ids.customer_record_id);
if (!(f['${LINK.quoteProperty}'] || []).includes(ids.property_record_id)) problems.push('quote is not linked to property ' + ids.property_record_id);
if (problems.length) return [{ json: refuse('verify read-back', 'RECONCILIATION_MISMATCH', problems.join('; ')) }];
return [{ json: { ok: true, proof: { verified: true, quote_number: f['${NUM.quote}'], customer_number: job.customer_number, property_number: job.property_number,
  quote_record_id: up.id, customer_record_id: ids.customer_record_id, property_record_id: ids.property_record_id,
  quote_customer_link_ids: f['${LINK.quoteCustomer}'], quote_property_link_ids: f['${LINK.quoteProperty}'], read_back_at: new Date().toISOString(), n8n_execution: $execution.id } } }];` } },
  output: [{ ok: true, proof: { verified: true } }] });
const verified = ifElse({ version: 2.3, config: { name: 'Read-Back Verified?', parameters: OK_IF } });

const complete = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Record Verified Publish', onError: 'continueErrorOutput',
  parameters: { operation: 'executeQuery', query: 'select wf_complete_side_effect($1, $2::jsonb) as r',
    options: { queryReplacement: expr("{{ [ $('Write To Publish').first().json.key, JSON.stringify($json.proof) ] }}") } },
  credentials: PG }, output: [{ r: { status: 'RECORDED' } }] });
const refused = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Proof Refused By Postgres',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const e = $input.first().json; const m = (e.error && (e.error.message || e.error)) || e.message || 'refused';
return [{ json: { ok: false, failure: { step: 'record quote publish', error_class: 'RECONCILIATION_MISMATCH', http_status: null, retry_after_seconds: null, message: 'record quote publish: ' + String(m).slice(0, 400) } } }];` } },
  output: [{ ok: false, failure: {} }] });
const recordFailure = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Record Publish Failure',
  parameters: { operation: 'executeQuery', query: "select wf_fail_side_effect($1, $2, $3, nullif($4, '')::int, nullif($5, '')::int) as f",
    options: { queryReplacement: expr("{{ [ $('Write To Publish').first().json.key, $json.failure.error_class, $json.failure.message, String($json.failure.http_status ?? ''), String($json.failure.retry_after_seconds ?? '') ] }}") } },
  credentials: PG }, output: [{ f: { retry: true } }] });

export default workflow('roofops-airtable-quote-publish', '[RoofOps] 10 Airtable Quote Publish')
  .add(everyMinute).to(next).to(pick).to(any.onTrue(claim.to(claimed.onTrue(buildCustomer.to(customerBuilt
    .onTrue(upCustomer.to(buildProperty).to(propertyOk
      .onTrue(upProperty.to(buildQuote).to(quoteOk
        .onTrue(upQuote.to(readQuote).to(verify).to(verified.onTrue(complete).onFalse(recordFailure)))
        .onFalse(recordFailure)))
      .onFalse(recordFailure)))
    .onFalse(recordFailure))))))
  .add(complete.onError(refused))
  .add(refused).to(recordFailure);
