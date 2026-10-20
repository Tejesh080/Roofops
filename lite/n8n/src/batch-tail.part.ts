// Shared tail of the scheduled Lite workflows: write the planned Message Log rows and job updates in batches of 10
// (Airtable's limit per request), then summarise. A run with nothing to write still ends in the summary.
const tail = (plan, summaryName) => {
  const logBatches = code('Log Batches', `
const p = $('${plan}').first().json;
const b = chunk(p.logs, 10);
return b.length ? b.map((x) => ({ json: { request: { typecast: false, records: x } } })) : [{ json: { none: true } }];`);
  const anyLogs = OK_IF('Logs To Write?', '{{ $json.none !== true }}');
  const writeLog = airtableWrite('Write Log', 'POST', T.messages);
  const updateBatches = code('Update Batches', `
if ($('Write Log').isExecuted) $('Write Log').all().forEach((i) => records(i.json, 'write message log'));
const p = $('${plan}').first().json;
const b = chunk(p.updates, 10);
return b.length ? b.map((x) => ({ json: { request: { typecast: false, records: x } } })) : [{ json: { none: true } }];`);
  const anyUpdates = OK_IF('Updates To Write?', '{{ $json.none !== true }}');
  const updateJobs = airtableWrite('Update Jobs', 'PATCH', T.jobs);
  const summary = code(summaryName, `
if ($('Update Jobs').isExecuted) $('Update Jobs').all().forEach((i) => records(i.json, 'update jobs'));
const p = $('${plan}').first().json;
return [{ json: Object.assign({ ok: true, ran_at: iso(NOW), logged: p.logs.length, jobs_updated: p.updates.length }, p.summary) }];`);
  return { logBatches, anyLogs, writeLog, updateBatches, anyUpdates, updateJobs, summary };
};
