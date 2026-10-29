/**
 * npm run n8n:mcp -- status  <workflowId>                    read only: active state, version, MCP access, saving settings
 * npm run n8n:mcp -- disable <workflowId> "<expected name>"  sets settings.availableInMCP = false, sending back exactly the
 *                                                            nodes, connections and other settings it just read
 * An MCP client can read, edit and EXECUTE any workflow with MCP access, including schedule- and webhook-triggered ones
 * (for 07 that is a repair-mode reconciliation, with no operator token). Deployment and inspection use the public API,
 * so RoofOps workflows need no MCP access. `disable` refuses if the workflow's name is not the expected one, then proves
 * that nodes and connections are unchanged and the workflow is still active. Key from .env.local, never printed.
 */
import { isDeepStrictEqual } from 'node:util';
import { loadLocalEnv, requireEnv } from '../src/config/env.js';

loadLocalEnv();
const [cmd, id, expectedName] = process.argv.slice(2);
if (!id || !['status', 'disable'].includes(cmd ?? '') || (cmd === 'disable' && !expectedName)) {
  throw new Error('usage: n8n-mcp-access.ts status <workflowId> | disable <workflowId> "<expected name>"');
}
const H = { 'X-N8N-API-KEY': requireEnv('N8N_API_KEY'), 'content-type': 'application/json', accept: 'application/json' };
const url = `${requireEnv('N8N_BASE_URL')}/api/v1/workflows/${id}`;
type W = { name: string; active: boolean; versionId?: string; nodes: unknown[]; connections: unknown; settings: Record<string, unknown> };
const read = async () => { const r = await fetch(url, { headers: H }); if (!r.ok) throw new Error(`GET ${id}: HTTP ${r.status}`); return await r.json() as W; };
const show = (w: W) => JSON.stringify({ name: w.name, active: w.active, versionId: w.versionId, availableInMCP: w.settings.availableInMCP ?? '(default: on)',
  saveDataSuccessExecution: w.settings.saveDataSuccessExecution, saveDataErrorExecution: w.settings.saveDataErrorExecution,
  saveManualExecutions: w.settings.saveManualExecutions, saveExecutionProgress: w.settings.saveExecutionProgress, callerPolicy: w.settings.callerPolicy });

const before = await read();
console.log(`now:   ${show(before)}`);
if (cmd === 'disable') {
  if (before.name !== expectedName) throw new Error(`refusing: workflow is "${before.name}", expected "${expectedName}"`);
  if (before.settings.availableInMCP === false) { console.log('already off; nothing sent'); process.exit(0); }
  const res = await fetch(url, { method: 'PUT', headers: H,
    body: JSON.stringify({ name: before.name, nodes: before.nodes, connections: before.connections, settings: { ...before.settings, availableInMCP: false } }) });
  if (!res.ok) { console.log(`PUT refused: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`); process.exit(2); }
  const after = await read();
  console.log(`after: ${show(after)}`);
  const changed = Object.keys({ ...before.settings, ...after.settings }).filter((k) => !isDeepStrictEqual(before.settings[k], after.settings[k]));
  console.log(`nodes unchanged: ${isDeepStrictEqual(before.nodes, after.nodes)}; connections unchanged: ${isDeepStrictEqual(before.connections, after.connections)}; ` +
    `still active: ${after.active}; versionId unchanged: ${before.versionId === after.versionId}; settings changed: ${changed.join(', ') || 'none'}`);
  if (!after.active || !isDeepStrictEqual(before.nodes, after.nodes)) process.exitCode = 3;   // a person checks before anything else
}
