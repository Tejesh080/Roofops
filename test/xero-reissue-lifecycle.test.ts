/**
 * AC-14C Part C (docs/defect-ledger.md; validation contract VAL-CROSS-001..005, VAL-BAL-006): the deterministic
 * end-to-end recovery proof for a Xero-verified DELETED or VOIDED final invoice.
 *
 * The whole scenario runs through the real paths only - no network, no hosted system:
 *   * the project is born from an accepted quote through 01 (`wf_quote_accepted`) and completed through 06
 *     (`wf_airtable_change`: Scheduled -> In Progress -> Completed, the two COMPLETION checklist items Done);
 *   * the final invoice, its approval and the Xero draft write with its read-back proofs are built by the committed
 *     scenario builder (test/helpers/reissue-scenario.ts: 04 prepare/approve -> 05 claim/complete);
 *   * every Xero read is a real 07 run: the recorded nodes from `n8n/07-reconcile.sdk.ts` executed by the test runner
 *     against a fake Xero HTTP handler (the repo's established e2e pattern - see test/xero-settlement.test.ts);
 *   * the recovery itself is `ops_reissue_request` / `ops_reissue_decide` - the database decides, the test only calls.
 *
 * What is pinned, per assertion ID:
 *   VAL-CROSS-001/002  the full lifecycle for a verified DELETED and for a verified VOIDED invoice: project ->
 *                      canonical FINAL invoice -> approve -> draft with tenant + InvoiceID bound -> verified void ->
 *                      RoofOps VOIDED (reason recorded, integrity green) -> close refused while money is owed ->
 *                      operator request -> fresh approval -> decide -> generation 2 (same invoice number, old
 *                      InvoiceID retained, new generation-aware outbox identity) -> new draft/readback -> exact new
 *                      InvoiceID bound -> verified settlement (AUTHORISED/UNPAID => ISSUED) -> PAID only from a
 *                      verified read -> project closes -> reconciliation clean. Exactly one live draft generation at
 *                      every stage.
 *   VAL-CROSS-003      the stale-read window: a 07 run between the decision and the new draft's completion, against the
 *                      superseded InvoiceID (still linked at that moment), reporting DELETED, a lookup failure or a
 *                      contradictory live document, changes nothing and cannot re-void the invoice or move the
 *                      link/generation; a stale delivery against the old InvoiceID after the link moved is inert, and
 *                      the balance can only come from the new generation's reads.
 *   VAL-CROSS-004      the existing protections stay intact: the named integrity rules are PASS (not merely "no FAIL")
 *                      at the void, through the reissue and after the close. The targeted AC-04/05/06/08/13A/14 suites
 *                      (xero-settlement, invoice-void, xero-tenant-binding, invoice-approval-binding, billing-entitlement,
 *                      over-billing, state-integrity, dashboard, schema, import) were run on both engines with the new
 *                      schema: 10 files passed, 0 failed, and the full dual-engine battery is 32 passed | 3 skipped (35)
 *                      files, 707 passed | 36 skipped (743) tests, exit 0.
 *   VAL-CROSS-005      the close gate: refused with the "left to bill" class while the money is owed (dashboard
 *                      needs_attention true, the blocker naming the voided final and the money still owed), allowed
 *                      after the verified PAID, with the dashboard money-owed following the same states.
 *   VAL-BAL-006        collectibility returns only through the correct states: in the decide window the invoice is
 *                      APPROVED/PENDING - not ISSUED/PARTIALLY_PAID, and the dashboard's money-owed excludes it
 *                      (`outstanding` is deliberately NOT asserted to be 0 there); after the new draft's verified
 *                      read the balance shows the verified amount due from the new generation only, with no residue
 *                      of the voided generation.
 *
 * Two documented facts this file pins rather than hides:
 *   * while the invoice is VOIDED there is no live FINAL invoice, so `project_left_to_bill_after_final` is null by
 *     design (migration 20261001160000 / architecture 4.3: entitlement stays visible through project_billing, the
 *     preview refusal and the close gate); the dashboard's blocker for that window is the "final invoice ... was
 *     voided ... needs a person" one, and the close refusal is the left-to-bill class.
 *   * a verified void read through the real 07 nodes records the superseded document as EXTERNAL_MISSING drift and
 *     opens that exception (test/xero-settlement.test.ts test 5 pins the same), and the void itself opens the AC-05
 *     "a replacement final invoice needs a person" exception. Both are a person's to answer: they are closed the
 *     documented way - `npm run exception:resolve` / `ops_resolve_exception`, audited, with a reason - which is what
 *     turns the dashboard's needs_attention off once the replacement is settled.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';
import { recorded } from './helpers/n8n-sdk-shim.js';
import { N8nRun, type HttpRequest, type Item } from './helpers/n8n-runner.js';
import { approvedReissueScenario, deletedReissueScenario, voidedReissueScenario, type ReissueScenario } from './helpers/reissue-scenario.js';

type R = Record<string, unknown>;
const APPROVER = 'usr7uCnNO15fCefbH';                 // the Airtable approver the invoice flow uses (mapped to EMP-900)
const A = '11111111-2222-3333-4444-555555555555';     // the pinned tenant, and every write's bound tenant
const FINANCE = 'EMP-900';                            // FINANCE, active (the dataset's approver): requests/resolves
const ADMIN = 'EMP-901';                              // ADMIN, active (scenario fixture): decides
const REASON = 'Xero deleted the draft; the customer still owes the job';
const T_PROJECTS = 'tblvUPIoebC3zoacv';
const F = { status: 'fldi2Qwz1dAh2tcTE', start: 'fld8rf6RZLgfs6Ron', end: 'fldvZtiassZEgLMAN', photos: 'fldbbksVL3dT6cqyS', cert: 'fldf7iJiyHFxOQgUy' };
const P4 = 'PRJ-2026-0004';                           // imported: fully paid invoices, final 14,664.49 left to bill
const Q_DELETED = 'Q-2026-0052';                      // cleanly acceptable quotes (no project yet in the import)
const Q_VOIDED = 'Q-2026-0054';
const XID4 = 'aaaaaaaa-bbbb-cccc-dddd-0000000000a4';
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;
const uuidFor = (seed: string) => createHash('md5').update(seed).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
/** The integrity rules this file holds to PASS, in check_key order. */
const NAMED_CHECKS = ['closed_project_settled', 'done_has_proof', 'one_final_per_project', 'voided_invoice_has_no_xero_write',
  'xero_link_only_when_synced', 'xero_synced_has_verified_link'];
