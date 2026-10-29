import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';

// [RoofOps] 08 Reissue Dispatch (AC-14C, audit P2-D1). The supervised reissue (ops_reissue_decide) queues a generation-2
// xero.create_draft_invoice write; this operator-triggered workflow dispatches it to the unchanged [RoofOps] 05, exactly
// as 04 dispatches a first issue. Postgres decides everything: the operator token (SHA-256, like 07's reconcile trigger)
// and whether the ONE write the operator selected (invoice number + generation in the request body) is due and proven
// (wf_reissue_dispatch); nothing else is ever listed, and 05's own claim re-proves that write before any Xero call.

const PG = { postgres: { id: 'kWqjtv0gz7ref2EN', name: 'RoofOps Postgres' } };
const XERO_WF = 'Y2deCFTZzpv1uo8C';                     // [RoofOps] 05 Xero Draft Invoice, the same sub-workflow 04 runs

const hook = trigger({ type: 'n8n-nodes-base.webhook', version: 2.1,
  config: { name: 'Operator Trigger (npm run reissue -- dispatch)', parameters: { httpMethod: 'POST', path: 'roofops/reissue/dispatch',
    responseMode: 'onReceived', options: { noResponseBody: true } } }, output: [{ headers: {}, body: {} }] });

const request = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Read Request',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const j = $input.first().json;
const b = j.body || {};
const g = Number(b.generation);
// The token is checked in Postgres against a SHA-256 hash; it is never stored or echoed. The selection names exactly one
// write: without both an invoice number and a whole generation, Postgres refuses and nothing is dispatched.
return [{ json: { token: String((j.headers || {})['x-roofops-token'] || ''), invoice_number: typeof b.invoice_number === 'string' ? b.invoice_number : '',
  generation: Number.isInteger(g) && g > 0 ? String(g) : '' } }];` } },
  output: [{ token: '', invoice_number: '', generation: '' }] });

const find = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Find Dispatchable Reissues',
  parameters: { operation: 'executeQuery', query: "select wf_reissue_dispatch($1, $2, nullif($3, '')::int, $4) as d",
    options: { queryReplacement: expr("{{ [ $json.token, $json.invoice_number, $json.generation, 'n8n:' + $execution.id ] }}") } },
  credentials: PG }, output: [{ d: { ok: true, writes: [] } }] });

const writes = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Reissue Writes To Dispatch',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const d = $input.first().json.d || {};
const sel = $('Read Request').first().json;
// At most the one selected write (Postgres lists nothing else; checked again here): 05 takes { xero_key } and claims it
// with its own checks.
const w = (d.ok === true ? (d.writes || []) : []).filter(function (x) {
  return x.invoice_number === sel.invoice_number && String(x.generation) === sel.generation; }).slice(0, 1);
if (!w.length) return [{ json: { none: true, refused: d.ok !== true, code: d.code || null, detail: d.detail || null } }];
return w.map(function (x) { return { json: { xero_key: x.xero_key, invoice_number: x.invoice_number, generation: x.generation, dispatched_by: 'reissue-dispatch' } }; });` } },
  output: [{ xero_key: 'xero:invoice:uuid:g2' }] });

const any = ifElse({ version: 2.3, config: { name: 'Any Reissue Writes?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.none !== true }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

const runXero = node({ type: 'n8n-nodes-base.executeWorkflow', version: 1.3, config: { name: 'Run Xero Draft Invoice',
  parameters: { mode: 'each', source: 'database', workflowId: { __rl: true, mode: 'id', value: XERO_WF }, options: { waitForSubWorkflow: true } } },
  output: [{ xero: { status: 'DONE' } }] });

export default workflow('roofops-reissue-dispatch', '[RoofOps] 08 Reissue Dispatch')
  .add(hook).to(request).to(find).to(writes).to(any.onTrue(runXero));
