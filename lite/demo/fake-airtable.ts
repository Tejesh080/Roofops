/**
 * An in-memory Airtable for the Lite demo and tests: tables from lite/airtable/schema.json, addressed by NAME in the URL
 * (as the Lite workflows do), with list (filterByFormula, pages of at most 100 with an offset), create and update. It
 * refuses what real Airtable refuses with
 * typecast:false: unknown fields, a value that is not one of a single-select's options, more than 10 records per write,
 * a link to a record that does not exist. Formulas: AND, OR, NOT, FIND, LOWER, REGEX_REPLACE, BLANK(), TRUE(), FALSE(),
 * RECORD_ID(), =, !=, >, <, strings (with \' escapes), numbers and {Field}.
 */
import { readFileSync } from 'node:fs';

interface FieldDef { name: string; type: string; options?: string[]; linksTo?: string; inverseOf?: string }
interface TableDef { key: string; name: string; fields: FieldDef[] }
export interface Rec { id: string; createdTime: string; fields: Record<string, unknown> }
export interface Req { method: string; url: string; query: Record<string, string>; body?: unknown }
export interface Res { statusCode: number; body: unknown }

const SCHEMA = (JSON.parse(readFileSync('lite/airtable/schema.json', 'utf8')) as { tables: TableDef[] }).tables;

export class FakeAirtable {
  readonly tables = new Map<string, Map<string, Rec>>();
  readonly requests: Req[] = [];
  private n = 0;
  constructor(readonly baseId: string, private names: Record<string, string>) {
    for (const t of SCHEMA) this.tables.set(t.key, new Map());
  }
  private def(key: string) { return SCHEMA.find((t) => t.key === key)!; }
  private keyOfName(name: string) { return Object.entries(this.names).find(([, v]) => v === name)?.[0]; }
  table(key: string) { return this.tables.get(key)!; }
  all(key: string) { return [...this.table(key).values()]; }
  get(key: string, id: string) { return this.table(key).get(id); }

  /** Insert directly (fixtures), with the same field checks as the API. */
  insert(key: string, fields: Record<string, unknown>): Rec {
    const problem = this.check(key, fields);
    if (problem) throw new Error(`fixture for ${key}: ${problem}`);
    const rec = { id: `rec${String(++this.n).padStart(14, '0')}`, createdTime: new Date().toISOString(), fields: { ...fields } };
    this.table(key).set(rec.id, rec);
    this.syncInverses();
    return rec;
  }

  /** Airtable keeps both sides of a link: e.g. Lite Contacts > Lite Jobs lists every job whose Contact is that person. */
  private syncInverses() {
    for (const t of SCHEMA) for (const f of t.fields.filter((x) => x.inverseOf)) {
      const source = this.def(f.linksTo!);
      for (const rec of this.table(t.key).values()) {
        const ids = [...this.table(source.key).values()].filter((r) => ((r.fields[f.inverseOf!] as string[] | undefined) ?? []).includes(rec.id)).map((r) => r.id);
        if (ids.length) rec.fields[f.name] = ids; else rec.fields = Object.fromEntries(Object.entries(rec.fields).filter(([k]) => k !== f.name));
      }
    }
  }

  private check(key: string, fields: Record<string, unknown>): string | null {
    const def = this.def(key);
    for (const [k, v] of Object.entries(fields)) {
      const f = def.fields.find((x) => x.name === k);
      if (!f) return `UNKNOWN_FIELD_NAME "${k}" in ${def.name}`;
      if (v === null || v === undefined) continue;
      if (f.type === 'singleSelect' && (typeof v !== 'string' || !f.options!.includes(v))) return `INVALID_MULTIPLE_CHOICE_OPTIONS ${JSON.stringify(v)} for ${def.name}.${k}`;
      if (f.type === 'checkbox' && typeof v !== 'boolean') return `INVALID_VALUE_FOR_COLUMN ${def.name}.${k} expects a boolean`;
      if ((f.type === 'number' || f.type === 'currency') && typeof v !== 'number') return `INVALID_VALUE_FOR_COLUMN ${def.name}.${k} expects a number`;
      if (f.type === 'dateTime' && (typeof v !== 'string' || Number.isNaN(Date.parse(v)))) return `INVALID_VALUE_FOR_COLUMN ${def.name}.${k} expects a date`;
      if (f.type === 'multipleRecordLinks') {
        if (!Array.isArray(v)) return `INVALID_VALUE_FOR_COLUMN ${def.name}.${k} expects record ids`;
        for (const id of v) if (!this.table(f.linksTo!).has(String(id))) return `ROW_DOES_NOT_EXIST ${String(id)} for ${def.name}.${k}`;
      }
    }
    return null;
  }

