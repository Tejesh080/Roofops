import { workflow, node, trigger, ifElse, switchCase, expr } from '@n8n/workflow-sdk';

const DRIVE = { googleDriveOAuth2Api: { id: 'o7IjcWsTr1ZUy9wU', name: 'RoofOps Google Drive' } };
const PG = { postgres: { id: 'kWqjtv0gz7ref2EN', name: 'RoofOps Postgres' } };
const RAW = { response: { response: { fullResponse: true, neverError: true } }, timeout: 20000 };
const API = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_FIELDS = 'id,name,mimeType,parents,trashed,webViewLink,appProperties';

const FAIL_JS = `
function fail(step, r) {
  const s = r.statusCode;
  const body = r.body || {};
  const e = body.error || r.error || {};
  const msg = (typeof e === 'string' ? e : (e.message || e.type || e.description)) || r.message || ('HTTP ' + s);
  let cls = 'UNKNOWN'; let retryAfter = null;
  if (!s) cls = /time ?out|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED/i.test(String(msg)) ? 'TIMEOUT' : 'NETWORK';
  else if (s === 429) { cls = 'RATE_LIMITED'; retryAfter = parseInt((r.headers || {})['retry-after'], 10) || null; }
  else if (s === 401) cls = 'AUTH_FAILURE';
  else if (s === 403) cls = /rate ?limit/i.test(JSON.stringify(body)) ? 'RATE_LIMITED' : 'PERMISSION_DENIED';
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
const FOLDER = 'application/vnd.google-apps.folder';
const input = $('When Called By Main Workflow').first().json;
const claim = $('Claim Drive Side Effect').first().json.c;
const job = claim.payload || {};
`;

const OK_IF = { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.ok }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } };

const start = trigger({ type: 'n8n-nodes-base.executeWorkflowTrigger', version: 1.2,
  config: { name: 'When Called By Main Workflow', parameters: { inputSource: 'passthrough' } },
  output: [{ drive_key: 'drive:project-folder:uuid', project_id: 'uuid', project_number: 'PRJ-2026-0031' }] });

const claim = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Claim Drive Side Effect',
  parameters: { operation: 'executeQuery', query: 'select wf_claim_side_effect($1, $2, 180) as c',
    options: { queryReplacement: expr("{{ [ $('When Called By Main Workflow').first().json.drive_key, 'n8n:' + $execution.id ] }}") } },
  credentials: PG }, output: [{ c: { claimed: true, attempt: 1, payload: { project_id: 'uuid', folder_name: 'PRJ - x', subfolders: [] } } }] });

const claimRoute = switchCase({ version: 3.4, config: { name: 'Claimed?',
  parameters: { mode: 'expression', numberOutputs: 3, output: expr("{{ $json.c.claimed ? 0 : ($json.c.status === 'DONE' ? 1 : 2) }}") } } });

const alreadyDone = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Drive Already Done',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const input = $('When Called By Main Workflow').first().json;
const c = $input.first().json.c;
return [{ json: Object.assign({}, input, { drive: { status: 'DONE', already_done: true, folder_id: c.result.folder_id, web_view_link: c.result.web_view_link } }) }];` } },
  output: [{ drive: { status: 'DONE' } }] });

const notClaimed = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Drive Not Claimed',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const input = $('When Called By Main Workflow').first().json;
const c = $input.first().json.c;
const dead = c.status === 'FAILED' && String(c.retry_at || '').startsWith('infinity');
return [{ json: Object.assign({}, input, { drive: { status: dead ? 'FAILED' : 'NOT_CLAIMED', claim: c, message: dead ? 'Dead-lettered after ' + c.attempts + ' attempts: ' + c.last_error : 'Held by another worker or waiting for its retry window (' + c.status + ')' } }) }];` } },
  output: [{ drive: { status: 'NOT_CLAIMED' } }] });

const findRoot = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Find Root Folder', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: API, authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendQuery: true, queryParameters: { parameters: [
      { name: 'q', value: "appProperties has { key='roofops_role' and value='root' } and mimeType='application/vnd.google-apps.folder' and trashed=false" },
      { name: 'fields', value: 'files(id,name,parents,trashed)' }, { name: 'spaces', value: 'drive' }, { name: 'pageSize', value: '10' }] },
    options: RAW }, credentials: DRIVE }, output: [{ statusCode: 200, body: { files: [{ id: 'root' }] } }] });

