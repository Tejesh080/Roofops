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

// --- Airtable webhook: create once, refresh daily (Airtable expires webhooks after 7 days), always read back ---
const AIRTABLE = { airtableTokenApi: { id: '3XbFnHjAd7mFvBD2', name: 'Roofops Airtable Personal Access Token account' } };
const HOOKS = 'https://api.airtable.com/v0/bases/appMc8V0Wm29tEeHQ/webhooks';
const NOTIFY = 'https://tejesh08.app.n8n.cloud/webhook/roofops/airtable/quote-events';

const listHooks = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'List Airtable Webhooks',
  parameters: { method: 'GET', url: HOOKS, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi', options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { webhooks: [] } }] });

const decideHook = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Decide Webhook Action',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const NOTIFY = 'https://tejesh08.app.n8n.cloud/webhook/roofops/airtable/quote-events';
const r = $input.first().json;
if (r.statusCode !== 200) throw new Error('Airtable webhook list failed: HTTP ' + r.statusCode + ' ' + JSON.stringify(r.body).slice(0, 300));
const ours = (r.body.webhooks || []).filter(function (w) { return w.notificationUrl === NOTIFY; });
if (ours.length > 1) throw new Error(ours.length + ' Airtable webhooks point at ' + NOTIFY + '; delete the extras before continuing');
return [{ json: { exists: ours.length === 1, webhook_id: ours.length ? ours[0].id : null, notify: NOTIFY } }];` } }, output: [{ exists: false }] });

const hookExists = ifElse({ version: 2.3, config: { name: 'Webhook Exists?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.exists }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

const refreshHook = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Refresh Airtable Webhook',
  parameters: { method: 'POST', url: expr(HOOKS + '/{{ $json.webhook_id }}/refresh'), authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi', options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200 }] });

// Watches ONLY Quotes.Status (so the workflow's own Automation Status writes never re-trigger it) and ships the
// cell values the event needs: Quote Number, Status (+ previous), Version, RoofOps ID, Accepted On.
const createHook = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Create Airtable Webhook',
  parameters: { method: 'POST', url: HOOKS, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: JSON.stringify({ notificationUrl: NOTIFY, specification: { options: {
      filters: { dataTypes: ['tableData'], recordChangeScope: 'tblzenPRNVV5O7lZP', watchDataInFieldIds: ['fldQpTa5tvrzlNg1h'], changeTypes: ['update'] },
      includes: { includeCellValuesInFieldIds: ['fldyP20HNafS614d5', 'fldQpTa5tvrzlNg1h', 'fldEjEqlzE8Y0M1nf', 'fldVUpqZkVKid3Fyy', 'fldfhsHggkGd8GKVq'], includePreviousCellValues: true } } } }),
    options: RAW }, credentials: AIRTABLE }, output: [{ statusCode: 200 }] });

const readHooks = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Back Airtable Webhooks',
  parameters: { method: 'GET', url: HOOKS, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi', options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { webhooks: [] } }] });

const verifyHook = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Verify Airtable Webhook',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const NOTIFY = 'https://tejesh08.app.n8n.cloud/webhook/roofops/airtable/quote-events';
const prior = $('Decide Webhook Action').first().json;
const change = prior.exists ? $('Refresh Airtable Webhook').first().json : $('Create Airtable Webhook').first().json;
if (change.statusCode !== 200) throw new Error((prior.exists ? 'refresh' : 'create') + ' failed: HTTP ' + change.statusCode + ' ' + JSON.stringify(change.body.error || change.body).slice(0, 300));
const r = $input.first().json;
if (r.statusCode !== 200) throw new Error('webhook read-back failed: HTTP ' + r.statusCode);
const ours = (r.body.webhooks || []).filter(function (w) { return w.notificationUrl === NOTIFY; });
if (ours.length !== 1) throw new Error('expected exactly 1 webhook for ' + NOTIFY + ', found ' + ours.length);
const w = ours[0];
const f = ((w.specification || {}).options || {}).filters || {};
const problems = [];
if (!w.isHookEnabled) problems.push('hook is disabled');
if (!w.expirationTime || new Date(w.expirationTime) <= new Date()) problems.push('hook is expired');
if (f.recordChangeScope !== 'tblzenPRNVV5O7lZP') problems.push('scope is not the Quotes table');
if (JSON.stringify(f.watchDataInFieldIds || []) !== JSON.stringify(['fldQpTa5tvrzlNg1h'])) problems.push('does not watch Status only');
if (problems.length) throw new Error('Airtable webhook ' + w.id + ': ' + problems.join('; '));
return [{ json: { verified: true, action: prior.exists ? 'REFRESHED' : 'CREATED', webhook_id: w.id, expires: w.expirationTime, enabled: w.isHookEnabled, cursor_for_next_payload: w.cursorForNextPayload, notification_url: w.notificationUrl } }];` } },
  output: [{ verified: true }] });

