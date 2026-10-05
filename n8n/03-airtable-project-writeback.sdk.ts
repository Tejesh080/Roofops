import { workflow, node, trigger, ifElse, switchCase, expr } from '@n8n/workflow-sdk';

const AIRTABLE = { airtableTokenApi: { id: '3XbFnHjAd7mFvBD2', name: 'Roofops Airtable Personal Access Token account' } };
const PG = { postgres: { id: 'kWqjtv0gz7ref2EN', name: 'RoofOps Postgres' } };
const RAW = { response: { response: { fullResponse: true, neverError: true } }, timeout: 20000 };
const BASE = 'https://api.airtable.com/v0/appMc8V0Wm29tEeHQ';
const PROJECTS = BASE + '/tblvUPIoebC3zoacv';
const QUOTES = BASE + '/tblzenPRNVV5O7lZP';

const FAIL_JS = `
function fail(step, r) {
  const s = r.statusCode;
  const body = r.body || {};
  const e = body.error || r.error || {};
  const msg = (typeof e === 'string' ? e : (e.message || e.type || e.description)) || r.message || ('HTTP ' + s);
  let cls = 'UNKNOWN'; let retryAfter = null;
  if (!s) cls = /time ?out|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED/i.test(String(msg)) ? 'TIMEOUT' : 'NETWORK';
  else if (s === 429) { cls = 'RATE_LIMITED'; retryAfter = parseInt((r.headers || {})['retry-after'], 10) || 30; }
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
const F = { number: 'fldhhnQXlbuFaveK3', quote: 'fld08eKCeuDCsJLjz', customer: 'fldG4mPoV6sUkA9rM', status: 'fldi2Qwz1dAh2tcTE', pm: 'fldnZcRBxG7hTebD5',
  materialTask: 'fld93YzhrpOVIviRY', driveFolder: 'fldgVDT29UOOOtlqO', roofopsId: 'fldc4T0AgU3zCmANC',
  completionPhotos: 'fldbbksVL3dT6cqyS', complianceCertificate: 'fldf7iJiyHFxOQgUy' };
const QF = { projects: 'flduJm0iR7pBb157b', number: 'fldyP20HNafS614d5' };
const input = $('When Called By Main Workflow').first().json;
const job = $('Claim Airtable Write-back').last().json.c.payload || {};
`;

const OK_IF = { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.ok }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } };

const start = trigger({ type: 'n8n-nodes-base.executeWorkflowTrigger', version: 1.2,
  config: { name: 'When Called By Main Workflow', parameters: { inputSource: 'passthrough' } },
  output: [{ airtable_key: 'airtable:project-writeback:uuid', project_id: 'uuid' }] });

const claim = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Claim Airtable Write-back',
  parameters: { operation: 'executeQuery', query: 'select wf_claim_side_effect($1, $2, 180) as c',
    options: { queryReplacement: expr("{{ [ $('When Called By Main Workflow').first().json.airtable_key, 'n8n:' + $execution.id ] }}") } },
  credentials: PG }, output: [{ c: { claimed: true, attempt: 1, payload: {} } }] });

const claimRoute = switchCase({ version: 3.4, config: { name: 'Claimed?',
  parameters: { mode: 'expression', numberOutputs: 3, output: expr("{{ $json.c.claimed ? 0 : ($json.c.status === 'DONE' ? 1 : 2) }}") } } });

const alreadyDone = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Write-back Already Done',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const input = $('When Called By Main Workflow').first().json;
const c = $input.first().json.c;
return [{ json: Object.assign({}, input, { airtable: { status: 'DONE', already_done: true, project_record_id: c.result.project_record_id } }) }];` } },
  output: [{ airtable: { status: 'DONE' } }] });

const notClaimed = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Write-back Not Claimed',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const input = $('When Called By Main Workflow').first().json;
const c = $input.first().json.c;
const dead = c.status === 'FAILED' && String(c.retry_at || '').startsWith('infinity');
return [{ json: Object.assign({}, input, { airtable: { status: dead ? 'FAILED' : (c.status === 'WAITING_ON_DEPENDENCY' ? 'WAITING_ON_DRIVE' : 'NOT_CLAIMED'), claim: c,
  message: dead ? 'Dead-lettered after ' + c.attempts + ' attempts: ' + c.last_error : 'Not claimed (' + c.status + ')' } }) }];` } },
  output: [{ airtable: { status: 'NOT_CLAIMED' } }] });

