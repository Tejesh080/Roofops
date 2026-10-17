import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';

// [RoofOps] 10 Airtable Quote Publish (SALES-01). UNPUBLISHED: written for review; nothing here runs until the owner
// creates and activates it. A quote drafted and sent in the RoofOps dashboard (web_quote_send) queues ONE outbox write,
// airtable.quote_publish, carrying the customer, property and quote rows by their RoofOps numbers. Every minute this asks
// Postgres for the next due write (wf_quote_publish_next), claims it (wf_claim_side_effect), upserts the three Airtable
// records MERGED ON THEIR RoofOps ID field (a retry finds the same records, never a second one), links property -> customer
// and quote -> customer + property, reads all three records back and records what Airtable holds as the proof
// (wf_complete_side_effect checks record ids, RoofOps IDs, numbers, owner and quote links, version and amount). A failure is recorded with its class (wf_quote_publish_fail: bounded retry, then an exception). After this the quote
// is an ordinary Airtable quote: reconciliation keeps its fields canonical and Status -> Accepted runs n8n 01 unchanged.

const AIRTABLE = { airtableTokenApi: { id: '3XbFnHjAd7mFvBD2', name: 'Roofops Airtable Personal Access Token account' } };
const PG = { postgres: { id: 'kWqjtv0gz7ref2EN', name: 'RoofOps Postgres' } };
const RAW = { response: { response: { fullResponse: true, neverError: true } }, timeout: 20000 };
const BASE = 'https://api.airtable.com/v0/appMc8V0Wm29tEeHQ';
const T = { customers: BASE + '/tblHKX79FJFHn5FDc', properties: BASE + '/tblSYcCqId9wTMg3c', quotes: BASE + '/tblzenPRNVV5O7lZP' };
const ID = { customer: 'fldDClu1e0ffwnojn', property: 'fldm6rtleyV6yp8ZS', quote: 'fldVUpqZkVKid3Fyy' };
const LINK = { propertyOwner: 'fldVpX0MOcA8TnGvo', quoteCustomer: 'fld4LsEu8c9EMFj0h', quoteProperty: 'fldisUv1ckHz2Detv' };
const NUM = { customer: 'fldzmWSHtLVZ4OTmZ', property: 'fldIy8ab7Ky67jL31', quote: 'fldyP20HNafS614d5' };
const QF = { version: 'fldEjEqlzE8Y0M1nf', amount: 'fldbfUE8DVh1Dwjfs' };   // Quotes.Version, Quotes.Amount (inc GST)
const STATUS = 'fldQpTa5tvrzlNg1h';   // Quotes.Status (AIRTABLE_EDIT: Accepted -> n8n 01)

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
// Status is staff-editable in Airtable. Only the first attempt writes it (creating the row as Sent); a retry may find the row
// already there and edited (e.g. Accepted) and must never put it back. A row a retry creates gets Sent from reconciliation.
if (Number($('Claim Quote Publish').last().json.c.attempt) > 1) delete fields['${STATUS}'];
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

// The customer and property records as Airtable now holds them (the proof is what was read, never what was sent).
const readCustomer = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Back Customer', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: expr(T.customers + "/{{ $('Build Quote').first().json.customer_record_id }}"), authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendQuery: true, queryParameters: { parameters: [{ name: 'returnFieldsByFieldId', value: 'true' }] }, options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { id: 'rec', fields: {} } }] });
const readProperty = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Back Property', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: expr(T.properties + "/{{ $('Build Quote').first().json.property_record_id }}"), authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendQuery: true, queryParameters: { parameters: [{ name: 'returnFieldsByFieldId', value: 'true' }] }, options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { id: 'rec', fields: {} } }] });

