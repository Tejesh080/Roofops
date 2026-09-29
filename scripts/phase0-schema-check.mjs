import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const sql = fs.readFileSync(process.argv[2], 'utf8');
const db = new PGlite();
console.log((await db.query('select version()')).rows[0].version.split(',')[0]);
await db.exec(sql);
console.log('tables created:', (await db.query(`select count(*)::int n from pg_tables where schemaname='public'`)).rows[0].n);

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log('  PASS', name); };
const bad = (name, msg) => { fail++; console.log('  FAIL', name, msg ?? ''); };
async function expectOk(name, q) {
  try { await db.exec('savepoint o;' + q + ';release o;'); ok(name); }
  catch (e) { await db.exec('rollback to o'); bad(name, '-> ' + e.message); }
}
async function expectErr(name, q, re) {
  try { await db.exec('savepoint s;' + q); bad(name, '(was accepted)'); await db.exec('release s'); }
  catch (e) { await db.exec('rollback to s'); if (re && !re.test(e.message)) bad(name, 'wrong error: ' + e.message); else ok(`${name}  [${e.message.slice(0, 80)}]`); }
}

const E1 = '00000000-0000-0000-0000-00000000e001', E2 = '00000000-0000-0000-0000-00000000e002';
const C1 = '00000000-0000-0000-0000-0000000000c1', C2 = '00000000-0000-0000-0000-0000000000c2';
const P1 = '00000000-0000-0000-0000-0000000000a1', Q1 = '00000000-0000-0000-0000-0000000000f1', V1 = '00000000-0000-0000-0000-0000000000b1';

await db.exec('begin');
console.log('friendly ids:', (await db.query(`select next_friendly_id('Q',2026) a, next_friendly_id('Q',2026) b, next_friendly_id('CUST') c`)).rows[0]);

await expectOk('seed minimal graph (employee, customer, property, quote, version, accept, project)', `
  insert into employees(id,employee_code,full_name,email,role) values
    ('${E1}','EMP-001','Demo PM','pm@example.com','PROJECT_MANAGER'),
    ('${E2}','EMP-002','Demo Finance','fin@example.com','FINANCE');
  insert into customers(id,customer_number,customer_type,display_name,email) values
    ('${C1}','CUST-0001','RESIDENTIAL','Test Customer','t@example.com'),
    ('${C2}','CUST-0002','RESIDENTIAL','Other Customer','o@example.com');
  insert into properties(id,property_number,address_line1,suburb,state,postcode,property_type) values
    ('${P1}','PROP-0001','1 Example St','Bundaberg','QLD','4670','DETACHED_HOUSE');
  insert into quotes(id,quote_number,customer_id,property_id,job_type,status,sent_at) values
    ('${Q1}','Q-2026-0001','${C1}','${P1}','LEAK_REPAIR','SENT',now());
  insert into quote_versions(id,quote_id,version_number,subtotal_ex_gst,gst_amount,total_inc_gst) values
    ('${V1}','${Q1}',1,1000.00,100.00,1100.00);
  update quotes set status='ACCEPTED', accepted_version_id='${V1}', accepted_at=now() where id='${Q1}';
  insert into projects(project_number,quote_id,accepted_quote_version_id,customer_id,property_id,contract_value_ex_gst) values
    ('PRJ-2026-0001','${Q1}','${V1}','${C1}','${P1}',1000);`);
const rv = (await db.query(`select record_version from quotes`)).rows[0].record_version;
rv === 2 ? ok('record_version bumped on update (1 -> 2)') : bad('record_version', rv);

await expectErr('second project for the same quote', `
  insert into projects(project_number,quote_id,accepted_quote_version_id,customer_id,property_id,contract_value_ex_gst)
  values ('PRJ-2026-0002','${Q1}','${V1}','${C1}','${P1}',1000);`, /unique/);
await expectErr('project customer differs from its quote', `update projects set customer_id='${C2}';`, /foreign key/);
await expectErr('ACCEPTED quote with no accepted version', `
  insert into quotes(quote_number,customer_id,property_id,job_type,status,sent_at,accepted_at)
  values ('Q-2026-0009','${C1}','${P1}','LEAK_REPAIR','ACCEPTED',now(),now());`, /check/);
await expectErr('quote version with wrong GST', `
  insert into quote_versions(quote_id,version_number,subtotal_ex_gst,gst_amount,total_inc_gst) values ('${Q1}',2,1000.00,99.00,1099.00);`, /check/);

