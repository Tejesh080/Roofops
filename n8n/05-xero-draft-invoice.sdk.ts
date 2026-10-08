import { workflow, node, trigger, ifElse, switchCase, expr } from '@n8n/workflow-sdk';

const XERO = { xeroOAuth2Api: { id: 'rjqe50LhcU1IRLBc', name: 'RoofOps Xero' } };
const PG = { postgres: { id: 'kWqjtv0gz7ref2EN', name: 'RoofOps Postgres' } };
const RAW = { response: { response: { fullResponse: true, neverError: true } }, timeout: 20000 };
const API = 'https://api.xero.com/api.xro/2.0';
const JOB = "$('Claim Xero Draft').last().json.c.payload";
const HDR = { parameters: [
  { name: 'xero-tenant-id', value: expr('{{ ' + JOB + '.xero_tenant_id }}') }, { name: 'Accept', value: 'application/json' }] };
const ALL_STATUSES = 'DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED';

const FAIL_JS = `
function xeroMsg(b) {
  if (!b || typeof b !== 'object') return String(b || '');
  const ve = [];
  (b.Elements || []).forEach(function (e) { (e.ValidationErrors || []).forEach(function (v) { ve.push(v.Message); }); });
  return ve.length ? ve.join('; ') : (b.Detail || b.Message || b.Title || JSON.stringify(b).slice(0, 300));
}
function fail(step, r) {
  const s = r.statusCode;
  const msg = s ? xeroMsg(r.body) : ((r.error && (r.error.message || r.error)) || r.message || 'no response');
  let cls = 'UNKNOWN'; let retryAfter = null;
  if (!s) cls = /time ?out|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED/i.test(String(msg)) ? 'TIMEOUT' : 'NETWORK';
  else if (s === 429) { cls = 'RATE_LIMITED'; retryAfter = parseInt((r.headers || {})['retry-after'], 10) || 60; }
  else if (s === 401) cls = 'AUTH_FAILURE';
  else if (s === 403) cls = 'PERMISSION_DENIED';
  else if (s === 404) cls = 'NOT_FOUND';
  else if (s === 409) cls = 'CONFLICT';
  else if (s === 400 || s === 422) cls = 'VALIDATION_ERROR';
  else if (s === 503) cls = 'SERVICE_UNAVAILABLE';
  else if (s >= 500) cls = 'UPSTREAM_5XX';
  return { ok: false, failure: { step: step, error_class: cls, http_status: s || null, retry_after_seconds: retryAfter, message: step + ': ' + String(msg).slice(0, 400) } };
}
function refuse(step, cls, message) {
  return { ok: false, failure: { step: step, error_class: cls, http_status: null, retry_after_seconds: null, message: step + ': ' + message } };
}
` + 'const job = ' + JOB + ' || {};\n' + 'const money = function (x) { return Math.round(Number(x) * 100); };\n';

const OK_PARAMS = { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.ok }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } };

const start = trigger({ type: 'n8n-nodes-base.executeWorkflowTrigger', version: 1.2,
  config: { name: 'When Called By Workflow 04', parameters: { inputSource: 'passthrough' } }, output: [{ xero_key: 'xero:invoice:uuid' }] });

const claim = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Claim Xero Draft',
  parameters: { operation: 'executeQuery', query: 'select wf_claim_side_effect($1, $2, 180) as c',
    options: { queryReplacement: expr("{{ [ $('When Called By Workflow 04').first().json.xero_key, 'n8n:' + $execution.id ] }}") } },
  credentials: PG }, output: [{ c: { claimed: true, payload: {} } }] });

const claimRoute = switchCase({ version: 3.4, config: { name: 'Claimed?',
  parameters: { mode: 'expression', numberOutputs: 3, output: expr("{{ $json.c.claimed ? 0 : ($json.c.status === 'DONE' ? 1 : 2) }}") } } });

const alreadyDone = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Xero Draft Already Done',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const c = $input.first().json.c;
return [{ json: Object.assign({}, $('When Called By Workflow 04').first().json, { xero: { status: 'DONE', already_done: true, invoice_id: c.result.invoice_id,
  invoice_number: c.result.invoice_number, total: c.result.total, xero_status: c.result.status } }) }];` } }, output: [{ xero: { status: 'DONE' } }] });

const notClaimed = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Xero Draft Not Claimed',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const c = $input.first().json.c;
const dead = c.status === 'FAILED' && String(c.retry_at || '').startsWith('infinity');
return [{ json: Object.assign({}, $('When Called By Workflow 04').first().json, { xero: { status: dead ? 'FAILED' : 'NOT_CLAIMED', claim: c,
  message: dead ? 'Dead-lettered after ' + c.attempts + ' attempts: ' + c.last_error : 'Held by another worker or waiting for its retry window (' + c.status + ')' } }) }];` } },
  output: [{ xero: { status: 'NOT_CLAIMED' } }] });

