/**
 * AC-14C Part B2 (docs/defect-ledger.md; mission architecture 4.2): the supervised final-invoice reissue.
 *
 * A voided final invoice is not collectible (B1b) but the customer still owes the work (project_billing and the close
 * gate keep saying so). This suite pins the only way back: an operator asks for a replacement draft of the SAME
 * invoice row (one canonical FINAL invoice per project, ever) with a reason, and an authorised decision queues exactly
 * one new generation of the Xero draft write. Nothing here is automatic and nothing here writes to Xero.
 *
 * Pinned here, against both engines:
 *  * the two happy paths (a verified Xero DELETED and a verified Xero VOIDED) end to end: request -> approval bound to
 *    invoice/state/preview hash/record version/generation/tenant/void evidence -> decide -> old generation superseded,
 *    generation 2 opened and queued with new keys, the invoice back to APPROVED / sync PENDING with the reissue
 *    approval attached, the approval EXECUTED, one audit event, one invoice row, the same invoice number.
 *  * the whole refusal catalogue in the pinned precedence order, with no state change: authority, reason, NOT_FOUND /
 *    NOT_FINAL_INVOICE, project state, tenancy (pin missing, pin/bound mismatch, a void recorded in another tenant),
 *    invoice state, observation semantics (ambiguous / contradicted / not verified), money, write state, duplicate
 *    request, approval state and drift, and the replay.
 *  * recovery is never a dead end: an expired request is cancelled and replaced by a fresh one.
 *  * raw SQL cannot flip VOIDED -> APPROVED without a matching reissue approval and the void proof; the guard is what
 *    refuses (it fires before the state-machine trigger), it excludes the write the reissue itself opens and still
 *    refuses a live write of an older generation.
 *  * the link moves only on a proof-gated generation >= 2 completion, and never overwrites another invoice's link.
 *  * the tenant is derived, never caller-supplied; the outbox tenant of a queued write cannot be changed.
 *  * the new functions are owner-only (SECURITY DEFINER, safe search_path, revoked from PUBLIC and the app roles).
 *  * the void guard's verified-void exemption applies only while the draft writes are terminal, so a local void during
 *    the reissue window is refused (VAL-RIS-018), and the exemption is back once the replacement completed and its
 *    document was verified voided.
 */