  readonly http = (req: Req): Res => {
    this.requests.push(req);
    const m = /^https:\/\/api\.airtable\.com\/v0\/(app[A-Za-z0-9]{14})\/([^/?]+)$/.exec(req.url);
    if (!m || m[1] !== this.baseId) return { statusCode: 404, body: { error: { type: 'NOT_FOUND', message: 'base not found' } } };
    const key = this.keyOfName(decodeURIComponent(m[2]!));
    if (!key) return { statusCode: 404, body: { error: { type: 'TABLE_NOT_FOUND', message: decodeURIComponent(m[2]!) } } };
    const tab = this.table(key);
    if (req.method === 'GET') {
      let fn: (r: Rec) => boolean;
      try { fn = req.query.filterByFormula ? compile(req.query.filterByFormula) : () => true; }
      catch (e) { return { statusCode: 422, body: { error: { type: 'INVALID_FILTER_BY_FORMULA', message: (e as Error).message } } }; }
      // Pages of at most 100, as Airtable: an "offset" in the answer means there are more, fetched by sending it back.
      const size = Number(req.query.pageSize ?? 100);
      if (!(size >= 1 && size <= 100)) return { statusCode: 422, body: { error: { type: 'INVALID_PAGE_SIZE', message: 'pageSize must be 1 to 100' } } };
      const from = req.query.offset ? Number(/^itr(\d+)$/.exec(req.query.offset)?.[1] ?? NaN) : 0;
      if (Number.isNaN(from)) return { statusCode: 422, body: { error: { type: 'LIST_RECORDS_ITERATOR_NOT_AVAILABLE', message: 'invalid offset' } } };
      const all = [...tab.values()].filter(fn);
      const page = all.slice(from, from + size).map((r) => structuredClone(r));
      return { statusCode: 200, body: { records: page, ...(from + size < all.length ? { offset: `itr${from + size}` } : {}) } };
    }
    const body = req.body as { records?: { id?: string; fields: Record<string, unknown> }[]; typecast?: boolean } | undefined;
    if (!body || !Array.isArray(body.records) || !body.records.length) return { statusCode: 422, body: { error: { type: 'INVALID_REQUEST_MISSING_FIELDS', message: 'records' } } };
    if (body.records.length > 10) return { statusCode: 422, body: { error: { type: 'INVALID_RECORDS', message: 'at most 10 records per request' } } };
    for (const r of body.records) {
      const p = this.check(key, r.fields);
      if (p) return { statusCode: 422, body: { error: { type: p.split(' ')[0], message: p } } };
      if (req.method === 'PATCH' && (!r.id || !tab.has(r.id))) return { statusCode: 404, body: { error: { type: 'NOT_FOUND', message: `record ${r.id ?? '(none)'}` } } };
    }
    if (req.method === 'POST') return { statusCode: 200, body: { records: body.records.map((r) => this.insert(key, r.fields)) } };
    if (req.method === 'PATCH') {
      const recs = body.records.map((r) => {
        const rec = tab.get(r.id!)!;
        rec.fields = Object.fromEntries(Object.entries({ ...rec.fields, ...r.fields }).filter(([, v]) => v !== null && v !== undefined));   // null clears a field, as in Airtable
        return rec;
      });
      this.syncInverses();
      return { statusCode: 200, body: { records: recs.map((r) => structuredClone(r)) } };
    }
    return { statusCode: 405, body: { error: { type: 'METHOD_NOT_ALLOWED' } } };
  };
}

