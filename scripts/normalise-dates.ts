/**
 * npm run data:normalise [-- --check]
 * Reads data/raw/, applies date normalisation relative to DEMO_DATE, writes data/normalised/.
 * --check: do not write; exit 1 if the committed output differs from a fresh run (drift guard).
 */
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_DATE } from '../src/config/demo.js';
import { runNormalisation, writeNormalised } from '../src/normalise/pipeline.js';

const RAW = 'data/raw', OUT = 'data/normalised';
const check = process.argv.includes('--check');

const r = runNormalisation(RAW, DEMO_DATE);
console.log(`demo date ${DEMO_DATE}: ${r.rawViolations.length} invariant violations in raw bundle`);
const byRule = new Map<string, number>();
for (const c of r.changes) byRule.set(c.rule, (byRule.get(c.rule) ?? 0) + 1);
for (const [k, n] of [...byRule].sort()) console.log(`  ${k.padEnd(45)} ${n}`);
console.log(`${r.changes.length} date cells changed; ${r.remainingViolations.length} violations remaining`);
for (const v of r.remainingViolations) console.log(`  ! ${v.table} ${v.recordId}: ${v.message}`);
if (r.remainingViolations.length) process.exit(1);

if (check) {
  const tmp = mkdtempSync(join(tmpdir(), 'roofops-norm-'));
  writeNormalised(RAW, tmp, DEMO_DATE, r);
  const files = ['MANIFEST.json', 'date_changes.csv', 'scenario-manifest.json'];
  const drift = files.filter((f) => readFileSync(join(tmp, f), 'utf8') !== readFileSync(join(OUT, f), 'utf8'));
  rmSync(tmp, { recursive: true, force: true });
  if (drift.length) { console.error(`drift in ${drift.join(', ')}; run npm run data:normalise`); process.exit(1); }
  console.log('committed data/normalised matches a fresh run');
} else {
  writeNormalised(RAW, OUT, DEMO_DATE, r);
  console.log(`wrote ${OUT}/`);
}
