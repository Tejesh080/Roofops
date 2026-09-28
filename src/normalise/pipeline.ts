import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLE_TABLES, fileSha256, loadBundle, sha256, type Bundle } from '../data/bundle.js';
import { serializeCsv } from '../data/csv.js';
import { DATE_RULES_VERSION } from '../config/demo.js';
import { normaliseDates, type DateChange } from './rules.js';
import { checkDateInvariants, type Violation } from './invariants.js';
import { buildScenarioManifest, type ScenarioManifest } from './scenarios.js';

export interface NormaliseResult {
  bundle: Bundle;
  changes: DateChange[];
  rawViolations: Violation[];
  remainingViolations: Violation[];
  manifest: ScenarioManifest;
}

export function runNormalisation(rawDir: string, demoDate: string): NormaliseResult {
  const raw = loadBundle(rawDir);
  const rawViolations = checkDateInvariants(raw, demoDate);
  const { bundle, changes } = normaliseDates(raw, demoDate);
  return {
    bundle, changes, rawViolations,
    remainingViolations: checkDateInvariants(bundle, demoDate),
    manifest: buildScenarioManifest(bundle),
  };
}

/** Writes data/normalised/. Tables with no date changes are byte-identical copies of the raw file. */
export function writeNormalised(rawDir: string, outDir: string, demoDate: string, r: NormaliseResult): void {
  mkdirSync(outDir, { recursive: true });
  const changed = new Set(r.changes.map((c) => c.table));
  const files: Record<string, { raw_sha256: string; normalised_sha256: string; date_changes: number }> = {};
  for (const t of BUNDLE_TABLES) {
    const src = join(rawDir, `${t}.csv`), dst = join(outDir, `${t}.csv`);
    if (changed.has(t)) writeFileSync(dst, serializeCsv(r.bundle[t]));
    else copyFileSync(src, dst);
    files[t] = { raw_sha256: fileSha256(src), normalised_sha256: fileSha256(dst), date_changes: r.changes.filter((c) => c.table === t).length };
  }
  const log = {
    headers: ['table', 'record_id', 'field', 'from', 'to', 'rule', 'reason'],
    rows: r.changes.map((c) => ({ table: c.table, record_id: c.recordId, field: c.field, from: c.from, to: c.to, rule: c.rule, reason: c.reason })),
  };
  writeFileSync(join(outDir, 'date_changes.csv'), serializeCsv(log));
  writeFileSync(join(outDir, 'scenario-manifest.json'), JSON.stringify(r.manifest, null, 2) + '\n');

  const byRule: Record<string, number> = {};
  for (const c of r.changes) byRule[c.rule] = (byRule[c.rule] ?? 0) + 1;
  const manifest = {
    dataset: 'RoofOps synthetic data bundle (canonical normalised tables)',
    synthetic_demo_data: true,
    demo_date: demoDate,
    date_rules_version: DATE_RULES_VERSION,
    raw_violations_found: r.rawViolations.length,
    violations_remaining: r.remainingViolations.length,
    date_changes_total: r.changes.length,
    date_changes_by_rule: Object.fromEntries(Object.entries(byRule).sort()),
    files,
    // Hash of all normalised tables in canonical order: the import batch identity.
    dataset_sha256: sha256(BUNDLE_TABLES.map((t) => files[t]!.normalised_sha256).join('\n')),
  };
  writeFileSync(join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
}

export function readManifest(dir: string): { dataset_sha256: string; demo_date: string } {
  return JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as { dataset_sha256: string; demo_date: string };
}