const NAMED_PASS = NAMED_CHECKS.map((k) => `${k}:PASS`).sort();

/** Fake Xero: GET /Invoices/{InvoiceID} per tenant; failures injectable; every request recorded. */
class FakeXero {
  readonly requests: HttpRequest[] = [];
  readonly invoices = new Map<string, R>();         // `${tenant}:${InvoiceID}`
  fail: ((req: HttpRequest) => { statusCode: number } | 'network' | null) = () => null;
  handle = (req: HttpRequest) => {
    this.requests.push(req);
    const f = this.fail(req);
    if (f === 'network') throw new Error('ETIMEDOUT: socket hang up');
    if (f) return { statusCode: f.statusCode, body: { Title: 'injected', Status: f.statusCode } };
    const m = /^https:\/\/api\.xero\.com\/api\.xro\/2\.0\/Invoices\/([0-9a-f-]{36})$/.exec(req.url);
    if (req.method !== 'GET' || !m) return { statusCode: 400, body: { Message: 'unexpected request' } };
    const inv = this.invoices.get(`${req.headers['xero-tenant-id'] ?? ''}:${m[1]!}`);
    return inv ? { statusCode: 200, body: { Invoices: [inv] } } : { statusCode: 404, body: { Title: 'Not Found' } };
  };
}