const checkRoot = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Check Root Folder',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const r = $input.first().json;
if (r.statusCode !== 200) return [{ json: fail('find root folder', r) }];
const files = r.body.files || [];
if (files.length === 0) return [{ json: refuse('find root folder', 'SERVICE_UNAVAILABLE', 'Drive root "' + job.root_folder_name + '" is not available (missing or in trash). Restore it or run [RoofOps] 00 Setup.') }];
if (files.length > 1) return [{ json: refuse('find root folder', 'RECONCILIATION_MISMATCH', files.length + ' live folders are tagged as the RoofOps root; refusing to guess') }];
return [{ json: { ok: true, root_id: files[0].id } }];` } },
  output: [{ ok: true, root_id: 'root' }] });
const rootOk = ifElse({ version: 2.3, config: { name: 'Root OK?', parameters: OK_IF } });

const findProject = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Find Project Folder', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: API, authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendQuery: true, queryParameters: { parameters: [
      { name: 'q', value: expr("appProperties has { key='roofops_project_id' and value='{{ $('Claim Drive Side Effect').first().json.c.payload.project_id }}' } and trashed=false") },
      { name: 'fields', value: 'files(id,name,mimeType,parents,trashed)' }, { name: 'spaces', value: 'drive' }, { name: 'pageSize', value: '10' }] },
    options: RAW }, credentials: DRIVE }, output: [{ statusCode: 200, body: { files: [] } }] });

const checkProject = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Check Project Folder Search',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const r = $input.first().json;
const root = $('Check Root Folder').first().json.root_id;
if (r.statusCode !== 200) return [{ json: fail('find project folder', r) }];
const files = (r.body.files || []).filter(function (f) { return f.mimeType === FOLDER; });
if (files.length > 1) return [{ json: refuse('find project folder', 'RECONCILIATION_MISMATCH', files.length + ' live folders are tagged with project ' + job.project_id + '; refusing to pick one') }];
if (files.length === 1) return [{ json: { ok: true, found: true, folder_id: files[0].id, root_id: root } }];
return [{ json: { ok: true, found: false, root_id: root } }];` } },
  output: [{ ok: true, found: false, root_id: 'root' }] });
const searchOk = ifElse({ version: 2.3, config: { name: 'Search OK?', parameters: OK_IF } });
const exists = ifElse({ version: 2.3, config: { name: 'Folder Already Exists?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.found }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

const createProject = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Create Project Folder', onError: 'continueRegularOutput',
  parameters: { method: 'POST', url: API + '?fields=id,name', authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: expr("{{ JSON.stringify({ name: $('Claim Drive Side Effect').first().json.c.payload.folder_name, mimeType: 'application/vnd.google-apps.folder', parents: [ $json.root_id ], appProperties: { roofops_project_id: $('Claim Drive Side Effect').first().json.c.payload.project_id, roofops_project_number: $('Claim Drive Side Effect').first().json.c.payload.project_number, roofops_kind: 'project' } }) }}"),
    options: RAW }, credentials: DRIVE }, output: [{ statusCode: 200, body: { id: 'fid' } }] });

const checkCreate = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Check Folder Create',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const r = $input.first().json;
if (r.statusCode !== 200 || !r.body || !r.body.id) return [{ json: fail('create project folder', r) }];
return [{ json: { ok: true, found: false, created: true, folder_id: r.body.id, root_id: $('Check Root Folder').first().json.root_id } }];` } },
  output: [{ ok: true, folder_id: 'fid' }] });
const createOk = ifElse({ version: 2.3, config: { name: 'Create OK?', parameters: OK_IF } });

const listSubs = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'List Project Subfolders', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: API, authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendQuery: true, queryParameters: { parameters: [
      { name: 'q', value: expr("'{{ $json.folder_id }}' in parents and trashed=false") },
      { name: 'fields', value: 'files(id,name,mimeType,parents,trashed)' }, { name: 'pageSize', value: '100' }] },
    options: RAW }, credentials: DRIVE }, output: [{ statusCode: 200, body: { files: [] } }] });

const planSubs = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Plan Missing Subfolders',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const r = $input.first().json;
const search = $('Check Project Folder Search').first().json;
const fid = search.found ? search.folder_id : $('Check Folder Create').first().json.folder_id;
if (r.statusCode !== 200) return [{ json: fail('list subfolders', r) }];
const live = (r.body.files || []).filter(function (f) { return f.mimeType === FOLDER && !f.trashed; });
const want = job.subfolders || [];
for (const n of want) {
  if (live.filter(function (f) { return f.name === n; }).length > 1) return [{ json: refuse('list subfolders', 'RECONCILIATION_MISMATCH', 'more than one "' + n + '" subfolder; refusing to pick one') }];
}
const missing = want.filter(function (n) { return !live.some(function (f) { return f.name === n; }); });
return [{ json: { ok: true, folder_id: fid, root_id: search.root_id, missing: missing, existing: live.length } }];` } },
  output: [{ ok: true, folder_id: 'fid', missing: [] }] });