const connections = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'List Xero Connections', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: 'https://api.xero.com/connections', authentication: 'predefinedCredentialType', nodeCredentialType: 'xeroOAuth2Api', options: RAW },
  credentials: XERO }, output: [{ statusCode: 200, body: [] }] });
const checkTenant = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Check Pinned Tenant Connected',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const r = $input.first().json;
if (r.statusCode !== 200) return [{ json: fail('list connections', r) }];
if (!job.xero_tenant_id) return [{ json: refuse('check tenant', 'PERMISSION_DENIED', 'no pinned Xero Demo tenant in the approved payload') }];
const t = (Array.isArray(r.body) ? r.body : []).filter(function (c) { return c.tenantId === job.xero_tenant_id; });
if (t.length !== 1) return [{ json: refuse('check tenant', 'PERMISSION_DENIED', 'the pinned Xero Demo tenant is not connected to the RoofOps Xero credential') }];
return [{ json: { ok: true, tenant_id: t[0].tenantId, tenant_name: t[0].tenantName } }];` } }, output: [{ ok: true }] });
const tenantOk = ifElse({ version: 2.3, config: { name: 'Tenant OK?', parameters: OK_PARAMS } });

const org = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Organisation', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: API + '/Organisation', authentication: 'predefinedCredentialType', nodeCredentialType: 'xeroOAuth2Api',
    sendHeaders: true, headerParameters: HDR, options: RAW }, credentials: XERO }, output: [{ statusCode: 200, body: {} }] });
const checkOrg = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Check Demo Company',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const r = $input.first().json;
if (r.statusCode !== 200) return [{ json: fail('read organisation', r) }];
const o = ((r.body || {}).Organisations || [])[0] || {};
if (o.Class !== 'DEMO' || o.IsDemoCompany !== true || o.OrganisationID !== job.xero_tenant_id) {
  return [{ json: refuse('check organisation', 'PERMISSION_DENIED', 'REFUSED: "' + o.Name + '" is not a Xero Demo Company (Class=' + o.Class + ', IsDemoCompany=' + o.IsDemoCompany + ')') }];
}
return [{ json: { ok: true, organisation_name: o.Name, organisation_class: o.Class } }];` } }, output: [{ ok: true }] });
const orgOk = ifElse({ version: 2.3, config: { name: 'Demo Company?', parameters: OK_PARAMS } });

const findContact = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Find Contact By Number', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: API + '/Contacts', authentication: 'predefinedCredentialType', nodeCredentialType: 'xeroOAuth2Api', sendHeaders: true, headerParameters: HDR,
    sendQuery: true, queryParameters: { parameters: [
      { name: 'where', value: expr('ContactNumber=="{{ ' + JOB + '.xero_contact_number }}"') }, { name: 'includeArchived', value: 'true' }] }, options: RAW },
  credentials: XERO }, output: [{ statusCode: 200, body: { Contacts: [] } }] });
