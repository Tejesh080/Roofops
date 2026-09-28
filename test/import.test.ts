import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { loadBundle } from '../src/data/bundle.js';
import type { ScenarioManifest } from '../src/normalise/scenarios.js';
import { importBundle, type ImportResult } from '../src/import/importer.js';
import { DEMO_DATE } from '../src/config/demo.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';

const src = loadBundle('data/normalised');
const manifest = JSON.parse(readFileSync('data/normalised/scenario-manifest.json', 'utf8')) as ScenarioManifest;
const scenario = (k: string) => manifest[k]!.records;
const money = (x: string | number) => Number(x).toFixed(2);

describe.each(TARGETS)('bundle import [%s]', (target) => {
  let db: Db;
  let first: ImportResult;

  beforeAll(async () => {
    db = await migratedDb(target);
    first = await importBundle(db);
  });
  afterAll(async () => { await db.close(); });

  describe('volumes match the brief', () => {
    it('loads every canonical table in full', () => {
      expect(first.status).toBe('IMPORTED');
      if (first.status !== 'IMPORTED') return;
      expect(first.rowCounts).toMatchObject({
        customers: 40, properties: 52, quotes: 65, projects: 30, suppliers: 6, products: 45,
        purchase_orders: 35, invoices: 38, automation_events: 110, site_notes: 75, documents: 60,
        workflow_exceptions: 12, processed_events: 81,
      });
    });
  });

  describe('nothing is replaced: IDs, names, amounts, relationships', () => {
    it('keeps every source ID verbatim', async () => {
      const pairs: [string, string, string][] = [
        ['customers', 'customer_number', 'customer_id'], ['properties', 'property_number', 'property_id'],
        ['quotes', 'quote_number', 'quote_id'], ['projects', 'project_number', 'project_id'],
        ['suppliers', 'supplier_code', 'supplier_id'], ['products', 'product_code', 'product_id'],
        ['purchase_orders', 'po_number', 'po_id'], ['invoices', 'invoice_number', 'invoice_id'],
        ['documents', 'document_number', 'document_id'], ['site_notes', 'note_number', 'site_note_id'],
        ['workflow_exceptions', 'exception_number', 'exception_id'], ['automation_events', 'event_key', 'event_id'],
      ];
      const srcTable: Record<string, keyof typeof src> = {
        customers: 'customers', properties: 'properties', quotes: 'quotes', projects: 'projects', suppliers: 'suppliers',
        products: 'products', purchase_orders: 'purchase_orders', invoices: 'invoices', documents: 'documents',
        site_notes: 'site_notes', workflow_exceptions: 'workflow_exceptions', automation_events: 'project_events',
      };
      for (const [table, dbCol, srcCol] of pairs) {
        const ids = await col(db, `select ${dbCol} v from ${table} order by 1`);
        expect(ids, table).toEqual(src[srcTable[table]!].rows.map((r) => r[srcCol]!).sort());
      }
      const keys = await col(db, `select idempotency_key v from processed_events order by 1`);
      expect(keys).toEqual(src.processed_events.rows.map((r) => r.event_key!).sort());
    });

    it('keeps customer names, emails and phones exactly (including the trailing-space duplicate)', async () => {
      const rows = await db.query<{ n: string; name: string; email: string; phone: string }>(
        'select customer_number n, display_name name, email, phone from customers');
      const byId = new Map(rows.map((r) => [r.n, r]));
      for (const c of src.customers.rows) {
        expect(byId.get(c.customer_id!), c.customer_id).toEqual({ n: c.customer_id, name: c.customer_name, email: c.email, phone: c.phone });
      }
      expect(byId.get('CUST-0040')!.name).toBe('Chloe Bennett ');
    });

    it('keeps every quote amount exactly (GST-inclusive total)', async () => {
      const rows = await db.query<{ n: string; t: string; v: number }>(
        `select q.quote_number n, qv.total_inc_gst::text t, qv.version_number v from quotes q join quote_versions qv on qv.quote_id = q.id`);
      const byId = new Map(rows.map((r) => [r.n, r]));
      for (const q of src.quotes.rows) {
        expect(byId.get(q.quote_id!)!.t, q.quote_id).toBe(money(q.quote_amount_aud!));
        expect(byId.get(q.quote_id!)!.v).toBe(Number(q.quote_version));
      }
    });

    it('keeps every PO value (ex-GST) and invoice amount (GST-inclusive) exactly', async () => {
      const pos = new Map((await db.query<{ n: string; s: string }>('select po_number n, subtotal_ex_gst::text s from purchase_orders')).map((r) => [r.n, r.s]));
      for (const p of src.purchase_orders.rows) expect(pos.get(p.po_id!), p.po_id).toBe(money(p.po_value_aud!));
      const inv = new Map((await db.query<{ n: string; t: string }>('select invoice_number n, total_inc_gst::text t from invoices')).map((r) => [r.n, r.t]));
      for (const i of src.invoices.rows) expect(inv.get(i.invoice_id!), i.invoice_id).toBe(money(i.invoice_amount_aud!));
      const prices = new Map((await db.query<{ n: string; p: string; sku: string }>(
        `select p.product_code n, sp.list_price_ex_gst::text p, sp.supplier_sku sku from products p join supplier_products sp on sp.product_id = p.id`)).map((r) => [r.n, r]));
      for (const p of src.products.rows) expect(prices.get(p.product_id!)).toEqual({ n: p.product_id, p: money(p.unit_price_aud!), sku: p.supplier_sku });
    });

    it('keeps every relationship', async () => {
      const prj = await db.query<{ n: string; q: string; c: string; p: string; pm: string }>(`
        select pj.project_number n, q.quote_number q, c.customer_number c, pr.property_number p, e.full_name pm
        from projects pj join quotes q on q.id = pj.quote_id join customers c on c.id = pj.customer_id
        join properties pr on pr.id = pj.property_id join employees e on e.id = pj.project_manager_id`);
      const byId = new Map(prj.map((r) => [r.n, r]));
      for (const p of src.projects.rows) {
        expect(byId.get(p.project_id!)).toEqual({ n: p.project_id, q: p.quote_id, c: p.customer_id, p: p.property_id, pm: p.project_manager });
      }
      const po = await db.query<{ n: string; s: string; p: string }>(`
        select po.po_number n, s.supplier_code s, pj.project_number p from purchase_orders po
        join suppliers s on s.id = po.supplier_id join projects pj on pj.id = po.project_id`);
      for (const p of src.purchase_orders.rows) expect(po.find((r) => r.n === p.po_id)).toEqual({ n: p.po_id, s: p.supplier_id, p: p.project_id });
      const owners = await db.query<{ p: string; c: string }>(`select pr.property_number p, c.customer_number c
        from customer_properties cp join properties pr on pr.id = cp.property_id join customers c on c.id = cp.customer_id where cp.relationship = 'OWNER'`);
      for (const p of src.properties.rows) expect(owners.find((o) => o.p === p.property_id)?.c).toBe(p.customer_id);
    });

    it('stores the normalised dates exactly', async () => {
      const rows = await db.query<{ n: string; s: string; c: string; a: string | null }>(
        `select project_number n, planned_start_date::text s, planned_completion_date::text c, actual_start_date::text a from projects`);
      for (const p of src.projects.rows) {
        expect(rows.find((r) => r.n === p.project_id)).toEqual({ n: p.project_id, s: p.planned_start_date, c: p.planned_completion_date, a: p.actual_start_date || null });
      }
    });

    it('keeps every source row verbatim in staging (nothing is lost, even derived columns)', async () => {
      expect(await col(db, `select materials_status v from staging.projects where project_id = 'PRJ-2026-0013'`)).toEqual(['Delivery After Planned Start']);
      expect(Number((await col(db, 'select count(*) v from staging.date_changes'))[0])).toBeGreaterThan(100);
    });

    it('site note text, document file names and exception messages are unchanged', async () => {
      const notes = new Map((await db.query<{ n: string; b: string }>('select note_number n, body b from site_notes')).map((r) => [r.n, r.b]));
      for (const s of src.site_notes.rows) expect(notes.get(s.site_note_id!)).toBe(s.note_text);
      const docs = new Map((await db.query<{ n: string; f: string }>('select document_number n, file_name f from documents')).map((r) => [r.n, r.f]));
      for (const d of src.documents.rows) expect(docs.get(d.document_id!)).toBe(d.file_name);
      const exc = new Map((await db.query<{ n: string; m: string }>('select exception_number n, error_message m from workflow_exceptions')).map((r) => [r.n, r.m]));
      for (const x of src.workflow_exceptions.rows) expect(exc.get(x.exception_id!)).toBe(x.error_message);
    });

    it('uses only reserved example domains for every email', async () => {
      const emails = await col(db, `select email v from customers union all select orders_email from suppliers union all select email from employees`);
      expect(emails.length).toBeGreaterThan(40);
      for (const e of emails) expect(e, e).toMatch(/@([a-z0-9-]+\.)*example\.(com|org|net)$/);
    });

    it('marks integration identities as MOCK (the bundle IDs are demo placeholders)', async () => {
      expect(await col(db, `select distinct is_mock::text v from external_links`)).toEqual(['true']);
      expect(Number((await col(db, `select count(*) v from external_links where provider = 'XERO'`))[0])).toBe(src.invoices.rows.filter((i) => i.xero_invoice_id).length);
    });
  });

  describe('planted scenarios are reproduced by the derived views, from facts alone', () => {
    it('3 delayed projects', async () => {
      expect(await col(db, `select project_number v from v_project_risk where is_delayed order by 1`)).toEqual(scenario('DELAYED_PROJECT'));
    });
    it('2 projects awaiting supplier acknowledgement', async () => {
      // the tag is planted on both the projects and their POs
      expect(await col(db, `select project_number v from v_project_risk where supplier_ack_overdue order by 1`))
        .toEqual(scenario('SUPPLIER_ACK_PENDING').filter((id) => id.startsWith('PRJ-')));
      expect(await col(db, `select v.po_number v from v_purchase_order_status v join projects p on p.id = v.project_id
                             where v.ack_overdue and p.status not in ('COMPLETED','CLOSED','CANCELLED') order by 1`))
        .toEqual(scenario('SUPPLIER_ACK_PENDING').filter((id) => id.startsWith('PO-')));
    });
    it('KNOWN SOURCE DISCREPANCY: completed projects still have POs the supplier never acknowledged (status, not dates; left as supplied)', async () => {
      expect(await col(db, `select v.po_number v from v_purchase_order_status v join projects p on p.id = v.project_id
                             where p.status = 'COMPLETED' and v.status in ('DRAFT','APPROVED','SENT') order by 1`))
        .toEqual(['PO-2026-0001', 'PO-2026-0002', 'PO-2026-0004', 'PO-2026-0005', 'PO-2026-0006', 'PO-2026-0008',
                  'PO-2026-0032', 'PO-2026-0033', 'PO-2026-0035']);
    });
    it('1 completed project missing completion documentation', async () => {
      expect(await col(db, `select project_number v from v_projects_missing_completion_docs order by 1`)).toEqual(scenario('MISSING_COMPLIANCE_PHOTOS'));
    });
    it('1 accepted quote whose project creation failed', async () => {
      expect(await col(db, `select quote_number v from v_accepted_quotes_without_project`)).toEqual(scenario('ACCEPTED_QUOTE_PROJECT_CREATION_FAILED'));
    });
    it('2 overdue invoices', async () => {
      expect(await col(db, `select invoice_number v from v_invoice_balances where is_overdue order by 1`)).toEqual(scenario('OVERDUE_INVOICE'));
    });
    it('1 duplicate customer candidate (found by normalised phone, stored as an open pair)', async () => {
      expect(await col(db, `select unnest(array[customer_a, customer_b]) v from v_open_duplicate_customers order by 1`)).toEqual(scenario('DUPLICATE_CUSTOMER_CANDIDATE'));
      expect(await col(db, `select string_agg(customer_number, ',' order by customer_number) v from customers group by phone_normalised having count(*) > 1`))
        .toEqual([scenario('DUPLICATE_CUSTOMER_CANDIDATE').join(',')]);
    });
    it('1 delayed supplier delivery', async () => {
      expect(await col(db, `select po.po_number v from purchase_orders po join projects p on p.id = po.project_id
                             where po.status = 'ACKNOWLEDGED' and po.expected_delivery_date > p.planned_start_date and p.actual_start_date is null`))
        .toEqual(scenario('SUPPLIER_DELIVERY_DELAY'));
    });
    it('1 quote with missing inspection information', async () => {
      expect(await col(db, `select quote_number v from v_quotes_missing_measurement`)).toEqual(scenario('MISSING_INSPECTION_MEASUREMENT'));
    });
    it('1 job scheduled before materials arrive', async () => {
      expect(await col(db, `select project_number v from v_project_risk where materials_after_start`)).toEqual(scenario('JOB_BEFORE_MATERIALS'));
    });
    it('1 unresolved automation exception', async () => {
      expect(await col(db, `select exception_number v from workflow_exceptions where resolution_status = 'OPEN'`)).toEqual(scenario('OPEN_WORKFLOW_EXCEPTION'));
    });
    it('KNOWN SOURCE DISCREPANCY: the UNRESOLVED_AUTOMATION_EXCEPTION tag is on PRJ-2026-0016, but the open exception is on PRJ-2026-0008', async () => {
      // Reported for review, deliberately not "fixed": only dates may be corrected.
      expect(scenario('UNRESOLVED_AUTOMATION_EXCEPTION')).toEqual(['PRJ-2026-0016']);
      expect(await col(db, `select business_reference v from workflow_exceptions where resolution_status = 'OPEN'`)).toEqual(['PRJ-2026-0008']);
    });
    it('duplicate webhook fixture: blocked delivery linked to its original, plus its idempotency ledger entry', async () => {
      const [dup] = await db.query<{ key: string; status: string; cls: string; cause: string }>(`
        select d.event_key key, d.status, d.error_class cls, o.event_key cause
        from automation_events d join automation_events o on o.event_id = d.causation_id where d.status = 'DUPLICATE_IGNORED'`);
      expect(dup).toEqual({ key: 'EVT-DUP-0001', status: 'DUPLICATE_IGNORED', cls: 'DUPLICATE_EVENT', cause: 'EVT-00005' });
      expect(await col(db, `select idempotency_key v from processed_events where idempotency_key like 'quote.accepted:%'`)).toEqual(['quote.accepted:Q-2026-0005']);
    });
    it('rate-limit, timeout, validation, schema, auth and ambiguous-write exception fixtures exist and carry the right retry policy', async () => {
      const rows = await db.query<{ c: string; r: boolean }>(`select error_class c, retryable r from workflow_exceptions order by exception_number`);
      const byClass = Object.fromEntries(rows.map((x) => [x.c, x.r]));
      expect(byClass).toMatchObject({ RATE_LIMITED: true, TIMEOUT: true, VALIDATION_ERROR: false, SCHEMA_MISMATCH: false, AUTH_FAILURE: false, AMBIGUOUS_WRITE: false });
    });
    it('risk view explains every at-risk project with named reasons', async () => {
      const rows = await db.query<{ n: string; reasons: string[] }>(`select project_number n, risk_reasons reasons from v_project_risk where risk_level = 'HIGH' order by 1`);
      expect(rows.map((r) => r.n)).toEqual(['PRJ-2026-0010', 'PRJ-2026-0011', 'PRJ-2026-0013', 'PRJ-2026-0015', 'PRJ-2026-0018', 'PRJ-2026-0020']);
      for (const r of rows) expect(r.reasons.length).toBeGreaterThan(0);
      expect(await col(db, `select project_number v from v_project_risk where risk_level = 'HIGH' and starts_next_week order by 1`))
        .toEqual(['PRJ-2026-0010', 'PRJ-2026-0013', 'PRJ-2026-0018']);
    });
  });

  describe('import safety', () => {
    it('pins the business date to the demo date', async () => {
      expect(await col(db, `select app_today()::text v`)).toEqual([DEMO_DATE]);
    });

    it('is idempotent: importing the same dataset again changes nothing', async () => {
      const before = await col(db, `select count(*)::text v from audit_events union all select count(*)::text from projects`);
      const again = await importBundle(db);
      expect(again.status).toBe('SKIPPED_ALREADY_IMPORTED');
      expect(await col(db, `select count(*)::text v from audit_events union all select count(*)::text from projects`)).toEqual(before);
    });

    it('records the import in the audit trail and the chain verifies', async () => {
      expect(await col(db, `select action v from audit_events`)).toEqual(['data.import']);
      expect(await col(db, `select coalesce(verify_audit_chain()::text, 'intact') v`)).toEqual(['intact']);
    });

    it('continues friendly IDs after the imported ones', async () => {
      await db.exec('begin');
      expect(await col(db, `select next_friendly_id('PRJ', 2026) v union all select next_friendly_id('Q', 2026) union all select next_friendly_id('PO', 2026) union all select next_friendly_id('EXC')`))
        .toEqual(['PRJ-2026-0031', 'Q-2026-0066', 'PO-2026-0036', 'EXC-0013']);
      await db.exec('rollback');
    });
  });
});