const planOk = ifElse({ version: 2.3, config: { name: 'Listing OK?', parameters: OK_IF } });
const anyMissing = ifElse({ version: 2.3, config: { name: 'Any Subfolders Missing?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.missing }}'), rightValue: '', operator: { type: 'array', operation: 'notEmpty', singleValue: true } }], combinator: 'and' } } } });

const splitMissing = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'One Item Per Missing Subfolder',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const p = $input.first().json;
return p.missing.map(function (n) { return { json: { name: n, folder_id: p.folder_id } }; });` } },
  output: [{ name: '01 Quote', folder_id: 'fid' }] });

const createSub = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Create Subfolder', onError: 'continueRegularOutput',
  parameters: { method: 'POST', url: API + '?fields=id,name', authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: expr("{{ JSON.stringify({ name: $json.name, mimeType: 'application/vnd.google-apps.folder', parents: [ $json.folder_id ], appProperties: { roofops_project_id: $('Claim Drive Side Effect').first().json.c.payload.project_id, roofops_subfolder: $json.name } }) }}"),
    options: RAW }, credentials: DRIVE }, output: [{ statusCode: 200, body: { id: 'sub' } }] });

const checkSubs = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Check Subfolder Creates',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
for (const it of $input.all()) {
  if (it.json.statusCode !== 200 || !it.json.body || !it.json.body.id) return [{ json: fail('create subfolder', it.json) }];
}
return [{ json: { ok: true, created: $input.all().length } }];` } },
  output: [{ ok: true, created: 5 }] });
const subsOk = ifElse({ version: 2.3, config: { name: 'Subfolders OK?', parameters: OK_IF } });

const readFolder = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Back Project Folder', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: expr(API + "/{{ $('Plan Missing Subfolders').first().json.folder_id }}"), authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendQuery: true, queryParameters: { parameters: [{ name: 'fields', value: FOLDER_FIELDS }] },
    options: RAW }, credentials: DRIVE }, output: [{ statusCode: 200, body: { id: 'fid' } }] });

const readSubs = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Back Subfolders', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: API, authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api',
    sendQuery: true, queryParameters: { parameters: [
      { name: 'q', value: expr("'{{ $('Plan Missing Subfolders').first().json.folder_id }}' in parents and trashed=false") },
      { name: 'fields', value: 'files(' + FOLDER_FIELDS + ')' }, { name: 'pageSize', value: '100' }] },
    options: RAW }, credentials: DRIVE }, output: [{ statusCode: 200, body: { files: [] } }] });

const verify = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Verify Drive Read-Back',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const f = $('Read Back Project Folder').first().json;
const c = $input.first().json;
if (f.statusCode !== 200) return [{ json: fail('read back project folder', f) }];
if (c.statusCode !== 200) return [{ json: fail('read back subfolders', c) }];
const root = $('Check Root Folder').first().json.root_id;
const b = f.body;
const problems = [];
if (b.mimeType !== FOLDER) problems.push('not a folder');
if (b.trashed) problems.push('folder is in trash');
if (!(b.parents || []).includes(root)) problems.push('folder is not inside the RoofOps root');
if (b.name !== job.folder_name) problems.push('name "' + b.name + '" is not "' + job.folder_name + '"');
if ((b.appProperties || {}).roofops_project_id !== job.project_id) problems.push('folder is not tagged with the project id');
const subs = (c.body.files || []).filter(function (s) { return s.mimeType === FOLDER && !s.trashed; });
const proofSubs = [];
for (const n of (job.subfolders || [])) {
  const m = subs.filter(function (s) { return s.name === n; });
  if (m.length !== 1) { problems.push('subfolder "' + n + '" found ' + m.length + ' times'); continue; }
  proofSubs.push({ id: m[0].id, name: m[0].name, parent_id: (m[0].parents || [])[0], mime_type: m[0].mimeType, trashed: m[0].trashed, web_view_link: m[0].webViewLink });
}
if (problems.length) return [{ json: refuse('verify read-back', 'RECONCILIATION_MISMATCH', problems.join('; ')) }];
return [{ json: { ok: true, proof: { verified: true, folder_id: b.id, mime_type: b.mimeType, name: b.name, parent_id: root, trashed: b.trashed,
  web_view_link: b.webViewLink, app_properties: b.appProperties, subfolders: proofSubs, read_back_at: new Date().toISOString(),
  created_this_attempt: !$('Check Project Folder Search').first().json.found, n8n_execution: $execution.id } } }];` } },
  output: [{ ok: true, proof: { verified: true } }] });
const verifyOk = ifElse({ version: 2.3, config: { name: 'Read-Back Verified?', parameters: OK_IF } });

const complete = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Record Verified Drive Folder', onError: 'continueErrorOutput',
  parameters: { operation: 'executeQuery', query: 'select wf_complete_side_effect($1, $2::jsonb) as r',
    options: { queryReplacement: expr("{{ [ $('When Called By Main Workflow').first().json.drive_key, JSON.stringify($json.proof) ] }}") } },
  credentials: PG }, output: [{ r: { status: 'RECORDED' } }] });

const done = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Drive Done',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const input = $('When Called By Main Workflow').first().json;
const proof = $('Verify Drive Read-Back').first().json.proof;
return [{ json: Object.assign({}, input, { drive: { status: 'DONE', folder_id: proof.folder_id, web_view_link: proof.web_view_link,
  subfolders: proof.subfolders.map(function (s) { return s.name + '=' + s.id; }), recorded: $input.first().json.r,
  attempt: $('Claim Drive Side Effect').last().json.c.attempt } }) }];` } },
  output: [{ drive: { status: 'DONE' } }] });

