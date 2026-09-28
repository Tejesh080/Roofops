/**
 * Verifies the initial Airtable load by comparing an Airtable READ-BACK (records listed
 * from the real base after creation) with the hosted Postgres data and with the record
 * IDs returned at create time. Only if every check passes are the Airtable record IDs
 * persisted to external_links (verified_at = now()) with one audit event.
 *
 *   npx tsx scripts/verify-airtable-load.ts <dir-with-readback-tsv-and-create-maps>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPostgres, withTransaction } from '../src/db/db.js';
import { hostedDbConfig } from '../src/config/env.js';
import { AIRTABLE_BASE_ID } from '../src/integrations/airtable/schema.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: verify-airtable-load.ts <dir>');
const tsv = (f: string) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
const createMap = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, string>;
const norm = (s: string) => s.toUpperCase().replace(/ /g, '_');
const money = (x: string | number) => Number(x).toFixed(2);

interface Spec {
  table: string; entity: string; createMap: string; sql: string;
  compare: (rb: string[], db: Record<string, string>) => string[];
}
const SPECS: Spec[] = [
  { table: 'customers', entity: 'customer', createMap: 'customers.json',
    sql: `select id::text, customer_number k, display_name v1 from customers`,
    compare: (r, d) => (r[3] === d.v1 ? [] : [`name '${r[3]}' != '${d.v1}'`]) },
  { table: 'suppliers', entity: 'supplier', createMap: 'suppliers.json',
    sql: `select id::text, supplier_code k, name v1 from suppliers`,
    compare: (r, d) => (r[3] === d.v1 ? [] : [`name '${r[3]}' != '${d.v1}'`]) },
  { table: 'properties', entity: 'property', createMap: 'properties.json',
    sql: `select p.id::text, p.property_number k, c.customer_number v1 from properties p
          join customer_properties cp on cp.property_id = p.id and cp.relationship = 'OWNER' join customers c on c.id = cp.customer_id`,
    compare: (r, d) => (r[3] === d.v1 ? [] : [`owner ${r[3]} != ${d.v1}`]) },
  { table: 'quotes', entity: 'quote', createMap: 'quotes.json',
    sql: `select q.id::text, q.quote_number k, qv.total_inc_gst::text v1, q.status v2, c.customer_number v3 from quotes q
          join customers c on c.id = q.customer_id join lateral (select total_inc_gst from quote_versions v where v.quote_id = q.id order by version_number desc limit 1) qv on true`,
    compare: (r, d) => [
      ...(money(r[3]!) === money(d.v1!) ? [] : [`amount ${r[3]} != ${d.v1}`]),
      ...(norm(r[4]!) === d.v2 ? [] : [`status ${r[4]} != ${d.v2}`]),
      ...(r[5] === d.v3 ? [] : [`customer ${r[5]} != ${d.v3}`])] },
  { table: 'projects', entity: 'project', createMap: 'projects.json',
    sql: `select p.id::text, p.project_number k, p.status v1, q.quote_number v2, p.planned_start_date::text v3 from projects p join quotes q on q.id = p.quote_id`,
    compare: (r, d) => [
      ...(norm(r[3]!) === d.v1 ? [] : [`status ${r[3]} != ${d.v1}`]),
      ...(r[4] === d.v2 ? [] : [`quote ${r[4]} != ${d.v2}`]),
      ...(r[5] === d.v3 ? [] : [`planned start ${r[5]} != ${d.v3}`])] },
  { table: 'purchase_orders', entity: 'purchase_order', createMap: 'purchase_orders.json',
    sql: `select po.id::text, po.po_number k, po.subtotal_ex_gst::text v1, p.project_number v2, s.supplier_code v3
          from purchase_orders po join projects p on p.id = po.project_id join suppliers s on s.id = po.supplier_id`,
    compare: (r, d) => [
      ...(money(r[3]!) === money(d.v1!) ? [] : [`subtotal ${r[3]} != ${d.v1}`]),
      ...(r[4] === d.v2 ? [] : [`project ${r[4]} != ${d.v2}`]),
      ...(r[5] === d.v3 ? [] : [`supplier ${r[5]} != ${d.v3}`])] },
];

const cfg = hostedDbConfig();
const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
const failures: string[] = [];
const verified: { entity: string; id: string; rec: string }[] = [];
try {
  for (const s of SPECS) {
    const rb = tsv(`rb-${s.table}.tsv`);
    const created = createMap(s.createMap);
    const rows = await db.query<Record<string, string>>(s.sql);
    const byKey = new Map(rows.map((r) => [r.k!, r]));
    if (rb.length !== rows.length) failures.push(`${s.table}: Airtable has ${rb.length} records, Postgres ${rows.length}`);
    if (new Set(rb.map((r) => r[1])).size !== rb.length) failures.push(`${s.table}: duplicate business keys in Airtable`);
    for (const r of rb) {
      const [rec, key, uuid] = r as [string, string, string];
      const d = byKey.get(key);
      if (!d) { failures.push(`${s.table} ${key}: not in Postgres`); continue; }
      if (created[key] !== rec) failures.push(`${s.table} ${key}: read-back record ${rec} != created ${created[key]}`);
      if (uuid !== d.id) failures.push(`${s.table} ${key}: RoofOps ID ${uuid} != Postgres ${d.id}`);
      for (const f of s.compare(r, d)) failures.push(`${s.table} ${key}: ${f}`);
      verified.push({ entity: s.entity, id: d.id!, rec });
    }
    console.log(`${s.table.padEnd(16)} Airtable ${String(rb.length).padStart(3)} | Postgres ${String(rows.length).padStart(3)} | read-back checks ${rb.length * 3}+`);
  }
  if (failures.length) {
    for (const f of failures) console.error('  FAIL', f);
    throw new Error(`${failures.length} verification failures; nothing recorded`);
  }
  await withTransaction(db, async () => {
    for (const v of verified) {
      await db.query(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, external_url, last_synced_at, verified_at)
        values ('AIRTABLE', $1, $2, 'Record', $3, $4, now(), now())
        on conflict (provider, entity_type, entity_id, external_type) do update set verified_at = now(), last_synced_at = now()
        where external_links.external_id = excluded.external_id`,
        [v.entity, v.id, v.rec, `https://airtable.com/${AIRTABLE_BASE_ID}/${v.rec}`]);
    }
    await db.query(`insert into audit_events (actor_type, actor_id, actor_display, action, entity_type, entity_id, after_state, external_reference, reason)
      values ('SYSTEM', 'airtable-initial-load', 'Airtable initial load verifier', 'airtable.initial_load.verified', 'airtable_base',
              stable_uuid('airtable_base', $1), $2, $1, 'Synthetic operational data loaded into the RoofOps Demo base; every record read back and matched to Postgres')`,
      [AIRTABLE_BASE_ID, JSON.stringify(Object.fromEntries(SPECS.map((s) => [s.table, verified.filter((v) => v.entity === s.entity).length])))]);
  });
  const [n] = await db.query<{ n: number }>(`select count(*)::int n from external_links where provider = 'AIRTABLE' and verified_at is not null`);
  console.log(`ALL CHECKS PASSED. external_links (AIRTABLE, verified) = ${n!.n}`);
} finally {
  await db.close();
}
