/**
 * Isolated staging (ops/staging/staging.ts), locally: a fake staging Airtable base (the production schema with every id
 * changed) is mapped, the staging migrations and n8n 10 are generated and validated, a fresh EMPTY database is loaded
 * from them with only synthetic seed data, a synthetic quote is sent, and the generated staging workflow (its real
 * nodes) publishes it to a scripted Airtable that knows only the staging ids. The originals are never touched, and the
 * guard refuses production-looking connections and databases. Nothing here talks to a cloud service.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { MIGRATIONS_DIR } from '../src/db/migrate.js';
import { buildMap, generate, guard, load, PROD_CREDENTIALS, syntheticQuote, validate, WORKFLOW_OUT, type Schema, type StagingMap } from '../ops/staging/staging.js';
import { TARGETS, freshDb, migratedDb } from './helpers/db.js';
import { recorded } from './helpers/n8n-sdk-shim.js';
import { N8nRun, type HttpRequest } from './helpers/n8n-runner.js';

type R = Record<string, unknown>;
const PROD = JSON.parse(readFileSync('ops/staging/production-airtable-schema.json', 'utf8')) as Schema;
const fake = (id: string) => `${id.slice(0, 3)}Z${createHash('sha256').update(id).digest('hex').slice(0, 13)}`;
/** The staging base as a structure-only duplicate would be: same tables and fields by name, every id new. */
const STAGING: Schema = { baseId: fake(PROD.baseId), tables: PROD.tables.map((t) => ({ id: fake(t.id), name: t.name, fields: t.fields.map((f) => ({ ...f, id: fake(f.id) })) })) };
const CREDS = { airtable: { id: 'StagingAirtab001', name: 'RoofOps STAGING Airtable' }, postgres: { id: 'StagingPostgr001', name: 'RoofOps STAGING Postgres' } };
const OUT = 'ops/staging/out/test';                       // gitignored; inside the project so the SDK alias resolves
const originals = () => readdirSync(MIGRATIONS_DIR).map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8')).join('\0') + readFileSync('n8n/10-airtable-quote-publish.sdk.ts', 'utf8');
const sid = (table: string, field?: string) => {
  const t = STAGING.tables.find((x) => x.name === table)!;
  return field ? t.fields.find((f) => f.name === field)!.id : t.id;
};

let map: StagingMap;
const before = originals();
beforeAll(() => {
  map = buildMap(PROD, STAGING, CREDS);
  generate(map, OUT);
});
afterAll(() => {
  expect(originals()).toBe(before);                        // the originals are never modified
  rmSync(OUT, { recursive: true, force: true });
});

describe('staging map and generated files', () => {
  it('maps every production id the sources use, by table and field name, one-to-one', () => {
    expect(map.staging_base).toBe(STAGING.baseId);
    expect(Object.keys(map.ids)).toHaveLength(1 + PROD.tables.length + PROD.tables.reduce((n, t) => n + t.fields.length, 0));
    expect(new Set(Object.values(map.ids)).size).toBe(Object.keys(map.ids).length);
  });

  it('refuses a map that is unsafe or incomplete', () => {
    expect(() => buildMap(PROD, PROD, CREDS)).toThrow(/production ids/);                                    // the production base itself
    const missing = structuredClone(STAGING); missing.tables.find((t) => t.name === 'Quotes')!.fields = missing.tables.find((t) => t.name === 'Quotes')!.fields.filter((f) => f.name !== 'Status');
    expect(() => buildMap(PROD, missing, CREDS)).toThrow(/Quotes\.Status/);
    const retyped = structuredClone(STAGING); retyped.tables.find((t) => t.name === 'Quotes')!.fields.find((f) => f.name === 'Version')!.type = 'singleLineText';
    expect(() => buildMap(PROD, retyped, CREDS)).toThrow(/Quotes\.Version.*type/);
    expect(() => buildMap(PROD, STAGING, { ...CREDS, airtable: PROD_CREDENTIALS.airtable })).toThrow(/PRODUCTION credential/);
  });

  it('the generated files carry no production id and differ from the originals only by ids (and the staging names)', () => {
    const r = validate(map, OUT);
    expect(r.migrations).toBe(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).length);
    expect(r.ids_replaced).toBeGreaterThan(500);
    const wf = readFileSync(join(OUT, WORKFLOW_OUT), 'utf8');
    expect(wf).toContain(`https://api.airtable.com/v0/${STAGING.baseId}`);
    expect(wf).toContain(`'[STAGING] 10 Airtable Quote Publish'`);
    expect(wf).toContain(CREDS.airtable.id); expect(wf).toContain(CREDS.postgres.id);
    expect(wf).not.toContain(PROD_CREDENTIALS.airtable.id); expect(wf).not.toContain(PROD.baseId);
  });

  it('validation catches a production id left behind, and any other change', () => {
    const f = join(OUT, 'migrations', readdirSync(join(OUT, 'migrations')).at(-1)!);
    const text = readFileSync(f, 'utf8');
    try {
      writeFileSync(f, text + `\n-- ${PROD.tables[0]!.fields[0]!.id}\n`);
      expect(() => validate(map, OUT)).toThrow(/still contains production/);
      writeFileSync(f, text.replace('create', 'CREATE'));
      expect(() => validate(map, OUT)).toThrow(/does not equal the original/);
    } finally { writeFileSync(f, text); }
    expect(() => validate(map, OUT)).not.toThrow();
  });
});

