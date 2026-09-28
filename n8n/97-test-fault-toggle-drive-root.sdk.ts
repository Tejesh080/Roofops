import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

// TEST ONLY. Manual trigger, never published (no public URL). Moves the RoofOps Demo Drive root to trash if it is
// live, or restores it if it is trashed, then reads the new state back. Produces a real, reversible Drive outage
// for the transient-failure tests without touching any credential.
const DRIVE = { googleDriveOAuth2Api: { id: 'o7IjcWsTr1ZUy9wU', name: 'RoofOps Google Drive' } };
const FILES = 'https://www.googleapis.com/drive/v3/files';

const start = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Toggle Now' }, output: [{}] });

const find = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Find Root (Including Trash)',
  parameters: { method: 'GET', url: FILES, authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendQuery: true, queryParameters: { parameters: [
      { name: 'q', value: "appProperties has { key='roofops_role' and value='root' } and mimeType='application/vnd.google-apps.folder'" },
      { name: 'fields', value: 'files(id,name,trashed)' }] }, options: { timeout: 20000 } }, credentials: DRIVE }, output: [{ files: [] }] });

const decide = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Decide Toggle',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const files = $input.first().json.files || [];
if (files.length !== 1) throw new Error('expected exactly one RoofOps root, found ' + files.length);
return [{ json: { id: files[0].id, from_trashed: files[0].trashed, to_trashed: !files[0].trashed } }];` } }, output: [{ id: 'root', to_trashed: true }] });

const toggle = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Set Root Trash State',
  parameters: { method: 'PATCH', url: expr(FILES + '/{{ $json.id }}?fields=id,name,trashed'), authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: expr('{{ JSON.stringify({ trashed: $json.to_trashed }) }}'), options: { timeout: 20000 } },
  credentials: DRIVE }, output: [{ id: 'root', trashed: true }] });

const readBack = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Back Root',
  parameters: { method: 'GET', url: expr(FILES + "/{{ $('Decide Toggle').first().json.id }}?fields=id,name,trashed,modifiedTime"), authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    options: { timeout: 20000 } }, credentials: DRIVE }, output: [{ id: 'root', trashed: true }] });

const verify = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Verify Toggle',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const want = $('Decide Toggle').first().json.to_trashed;
const got = $input.first().json;
if (got.trashed !== want) throw new Error('root trashed=' + got.trashed + ', expected ' + want);
return [{ json: { verified: true, root_id: got.id, trashed: got.trashed, at: new Date().toISOString() } }];` } }, output: [{ verified: true }] });

export default workflow('roofops-fault-toggle-drive-root', '[RoofOps] 97 TEST Fault: Toggle Drive Root')
  .add(start).to(find).to(decide).to(toggle).to(readBack).to(verify);