await expectOk('PO lines inserted; header totals derived by trigger', `
  insert into suppliers(id,supplier_code,name) values ('00000000-0000-0000-0000-0000000000d1','SUP-001','Demo Supplier');
  insert into products(id,sku,name,category,unit) values ('00000000-0000-0000-0000-0000000000e9','RO-TEST','Screws','FASTENERS','BOX');
  insert into purchase_orders(id,po_number,supplier_id,freight_ex_gst,idempotency_key)
    values ('00000000-0000-0000-0000-000000000901','PO-2026-0001','00000000-0000-0000-0000-0000000000d1',50,'po:create:1');
  insert into purchase_order_lines(purchase_order_id,line_no,product_id,description,quantity,unit,unit_price_ex_gst) values
    ('00000000-0000-0000-0000-000000000901',1,'00000000-0000-0000-0000-0000000000e9','Screws',3,'BOX',33.33),
    ('00000000-0000-0000-0000-000000000901',2,'00000000-0000-0000-0000-0000000000e9','Screws',1.5,'BOX',10.01);`);
const po = (await db.query(`select subtotal_ex_gst s, freight_ex_gst f, gst_amount g, total_inc_gst t from purchase_orders`)).rows[0];
console.log('   PO totals:', po, '(expected 3*33.33 + round(1.5*10.01,2) = 99.99 + 15.02 = 115.01; GST on 165.01 = 16.50; total 181.51)');
(Number(po.s) === 115.01 && Number(po.g) === 16.5 && Number(po.t) === 181.51) ? ok('PO arithmetic correct') : bad('PO arithmetic');

await expectErr('duplicate PO idempotency key', `
  insert into purchase_orders(po_number,supplier_id,idempotency_key) values ('PO-2026-0002','00000000-0000-0000-0000-0000000000d1','po:create:1');`, /unique/);
await expectErr('PO set to SENT without approval', `update purchase_orders set status='SENT', sent_at=now();`, /check/);
const v0 = (await db.query(`select record_version from purchase_orders`)).rows[0].record_version;
await db.exec(`update purchase_orders set total_inc_gst = 1.00, subtotal_ex_gst = 1.00`);
const forged = (await db.query(`select total_inc_gst t, record_version v from purchase_orders`)).rows[0];
Number(forged.t) === 181.51 ? ok('forged PO total is re-derived from lines (181.51 kept)') : bad('forged total stuck', forged.t);
await db.exec(`update purchase_order_lines set quantity = 4 where line_no = 1`);
const after = (await db.query(`select total_inc_gst t, record_version v from purchase_orders`)).rows[0];
(Number(after.t) === 218.17 && after.v > forged.v) ? ok(`line change re-derives total (218.17) and bumps PO record_version ${v0}->${after.v} (stale approvals detectable)`) : bad('line change', JSON.stringify(after));

await expectOk('invoice with lines: totals derived', `
  insert into invoices(id,invoice_number,project_id,customer_id,invoice_type,idempotency_key)
    select '00000000-0000-0000-0000-000000000801','INV-2026-0001',id,customer_id,'FINAL','inv:create:1' from projects;
  insert into invoice_lines(invoice_id,line_no,description,quantity,unit_price_ex_gst) values
    ('00000000-0000-0000-0000-000000000801',1,'Roof restoration - final',1,12345.67);`);
const inv = (await db.query(`select subtotal_ex_gst s, gst_amount g, total_inc_gst t from invoices`)).rows[0];
(Number(inv.g) === 1234.57 && Number(inv.t) === 13580.24) ? ok('invoice GST 1234.57 / total 13580.24') : bad('invoice arithmetic', JSON.stringify(inv));
await expectErr('duplicate invoice idempotency key', `
  insert into invoices(invoice_number,project_id,customer_id,invoice_type,idempotency_key)
    select 'INV-2026-0002',id,customer_id,'FINAL','inv:create:1' from projects;`, /unique/);
await expectErr('invoice ISSUED without approval', `
  update invoices set status='ISSUED', issue_date=current_date, due_date=current_date+14;`, /check/);

await expectOk('idempotency claim: first claimer inserts', `
  insert into processed_events(consumer,idempotency_key,first_event_id,request_hash,status,lease_expires_at)
  values ('quote_to_project@v1','quote.accepted:q1:v1',gen_random_uuid(),'h1','PROCESSING',now()+interval '30 seconds') on conflict do nothing;`);
const second = await db.query(`insert into processed_events(consumer,idempotency_key,first_event_id,request_hash,status,lease_expires_at)
  values ('quote_to_project@v1','quote.accepted:q1:v1',gen_random_uuid(),'h1','PROCESSING',now()+interval '30 seconds') on conflict do nothing returning 1`);
