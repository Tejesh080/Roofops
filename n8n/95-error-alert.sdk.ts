import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const PG = { postgres: { id: 'kWqjtv0gz7ref2EN', name: 'RoofOps Postgres' } };

// The error workflow of every RoofOps workflow (each workflow's Settings > Error workflow; master plan Task 1.2).
// n8n runs it when a PRODUCTION execution fails (never for a manual run). It records the failure as a failed n8n
// health check through the same entry point as 08, so System Health shows it at once, with the workflow, execution
// and message; /api/healthz needs attention when n8n fails three times in a row before 08's next OK. No address or
// secret lives here: the outside uptime monitor watches /api/healthz.
const onError = trigger({ type: 'n8n-nodes-base.errorTrigger', version: 1, config: { name: 'When A Workflow Fails' },
  output: [{ execution: { id: '231', url: 'https://example.app.n8n.cloud/execution/231', error: { message: 'Example error', stack: 'Error: ...' },
    lastNodeExecuted: 'Node With Error', mode: 'trigger' }, workflow: { id: 'abc', name: '[RoofOps] 06 Airtable Changes' } }] });

const build = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Build Failure Record',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
// A failure inside a trigger (the workflow never started) arrives as "trigger" instead of "execution".
const j = $input.first().json;
const run = j.execution || j.trigger || {};
const err = run.error || {};
const text = (v, max) => (v == null ? null : String(v).slice(0, max));
const detail = {
  source: 'error-workflow',
  workflow: text((j.workflow || {}).name || 'unknown workflow', 120),
  workflow_id: text((j.workflow || {}).id, 40),
  execution_id: text(run.id, 40),
  node: text(run.lastNodeExecuted || (err.node || {}).name, 120),
  mode: text(run.mode, 20),
  message: text(err.message || err.description || 'no message', 300),
};
for (const k of Object.keys(detail)) if (detail[k] === null) delete detail[k];
return [{ json: { checks: JSON.stringify([{ service: 'n8n', ok: false, detail }]) } }];` } },
  output: [{ checks: '[{"service":"n8n","ok":false,"detail":{"source":"error-workflow"}}]' }] });

const record = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Record Failure In Postgres',
  parameters: { operation: 'executeQuery', query: 'select wf_record_health($1::jsonb) as r', options: { queryReplacement: expr('{{ [ $json.checks ] }}') } },
  credentials: PG }, output: [{ r: { recorded: 2 } }] });

export default workflow('roofops-error-alert', '[RoofOps] 95 Workflow Failure To Health')
  .add(onError).to(build).to(record);
