import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';

// [RoofOps] 09 Staff Xero Dispatch (STAFF-OPS-01). Staff ask the dashboard to send one queued Xero draft write (an
// invoice they approved, a failed write that is due again, or a reissue's replacement): web_xero_dispatch_request
// records the request as the signed-in Finance/Admin employee. This workflow polls every minute and asks Postgres for
// the next request (wf_xero_dispatch_next), which re-checks it now (current generation, due, not uncertain, approved,
// unchanged payload, reissue proven) and hands over at most ONE write, then runs the unchanged [RoofOps] 05 exactly as
// 04 and 08 do; 05's own claim re-proves the write before any Xero call. No webhook, no secret: nothing outside n8n
// and Postgres can trigger a Xero write here.

const PG = { postgres: { id: 'kWqjtv0gz7ref2EN', name: 'RoofOps Postgres' } };
const XERO_WF = 'Y2deCFTZzpv1uo8C';                     // [RoofOps] 05 Xero Draft Invoice, the same sub-workflow 04 and 08 run

const everyMinute = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1.3, config: { name: 'Every Minute', disabled: true,   // staging: off until the owner switches dispatch on
  parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } } }, output: [{}] });

const next = node({ type: 'n8n-nodes-base.postgres', version: 2.7, config: { name: 'Next Staff Request',
  parameters: { operation: 'executeQuery', query: 'select wf_xero_dispatch_next($1) as d',
    options: { queryReplacement: expr("{{ [ 'n8n:09:' + $execution.id ] }}") } },
  credentials: PG }, output: [{ d: { ok: true, writes: [] } }] });

const writes = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: 'Write To Dispatch',
  parameters: { mode: 'runOnceForAllItems', jsCode: `
const d = $input.first().json.d || {};
// At most one write per run (Postgres hands over one; checked again here). 05 takes { xero_key } and claims it itself.
const w = (d.ok === true ? (d.writes || []) : []).slice(0, 1);
if (!w.length) return [{ json: { none: true, refused: d.refused || [] } }];
return w.map(function (x) { return { json: { xero_key: x.xero_key, invoice_number: x.invoice_number, generation: x.generation, dispatched_by: 'staff-request' } }; });` } },
  output: [{ xero_key: 'xero:invoice:uuid:g1', none: false }] });

const any = ifElse({ version: 2.3, config: { name: 'Any Write?', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ leftValue: expr('{{ $json.none !== true }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } } } });

const runXero = node({ type: 'n8n-nodes-base.executeWorkflow', version: 1.3, config: { name: 'Run Xero Draft Invoice',
  parameters: { mode: 'each', source: 'database', workflowId: { __rl: true, mode: 'id', value: XERO_WF }, options: { waitForSubWorkflow: true } } },
  output: [{ xero: { status: 'DONE' } }] });

export default workflow('roofops-staff-xero-dispatch', '[RoofOps] 09 Staff Xero Dispatch')
  .add(everyMinute).to(next).to(writes).to(any.onTrue(runXero));
