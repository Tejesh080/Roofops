import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { InvoiceRows } from './helpers/airtable04.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';

type Result = Record<string, unknown> & { outcome?: string };
const APPROVER = 'usr7uCnNO15fCefbH';   // mapped to EMP-900 Demo Finance Approver (FINANCE) by migration 800
const TENANT = '11111111-2222-3333-4444-555555555555';

/** The Airtable record of a project (linked in beforeAll; synthetic but well-formed). */
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;
/** What n8n 04 sends: from the project's own row, stamped when the approver acted (after the preview was shown: AC-03). */
function ev(eventId: string, type: string, project: string, actor = APPROVER, extra: Record<string, unknown> = {}) {
  return { event_id: eventId, event_type: type, source: 'airtable', actor_id: actor, occurred_at: new Date(Date.now() + 1000).toISOString(),
           payload: { project_number: project, airtable_record_id: recFor(project), ...extra } };
}
/** The Airtable rows as n8n 04 leaves them; Airtable invoice events go through 04's real contract (test/helpers/airtable04.ts). */
const rows = new InvoiceRows();
async function call(db: Db, fn: string, ...args: unknown[]): Promise<Result> {
  const e = args[0] as Parameters<InvoiceRows['send']>[1] & { source?: string };
  if ((fn === 'wf_invoice_prepare' || fn === 'wf_invoice_decide') && args.length === 1 && e.source === 'airtable') return rows.send(db, e, 'n8n:test');
  return callDirect(db, fn, ...args);
}
/** Straight to Postgres, without n8n 04 around it (validation of the function itself). */
async function callDirect(db: Db, fn: string, ...args: unknown[]): Promise<Result> {
  const params = args.map((_, i) => `$${String(i + 1)}`).join(', ');
  const [r] = await db.query<{ r: Result }>(`select ${fn}(${params}) as r`, args.map((a) => (a !== null && typeof a === 'object' ? JSON.stringify(a) : a)));
  return r!.r;
}
const n = async (db: Db, sql: string) => Number((await col(db, sql))[0]);

/** What [RoofOps] 05 sends after reading the draft back from Xero. */
function xeroProof(p: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    verified: true, tenant_id: p.xero_tenant_id, organisation_class: 'DEMO', invoice_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    invoice_number: p.xero_invoice_number, reference: p.reference, status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false,
    contact_id: 'ffffffff-1111-2222-3333-444444444444', contact_number: p.xero_contact_number, total: p.amount_inc_gst, total_tax: p.gst_amount,
    currency: 'AUD', line_amount_types: 'Inclusive', matching_invoices: 1, ...over,
  };
}