/** A scripted Airtable that knows ONLY the staging base and its ids; anything else is refused (as a scoped token would). */
class StagingAirtable {
  readonly tables = new Map<string, Map<string, { id: string; fields: R }>>();
  readonly requests: HttpRequest[] = [];
  private n = 0;
  readonly http = (req: HttpRequest) => {
    this.requests.push(req);
    const m = /^https:\/\/api\.airtable\.com\/v0\/(app\w+)\/(tbl\w+)(?:\/(rec\w+))?$/.exec(req.url);
    if (!m || m[1] !== STAGING.baseId || !STAGING.tables.some((t) => t.id === m[2])) return { statusCode: 403, body: { error: { type: 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND' } } };
    const t = m[2]!; if (!this.tables.has(t)) this.tables.set(t, new Map());
    const tab = this.tables.get(t)!;
    const known = new Set(STAGING.tables.find((x) => x.id === t)!.fields.map((f) => f.id));
    if (req.method === 'GET' && m[3]) { const r = tab.get(m[3]); return r ? { statusCode: 200, body: r } : { statusCode: 404, body: { error: 'NOT_FOUND' } }; }
    if (req.method === 'GET') {
      const byName = Object.fromEntries(STAGING.tables.find((x) => x.id === t)!.fields.map((f) => [f.name, f.id]));
      const conds = [...(req.query.filterByFormula ?? '').matchAll(/\{([^}]+)\}='([^']*)'/g)].map(([, name, v]) => [byName[name!], v] as const);
      return { statusCode: 200, body: { records: [...tab.values()].filter((r) => conds.some(([f, v]) => f && r.fields[f] === v)) } };
    }
    const body = req.body as { records: { fields: R }[]; performUpsert?: { fieldsToMergeOn: string[] } };
    for (const r of body.records) for (const k of Object.keys(r.fields)) if (!known.has(k)) return { statusCode: 422, body: { error: { type: 'UNKNOWN_FIELD_NAME', message: k } } };
    const recs = body.records.map((r) => {
      const hit = body.performUpsert ? [...tab.values()].find((x) => body.performUpsert!.fieldsToMergeOn.every((f) => x.fields[f] === r.fields[f])) : undefined;
      if (hit) { Object.assign(hit.fields, r.fields); return hit; }
      const rec = { id: `recS${String(++this.n).padStart(13, '0')}`, fields: { ...r.fields } };
      tab.set(rec.id, rec); return rec;
    });
    return { statusCode: 200, body: { records: recs } };
  };
}

describe.each(TARGETS)('a fresh staging database [%s]', (target) => {
  let db: Db & { url?: string };
  const secrets = mkdtempSync(join(tmpdir(), 'staging-secrets-'));
  beforeAll(async () => { db = await freshDb(target); }, 180_000);
  afterAll(async () => { await db.close(); rmSync(secrets, { recursive: true, force: true }); });

  it('loads from the generated migrations with only synthetic seed data; Sales runs; the staging n8n 10 publishes the quote to the staging base only', async () => {
    const loaded = await load(db, db.url ?? 'postgresql://postgres@127.0.0.1:5432/pglite', OUT, secrets);
    expect(loaded.applied).toBe(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).length);
    // Nothing but the schema, its settings and one synthetic login: no customer, quote, project or invoice data.
    expect((await db.query<R>(`select (select count(*)::int from customers) c, (select count(*)::int from quotes) q, (select count(*)::int from projects) p,
      (select count(*)::int from invoices) i, (select count(*)::int from external_links) l`))[0]).toEqual({ c: 0, q: 0, p: 0, i: 0, l: 0 });
    // Employees: the synthetic approver a migration seeds (20260929000800) and the synthetic staging estimator.
    expect(await db.query<R>(`select employee_code, full_name from employees order by 1`)).toEqual([
      { employee_code: 'EMP-900', full_name: 'Demo Finance Approver' }, { employee_code: 'EMP-901', full_name: 'Synthetic Staging Estimator' }]);
    // The database itself knows only staging ids.
    expect((await db.query<R>(`select count(*)::int n from field_contract where airtable_table_id not in (${STAGING.tables.map((t) => `'${t.id}'`).join(',')})`))[0]).toEqual({ n: 0 });

    const s = await syntheticQuote(db, `t${target}`, secrets);
    const payload = (await db.query<{ p: R }>('select payload p from outbox where idempotency_key = $1', [s.key]))[0]!.p;
    expect(Object.keys(payload.quote_fields as R).every((k) => k === sid('Quotes', 'RoofOps ID') || STAGING.tables.some((t) => t.fields.some((f) => f.id === k)))).toBe(true);

    // The generated staging workflow, its real nodes, against this database (as roofops_workflow) and the staging base.
    if (!recorded.nodes.has('Write To Publish')) {                // one import per test file (the module is cached)
      recorded.nodes.clear(); recorded.edges.length = 0;
      const file = `../${OUT}/${WORKFLOW_OUT}`;
      await import(/* @vite-ignore */ file);
    }
    expect(JSON.stringify(recorded.nodes.get('Find Quote'))).toContain(`/v0/${STAGING.baseId}/${sid('Quotes')}`);   // the staging workflow, not production
    expect(JSON.stringify([...recorded.nodes.values()])).not.toContain(PROD.baseId);
    const air = new StagingAirtable();
    const wdb = { query: async (q: string, p: unknown[] = []) => { await db.exec('set role roofops_workflow'); try { return await db.query(q, p); } finally { await db.exec('reset role'); } } } as unknown as Db;
    const run = new N8nRun(recorded.nodes, recorded.edges, { db: wdb, http: air.http });
    await run.run('Write To Publish', [{ json: { d: { writes: [{ key: s.key, quote_number: s.quote }] } } }], ['Proof Refused By Postgres']);
    expect(run.executed).toContain('Record Verified Publish');
    expect(run.executed).not.toContain('Record Publish Failure');
    expect((await db.query<R>(`select status, attempts::int a, result->>'quote_record_count' n, result->'quote_read_back'->>'status' st from outbox where idempotency_key = $1`, [s.key]))[0])
      .toEqual({ status: 'DONE', a: 1, n: '1', st: 'Sent' });
    expect(air.requests.every((r) => r.url.startsWith(`https://api.airtable.com/v0/${STAGING.baseId}/`))).toBe(true);
    const quotes = [...(air.tables.get(sid('Quotes'))?.values() ?? [])];
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.fields[sid('Quotes', 'Status')]).toBe('Sent');
    expect(quotes[0]!.fields[sid('Quotes', 'Quote Number')]).toBe(s.quote);
    expect(air.tables.get(sid('Customers'))?.size).toBe(1);
    expect(air.tables.get(sid('Properties'))?.size).toBe(1);
    expect((await db.query<R>(`select count(*)::int n from external_links where provider = 'AIRTABLE' and verified_at is not null`))[0]).toEqual({ n: 3 });
  });
});

