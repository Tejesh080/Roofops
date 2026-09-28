import { workflow, node, trigger, ifElse, switchCase, expr } from '@n8n/workflow-sdk';

const DRIVE = { googleDriveOAuth2Api: { id: 'o7IjcWsTr1ZUy9wU', name: 'RoofOps Google Drive' } };
const RAW = { response: { response: { fullResponse: true, neverError: true } }, timeout: 20000 };
const FILES = 'https://www.googleapis.com/drive/v3/files';

const manual = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run Setup Now' }, output: [{}] });
const daily = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1.3, config: { name: 'Daily 03:15',
  parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 3, triggerAtMinute: 15 }] } } }, output: [{}] });

const findRoot = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Find Drive Root (Including Trash)',
  parameters: { method: 'GET', url: FILES, authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendQuery: true, queryParameters: { parameters: [
      { name: 'q', value: "appProperties has { key='roofops_role' and value='root' } and mimeType='application/vnd.google-apps.folder'" },
      { name: 'fields', value: 'files(id,name,trashed,createdTime,webViewLink)' }, { name: 'spaces', value: 'drive' }] },
    options: RAW }, credentials: DRIVE }, output: [{ statusCode: 200, body: { files: [] } }] });

const decideRoot = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Decide Drive Root Action',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const r = $input.first().json;
if (r.statusCode !== 200) throw new Error('Drive search failed: HTTP ' + r.statusCode + ' ' + JSON.stringify(r.body).slice(0, 300));
const all = r.body.files || [];
const live = all.filter(function (f) { return !f.trashed; });
if (live.length > 1) return [{ json: { action: 'CONFLICT', detail: live.length + ' live RoofOps roots: ' + live.map(function (f) { return f.id; }).join(', ') } }];
if (live.length === 1) return [{ json: { action: 'OK', root_id: live[0].id, web_view_link: live[0].webViewLink } }];
// Never auto-create a second root while the real one is only in the trash: restore it instead.
if (all.length > 0) return [{ json: { action: 'IN_TRASH', detail: 'Root ' + all[0].id + ' is in the trash; restore it in Google Drive' } }];
return [{ json: { action: 'CREATE' } }];` } }, output: [{ action: 'CREATE' }] });

const needCreate = ifElse({ version: 2.3, config: { name: 'Create Root?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
  conditions: [{ leftValue: expr('{{ $json.action }}'), rightValue: 'CREATE', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } } } });

const createRoot = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Create Drive Root',
  parameters: { method: 'POST', url: FILES + '?fields=id', authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: '{"name":"RoofOps Demo","mimeType":"application/vnd.google-apps.folder","appProperties":{"roofops_role":"root"},"description":"SYNTHETIC DEMO DATA. Created by RoofOps n8n setup; project folders are created by [RoofOps] 02."}',
    options: RAW }, credentials: DRIVE }, output: [{ statusCode: 200, body: { id: 'root' } }] });

const readRoot = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Back Drive Root',
  parameters: { method: 'GET', url: expr(FILES + '/{{ $json.body.id }}'), authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendQuery: true, queryParameters: { parameters: [{ name: 'fields', value: 'id,name,mimeType,trashed,webViewLink,appProperties' }] },
    options: RAW }, credentials: DRIVE }, output: [{ statusCode: 200, body: { id: 'root' } }] });

const verifyRoot = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Verify Drive Root',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const r = $input.first().json;
const b = r.body || {};
const ok = r.statusCode === 200 && b.name === 'RoofOps Demo' && b.mimeType === 'application/vnd.google-apps.folder' && !b.trashed && (b.appProperties || {}).roofops_role === 'root';
if (!ok) throw new Error('Drive root read-back failed: ' + JSON.stringify(b).slice(0, 300));
return [{ json: { action: 'CREATED', verified: true, root_id: b.id, web_view_link: b.webViewLink } }];` } }, output: [{ verified: true }] });

export default workflow('roofops-setup', '[RoofOps] 00 Setup & Maintenance')
  .add(manual).to(findRoot)
  .add(daily).to(findRoot)
  .add(findRoot).to(decideRoot).to(needCreate.onTrue(createRoot.to(readRoot).to(verifyRoot)));