describe.each(TARGETS)('Approved project -> Xero draft invoice control layer [%s]', (target) => {
  let db: Db;
  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
  });
  afterAll(async () => { await db.close(); });

  describe('preview (no approval = no Xero side effect)', () => {
    it('PRJ-2026-0004: deterministic amount = quote 20949.27 - billed 6284.78 = 14664.49 inc GST (GST 1333.14)', async () => {
      const r = await call(db, 'wf_invoice_prepare', ev('EVT-I-PREP-1', 'invoice.prepare_requested', 'PRJ-2026-0004'));
      expect(r).toMatchObject({ outcome: 'PREVIEW_READY', project_number: 'PRJ-2026-0004' });
      const p = r.preview as Record<string, unknown>;
      expect(p).toMatchObject({ amount_inc_gst: 14664.49, gst_amount: 1333.14, amount_ex_gst: 13331.35, quote_total_inc_gst: 20949.27,
        billed_to_date_inc_gst: 6284.78, reference: 'PRJ-2026-0004', xero_contact_number: 'RO-CUST-0004', xero_contact_name: 'Ella Thompson [CUST-0004]',
        customer_name: 'Ella Thompson', xero_account_code: '200', xero_tax_type: 'OUTPUT', invoice_date: '2026-09-29', due_date: '2026-10-13' });
      expect((p.lines as { unit_amount: number }[]).reduce((s, l) => s + l.unit_amount, 0)).toBeCloseTo(14664.49, 2);
      expect(await col(db, `select status v from approvals where approval_number = '${r.approval_number as string}'`)).toEqual(['PENDING']);
      expect(await n(db, `select count(*) v from invoices where project_id = (select id from projects where project_number = 'PRJ-2026-0004') and invoice_type = 'FINAL'`)).toBe(0);
      expect(await n(db, `select count(*) v from outbox where topic = 'xero.create_draft_invoice'`)).toBe(0);
    });

    it('asking again returns the same pending preview; a redelivered request gets the same answer', async () => {
      const again = await call(db, 'wf_invoice_prepare', ev('EVT-I-PREP-2', 'invoice.prepare_requested', 'PRJ-2026-0004'));
      expect(again).toMatchObject({ outcome: 'ALREADY_PENDING' });
      const redelivered = await call(db, 'wf_invoice_prepare', ev('EVT-I-PREP-1', 'invoice.prepare_requested', 'PRJ-2026-0004'));
      expect(redelivered).toMatchObject({ outcome: 'PREVIEW_READY', duplicate: true, delivery_count: 2 });
      expect(await n(db, `select count(*) v from approvals where business_reference = 'PRJ-2026-0004'`)).toBe(1);
    });

    it('rejects ineligible projects with a named reason, one exception each, and no approval', async () => {
      const cases: [string, string][] = [
        ['PRJ-2026-0009', 'INVALID_STATE'],        // PLANNING, not COMPLETED
        ['PRJ-2026-0007', 'MISSING_DOCUMENT'],     // planted: completion photos missing
        ['PRJ-2026-0006', 'ARITHMETIC_MISMATCH'],  // already billed more than the quote
        ['PRJ-2026-0003', 'INVALID_STATE'],        // has an unapproved DRAFT invoice
        ['PRJ-2026-9999', 'NOT_FOUND'],
      ];
      for (const [prj, cls] of cases) {
        const r = await call(db, 'wf_invoice_prepare', ev(`EVT-I-BAD-${prj}`, 'invoice.prepare_requested', prj));
        expect(r, prj).toMatchObject({ outcome: 'INVALID_STATE', error_class: cls });
        expect(r.exception_number, prj).toMatch(/^EXC-/);
      }
      const again = await call(db, 'wf_invoice_prepare', ev('EVT-I-BAD-AGAIN', 'invoice.prepare_requested', 'PRJ-2026-0007'));
      expect(await n(db, `select count(*) v from workflow_exceptions where business_reference = 'PRJ-2026-0007' and workflow_key = 'project_to_invoice' and resolution_status = 'OPEN'`)).toBe(1);
      expect(again.exception_number).toBeDefined();
      expect(await n(db, `select count(*) v from approvals where business_reference in ('PRJ-2026-0009','PRJ-2026-0007','PRJ-2026-0006','PRJ-2026-0003')`)).toBe(0);
    });

    it('rejects a malformed event without touching anything', async () => {
      const r = await callDirect(db, 'wf_invoice_prepare', { ...ev('EVT-I-MAL', 'invoice.prepare_requested', 'PRJ-2026-0004'), actor_id: '' });
      expect(r).toMatchObject({ outcome: 'INVALID_EVENT', issues: ['actor_id: required (who asked)'] });
    });
  });

  describe('approval', () => {
    it('refuses to queue a Xero write while no Demo Company tenant is pinned', async () => {
      await call(db, 'wf_invoice_prepare', ev('EVT-I-PREP-0002', 'invoice.prepare_requested', 'PRJ-2026-0002'));
      const r = await call(db, 'wf_invoice_decide', ev('EVT-I-APR-0002', 'invoice.approved', 'PRJ-2026-0002'));
      expect(r).toMatchObject({ outcome: 'INVALID_STATE', message: expect.stringMatching(/No Xero Demo Company tenant is pinned/) as unknown });
      expect(await n(db, `select count(*) v from invoices where idempotency_key like 'invoice:final:%'`)).toBe(0);
      await db.exec(`update app_settings set value = '${TENANT}' where key = 'xero.demo_tenant_id'`);
    });

    it('an Airtable user who is not a mapped finance approver cannot approve', async () => {
      const r = await call(db, 'wf_invoice_decide', ev('EVT-I-APR-X', 'invoice.approved', 'PRJ-2026-0004', 'usrSOMEONEELSE001'));
      expect(r).toMatchObject({ outcome: 'PERMISSION_DENIED', error_class: 'PERMISSION_DENIED' });
      expect(await col(db, `select status v from approvals where business_reference = 'PRJ-2026-0004'`)).toEqual(['PENDING']);
      expect(await n(db, `select count(*) v from outbox where topic = 'xero.create_draft_invoice'`)).toBe(0);
    });

    it('approval creates ONE RoofOps FINAL invoice whose derived totals equal the preview, and queues ONE Xero draft', async () => {
      // The refusal above replaced the preview on the row with "Not authorised": Prepare shows the same preview again.
      expect(await call(db, 'wf_invoice_prepare', ev('EVT-I-PREP-4', 'invoice.prepare_requested', 'PRJ-2026-0004'))).toMatchObject({ outcome: 'ALREADY_PENDING' });
      const r = await call(db, 'wf_invoice_decide', ev('EVT-I-APR-1', 'invoice.approved', 'PRJ-2026-0004'));
      expect(r).toMatchObject({ outcome: 'APPROVED', decided_by: 'Demo Finance Approver', amount_inc_gst: 14664.49 });
      expect(await col(db, `select invoice_type || '|' || status || '|' || sync_status || '|' || total_inc_gst || '|' || gst_amount v from invoices where invoice_number = '${r.invoice_number as string}'`))
        .toEqual(['FINAL|APPROVED|PENDING|14664.49|1333.14']);
      const [payload] = await db.query<{ p: Record<string, unknown> }>(`select payload p from outbox where idempotency_key = '${r.xero_key as string}'`);
      expect(payload!.p).toMatchObject({ xero_tenant_id: TENANT, xero_invoice_number: `RO-${r.invoice_number as string}`, reference: 'PRJ-2026-0004',
        amount_inc_gst: 14664.49, approval_number: r.approval_number });
      expect(await col(db, `select status v from approvals where approval_number = '${r.approval_number as string}'`)).toEqual(['EXECUTING']);
    });

    it('approving again (redelivery or a new event) never creates a second invoice or side effect', async () => {
      const redelivered = await call(db, 'wf_invoice_decide', ev('EVT-I-APR-1', 'invoice.approved', 'PRJ-2026-0004'));
      const newEvent = await call(db, 'wf_invoice_decide', ev('EVT-I-APR-2', 'invoice.approved', 'PRJ-2026-0004'));
      expect(redelivered).toMatchObject({ outcome: 'ALREADY_PROCESSED', first_outcome: 'APPROVED' });
      expect(newEvent).toMatchObject({ outcome: 'ALREADY_PROCESSED', first_outcome: 'APPROVED', delivery_count: 3 });
      expect((newEvent.pending_side_effects as unknown[]).length).toBe(1);   // the Xero draft is not done yet: a re-drive may finish it
      expect(await n(db, `select count(*) v from invoices where project_id = (select id from projects where project_number = 'PRJ-2026-0004') and invoice_type = 'FINAL'`)).toBe(1);
      expect(await n(db, `select count(*) v from outbox where topic = 'xero.create_draft_invoice'`)).toBe(1);
      expect(await call(db, 'wf_invoice_prepare', ev('EVT-I-PREP-3', 'invoice.prepare_requested', 'PRJ-2026-0004'))).toMatchObject({ outcome: 'ALREADY_INVOICED' });
    });

    it('persistent idempotency: even bypassing the functions, a second FINAL invoice for the project is impossible', async () => {
      await expect(db.exec(`insert into invoices (invoice_number, project_id, customer_id, invoice_type, idempotency_key)
                            select 'INV-TEST-DUP', id, customer_id, 'FINAL', 'invoice:final:' || id from projects where project_number = 'PRJ-2026-0004'`))
        .rejects.toThrow(/duplicate key/);
    });

    it('a preview that changed since it was prepared is stale and cannot be approved', async () => {
      await call(db, 'wf_invoice_prepare', ev('EVT-I-PREP-0005', 'invoice.prepare_requested', 'PRJ-2026-0005'));
      await db.exec(`insert into variations (variation_number, project_id, description, amount_inc_gst, status, customer_approved_at, approved_by)
                     select 'VAR-TEST-1', p.id, 'Extra flashing', 990.00, 'APPROVED', now(), (select id from employees where employee_code = 'EMP-900')
                     from projects p where p.project_number = 'PRJ-2026-0005'`);
      const r = await call(db, 'wf_invoice_decide', ev('EVT-I-APR-0005', 'invoice.approved', 'PRJ-2026-0005'));
      expect(r).toMatchObject({ outcome: 'INVALID_STATE', message: expect.stringMatching(/stale/) as unknown });
      expect(await col(db, `select status v from approvals where business_reference = 'PRJ-2026-0005'`)).toEqual(['CANCELLED']);
      const fresh = await call(db, 'wf_invoice_prepare', ev('EVT-I-PREP-0005b', 'invoice.prepare_requested', 'PRJ-2026-0005'));
      expect(fresh).toMatchObject({ outcome: 'PREVIEW_READY' });
      expect((fresh.preview as { lines: unknown[]; amount_inc_gst: number })).toMatchObject({ amount_inc_gst: 18821.91 });   // 17831.91 + 990.00
      expect((fresh.preview as { lines: unknown[] }).lines).toHaveLength(2);
    });

    it('a reject is recorded with the approver and creates nothing', async () => {
      const r = await call(db, 'wf_invoice_decide', ev('EVT-I-REJ-0005', 'invoice.rejected', 'PRJ-2026-0005', APPROVER, { reason: 'Customer disputes the variation' }));
      expect(r).toMatchObject({ outcome: 'REJECTED_BY_APPROVER' });
      expect(await col(db, `select status || '|' || decision_reason v from approvals where business_reference = 'PRJ-2026-0005' and status = 'REJECTED'`))
        .toEqual(['REJECTED|Customer disputes the variation']);
      expect(await n(db, `select count(*) v from invoices where project_id = (select id from projects where project_number = 'PRJ-2026-0005') and invoice_type = 'FINAL'`)).toBe(0);
    });
  });

  describe('Xero side effect: only read-back proof from the pinned DEMO tenant is accepted', () => {
    const key = async () => (await col(db, `select idempotency_key v from outbox where topic = 'xero.create_draft_invoice'`))[0]!;
    const payload = async () => (await db.query<{ p: Record<string, unknown> }>(`select payload p from outbox where topic = 'xero.create_draft_invoice'`))[0]!.p;

    it('an ambiguous timeout marks the invoice UNKNOWN (reconcile before any retry)', async () => {
      await call(db, 'wf_claim_side_effect', await key(), 'w', 120);
      expect(await call(db, 'wf_fail_side_effect', await key(), 'TIMEOUT', 'Xero POST timed out after 20s', null, null)).toMatchObject({ retry: true });
      expect(await col(db, `select sync_status v from invoices where idempotency_key like 'invoice:final:%'`)).toEqual(['UNKNOWN']);
    });

    it('refuses proof from the wrong tenant, a non-demo org, a non-draft, a wrong total, or two matching invoices', async () => {
      await db.exec(`update outbox set next_attempt_at = now() where topic = 'xero.create_draft_invoice'`);
      await call(db, 'wf_claim_side_effect', await key(), 'w', 120);
      const p = await payload();
      const bad: [Record<string, unknown>, RegExp][] = [
        [{ tenant_id: 'b09bb96b-b58c-4c97-97d6-5d42b07038e2' }, /not the pinned Demo Company tenant/],
        [{ organisation_class: 'ULTIMATE_10' }, /not a Demo Company/],
        [{ status: 'AUTHORISED' }, /must be an ACCREC DRAFT/],
        [{ sent_to_contact: true }, /unpaid and unsent/],
        [{ total: 14664.5 }, /does not match the approved/],
        [{ reference: 'PRJ-2026-0001' }, /does not carry number/],
        [{ contact_number: 'RO-CUST-0001' }, /contact/],
        [{ matching_invoices: 2 }, /exactly one Xero invoice/],
        [{ verified: false }, /without read-back verification/],
      ];
      for (const [over, err] of bad) await expect(call(db, 'wf_complete_side_effect', await key(), xeroProof(p, over))).rejects.toThrow(err);
      expect(await n(db, `select count(*) v from external_links where provider = 'XERO'`)).toBe(0);
    });

    it('good proof records InvoiceID + ContactID, marks the invoice SYNCED, the approval EXECUTED and the run SUCCEEDED', async () => {
      const p = await payload();
      expect(await call(db, 'wf_complete_side_effect', await key(), xeroProof(p))).toMatchObject({ status: 'RECORDED', remaining_side_effects: 0 });
      expect(await col(db, `select entity_type || ':' || external_type || ':' || external_id v from external_links where provider = 'XERO' order by 1`))
        .toEqual(['customer:Contact:ffffffff-1111-2222-3333-444444444444', 'invoice:Invoice:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
      expect(await col(db, `select sync_status v from invoices where idempotency_key like 'invoice:final:%'`)).toEqual(['SYNCED']);
      expect(await col(db, `select status v from approvals where business_reference = 'PRJ-2026-0004'`)).toEqual(['EXECUTED']);
      expect(await col(db, `select status v from workflow_runs where workflow_key = 'project_to_invoice'`)).toEqual(['SUCCEEDED']);
      expect(await col(db, `select action v from audit_events where action in ('invoice.preview_prepared','approval.approve','invoice.create','xero.invoice.draft_created')
                              and (business_reference in ('PRJ-2026-0004') or entity_type in ('invoice','approval')) order by seq`))
        .toEqual(expect.arrayContaining(['invoice.preview_prepared', 'approval.approve', 'invoice.create', 'xero.invoice.draft_created']));
      expect(await col(db, `select coalesce(verify_audit_chain()::text, 'intact') v`)).toEqual(['intact']);
    });

    it('a completed Xero draft is never redone, and a second Xero invoice for the same RoofOps invoice is refused', async () => {
      expect(await call(db, 'wf_claim_side_effect', await key(), 'w', 120)).toMatchObject({ claimed: false, status: 'DONE' });
      expect(await call(db, 'wf_complete_side_effect', await key(), xeroProof(await payload(), { invoice_id: '99999999-9999-9999-9999-999999999999' })))
        .toMatchObject({ status: 'ALREADY_DONE' });
    });

    // Live regression (PRJ-2026-0004): a replayed/new Approve or Prepare after the draft exists must still let Airtable show
    // "Xero draft created" with the real IDs, not overwrite the project's invoice state with a bare "Duplicate ignored".
    it('duplicates after the draft exists report the verified Xero state (and still create nothing)', async () => {
      const state = { sync_status: 'SYNCED', xero_invoice_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', xero_contact_id: 'ffffffff-1111-2222-3333-444444444444',
                      total_inc_gst: 14664.49, status: 'APPROVED' };
      const replay = await call(db, 'wf_invoice_decide', ev('EVT-I-APR-1', 'invoice.approved', 'PRJ-2026-0004'));
      const fresh = await call(db, 'wf_invoice_decide', ev('EVT-I-APR-9', 'invoice.approved', 'PRJ-2026-0004'));
      const prep = await call(db, 'wf_invoice_prepare', ev('EVT-I-PREP-9', 'invoice.prepare_requested', 'PRJ-2026-0004'));
      for (const r of [replay, fresh]) {
        expect(r).toMatchObject({ outcome: 'ALREADY_PROCESSED', first_outcome: 'APPROVED', pending_side_effects: [], xero_state: state });
        expect((r.xero_state as { xero_invoice_number: string }).xero_invoice_number).toBe(`RO-${r.invoice_number as string}`);
      }
      expect(prep).toMatchObject({ outcome: 'ALREADY_INVOICED', xero_state: state });
      expect(await n(db, `select count(*) v from invoices where invoice_type = 'FINAL' and project_id = (select id from projects where project_number = 'PRJ-2026-0004')`)).toBe(1);
      expect(await n(db, `select count(*) v from outbox where topic = 'xero.create_draft_invoice'`)).toBe(1);
      expect(await n(db, `select count(*) v from external_links where provider = 'XERO'`)).toBe(2);
    });
  });

  it('least privilege: n8n may call the invoice entry points but not the preview internals', async () => {
    await db.exec('begin; set local role roofops_workflow;');
    try {
      expect(await call(db, 'wf_invoice_prepare', ev('EVT-I-PRIV', 'invoice.prepare_requested', 'PRJ-2026-0004'))).toMatchObject({ outcome: 'ALREADY_INVOICED' });
      await db.exec('savepoint s');
      await expect(db.query(`select invoice_final_preview(id) from projects limit 1`)).rejects.toThrow(/permission denied/);
      await db.exec('rollback to savepoint s');
      for (const internal of ['wf_invoice_decide_core', 'wf_invoice_prepare_core']) {
        await expect(db.query(`select ${internal}('{}'::jsonb, 'x')`)).rejects.toThrow(/permission denied/);
        await db.exec('rollback to savepoint s');
      }
      await expect(db.query(`select invoice_xero_state(id) from invoices limit 1`)).rejects.toThrow(/permission denied/);
      await db.exec('rollback to savepoint s');
      await expect(db.query(`select * from approvals`)).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec('rollback');
    }
  });
});
