/**
 * npm run ai:eval   Copilot regression suite (Promptfoo, dev-only via npx, pinned; no runtime dependency).
 * Needs the web app running (cd web && npm run dev). Refreshes ground truth from Postgres, runs the suite against the
 * real /api/copilot, prints a pass/fail table. Telemetry and sharing are off; results stay on this machine.
 */
import { spawnSync } from 'node:child_process';

const PROMPTFOO = 'promptfoo@0.123.1';
const env = { ...process.env, PROMPTFOO_DISABLE_TELEMETRY: '1', PROMPTFOO_DISABLE_UPDATE: '1', PROMPTFOO_DISABLE_SHARING: '1' };
const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' }).status ?? 1;

// The suite prepares one real preview (PRJ-2026-0005); the existing audited demo reset withdraws it before and after.
if (run('npx', ['tsx', 'scripts/demo.ts', 'reset']) !== 0) process.exit(1);
if (run('npx', ['tsx', 'scripts/ai-ground-truth.ts']) !== 0) process.exit(1);
const status = run('npx', ['--yes', PROMPTFOO, 'eval', '-c', 'promptfoo/promptfooconfig.yaml', '--no-cache', '--no-table', '-o', 'promptfoo/results.json']);
run('npx', ['tsx', 'scripts/demo.ts', 'reset']);
process.exitCode = status;