describe.each(TARGETS)('AC-14C C: the end-to-end recovery lifecycle [%s]', (target) => {
  let db: Db & { url?: string };
  let xero: FakeXero;
  let seq = 0;

  beforeAll(async () => {
    const sdk = '../n8n/07-reconcile.sdk.ts';                                       // a variable: typecheck does not follow it into n8n's SDK
    await import(/* @vite-ignore */ sdk);
  });
  const q1 = async <T>(sql: string, p: unknown[] = []): Promise<T> => (await db.query<{ r: T }>(sql, p))[0]!.r;
  const one = async (sql: string, p: unknown[] = []): Promise<R> => (await db.query<R>(sql, p))[0]!;
  const many = (sql: string, p: unknown[] = []): Promise<R[]> => db.query<R>(sql, p);
  const colOf = (sql: string, p: unknown[] = []) => col(db, sql, p);
  const fails = () => colOf(`select check_key v from integrity_check() where status = 'FAIL'`);
  const named = async () => (await many(`select check_key, status from integrity_check() where check_key = any($1::text[]) order by check_key`,
    [NAMED_CHECKS])).map((c) => `${String(c.check_key)}:${String(c.status)}`);

  beforeEach(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`update app_settings set value = '${A}' where key = 'xero.demo_tenant_id';
                   update app_settings set value = encode(sha256(convert_to('test-operator-token', 'UTF8')), 'hex') where key = 'reconcile.trigger_token_sha256';
                   insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
    xero = new FakeXero();
    seq = 0;
  }, 120_000);
  afterEach(async () => { await db.close(); });

  // ---------------------------------------------------------------------------------------------------------------
  // The real 07 path: the recorded nodes, a fake Xero, and the run-row quota reset the other suites use.
  // ---------------------------------------------------------------------------------------------------------------
  const run07 = async (mode: 'repair' | 'observe' = 'repair') => {
    await db.exec(`update reconciliation_runs set started_at = started_at - interval '10 minutes', status = case when status = 'RUNNING' then 'FAILED' else status end`);
    const r = new N8nRun(recorded.nodes, recorded.edges, { db, http: xero.handle });
    const trigger: Item[] = mode === 'repair' ? [{ json: {} }] : [{ json: { headers: { 'x-roofops-token': 'test-operator-token' }, body: { mode: 'observe' } } }];
    await r.run('Read Request', trigger, ['Run Started?']);
    await r.run('External Objects To Check', r.out.get('Start Reconciliation Run')!, ['Find Drive Root']);
    await r.run('Xero Invoices To Read', [{ json: {} }], ['Uncertain Xero Writes To Look Up']);
    expect(r.executed, 'Record Xero Findings must run, whatever Xero answered').toContain('Record Xero Findings');
    return r.out.get('Record Xero Findings')![0]!.json.r as R;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // The project: an accepted quote (01) completed through the real 06 handler, with the money still left to bill.
  // ---------------------------------------------------------------------------------------------------------------
  const airtableChange = (project: string, fields: R) => {
    seq += 1;
    return q1<R>(`select wf_airtable_change($1::jsonb, 'n8n:test') r`, [JSON.stringify({
      event_id: `airtable:ac14cC:txn${String(seq)}:${recFor(project)}`, source: 'airtable', actor_id: APPROVER,
      occurred_at: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString(), table_id: T_PROJECTS, record_id: recFor(project),
      changes: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { current: v }])), current: { ...fields },
    })]);
  };
  /** Quote accepted -> project -> Scheduled -> In Progress -> COMPLETED with both COMPLETION items Done. */
  const acceptedProject = async (quote: string): Promise<{ project: string; total: number }> => {
    const created = await q1<R>(`select wf_quote_accepted($1::jsonb, 'n8n:test') r`, [JSON.stringify({
      event_id: `EVT-C14C-ACCEPT-${quote}`, correlation_id: `CORR-C14C-ACCEPT-${quote}`, event_type: 'quote.accepted', source: 'airtable',
      actor_id: 'airtable-automation', occurred_at: '2026-09-29T09:00:00+10:00',
      payload: { quote_id: quote, accepted_version: 1, accepted_on: '2026-09-29', airtable_record_id: 'recC14CACCEPT0001' } })]);
    expect(created, quote).toMatchObject({ status: 'CREATED' });
    const project = String(created.project_number);
    await db.query(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
      select 'AIRTABLE', 'project', id, 'Record', $2, now(), now() from projects where project_number = $1`, [project, recFor(project)]);
    for (const fields of [{ [F.start]: '2026-10-01', [F.end]: '2026-10-20' }, { [F.status]: 'Scheduled' }, { [F.status]: 'In Progress' },
      { [F.photos]: 'Done' }, { [F.cert]: 'Done' }, { [F.status]: 'Completed' }]) {
      expect(await airtableChange(project, fields), `${project} ${JSON.stringify(fields)}`).toMatchObject({ outcome: 'APPLIED' });
    }
    expect(await one(`select status, actual_completion_date is not null done from projects where project_number = $1`, [project]))
      .toMatchObject({ status: 'COMPLETED', done: true });
    expect(await dash(project)).toMatchObject({ invoice_status: 'READY_TO_INVOICE', needs_attention: false });
    const b = await billing(project);
    expect(Number(b.remaining), `${project} has the money the void will leave owed`).toBeGreaterThan(0);
    return { project, total: Number(b.remaining) };
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Readers.
  // ---------------------------------------------------------------------------------------------------------------
  const inv = (id: string) => one(`select id::text, invoice_number, status, sync_status, voided_reason, record_version, approval_id::text approval_id
                                     from invoices where id = $1`, [id]);
  const ledger = (id: string) => many(`select generation, status, outbox_idempotency_key key, xero_invoice_id, xero_invoice_number, tenant_id, opened_by,
      approval_id::text approval_id, superseded_at::text superseded_at, superseded_reason
    from invoice_xero_draft_generations where invoice_id = $1 order by generation`, [id]);
  const outbox = (id: string) => many(`select generation, status, idempotency_key, payload, next_attempt_at = 'infinity' dead
    from outbox where aggregate_id = $1 and topic = 'xero.create_draft_invoice' order by generation`, [id]);
  const links = (id: string) => many(`select external_id, verified_at is not null verified from external_links
    where provider = 'XERO' and entity_type = 'invoice' and external_type = 'Invoice' and entity_id = $1 order by external_id`, [id]);
  const link = async (id: string) => (await db.query<{ external_id: string }>(`select external_id from external_links
    where provider = 'XERO' and entity_type = 'invoice' and external_type = 'Invoice' and entity_id = $1`, [id]))[0]?.external_id ?? null;
  const observations = (id: string) => many(`select verdict, settlement, tenant_id, bound_tenant_id, xero_invoice_id, amount_paid, amount_due
    from xero_invoice_observations where invoice_id = $1 order by observed_at, id`, [id]);
  const balance = (id: string) => one(`select status, amount_paid::numeric(12,2)::text paid, outstanding::numeric(12,2)::text outstanding, is_overdue
    from v_invoice_balances where id = $1`, [id]);
  const dash = (project: string) => one(`select invoice_status, invoice_blocker, needs_attention, final_invoice_sync, xero_invoice_id,
      outstanding_inc_gst::numeric(12,2)::text outstanding, has_overdue_invoice from v_dashboard_projects where project_number = $1`, [project]);
  const billing = async (project: string) => (await one(`select project_billing(p.id) b from projects p where p.project_number = $1`, [project])).b as R;
  const leftAfterFinal = async (project: string) =>
    (await one(`select project_left_to_bill_after_final(p.id) x from projects p where p.project_number = $1`, [project])).x as R | null;
  const close = async (project: string) =>
    (await one(`select project_transition_guard(p, 'CLOSED') v from projects p where p.project_number = $1`, [project])).v as string | null;
  const openExceptions = (project: string) => many(`select exception_number, error_class, workflow_key, business_reference from workflow_exceptions w
    where w.resolution_status = 'OPEN' and (w.entity_id = (select p.id from projects p where p.project_number = $1) or w.business_reference = $1)
    order by exception_number`, [project]);
  /** The documented operator path: every open exception for the project is answered, audited, with a reason. */
  const resolveOpenExceptions = async (project: string): Promise<R[]> => {
    const open = await openExceptions(project);
    for (const e of open) {
      expect(await q1<R>(`select ops_resolve_exception($1, $2, $3) r`, [String(e.exception_number), FINANCE,
        `The replacement final invoice for ${project} is settled and paid; the void is resolved`])).toMatchObject({ resolved: true });
    }
    return open;
  };
  /** The invariant at every stage: exactly one non-superseded generation, at most one live draft write. */
  const liveDraft = async (id: string) => {
    expect(await colOf(`select generation::text v from invoice_xero_draft_generations where invoice_id = $1 and superseded_at is null`, [id])).toHaveLength(1);
    const live = await colOf(`select generation::text v from outbox where aggregate_id = $1 and topic = 'xero.create_draft_invoice'
      and (status in ('PENDING', 'DISPATCHING') or (status = 'FAILED' and next_attempt_at <> 'infinity'))`, [id]);
    expect(live.length).toBeLessThanOrEqual(1);
  };
  /** 05's completion proof for a generation: the draft read back in the pinned tenant, bound to the InvoiceID. */
  const completeDraft = async (id: string, generation: number, invoiceId: string) => {
    const g = (await outbox(id)).find((w) => Number(w.generation) === generation)!;
    const p = g.payload as R;
    expect(await q1<R>(`select wf_claim_side_effect($1, 'n8n:05', 120) r`, [String(g.idempotency_key)])).toMatchObject({ claimed: true });
    expect(await q1<R>(`select wf_complete_side_effect($1, $2::jsonb) r`, [String(g.idempotency_key), JSON.stringify({
      verified: true, tenant_id: A, organisation_class: 'DEMO', invoice_id: invoiceId, invoice_number: p.xero_invoice_number, reference: p.reference,
      status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false, contact_id: uuidFor(`contact:${String(p.customer_id)}`),
      contact_number: p.xero_contact_number, total: p.amount_inc_gst, total_tax: p.gst_amount, currency: 'AUD', line_amount_types: 'Inclusive', matching_invoices: 1 })])
    ).toMatchObject({ status: 'RECORDED' });
    return g;
  };
  /** The document Xero returns for a linked draft of the invoice, in the state the test needs. */
  const doc = (p: R, invoiceId: string, status: string, over: R = {}) => ({ InvoiceID: invoiceId, Type: 'ACCREC', InvoiceNumber: p.xero_invoice_number,
    Reference: p.reference, Status: status, CurrencyCode: 'AUD', LineAmountTypes: 'Inclusive', Date: '2026-10-06', DueDate: '2026-10-20',
    Total: p.amount_inc_gst, AmountDue: p.amount_inc_gst, AmountPaid: 0, AmountCredited: 0, Payments: [], ...over });

  // ---------------------------------------------------------------------------------------------------------------
  // The lifecycle itself: from the live draft, through the verified void, back to a closed, paid project.
  // ---------------------------------------------------------------------------------------------------------------
  const lifecycle = async (s: ReissueScenario, family: 'DELETED' | 'VOIDED', total: number, newXid: string): Promise<void> => {
    const id = s.invoice.id;
    const project = s.project;
    const number = s.invoice.number;
    const xeroNumber = s.invoice.xeroNumber;
    const oldXid = s.invoice.xid;
    const projectId = String((await one(`select project_id::text p from invoices where id = $1`, [id])).p);

    // 1-2. The canonical FINAL invoice: exactly one row, the RoofOps-origin FINAL, the entitlement as its total.
    expect(await many(`select id::text from invoices where project_id = $1 and invoice_type = 'FINAL'`, [projectId])).toHaveLength(1);
    expect(await one(`select invoice_type, record_origin, idempotency_key, total_inc_gst::numeric(12,2)::text total from invoices where id = $1`, [id]))
      .toMatchObject({ invoice_type: 'FINAL', record_origin: 'ROOFOPS', idempotency_key: `invoice:final:${projectId}`, total: total.toFixed(2) });
    // 3-5. Generation 1: the approval queued it with the legacy identity, 05 created the draft in the bound tenant and
    //      read it back - the exact tenant and InvoiceID are bound, one current link, sync SYNCED.
    const gen1 = (await outbox(id))[0]!;
    const p1 = gen1.payload as R;
    expect(gen1).toMatchObject({ generation: 1, status: 'DONE', idempotency_key: `xero:invoice:${id}` });
    expect(p1).toMatchObject({ xero_tenant_id: A, xero_invoice_number: xeroNumber, xero_idempotency_key: `roofops-${id}` });
    expect(await ledger(id)).toMatchObject([{ generation: 1, status: 'CREATED', key: `xero:invoice:${id}`, xero_invoice_id: oldXid,
      xero_invoice_number: xeroNumber, tenant_id: A, superseded_at: null }]);
    expect(await inv(id)).toMatchObject({ invoice_number: number, status: 'APPROVED', sync_status: 'SYNCED', voided_reason: null });
    expect(await links(id)).toEqual([{ external_id: oldXid, verified: true }]);
    await liveDraft(id);
    // 6. A verified DRAFT read is not collectible and changes no state: the dashboard still calls the money owed nothing.
    xero.invoices.set(`${A}:${oldXid}`, doc(p1, oldXid, 'DRAFT'));
    expect(await run07('repair')).toMatchObject({ ok: true, verified: 1, drift: 0, settlement: { ok: true, applied: 0, verdicts: { verified: 1 } } });
    expect(await inv(id)).toMatchObject({ status: 'APPROVED', sync_status: 'SYNCED' });
    expect(await dash(project)).toMatchObject({ invoice_status: 'XERO_DRAFT_CREATED', outstanding: '0.00', needs_attention: false });
    expect(String(await close(project))).toMatch(/not every invoice is paid yet/);
    // 7-9. The verified void/deletion: RoofOps follows Xero, the reason is recorded, nothing is collectible.
    xero.invoices.set(`${A}:${oldXid}`, doc(p1, oldXid, family, { AmountDue: family === 'DELETED' ? 0 : total }));
    expect(await run07('repair')).toMatchObject({ ok: true, settlement: { ok: true, applied: 1, verdicts: { verified: 1 } } });
    expect(await inv(id)).toMatchObject({ status: 'VOIDED', sync_status: 'SYNCED',
      voided_reason: expect.stringMatching(new RegExp(`^${family === 'DELETED' ? 'Deleted' : 'Voided'} in Xero \\(verified by reconciliation `)) as unknown });
    expect(await balance(id)).toMatchObject({ status: 'VOIDED', outstanding: '0.00', is_overdue: false });
    expect(await link(id)).toBe(oldXid);                                            // the void document stays the one linked one
    expect((await observations(id)).at(-1)).toMatchObject({ verdict: 'VERIFIED', settlement: family, tenant_id: A, xero_invoice_id: oldXid });
    expect(await fails()).toEqual([]);
    await liveDraft(id);
    // 10. The close gate holds while the money is owed: the left-to-bill class, and the dashboard says a person is needed.
    expect(String(await close(project))).toMatch(/left to bill/);
    const b1 = await billing(project);
    expect(Number(b1.remaining)).toBe(total);
    expect((b1.billed_invoices as { invoice: string }[]).map((x) => x.invoice)).not.toContain(number);
    expect(await dash(project)).toMatchObject({ invoice_status: 'NOT_READY', needs_attention: true, outstanding: '0.00', has_overdue_invoice: false });
    expect(String((await dash(project)).invoice_blocker)).toContain(number);
    expect(String((await dash(project)).invoice_blocker)).toMatch(/needs a person/);
    expect(await leftAfterFinal(project)).toBeNull();     // no live FINAL invoice to measure "left after final" against (by design)
    const open = await openExceptions(project);
    expect(open.map((e) => String(e.error_class))).toContain('INVALID_STATE');       // AC-05: a replacement needs a person
    expect(open.map((e) => String(e.error_class))).toContain('EXTERNAL_MISSING');    // the 07 read of the voided document
    // 11-12. The operator requests the reissue: one fresh approval bound to the exact evidence. Nothing is queued.
    const req = await s.request(FINANCE, REASON);
    expect(req).toMatchObject({ ok: true, code: 'REISSUE_REQUESTED', invoice_number: number, target_generation: 2 });
    const ap = await one(`select action_type, entity_type, entity_id::text, status, payload_hash, expected_record_version, action_payload
      from approvals where approval_number = $1`, [String(req.approval_number)]);
    expect(ap).toMatchObject({ action_type: 'REISSUE_INVOICE', entity_type: 'invoice', entity_id: id, status: 'PENDING',
      expected_record_version: (await inv(id)).record_version });
    expect(ap.payload_hash).toBe(await q1<string>(`select invoice_reissue_preview_hash($1::jsonb) r`, [JSON.stringify(ap.action_payload)]));
    expect(ap.action_payload as R).toMatchObject({ invoice_status: 'VOIDED', invoice_sync_status: 'SYNCED', current_generation: 1, target_generation: 2,
      tenant: { tenant_id: A }, linked_xero_invoice_id: oldXid, requested_reason: REASON,
      void_evidence: expect.objectContaining({ settlement: family, tenant_id: A }) as unknown });
    expect(await outbox(id)).toHaveLength(1);
    expect(await ledger(id)).toHaveLength(1);
    await liveDraft(id);
    // 13-16. The decision: generation 1 superseded (with the reason), generation 2 opened and queued - the same invoice
    //        number on the one FINAL row, the old InvoiceID retained, a new generation-aware outbox identity.
    const dec = await s.decide(String(req.approval_number), ADMIN, 'checked the customer account');
    expect(dec).toMatchObject({ ok: true, code: 'REISSUE_QUEUED', generation: 2, superseded_generation: 1,
      outbox_idempotency_key: `xero:invoice:${id}:g2`, xero_idempotency_key: `roofops-${id}-g2` });
    const led = await ledger(id);
    expect(led).toMatchObject([
      { generation: 1, status: 'SUPERSEDED', xero_invoice_id: oldXid, xero_invoice_number: xeroNumber, tenant_id: A,
        superseded_reason: expect.stringMatching(new RegExp(`Reissue ${String(req.approval_number)} by ${ADMIN}`)) as unknown },
      { generation: 2, status: 'PENDING', xero_invoice_id: null, key: `xero:invoice:${id}:g2`, opened_by: `operator:${ADMIN}` }]);
    expect(String(led[0]!.superseded_reason)).toContain(REASON);
    const gen2 = (await outbox(id))[1]!;
    expect(gen2).toMatchObject({ generation: 2, status: 'PENDING', idempotency_key: `xero:invoice:${id}:g2` });
    expect(gen2.payload as R).toMatchObject({ xero_tenant_id: A, xero_invoice_number: xeroNumber, xero_idempotency_key: `roofops-${id}-g2`,
      generation: 2, reissued_from_generation: 1, reissued_by: ADMIN, reissue_reason: REASON });
    expect(await inv(id)).toMatchObject({ invoice_number: number, status: 'APPROVED', sync_status: 'PENDING' });
    expect(await many(`select id::text from invoices where project_id = $1 and invoice_type = 'FINAL'`, [projectId])).toHaveLength(1);
    expect(await link(id)).toBe(oldXid);                                            // history until the replacement is proved
    expect(await fails()).toEqual([]);
    await liveDraft(id);
    // 17-18. The new draft is created and read back: the one current link moves to the exact new InvoiceID.
    await completeDraft(id, 2, newXid);
    expect(await link(id)).toBe(newXid);
    expect(await links(id)).toEqual([{ external_id: newXid, verified: true }]);
    expect(await ledger(id)).toMatchObject([{ generation: 1, status: 'SUPERSEDED', xero_invoice_id: oldXid },
      { generation: 2, status: 'CREATED', xero_invoice_id: newXid, xero_invoice_number: xeroNumber, tenant_id: A }]);
    expect(await inv(id)).toMatchObject({ status: 'APPROVED', sync_status: 'SYNCED' });
    expect(await fails()).toEqual([]);
    await liveDraft(id);
    // 19. The verified settlement: AUTHORISED + UNPAID => ISSUED, with the verified amount due from the new generation.
    xero.invoices.set(`${A}:${newXid}`, doc(gen2.payload as R, newXid, 'AUTHORISED'));
    expect(await run07('repair')).toMatchObject({ ok: true, verified: 1, drift: 0, settlement: { ok: true, applied: 1, verdicts: { verified: 1 } } });
    expect(await inv(id)).toMatchObject({ status: 'ISSUED', sync_status: 'SYNCED' });
    expect(await balance(id)).toMatchObject({ status: 'ISSUED', paid: '0.00', outstanding: total.toFixed(2), is_overdue: false });
    expect(await dash(project)).toMatchObject({ outstanding: total.toFixed(2) });
    expect((await observations(id)).at(-1)).toMatchObject({ verdict: 'VERIFIED', settlement: 'UNPAID', xero_invoice_id: newXid, tenant_id: A });
    // 20. PAID only from a verified read: it was ISSUED (not PAID) until Xero said PAID, and only then may it close.
    expect((await inv(id)).status).not.toBe('PAID');
    xero.invoices.set(`${A}:${newXid}`, doc(gen2.payload as R, newXid, 'PAID', { AmountDue: 0, AmountPaid: total,
      FullyPaidOnDate: '2026-10-10', Payments: [{ PaymentID: 'bbbbbbbb-0000-0000-0000-000000000009', Amount: total, Date: '2026-10-10' }] }));
    expect(await run07('repair')).toMatchObject({ ok: true, verified: 1, settlement: { ok: true, applied: 1, verdicts: { verified: 1 } } });
    expect(await inv(id)).toMatchObject({ status: 'PAID' });
    expect(await balance(id)).toMatchObject({ status: 'PAID', paid: total.toFixed(2), outstanding: '0.00' });
    expect(await dash(project)).toMatchObject({ outstanding: '0.00', has_overdue_invoice: false });
    expect(await close(project)).toBeNull();
    // 21. The project closes, and the person's exceptions are answered the documented way (audited, with a reason).
    expect(await one(`update projects set status = 'CLOSED' where project_number = $1 returning status`, [project])).toMatchObject({ status: 'CLOSED' });
    const resolved = await resolveOpenExceptions(project);
    expect(resolved.map((e) => String(e.error_class))).toContain('INVALID_STATE');
    expect(await colOf(`select actor_id || ' ' || (before_state ->> 'resolution_status') || '->' || (after_state ->> 'resolution_status') v
      from audit_events where action = 'exception.resolved' and business_reference = $1`, [String(resolved[0]!.exception_number)]))
      .toEqual([`${FINANCE} OPEN->RESOLVED`]);
    expect(await dash(project)).toMatchObject({ needs_attention: false });
    // 22. Reconciliation stays clean: a final repair run applies nothing and contradicts nothing; integrity is green.
    const clean = await run07('repair');
    expect(clean).toMatchObject({ ok: true, verified: 1, drift: 0, settlement: { ok: true, applied: 0, verdicts: { verified: 1 } } });
    expect(await inv(id)).toMatchObject({ status: 'PAID' });
    expect(await fails()).toEqual([]);
    // 23. History: the superseded generation, its InvoiceID and every read of it are still queryable and inert.
    const obs = await observations(id);
    expect(obs.filter((o) => o.xero_invoice_id === oldXid).map((o) => String(o.settlement))).toEqual(['NOT_ISSUED', family]);
    expect(obs.slice(2).map((o) => String(o.settlement))).toEqual(['UNPAID', 'PAID', 'PAID']);
    expect(obs.slice(2).every((o) => o.xero_invoice_id === newXid && o.tenant_id === A)).toBe(true);
    expect(await colOf(`select xero_invoice_id v from invoice_xero_draft_generations where invoice_id = $1 and generation = 1`, [id])).toEqual([oldXid]);
    // 24. One live draft generation throughout, the current identity is the replacement's, and the named protections PASS.
    await liveDraft(id);
    expect(await link(id)).toBe(newXid);
    expect(await named()).toEqual(NAMED_PASS);
  };

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-CROSS-001 / VAL-CROSS-002: the full lifecycle for both void families.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-CROSS-001 the full recovery lifecycle after a verified Xero DELETED', async () => {
    const { project, total } = await acceptedProject(Q_DELETED);
    const s = await approvedReissueScenario(db, { project, xid: 'aaaaaaaa-bbbb-cccc-dddd-0000000000c1' });
    expect(s.invoice.number).toMatch(/^INV-2026-\d{4}$/);
    await lifecycle(s, 'DELETED', total, 'aaaaaaaa-bbbb-cccc-dddd-0000000000c2');
  }, 120_000);

  it('VAL-CROSS-002 the same lifecycle after a verified Xero VOIDED', async () => {
    const { project, total } = await acceptedProject(Q_VOIDED);
    const s = await approvedReissueScenario(db, { project, xid: 'aaaaaaaa-bbbb-cccc-dddd-0000000000d1' });
    await lifecycle(s, 'VOIDED', total, 'aaaaaaaa-bbbb-cccc-dddd-0000000000d2');
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-CROSS-003: the stale-read window is safe.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-CROSS-003 reads of the superseded InvoiceID cannot re-void the invoice or move the generation or link', async () => {
    const s = await voidedReissueScenario(db, { project: P4, xid: XID4 });
    const id = s.invoice.id;
    expect(await inv(id)).toMatchObject({ status: 'VOIDED', sync_status: 'SYNCED' });
    const req = await s.request(FINANCE, REASON);
    expect(await s.decide(String(req.approval_number), ADMIN, null)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED' });
    const before = { inv: await inv(id), led: await ledger(id), out: await outbox(id), obs: (await observations(id)).length };
    expect(before.inv).toMatchObject({ status: 'APPROVED', sync_status: 'PENDING' });
    expect(await link(id)).toBe(XID4);                                   // the window: the old document is still the linked one
    const gen2 = (await outbox(id))[1]!;
    const p = gen2.payload as R;

    // The linked (superseded) document still reports DELETED, in the bound tenant: a repair run records it and applies nothing.
    xero.invoices.set(`${A}:${XID4}`, doc(p, XID4, 'DELETED', { AmountDue: 0 }));
    expect(await run07('repair')).toMatchObject({ ok: true, settlement: { ok: true, applied: 0, verdicts: { verified: 1 } } });
    expect(await inv(id)).toMatchObject({ status: 'APPROVED', sync_status: 'PENDING' });
    // ... a lookup failure: recorded, never inferred.
    xero.fail = (r) => (r.url.endsWith(XID4) ? { statusCode: 500 } : null);
    expect(await run07('repair')).toMatchObject({ ok: true, settlement: { ok: true, applied: 0, verdicts: { lookup_failed: 1 } } });
    xero.fail = () => null;
    // ... a contradictory read (the old document looks live and unpaid): still nothing applies.
    xero.invoices.set(`${A}:${XID4}`, doc(p, XID4, 'AUTHORISED'));
    expect(await run07('repair')).toMatchObject({ ok: true, settlement: { ok: true, applied: 0, verdicts: { verified: 1 } } });
    // The invoice is exactly where the decision left it: never re-voided, never issued, one generation, one link.
    expect(await inv(id)).toEqual(before.inv);
    expect(await ledger(id)).toEqual(before.led);
    expect(await outbox(id)).toEqual(before.out);
    expect(await link(id)).toBe(XID4);
    expect((await observations(id)).length).toBe(before.obs + 3);       // the three reads are history only
    expect((await observations(id)).slice(-3).map((o) => `${String(o.verdict)}/${(o.settlement as string | null) ?? 'none'}`))
      .toEqual(['VERIFIED/DELETED', 'LOOKUP_FAILED/none', 'VERIFIED/UNPAID']);
    expect(await fails()).toEqual([]);
    await liveDraft(id);

    // The new draft completes: the link moves to the new InvoiceID, and the old observations stay inert.
    const newXid = 'aaaaaaaa-bbbb-cccc-dddd-0000000000c3';
    await completeDraft(id, 2, newXid);
    expect(await link(id)).toBe(newXid);
    const afterMove = { inv: await inv(id), led: await ledger(id), obs: (await observations(id)).length };
    // A stale delivery of the old InvoiceID after the move: not even recorded, and nothing changes.
    const run = `STALE-${String(++seq)}`;
    await db.query(`insert into reconciliation_runs (run_key, trigger, mode, status) values ($1, 'test', 'repair', 'RUNNING')`, [run]);
    expect(await q1<R>(`select xero_record_settlement($1, $2::jsonb) r`, [run, JSON.stringify([{ invoice_id: XID4, tenant_id: A, http: 200,
      xero_invoice_number: p.xero_invoice_number, xero: doc(p, XID4, 'PAID', { AmountDue: 0, AmountPaid: p.amount_inc_gst }) }])]))
      .toMatchObject({ ok: true, applied: 0 });
    expect(await inv(id)).toEqual(afterMove.inv);
    expect(await ledger(id)).toEqual(afterMove.led);
    expect((await observations(id)).length).toBe(afterMove.obs);
    // ... and the new generation settles normally, from its own reads only: the old PAID-looking document leaves no residue.
    xero.invoices.set(`${A}:${newXid}`, doc(p, newXid, 'AUTHORISED'));
    expect(await run07('repair')).toMatchObject({ ok: true, verified: 1, drift: 0, settlement: { ok: true, applied: 1, verdicts: { verified: 1 } } });
    expect(await inv(id)).toMatchObject({ status: 'ISSUED' });
    expect(await balance(id)).toMatchObject({ status: 'ISSUED', paid: '0.00', outstanding: Number(p.amount_inc_gst).toFixed(2) });
    expect((await observations(id)).at(-1)).toMatchObject({ verdict: 'VERIFIED', settlement: 'UNPAID', xero_invoice_id: newXid });
    expect(await fails()).toEqual([]);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-CROSS-004: the named protections are PASS at the void, through the reissue, and after the close.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-CROSS-004 the named integrity rules stay PASS through a full recovery', async () => {
    const s = await deletedReissueScenario(db, { project: P4, xid: XID4 });
    const id = s.invoice.id;
    // A verified void with a superseded generation present: the AC-14B exemption applies, the void is not a failure.
    expect(await named()).toEqual(NAMED_PASS);
    expect(await fails()).toEqual([]);
    // Through the decision (a queued replacement, the superseded document still linked): still green.
    const req = await s.request(FINANCE, REASON);
    expect(await s.decide(String(req.approval_number), ADMIN, null)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED' });
    expect(await named()).toEqual(NAMED_PASS);
    // The replacement completes and is settled: the current generation is the one that must carry the proof.
    const newXid = 'aaaaaaaa-bbbb-cccc-dddd-0000000000c6';
    await completeDraft(id, 2, newXid);
    const p = ((await outbox(id))[1]!.payload) as R;
    expect(await named()).toEqual(NAMED_PASS);
    xero.invoices.set(`${A}:${newXid}`, doc(p, newXid, 'AUTHORISED'));
    expect(await run07('repair')).toMatchObject({ ok: true, settlement: { ok: true, applied: 1, verdicts: { verified: 1 } } });
    expect(await named()).toEqual(NAMED_PASS);
    xero.invoices.set(`${A}:${newXid}`, doc(p, newXid, 'PAID', { AmountDue: 0, AmountPaid: s.invoice.total }));
    expect(await run07('repair')).toMatchObject({ ok: true, settlement: { ok: true, applied: 1, verdicts: { verified: 1 } } });
    expect(await close(P4)).toBeNull();
    expect(await one(`update projects set status = 'CLOSED' where project_number = $1 returning status`, [P4])).toMatchObject({ status: 'CLOSED' });
    expect(await named()).toEqual(NAMED_PASS);
    expect(await fails()).toEqual([]);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-BAL-006: collectibility returns only through the correct states.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-BAL-006 the decide window is not collectible, and the balance returns from the new generation only', async () => {
    const s = await deletedReissueScenario(db, { project: P4, xid: XID4 });
    const id = s.invoice.id;
    const total = s.invoice.total;
    expect(await balance(id)).toMatchObject({ status: 'VOIDED', outstanding: '0.00', is_overdue: false });

    const req = await s.request(FINANCE, REASON);
    expect(await s.decide(String(req.approval_number), ADMIN, null)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED' });
    // In the decide window the invoice is APPROVED/PENDING and deliberately not collectible: not ISSUED/PARTIALLY_PAID,
    // and the dashboard's money-owed excludes it. (Its own row's outstanding is deliberately not asserted here: an
    // APPROVED row falls back to total - payments; only the collectible states are money owed.)
    expect(await inv(id)).toMatchObject({ status: 'APPROVED', sync_status: 'PENDING' });
    expect(await colOf(`select status v from v_invoice_balances where id = $1`, [id])).toEqual(['APPROVED']);
    expect(await colOf(`select status v from v_invoice_balances where id = $1 and status in ('ISSUED', 'PARTIALLY_PAID')`, [id])).toEqual([]);
    expect(await dash(P4)).toMatchObject({ outstanding: '0.00', has_overdue_invoice: false, needs_attention: true });

    // A contradictory partial payment on the superseded document is recorded (the read is history) and applied to
    // nothing: the voided generation leaves no residue in the balance.
    const gen2 = (await outbox(id))[1]!;
    const p = gen2.payload as R;
    xero.invoices.set(`${A}:${XID4}`, doc(p, XID4, 'AUTHORISED', { AmountDue: total - 5000, AmountPaid: 5000,
      Payments: [{ PaymentID: 'bbbbbbbb-0000-0000-0000-00000000000b', Amount: 5000, Date: '2026-10-10' }] }));
    expect(await run07('repair')).toMatchObject({ ok: true, settlement: { ok: true, applied: 0, verdicts: { verified: 1 } } });
    expect((await observations(id)).at(-1)).toMatchObject({ verdict: 'VERIFIED', settlement: 'PARTIALLY_PAID', xero_invoice_id: XID4 });

    // The new draft completes; its verified read (AUTHORISED/UNPAID => ISSUED) is the only source of the balance.
    const newXid = 'aaaaaaaa-bbbb-cccc-dddd-0000000000c4';
    await completeDraft(id, 2, newXid);
    xero.invoices.set(`${A}:${newXid}`, doc(p, newXid, 'AUTHORISED'));
    expect(await run07('repair')).toMatchObject({ ok: true, verified: 1, drift: 0, settlement: { ok: true, applied: 1, verdicts: { verified: 1 } } });
    expect(await inv(id)).toMatchObject({ status: 'ISSUED' });
    expect(await balance(id)).toMatchObject({ status: 'ISSUED', paid: '0.00', outstanding: total.toFixed(2), is_overdue: false });
    expect(await dash(P4)).toMatchObject({ outstanding: total.toFixed(2) });
    // The read that drives it is the one bound to the NEW InvoiceID; the voided generation's read is history.
    expect(await one(`select o.xero_invoice_id from xero_invoice_observations o join external_links l
        on l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = o.invoice_id and l.external_id = o.xero_invoice_id
      where o.invoice_id = $1 and o.verdict = 'VERIFIED' order by o.observed_at desc, o.id desc limit 1`, [id]))
      .toMatchObject({ xero_invoice_id: newXid });
    // A partial payment on the new generation: the balance follows it exactly.
    xero.invoices.set(`${A}:${newXid}`, doc(p, newXid, 'AUTHORISED', { AmountDue: total - 5000, AmountPaid: 5000,
      Payments: [{ PaymentID: 'bbbbbbbb-0000-0000-0000-00000000000a', Amount: 5000, Date: '2026-10-10' }] }));
    expect(await run07('repair')).toMatchObject({ ok: true, settlement: { ok: true, applied: 1 } });
    expect(await inv(id)).toMatchObject({ status: 'PARTIALLY_PAID' });
    expect(await balance(id)).toMatchObject({ status: 'PARTIALLY_PAID', paid: '5000.00', outstanding: (total - 5000).toFixed(2) });
    expect(await dash(P4)).toMatchObject({ outstanding: (total - 5000).toFixed(2) });
    // Back to PAID from a verified read: nothing outstanding, and the money-owed figures follow.
    xero.invoices.set(`${A}:${newXid}`, doc(p, newXid, 'PAID', { AmountDue: 0, AmountPaid: total }));
    expect(await run07('repair')).toMatchObject({ ok: true, settlement: { ok: true, applied: 1 } });
    expect(await balance(id)).toMatchObject({ status: 'PAID', outstanding: '0.00' });
    expect(await dash(P4)).toMatchObject({ outstanding: '0.00' });
    expect(await fails()).toEqual([]);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-CROSS-005: the close gate refuses then allows at exactly the right moments.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-CROSS-005 the close gate holds while money is owed and opens after the verified PAID', async () => {
    const s = await deletedReissueScenario(db, { project: P4, xid: XID4 });
    const id = s.invoice.id;
    const total = s.invoice.total;
    // While owed: refused with the left-to-bill class; the dashboard needs attention and names the voided final.
    expect(String(await close(P4))).toMatch(/left to bill/);
    expect(await dash(P4)).toMatchObject({ needs_attention: true, outstanding: '0.00', invoice_status: 'NOT_READY' });
    expect(String((await dash(P4)).invoice_blocker)).toMatch(new RegExp(`${s.invoice.number}.*needs a person`));
    expect(await leftAfterFinal(P4)).toBeNull();          // by design: no live FINAL invoice in this window (B1b)
    expect(Number((await billing(P4)).remaining)).toBe(total);
    // Recover: request, decide, new draft/readback, verified reads.
    const req = await s.request(FINANCE, REASON);
    expect(await s.decide(String(req.approval_number), FINANCE, 'checked the customer account')).toMatchObject({ ok: true, code: 'REISSUE_QUEUED' });
    expect(String(await close(P4))).toMatch(/not every invoice is paid yet/);
    const newXid = 'aaaaaaaa-bbbb-cccc-dddd-0000000000c5';
    await completeDraft(id, 2, newXid);
    const p = ((await outbox(id))[1]!.payload) as R;
    xero.invoices.set(`${A}:${newXid}`, doc(p, newXid, 'AUTHORISED'));
    expect(await run07('repair')).toMatchObject({ ok: true, settlement: { ok: true, applied: 1 } });
    expect(await close(P4)).toMatch(/not every invoice is paid yet/);
    expect(await dash(P4)).toMatchObject({ needs_attention: true, outstanding: total.toFixed(2) });
    xero.invoices.set(`${A}:${newXid}`, doc(p, newXid, 'PAID', { AmountDue: 0, AmountPaid: total }));
    expect(await run07('repair')).toMatchObject({ ok: true, settlement: { ok: true, applied: 1 } });
    // Settled: the gate opens. The dashboard still needs attention only because the AC-05 void exception is open.
    expect(await close(P4)).toBeNull();
    expect(await dash(P4)).toMatchObject({ needs_attention: true, outstanding: '0.00' });
    expect((await resolveOpenExceptions(P4)).map((e) => String(e.error_class))).toContain('INVALID_STATE');
    expect(await dash(P4)).toMatchObject({ needs_attention: false });
    expect(await one(`update projects set status = 'CLOSED' where project_number = $1 returning status`, [P4])).toMatchObject({ status: 'CLOSED' });
    expect(await dash(P4)).toMatchObject({ needs_attention: false, outstanding: '0.00' });
    expect(await named()).toEqual(NAMED_PASS);
    expect(await fails()).toEqual([]);
  }, 120_000);
});
