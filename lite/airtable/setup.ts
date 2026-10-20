/**
 * Creates the RoofOps Lite tables (lite/airtable/schema.json) in an Airtable base through the Airtable Meta API.
 *
 *   npx tsx lite/airtable/setup.ts lite/config/<client>.json             DRY RUN: prints the plan, changes nothing
 *   npx tsx lite/airtable/setup.ts lite/config/<client>.json --verify    read-only: does the base already match?
 *   LITE_AIRTABLE_TOKEN=... npx tsx lite/airtable/setup.ts lite/config/<client>.json --apply
 *
 * --apply needs a personal access token with schema.bases:read + schema.bases:write on that base only (it is read from
 * the environment, never printed). It refuses if any Lite table already exists: it only ever creates, never changes or
 * deletes, so existing tables (including Advanced RoofOps ones) cannot be touched. Link fields are added after all
 * tables exist; Airtable creates the other side of each link itself (e.g. Lite Contacts > "Lite Jobs").
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/config.js';

interface FieldDef { name: string; type: string; options?: string[]; linksTo?: string; inverseOf?: string; primary?: boolean; description?: string }
interface TableDef { key: string; name: string; description: string; fields: FieldDef[] }
export interface Call { method: 'GET' | 'POST'; path: string; body?: unknown; note: string }
type Fetch = (path: string, init: { method: string; body?: string }) => Promise<{ status: number; json: unknown }>;

const SCHEMA = (JSON.parse(readFileSync('lite/airtable/schema.json', 'utf8')) as { tables: TableDef[] }).tables;

/** Airtable field options for a schema field (links get their table id later). */
export function fieldSpec(f: FieldDef, tableIds: Record<string, string> = {}) {
  const base: Record<string, unknown> = { name: f.name, type: f.type };
  if (f.description) base.description = f.description;
  switch (f.type) {
    case 'singleSelect': base.options = { choices: f.options!.map((name) => ({ name })) }; break;
    case 'checkbox': base.options = { icon: 'check', color: 'greenBright' }; break;
    case 'dateTime': base.options = { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'client' }; break;
    case 'currency': base.options = { precision: 2, symbol: '$' }; break;
    case 'number': base.options = { precision: 0 }; break;
    case 'multipleRecordLinks': base.options = { linkedTableId: tableIds[f.linksTo!] ?? `<id of ${f.linksTo!}>` }; break;
    default: break;
  }
  return base;
}

/** The calls --apply would make, in order (tables without links, then link fields). */
export function plan(baseId: string, tableIds: Record<string, string> = {}): Call[] {
  const calls: Call[] = [];
  for (const t of SCHEMA) {
    const fields = t.fields.filter((f) => f.type !== 'multipleRecordLinks');
    if (!fields[0]?.primary) throw new Error(`${t.name}: the first non-link field must be the primary field`);
    calls.push({ method: 'POST', path: `/v0/meta/bases/${baseId}/tables`, body: { name: t.name, description: t.description, fields: fields.map((f) => fieldSpec(f)) }, note: `create table ${t.name} (${fields.length} fields)` });
  }
  for (const t of SCHEMA) for (const f of t.fields.filter((x) => x.type === 'multipleRecordLinks' && !x.inverseOf)) {
    calls.push({ method: 'POST', path: `/v0/meta/bases/${baseId}/tables/<id of ${t.key}>/fields`, body: fieldSpec(f, tableIds), note: `link ${t.name}.${f.name} -> ${SCHEMA.find((x) => x.key === f.linksTo)!.name}` });
  }
  return calls;
}