// --- Second webhook (Phase 3): Projects.Invoice Action -> [RoofOps] 04 ---
const NOTIFY_INVOICE = 'https://tejesh08.app.n8n.cloud/webhook/roofops/airtable/project-invoice-events';
const listInvoiceHooks = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'List Airtable Webhooks (Invoice)',
  parameters: { method: 'GET', url: HOOKS, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi', options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { webhooks: [] } }] });
const decideInvoiceHook = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Decide Invoice Webhook Action',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const NOTIFY = 'https://tejesh08.app.n8n.cloud/webhook/roofops/airtable/project-invoice-events';
const r = $input.first().json;
if (r.statusCode !== 200) throw new Error('Airtable webhook list failed: HTTP ' + r.statusCode + ' ' + JSON.stringify(r.body).slice(0, 300));
const ours = (r.body.webhooks || []).filter(function (w) { return w.notificationUrl === NOTIFY; });
if (ours.length > 1) throw new Error(ours.length + ' Airtable webhooks point at ' + NOTIFY + '; delete the extras before continuing');
return [{ json: { exists: ours.length === 1, webhook_id: ours.length ? ours[0].id : null, notify: NOTIFY } }];` } }, output: [{ exists: false }] });
const invoiceHookExists = ifElse({ version: 2.3, config: { name: 'Invoice Webhook Exists?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.exists }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });
const refreshInvoiceHook = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Refresh Invoice Webhook',
  parameters: { method: 'POST', url: expr(HOOKS + '/{{ $json.webhook_id }}/refresh'), authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi', options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200 }] });
// Watches ONLY Projects.Invoice Action (the workflow's own status writes never re-trigger it).
const createInvoiceHook = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Create Invoice Webhook',
  parameters: { method: 'POST', url: HOOKS, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: JSON.stringify({ notificationUrl: NOTIFY_INVOICE, specification: { options: {
      filters: { dataTypes: ['tableData'], recordChangeScope: 'tblvUPIoebC3zoacv', watchDataInFieldIds: ['fldYnINTdtOckOzK4'], changeTypes: ['update'] },
      includes: { includeCellValuesInFieldIds: ['fldhhnQXlbuFaveK3', 'fldc4T0AgU3zCmANC', 'fldYnINTdtOckOzK4'], includePreviousCellValues: true } } } }),
    options: RAW }, credentials: AIRTABLE }, output: [{ statusCode: 200 }] });
const readInvoiceHooks = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Back Invoice Webhook',
  parameters: { method: 'GET', url: HOOKS, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi', options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { webhooks: [] } }] });
const verifyInvoiceHook = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Verify Invoice Webhook',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const NOTIFY = 'https://tejesh08.app.n8n.cloud/webhook/roofops/airtable/project-invoice-events';
const prior = $('Decide Invoice Webhook Action').first().json;
const change = prior.exists ? $('Refresh Invoice Webhook').first().json : $('Create Invoice Webhook').first().json;
if (change.statusCode !== 200) throw new Error((prior.exists ? 'refresh' : 'create') + ' failed: HTTP ' + change.statusCode + ' ' + JSON.stringify(change.body.error || change.body).slice(0, 300));
const r = $input.first().json;
if (r.statusCode !== 200) throw new Error('webhook read-back failed: HTTP ' + r.statusCode);
const ours = (r.body.webhooks || []).filter(function (w) { return w.notificationUrl === NOTIFY; });
if (ours.length !== 1) throw new Error('expected exactly 1 webhook for ' + NOTIFY + ', found ' + ours.length);
const w = ours[0];
const f = ((w.specification || {}).options || {}).filters || {};
const problems = [];
if (!w.isHookEnabled) problems.push('hook is disabled');
if (!w.expirationTime || new Date(w.expirationTime) <= new Date()) problems.push('hook is expired');
if (f.recordChangeScope !== 'tblvUPIoebC3zoacv') problems.push('scope is not the Projects table');
if (JSON.stringify(f.watchDataInFieldIds || []) !== JSON.stringify(['fldYnINTdtOckOzK4'])) problems.push('does not watch Invoice Action only');
if (problems.length) throw new Error('Airtable webhook ' + w.id + ': ' + problems.join('; '));
return [{ json: { verified: true, action: prior.exists ? 'REFRESHED' : 'CREATED', webhook_id: w.id, expires: w.expirationTime, enabled: w.isHookEnabled, notification_url: w.notificationUrl } }];` } },
  output: [{ verified: true }] });

export default workflow('roofops-setup', '[RoofOps] 00 Setup & Maintenance')
  .add(manual).to(findRoot)
  .add(daily).to(findRoot)
  .add(findRoot).to(decideRoot).to(needCreate.onTrue(createRoot.to(readRoot).to(verifyRoot)))
  .add(manual).to(listHooks)
  .add(daily).to(listHooks)
  .add(listHooks).to(decideHook).to(hookExists.onTrue(refreshHook.to(readHooks)).onFalse(createHook.to(readHooks)))
  .add(readHooks).to(verifyHook)
  .add(manual).to(listInvoiceHooks)
  .add(daily).to(listInvoiceHooks)
  .add(listInvoiceHooks).to(decideInvoiceHook).to(invoiceHookExists.onTrue(refreshInvoiceHook.to(readInvoiceHooks)).onFalse(createInvoiceHook.to(readInvoiceHooks)))
  .add(readInvoiceHooks).to(verifyInvoiceHook);
