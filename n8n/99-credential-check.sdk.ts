import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const AIRTABLE = { airtableApi: { id: '9oxseGuocpt3UtcB', name: 'Roofops Airtable account' } };
const DRIVE = { googleDriveOAuth2Api: { id: 'o7IjcWsTr1ZUy9wU', name: 'RoofOps Google Drive' } };
const PG = { postgres: { id: 'kWqjtv0gz7ref2EN', name: 'RoofOps Postgres' } };
const DEEPSEEK = { deepSeekApi: { id: 'jv3W4NvaBlk9SJgb', name: 'Roofops deepseek api key which i kept in .env aswell' } };
const RESP = { response: { response: { fullResponse: true, neverError: true } } };

const start = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run Credential Check' }, output: [{}] });

const atSchema = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Airtable Read Base Schema',
  parameters: { method: 'GET', url: 'https://api.airtable.com/v0/meta/bases/appMc8V0Wm29tEeHQ/tables', authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableApi', options: RESP },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { tables: [] } }] });
const atQuote = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Airtable Read Quote Q-2026-0041',
  parameters: { method: 'GET', url: 'https://api.airtable.com/v0/appMc8V0Wm29tEeHQ/tblzenPRNVV5O7lZP/rec4MMzrBxFdppyVd?returnFieldsByFieldId=true', authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableApi', options: RESP },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { id: 'rec', fields: {} } }] });
const atHooks = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Airtable List Webhooks',
  parameters: { method: 'GET', url: 'https://api.airtable.com/v0/bases/appMc8V0Wm29tEeHQ/webhooks', authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableApi', options: RESP },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { webhooks: [] } }] });

const pgCheck = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Postgres Call Allowed Entry Point',
  parameters: { operation: 'executeQuery', query: "select current_user as login_role, wf_claim_side_effect('credential-check:no-such-key', 'n8n-credential-check', 1) as claim_result" },
  credentials: PG }, output: [{ login_role: 'roofops_n8n', claim_result: {} }] });
const pgDenied = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Postgres Table Read Must Be Denied', onError: 'continueRegularOutput',
  parameters: { operation: 'executeQuery', query: 'select count(*) from projects' },
  credentials: PG }, output: [{ error: 'permission denied' }] });

const drvAbout = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Drive About',
  parameters: { method: 'GET', url: 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)', authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api', options: RESP },
  credentials: DRIVE }, output: [{ statusCode: 200, body: {} }] });
const drvCreate = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Drive Create Temp Folder',
  parameters: { method: 'POST', url: 'https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,trashed,webViewLink,appProperties', authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: expr('{{ JSON.stringify({ name: "RoofOps credential check " + $now.toISO(), mimeType: "application/vnd.google-apps.folder", appProperties: { roofops_kind: "credential_check", roofops_nonce: $execution.id } }) }}'),
    options: RESP }, credentials: DRIVE }, output: [{ statusCode: 200, body: { id: 'x' } }] });
const drvGet = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Drive Read Back Temp Folder',
  parameters: { method: 'GET', url: expr('https://www.googleapis.com/drive/v3/files/{{ $json.body.id }}?fields=id,name,mimeType,trashed,webViewLink,appProperties'), authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api', options: RESP },
  credentials: DRIVE }, output: [{ statusCode: 200, body: { id: 'x' } }] });
const drvTrash = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Drive Trash Temp Folder',
  parameters: { method: 'PATCH', url: expr('https://www.googleapis.com/drive/v3/files/{{ $json.body.id }}?fields=id,trashed'), authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '{"trashed": true}', options: RESP }, credentials: DRIVE }, output: [{ statusCode: 200, body: { id: 'x', trashed: true } }] });

const dsModels = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'DeepSeek List Models',
  parameters: { method: 'GET', url: 'https://api.deepseek.com/models', authentication: 'predefinedCredentialType', nodeCredentialType: 'deepSeekApi', options: RESP },
  credentials: DEEPSEEK }, output: [{ statusCode: 200, body: { data: [] } }] });

export default workflow('roofops-credential-check', '[RoofOps] 99 Credential Check')
  .add(start).to(atSchema).to(atQuote).to(atHooks)
  .add(start).to(pgCheck).to(pgDenied)
  .add(start).to(drvAbout).to(drvCreate).to(drvGet).to(drvTrash)
  .add(start).to(dsModels);
