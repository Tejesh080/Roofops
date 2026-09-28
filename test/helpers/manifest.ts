import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLE_TABLES, fileSha256, sha256 } from '../../src/data/bundle.js';

/** Re-stamps MANIFEST.json hashes for a (deliberately corrupted) copy, so the corruption reaches the transform. */
export function writeNormalisedManifestFor(dir: string): void {
  const path = join(dir, 'MANIFEST.json');
  const m = JSON.parse(readFileSync(path, 'utf8')) as { files: Record<string, { normalised_sha256: string }>; dataset_sha256: string };
  for (const t of BUNDLE_TABLES) m.files[t]!.normalised_sha256 = fileSha256(join(dir, `${t}.csv`));
  m.dataset_sha256 = sha256(BUNDLE_TABLES.map((t) => m.files[t]!.normalised_sha256).join('\n'));
  writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
}