second.rows.length === 0 ? ok('idempotency claim: second claimer gets nothing') : bad('second claimer won');
await expectErr('COMPLETED idempotency row without result', `
  update processed_events set status='COMPLETED', completed_at=now();`, /check/);

await expectOk('audit inserts', `
  insert into audit_events(actor_type,actor_id,action,entity_type,entity_id) values ('SYSTEM','seed','project.create','project',gen_random_uuid());
  insert into audit_events(actor_type,actor_id,action,entity_type,entity_id) values ('USER','EMP-001','po.approve','purchase_order',gen_random_uuid());`);
const chain = (await db.query(`select seq, prev_hash, row_hash from audit_events order by seq`)).rows;
(chain[0].prev_hash === null && chain[1].prev_hash === chain[0].row_hash && /^[0-9a-f]{64}$/.test(chain[1].row_hash)) ? ok('audit hash chain links row 2 -> row 1') : bad('hash chain', JSON.stringify(chain));
await expectErr('audit UPDATE', `update audit_events set reason='tamper';`, /append-only/);
await expectErr('audit DELETE', `delete from audit_events;`, /append-only/);

await expectErr('site note on a job belonging to a different project', `
  insert into jobs(id,job_number,project_id,job_type,scheduled_start,scheduled_end)
    select '00000000-0000-0000-0000-000000000701','JOB-2026-0001',id,'REPAIR',now(),now()+interval '4 hours' from projects;
  insert into site_notes(project_id,job_id,body) values (gen_random_uuid(),'00000000-0000-0000-0000-000000000701','x');`, /foreign key/);
await expectErr('document attached to nothing', `
  insert into documents(document_type,title,file_name,mime_type,storage_provider,storage_ref) values ('OTHER','x','x.pdf','application/pdf','MOCK','m/1');`, /check/);
await expectErr('REJECTED approval with no reason', `
  insert into approvals(approval_number,action_type,entity_type,entity_id,requested_by_actor_type,requested_by_employee_id,required_permission,action_payload,payload_hash,expected_record_version,idempotency_key,status,decided_by,decided_at,expires_at)
  values ('APR-2026-0001','SEND_PURCHASE_ORDER','purchase_order',gen_random_uuid(),'USER','${E1}','po.send','{}','h',1,'k1','REJECTED','${E2}',now(),now()+interval '1 day');`, /check/);
await expectErr('AI-requested approval with no recorded tool invocation', `
  insert into approvals(approval_number,action_type,entity_type,entity_id,requested_by_actor_type,requested_by_employee_id,required_permission,action_payload,payload_hash,expected_record_version,idempotency_key,expires_at)
  values ('APR-2026-0002','CREATE_INVOICE','invoice',gen_random_uuid(),'AI','${E1}','invoice.create','{}','h',1,'k2',now()+interval '1 day');`, /check/);
await expectErr('two open exceptions for the same run', `
  insert into workflow_runs(id,workflow_key,workflow_version,runner,correlation_id,idempotency_key)
    values ('00000000-0000-0000-0000-000000000601','quote_to_project','1.0.0','LOCAL',gen_random_uuid(),'k');
  insert into workflow_exceptions(exception_number,workflow_run_id,workflow_key,error_class,error_message,retryable,attempt_count)
    values ('EXC-2026-0001','00000000-0000-0000-0000-000000000601','quote_to_project','UPSTREAM_5XX','x',true,5);
  insert into workflow_exceptions(exception_number,workflow_run_id,workflow_key,error_class,error_message,retryable,attempt_count)
    values ('EXC-2026-0002','00000000-0000-0000-0000-000000000601','quote_to_project','UPSTREAM_5XX','x',true,5);`, /unique/);
await expectErr('same Xero invoice ID linked to two internal invoices', `
  insert into external_links(provider,is_mock,entity_type,entity_id,external_type,external_id) values ('XERO',true,'invoice',gen_random_uuid(),'Invoice','abc');
  insert into external_links(provider,is_mock,entity_type,entity_id,external_type,external_id) values ('XERO',true,'invoice',gen_random_uuid(),'Invoice','abc');`, /unique/);
await expectErr('customer marked MERGED without target', `update customers set status='MERGED' where id='${C2}';`, /check/);
await expectErr('duplicate-candidate pair stored in non-canonical order', `
  insert into customer_match_candidates(customer_id,candidate_customer_id,match_score) values ('${C2}','${C1}',0.9);`, /check/);

await db.exec('rollback');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