const checkContact = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Check Contact Search',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const r = $input.first().json;
if (r.statusCode !== 200) return [{ json: fail('find contact', r) }];
const cs = (r.body.Contacts || []).filter(function (c) { return c.ContactNumber === job.xero_contact_number; });
if (cs.length > 1) return [{ json: refuse('find contact', 'RECONCILIATION_MISMATCH', cs.length + ' Xero contacts have number ' + job.xero_contact_number) }];
if (cs.length === 1 && cs[0].ContactStatus !== 'ACTIVE') return [{ json: refuse('find contact', 'RECONCILIATION_MISMATCH', 'Xero contact ' + job.xero_contact_number + ' is ' + cs[0].ContactStatus) }];
return [{ json: { ok: true, found: cs.length === 1, contact_id: cs.length ? cs[0].ContactID : null } }];` } }, output: [{ ok: true, found: false }] });
const contactOk = ifElse({ version: 2.3, config: { name: 'Contact Search OK?', parameters: OK_PARAMS } });
const contactExists = ifElse({ version: 2.3, config: { name: 'Contact Exists?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.found }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

const createContact = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Create Contact', onError: 'continueRegularOutput',
  parameters: { method: 'PUT', url: API + '/Contacts', authentication: 'predefinedCredentialType', nodeCredentialType: 'xeroOAuth2Api', sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'xero-tenant-id', value: expr('{{ ' + JOB + '.xero_tenant_id }}') }, { name: 'Accept', value: 'application/json' },
      { name: 'Idempotency-Key', value: expr("roofops-contact-{{ " + JOB + ".customer_id }}") }] },
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: expr('{{ JSON.stringify({ Contacts: [{ Name: ' + JOB + '.xero_contact_name, ContactNumber: ' + JOB + '.xero_contact_number, EmailAddress: ' + JOB + '.customer_email }] }) }}'),
    options: RAW }, credentials: XERO }, output: [{ statusCode: 200, body: { Contacts: [{ ContactID: 'c' }] } }] });
const checkCreateContact = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Check Contact Create',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const r = $input.first().json;
if (r.statusCode !== 200) return [{ json: fail('create contact', r) }];
const c = (r.body.Contacts || [])[0] || {};
if (!c.ContactID || c.ContactNumber !== job.xero_contact_number || c.HasValidationErrors) return [{ json: refuse('create contact', 'RECONCILIATION_MISMATCH', 'contact create did not return ' + job.xero_contact_number) }];
return [{ json: { ok: true, found: false, created: true, contact_id: c.ContactID } }];` } }, output: [{ ok: true }] });
const createContactOk = ifElse({ version: 2.3, config: { name: 'Contact Created?', parameters: OK_PARAMS } });

const findByNumber = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Search Xero By Invoice Number', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: API + '/Invoices', authentication: 'predefinedCredentialType', nodeCredentialType: 'xeroOAuth2Api', sendHeaders: true, headerParameters: HDR,
    sendQuery: true, queryParameters: { parameters: [
      { name: 'InvoiceNumbers', value: expr('{{ ' + JOB + '.xero_invoice_number }}') }, { name: 'Statuses', value: ALL_STATUSES }] }, options: RAW },
  credentials: XERO }, output: [{ statusCode: 200, body: { Invoices: [] } }] });
const findByRef = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Search Xero By Reference', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: API + '/Invoices', authentication: 'predefinedCredentialType', nodeCredentialType: 'xeroOAuth2Api', sendHeaders: true, headerParameters: HDR,
    sendQuery: true, queryParameters: { parameters: [
      { name: 'where', value: expr('Type=="ACCREC" AND Reference=="{{ ' + JOB + '.reference }}"') }, { name: 'Statuses', value: ALL_STATUSES }] }, options: RAW },
  credentials: XERO }, output: [{ statusCode: 200, body: { Invoices: [] } }] });