const refused = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Proof Refused By Postgres',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const e = $input.first().json;
const m = (e.error && (e.error.message || e.error)) || e.message || 'refused';
return [{ json: { ok: false, failure: { step: 'record drive folder', error_class: 'RECONCILIATION_MISMATCH', http_status: null, retry_after_seconds: null, message: 'record drive folder: ' + String(m).slice(0, 400) } } }];` } },
  output: [{ ok: false, failure: {} }] });

const recordFailure = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Record Drive Failure',
  parameters: { operation: 'executeQuery',
    query: "select wf_fail_side_effect($1, $2, $3, nullif($4, '')::int, nullif($5, '')::int) as f, $6::text as step",
    options: { queryReplacement: expr("{{ [ $('When Called By Main Workflow').first().json.drive_key, $json.failure.error_class, $json.failure.message, String($json.failure.http_status ?? ''), String($json.failure.retry_after_seconds ?? ''), $json.failure.step ] }}") } },
  credentials: PG }, output: [{ f: { retry: true, retry_in_seconds: 1 } }] });

const retry = ifElse({ version: 2.3, config: { name: 'Retry Allowed?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.f.retry }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

const wait = node({ type: 'n8n-nodes-base.wait', version: 1.1, config: { name: 'Wait For Backoff',
  parameters: { resume: 'timeInterval', amount: expr('{{ $json.f.retry_in_seconds + 2 }}'), unit: 'seconds' } }, output: [{}] });

const deadLetter = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Drive Failed (Exception Opened)',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const input = $('When Called By Main Workflow').first().json;
const f = $input.first().json.f;
return [{ json: Object.assign({}, input, { drive: { status: 'FAILED', exception_number: f.exception_number, attempt: f.attempt, reason: f.reason,
  message: $('Record Drive Failure').last().json.step } }) }];` } },
  output: [{ drive: { status: 'FAILED' } }] });

export default workflow('roofops-drive-project-folder', '[RoofOps] 02 Drive Project Folder')
  .add(start).to(claim).to(claimRoute
    .onCase(0, findRoot.to(checkRoot).to(rootOk
      .onTrue(findProject.to(checkProject).to(searchOk
        .onTrue(exists
          .onTrue(listSubs)
          .onFalse(createProject.to(checkCreate).to(createOk.onTrue(listSubs).onFalse(recordFailure))))
        .onFalse(recordFailure)))
      .onFalse(recordFailure)))
    .onCase(1, alreadyDone)
    .onCase(2, notClaimed))
  .add(listSubs).to(planSubs).to(planOk
    .onTrue(anyMissing
      .onTrue(splitMissing.to(createSub).to(checkSubs).to(subsOk.onTrue(readFolder).onFalse(recordFailure)))
      .onFalse(readFolder))
    .onFalse(recordFailure))
  .add(readFolder).to(readSubs).to(verify).to(verifyOk
    .onTrue(complete)
    .onFalse(recordFailure))
  .add(complete).to(done)
  .add(complete.onError(refused))
  .add(refused).to(recordFailure)
  .add(recordFailure).to(retry.onTrue(wait.to(claim)).onFalse(deadLetter));