const verify = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Verify Quote Read-Back',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const up = one('upsert quote', $('Upsert Quote').first().json);
if (!up.ok) return [{ json: up }];
const rq = $('Read Back Quote').first().json;
const rc = $('Read Back Customer').first().json;
const rp = $input.first().json;                                       // Read Back Property
if (rq.statusCode !== 200) return [{ json: fail('read back quote', rq) }];
if (rc.statusCode !== 200) return [{ json: fail('read back customer', rc) }];
if (rp.statusCode !== 200) return [{ json: fail('read back property', rp) }];
const ids = $('Build Quote').first().json;
const q = rq.body.fields || {}; const c = rc.body.fields || {}; const p = rp.body.fields || {};
const has = (list, id) => Array.isArray(list) && list.indexOf(id) >= 0;
const want = job.quote_fields || {};
const problems = [];
if (rq.body.id !== up.id) problems.push('read back a different quote record');
if (q['${NUM.quote}'] !== job.quote_number) problems.push('Quote Number is ' + q['${NUM.quote}']);
if (q['${ID.quote}'] !== job.quote_id) problems.push('quote RoofOps ID is ' + q['${ID.quote}']);
if (Number(q['${QF.version}']) !== Number(want['${QF.version}'])) problems.push('Version is ' + q['${QF.version}'] + ', not ' + want['${QF.version}']);
if (Number(q['${QF.amount}']) !== Number(want['${QF.amount}'])) problems.push('Amount is ' + q['${QF.amount}'] + ', not ' + want['${QF.amount}']);
if (!has(q['${LINK.quoteCustomer}'], ids.customer_record_id)) problems.push('quote is not linked to customer ' + ids.customer_record_id);
if (!has(q['${LINK.quoteProperty}'], ids.property_record_id)) problems.push('quote is not linked to property ' + ids.property_record_id);
if (rc.body.id !== ids.customer_record_id) problems.push('read back a different customer record');
if (c['${NUM.customer}'] !== job.customer_number) problems.push('Customer ID is ' + c['${NUM.customer}']);
if (c['${ID.customer}'] !== job.customer_id) problems.push('customer RoofOps ID is ' + c['${ID.customer}']);
if (rp.body.id !== ids.property_record_id) problems.push('read back a different property record');
if (p['${NUM.property}'] !== job.property_number) problems.push('Property ID is ' + p['${NUM.property}']);
if (p['${ID.property}'] !== job.property_id) problems.push('property RoofOps ID is ' + p['${ID.property}']);
if (!has(p['${LINK.propertyOwner}'], ids.customer_record_id)) problems.push('property owner is not customer ' + ids.customer_record_id);
if (problems.length) return [{ json: refuse('verify read-back', 'RECONCILIATION_MISMATCH', problems.join('; ')) }];
// Every value below is what Airtable returned; Postgres checks it again against the hand-off before recording DONE.
return [{ json: { ok: true, proof: { verified: true, quote_number: q['${NUM.quote}'], customer_number: c['${NUM.customer}'], property_number: p['${NUM.property}'],
  quote_record_id: rq.body.id, customer_record_id: rc.body.id, property_record_id: rp.body.id,
  quote_customer_link_ids: q['${LINK.quoteCustomer}'], quote_property_link_ids: q['${LINK.quoteProperty}'],
  customer_read_back: { id: rc.body.id, roofops_id: c['${ID.customer}'], number: c['${NUM.customer}'] },
  property_read_back: { id: rp.body.id, roofops_id: p['${ID.property}'], number: p['${NUM.property}'], owner_link_ids: p['${LINK.propertyOwner}'] },
  quote_read_back: { id: rq.body.id, roofops_id: q['${ID.quote}'], number: q['${NUM.quote}'], version: q['${QF.version}'], amount: q['${QF.amount}'],
    customer_link_ids: q['${LINK.quoteCustomer}'], property_link_ids: q['${LINK.quoteProperty}'] },
  read_back_at: new Date().toISOString(), n8n_execution: $execution.id } } }];` } },
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
  parameters: { operation: 'executeQuery', query: "select wf_quote_publish_fail($1, $2, $3, nullif($4, '')::int, nullif($5, '')::int) as f",
    options: { queryReplacement: expr("{{ [ $('Write To Publish').first().json.key, $json.failure.error_class, $json.failure.message, String($json.failure.http_status ?? ''), String($json.failure.retry_after_seconds ?? '') ] }}") } },
  credentials: PG }, output: [{ f: { retry: true } }] });

export default workflow('roofops-airtable-quote-publish', '[RoofOps] 10 Airtable Quote Publish')
  .add(everyMinute).to(next).to(pick).to(any.onTrue(claim.to(claimed.onTrue(buildCustomer.to(customerBuilt
    .onTrue(upCustomer.to(buildProperty).to(propertyOk
      .onTrue(upProperty.to(buildQuote).to(quoteOk
        .onTrue(upQuote.to(readQuote).to(readCustomer).to(readProperty).to(verify).to(verified.onTrue(complete).onFalse(recordFailure)))
        .onFalse(recordFailure)))
      .onFalse(recordFailure)))
    .onFalse(recordFailure))))))
  .add(complete.onError(refused))
  .add(refused).to(recordFailure);