const build = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Build Project Record',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
if (!job.quote_airtable_record_id) return [{ json: refuse('build record', 'SCHEMA_MISMATCH', 'no verified Airtable record id for quote ' + job.quote_number) }];
if (!job.drive_folder || !job.drive_folder.web_view_link) return [{ json: refuse('build record', 'SCHEMA_MISMATCH', 'claim did not carry the verified Drive folder') }];
const fields = {};
fields[F.number] = job.project_number;
fields[F.quote] = [job.quote_airtable_record_id];
if (job.customer_airtable_record_id) fields[F.customer] = [job.customer_airtable_record_id];
fields[F.status] = job.status;
fields[F.pm] = job.project_manager;
fields[F.materialTask] = job.material_task;
fields[F.driveFolder] = job.drive_folder.web_view_link;
fields[F.roofopsId] = job.project_id;
// AC-13A: a new project's completion gate starts To do (wf_quote_accepted creates both items OPEN); staff set them here later.
fields[F.completionPhotos] = 'To do';
fields[F.complianceCertificate] = 'To do';
return [{ json: { ok: true, request: { performUpsert: { fieldsToMergeOn: [F.roofopsId] }, returnFieldsByFieldId: true, typecast: false, records: [{ fields: fields }] } } }];` } },
  output: [{ ok: true, request: {} }] });
const buildOk = ifElse({ version: 2.3, config: { name: 'Record Built?', parameters: OK_IF } });

const upsert = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Upsert Project Record', onError: 'continueRegularOutput',
  parameters: { method: 'PATCH', url: PROJECTS, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: expr('{{ JSON.stringify($json.request) }}'), options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { records: [{ id: 'rec' }] } }] });

const checkUpsert = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Check Upsert',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const r = $input.first().json;
if (r.statusCode !== 200) return [{ json: fail('upsert project record', r) }];
const recs = r.body.records || [];
if (recs.length !== 1) return [{ json: refuse('upsert project record', 'RECONCILIATION_MISMATCH', 'upsert returned ' + recs.length + ' records') }];
return [{ json: { ok: true, record_id: recs[0].id, created: (r.body.createdRecords || []).includes(recs[0].id) } }];` } },
  output: [{ ok: true, record_id: 'rec' }] });
const upsertOk = ifElse({ version: 2.3, config: { name: 'Upsert OK?', parameters: OK_IF } });

const readProject = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Back Project Record', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: expr(PROJECTS + '/{{ $json.record_id }}'), authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendQuery: true, queryParameters: { parameters: [{ name: 'returnFieldsByFieldId', value: 'true' }] }, options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { id: 'rec', fields: {} } }] });

const readQuote = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Read Back Quote Link', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: expr(QUOTES + "/{{ $('Claim Airtable Write-back').last().json.c.payload.quote_airtable_record_id }}"), authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendQuery: true, queryParameters: { parameters: [{ name: 'returnFieldsByFieldId', value: 'true' }] }, options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { id: 'rec', fields: {} } }] });

const countMatches = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5, config: { name: 'Count Matching Project Records', onError: 'continueRegularOutput',
  parameters: { method: 'GET', url: PROJECTS, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    sendQuery: true, queryParameters: { parameters: [
      { name: 'filterByFormula', value: expr("OR({RoofOps ID}='{{ $('Claim Airtable Write-back').last().json.c.payload.project_id }}',{Project Number}='{{ $('Claim Airtable Write-back').last().json.c.payload.project_number }}')") },
      { name: 'fields[]', value: 'Project Number' }, { name: 'pageSize', value: '10' }] }, options: RAW },
  credentials: AIRTABLE }, output: [{ statusCode: 200, body: { records: [] } }] });

const verify = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Verify Airtable Read-Back',
  parameters: { mode: 'runOnceForAllItems', jsCode: FAIL_JS + `
const p = $('Read Back Project Record').first().json;
const q = $('Read Back Quote Link').first().json;
const m = $input.first().json;
if (p.statusCode !== 200) return [{ json: fail('read back project record', p) }];
if (q.statusCode !== 200) return [{ json: fail('read back quote', q) }];
if (m.statusCode !== 200) return [{ json: fail('count matching project records', m) }];
const recId = $('Check Upsert').first().json.record_id;
const f = p.body.fields || {};
const problems = [];
if (p.body.id !== recId) problems.push('read back a different record');
if (f[F.number] !== job.project_number) problems.push('Project Number is ' + f[F.number]);
if (f[F.roofopsId] !== job.project_id) problems.push('RoofOps ID is ' + f[F.roofopsId]);
if (f[F.status] !== job.status) problems.push('Status is ' + f[F.status]);
if (f[F.driveFolder] !== job.drive_folder.web_view_link) problems.push('Drive Folder is ' + f[F.driveFolder]);
if (f[F.completionPhotos] !== 'To do') problems.push('Completion Photos is ' + f[F.completionPhotos]);
if (f[F.complianceCertificate] !== 'To do') problems.push('Compliance Certificate is ' + f[F.complianceCertificate]);
const quoteLinks = f[F.quote] || [];
if (!quoteLinks.includes(job.quote_airtable_record_id)) problems.push('Project is not linked to quote ' + job.quote_airtable_record_id);
const backLinks = (q.body.fields || {})[QF.projects] || [];
if (!backLinks.includes(recId)) problems.push('Quote ' + job.quote_number + ' does not link back to ' + recId);
const matches = m.body.records || [];
if (matches.length !== 1) problems.push(matches.length + ' Airtable project records match ' + job.project_number + ' / RoofOps ID');
if (problems.length) return [{ json: refuse('verify read-back', 'RECONCILIATION_MISMATCH', problems.join('; ')) }];
return [{ json: { ok: true, proof: { verified: true, project_record_id: recId, roofops_id: f[F.roofopsId], project_number: f[F.number], status: f[F.status],
  linked_quote_record_ids: quoteLinks, quote_links_back: true, drive_folder_url: f[F.driveFolder], matching_records: matches.length,
  created: $('Check Upsert').first().json.created, read_back_at: new Date().toISOString(), n8n_execution: $execution.id } } }];` } },
  output: [{ ok: true, proof: { verified: true } }] });
