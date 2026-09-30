import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { HOSTED, TARGETS, migratedDb, openHosted, type Target } from './helpers/db.js';

const E1 = '00000000-0000-0000-0000-00000000e001', E2 = '00000000-0000-0000-0000-00000000e002';
const C1 = '00000000-0000-0000-0000-0000000000c1', C2 = '00000000-0000-0000-0000-0000000000c2';
const P1 = '00000000-0000-0000-0000-0000000000a1', Q1 = '00000000-0000-0000-0000-0000000000f1', V1 = '00000000-0000-0000-0000-0000000000b1';
const S1 = '00000000-0000-0000-0000-0000000000d1', PR1 = '00000000-0000-0000-0000-0000000000e9', PO1 = '00000000-0000-0000-0000-000000000901';
const INV1 = '00000000-0000-0000-0000-000000000801', PJ1 = '00000000-0000-0000-0000-000000000701';

const ALL: Target[] = HOSTED ? [...TARGETS, 'hosted'] : TARGETS;

// Every check touches only rows it created (by id), inside one transaction that is rolled
// back, so the same suite runs on an empty DB and on the loaded hosted DB without leaving a trace.
describe.each(ALL)('schema constraints [%s]', (target) => {
  let db: Db;

  async function rejects(sql: string, pattern: RegExp): Promise<void> {
    await db.exec('savepoint t');
    try {
      await db.exec(sql);
    } catch (e) {
      await db.exec('rollback to savepoint t');
      expect((e as Error).message).toMatch(pattern);
      return;
    }
    await db.exec('rollback to savepoint t');
    throw new Error(`expected rejection: ${sql.slice(0, 80)}`);
  }
  const one = async <T>(sql: string) => (await db.query<T>(sql))[0]!;

  beforeAll(async () => {
    db = target === 'hosted' ? await openHosted() : await migratedDb(target);
    await db.exec('begin');   // whole suite runs in one transaction (savepoints per rejection), rolled back at the end
    await db.exec(`
      insert into employees(id,employee_code,full_name,email,role) values
        ('${E1}','EMP-901','Test PM','pm@example.com','PROJECT_MANAGER'),
        ('${E2}','EMP-902','Test Finance','fin@example.com','FINANCE');
      insert into customers(id,customer_number,customer_type,display_name,email,phone) values
        ('${C1}','CUST-9001','RESIDENTIAL','Test Customer','t@example.com','0400 111 222'),
        ('${C2}','CUST-9002','RESIDENTIAL','Other Customer','o@example.com',null);
      insert into properties(id,property_number,address_line1,suburb,state,postcode,property_type) values
        ('${P1}','PROP-9001','1 Example St','Bundaberg','QLD','4670','DETACHED_HOUSE');
      insert into quotes(id,quote_number,customer_id,property_id,job_type,status,created_on,sent_on) values
        ('${Q1}','Q-2026-9001','${C1}','${P1}','LEAK_REPAIR','SENT','2026-09-01','2026-09-02');
      insert into quote_versions(id,quote_id,version_number,line_amount_type) values ('${V1}','${Q1}',1,'INCLUSIVE');
      insert into quote_version_lines(quote_version_id,line_no,line_kind,description,quantity,unit,unit_price)
        values ('${V1}',1,'SUMMARY','Leak repair',1,'LOT',1100.00);
      update quotes set status='ACCEPTED', accepted_version_id='${V1}', accepted_on='2026-09-05' where id='${Q1}';
      insert into projects(id,project_number,quote_id,accepted_quote_version_id,customer_id,property_id)
        values ('${PJ1}','PRJ-2026-9001','${Q1}','${V1}','${C1}','${P1}');
      insert into suppliers(id,supplier_code,name) values ('${S1}','SUP-901','Test Supplier');
      insert into products(id,product_code,name,unit) values ('${PR1}','PROD-9001','Screws','PACK');
    `);
  });
  afterAll(async () => { await db.exec('rollback'); await db.close(); });

  it('issues sequential friendly IDs', async () => {
    const r = await one<{ a: string; b: string; c: string }>(`select next_friendly_id('TST',2026) a, next_friendly_id('TST',2026) b, next_friendly_id('TSTC') c`);
    expect(r).toEqual({ a: 'TST-2026-0001', b: 'TST-2026-0002', c: 'TSTC-0001' });
  });

  it('stable_uuid is deterministic, distinct per kind, and RFC 9562 v8 shaped', async () => {
    const r = await one<{ a: string; b: string; c: string }>(`select stable_uuid('quote','Q-2026-0001')::text a, stable_uuid('quote','Q-2026-0001')::text b, stable_uuid('project','Q-2026-0001')::text c`);
    expect(r.a).toBe(r.b);
    expect(r.a).not.toBe(r.c);
    expect(r.a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('derives GST from a GST-inclusive quote amount without changing it', async () => {
    const v = await one<{ s: string; g: string; t: string }>(`select subtotal_ex_gst::text s, gst_amount::text g, total_inc_gst::text t from quote_versions where id='${V1}'`);
    expect(v).toEqual({ s: '1000.00', g: '100.00', t: '1100.00' });
  });

  it('freezes an accepted quote version (changes must become variations)', async () => {
    await rejects(`update quote_version_lines set unit_price = 1.00 where quote_version_id='${V1}'`, /accepted and immutable/);
    await rejects(`insert into quote_version_lines(quote_version_id,line_no,line_kind,description,quantity,unit,unit_price) values ('${V1}',2,'OTHER','x',1,'LOT',5)`, /accepted and immutable/);
  });

  it('allows only one project per quote', async () => {
    await rejects(`insert into projects(project_number,quote_id,accepted_quote_version_id,customer_id,property_id)
                   values ('PRJ-2026-9002','${Q1}','${V1}','${C1}','${P1}')`, /projects_quote_id_key|unique/);
  });

  it("rejects a project whose customer differs from its quote's", async () => {
    await rejects(`update projects set customer_id='${C2}' where id='${PJ1}'`, /foreign key/);
  });

  it('rejects an ACCEPTED quote without an accepted version, and accepted-before-sent', async () => {
    await rejects(`insert into quotes(quote_number,customer_id,property_id,job_type,status,created_on,sent_on,accepted_on)
                   values ('Q-2026-9009','${C1}','${P1}','LEAK_REPAIR','ACCEPTED','2026-09-01','2026-09-01','2026-09-02')`, /check/);
    await rejects(`insert into quotes(quote_number,customer_id,property_id,job_type,status,created_on,sent_on)
                   values ('Q-2026-9010','${C1}','${P1}','LEAK_REPAIR','SENT','2026-09-05','2026-09-01')`, /check/);
  });

  it('derives PO totals from lines (ex-GST) and ignores forged totals', async () => {
    await db.exec(`insert into purchase_orders(id,po_number,supplier_id,idempotency_key) values ('${PO1}','PO-2026-9001','${S1}','po:create:9001');
      insert into purchase_order_lines(purchase_order_id,line_no,line_kind,product_id,description,quantity,unit,unit_price) values
        ('${PO1}',1,'ITEM','${PR1}','Screws',3,'PACK',33.33), ('${PO1}',2,'ITEM','${PR1}','Screws',1.5,'PACK',10.01),
        ('${PO1}',3,'FREIGHT',null,'Freight',1,'LOT',50.00)`);
    const po = await one<{ s: string; g: string; t: string; v: number }>(`select subtotal_ex_gst::text s, gst_amount::text g, total_inc_gst::text t, record_version v from purchase_orders where id='${PO1}'`);
    expect({ s: po.s, g: po.g, t: po.t }).toEqual({ s: '165.01', g: '16.50', t: '181.51' });
    await db.exec(`update purchase_orders set total_inc_gst = 1, subtotal_ex_gst = 1 where id='${PO1}'`);
    expect((await one<{ t: string }>(`select total_inc_gst::text t from purchase_orders where id='${PO1}'`)).t).toBe('181.51');
  });

  it('bumps PO record_version when a line changes (stale approvals are detectable)', async () => {
    const before = (await one<{ v: number }>(`select record_version v from purchase_orders where id='${PO1}'`)).v;
    await db.exec(`update purchase_order_lines set quantity = 4 where purchase_order_id='${PO1}' and line_no = 1`);
    const after = await one<{ v: number; t: string }>(`select record_version v, total_inc_gst::text t from purchase_orders where id='${PO1}'`);
    expect(after.v).toBeGreaterThan(before);
    expect(after.t).toBe('218.17');
  });

  it('rejects a duplicate PO idempotency key', async () => {
    await rejects(`insert into purchase_orders(po_number,supplier_id,idempotency_key) values ('PO-2026-9002','${S1}','po:create:9001')`, /unique/);
  });

  it('requires approval metadata for RoofOps POs, but not for IMPORT legacy records', async () => {
    await rejects(`update purchase_orders set status='SENT', sent_at=now() where id='${PO1}'`, /check/);
    await db.exec(`insert into purchase_orders(po_number,supplier_id,record_origin,status) values ('PO-2026-9003','${S1}','IMPORT','SENT')`);
  });

  it('derives invoice totals and blocks issuing without approval', async () => {
    await db.exec(`insert into invoices(id,invoice_number,project_id,customer_id,idempotency_key)
                   select '${INV1}','INV-2026-9001',id,customer_id,'inv:create:9001' from projects where id='${PJ1}';
                   insert into invoice_lines(invoice_id,line_no,description,quantity,unit_price) values ('${INV1}',1,'Final',1,13580.24)`);
    const inv = await one<{ s: string; g: string; t: string }>(`select subtotal_ex_gst::text s, gst_amount::text g, total_inc_gst::text t from invoices where id='${INV1}'`);
    expect(inv).toEqual({ s: '12345.67', g: '1234.57', t: '13580.24' });
    await rejects(`update invoices set status='ISSUED', issue_date='2026-09-29', due_date='2026-10-13' where id='${INV1}'`, /check/);
    await rejects(`insert into invoices(invoice_number,project_id,customer_id,idempotency_key) select 'INV-2026-9002',id,customer_id,'inv:create:9001' from projects where id='${PJ1}'`, /unique/);
  });

  it('idempotency ledger: first claim wins, second gets nothing', async () => {
    await db.exec(`insert into automation_events(event_id,correlation_id,event_type,actor_type,source,occurred_at,status)
                   values ('00000000-0000-0000-0000-00000000aa01',gen_random_uuid(),'quote.accepted','SYSTEM','test',now(),'RECEIVED')`);
    const claim = `insert into processed_events(consumer,idempotency_key,first_event_id,request_hash,status,lease_expires_at)
      values ('quote_to_project@1','quote.accepted:Q-2026-9001:v1','00000000-0000-0000-0000-00000000aa01','h1','PROCESSING',now()+interval '30 seconds')
      on conflict do nothing returning 1 as won`;
    expect(await db.query(claim)).toHaveLength(1);
    expect(await db.query(claim)).toHaveLength(0);
    await rejects(`update processed_events set status='COMPLETED', completed_at=now() where consumer='quote_to_project@1'`, /check/);
  });

  it('audit trail is append-only and hash-chained', async () => {
    await db.exec(`insert into audit_events(actor_type,actor_id,action,entity_type,entity_id) values ('SYSTEM','test','project.create','project',gen_random_uuid());
                   insert into audit_events(actor_type,actor_id,action,entity_type,entity_id) values ('USER','EMP-901','po.approve','purchase_order',gen_random_uuid())`);
    const rows = await db.query<{ prev_hash: string | null; row_hash: string }>(`select prev_hash, row_hash from audit_events where actor_id in ('test','EMP-901') order by seq`);
    expect(rows[1]!.prev_hash).toBe(rows[0]!.row_hash);
    expect((await one<{ b: string | null }>('select verify_audit_chain() b')).b).toBeNull();
    await rejects(`update audit_events set reason='tamper' where actor_id = 'test'`, /append-only/);
    await rejects(`delete from audit_events where actor_id = 'test'`, /append-only/);
  });

  it('audit hash does not depend on the session time zone', async () => {
    await db.exec(`set time zone 'America/New_York'`);
    expect((await one<{ b: string | null }>('select verify_audit_chain() b')).b).toBeNull();
    await db.exec(`set time zone 'UTC'`);
  });

  it('enforces the remaining relational rules', async () => {
    await rejects(`insert into documents(document_number,document_type,title,file_name,mime_type,storage_provider,storage_ref)
                   values ('DOC-9001','OTHER','x','x.pdf','application/pdf','NOT_STORED','m/1')`, /check/);
    await rejects(`insert into approvals(approval_number,action_type,entity_type,entity_id,requested_by_actor_type,requested_by_employee_id,required_permission,action_payload,payload_hash,expected_record_version,idempotency_key,expires_at)
                   values ('APR-2026-9001','CREATE_INVOICE','invoice',gen_random_uuid(),'AI','${E1}','invoice.create','{}','h',1,'k2',now()+interval '1 day')`, /check/);
    await rejects(`insert into approvals(approval_number,action_type,entity_type,entity_id,requested_by_actor_type,requested_by_employee_id,required_permission,action_payload,payload_hash,expected_record_version,idempotency_key,status,decided_by,decided_at,expires_at)
                   values ('APR-2026-9002','SEND_PURCHASE_ORDER','purchase_order',gen_random_uuid(),'USER','${E1}','po.send','{}','h',1,'k1','REJECTED','${E2}',now(),now()+interval '1 day')`, /check/);
    await rejects(`update customers set status='MERGED' where id='${C2}'`, /check/);
    await rejects(`insert into workflow_exceptions(exception_number,workflow_key,error_class,error_message,retryable,attempt_count,first_failed_at,last_attempt_at)
                   values ('EXC-9001','x','NOT_A_CLASS','x',false,1,now(),now())`, /foreign key/);
    await rejects(`insert into external_links(provider,entity_type,entity_id,external_type,external_id) values
                   ('XERO','invoice',gen_random_uuid(),'Invoice','dup'), ('XERO','invoice',gen_random_uuid(),'Invoice','dup')`, /unique/);
  });

  it('has no mock concepts left in the schema', async () => {
    expect(await db.query(`select 1 from information_schema.columns where table_schema = 'public' and column_name = 'is_mock'`)).toEqual([]);
    await rejects(`insert into documents(document_number,document_type,title,file_name,mime_type,storage_provider,storage_ref,project_id)
                   values ('DOC-9002','OTHER','x','x.pdf','application/pdf','MOCK_DRIVE','m/1','${PJ1}')`, /check/);
  });

  it('no public-schema function is executable by PUBLIC (engine-independent least-privilege check)', async () => {
    const open = await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
      aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where n.nspname = 'public' and a.grantee = 0 and a.privilege_type = 'EXECUTE'`);
    expect(open).toEqual([]);
    const wf = await db.query<{ f: string }>(`select p.proname f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('roofops_workflow', p.oid, 'execute') order by 1`);
    expect(wf.map((r) => r.f)).toEqual(['wf_airtable_change', 'wf_airtable_cursor', 'wf_airtable_cursor_advance', 'wf_airtable_writeback_verified', 'wf_claim_side_effect',
      'wf_complete_side_effect', 'wf_drive_call_decision', 'wf_fail_side_effect', 'wf_invoice_decide', 'wf_invoice_prepare', 'wf_invoice_preview_verified', 'wf_quote_accepted', 'wf_reconcile_airtable', 'wf_reconcile_drive_unavailable',
      'wf_reconcile_external', 'wf_reconcile_finish', 'wf_reconcile_start', 'wf_reconcile_targets', 'wf_record_health', 'wf_webhook_check']);
  });

  it('Supabase public roles (anon, authenticated) cannot read or write any RoofOps table', async () => {
    const roles = await db.query<{ r: string }>(`select rolname r from pg_roles where rolname in ('anon','authenticated')`);
    if (roles.length === 0) return;   // not a Supabase database
    const leaks = await db.query(`select c.relname, r.rolname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated')) r(rolname)
      where n.nspname = 'public' and c.relkind in ('r','v')
        and (has_table_privilege(r.rolname, c.oid, 'select') or has_table_privilege(r.rolname, c.oid, 'insert'))`);
    expect(leaks).toEqual([]);
    const fnLeaks = await db.query(`select p.proname, r.rolname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated')) r(rolname)
      where n.nspname = 'public' and has_function_privilege(r.rolname, p.oid, 'execute')`);
    expect(fnLeaks).toEqual([]);
  });

  it('normalises phone numbers for duplicate detection', async () => {
    expect((await one<{ p: string }>(`select phone_normalised p from customers where id='${C1}'`)).p).toBe('0400111222');
  });
});