const reconcile = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Reconcile Before Create',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
// Search BEFORE every create: a timed-out earlier attempt may already have created the draft.
const byNum = $('Search Xero By Invoice Number').first().json;
const byRef = $input.first().json;
if (byNum.statusCode !== 200) return [{ json: fail('search by invoice number', byNum) }];
if (byRef.statusCode !== 200) return [{ json: fail('search by reference', byRef) }];
const cs = $('Check Contact Search').first().json;
const contact = cs.found ? cs.contact_id : $('Check Contact Create').first().json.contact_id;
let mine = (byNum.body.Invoices || []).filter(function (i) { return i.InvoiceNumber === job.xero_invoice_number; });
let live = mine.filter(function (i) { return i.Status !== 'DELETED' && i.Status !== 'VOIDED'; });
const others = (byRef.body.Invoices || []).filter(function (i) { return i.InvoiceNumber !== job.xero_invoice_number && i.Status !== 'DELETED' && i.Status !== 'VOIDED'; });
if (others.length) return [{ json: refuse('reconcile', 'RECONCILIATION_MISMATCH', 'Xero already has ' + others.map(function (i) { return i.InvoiceNumber + ' (' + i.Status + ')'; }).join(', ') + ' with reference ' + job.reference + '; refusing to bill twice') }];
// AC-14C P2-D2: a generation >= 2 write is a supervised reissue (the claim proved it in Postgres) that replaces the
// superseded document(s) with the same number. Those must stay VOIDED/DELETED and are never adopted; any other document
// with the number is judged exactly as for generation 1 (adopt only a fresh matching DRAFT, otherwise a person decides).
const claimed = $('Claim Xero Draft').last().json.c || {};
const gen = Number(claimed.generation || 1);
if (gen >= 2) {
  const stale = claimed.superseded_xero_invoice_ids;
  if (!Array.isArray(stale) || !stale.length) return [{ json: refuse('reconcile', 'RECONCILIATION_MISMATCH', 'generation ' + gen + ' of ' + job.xero_invoice_number + ' was claimed without its superseded Xero invoice ids; refusing') }];
  const revived = mine.filter(function (i) { return stale.indexOf(i.InvoiceID) >= 0 && i.Status !== 'DELETED' && i.Status !== 'VOIDED'; });
  if (revived.length) return [{ json: refuse('reconcile', 'RECONCILIATION_MISMATCH', 'superseded Xero invoice ' + revived[0].InvoiceID + ' (' + job.xero_invoice_number + ') is ' + revived[0].Status + ' again; a person must decide') }];
  mine = mine.filter(function (i) { return stale.indexOf(i.InvoiceID) < 0; });
  live = mine.filter(function (i) { return i.Status !== 'DELETED' && i.Status !== 'VOIDED'; });
  if (mine.length && !live.length) return [{ json: refuse('reconcile', 'RECONCILIATION_MISMATCH', job.xero_invoice_number + ' exists in Xero as ' + mine[0].Status + ' (' + mine[0].InvoiceID + '), not a superseded generation; a person must decide') }];
}
if (mine.length && !live.length) return [{ json: refuse('reconcile', 'RECONCILIATION_MISMATCH', job.xero_invoice_number + ' exists in Xero as ' + mine[0].Status + '; a person must decide') }];
if (live.length > 1) return [{ json: refuse('reconcile', 'RECONCILIATION_MISMATCH', live.length + ' Xero invoices numbered ' + job.xero_invoice_number) }];
if (live.length === 1) {
  const i = live[0];
  if (i.Status !== 'DRAFT' || (i.Contact || {}).ContactID !== contact || money(i.Total) !== money(job.amount_inc_gst)) {
    return [{ json: refuse('reconcile', 'RECONCILIATION_MISMATCH', job.xero_invoice_number + ' exists in Xero but differs (status ' + i.Status + ', total ' + i.Total + '); a person must decide') }];
  }
  return [{ json: { ok: true, exists: true, invoice_id: i.InvoiceID, contact_id: contact, adopted: true } }];
}
return [{ json: { ok: true, exists: false, contact_id: contact } }];` } }, output: [{ ok: true, exists: false }] });
const reconcileOk = ifElse({ version: 2.3, config: { name: 'Reconciled?', parameters: OK_PARAMS } });
const invoiceExists = ifElse({ version: 2.3, config: { name: 'Draft Already In Xero?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.exists }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

const createInvoice = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Create DRAFT Invoice', onError: 'continueRegularOutput',
  parameters: { method: 'PUT', url: API + '/Invoices', authentication: 'predefinedCredentialType', nodeCredentialType: 'xeroOAuth2Api', sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'xero-tenant-id', value: expr('{{ ' + JOB + '.xero_tenant_id }}') }, { name: 'Accept', value: 'application/json' },
      { name: 'Idempotency-Key', value: expr('{{ ' + JOB + '.xero_idempotency_key }}') }] },
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: expr('{{ JSON.stringify({ Invoices: [{ Type: "ACCREC", Status: "DRAFT", Contact: { ContactID: $json.contact_id }, Date: ' + JOB + '.invoice_date, DueDate: ' + JOB + '.due_date, '
      + 'LineAmountTypes: "Inclusive", CurrencyCode: "AUD", InvoiceNumber: ' + JOB + '.xero_invoice_number, Reference: ' + JOB + '.reference, '
      + 'LineItems: ' + JOB + '.lines.map(l => ({ Description: l.description, Quantity: l.quantity, UnitAmount: l.unit_amount, AccountCode: ' + JOB + '.xero_account_code, TaxType: ' + JOB + '.xero_tax_type })) }] }) }}'),
    options: RAW }, credentials: XERO }, output: [{ statusCode: 200, body: { Invoices: [{ InvoiceID: 'i' }] } }] });
const checkCreate = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Check Invoice Create',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const r = $input.first().json;
if (r.statusCode !== 200) return [{ json: fail('create draft invoice', r) }];
const i = (r.body.Invoices || [])[0] || {};
if (!i.InvoiceID || i.HasErrors) return [{ json: refuse('create draft invoice', 'VALIDATION_ERROR', xeroMsg(r.body)) }];
return [{ json: { ok: true, exists: true, invoice_id: i.InvoiceID, contact_id: $('Reconcile Before Create').first().json.contact_id, adopted: false } }];` } },
  output: [{ ok: true }] });
