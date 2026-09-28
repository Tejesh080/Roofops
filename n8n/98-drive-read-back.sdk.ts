import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

// Read-only Drive inventory used by the Phase 2 tests to count folders independently of the workflow that created them.
const DRIVE = { googleDriveOAuth2Api: { id: 'o7IjcWsTr1ZUy9wU', name: 'RoofOps Google Drive' } };
const FILES = 'https://www.googleapis.com/drive/v3/files';

const start = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run Read-Back' }, output: [{}] });

const listProjects = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'List RoofOps Folders',
  parameters: { method: 'GET', url: FILES, authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendQuery: true, queryParameters: { parameters: [
      { name: 'q', value: "mimeType='application/vnd.google-apps.folder' and trashed=false and (appProperties has { key='roofops_kind' and value='project' } or appProperties has { key='roofops_role' and value='root' })" },
      { name: 'fields', value: 'files(id,name,parents,trashed,createdTime,webViewLink,appProperties)' }, { name: 'spaces', value: 'drive' }, { name: 'pageSize', value: '100' }] },
    options: { timeout: 20000 } }, credentials: DRIVE }, output: [{ files: [] }] });

const split = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'One Item Per Project Folder',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const files = $input.first().json.files || [];
const projects = files.filter(function (f) { return (f.appProperties || {}).roofops_kind === 'project'; });
if (projects.length === 0) return [{ json: { id: null, none: true } }];
return projects.map(function (f) { return { json: f }; });` } }, output: [{ id: 'fid' }] });

const listChildren = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'List Subfolders',
  parameters: { method: 'GET', url: FILES, authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendQuery: true, queryParameters: { parameters: [
      { name: 'q', value: expr("'{{ $json.id || 'none' }}' in parents and trashed=false") },
      { name: 'fields', value: 'files(id,name,mimeType,parents)' }, { name: 'pageSize', value: '100' }] },
    options: { timeout: 20000 } }, credentials: DRIVE }, output: [{ files: [] }] });

const summary = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Summarise Drive State',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const all = $('List RoofOps Folders').first().json.files || [];
const roots = all.filter(function (f) { return (f.appProperties || {}).roofops_role === 'root'; });
const projects = $('One Item Per Project Folder').all().map(function (i) { return i.json; }).filter(function (p) { return p.id; });
const children = $input.all().map(function (i) { return i.json.files || []; });
const byProject = {};
projects.forEach(function (p, i) {
  const key = (p.appProperties || {}).roofops_project_number || p.id;
  byProject[key] = byProject[key] || [];
  byProject[key].push({ folder_id: p.id, name: p.name, parent_is_root: roots.length === 1 && (p.parents || []).includes(roots[0].id), created: p.createdTime,
    subfolders: (children[i] || []).map(function (c) { return c.name + '=' + c.id; }).sort() });
});
return [{ json: { live_roots: roots.map(function (r) { return r.id; }), live_project_folders: projects.length, projects: byProject, read_at: new Date().toISOString() } }];` } },
  output: [{ live_project_folders: 1 }] });

export default workflow('roofops-drive-read-back', '[RoofOps] 98 Drive Read-Back')
  .add(start).to(listProjects).to(split).to(listChildren).to(summary);
