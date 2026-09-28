import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';

// Read-only. Identifies the Xero tenant behind the RoofOps Xero credential, proves it is a DEMO organisation,
// and reads a handful of contacts, invoices and the sales account. Outputs ids/names/counts only (no tokens).
const XERO = { xeroOAuth2Api: { id: 'rjqe50LhcU1IRLBc', name: 'RoofOps Xero' } };
const RAW = { response: { response: { fullResponse: true, neverError: true } }, timeout: 20000 };
const API = 'https://api.xero.com/api.xro/2.0';
const HDR = { parameters: [
  { name: 'xero-tenant-id', value: expr("{{ $('Pick Demo Tenant').first().json.tenant_id }}") }, { name: 'Accept', value: 'application/json' }] };

const start = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run Xero Check' }, output: [{}] });

const connections = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'List Xero Connections',
  parameters: { method: 'GET', url: 'https://api.xero.com/connections', authentication: 'predefinedCredentialType', nodeCredentialType: 'xeroOAuth2Api', options: RAW },
  credentials: XERO }, output: [{ statusCode: 200, body: [] }] });

const pick = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Pick Demo Tenant',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const r = $input.first().json;
if (r.statusCode !== 200) throw new Error('connections: HTTP ' + r.statusCode + ' ' + JSON.stringify(r.body).slice(0, 200));
const all = (Array.isArray(r.body) ? r.body : []).filter(function (c) { return c.tenantType === 'ORGANISATION'; });
if (all.length !== 1) throw new Error('expected exactly one connected organisation, found ' + all.length);
// Identity only; the Organisation read below decides whether this is a DEMO org. Nothing else is read until then.
return [{ json: { tenant_id: all[0].tenantId, tenant_name: all[0].tenantName, name_says_demo: /demo company/i.test(all[0].tenantName || '') } }];` } },
  output: [{ tenant_id: 't' }] });

const isDemo = ifElse({ version: 2.3, config: { name: 'Is Demo Company?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ (($json.body || {}).Organisations || [{}])[0].Class }}'), rightValue: 'DEMO', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } } } });

const notDemo = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Not A Demo Company (Stop)',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const o = (($input.first().json.body || {}).Organisations || [{}])[0];
return [{ json: { is_demo: false, http: $input.first().json.statusCode, name: o.Name, class: o.Class, edition: o.Edition, country: o.CountryCode, organisation_type: o.OrganisationType, note: 'Refused: RoofOps writes only to a Xero Demo Company. No contacts or invoices were read.' } }];` } },
  output: [{ is_demo: false }] });

const org = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Organisation',
  parameters: { method: 'GET', url: API + '/Organisation', authentication: 'predefinedCredentialType', nodeCredentialType: 'xeroOAuth2Api', sendHeaders: true, headerParameters: HDR, options: RAW },
  credentials: XERO }, output: [{ statusCode: 200, body: {} }] });

const contacts = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Some Contacts',
  parameters: { method: 'GET', url: API + '/Contacts', authentication: 'predefinedCredentialType', nodeCredentialType: 'xeroOAuth2Api', sendHeaders: true, headerParameters: HDR,
    sendQuery: true, queryParameters: { parameters: [{ name: 'page', value: '1' }, { name: 'pageSize', value: '5' }, { name: 'summaryOnly', value: 'true' }] }, options: RAW },
  credentials: XERO }, output: [{ statusCode: 200, body: {} }] });

const invoices = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Some Invoices',
  parameters: { method: 'GET', url: API + '/Invoices', authentication: 'predefinedCredentialType', nodeCredentialType: 'xeroOAuth2Api', sendHeaders: true, headerParameters: HDR,
    sendQuery: true, queryParameters: { parameters: [{ name: 'page', value: '1' }, { name: 'pageSize', value: '5' }, { name: 'where', value: 'Type=="ACCREC"' }, { name: 'summaryOnly', value: 'true' }] }, options: RAW },
  credentials: XERO }, output: [{ statusCode: 200, body: {} }] });

const account = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Sales Account 200',
  parameters: { method: 'GET', url: API + '/Accounts', authentication: 'predefinedCredentialType', nodeCredentialType: 'xeroOAuth2Api', sendHeaders: true, headerParameters: HDR,
    sendQuery: true, queryParameters: { parameters: [{ name: 'where', value: 'Code=="200"' }] }, options: RAW },
  credentials: XERO }, output: [{ statusCode: 200, body: {} }] });

const summary = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Summarise (No Secrets)',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const t = $('Pick Demo Tenant').first().json;
const o = $('Read Organisation').first().json;
const c = $('Read Some Contacts').first().json;
const i = $('Read Some Invoices').first().json;
const a = $input.first().json;
const org = ((o.body || {}).Organisations || [])[0] || {};
const acc = ((a.body || {}).Accounts || [])[0] || {};
return [{ json: {
  tenant_id: t.tenant_id, tenant_name: t.tenant_name, connections: t.connections,
  organisation: { status: o.statusCode, name: org.Name, class: org.Class, edition: org.Edition, country: org.CountryCode, currency: org.BaseCurrency, is_demo: org.Class === 'DEMO', organisation_id: org.OrganisationID },
  contacts: { status: c.statusCode, sample: ((c.body || {}).Contacts || []).map(function (x) { return x.Name + ' | ' + x.ContactID; }), error: c.statusCode === 200 ? null : JSON.stringify(c.body).slice(0, 200) },
  invoices: { status: i.statusCode, sample: ((i.body || {}).Invoices || []).map(function (x) { return (x.InvoiceNumber || '(no number)') + ' | ' + x.Status + ' | ' + x.Total + ' | ' + (x.Contact || {}).Name; }), error: i.statusCode === 200 ? null : JSON.stringify(i.body).slice(0, 200) },
  sales_account: { status: a.statusCode, code: acc.Code, name: acc.Name, tax_type: acc.TaxType, type: acc.Type, error: a.statusCode === 200 ? null : JSON.stringify(a.body).slice(0, 200) },
} }];` } }, output: [{ tenant_id: 't' }] });

export default workflow('roofops-xero-read-only-check', '[RoofOps] 96 Xero Read-Only Check')
  .add(start).to(connections).to(pick).to(org).to(isDemo.onTrue(contacts.to(invoices).to(account).to(summary)).onFalse(notDemo));
