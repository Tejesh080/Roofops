import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLE_TABLES, fileSha256, sha256 } from '../data/bundle.js';
import { parseCsv, type Table } from '../data/csv.js';
import { withTransaction, type Db } from '../db/db.js';

export const NORMALISED_DIR = 'data/normalised';
const TRANSFORM_SQL = join(import.meta.dirname, 'transform.sql');

/** Core tables whose row counts are recorded on the import batch. */
export const COUNTED_TABLES = [
  'employees', 'customers', 'customer_match_candidates', 'properties', 'customer_properties', 'inspections',
  'quotes', 'quote_versions', 'projects', 'project_checklist_items', 'suppliers', 'products', 'supplier_products',
  'purchase_orders', 'invoices', 'payments', 'documents', 'site_notes', 'automation_events', 'processed_events',
  'workflow_exceptions', 'external_links',
] as const;

export type ImportResult =
  | { status: 'IMPORTED'; batchId: string; datasetSha256: string; rowCounts: Record<string, number> }
  | { status: 'SKIPPED_ALREADY_IMPORTED'; batchId: string; datasetSha256: string };

interface Manifest {
  demo_date: string;
  dataset_sha256: string;
  files: Record<string, { normalised_sha256: string }>;
}

/** Verifies the normalised files are exactly the ones the manifest describes. */
export function readVerifiedManifest(dir: string): Manifest {
  const m = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as Manifest;
  for (const t of BUNDLE_TABLES) {
    const actual = fileSha256(join(dir, `${t}.csv`));
    if (actual !== m.files[t]?.normalised_sha256) throw new Error(`${t}.csv does not match MANIFEST.json (hash ${actual.slice(0, 12)}…); re-run npm run data:normalise`);
  }
  const recomputed = sha256(BUNDLE_TABLES.map((t) => m.files[t]!.normalised_sha256).join('\n'));
  if (recomputed !== m.dataset_sha256) throw new Error('MANIFEST.json dataset_sha256 is inconsistent');
  return m;
}

async function loadStaging(db: Db, table: string, data: Table): Promise<void> {
  const cols = data.headers.map((h) => `"${h}"`).join(', ');
  const BATCH = 200;
  for (let i = 0; i < data.rows.length; i += BATCH) {
    const chunk = data.rows.slice(i, i + BATCH);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => `(${data.headers.map((h) => { params.push(row[h] ?? ''); return `$${params.length}`; }).join(', ')})`);
    await db.query(`insert into staging.${table} (${cols}) values ${tuples.join(', ')}`, params);
  }
}

/**
 * Loads data/normalised into the core schema in ONE transaction.
 * Idempotent: the same dataset (by content hash) is never imported twice.
 * Refuses to merge a different dataset into a database that already has data.
 */
export async function importBundle(db: Db, dir = NORMALISED_DIR): Promise<ImportResult> {
  const manifest = readVerifiedManifest(dir);
  const prior = await db.query<{ id: string }>('select id from import_batches where dataset_sha256 = $1', [manifest.dataset_sha256]);
  if (prior[0]) return { status: 'SKIPPED_ALREADY_IMPORTED', batchId: prior[0].id, datasetSha256: manifest.dataset_sha256 };
  const [{ n } = { n: 0 }] = await db.query<{ n: number }>('select count(*)::int as n from customers');
  if (n > 0) throw new Error('Database already contains a different dataset; reset it before importing');

  return withTransaction(db, async () => {
    for (const t of BUNDLE_TABLES) {
      await db.exec(`truncate staging.${t}`);
      await loadStaging(db, t, parseCsv(readFileSync(join(dir, `${t}.csv`), 'utf8')));
    }
    await db.exec('truncate staging.date_changes');
    await loadStaging(db, 'date_changes', parseCsv(readFileSync(join(dir, 'date_changes.csv'), 'utf8')));

    await db.exec(readFileSync(TRANSFORM_SQL, 'utf8'));

    await db.query(`insert into app_settings (key, value) values ('business_date_override', $1)
                    on conflict (key) do update set value = excluded.value, updated_at = now()`, [manifest.demo_date]);

    const rowCounts: Record<string, number> = {};
    for (const t of COUNTED_TABLES) {
      rowCounts[t] = (await db.query<{ n: number }>(`select count(*)::int as n from ${t}`))[0]!.n;
    }
    const [batch] = await db.query<{ id: string }>(
      `insert into import_batches (dataset_sha256, demo_date, source, row_counts, status)
       values ($1, $2, $3, $4, 'COMPLETED') returning id`,
      [manifest.dataset_sha256, manifest.demo_date, dir, JSON.stringify(rowCounts)]);
    await db.query(
      `insert into audit_events (actor_type, actor_id, actor_display, action, entity_type, entity_id, after_state, reason)
       values ('SYSTEM', 'importer', 'RoofOps bundle importer', 'data.import', 'import_batch', $1, $2, $3)`,
      [batch!.id, JSON.stringify({ dataset_sha256: manifest.dataset_sha256, demo_date: manifest.demo_date, row_counts: rowCounts }),
        'Initial load of the canonical synthetic data bundle (dates normalised to the demo date)']);
    return { status: 'IMPORTED' as const, batchId: batch!.id, datasetSha256: manifest.dataset_sha256, rowCounts };
  });
}
