/**
 * Loads the synthetic Lite demo data (lite/demo/fixtures.ts: every name starts "ZZ Lite Demo", Demo Data ticked) into
 * the REAL Lite tables, so the four workflows can be shown against real Airtable.
 *
 *   npx tsx lite/airtable/seed-demo.ts lite/config/<client>.json                      DRY RUN: counts only
 *   LITE_AIRTABLE_TOKEN=... npx tsx lite/airtable/seed-demo.ts lite/config/<client>.json --apply
 *
 * --apply needs a token with data.records:read + data.records:write on that base. It only creates records in the Lite
 * tables, in link order (contacts, properties, jobs, quotes), and refuses if any Lite table already holds Demo Data.
 * To remove the demo data afterwards, use the "Demo data" views (lite/airtable/views.md) in Airtable.
 */
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/config.js';
import { FakeAirtable } from '../demo/fake-airtable.js';
import { seed } from '../demo/fixtures.js';

type Fetch = (path: string, init: { method: string; body?: string }) => Promise<{ status: number; json: unknown }>;
const ORDER = ['contacts', 'properties', 'jobs', 'quotes'] as const;
const INVERSE = new Set(['Lite Jobs']);   // created by Airtable as the other side of a link; never written

/** The demo records per table, in creation order, with links still pointing at local ids. */
export function demoRecords(baseId: string, tables: Record<string, string>) {
  const at = new FakeAirtable(baseId, tables);
  seed(at);
  return ORDER.map((key) => ({ key, records: at.all(key).map((r) => ({ localId: r.id, fields: Object.fromEntries(Object.entries(r.fields).filter(([k]) => !INVERSE.has(k))) })) }));
}

export async function seedDemo(baseId: string, tables: Record<string, string>, fetchJson: Fetch, log: (s: string) => void = console.log) {
  for (const key of ORDER) {
    const r = await fetchJson(`/v0/${baseId}/${encodeURIComponent(tables[key]!)}?filterByFormula=${encodeURIComponent('{Demo Data}')}&pageSize=1`, { method: 'GET' });
    if (r.status !== 200) throw new Error(`${tables[key]!}: cannot read (HTTP ${r.status}). Do the Lite tables exist, and does the token cover this base?`);
    if (((r.json as { records?: unknown[] }).records ?? []).length) throw new Error(`refusing: ${tables[key]!} already holds Demo Data. Nothing was created.`);
  }
  const ids = new Map<string, string>();
  const created: Record<string, number> = {};
  for (const { key, records } of demoRecords(baseId, tables)) {
    for (let i = 0; i < records.length; i += 10) {
      const batch = records.slice(i, i + 10).map((rec) => ({ fields: Object.fromEntries(Object.entries(rec.fields).map(([k, v]) =>
        [k, Array.isArray(v) ? v.map((x: string) => { const real = ids.get(x); if (!real) throw new Error(`${key}.${k}: link to ${x} before it was created`); return real; }) : v])) }));
      const r = await fetchJson(`/v0/${baseId}/${encodeURIComponent(tables[key]!)}`, { method: 'POST', body: JSON.stringify({ typecast: false, records: batch }) });
      if (r.status !== 200) throw new Error(`${tables[key]!}: create failed (HTTP ${r.status}) ${JSON.stringify(r.json).slice(0, 300)}`);
      ((r.json as { records: { id: string }[] }).records).forEach((x, j) => ids.set(records[i + j]!.localId, x.id));
    }
    created[key] = records.length;
    log(`created ${records.length} demo records in ${tables[key]!}`);
  }
  return created;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, mode] = [process.argv[2], process.argv[3]];
  if (!file) { console.error('usage: seed-demo.ts lite/config/<client>.json [--apply]'); process.exit(1); }
  const config = loadConfig(file);
  if (mode !== '--apply') {
    console.log(`DRY RUN for base ${config.airtable.baseId} (nothing is created):`);
    for (const t of demoRecords(config.airtable.baseId, config.airtable.tables)) console.log(`  ${config.airtable.tables[t.key]}: ${t.records.length} synthetic records`);
  } else {
    const token = process.env.LITE_AIRTABLE_TOKEN;
    if (!token) { console.error('set LITE_AIRTABLE_TOKEN (data.records:read and data.records:write on this base)'); process.exit(1); }
    const fetchJson: Fetch = async (path, init) => {
      const res = await fetch(`https://api.airtable.com${path}`, { method: init.method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(init.body ? { body: init.body } : {}) });
      return { status: res.status, json: await res.json() };
    };
    seedDemo(config.airtable.baseId, config.airtable.tables, fetchJson).then((c) => { console.log('done:', JSON.stringify(c)); })
      .catch((e: unknown) => { console.error((e as Error).message); process.exitCode = 1; });
  }
}
