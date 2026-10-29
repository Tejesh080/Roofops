/**
 * Creates the RoofOps Lite tables (lite/airtable/schema.json) in an Airtable base through the Airtable Meta API, under
 * the table names in the client's config.
 *
 *   npx tsx lite/airtable/setup.ts lite/config/<client>.json             DRY RUN: prints the plan, changes nothing
 *   npx tsx lite/airtable/setup.ts lite/config/<client>.json --verify    read-only: does the base already match?
 *   LITE_AIRTABLE_TOKEN=... npx tsx lite/airtable/setup.ts lite/config/<client>.json --apply
 *   LITE_AIRTABLE_TOKEN=... npx tsx lite/airtable/setup.ts lite/config/<client>.json --upgrade
 *
 * --apply / --upgrade need a personal access token with schema.bases:read + schema.bases:write on that base only (read
 * from the environment, never printed). --apply refuses if any Lite table already exists. --upgrade is for a base made by
 * an older Lite version: it only ADDS what is missing (tables, fields); it never changes, renames or deletes an existing
 * table or field. Choices missing from an existing single-select cannot be added through the API: they are listed for a
 * person to add in Airtable (field > Edit > Add option). Link fields are added after their tables exist; Airtable creates
 * the other side of each link itself, and the one back-link the workflows read ("Lite Jobs" on contacts) is given that name.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/config.js';

interface FieldDef { name: string; type: string; options?: string[]; linksTo?: string; inverseOf?: string; primary?: boolean; description?: string }
interface TableDef { key: string; name: string; description: string; fields: FieldDef[] }
export interface Call { method: 'GET' | 'POST'; path: string; body?: unknown; note: string }
type Fetch = (path: string, init: { method: string; body?: string }) => Promise<{ status: number; json: unknown }>;
type Names = Record<string, string>;
interface LiveField { id?: string; name: string; type: string; options?: { choices?: { name: string }[] } }
interface LiveTable { id: string; name: string; fields: LiveField[] }

export const SCHEMA = (JSON.parse(readFileSync('lite/airtable/schema.json', 'utf8')) as { tables: TableDef[] }).tables;
const DEFAULT_NAMES: Names = Object.fromEntries(SCHEMA.map((t) => [t.key, t.name]));
const nameOf = (names: Names, key: string) => names[key] ?? DEFAULT_NAMES[key]!;

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
const links = (t: TableDef) => t.fields.filter((x) => x.type === 'multipleRecordLinks' && !x.inverseOf);
/** The back-link the workflows read, for a link field: e.g. jobs.Contact -> contacts."Lite Jobs". */
const inverseFor = (t: TableDef, f: FieldDef) => SCHEMA.find((x) => x.key === f.linksTo)!.fields.find((x) => x.inverseOf === f.name && x.linksTo === t.key);

/** The calls --apply would make, in order (tables without links, then link fields). */
export function plan(baseId: string, tableIds: Record<string, string> = {}, names: Names = DEFAULT_NAMES): Call[] {
  const calls: Call[] = [];
  for (const t of SCHEMA) {
    const fields = t.fields.filter((f) => f.type !== 'multipleRecordLinks');
    if (!fields[0]?.primary) throw new Error(`${t.name}: the first non-link field must be the primary field`);
    calls.push({ method: 'POST', path: `/v0/meta/bases/${baseId}/tables`, body: { name: nameOf(names, t.key), description: t.description, fields: fields.map((f) => fieldSpec(f)) }, note: `create table ${nameOf(names, t.key)} (${fields.length} fields)` });
  }
  for (const t of SCHEMA) for (const f of links(t)) {
    calls.push({ method: 'POST', path: `/v0/meta/bases/${baseId}/tables/<id of ${t.key}>/fields`, body: fieldSpec(f, tableIds), note: `link ${nameOf(names, t.key)}.${f.name} -> ${nameOf(names, f.linksTo!)}` });
  }
  return calls;
}