const createOk = ifElse({ version: 2.3, config: { name: 'Created?', parameters: OK_PARAMS } });

const readInvoice = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Back Invoice', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: expr(API + '/Invoices/{{ $json.invoice_id }}'), authentication: 'predefinedCredentialType', nodeCredentialType: 'xeroOAuth2Api',
    sendHeaders: true, headerParameters: HDR, options: RAW }, credentials: XERO }, output: [{ statusCode: 200, body: { Invoices: [] } }] });
const recount = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Recount By Invoice Number', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: API + '/Invoices', authentication: 'predefinedCredentialType', nodeCredentialType: 'xeroOAuth2Api', sendHeaders: true, headerParameters: HDR,
    sendQuery: true, queryParameters: { parameters: [
      { name: 'InvoiceNumbers', value: expr('{{ ' + JOB + '.xero_invoice_number }}') }, { name: 'Statuses', value: 'DRAFT,SUBMITTED,AUTHORISED,PAID' }] }, options: RAW },
  credentials: XERO }, output: [{ statusCode: 200, body: { Invoices: [] } }] });

const verify = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Verify Xero Read-Back',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const rb = $('Read Back Invoice').first().json;
const rc = $input.first().json;
if (rb.statusCode !== 200) return [{ json: fail('read back invoice', rb) }];
if (rc.statusCode !== 200) return [{ json: fail('recount invoices', rc) }];
const i = (rb.body.Invoices || [])[0] || {};
const rec = $('Reconcile Before Create').first().json;
const want = rec.exists ? rec : $('Check Invoice Create').first().json;
const problems = [];
if (i.InvoiceID !== want.invoice_id) problems.push('read back a different invoice');
if (i.Type !== 'ACCREC') problems.push('type ' + i.Type);
if (i.Status !== 'DRAFT') problems.push('status ' + i.Status);
if (i.InvoiceNumber !== job.xero_invoice_number) problems.push('number ' + i.InvoiceNumber);
if (i.Reference !== job.reference) problems.push('reference ' + i.Reference);
if ((i.Contact || {}).ContactID !== want.contact_id) problems.push('contact ' + (i.Contact || {}).ContactID);
if (money(i.Total) !== money(job.amount_inc_gst)) problems.push('total ' + i.Total + ' != ' + job.amount_inc_gst);
if (money(i.TotalTax) !== money(job.gst_amount)) problems.push('GST ' + i.TotalTax + ' != ' + job.gst_amount);
if (i.LineAmountTypes !== 'Inclusive' || i.CurrencyCode !== 'AUD') problems.push(i.LineAmountTypes + '/' + i.CurrencyCode);
if (Number(i.AmountPaid || 0) !== 0 || i.SentToContact === true) problems.push('paid or sent');
const matching = (rc.body.Invoices || []).filter(function (x) { return x.InvoiceNumber === job.xero_invoice_number; }).length;
if (matching !== 1) problems.push(matching + ' live invoices numbered ' + job.xero_invoice_number);
const vc = $('Claim Xero Draft').last().json.c || {};
if (Number(vc.generation || 1) >= 2 && (vc.superseded_xero_invoice_ids || []).indexOf(i.InvoiceID) >= 0) problems.push('read back superseded Xero invoice ' + i.InvoiceID);
if (problems.length) return [{ json: refuse('verify read-back', 'RECONCILIATION_MISMATCH', problems.join('; ')) }];
const t = $('Check Pinned Tenant Connected').first().json;
return [{ json: { ok: true, proof: { verified: true, tenant_id: t.tenant_id, tenant_name: t.tenant_name, organisation_class: $('Check Demo Company').first().json.organisation_class,
  invoice_id: i.InvoiceID, invoice_number: i.InvoiceNumber, reference: i.Reference, status: i.Status, type: i.Type, amount_paid: Number(i.AmountPaid || 0),
  sent_to_contact: i.SentToContact === true, contact_id: i.Contact.ContactID, contact_number: job.xero_contact_number, contact_name: i.Contact.Name,
  total: i.Total, total_tax: i.TotalTax, sub_total: i.SubTotal, currency: i.CurrencyCode, line_amount_types: i.LineAmountTypes, matching_invoices: matching,
  adopted_existing_draft: want.adopted === true, read_back_at: new Date().toISOString(), n8n_execution: $execution.id } } }];` } },
  output: [{ ok: true, proof: {} }] });
const verifyOk = ifElse({ version: 2.3, config: { name: 'Read-Back Verified?', parameters: OK_PARAMS } });

const complete = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Record Verified Xero Draft', onError: 'continueErrorOutput',
  parameters: { operation: 'executeQuery', query: 'select wf_complete_side_effect($1, $2::jsonb) as r',
    options: { queryReplacement: expr("{{ [ $('When Called By Workflow 04').first().json.xero_key, JSON.stringify($json.proof) ] }}") } },
  credentials: PG }, output: [{ r: { status: 'RECORDED' } }] });
const done = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Xero Draft Done',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const p = $('Verify Xero Read-Back').first().json.proof;
return [{ json: Object.assign({}, $('When Called By Workflow 04').first().json, { xero: { status: 'DONE', invoice_id: p.invoice_id, invoice_number: p.invoice_number,
  contact_id: p.contact_id, total: p.total, total_tax: p.total_tax, xero_status: p.status, tenant_name: p.tenant_name, adopted_existing_draft: p.adopted_existing_draft,
  attempt: $('Claim Xero Draft').last().json.c.attempt, recorded: $input.first().json.r } }) }];` } }, output: [{ xero: { status: 'DONE' } }] });
