/** Reads a generated Lite workflow (.sdk.ts) through the local SDK recorder: its nodes, connections, id and name. */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RecEdge, RecNode } from './sdk-recorder.js';

export interface LoadedWorkflow { meta: { id: string; name: string }; nodes: Map<string, RecNode>; edges: RecEdge[] }

const RECORDER = pathToFileURL(resolve('lite/tools/sdk-recorder.ts')).href;
let seq = 0;

export async function loadWorkflow(sdkFile: string): Promise<LoadedWorkflow> {
  const src = readFileSync(sdkFile, 'utf8');
  if (!src.includes("from '@n8n/workflow-sdk';")) throw new Error(`${sdkFile} does not import @n8n/workflow-sdk`);
  const tmp = resolve(sdkFile.replace(/\.sdk\.ts$/, `.record-${process.pid}-${++seq}.tmp.ts`));
  writeFileSync(tmp, src.replace("from '@n8n/workflow-sdk';", `from '${RECORDER}';`));
  const { take } = await import(RECORDER) as typeof import('./sdk-recorder.js');
  take();
  try { await import(pathToFileURL(tmp).href); } finally { rmSync(tmp, { force: true }); }
  return take();
}