async function readBase(baseId: string, fetchJson: Fetch): Promise<LiveTable[]> {
  const r = await fetchJson(`/v0/meta/bases/${baseId}/tables`, { method: 'GET' });
  if (r.status !== 200) throw new Error(`could not read the base schema (HTTP ${r.status}): check the token's scopes`);
  return (r.json as { tables: LiveTable[] }).tables;
}

/** Read-only: which Lite tables, fields and select options are missing or different in the base. */
export async function verify(baseId: string, fetchJson: Fetch, names: Names = DEFAULT_NAMES): Promise<string[]> {
  let tables: LiveTable[];
  try { tables = await readBase(baseId, fetchJson); } catch (e) { return [(e as Error).message]; }
  const problems: string[] = [];
  for (const t of SCHEMA) {
    const tn = nameOf(names, t.key);
    const live = tables.find((x) => x.name === tn);
    if (!live) { problems.push(`missing table ${tn}`); continue; }
    for (const f of t.fields) {
      const lf = live.fields.find((x) => x.name === f.name);
      if (!lf) { problems.push(`${tn}: missing field ${f.name}`); continue; }
      if (lf.type !== f.type) problems.push(`${tn}.${f.name}: type ${lf.type}, expected ${f.type}`);
      for (const o of f.options ?? []) if (!lf.options?.choices?.some((c) => c.name === o)) problems.push(`${tn}.${f.name}: missing option "${o}"`);
    }
  }
  return problems;
}

