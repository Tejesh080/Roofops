import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const PG = { postgres: { id: 'kWqjtv0gz7ref2EN', name: 'RoofOps Postgres' } };
const DRIVE = { googleDriveOAuth2Api: { id: 'o7IjcWsTr1ZUy9wU', name: 'RoofOps Google Drive' } };
const XERO = { xeroOAuth2Api: { id: 'rjqe50LhcU1IRLBc', name: 'RoofOps Xero' } };
const DEEPSEEK = { deepSeekApi: { id: 'jv3W4NvaBlk9SJgb', name: 'Roofops deepseek api key which i kept in .env aswell' } };
const RAW = { response: { response: { fullResponse: true, neverError: true } }, timeout: 15000 };

// Synthetic monitoring: safe READS only (never creates anything). Airtable is not called here (Free plan quota);
// its health comes from the nightly reconciliation, which reads every table.
const every30 = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1.3, config: { name: 'Every 30 Minutes',
  parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 30 }] } } }, output: [{}] });

const drive = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Drive: Find RoofOps Root',
  parameters: { method: 'GET', url: 'https://www.googleapis.com/drive/v3/files', authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendQuery: true, queryParameters: { parameters: [
      { name: 'q', value: "appProperties has { key='roofops_role' and value='root' } and mimeType='application/vnd.google-apps.folder' and trashed=false" },
      { name: 'fields', value: 'files(id)' }] }, options: RAW }, credentials: DRIVE }, output: [{ statusCode: 200, body: { files: [{ id: 'root' }] } }] });

const xero = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Xero: List Connections', executeOnce: true,
  parameters: { method: 'GET', url: 'https://api.xero.com/connections', authentication: 'predefinedCredentialType', nodeCredentialType: 'xeroOAuth2Api', options: RAW },
  credentials: XERO }, output: [{ statusCode: 200, body: [] }] });

const deepseek = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'DeepSeek: List Models', executeOnce: true,
  parameters: { method: 'GET', url: 'https://api.deepseek.com/models', authentication: 'predefinedCredentialType', nodeCredentialType: 'deepSeekApi', options: RAW },
  credentials: DEEPSEEK }, output: [{ statusCode: 200, body: { data: [] } }] });

const record = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Record Health In Postgres', executeOnce: true,
  parameters: { operation: 'executeQuery', query: 'select wf_record_health($1::jsonb) as r',
    options: { queryReplacement: expr("{{ (() => { const d = $('Drive: Find RoofOps Root').first().json; const x = $('Xero: List Connections').first().json; " +
      "const s = $('DeepSeek: List Models').first().json; const roots = ((d.body || {}).files || []).length; " +
      "const tenants = Array.isArray(x.body) ? x.body.map(c => c.tenantId) : []; " +
      "return [ JSON.stringify([ " +
      "{ service: 'google_drive', ok: d.statusCode === 200 && roots === 1, detail: { http: d.statusCode, roofops_roots: roots } }, " +
      "{ service: 'xero', ok: x.statusCode === 200, detail: { http: x.statusCode, connections: tenants.length, tenant_ids: tenants } }, " +
      "{ service: 'deepseek', ok: s.statusCode === 200, detail: { http: s.statusCode } }, " +
      "{ service: 'n8n', ok: true, detail: { check: '[RoofOps] 08 ran' } } ]) ]; })() }}") } },
  credentials: PG }, output: [{ r: { recorded: 5 } }] });

export default workflow('roofops-health', '[RoofOps] 08 Health Checks')
  .add(every30).to(drive).to(xero).to(deepseek).to(record);