describe.each(TARGETS)('import atomicity [%s]', (target) => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'roofops-bad-')); cpSync('data/normalised', dir, { recursive: true }); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('refuses files that do not match MANIFEST.json', async () => {
    const db = await migratedDb(target);
    try {
      writeFileSync(join(dir, 'invoices.csv'), readFileSync(join(dir, 'invoices.csv'), 'utf8').replace('3860.76', '3860.77'));
      await expect(importBundle(db, dir)).rejects.toThrow(/does not match MANIFEST/);
      expect(await col(db, 'select count(*)::text v from customers')).toEqual(['0']);
    } finally { await db.close(); }
  });

  it('rolls back completely when any row is invalid (all-or-nothing)', async () => {
    const db = await migratedDb(target);
    try {
      // Corrupt one project status AFTER staging validation would pass: the transform must fail and undo everything.
      cpSync('data/normalised', dir, { recursive: true });
      const p = join(dir, 'projects.csv');
      writeFileSync(p, readFileSync(p, 'utf8').replace('PRJ-2026-0030,Q-2026-0030,CUST-0030,PROP-0030,Materials Pending', 'PRJ-2026-0030,Q-2026-0030,CUST-0030,PROP-0030,Teleported'));
      const { writeNormalisedManifestFor } = await import('./helpers/manifest.js');
      writeNormalisedManifestFor(dir);
      await expect(importBundle(db, dir)).rejects.toThrow(/check constraint/);
      expect(await col(db, `select (select count(*) from customers) + (select count(*) from import_batches) + (select count(*) from audit_events) v`)).toEqual(['0']);
    } finally { await db.close(); }
  });
});