/** Read-only: which Lite tables and fields are missing or different in the base. */
export async function verify(baseId: string, fetchJson: Fetch): Promise<string[]> {
  const r = await fetchJson(`/v0/meta/bases/${baseId}/tables`, { method: 'GET' });
  if (r.status !== 200) return [`could not read the base schema (HTTP ${r.status})`];
  const tables = (r.json as { tables: { name: string; fields: { name: string; type: string; options?: { choices?: { name: string }[] } }[] }[] }).tables;
  const problems: string[] = [];
  for (const t of SCHEMA) {
    const live = tables.find((x) => x.name === t.name);
    if (!live) { problems.push(`missing table ${t.name}`); continue; }
    for (const f of t.fields) {
      const lf = live.fields.find((x) => x.name === f.name);
      if (!lf) { problems.push(`${t.name}: missing field ${f.name}`); continue; }
      if (lf.type !== f.type) problems.push(`${t.name}.${f.name}: type ${lf.type}, expected ${f.type}`);
      for (const o of f.options ?? []) if (!lf.options?.choices?.some((c) => c.name === o)) problems.push(`${t.name}.${f.name}: missing option "${o}"`);
    }
  }
  return problems;
}

/** Creates the tables. Refuses when any Lite table already exists (it never changes an existing table). */
export async function apply(baseId: string, fetchJson: Fetch, log: (s: string) => void = console.log) {
  const r = await fetchJson(`/v0/meta/bases/${baseId}/tables`, { method: 'GET' });
  if (r.status !== 200) throw new Error(`could not read the base schema (HTTP ${r.status}): check the token's scopes`);
  const existing = (r.json as { tables: { name: string }[] }).tables.map((t) => t.name);
  const clash = SCHEMA.filter((t) => existing.includes(t.name)).map((t) => t.name);
  if (clash.length) throw new Error(`refusing: ${clash.join(', ')} already exist in this base. Nothing was changed. Use --verify to compare.`);
  const ids: Record<string, string> = {};
  for (const [i, call] of plan(baseId).entries()) {
    if (i < SCHEMA.length) {
      const t = SCHEMA[i]!;
      const res = await fetchJson(call.path, { method: 'POST', body: JSON.stringify(call.body) });
      if (res.status !== 200) throw new Error(`${call.note}: HTTP ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
      ids[t.key] = (res.json as { id: string }).id;
      log(`created ${t.name} (${ids[t.key]!})`);
    }
  }
  for (const t of SCHEMA) for (const f of t.fields.filter((x) => x.type === 'multipleRecordLinks' && !x.inverseOf)) {
    const res = await fetchJson(`/v0/meta/bases/${baseId}/tables/${ids[t.key]!}/fields`, { method: 'POST', body: JSON.stringify(fieldSpec(f, ids)) });
    if (res.status !== 200) throw new Error(`link ${t.name}.${f.name}: HTTP ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
    log(`linked ${t.name}.${f.name}`);
  }
  return ids;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, mode] = [process.argv[2], process.argv[3]];
  if (!file) { console.error('usage: setup.ts lite/config/<client>.json [--verify | --apply]'); process.exit(1); }
  const config = loadConfig(file);
  const token = process.env.LITE_AIRTABLE_TOKEN;
  const fetchJson: Fetch = async (path, init) => {
    if (!token) throw new Error('set LITE_AIRTABLE_TOKEN (schema.bases:read, plus schema.bases:write for --apply)');
    const res = await fetch(`https://api.airtable.com${path}`, { method: init.method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(init.body ? { body: init.body } : {}) });
    return { status: res.status, json: await res.json() };
  };
  (async () => {
    if (mode === '--apply') console.log('created:', JSON.stringify(await apply(config.airtable.baseId, fetchJson)));
    else if (mode === '--verify') { const p = await verify(config.airtable.baseId, fetchJson); console.log(p.length ? p.join('\n') : 'The base has every Lite table and field.'); }
    else { console.log(`DRY RUN for base ${config.airtable.baseId} (nothing is changed):`); for (const c of plan(config.airtable.baseId)) console.log(`  ${c.method} ${c.path}  ${c.note}`); }
  })().catch((e: unknown) => { console.error((e as Error).message); process.exitCode = 1; });
}
