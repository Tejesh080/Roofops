/**
 * Phase 3 live verification: the HOSTED control layer after the real Airtable → n8n → Postgres → Xero Demo Company run
 * for PRJ-2026-0004. Read-only. Runs only with RUN_HOSTED_TESTS=1.
 *
 * These assertions are the Postgres side of the evidence. Xero was read back independently with the read-only
 * [RoofOps] 96 Xero Read-Only Check (inventory of every RoofOps invoice/contact in the Demo org) and Airtable with an
 * independent Airtable connection (see docs/phase3-status.md); the external IDs asserted here are the ones those returned.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { HOSTED, col, openHosted } from './helpers/db.js';

const DEMO_TENANT = { id: '96643bb0-3a0a-406e-96fb-ab8a933ee6b8', name: 'Demo Company (AU)' };
const LIVE = {
  project: 'PRJ-2026-0004', invoice: 'INV-2026-0039', approval: 'APR-2026-0001',
  xeroInvoiceId: '7b74973c-a487-48f0-85b9-91ca8c5b2909', xeroNumber: 'RO-INV-2026-0039', xeroContactId: 'fb5fe56b-ab42-41eb-a3ea-161fb504eeef',
  approveEvent: 'airtable:achAHQLGW3ueCycSt:txn53:reczturPjx3N6PGoY',
} as const;

describe.runIf(HOSTED)('Phase 3 live Xero draft-invoice evidence [hosted]', () => {
  let db: Db;
  beforeAll(async () => { db = await openHosted(); });
  afterAll(async () => { await db.close(); });

  it('writes are pinned to the proven Demo Company tenant, and the pin is audited', async () => {
    expect(await col(db, `select value v from app_settings where key in ('xero.demo_tenant_id', 'xero.demo_tenant_name') order by key`))
      .toEqual([DEMO_TENANT.id, DEMO_TENANT.name]);
    expect(await col(db, `select action || '|' || entity_id v from audit_events where action = 'xero.demo_tenant.pin'`))
      .toEqual([`xero.demo_tenant.pin|${DEMO_TENANT.id}`]);
  });

  it('exactly one FINAL invoice for the project, approved, SYNCED, with the previewed amount', async () => {
    expect(await col(db, `select i.invoice_number || '|' || i.status || '|' || i.sync_status || '|' || i.total_inc_gst || '|' || i.gst_amount v
                          from invoices i join projects p on p.id = i.project_id where p.project_number = '${LIVE.project}' and i.invoice_type = 'FINAL'`))
      .toEqual([`${LIVE.invoice}|APPROVED|SYNCED|14664.49|1333.14`]);
  });

  it('one approval, EXECUTED, whose hashed preview named the project, customer, amount, reference and Demo organisation', async () => {
    expect(await col(db, `select approval_number || '|' || status || '|' || (action_payload ->> 'reference') || '|' || (action_payload ->> 'amount_inc_gst') || '|'
                                 || (action_payload ->> 'xero_contact_name') || '|' || (action_payload ->> 'xero_tenant_name') v
                          from approvals where business_reference = '${LIVE.project}'`))
      .toEqual([`${LIVE.approval}|EXECUTED|${LIVE.project}|14664.49|Ella Thompson [CUST-0004]|${DEMO_TENANT.name}`]);
    expect(await col(db, `select (payload_hash = invoice_preview_hash(action_payload))::text v from approvals where approval_number = '${LIVE.approval}'`)).toEqual(['true']);
  });

  it('one Xero side effect, DONE on the first attempt, keyed to the RoofOps invoice and pinned tenant', async () => {
    expect(await col(db, `select o.status || '|' || o.attempts || '|' || (o.payload ->> 'xero_tenant_id') || '|' || (o.payload ->> 'xero_invoice_number') v
                          from outbox o where o.topic = 'xero.create_draft_invoice'`))
      .toEqual([`DONE|1|${DEMO_TENANT.id}|${LIVE.xeroNumber}`]);
  });

  it('the real Xero InvoiceID and ContactID are stored and verified in external_links', async () => {
    expect(await col(db, `select entity_type || ':' || external_type || ':' || external_id v from external_links
                          where provider = 'XERO' and verified_at is not null order by 1`))
      .toEqual([`customer:Contact:${LIVE.xeroContactId}`, `invoice:Invoice:${LIVE.xeroInvoiceId}`]);
  });

  it('the replayed and the new Approve events were both ignored; the decision was taken once', async () => {
    expect(await col(db, `select status || '|' || delivery_count v from processed_events where idempotency_key = 'invoice.decision:${LIVE.approval}'`))
      .toEqual(['COMPLETED|3']);
    expect(await col(db, `select event_key || '|' || status || '|' || (metadata ->> 'reason') v from automation_events
                          where event_type = 'invoice.approved' and business_reference = '${LIVE.project}' and status = 'DUPLICATE_IGNORED' order by recorded_at`))
      .toEqual([`${LIVE.approveEvent}:redelivery:1|DUPLICATE_IGNORED|transport redelivery of the same event_id`,
                `airtable:achAHQLGW3ueCycSt:txn57:reczturPjx3N6PGoY|DUPLICATE_IGNORED|semantic duplicate: ${LIVE.approval} was already decided`]);
  });

  it('invalid project states were rejected live with a named exception and no approval', async () => {
    expect(await col(db, `select business_reference || '|' || error_class v from workflow_exceptions
                          where exception_number in ('EXC-0016', 'EXC-0017') order by exception_number`))
      .toEqual(['PRJ-2026-0007|MISSING_DOCUMENT', 'PRJ-2026-0031|INVALID_STATE']);
    expect(await col(db, `select count(*)::text v from approvals where business_reference in ('PRJ-2026-0007', 'PRJ-2026-0031')`)).toEqual(['0']);
  });

  it('the audit trail explains it end to end, and the hash chain is intact', async () => {
    expect(await col(db, `select action || '|' || actor_id v from audit_events
                          where action in ('invoice.preview_prepared', 'approval.approve', 'invoice.create', 'xero.invoice.draft_created')
                            and business_reference in ('${LIVE.project}', '${LIVE.approval}', '${LIVE.invoice}') order by seq`))
      .toEqual(['invoice.preview_prepared|usr7uCnNO15fCefbH', 'approval.approve|EMP-900', 'invoice.create|project_to_invoice@1', 'xero.invoice.draft_created|xero']);
    expect(await col(db, `select external_reference v from audit_events where action = 'xero.invoice.draft_created'`)).toEqual([LIVE.xeroInvoiceId]);
    expect(await col(db, `select coalesce(verify_audit_chain()::text, 'intact') v`)).toEqual(['intact']);
  });
});
