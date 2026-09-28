import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv, type Table } from './csv.js';

/**
 * The canonical normalised tables in the RoofOps synthetic data bundle.
 * `roofops_master_operations.csv` (flat, denormalised) and `data_dictionary.csv`
 * ship with the bundle but are not loaded: the per-table files are canonical.
 */
export const BUNDLE_TABLES = [
  'customers', 'properties', 'quotes', 'projects', 'suppliers', 'products',
  'purchase_orders', 'invoices', 'project_events', 'site_notes', 'documents',
  'workflow_exceptions', 'processed_events',
] as const;
export type BundleTable = (typeof BUNDLE_TABLES)[number];
export type Bundle = Record<BundleTable, Table>;

/** Primary key column of each bundle file (the source business ID, preserved verbatim). */
export const PRIMARY_KEY: Record<BundleTable, string> = {
  customers: 'customer_id', properties: 'property_id', quotes: 'quote_id', projects: 'project_id',
  suppliers: 'supplier_id', products: 'product_id', purchase_orders: 'po_id', invoices: 'invoice_id',
  project_events: 'event_id', site_notes: 'site_note_id', documents: 'document_id',
  workflow_exceptions: 'exception_id', processed_events: 'event_key',
};

/**
 * Every date / timestamp column in the bundle. Date normalisation may change
 * ONLY these columns; a test enforces that every other cell is byte-identical.
 */
export const DATE_COLUMNS: Record<BundleTable, readonly string[]> = {
  customers: ['created_date'],
  properties: [],
  quotes: ['inspection_date', 'quote_created_date', 'quote_sent_date', 'quote_accepted_date'],
  projects: ['planned_start_date', 'actual_start_date', 'planned_completion_date', 'actual_completion_date'],
  suppliers: [],
  products: [],
  purchase_orders: ['po_date', 'expected_delivery_date'],
  invoices: ['invoice_date', 'due_date', 'paid_date'],
  project_events: ['occurred_at'],
  site_notes: ['created_at'],
  documents: ['uploaded_at'],
  workflow_exceptions: ['created_at', 'last_attempt_at'],
  processed_events: ['processed_at'],
};

export function loadBundle(dir: string): Bundle {
  const out = {} as Bundle;
  for (const t of BUNDLE_TABLES) out[t] = parseCsv(readFileSync(join(dir, `${t}.csv`), 'utf8'));
  return out;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function fileSha256(path: string): string {
  return sha256(readFileSync(path));
}

export function cloneBundle(b: Bundle): Bundle {
  return structuredClone(b);
}