const refused = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Proof Refused By Postgres',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const e = $input.first().json;
const m = (e.error && (e.error.message || e.error)) || e.message || 'refused';
return [{ json: { ok: false, failure: { step: 'record xero draft', error_class: 'RECONCILIATION_MISMATCH', http_status: null, retry_after_seconds: null, message: 'record xero draft: ' + String(m).slice(0, 400) } } }];` } },
  output: [{ ok: false }] });

const recordFailure = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Record Xero Failure',
  parameters: { operation: 'executeQuery',
    query: "select wf_fail_side_effect($1, $2, $3, nullif($4, '')::int, nullif($5, '')::int) as f, $6::text as step",
    options: { queryReplacement: expr("{{ [ $('When Called By Workflow 04').first().json.xero_key, $json.failure.error_class, $json.failure.message, String($json.failure.http_status ?? ''), String($json.failure.retry_after_seconds ?? ''), $json.failure.step ] }}") } },
  credentials: PG }, output: [{ f: { retry: true, retry_in_seconds: 1 } }] });
const retry = ifElse({ version: 2.3, config: { name: 'Retry Allowed?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.f.retry }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });
const wait = node({ type: 'n8n-nodes-base.wait', version: 1.1, config: { name: 'Wait For Backoff',
  parameters: { resume: 'timeInterval', amount: expr('{{ $json.f.retry_in_seconds + 2 }}'), unit: 'seconds' } }, output: [{}] });
const deadLetter = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Xero Draft Failed (Exception Opened)',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const f = $input.first().json.f;
return [{ json: Object.assign({}, $('When Called By Workflow 04').first().json, { xero: { status: 'FAILED', exception_number: f.exception_number, attempt: f.attempt, reason: f.reason,
  message: $('Record Xero Failure').last().json.step } }) }];` } }, output: [{ xero: { status: 'FAILED' } }] });

export default workflow('roofops-xero-draft-invoice', '[RoofOps] 05 Xero Draft Invoice')
  .add(start).to(claim).to(claimRoute
    .onCase(0, connections.to(checkTenant).to(tenantOk
      .onTrue(org.to(checkOrg).to(orgOk
        .onTrue(findContact.to(checkContact).to(contactOk
          .onTrue(contactExists
            .onTrue(findByNumber)
            .onFalse(createContact.to(checkCreateContact).to(createContactOk.onTrue(findByNumber).onFalse(recordFailure))))
          .onFalse(recordFailure)))
        .onFalse(recordFailure)))
      .onFalse(recordFailure)))
    .onCase(1, alreadyDone)
    .onCase(2, notClaimed))
  .add(findByNumber).to(findByRef).to(reconcile).to(reconcileOk
    .onTrue(invoiceExists
      .onTrue(readInvoice)
      .onFalse(createInvoice.to(checkCreate).to(createOk.onTrue(readInvoice).onFalse(recordFailure))))
    .onFalse(recordFailure))
  .add(readInvoice).to(recount).to(verify).to(verifyOk.onTrue(complete).onFalse(recordFailure))
  .add(complete).to(done)
  .add(complete.onError(refused))
  .add(refused).to(recordFailure)
  .add(recordFailure).to(retry.onTrue(wait.to(claim)).onFalse(deadLetter));