async function post(fetchJson: Fetch, path: string, body: unknown, what: string) {
  const res = await fetchJson(path, { method: 'POST', body: JSON.stringify(body) });
  if (res.status !== 200) throw new Error(`${what}: HTTP ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
  return res.json as { id: string; options?: { inverseLinkFieldId?: string } };
}

/** Adds one link field; names its back-link as the workflows expect when the table names differ from the defaults. */
async function addLink(baseId: string, fetchJson: Fetch, t: TableDef, f: FieldDef, ids: Record<string, string>, names: Names, log: (s: string) => void) {
  const made = await post(fetchJson, `/v0/meta/bases/${baseId}/tables/${ids[t.key]!}/fields`, fieldSpec(f, ids), `link ${nameOf(names, t.key)}.${f.name}`);
  log(`linked ${nameOf(names, t.key)}.${f.name}`);
  const inv = inverseFor(t, f);
  if (inv && inv.name !== nameOf(names, t.key) && made.options?.inverseLinkFieldId) {
    const res = await fetchJson(`/v0/meta/bases/${baseId}/tables/${ids[f.linksTo!]!}/fields/${made.options.inverseLinkFieldId}`, { method: 'PATCH', body: JSON.stringify({ name: inv.name }) });
    if (res.status !== 200) throw new Error(`name the back-link ${inv.name}: HTTP ${res.status}`);
    log(`named the back-link on ${nameOf(names, f.linksTo!)} "${inv.name}"`);
  }
}

/** Creates the tables. Refuses when any Lite table already exists (it never changes an existing table). */
export async function apply(baseId: string, fetchJson: Fetch, log: (s: string) => void = console.log, names: Names = DEFAULT_NAMES) {
  const existing = (await readBase(baseId, fetchJson)).map((t) => t.name);
  const clash = SCHEMA.map((t) => nameOf(names, t.key)).filter((n) => existing.includes(n));
  if (clash.length) throw new Error(`refusing: ${clash.join(', ')} already exist in this base. Nothing was changed. Use --verify to compare, or --upgrade to add what is missing.`);
  const ids: Record<string, string> = {};
  for (const [i, call] of plan(baseId, {}, names).entries()) {
    if (i >= SCHEMA.length) break;
    const t = SCHEMA[i]!;
    ids[t.key] = (await post(fetchJson, call.path, call.body, call.note)).id;
    log(`created ${nameOf(names, t.key)} (${ids[t.key]!})`);
  }
  for (const t of SCHEMA) for (const f of links(t)) await addLink(baseId, fetchJson, t, f, ids, names, log);
  return ids;
}

/**
 * Brings a base made by an older Lite version up to this schema by ADDING only: missing tables (with their links) and
 * missing fields. Returns what it created and the select options a person must add by hand.
 */
export async function upgrade(baseId: string, fetchJson: Fetch, log: (s: string) => void = console.log, names: Names = DEFAULT_NAMES) {
  const live = await readBase(baseId, fetchJson);
  const ids: Record<string, string> = {}; const created: string[] = []; const manual: string[] = [];
  for (const t of SCHEMA) {
    const lt = live.find((x) => x.name === nameOf(names, t.key));
    if (lt) { ids[t.key] = lt.id; continue; }
    const fields = t.fields.filter((f) => f.type !== 'multipleRecordLinks');
    ids[t.key] = (await post(fetchJson, `/v0/meta/bases/${baseId}/tables`, { name: nameOf(names, t.key), description: t.description, fields: fields.map((f) => fieldSpec(f)) }, `create table ${nameOf(names, t.key)}`)).id;
    created.push(`table ${nameOf(names, t.key)}`); log(`created ${nameOf(names, t.key)}`);
  }
  for (const t of SCHEMA) {
    const lt = live.find((x) => x.name === nameOf(names, t.key));
    for (const f of t.fields) {
      if (f.inverseOf) continue;   // made by Airtable with its link
      const lf = lt?.fields.find((x) => x.name === f.name);
      if (lf) {
        if (lf.type !== f.type) manual.push(`${nameOf(names, t.key)}.${f.name} is a ${lf.type} field, Lite expects ${f.type}: fix it by hand (not changed)`);
        for (const o of f.options ?? []) if (!lf.options?.choices?.some((c) => c.name === o)) manual.push(`${nameOf(names, t.key)}.${f.name}: add the option "${o}"`);
        continue;
      }
      if (lt && f.type !== 'multipleRecordLinks') {
        await post(fetchJson, `/v0/meta/bases/${baseId}/tables/${ids[t.key]!}/fields`, fieldSpec(f), `add ${nameOf(names, t.key)}.${f.name}`);
        created.push(`${nameOf(names, t.key)}.${f.name}`); log(`added ${nameOf(names, t.key)}.${f.name}`);
      } else if (f.type === 'multipleRecordLinks') { await addLink(baseId, fetchJson, t, f, ids, names, log); created.push(`${nameOf(names, t.key)}.${f.name}`); }
    }
  }
  return { created, manual };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, mode] = [process.argv[2], process.argv[3]];
  if (!file) { console.error('usage: setup.ts lite/config/<client>.json [--verify | --apply | --upgrade]'); process.exit(1); }
  const config = loadConfig(file);
  const names = config.airtable.tables as unknown as Names;
  const token = process.env.LITE_AIRTABLE_TOKEN;
  const fetchJson: Fetch = async (path, init) => {
    if (!token) throw new Error('set LITE_AIRTABLE_TOKEN (schema.bases:read, plus schema.bases:write for --apply / --upgrade)');
    const res = await fetch(`https://api.airtable.com${path}`, { method: init.method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(init.body ? { body: init.body } : {}) });
    return { status: res.status, json: await res.json() };
  };
  (async () => {
    if (mode === '--apply') console.log('created:', JSON.stringify(await apply(config.airtable.baseId, fetchJson, console.log, names)));
    else if (mode === '--upgrade') {
      const r = await upgrade(config.airtable.baseId, fetchJson, console.log, names);
      console.log(r.created.length ? `added: ${r.created.join(', ')}` : 'nothing to add');
      if (r.manual.length) console.log(`still to do by hand in Airtable:\n  - ${r.manual.join('\n  - ')}`);
    } else if (mode === '--verify') { const p = await verify(config.airtable.baseId, fetchJson, names); console.log(p.length ? p.join('\n') : 'The base has every Lite table, field and option.'); }
    else { console.log(`DRY RUN for base ${config.airtable.baseId} (nothing is changed):`); for (const c of plan(config.airtable.baseId, {}, names)) console.log(`  ${c.method} ${c.path}  ${c.note}`); }
  })().catch((e: unknown) => { console.error((e as Error).message); process.exitCode = 1; });
}