describe('the staging guard finds the production project where Task 0.1 keeps it', () => {
  it('refuses the project hosted.env names (outside the repository), before connecting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-root-'));
    const envDir = mkdtempSync(join(tmpdir(), 'staging-envdir-'));
    try {
      writeFileSync(join(envDir, 'hosted.env'), 'SUPABASE_DB_URL=postgresql://postgres.prodprojectref03:x@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres\n');
      await expect(guard('postgresql://postgres.prodprojectref03:y@127.0.0.1:1/postgres', { localTest: true, envDir }, root)).rejects.toThrow(/PRODUCTION/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(envDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('the staging guard (local Postgres)', () => {
  it('refuses a connection that points at the production project, before connecting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-root-'));
    try {
      writeFileSync(join(root, '.env.local'), 'SUPABASE_DB_URL=postgresql://postgres.prodprojectref01:x@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres\n');
      await expect(guard('postgresql://postgres.prodprojectref01:y@127.0.0.1:1/postgres', { localTest: true }, root)).rejects.toThrow(/PRODUCTION/);
      mkdirSync(join(root, 'secrets'));
      writeFileSync(join(root, 'secrets/roofops-n8n-postgres.env'), 'PGUSER=roofops_n8n.prodprojectref02\n');
      await expect(guard('postgresql://postgres.prodprojectref02:y@127.0.0.1:1/postgres', { localTest: true }, root)).rejects.toThrow(/PRODUCTION/);
      await expect(guard('postgresql://postgres.stagingref:y@db.example.supabase.co:5432/postgres', { localTest: true }, root)).rejects.toThrow(/local-test only/);
      await expect(guard(process.env.TEST_DATABASE_URL!, { localTest: false }, root)).rejects.toThrow(/without --local-test/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a database that already has data and is not marked staging (as production is), and changes nothing in it', async () => {
    const prodLike = await migratedDb('postgres');
    try {
      await expect(guard(prodLike.url!, { localTest: true }, mkdtempSync(join(tmpdir(), 'r-')))).rejects.toThrow(/not marked staging/);
      expect((await prodLike.query<R>(`select count(*)::int n from information_schema.schemata where schema_name = 'roofops_env'`))[0]).toEqual({ n: 0 });
    } finally { await prodLike.close(); }
  });

  it('marks an empty database staging, then accepts it again (and only it)', async () => {
    const empty = await freshDb('postgres');
    try {
      const root = mkdtempSync(join(tmpdir(), 'r-'));
      const a = await guard(empty.url!, { localTest: true }, root); await a.close();
      const b = await guard(empty.url!, { localTest: true }, root); await b.close();
      expect((await empty.query<R>(`select env from roofops_env.marker`))).toEqual([{ env: 'staging' }]);
    } finally { await empty.close(); }
  });
});