import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { openPostgres, type Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { InvoiceRows } from './helpers/airtable04.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const APPROVER = 'usr7uCnNO15fCefbH';                          // the Airtable approver the invoice flow uses
const A = '11111111-2222-3333-4444-555555555555';              // the pinned tenant, and every write's bound tenant
const B = '99999999-8888-7777-6666-555555555555';              // another tenant: never the pin, never the bound one
const FINANCE = 'EMP-900';                                     // FINANCE, active (the dataset's approver)
const ADMIN = 'EMP-901';                                       // ADMIN, active (fixture)
const INACTIVE = 'EMP-902';                                    // FINANCE, not active (fixture)
const PM = 'EMP-001';                                          // PROJECT_MANAGER (outside invoice.reissue_roles)
const REASON = 'Xero deleted the draft; the customer still owes the job';
const P1 = 'PRJ-2026-0001';
const P2 = 'PRJ-2026-0002';
const P4 = 'PRJ-2026-0004';                                    // 14,664.49 left to bill: the money the void leaves owed
const P5 = 'PRJ-2026-0005';
const XID1 = 'aaaaaaaa-bbbb-cccc-dddd-0000000000a1';
const XID2 = 'aaaaaaaa-bbbb-cccc-dddd-0000000000a2';
const XID4 = 'aaaaaaaa-bbbb-cccc-dddd-0000000000a4';
const XID5 = 'aaaaaaaa-bbbb-cccc-dddd-0000000000a5';
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;
const uuidFor = (seed: string) => createHash('md5').update(seed).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

type Built = { id: string; number: string; project: string; key: string; payload: R; total: number; xeroNumber: string; xid: string; approvalId: string };

/**
 * The real paths, exactly as the other suites drive them: n8n 04's prepare/approve, 05's claim/complete/fail, and 07's
 * settlement recording (the function the runner calls, with a run row this test owns - the 2-minute quota is a
 * production guard for scheduled runs, not a test fixture).
 */
function kit(db: Db & { url?: string }, rows: InvoiceRows, seq: { n: number }) {
  const q1 = async <T = R>(sql: string, p: unknown[] = []) => (await db.query<{ r: T }>(sql, p))[0]!.r;
  const one = async (sql: string, p: unknown[] = []) => (await db.query<R>(sql, p))[0]!;
  /** Fixture-only escape (the established pattern): build a state the guards would not permit, never used to assert. */
  const force = async (sql: string, p: unknown[] = []) => {
    await db.exec(`set session_replication_role = replica`);
    try { await db.query(sql, p); } finally { await db.exec(`set session_replication_role = origin`).catch(() => undefined); }
  };
  /** A raw-SQL probe that must be refused: the probe is undone, whatever happens. */
  const rejects = async (sql: string, pattern: RegExp) => {
    await db.exec('begin');
    try {
      await db.query(sql);
    } catch (e) {
      await db.exec('rollback');
      expect((e as Error).message).toMatch(pattern);
      return (e as Error).message;
    }
    await db.exec('rollback');
    throw new Error(`expected rejection: ${sql.slice(0, 90)}`);
  };

  const ev = (type: string, project: string, dt = 0) => ({ event_id: `EVT-REI-${String(++seq.n)}`, event_type: type, source: 'airtable', actor_id: APPROVER,
    occurred_at: new Date(Date.now() + dt).toISOString(), payload: { project_number: project, airtable_record_id: recFor(project) } });
  /** Prepare and approve a project's final invoice as n8n 04 does; the Xero write is queued, not claimed. */
  const buildFinal = async (project: string, xid: string): Promise<Built> => {
    expect(await rows.send(db, ev('invoice.prepare_requested', project), 'n8n:test')).toMatchObject({ outcome: 'PREVIEW_READY' });
    const r = await rows.send(db, ev('invoice.approved', project, 1000), 'n8n:test');
    expect(r).toMatchObject({ outcome: 'APPROVED' });
    const [job] = await db.query<{ key: string; payload: R; approval_id: string }>(
      `select o.idempotency_key key, o.payload, i.approval_id::text approval_id from outbox o join invoices i on i.id = o.aggregate_id
        where o.aggregate_id = $1 and o.topic = 'xero.create_draft_invoice'`, [r.invoice_id]);
    const p = job!.payload;
    return { id: String(r.invoice_id), number: String(r.invoice_number), project, key: job!.key, payload: p,
      total: Number(p.amount_inc_gst), xeroNumber: String(p.xero_invoice_number), xid, approvalId: job!.approval_id };
  };
  const claim = (key: string, w: string) => q1(`select wf_claim_side_effect($1, $2, 120) r`, [key, w]);
  const fail = (key: string, cls: string, step: string, msg: string, http: number | null = null) =>
    q1(`select wf_fail_side_effect($1, $2, $3, $4, 0) r`, [key, cls, `${step}: ${msg}`, http]);
  const retryDue = (key: string) => db.query(`update outbox set next_attempt_at = now() where idempotency_key = $1 and status = 'FAILED' and next_attempt_at <> 'infinity'`, [key]);
  /** What 05 sends after reading its draft back from Xero. */
  const proof = (p: R, over: R = {}) => ({ verified: true, tenant_id: A, organisation_class: 'DEMO', invoice_id: uuidFor(`xero:${String(p.invoice_id)}`),
    invoice_number: p.xero_invoice_number, reference: p.reference, status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false,
    contact_id: uuidFor(`contact:${String(p.customer_id)}`), contact_number: p.xero_contact_number, total: p.amount_inc_gst, total_tax: p.gst_amount,
    currency: 'AUD', line_amount_types: 'Inclusive', matching_invoices: 1, ...over });
  const complete = (key: string, payload: R, over: R = {}) => q1(`select wf_complete_side_effect($1, $2::jsonb) r`, [key, JSON.stringify(proof(payload, over))]);
  /** A draft exists in Xero and is linked: the write is DONE, sync SYNCED, the link verified (the invoice's Xero ID). */
  const completeFinal = async (a: Built) => {
    expect(await claim(a.key, 'n8n:05')).toMatchObject({ claimed: true });
    expect(await complete(a.key, a.payload, { invoice_id: a.xid })).toMatchObject({ status: 'RECORDED' });
  };
  /** 05 refuses the write for good (a validation error is not retryable): dead-lettered, nothing created in Xero. */
  const deadLetter = async (a: Built) => {
    await claim(a.key, 'n8n:05');
    return fail(a.key, 'VALIDATION_ERROR', 'create contact', 'Xero refused the contact');
  };
  /** What an operator can do: void it directly (with the required reason). null on success, or Postgres's refusal. */
  const voidLocally = (a: Built) => db.query(`update invoices set status = 'VOIDED', voided_reason = 'Customer cancelled the job' where id = $1`, [a.id])
    .then(() => null, (e: unknown) => (e as Error).message);

  /** A run row this test owns, so several reads can be recorded without the scheduled-run quota. */
  const openRun = async (mode: 'repair' | 'observe' = 'repair') =>
    (await db.query<{ k: string }>(`insert into reconciliation_runs (run_key, trigger, mode, status)
       values ('REI-RUN-' || gen_random_uuid(), 'test', $1, 'RUNNING') returning run_key k`, [mode]))[0]!.k;
  const settle = (runKey: string, results: R[]) => q1(`select xero_record_settlement($1, $2::jsonb) r`, [runKey, JSON.stringify(results)]);
  /** The invoice as Xero's GET /Invoices/{id} returns it (amounts per state). */
  const doc = (a: Built, status: string, o: R = {}) => ({ InvoiceID: a.xid, Type: 'ACCREC', InvoiceNumber: a.xeroNumber, Reference: a.project, Status: status,
    CurrencyCode: 'AUD', LineAmountTypes: 'Inclusive', Date: '2026-10-06', DueDate: '2026-10-20', Total: a.total, AmountDue: status === 'DELETED' ? 0 : a.total,
    AmountPaid: 0, AmountCredited: 0, Payments: [], ...o });
  /** The real reconciliation path: one repair run applies the verified read of the linked document. */
  const applyVoid = async (a: Built, settlement: 'VOIDED' | 'DELETED', o: R = {}) => {
    const run = await openRun('repair');
    const res = await settle(run, [{ invoice_id: a.xid, tenant_id: A, http: 200, xero_invoice_number: a.xeroNumber, xero: doc(a, settlement, o) }]);
    if (process.env.REI_DEBUG) {
      console.log('DEBUG settle', JSON.stringify(res), JSON.stringify(doc(a, settlement, o)));
      console.log('DEBUG obs', JSON.stringify(await db.query(`select verdict, settlement, tenant_id, xero_invoice_id, detail from xero_invoice_observations where invoice_id = $1 order by observed_at desc limit 3`, [a.id])));
      console.log('DEBUG inv', JSON.stringify(await db.query(`select status, sync_status from invoices where id = $1`, [a.id])));
      console.log('DEBUG run', JSON.stringify(await db.query(`select run_key, mode, status from reconciliation_runs where run_key = $1`, [run])));
    }
    return res;
  };
  /** A synthetic observation: a fixture for the read semantics the battery and the guard read (never an assertion path). */
  const addObs = async (a: Built, o: { verdict: string; settlement?: string | null; tenantId?: string | null; xeroInvoiceId?: string | null;
    paid?: number | null; credited?: number | null; mins?: number }) => {
    const run = (await db.query<{ id: string }>(`insert into reconciliation_runs (run_key, trigger, mode, status, started_at, finished_at)
      values ('REI-OBS-' || gen_random_uuid(), 'test', 'observe', 'COMPLETED', now() - interval '1 hour', now() - interval '1 hour') returning id::text id`))[0]!;
    await db.query(`insert into xero_invoice_observations (invoice_id, run_id, observed_at, tenant_id, bound_tenant_id, xero_invoice_id, verdict,
        settlement, xero_status, amount_paid, amount_credited, detail)
      values ($1, $2, now() + make_interval(mins => $3), $4, $5, $6, $7, $8, $8, $9, $10, 'synthetic observation for the reissue tests')`,
      [a.id, run.id, o.mins ?? 0, o.tenantId ?? A, A, o.xeroInvoiceId ?? a.xid, o.verdict, o.settlement ?? null, o.paid ?? null, o.credited ?? null]);
  };

  // The facility under test.
  const request = (invoiceId: string, by: string, reason: string | null) => q1(`select ops_reissue_request($1, $2, $3) r`, [invoiceId, by, reason]);
  const decide = (approval: string, by: string, note: string | null = null) => q1(`select ops_reissue_decide($1, $2, $3) r`, [approval, by, note]);
  const previewOf = (invoiceId: string, reason: string | null = null) => q1(`select invoice_reissue_preview($1, $2) r`, [invoiceId, reason]);
  const checkOf = (invoiceId: string) => q1(`select invoice_reissue_check($1) r`, [invoiceId]);
  const previewHash = (preview: R) => q1<string>(`select invoice_reissue_preview_hash($1::jsonb) r`, [JSON.stringify(preview)]);

  // Readers.
  /** col() with the kit's connection bound (accepts the (db, sql, params) form too). */
  const colK = async (first: unknown, second?: unknown, third?: unknown) =>
    (typeof first === 'string' ? col(db, first, (second as unknown[] | undefined) ?? []) : col(first as Db, second as string, (third as unknown[] | undefined) ?? []));
  const exec = (sql: string, p: unknown[] = []) => db.query(sql, p);
  const invState = (a: Built) => one(`select id::text, invoice_number, status, sync_status, voided_reason, record_version, approval_id::text approval_id
                                       from invoices where id = $1`, [a.id]);
  const ledger = (id: string) => db.query<R>(`select generation, status, outbox_idempotency_key key, xero_invoice_id, xero_invoice_number, tenant_id,
      opened_by, approval_id::text approval_id, superseded_at::text superseded_at, superseded_reason
    from invoice_xero_draft_generations where invoice_id = $1 order by generation`, [id]);
  const outboxRows = (id: string) => db.query<R>(`select generation, status, idempotency_key, payload, next_attempt_at = 'infinity' dead
    from outbox where aggregate_id = $1 and topic = 'xero.create_draft_invoice' order by generation`, [id]);
  const approvalRow = (number: string) => one(`select id::text, approval_number, action_type, entity_type, entity_id::text, status, required_permission,
      payload_hash, expected_record_version, idempotency_key, action_payload, decision_reason, execution_result, requested_by_actor_type,
      requested_by_employee_id::text requested_by, decided_by::text, expires_at::text, created_at::text, decided_at::text, executed_at::text
    from approvals where approval_number = $1`, [number]);
  const link = async (id: string) => (await db.query<{ external_id: string }>(`select external_id from external_links
     where provider = 'XERO' and entity_type = 'invoice' and external_type = 'Invoice' and entity_id = $1`, [id]))[0]?.external_id ?? null;
  const linkRows = (id: string) => db.query<R>(`select external_id, verified_at is not null verified, external_url from external_links
     where provider = 'XERO' and entity_type = 'invoice' and external_type = 'Invoice' and entity_id = $1`, [id]);
  const audit = (id: string) => col(db, `select action v from audit_events where entity_id = $1 order by audit_id`, [id]);
  const balance = (id: string) => one(`select outstanding::numeric(12,2)::text outstanding, is_overdue from v_invoice_balances where id = $1`, [id]);
  const billing = async (project: string) => (await one(`select project_billing(p.id) b from projects p where p.project_number = $1`, [project])).b as R;
  const close = async (project: string) => (await one(`select project_transition_guard(p, 'CLOSED') v from projects p where p.project_number = $1`, [project])).v as string | null;
  const counts = () => one(`select (select count(*) from invoices)::int invoices, (select count(*) from outbox)::int outbox,
      (select count(*) from approvals)::int approvals, (select count(*) from audit_events)::int audit,
      (select count(*) from invoice_xero_draft_generations)::int ledger, (select count(*) from xero_invoice_observations)::int observations`);
  const integrityFails = () => col(db, `select check_key v from integrity_check() where status = 'FAIL'`);
  /** No reissue has happened: one generation, one write, and the invoice still VOIDED. */
  const untouched = async (a: Built) => {
    expect(await ledger(a.id)).toHaveLength(1);
    expect(await outboxRows(a.id)).toHaveLength(1);
    expect(await invState(a)).toMatchObject({ status: 'VOIDED', sync_status: 'SYNCED' });
  };
  /** No reissue request exists at all (only valid where the test never made one). */
  const noReissueApprovals = async () => { expect(await col(db, `select approval_number v from approvals where action_type = 'REISSUE_INVOICE'`)).toEqual([]); };

  /** The AC-14C-A deletion scenario: a completed final invoice whose linked draft was verified DELETED in Xero. */
  const deletedScenario = async (project = P4, xid = XID4) => {
    const a = await buildFinal(project, xid);
    await completeFinal(a);
    expect(await applyVoid(a, 'DELETED')).toMatchObject({ ok: true, applied: 1 });
    expect(await invState(a)).toMatchObject({ status: 'VOIDED', sync_status: 'SYNCED' });
    return a;
  };
  /** The AC-14B Xero void scenario (the voided document still carries its original total). */
  const voidedScenario = async (project = P4, xid = XID4) => {
    const a = await buildFinal(project, xid);
    await completeFinal(a);
    expect(await applyVoid(a, 'VOIDED')).toMatchObject({ ok: true, applied: 1 });
    expect(await invState(a)).toMatchObject({ status: 'VOIDED', sync_status: 'SYNCED' });
    return a;
  };

  return { q1, one, force, rejects, buildFinal, claim, fail, retryDue, complete, completeFinal, deadLetter, voidLocally, openRun, settle,
    doc, applyVoid, addObs, request, decide, previewOf, checkOf, previewHash, invState, ledger, outboxRows, approvalRow, link, linkRows, audit,
    balance, billing, close, counts, integrityFails, untouched, noReissueApprovals, deletedScenario, voidedScenario, col: colK, exec };
}

const fixtures = (db: Db) => db.exec(`
  insert into employees (employee_code, full_name, email, role, is_active) values
    ('${ADMIN}', 'Ada Admin', 'ada.admin@roofops.test', 'ADMIN', true),
    ('${INACTIVE}', 'Ivan Inactive', 'ivan.inactive@roofops.test', 'FINANCE', false);
  update app_settings set value = '${A}' where key = 'xero.demo_tenant_id';
  insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
  select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);

describe.each(TARGETS)('AC-14C B2: the supervised final-invoice reissue [%s]', (target) => {
  const rows = new InvoiceRows();
  const seq = { n: 0 };
  let db: Db & { url?: string };
  let k: ReturnType<typeof kit>;

  beforeEach(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await fixtures(db);
    k = kit(db, rows, seq);
  }, 120_000);
  afterEach(async () => { await db.close(); });

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-001 / VAL-RIS-002: the two legitimate paths, end to end.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-001 the deletion path: a request binds one approval and the decision opens generation 2 for the same invoice row', async () => {
    const a = await k.deletedScenario();
    // The B1b state this facility exists for: not collectible, but still owed, and the close gate still refuses.
    expect(await k.balance(a.id)).toMatchObject({ outstanding: '0.00', is_overdue: false });
    expect(Number((await k.billing(P4)).remaining)).toBeGreaterThan(0);
    expect(String(await k.close(P4))).toMatch(/not every invoice is paid yet|left to bill/);
    const before = await k.counts();

    const req = await k.request(a.id, FINANCE, REASON);
    expect(req).toMatchObject({ ok: true, code: 'REISSUE_REQUESTED', invoice_number: a.number, invoice_id: a.id, target_generation: 2 });
    const ap = await k.approvalRow(String(req.approval_number));
    expect(ap).toMatchObject({ action_type: 'REISSUE_INVOICE', entity_type: 'invoice', entity_id: a.id, status: 'PENDING',
      required_permission: 'invoice.approve', requested_by_actor_type: 'USER', requested_by: (await k.one(`select id::text from employees where employee_code = $1`, [FINANCE])).id,
      expected_record_version: (await k.invState(a)).record_version });
    expect(ap.idempotency_key).toBe(`reissue:request:${a.id}:0`);
    expect(ap.payload_hash).toBe(await k.previewHash(ap.action_payload as R));
    expect(ap.action_payload).toMatchObject({ invoice_number: a.number, invoice_status: 'VOIDED', invoice_sync_status: 'SYNCED',
      project_number: P4, project_status: 'COMPLETED', current_generation: 1, target_generation: 2, requested_reason: REASON,
      tenant: { tenant_id: A }, linked_xero_invoice_id: XID4 });
    const evidence = (ap.action_payload as R).void_evidence as R;
    expect(evidence).toMatchObject({ settlement: 'DELETED', tenant_id: A });
    expect(typeof evidence.run_id).toBe('string');
    expect(ap.decided_at).toBeNull();
    // Nothing is queued by a request: the write still is generation 1, and no generation 2 exists anywhere.
    expect(await k.outboxRows(a.id)).toHaveLength(1);
    expect(await k.ledger(a.id)).toHaveLength(1);

    const dec = await k.decide(String(req.approval_number), FINANCE);
    expect(dec).toMatchObject({ ok: true, code: 'REISSUE_QUEUED', invoice_number: a.number, invoice_id: a.id, generation: 2,
      superseded_generation: 1, outbox_idempotency_key: `xero:invoice:${a.id}:g2`, xero_idempotency_key: `roofops-${a.id}-g2` });
    expect(await k.ledger(a.id)).toMatchObject([
      { generation: 1, status: 'SUPERSEDED', xero_invoice_id: XID4, xero_invoice_number: a.xeroNumber, tenant_id: A,
        superseded_reason: expect.stringMatching(new RegExp(`Reissue ${String(req.approval_number)} by ${FINANCE}`)) as unknown },
      { generation: 2, status: 'PENDING', xero_invoice_id: null, key: `xero:invoice:${a.id}:g2`, approval_id: ap.id, opened_by: `operator:${FINANCE}` }]);
    expect(await k.ledger(a.id)).toHaveLength(2);
    const writes = await k.outboxRows(a.id);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ generation: 2, status: 'PENDING', idempotency_key: `xero:invoice:${a.id}:g2`,
      payload: { xero_tenant_id: A, xero_invoice_number: a.xeroNumber, generation: 2, xero_idempotency_key: `roofops-${a.id}-g2`,
        approval_number: String(req.approval_number), reissued_from_generation: 1, reissued_by: FINANCE } });
    // The invoice: same row, same number, collectible again through normal settlement.
    expect(await k.invState(a)).toMatchObject({ id: a.id, invoice_number: a.number, status: 'APPROVED', sync_status: 'PENDING', approval_id: ap.id });
    expect(await k.approvalRow(String(req.approval_number))).toMatchObject({ status: 'EXECUTED', decided_by: (await k.one(`select id::text from employees where employee_code = $1`, [FINANCE])).id,
      execution_result: { generation: 2, outbox_idempotency_key: `xero:invoice:${a.id}:g2`, superseded_generation: 1 } });
    // audit_id is not chronological for imported rows, so assert the reissue trail by membership, not by position.
    const trail = (await k.audit(a.id)).map(String);
    expect(trail).toEqual(expect.arrayContaining(['invoice.xero_settlement_applied', 'invoice.reissue_requested', 'invoice.reissued']));
    expect(trail.filter((x) => x.startsWith('invoice.reissue'))).toHaveLength(2);
    // Nothing was deleted: one more outbox row, one more approval, two more audit events, the same single invoice row.
    expect(await k.counts()).toMatchObject({ invoices: before.invoices, outbox: Number(before.outbox) + 1, approvals: Number(before.approvals) + 1,
      audit: Number(before.audit) + 2, ledger: Number(before.ledger) + 1 });
    expect(await k.col(`select count(*)::int v from invoices where project_id = (select project_id from invoices where id = $1) and invoice_type = 'FINAL'`, [a.id])).toEqual(['1']);
    // Billed again (the money sits on a live invoice now) and collectible through normal settlement; the close gate
    // refuses because it is unpaid, exactly as for any other approved final invoice.
    expect(Number((await k.billing(P4)).remaining)).toBe(0);
    expect(Number((await k.balance(a.id)).outstanding)).toBeGreaterThan(0);
    expect(String(await k.close(P4))).toMatch(/not every invoice is paid yet|left to bill/);
    expect(await k.integrityFails()).toEqual([]);
  }, 120_000);

  it('VAL-RIS-002 the Xero void path reissues the same invoice row, and the money stays owed', async () => {
    const a = await k.voidedScenario();
    expect(await k.invState(a)).toMatchObject({ status: 'VOIDED', voided_reason: expect.stringMatching(/^Voided in Xero \(verified by reconciliation /) as unknown });
    expect(await k.balance(a.id)).toMatchObject({ outstanding: '0.00', is_overdue: false });
    expect(Number((await k.billing(P4)).remaining)).toBeGreaterThan(0);
    expect(String(await k.close(P4))).toMatch(/not every invoice is paid yet|left to bill/);

    const req = await k.request(a.id, ADMIN, REASON);
    expect(req).toMatchObject({ ok: true, code: 'REISSUE_REQUESTED', target_generation: 2 });
    const dec = await k.decide(String(req.approval_number), ADMIN, 'checked the customer account');
    expect(dec).toMatchObject({ ok: true, code: 'REISSUE_QUEUED', generation: 2 });
    expect(await k.ledger(a.id)).toMatchObject([
      { generation: 1, status: 'SUPERSEDED', xero_invoice_id: XID4, superseded_reason: expect.stringMatching(/checked the customer account/) as unknown },
      { generation: 2, status: 'PENDING', opened_by: `operator:${ADMIN}` }]);
    expect(await k.invState(a)).toMatchObject({ invoice_number: a.number, status: 'APPROVED', sync_status: 'PENDING' });
    expect(await k.approvalRow(String(req.approval_number))).toMatchObject({ status: 'EXECUTED', decided_by: (await k.one(`select id::text from employees where employee_code = $1`, [ADMIN])).id });
    expect(await k.integrityFails()).toEqual([]);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-003: the reason is mandatory, and it is recorded where a person can find it.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-003 a request without a meaningful reason is refused and creates nothing; a real reason is recorded in all three places', async () => {
    const a = await k.deletedScenario();
    for (const reason of [null, '', '   ', 'too short']) {
      expect(await k.request(a.id, FINANCE, reason)).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    }
    await k.untouched(a);

    const req = await k.request(a.id, FINANCE, REASON);
    expect(req).toMatchObject({ ok: true, code: 'REISSUE_REQUESTED' });
    const ap = await k.approvalRow(String(req.approval_number));
    expect(ap.action_payload).toMatchObject({ requested_reason: REASON });
    const evidence = (ap.action_payload as R).void_evidence as R;
    expect(evidence).toMatchObject({ settlement: 'DELETED' });
    expect(typeof evidence.observation_id).toBe('string');
    expect(typeof evidence.run_id).toBe('string');
    // Operator attribution and timestamps on the approval.
    expect(ap.requested_by).toBe((await k.one(`select id::text from employees where employee_code = $1`, [FINANCE])).id);
    expect(ap.created_at).not.toBeNull();
    expect(Date.parse(String(ap.expires_at)) - Date.parse(String(ap.created_at))).toBe(168 * 3600 * 1000);   // invoice.approval_ttl_hours
    // The request audit event carries the reason, the actor and the void evidence.
    const reqAudit = await k.one(`select actor_type, actor_id, reason, after_state from audit_events where entity_id = $1 and action = 'invoice.reissue_requested'`, [a.id]);
    expect(reqAudit).toMatchObject({ actor_type: 'USER', actor_id: FINANCE, reason: REASON,
      after_state: { approval_number: String(req.approval_number), target_generation: 2, void_observation_id: ((ap.action_payload as R).void_evidence as R).observation_id,
        void_settlement: 'DELETED', linked_xero_invoice_id: XID4 } });

    const note = 'checked with the customer first';
    expect(await k.decide(String(req.approval_number), FINANCE, note)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED' });
    // ... the supersede reason, and the one audit event for the act, both carry the note and the request reason.
    expect(String((await k.ledger(a.id))[0]!.superseded_reason)).toContain(note);
    expect(String((await k.ledger(a.id))[0]!.superseded_reason)).toContain(REASON);
    const actAudit = await k.one(`select actor_type, actor_id, reason, before_state, after_state from audit_events where entity_id = $1 and action = 'invoice.reissued'`, [a.id]);
    expect(String(actAudit.reason)).toContain(note);
    expect(String(actAudit.reason)).toContain(REASON);
    expect(actAudit).toMatchObject({ actor_type: 'USER', actor_id: FINANCE,
      before_state: { status: 'VOIDED', generation: 1, superseded_xero_invoice_id: XID4, void_settlement: 'DELETED' },
      after_state: { status: 'APPROVED', generation: 2, approval_number: String(req.approval_number), outbox_idempotency_key: `xero:invoice:${a.id}:g2` } });
    expect(await k.approvalRow(String(req.approval_number))).toMatchObject({ decision_reason: note });
    expect((await k.approvalRow(String(req.approval_number))).decided_at).not.toBeNull();
    expect((await k.approvalRow(String(req.approval_number))).executed_at).not.toBeNull();
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-004: Finance/Admin authority only.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-004 only an active FINANCE/ADMIN employee may request or decide', async () => {
    const a = await k.deletedScenario();
    for (const by of [PM, INACTIVE, 'EMP-999', '', null as unknown as string]) {
      expect(await k.request(a.id, by, REASON)).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    }
    await k.untouched(a);

    const req = await k.request(a.id, FINANCE, REASON);
    expect(req).toMatchObject({ ok: true, code: 'REISSUE_REQUESTED' });
    expect(await k.decide(String(req.approval_number), PM, null)).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    expect(await k.decide(String(req.approval_number), INACTIVE, null)).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    // A refused decide consumes nothing: the request is still PENDING and nothing was queued.
    expect(await k.approvalRow(String(req.approval_number))).toMatchObject({ status: 'PENDING' });
    expect(await k.ledger(a.id)).toHaveLength(1);
    expect(await k.decide(String(req.approval_number), ADMIN, null)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED' });
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-005: a fresh approval bound to everything, and the original approval can never authorise a reissue.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-005 the decision needs a fresh, undecided, drift-free approval', async () => {
    const a = await k.deletedScenario();

    // (a) expired: the approval is marked EXPIRED and nothing is queued.
    const e = await k.request(a.id, FINANCE, REASON);
    await k.force(`update approvals set expires_at = now() - interval '1 hour' where approval_number = $1`, [String(e.approval_number)]);
    expect(await k.decide(String(e.approval_number), FINANCE, null)).toMatchObject({ ok: false, code: 'APPROVAL_EXPIRED' });
    expect(await k.approvalRow(String(e.approval_number))).toMatchObject({ status: 'EXPIRED' });
    await k.untouched(a);

    // (b) not pending: a cancelled request is refused, and the claim is released for a corrected retry.
    const c = await k.request(a.id, FINANCE, REASON);
    await k.force(`update approvals set status = 'CANCELLED', decision_reason = 'cancelled by the operator' where approval_number = $1`, [String(c.approval_number)]);
    expect(await k.decide(String(c.approval_number), FINANCE, null)).toMatchObject({ ok: false, code: 'APPROVAL_NOT_PENDING' });
    expect(await k.ledger(a.id)).toHaveLength(1);

    // (c) preview drift: a new verified read of the linked document changes the preview (and not the invoice row).
    const d = await k.request(a.id, FINANCE, REASON);
    await k.addObs(a, { verdict: 'VERIFIED', settlement: 'VOIDED', xeroInvoiceId: XID4, mins: 1 });
    expect(await k.decide(String(d.approval_number), FINANCE, null)).toMatchObject({ ok: false, code: 'PREVIEW_CHANGED' });
    expect(await k.approvalRow(String(d.approval_number))).toMatchObject({ status: 'CANCELLED' });
    expect(await k.ledger(a.id)).toHaveLength(1);

    // (d) record-version drift: the invoice row was touched (the preview hash itself is unchanged).
    const r = await k.request(a.id, FINANCE, REASON);
    const hashBefore = String((await k.approvalRow(String(r.approval_number))).payload_hash);
    await k.exec(`update invoices set voided_reason = voided_reason where id = $1`, [a.id]);   // a no-op write still bumps record_version
    expect(String((await k.checkOf(a.id)).target_generation)).toBe('2');
    expect(await k.decide(String(r.approval_number), FINANCE, null)).toMatchObject({ ok: false, code: 'RECORD_VERSION_CHANGED' });
    expect(String((await k.approvalRow(String(r.approval_number))).payload_hash)).toBe(hashBefore);

    // (e) generation drift: a later generation row appeared, so the bound target generation is stale.
    const g = await k.request(a.id, FINANCE, REASON);
    await k.force(`update invoice_xero_draft_generations set status = 'SUPERSEDED', superseded_at = now() where invoice_id = $1 and generation = 1`, [a.id]);
    await k.force(`insert into invoice_xero_draft_generations (invoice_id, generation, status, outbox_idempotency_key, opened_by)
                   values ($1, 2, 'FAILED', xero_draft_outbox_key($1, 2), 'operator:EMP-900')`, [a.id]);
    expect(await k.decide(String(g.approval_number), FINANCE, null)).toMatchObject({ ok: false, code: 'GENERATION_CHANGED' });
    expect(await k.ledger(a.id)).toHaveLength(2);

    // (f) the original CREATE_INVOICE approval is not a reissue request.
    const original = await k.one(`select approval_number from approvals where id = $1`, [a.approvalId]);
    expect(await k.decide(String(original.approval_number), FINANCE, null)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await k.decide('APR-1999-0001', FINANCE, null)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-006: project gates.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-006 the project must be COMPLETED, and never CLOSED or CANCELLED', async () => {
    const a = await k.deletedScenario(P1, XID1);
    const projectId = String((await k.invState(a)).id) && String((await k.one(`select project_id::text p from invoices where id = $1`, [a.id])).p);
    for (const [status, extra, code] of [['IN_PROGRESS', '', 'PROJECT_NOT_COMPLETED'], ['CLOSED', '', 'PROJECT_CLOSED'],
      ['CANCELLED', `, cancellation_reason = 'fixture'`, 'PROJECT_CANCELLED']] as const) {
      await k.force(`update projects set status = '${status}'${extra} where id = $1`, [projectId]);
      expect(await k.request(a.id, FINANCE, REASON), status).toMatchObject({ ok: false, code });
      expect(await k.decide('APR-2026-0001', FINANCE, null)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      await k.untouched(a);
      await k.noReissueApprovals();
    }
    await k.force(`update projects set status = 'COMPLETED' where id = $1`, [projectId]);
    expect(await k.request(a.id, FINANCE, REASON)).toMatchObject({ ok: true, code: 'REISSUE_REQUESTED' });
    expect(await k.integrityFails()).toEqual([]);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-007: void-evidence gates (tenancy first), and stability of the voided state.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-007 the void evidence gates: not voided, tenancy, and the three observation semantics', async () => {
    // (a) not voided at all.
    const live = await k.buildFinal(P4, XID4);
    await k.completeFinal(live);
    expect(await k.request(live.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'INVOICE_NOT_VOIDED' });
    expect(await k.ledger(live.id)).toHaveLength(1);
    expect(await k.outboxRows(live.id)).toHaveLength(1);
    expect(await k.invState(live)).toMatchObject({ status: 'APPROVED', sync_status: 'SYNCED' });
    await k.noReissueApprovals();

    // (b) the pin is missing.
    const a = await k.deletedScenario(P1, XID1);
    await k.force(`update app_settings set value = '' where key = 'xero.demo_tenant_id'`);
    expect(await k.request(a.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'TENANT_NOT_PINNED' });
    // (c) the pin disagrees with the tenant the write is bound to.
    await k.force(`update app_settings set value = $1 where key = 'xero.demo_tenant_id'`, [B]);
    expect(await k.request(a.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'TENANT_MISMATCH' });
    await k.force(`update app_settings set value = $1 where key = 'xero.demo_tenant_id'`, [A]);
    // (d) a void recorded in another tenant is not evidence.
    await k.addObs(a, { verdict: 'VERIFIED', settlement: 'VOIDED', tenantId: B, xeroInvoiceId: XID1, mins: 1 });
    expect(await k.request(a.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'TENANT_MISMATCH' });
    await k.force(`delete from xero_invoice_observations where tenant_id = $1 and invoice_id = $2`, [B, a.id]);
    expect(await k.request(a.id, FINANCE, REASON)).toMatchObject({ ok: true, code: 'REISSUE_REQUESTED' });
    // (e) a later verified read contradicting the void: the battery refuses (the request from (d) stays open, so the
    //     check is asked directly).
    await k.addObs(a, { verdict: 'VERIFIED', settlement: 'UNPAID', xeroInvoiceId: XID1, mins: 2 });
    expect(await k.checkOf(a.id)).toMatchObject({ ok: false, code: 'OBSERVATION_CONTRADICTED' });

    // (f) no verified observation at all: a local void (dead-lettered write, nothing in Xero) is not reissuable.
    const local = await k.buildFinal(P2, XID2);
    expect(await k.deadLetter(local)).toMatchObject({ retry: false });
    expect(await k.voidLocally(local)).toBeNull();
    expect(await k.request(local.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'VOID_NOT_VERIFIED' });
    expect(await k.ledger(local.id)).toHaveLength(1);
    expect(await k.outboxRows(local.id)).toHaveLength(1);
    expect(await k.invState(local)).toMatchObject({ status: 'VOIDED' });

    // (g) a void of a different InvoiceID is not proof of this one, neither is a read that is not void-family, and a
    //     failed read after the void is ambiguous - the invoice stays VOIDED and uncollectible throughout.
    const other = await k.buildFinal(P5, XID5);
    await k.completeFinal(other);
    await k.force(`update invoices set status = 'VOIDED', voided_reason = 'voided without a Xero read' where id = $1`, [other.id]);
    await k.addObs(other, { verdict: 'VERIFIED', settlement: 'VOIDED', xeroInvoiceId: uuidFor('another:document'), mins: 1 });
    expect(await k.request(other.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'VOID_NOT_VERIFIED' });
    await k.addObs(other, { verdict: 'VERIFIED', settlement: 'UNPAID', xeroInvoiceId: XID5, mins: 2 });
    expect(await k.request(other.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'VOID_NOT_VERIFIED' });
    await k.addObs(other, { verdict: 'LOOKUP_FAILED', settlement: null, xeroInvoiceId: XID5, mins: 3 });
    expect(await k.request(other.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'OBSERVATION_AMBIGUOUS' });
    expect(await k.invState(other)).toMatchObject({ status: 'VOIDED', sync_status: 'SYNCED' });
    expect(await k.balance(other.id)).toMatchObject({ outstanding: '0.00', is_overdue: false });
    expect(await k.ledger(other.id)).toHaveLength(1);
    expect(await k.outboxRows(other.id)).toHaveLength(1);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-008: money gates, at request and at decide.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-008 a verified payment, a credit, or a local payment row refuses the reissue at request and at decide', async () => {
    // The money read is EARLIER than the void (a later one would contradict the void first, per the pinned order).
    const paid = await k.buildFinal(P4, XID4);
    await k.completeFinal(paid);
    await k.addObs(paid, { verdict: 'VERIFIED', settlement: 'PARTIALLY_PAID', xeroInvoiceId: XID4, paid: 1000 });
    expect(await k.applyVoid(paid, 'DELETED')).toMatchObject({ ok: true, applied: 1 });
    expect(await k.request(paid.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'PAYMENT_EXISTS' });
    await k.untouched(paid);

    const credited = await k.buildFinal(P2, XID2);
    await k.completeFinal(credited);
    await k.addObs(credited, { verdict: 'VERIFIED', settlement: 'PARTIALLY_PAID', xeroInvoiceId: XID2, credited: 500 });
    expect(await k.applyVoid(credited, 'DELETED')).toMatchObject({ ok: true, applied: 1 });
    expect(await k.request(credited.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'CREDIT_EXISTS' });
    await k.untouched(credited);

    const local = await k.deletedScenario(P1, XID1);
    await k.exec(`insert into payments (invoice_id, amount, received_on, method, source) values ($1, 250, app_today(), 'BANK_TRANSFER', 'MANUAL')`, [local.id]);
    expect(await k.request(local.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'PAYMENT_EXISTS' });
    await k.untouched(local);

    // At decide: the request is fresh, then the money appears - the decision refuses and nothing is queued.
    const later = await k.deletedScenario(P5, XID5);
    const req = await k.request(later.id, FINANCE, REASON);
    expect(req).toMatchObject({ ok: true, code: 'REISSUE_REQUESTED' });
    await k.exec(`insert into payments (invoice_id, amount, received_on, method, source) values ($1, 100, app_today(), 'CASH', 'MANUAL')`, [later.id]);
    expect(await k.decide(String(req.approval_number), FINANCE, null)).toMatchObject({ ok: false, code: 'PAYMENT_EXISTS' });
    expect(await k.ledger(later.id)).toHaveLength(1);
    expect(await k.outboxRows(later.id)).toHaveLength(1);
    // ... and once the money is gone (a person deleted the mistaken row), the same approval decides: the claim was released.
    await k.exec(`delete from payments where invoice_id = $1`, [later.id]);
    expect(await k.decide(String(req.approval_number), FINANCE, null)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED' });
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-009: write-state gates, and one open request per invoice.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-009 a live write, an unknown write, or an open request refuses; no duplicate generation is created', async () => {
    // (a) a live write for the invoice.
    const live = await k.deletedScenario();
    await k.force(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, status, generation)
      select 'xero.create_draft_invoice', 'invoice', $1, correlation_id, xero_draft_outbox_key($1, 2), payload, 'PENDING', 2
        from outbox where idempotency_key = $2`, [live.id, live.key]);
    expect(await k.request(live.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'WRITE_IN_FLIGHT' });
    expect(await k.ledger(live.id)).toHaveLength(1);

    // (b) a retry-scheduled failure is still a live write.
    const retrying = await k.deletedScenario(P2, XID2);
    await k.force(`update outbox set status = 'FAILED', next_attempt_at = now() + interval '5 minutes' where idempotency_key = $1`, [retrying.key]);
    expect(await k.request(retrying.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'WRITE_IN_FLIGHT' });

    // (c) an unknown write.
    const unknown = await k.deletedScenario(P1, XID1);
    await k.exec(`update invoices set sync_status = 'UNKNOWN' where id = $1`, [unknown.id]);
    expect(await k.col(`select status v from invoice_xero_draft_generations where invoice_id = $1`, [unknown.id])).toEqual(['UNKNOWN']);
    expect(await k.request(unknown.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'PRIOR_WRITE_UNKNOWN' });
    expect(await k.ledger(unknown.id)).toHaveLength(1);
    expect(await k.outboxRows(unknown.id)).toHaveLength(1);
    expect(await k.invState(unknown)).toMatchObject({ status: 'VOIDED', sync_status: 'UNKNOWN' });

    // (d) an open request: refused, and no second approval.
    const open = await k.deletedScenario(P5, XID5);
    const first = await k.request(open.id, FINANCE, REASON);
    expect(first).toMatchObject({ ok: true, code: 'REISSUE_REQUESTED' });
    expect(await k.request(open.id, ADMIN, REASON)).toMatchObject({ ok: false, code: 'REISSUE_PENDING', approval_number: String(first.approval_number) });
    expect(await k.col(db, `select approval_number v from approvals where action_type = 'REISSUE_INVOICE'`)).toHaveLength(1);
    expect(await k.ledger(open.id)).toHaveLength(1);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-010: two simultaneous decisions (PostgreSQL, two connections).
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-010 two simultaneous decisions: exactly one queues, the loser refuses, and no partial state is left', async () => {
    const a = await k.deletedScenario();
    const req = await k.request(a.id, FINANCE, REASON);
    if (target !== 'postgres' || !db.url) {
      // PGlite is a single in-process connection: a genuine two-connection race is a PostgreSQL case (VAL-RIS-010).
      expect(target).toBe('pglite');
      return;
    }
    const other = await openPostgres(db.url);
    try {
      const results = await Promise.all([
        k.decide(String(req.approval_number), FINANCE, null),
        other.query<{ r: R }>(`select ops_reissue_decide($1, $2, $3) r`, [String(req.approval_number), ADMIN, null]).then((rows) => rows[0]!.r),
      ]);
      const queued = results.filter((r) => r.code === 'REISSUE_QUEUED');
      expect(queued, JSON.stringify(results)).toHaveLength(1);
      const refused = results.find((r) => r.code !== 'REISSUE_QUEUED')!;
      expect(refused).toMatchObject({ ok: false });
      expect(['ALREADY_PROCESSED', 'APPROVAL_NOT_PENDING']).toContain(String(refused.code));
      // Exactly one new generation, one new outbox row, one superseded predecessor, the invoice updated once.
      expect(await k.ledger(a.id)).toMatchObject([{ generation: 1, status: 'SUPERSEDED' }, { generation: 2, status: 'PENDING' }]);
      expect(await k.outboxRows(a.id)).toHaveLength(2);
      expect(await k.approvalRow(String(req.approval_number))).toMatchObject({ status: 'EXECUTED' });
      expect(await k.invState(a)).toMatchObject({ status: 'APPROVED', sync_status: 'PENDING' });
      expect(await k.col(db, `select action v from audit_events where entity_id = $1 and action = 'invoice.reissued'`, [a.id])).toHaveLength(1);
      expect(await k.col(db, `select consumer v from processed_events where consumer = $1`, [`invoice.reissue:${String(req.approval_number)}`]))
        .toEqual([`invoice.reissue:${String(req.approval_number)}`]);
    } finally { await other.close(); }
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-011: replay, duplicate requests, recovery from an expired request.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-011 a replay creates nothing, a double request is refused, and an expired request is replaced', async () => {
    const a = await k.deletedScenario();
    const req = await k.request(a.id, FINANCE, REASON);
    expect(await k.decide(String(req.approval_number), FINANCE, null)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED' });
    const after = await k.counts();
    const replay = await k.decide(String(req.approval_number), FINANCE, null);
    expect(replay).toMatchObject({ ok: false, code: 'ALREADY_PROCESSED', duplicate: true, generation: 2 });
    expect(await k.counts()).toEqual(after);
    expect(await k.ledger(a.id)).toHaveLength(2);

    // A second request while the (now executed) one is closed: allowed, but the invoice is no longer VOIDED.
    expect(await k.request(a.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'INVOICE_NOT_VOIDED' });

    // Expiry recovery: the open request expires, a fresh request replaces it and decides.
    const b = await k.deletedScenario(P2, XID2);
    const stale = await k.request(b.id, FINANCE, REASON);
    await k.force(`update approvals set expires_at = now() - interval '1 minute' where approval_number = $1`, [String(stale.approval_number)]);
    const fresh = await k.request(b.id, FINANCE, REASON);
    expect(fresh).toMatchObject({ ok: true, code: 'REISSUE_REQUESTED' });
    expect(String(fresh.approval_number)).not.toBe(String(stale.approval_number));
    expect(await k.approvalRow(String(stale.approval_number))).toMatchObject({ status: 'CANCELLED' });
    expect(await k.approvalRow(String(fresh.approval_number))).toMatchObject({ status: 'PENDING', idempotency_key: `reissue:request:${b.id}:1` });
    // The superseded (cancelled) one can never be decided: refused before the fresh one is, so the refusal is the
    // approval state and not the replacement's in-flight write.
    expect(await k.decide(String(stale.approval_number), FINANCE, null)).toMatchObject({ ok: false, code: 'APPROVAL_NOT_PENDING' });
    expect(await k.decide(String(fresh.approval_number), FINANCE, null)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED', generation: 2 });
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-012: raw SQL cannot bypass the guard.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-012 the reissue guard refuses raw SQL without the approval, the money or the void proof, and excludes its own write', async () => {
    const a = await k.deletedScenario();
    // (a) no approval attached (the invoice still carries its CREATE_INVOICE approval).
    const noApproval = await k.rejects(`update invoices set status = 'APPROVED' where id = '${a.id}'`, /REISSUE_INVOICE approval/);
    expect(noApproval).not.toMatch(/state machine check failed/);        // the guard fires, not the state machine
    // (b) an approval of the wrong action type.
    await k.rejects(`update invoices set status = 'APPROVED', approval_id = '${a.approvalId}' where id = '${a.id}'`, /REISSUE_INVOICE approval/);
    expect(await k.invState(a)).toMatchObject({ status: 'VOIDED' });

    // (c) money moved: a valid pending request, but a payment exists.
    const paid = await k.deletedScenario(P2, XID2);
    const pReq = await k.request(paid.id, FINANCE, REASON);
    await k.exec(`insert into payments (invoice_id, amount, received_on, method, source) values ($1, 10, app_today(), 'CASH', 'MANUAL')`, [paid.id]);
    await k.rejects(`update invoices set status = 'APPROVED', sync_status = 'PENDING',
      approval_id = (select id from approvals where approval_number = '${String(pReq.approval_number)}') where id = '${paid.id}'`, /money moved/);
    expect(await k.invState(paid)).toMatchObject({ status: 'VOIDED' });

    // (d) no void proof: a reissue approval exists, but nothing verified the void in Xero.
    const noProof = await k.buildFinal(P1, XID1);
    await k.completeFinal(noProof);
    await k.force(`update invoices set status = 'VOIDED', voided_reason = 'voided without a Xero read' where id = $1`, [noProof.id]);
    const fixtureApr = await k.q1<string>(`insert into approvals (approval_number, action_type, entity_type, entity_id, business_reference,
        requested_by_actor_type, requested_by_employee_id, required_permission, action_payload, payload_hash, expected_record_version,
        idempotency_key, expires_at) values (next_friendly_id('APR', extract(year from app_today())::int), 'REISSUE_INVOICE', 'invoice', $1,
        $2, 'USER', (select id from employees where employee_code = '${FINANCE}'), 'invoice.approve', '{}'::jsonb, 'fixture', 1,
        'reissue:fixture:' || gen_random_uuid(), now() + interval '1 day') returning approval_number r`, [noProof.id, noProof.number]);
    expect(fixtureApr).toMatch(/^APR-2026-\d{4}$/);
    await k.rejects(`update invoices set status = 'APPROVED', sync_status = 'PENDING',
      approval_id = (select id from approvals where approval_number = '${fixtureApr}') where id = '${noProof.id}'`, /verified void or deletion/);
    expect(await k.invState(noProof)).toMatchObject({ status: 'VOIDED' });
    // ... and neither does an expired one: freshness is part of the binding (the guard, not only the decide, checks it).
    await k.force(`update approvals set expires_at = now() - interval '1 minute' where approval_number = $1`, [fixtureApr]);
    await k.rejects(`update invoices set status = 'APPROVED', sync_status = 'PENDING',
      approval_id = (select id from approvals where approval_number = '${fixtureApr}') where id = '${noProof.id}'`, /matching REISSUE_INVOICE approval attached/);
    expect(await k.invState(noProof)).toMatchObject({ status: 'VOIDED' });

    // (e) a valid pending reissue approval plus the evidence is still not a recovery path (audit P2-H1): the transition is
    //     refused, nothing is consumed and no generation is opened; only the ops_reissue_decide transaction may do it.
    const okReq = await k.request(a.id, FINANCE, REASON);
    await k.rejects(`update invoices set status = 'APPROVED', sync_status = 'PENDING',
      approval_id = (select id from approvals where approval_number = '${String(okReq.approval_number)}') where id = '${a.id}'`, /only ops_reissue_decide/);
    expect(await k.invState(a)).toMatchObject({ status: 'VOIDED' });
    expect(await k.approvalRow(String(okReq.approval_number))).toMatchObject({ status: 'PENDING' });
    expect(await k.ledger(a.id)).toHaveLength(1);                         // raw SQL is not a recovery path: no generation was opened

    // (f) a live write of an OLDER generation still refuses ...
    const self = await k.deletedScenario(P5, XID5);
    const selfReq = await k.request(self.id, FINANCE, REASON);
    await k.force(`update invoice_xero_draft_generations set status = 'SUPERSEDED', superseded_at = now() where invoice_id = $1 and generation = 1`, [self.id]);
    await k.force(`insert into invoice_xero_draft_generations (invoice_id, generation, status, outbox_idempotency_key, opened_by)
                   values ($1, 2, 'FAILED', xero_draft_outbox_key($1, 2), 'operator:${FINANCE}')`, [self.id]);
    await k.force(`update outbox set status = 'PENDING', next_attempt_at = now() where idempotency_key = $1`, [self.key]);
    await k.rejects(`update invoices set status = 'APPROVED', sync_status = 'PENDING',
      approval_id = (select id from approvals where approval_number = '${String(selfReq.approval_number)}') where id = '${self.id}'`, /older generation/);
    expect(await k.invState(self)).toMatchObject({ status: 'VOIDED' });

    // (g) ... and a hand-forged live write at the target generation does not make raw SQL a recovery path either (audit
    //     P2-H1): the older-generation check no longer fires, but the transition is still refused because it is not the
    //     ops_reissue_decide transaction (the approval is PENDING, unconsumed, and generation 2 is not bound to it).
    await k.force(`update invoice_xero_draft_generations set status = 'PENDING' where invoice_id = $1 and generation = 2`, [self.id]);
    await k.force(`update outbox set status = 'DONE', next_attempt_at = 'infinity' where idempotency_key = $1`, [self.key]);
    await k.force(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, status, generation)
      select 'xero.create_draft_invoice', 'invoice', $1, correlation_id, xero_draft_outbox_key($1, 2), payload, 'PENDING', 2
        from outbox where idempotency_key = $2`, [self.id, self.key]);
    await k.rejects(`update invoices set status = 'APPROVED', sync_status = 'PENDING',
      approval_id = (select id from approvals where approval_number = '${String(selfReq.approval_number)}') where id = '${self.id}'`, /only ops_reissue_decide/);
    expect(await k.invState(self)).toMatchObject({ status: 'VOIDED' });

    // Ordering: the guard is a separate trigger on invoices, and it fires before the state-machine trigger (name order).
    const triggers = await k.col(db, `select tgname v from pg_trigger where tgrelid = 'public.invoices'::regclass and not tgisinternal order by tgname`);
    expect(triggers).toContain('invoices_reissue_guard');
    expect(triggers.indexOf('invoices_reissue_guard')).toBeLessThan(triggers.indexOf('invoices_state_machine'));
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-013: link movement is proof-gated.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-013 the link moves only on a proof-gated generation 2 completion, and never overwrites another invoice', async () => {
    const a = await k.deletedScenario(P1, XID1);
    const req = await k.request(a.id, FINANCE, REASON);
    expect(await k.decide(String(req.approval_number), FINANCE, null)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED' });
    const gen2 = (await k.outboxRows(a.id))[1]!;
    const newXid = uuidFor(`replacement:${a.id}`);
    expect(await k.link(a.id)).toBe(XID1);

    // Without the proofs the completion is refused and the link never moves.
    expect(await k.claim(String(gen2.idempotency_key), 'n8n:05')).toMatchObject({ claimed: true });
    await expect(k.complete(String(gen2.idempotency_key), gen2.payload as R, { invoice_id: newXid, total: Number((gen2.payload as R).amount_inc_gst) + 1 }))
      .rejects.toThrow(/does not match the approved/);
    expect(await k.link(a.id)).toBe(XID1);
    expect(await k.linkRows(a.id)).toHaveLength(1);
    // ... and so is a wrong tenant or a non-DRAFT read-back.
    await expect(k.complete(String(gen2.idempotency_key), gen2.payload as R, { invoice_id: newXid, tenant_id: B })).rejects.toThrow(/not the pinned Demo Company tenant/);
    await expect(k.complete(String(gen2.idempotency_key), gen2.payload as R, { invoice_id: newXid, status: 'AUTHORISED' })).rejects.toThrow(/must be an ACCREC DRAFT/);
    expect(await k.link(a.id)).toBe(XID1);

    // With every proof, the one current link moves to the replacement's InvoiceID and the old one stays in history.
    expect(await k.complete(String(gen2.idempotency_key), gen2.payload as R, { invoice_id: newXid })).toMatchObject({ status: 'RECORDED' });
    expect(await k.link(a.id)).toBe(newXid);
    expect(await k.linkRows(a.id)).toMatchObject([{ external_id: newXid, verified: true }]);
    expect(await k.ledger(a.id)).toMatchObject([{ generation: 1, status: 'SUPERSEDED', xero_invoice_id: XID1 },
      { generation: 2, status: 'CREATED', xero_invoice_id: newXid }]);
    expect(await k.invState(a)).toMatchObject({ status: 'APPROVED', sync_status: 'SYNCED' });
    expect(await k.integrityFails()).toEqual([]);
    // The superseded identity is still queryable (ledger, observations) and the invoice number is unchanged.
    expect(await k.col(db, `select xero_invoice_id v from invoice_xero_draft_generations where invoice_id = $1 and generation = 1`, [a.id])).toEqual([XID1]);
    expect(await k.col(db, `select distinct xero_invoice_id v from xero_invoice_observations where invoice_id = $1 and xero_invoice_id = $2`, [a.id, XID1])).toEqual([XID1]);

    // A generation-1 completion still refuses a second link, and so does a generation 2 whose predecessor was never
    // superseded (both on the same invoice: the outbox row is what the completion reads).
    const one = await k.buildFinal(P2, XID2);
    await k.completeFinal(one);
    await k.force(`update outbox set status = 'DISPATCHING' where idempotency_key = $1`, [one.key]);
    await expect(k.complete(one.key, one.payload, { invoice_id: uuidFor('second:link') })).rejects.toThrow(/already linked to Xero invoice/);
    expect(await k.link(one.id)).toBe(XID2);
    await k.force(`update outbox set generation = 2 where idempotency_key = $1`, [one.key]);
    // Since P2-D2 the unproven generation 2 is refused before the link check is reached.
    await expect(k.complete(one.key, one.payload, { invoice_id: uuidFor('second:link:2') })).rejects.toThrow(/the generation 2 Xero draft .* was not linked/);
    expect(await k.link(one.id)).toBe(XID2);

    // The new InvoiceID cannot overwrite another invoice's link.
    const other = await k.buildFinal(P4, XID4);
    await k.completeFinal(other);
    const b = await k.deletedScenario(P5, XID5);
    const bReq = await k.request(b.id, FINANCE, REASON);
    expect(await k.decide(String(bReq.approval_number), FINANCE, null)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED' });
    const bGen2 = (await k.outboxRows(b.id))[1]!;
    expect(await k.claim(String(bGen2.idempotency_key), 'n8n:05')).toMatchObject({ claimed: true });
    await expect(k.complete(String(bGen2.idempotency_key), bGen2.payload as R, { invoice_id: other.xid })).rejects.toThrow(/unique|duplicate key/i);
    expect(await k.link(b.id)).toBe(XID5);
    expect(await k.link(other.id)).toBe(other.xid);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-014: privileges and security posture.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-014 the reissue functions are owner-only SECURITY DEFINER, and the ledger stays closed', async () => {
    const fns = ['invoice_reissue_generation(uuid)', 'invoice_reissue_preview(uuid,text)', 'invoice_reissue_preview_hash(jsonb)',
      'invoice_reissue_check(uuid)', 'invoice_reissue_guard()', 'ops_reissue_request(uuid,text,text)', 'ops_reissue_decide(text,text,text)'];
    for (const f of fns) {
      for (const role of ['roofops_workflow', 'roofops_dashboard']) {
        expect(await k.col(db, `select has_function_privilege($1, $2, 'execute')::text v`, [role, f]), `${role} ${f}`).toEqual(['false']);
      }
    }
    // No PUBLIC execute on anything this migration added, and the workflow's own allow-list is untouched.
    expect(await k.col(db, `select p.proname v from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
      aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where n.nspname = 'public' and a.grantee = 0 and a.privilege_type = 'EXECUTE'`)).toEqual([]);
    expect(await k.col(db, `select has_function_privilege('roofops_workflow', 'wf_complete_side_effect(text,jsonb)', 'execute')::text v`)).toEqual(['true']);
    expect(await k.col(db, `select p.proname v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('roofops_workflow', p.oid, 'execute') order by 1`)).toHaveLength(22);   // + wf_reissue_dispatch (P2-D1)
    expect(await k.col(db, `select has_function_privilege('roofops_workflow', 'wf_reissue_dispatch(text,text)', 'execute')::text v`)).toEqual(['true']);
    // SECURITY DEFINER with a safe search_path.
    for (const f of ['invoice_reissue_generation', 'invoice_reissue_preview', 'invoice_reissue_preview_hash', 'invoice_reissue_check',
      'invoice_reissue_guard', 'ops_reissue_request', 'ops_reissue_decide']) {
      const r = await k.one(`select prosecdef, coalesce(array_to_string(proconfig, ','), '') config, prokind from pg_proc where proname = $1`, [f]);
      expect(r, f).toMatchObject({ prosecdef: true, config: 'search_path=public, pg_temp' });
    }
    // The ledger is RLS-enabled and unreadable for the application roles.
    expect(await k.one(`select relrowsecurity from pg_class where relname = 'invoice_xero_draft_generations'`)).toMatchObject({ relrowsecurity: true });
    for (const role of ['roofops_workflow', 'roofops_dashboard']) {
      expect(await k.col(db, `select has_table_privilege($1, 'invoice_xero_draft_generations', 'select')::text v`, [role])).toEqual(['false']);
    }
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-015: the tenant is never caller-supplied.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-015 the tenant is derived, and a queued write keeps the pinned tenant', async () => {
    // No tenant parameter exists on any of the new functions.
    for (const f of ['ops_reissue_request', 'ops_reissue_decide', 'invoice_reissue_check', 'invoice_reissue_preview']) {
      expect(await k.col(db, `select pg_get_function_arguments(p.oid) v from pg_proc p where p.proname = $1`, [f]))
        .toEqual([expect.not.stringMatching(/tenant/i) as unknown as string]);
    }
    const a = await k.deletedScenario();
    const req = await k.request(a.id, FINANCE, REASON);
    expect(await k.decide(String(req.approval_number), FINANCE, null)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED' });
    const gen2 = (await k.outboxRows(a.id))[1]!;
    expect((gen2.payload as R).xero_tenant_id).toBe(A);
    expect(await k.ledger(a.id)).toMatchObject([{ generation: 1, tenant_id: A }, { generation: 2, tenant_id: A }]);
    // The bound tenant of a queued write cannot be changed, even by raw SQL.
    await k.rejects(`update outbox set payload = payload || jsonb_build_object('xero_tenant_id', '${B}') where idempotency_key = '${String(gen2.idempotency_key)}'`,
      /tenant of .* is fixed/);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-016: nothing reissues automatically.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-016 applying a verified void queues nothing; only a decision creates a generation', async () => {
    const a = await k.deletedScenario();
    await k.untouched(a);
    expect(await k.col(db, `select generation::text v from invoice_xero_draft_generations where invoice_id = $1 and generation > 1`, [a.id])).toEqual([]);
    expect(await k.col(db, `select generation::text v from outbox where aggregate_id = $1 and generation > 1`, [a.id])).toEqual([]);
    expect(await k.col(db, `select action v from audit_events where entity_id = $1 and action like 'invoice.reissue%'`, [a.id])).toEqual([]);
    // A local void of a dead-lettered write (the AC-05 path) likewise queues nothing.
    const local = await k.buildFinal(P2, XID2);
    await k.deadLetter(local);
    expect(await k.voidLocally(local)).toBeNull();
    expect(await k.col(db, `select generation::text v from outbox where aggregate_id = $1 and generation > 1`, [local.id])).toEqual([]);
    expect(await k.col(db, `select generation::text v from invoice_xero_draft_generations where invoice_id = $1 and generation > 1`, [local.id])).toEqual([]);
    // Only the decision does, once.
    const req = await k.request(a.id, FINANCE, REASON);
    expect(await k.col(db, `select generation::text v from invoice_xero_draft_generations where invoice_id = $1 and generation > 1`, [a.id])).toEqual([]);
    expect(await k.decide(String(req.approval_number), FINANCE, null)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED' });
    expect(await k.col(db, `select generation::text v from invoice_xero_draft_generations where invoice_id = $1 and generation > 1`, [a.id])).toEqual(['2']);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-017: unknown and non-canonical references.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-017 unknown references and non-canonical invoices are refused with nothing created', async () => {
    expect(await k.request(randomUUID(), FINANCE, REASON)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await k.decide('APR-1999-0009', FINANCE, null)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await k.col(db, `select approval_number v from approvals where action_type = 'REISSUE_INVOICE'`)).toEqual([]);

    // An imported invoice (record_origin IMPORT) and a non-final one are never reissued.
    const imported = await k.one(`select id::text, invoice_number, invoice_type, record_origin from invoices where record_origin = 'IMPORT' limit 1`);
    expect(imported.record_origin).toBe('IMPORT');
    expect(await k.request(String(imported.id), FINANCE, REASON)).toMatchObject({ ok: false, code: 'NOT_FINAL_INVOICE' });
    const [nonFinal] = await db.query<{ id: string }>(`select id::text id from invoices where invoice_type <> 'FINAL' and record_origin = 'ROOFOPS' limit 1`);
    if (nonFinal !== undefined) expect(await k.request(nonFinal.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'NOT_FINAL_INVOICE' });
    // ... and neither is a RoofOps FINAL invoice whose canonical key was tampered with.
    const a = await k.deletedScenario();
    await k.force(`update invoices set idempotency_key = 'not-the-canonical-key' where id = $1`, [a.id]);
    expect(await k.request(a.id, FINANCE, REASON)).toMatchObject({ ok: false, code: 'NOT_FINAL_INVOICE' });
    await k.untouched(a);
    expect(await k.col(db, `select approval_number v from approvals where action_type = 'REISSUE_INVOICE'`)).toEqual([]);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-RIS-018: a local void during the reissue window is refused; the exemption is back once the replacement is done.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-RIS-018 a local void is refused while the replacement generation is live, and applies again after it completed', async () => {
    const a = await k.deletedScenario();
    const req = await k.request(a.id, FINANCE, REASON);
    expect(await k.decide(String(req.approval_number), FINANCE, null)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED' });
    // The reissue window: APPROVED with the replacement queued, and the superseded generation's document still linked.
    expect(await k.invState(a)).toMatchObject({ status: 'APPROVED', sync_status: 'PENDING' });
    expect(await k.link(a.id)).toBe(XID4);
    expect(await k.voidLocally(a)).toMatch(/cannot be voided: its Xero draft is queued/);
    expect(await k.invState(a)).toMatchObject({ status: 'APPROVED', sync_status: 'PENDING' });
    // While 05 is creating it, the same refusal (as any in-flight write).
    const gen2 = (await k.outboxRows(a.id))[1]!;
    expect(await k.claim(String(gen2.idempotency_key), 'n8n:05')).toMatchObject({ claimed: true });
    expect(await k.voidLocally(a)).toMatch(/cannot be voided: its Xero draft is being created/);
    expect(await k.invState(a)).toMatchObject({ status: 'APPROVED' });

    // The replacement completes: the link moves, and a verified void read of the NEW document is the exemption's proof.
    const newXid = uuidFor(`replacement:${a.id}`);
    expect(await k.complete(String(gen2.idempotency_key), gen2.payload as R, { invoice_id: newXid })).toMatchObject({ status: 'RECORDED' });
    expect(await k.link(a.id)).toBe(newXid);
    const observe = await k.openRun('observe');
    expect(await k.settle(observe, [{ invoice_id: newXid, tenant_id: A, http: 200, xero_invoice_number: a.xeroNumber,
      xero: { ...k.doc(a, 'VOIDED', { InvoiceID: newXid }), Status: 'VOIDED', AmountDue: 0 } }])).toMatchObject({ ok: true, applied: 0 });
    expect(await k.invState(a)).toMatchObject({ status: 'APPROVED' });            // observe applied nothing
    expect(await k.voidLocally(a)).toBeNull();                                    // the exemption applies as before
    expect(await k.invState(a)).toMatchObject({ status: 'VOIDED' });
    expect(await k.balance(a.id)).toMatchObject({ outstanding: '0.00', is_overdue: false });
    expect(await k.integrityFails()).toEqual([]);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // The preview itself: the exact payload the architecture names, and its hash rule.
  // ---------------------------------------------------------------------------------------------------------------
  it('the preview carries the architecture\'s fields, hashes without the record version, and follows the invoice', async () => {
    const a = await k.deletedScenario();
    const p = await k.previewOf(a.id, REASON);
    expect(p).toMatchObject({ ok: true });
    const preview = p.preview as R;
    expect(preview).toMatchObject({ invoice_id: a.id, invoice_number: a.number, xero_invoice_number: a.xeroNumber, invoice_type: 'FINAL',
      record_origin: 'ROOFOPS', invoice_status: 'VOIDED', invoice_sync_status: 'SYNCED', project_number: P4, project_status: 'COMPLETED',
      linked_xero_invoice_id: XID4, current_generation: 1, target_generation: 2, requested_reason: REASON,
      tenant: { tenant_id: A }, line_count: 1 });
    expect(typeof (preview.tenant as R).tenant_name).toBe('string');
    expect(typeof preview.total_inc_gst).toBe('number');
    expect(typeof preview.gst_amount).toBe('number');
    expect(typeof preview.lines_hash).toBe('string');
    expect(typeof preview.invoice_record_version).toBe('number');
    const evidence = preview.void_evidence as R;
    expect(evidence).toMatchObject({ settlement: 'DELETED', tenant_id: A });
    expect(typeof evidence.observation_id).toBe('string');
    expect(typeof evidence.run_id).toBe('string');
    // The hash excludes invoice_record_version: touching the row changes the record version, not the hash.
    const hash = await k.previewHash(preview);
    const touched = { ...preview, invoice_record_version: Number(preview.invoice_record_version) + 7 };
    expect(await k.previewHash(touched)).toBe(hash);
    expect(await k.previewHash({ ...preview, requested_reason: 'a different reason' })).not.toBe(hash);
    // An unknown invoice is NOT_FOUND, not an exception.
    expect(await k.previewOf(randomUUID())).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  }, 120_000);
});