const verifyOk = ifElse({ version: 2.3, config: { name: 'Read-Back Verified?', parameters: OK_IF } });

const complete = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Record Verified Write-back', onError: 'continueErrorOutput',
  parameters: { operation: 'executeQuery', query: 'select wf_complete_side_effect($1, $2::jsonb) as r',
    options: { queryReplacement: expr("{{ [ $('When Called By Main Workflow').first().json.airtable_key, JSON.stringify($json.proof) ] }}") } },
  credentials: PG }, output: [{ r: { status: 'RECORDED' } }] });

const done = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Write-back Done',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const input = $('When Called By Main Workflow').first().json;
const proof = $('Verify Airtable Read-Back').first().json.proof;
return [{ json: Object.assign({}, input, { airtable: { status: 'DONE', project_record_id: proof.project_record_id, created: proof.created,
  recorded: $input.first().json.r, attempt: $('Claim Airtable Write-back').last().json.c.attempt } }) }];` } },
  output: [{ airtable: { status: 'DONE' } }] });

const refused = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Proof Refused By Postgres',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const e = $input.first().json;
const m = (e.error && (e.error.message || e.error)) || e.message || 'refused';
return [{ json: { ok: false, failure: { step: 'record airtable write-back', error_class: 'RECONCILIATION_MISMATCH', http_status: null, retry_after_seconds: null, message: 'record airtable write-back: ' + String(m).slice(0, 400) } } }];` } },
  output: [{ ok: false, failure: {} }] });

const recordFailure = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Record Write-back Failure',
  parameters: { operation: 'executeQuery',
    query: "select wf_fail_side_effect($1, $2, $3, nullif($4, '')::int, nullif($5, '')::int) as f, $6::text as step",
    options: { queryReplacement: expr("{{ [ $('When Called By Main Workflow').first().json.airtable_key, $json.failure.error_class, $json.failure.message, String($json.failure.http_status ?? ''), String($json.failure.retry_after_seconds ?? ''), $json.failure.step ] }}") } },
  credentials: PG }, output: [{ f: { retry: true, retry_in_seconds: 1 } }] });

const retry = ifElse({ version: 2.3, config: { name: 'Retry Allowed?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.f.retry }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

const wait = node({ type: 'n8n-nodes-base.wait', version: 1.1, config: { name: 'Wait For Backoff',
  parameters: { resume: 'timeInterval', amount: expr('{{ $json.f.retry_in_seconds + 2 }}'), unit: 'seconds' } }, output: [{}] });

const deadLetter = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Write-back Failed (Exception Opened)',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const input = $('When Called By Main Workflow').first().json;
const f = $input.first().json.f;
return [{ json: Object.assign({}, input, { airtable: { status: 'FAILED', exception_number: f.exception_number, attempt: f.attempt, reason: f.reason,
  message: $('Record Write-back Failure').last().json.step } }) }];` } },
  output: [{ airtable: { status: 'FAILED' } }] });

export default workflow('roofops-airtable-project-writeback', '[RoofOps] 03 Airtable Project Write-back')
  .add(start).to(claim).to(claimRoute
    .onCase(0, build.to(buildOk
      .onTrue(upsert.to(checkUpsert).to(upsertOk
        .onTrue(readProject.to(readQuote).to(countMatches).to(verify).to(verifyOk
          .onTrue(complete)
          .onFalse(recordFailure)))
        .onFalse(recordFailure)))
      .onFalse(recordFailure)))
    .onCase(1, alreadyDone)
    .onCase(2, notClaimed))
  .add(complete).to(done)
  .add(complete.onError(refused))
  .add(refused).to(recordFailure)
  .add(recordFailure).to(retry.onTrue(wait.to(claim)).onFalse(deadLetter));
