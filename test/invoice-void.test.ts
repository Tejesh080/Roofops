/**
 * AC-05 (docs/adversarial-test-catalogue.md): voiding an invoice must never leave a Xero draft created or linked for it.
 * APPROVED -> VOIDED is a legal transition, but nothing tied the outbox row to the invoice's business status: n8n 05
 * could still claim the job, create the draft in Xero, and wf_complete_side_effect recorded it SYNCED on the VOIDED
 * invoice, while the dashboard offered the project as READY_TO_INVOICE again (reproduced: VOIDED + SYNCED + DONE +
 * linked, READY_TO_INVOICE, needs_attention false, integrity 0 FAIL).
 *
 * Owner decision (2026-10-01): a FINAL invoice cannot be voided while its Xero write is queued, in flight, ambiguous
 * (UNKNOWN) or done (a draft exists); only once the write failed safely (dead-lettered, nothing created). 05's claim and
 * the completion refuse a voided invoice as a safety net. After a void the project is blocked for a person (one FINAL
 * invoice per project, ever), never READY_TO_INVOICE. Voiding is done the only way it can be done: invoices.status.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { InvoiceRows } from './helpers/airtable04.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const APPROVER = 'usr7uCnNO15fCefbH';
const TENANT = '11111111-2222-3333-4444-555555555555';
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;

describe.each(TARGETS)('AC-05: a voided invoice never gets a Xero draft [%s]', (target) => {
  let db: Db;
  const rows = new InvoiceRows();
  let n = 0;
  const q1 = async (sql: string, p: unknown[] = []) => (await db.query<{ r: R }>(sql, p))[0]!.r;
  /** Prepare and approve a project's final invoice exactly as n8n 04 does; returns the invoice and its Xero job. */
  const approve = async (project: string) => {
    const ev = (type: string, dt = 0) => ({ event_id: `EVT-AC05-${String(++n)}`, event_type: type, source: 'airtable', actor_id: APPROVER,
      occurred_at: new Date(Date.now() + dt).toISOString(), payload: { project_number: project, airtable_record_id: recFor(project) } });
    expect(await rows.send(db, ev('invoice.prepare_requested'), 'n8n:test')).toMatchObject({ outcome: 'PREVIEW_READY' });
    const r = await rows.send(db, ev('invoice.approved', 1000), 'n8n:test');
    expect(r).toMatchObject({ outcome: 'APPROVED' });
    const [job] = await db.query<{ key: string; payload: R }>(`select idempotency_key key, payload from outbox where aggregate_id = $1`, [r.invoice_id]);
    return { invoice: String(r.invoice_number), id: String(r.invoice_id), key: job!.key, payload: job!.payload };
  };
  /** What an operator can do: void it directly (with the required reason). true, or Postgres's refusal message. */
  const voidIt = (invoice: string) => db.query(`update invoices set status = 'VOIDED', voided_reason = 'Customer cancelled the job' where invoice_number = $1`, [invoice])
    .then(() => true as const, (e: unknown) => (e as Error).message);
  /** What [RoofOps] 05 sends after reading its draft back from Xero. */
  const proof = (p: R) => ({ verified: true, tenant_id: p.xero_tenant_id, organisation_class: 'DEMO', invoice_id: 'aaaaaaaa-bbbb-cccc-dddd-000000000005',
    invoice_number: p.xero_invoice_number, reference: p.reference, status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false,
    contact_id: 'ffffffff-1111-2222-3333-000000000005', contact_number: p.xero_contact_number, total: p.amount_inc_gst, total_tax: p.gst_amount,
    currency: 'AUD', line_amount_types: 'Inclusive', matching_invoices: 1 });
  const claim = (key: string, w: string) => q1(`select wf_claim_side_effect($1, $2, 120) r`, [key, w]);
  const complete = (a: { key: string; payload: R }) => q1(`select wf_complete_side_effect($1, $2::jsonb) r`, [a.key, JSON.stringify(proof(a.payload))]);
  const state = async (id: string) => (await db.query<R>(`select i.status, i.sync_status, o.status outbox,
      exists (select 1 from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id) xero_linked
      from invoices i join outbox o on o.aggregate_id = i.id where i.id = $1`, [id]))[0]!;
  const dashboard = async (project: string) => (await db.query<R>(`select invoice_status, invoice_blocker, needs_attention from v_dashboard_projects where project_number = $1`, [project]))[0]!;
  const integrityFails = () => col(db, `select check_key v from integrity_check() where status = 'FAIL'`);

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`update app_settings set value = '${TENANT}' where key = 'xero.demo_tenant_id';
                   insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
  }, 120_000);
  afterAll(async () => { await db.close(); });

  it('a void is refused while the Xero write is queued, and once the draft exists; the write itself goes on normally', async () => {
    const a = await approve('PRJ-2026-0004');
    expect(await voidIt(a.invoice)).toMatch(/INV-\d{4}-\d{4} cannot be voided: its Xero draft is queued/);
    expect(await claim(a.key, 'w1')).toMatchObject({ claimed: true });
    expect(await complete(a)).toMatchObject({ status: 'RECORDED' });
    expect(await state(a.id)).toMatchObject({ status: 'APPROVED', sync_status: 'SYNCED', outbox: 'DONE', xero_linked: true });
    expect(await voidIt(a.invoice)).toMatch(/cannot be voided: its Xero draft exists/);                         // void it in Xero first
    expect(await state(a.id)).toMatchObject({ status: 'APPROVED', sync_status: 'SYNCED' });
    expect(await dashboard('PRJ-2026-0004')).toMatchObject({ invoice_status: 'XERO_DRAFT_CREATED' });
  });

  it('a void is refused while 05 is writing it (claimed) and after an ambiguous attempt (UNKNOWN): the draft may already exist in Xero', async () => {
    const a = await approve('PRJ-2026-0005');
    expect(await claim(a.key, 'w2')).toMatchObject({ claimed: true });
    expect(await voidIt(a.invoice)).toMatch(/cannot be voided: its Xero draft is being created/);
    expect(await q1(`select wf_fail_side_effect($1, 'TIMEOUT', 'create draft invoice: Xero POST timed out after 20s', null, null) r`, [a.key])).toMatchObject({ retry: true });
    expect((await state(a.id)).sync_status).toBe('UNKNOWN');
    expect(await voidIt(a.invoice)).toMatch(/cannot be voided: .*may already exist in Xero/);
    expect(await state(a.id)).toMatchObject({ status: 'APPROVED', sync_status: 'UNKNOWN' });
  });

  it('once the write failed safely, the void is allowed: the job is never picked up again, never linked, and the project needs a person', async () => {
    const p = 'PRJ-2026-0002';
    const a = await approve(p);
    expect(await claim(a.key, 'w3')).toMatchObject({ claimed: true });
    expect(await q1(`select wf_fail_side_effect($1, 'VALIDATION_ERROR', 'create contact: Xero refused the contact', null, null) r`, [a.key])).toMatchObject({ retry: false });
    expect(await state(a.id)).toMatchObject({ sync_status: 'FAILED', outbox: 'FAILED' });
    expect(await voidIt(a.invoice)).toBe(true);
    // Even if an operator re-queues the dead letter, 05 gets no job and completion links nothing.
    await db.query(`update outbox set status = 'PENDING', next_attempt_at = now() where idempotency_key = $1`, [a.key]);
    expect(await claim(a.key, 'w4')).toMatchObject({ claimed: false, status: 'INVOICE_VOIDED' });
    await expect(complete(a)).rejects.toThrow(/is voided: the Xero draft RO-INV-\d{4}-\d{4} was not linked/);
    expect(await state(a.id)).toMatchObject({ status: 'VOIDED', xero_linked: false });
    expect((await state(a.id)).sync_status).not.toBe('SYNCED');
    // Blocked for a person: not READY_TO_INVOICE (a second FINAL is impossible), an open exception, needs attention.
    expect(await dashboard(p)).toMatchObject({ invoice_status: 'NOT_READY', needs_attention: true,
      invoice_blocker: expect.stringMatching(/final invoice INV-\d{4}-\d{4} was voided/) as unknown });
    expect(await col(db, `select error_class || ' ' || resolution_status v from workflow_exceptions where business_reference = $1 and error_message like '%was voided%'`, [p]))
      .toEqual(['INVALID_STATE OPEN']);
    const again = await rows.send(db, { event_id: `EVT-AC05-${String(++n)}`, event_type: 'invoice.prepare_requested', source: 'airtable', actor_id: APPROVER,
      occurred_at: new Date().toISOString(), payload: { project_number: p, airtable_record_id: recFor(p) } }, 'n8n:test');
    expect(again).toMatchObject({ outcome: 'INVALID_STATE', message: expect.stringMatching(/was voided/) as unknown });   // a clear refusal, not a crash at approval
    expect(await integrityFails()).toEqual([]);
  });

  it('safety net: an invoice voided behind the checks (bypassing triggers) is never written or linked, and integrity reports it', async () => {
    const [{ id, key }] = await db.query<{ id: string; key: string }>(`select i.id::text id, o.idempotency_key key from invoices i join outbox o on o.aggregate_id = i.id
                                                                         join projects p on p.id = i.project_id where p.project_number = 'PRJ-2026-0005'`) as [{ id: string; key: string }];
    await db.exec(`set session_replication_role = replica`);
    try {
      await db.query(`update invoices set status = 'VOIDED', voided_reason = 'bypass' where id = $1`, [id]);
      await db.query(`update outbox set next_attempt_at = now() where idempotency_key = $1`, [key]);
    } finally { await db.exec(`set session_replication_role = origin`); }
    expect(await claim(key, 'w5')).toMatchObject({ claimed: false, status: 'INVOICE_VOIDED' });
    const [job] = await db.query<{ payload: R }>(`select payload from outbox where idempotency_key = $1`, [key]);
    await expect(complete({ key, payload: job!.payload })).rejects.toThrow(/is voided: the Xero draft .* was not linked/);
    expect(await state(id)).toMatchObject({ status: 'VOIDED', xero_linked: false });
    expect(await integrityFails()).toEqual(['voided_invoice_has_no_xero_write']);
  });
});