// ---- a small Airtable formula evaluator -------------------------------------------------------------------------------
type Tok = { t: 'str' | 'num' | 'field' | 'id' | 'op' | 'p'; v: string };
function lex(s: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') { let j = i + 1; let v = ''; while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; v += s[j] ?? ''; j++; } out.push({ t: 'str', v }); i = j + 1; continue; }
    if (c === '{') { const j = s.indexOf('}', i); out.push({ t: 'field', v: s.slice(i + 1, j) }); i = j + 1; continue; }
    if (/[0-9]/.test(c)) { let j = i; while (j < s.length && /[0-9.]/.test(s[j]!)) j++; out.push({ t: 'num', v: s.slice(i, j) }); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < s.length && /[A-Za-z_]/.test(s[j]!)) j++; out.push({ t: 'id', v: s.slice(i, j).toUpperCase() }); i = j; continue; }
    if (s.startsWith('!=', i)) { out.push({ t: 'op', v: '!=' }); i += 2; continue; }
    if ('=<>'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    if ('(),'.includes(c)) { out.push({ t: 'p', v: c }); i++; continue; }
    throw new Error(`unexpected "${c}" in formula`);
  }
  return out;
}
type Node = (r: Rec) => unknown;
function compile(src: string): (r: Rec) => boolean {
  const toks = lex(src); let p = 0;
  const peek = () => toks[p]; const eat = (v?: string) => { const t = toks[p++]; if (!t || (v && t.v !== v)) throw new Error(`formula: expected ${v ?? 'more'} at ${p}`); return t; };
  const value = (v: unknown): unknown => (Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : v);
  const primary = (): Node => {
    const t = eat();
    if (t.t === 'str') return () => t.v;
    if (t.t === 'num') return () => Number(t.v);
    if (t.t === 'field') return (r) => value(r.fields[t.v]);
    if (t.t === 'p' && t.v === '(') { const e = cmp(); eat(')'); return e; }
    if (t.t === 'id') {
      eat('('); const args: Node[] = [];
      if (peek()?.v !== ')') { args.push(cmp()); while (peek()?.v === ',') { eat(','); args.push(cmp()); } }
      eat(')');
      switch (t.v) {
        case 'AND': return (r) => args.every((a) => truthy(a(r)));
        case 'OR': return (r) => args.some((a) => truthy(a(r)));
        case 'NOT': return (r) => !truthy(args[0]!(r));
        case 'LOWER': return (r) => String(args[0]!(r)).toLowerCase();
        case 'FIND': return (r) => String(args[1]!(r)).indexOf(String(args[0]!(r))) + 1;
        case 'REGEX_REPLACE': return (r) => String(args[0]!(r)).replace(new RegExp(String(args[1]!(r)), 'g'), String(args[2]!(r)));
        case 'BLANK': return () => '';
        case 'TRUE': return () => true;
        case 'FALSE': return () => false;
        case 'RECORD_ID': return (r) => r.id;
        default: throw new Error(`formula function ${t.v} is not supported by the demo Airtable`);
      }
    }
    throw new Error(`formula: unexpected ${t.v}`);
  };
  const cmp = (): Node => {
    const a = primary();
    const op = peek();
    if (op?.t !== 'op') return a;
    p++; const b = primary();
    if (op.v === '=') return (r) => String(a(r)) === String(b(r));
    if (op.v === '!=') return (r) => String(a(r)) !== String(b(r));
    if (op.v === '>') return (r) => Number(a(r)) > Number(b(r));
    return (r) => Number(a(r)) < Number(b(r));
  };
  const e = cmp();
  if (p !== toks.length) throw new Error('formula: trailing input');
  return (r) => truthy(e(r));
}
const truthy = (v: unknown) => !(v === false || v === 0 || v === '' || v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)));
