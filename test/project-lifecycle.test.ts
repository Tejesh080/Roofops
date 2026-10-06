/**
 * AC-13A (docs/adversarial-test-catalogue.md AC-13, completion half): a project born from quote acceptance could never be
 * final-invoiced. wf_quote_accepted creates the required COMPLETION items (Completion Photos, Compliance Certificate) as
 * OPEN and nothing could mark them Done, Waived or Not applicable, so once COMPLETED the project hit MISSING_DOCUMENT
 * forever (and the close guard blamed "the final invoice has not been raised yet").
 *
 * Invariant: project lifecycle state and financial lifecycle state never contradict each other.
 *  - COMPLETED     only from In Progress (state machine); completion items may be Done only once work has started.
 *  - Prepare final only COMPLETED, every required COMPLETION item Done / Waived / Not applicable, no final invoice yet
 *                  (AC-05), nothing unapproved, not over-billed (AC-08), remaining_billable > 0 (AC-09 project_billing).
 *  - Fully billed  remaining_billable = 0 (project_billing), whatever the paperwork says.
 *  - CLOSED        COMPLETED, remaining_billable = 0, every invoice PAID or VOIDED, every required COMPLETION item
 *                  satisfied, no final-invoice preview awaiting approval.
 *  - Completion items change only through Airtable (Completion Photos / Compliance Certificate + their Note fields),
 *    validated by Postgres: checklist state machine, a reason for Waived / Not applicable, a mapped RoofOps employee
 *    (attribution), and locked once a final invoice exists or is being created, or the job is Closed / Cancelled.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { InvoiceRows } from './helpers/airtable04.js';
import { TARGETS, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const T_PROJECTS = 'tblvUPIoebC3zoacv';
const F = {
  status: 'fldi2Qwz1dAh2tcTE', reason: 'fld5MhzMBtA4CBUHo', start: 'fld8rf6RZLgfs6Ron', end: 'fldvZtiassZEgLMAN', sync: 'fldVrJOuyhbNtxnVh',
  photos: 'fldbbksVL3dT6cqyS', photosNote: 'fldA77ad94yUmvnu3', cert: 'fldf7iJiyHFxOQgUy', certNote: 'fldLi9FkGDFAbf0QB',
  swms: 'fldM6kgPz6QZagPAC', materials: 'fldozWSCU877wEZHq',
};
const APPROVER = 'usr7uCnNO15fCefbH';            // mapped to EMP-900 (employee_external_identities)
const UNMAPPED = 'usrSTAFFMEMBER01';             // an Airtable user RoofOps cannot attribute
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;

describe.each(TARGETS)('AC-13A: project and financial lifecycles never contradict; completion items have a supported path [%s]', (target) => {
  let db: Db;
  let P = '';                                    // the project born from quote acceptance
  const rows = new InvoiceRows();
  let seq = 0;
  const q = (sql: string, p: unknown[] = []) => db.query<R>(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0]!;
  const call = async (fn: string, ...a: unknown[]) =>
    (await one(`select ${fn}(${a.map((_, i) => `$${String(i + 1)}`).join(', ')}) r`, a.map((x) => (x !== null && typeof x === 'object' ? JSON.stringify(x) : x)))).r as R;
  const rolledBack = async <T>(fn: () => Promise<T>) => { await db.exec('begin'); try { return await fn(); } finally { await db.exec('rollback'); } };
  const force = async (sql: string, p: unknown[] = []) => {
    await db.exec(`set session_replication_role = replica`);
    try { await q(sql, p); } finally { await db.exec(`set session_replication_role = origin`).catch(() => undefined); }   // never mask the real error
  };
  /** An Airtable Projects edit exactly as n8n 06 hands it over (fields = the changed cells; current = the rest of the row). */
  const change = (project: string, fields: R, o: { actor?: string; at?: string; id?: string; current?: R; source?: string } = {}) => {
    seq += 1;
    return call('wf_airtable_change', {
      event_id: o.id ?? `airtable:achLIFE:txn${String(seq)}:${recFor(project)}`, source: o.source ?? 'airtable', actor_id: o.actor ?? APPROVER,
      occurred_at: o.at ?? new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString(), table_id: T_PROJECTS, record_id: recFor(project),
      changes: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { current: v }])), current: { ...(o.current ?? {}), ...fields },
    }, o.source === 'reconciler' ? 'reconciler' : 'test');
  };
  const items = async (project: string) => Object.fromEntries((await q(`
      select ci.item_code, ci.status, ci.completed_on::text completed_on, e.employee_code completed_by, ci.waived_reason
        from project_checklist_items ci join projects p on p.id = ci.project_id left join employees e on e.id = ci.completed_by
       where p.project_number = $1 and ci.stage = 'COMPLETION'`, [project])).map((r) => [String(r.item_code), r]));
  const status = async (project: string) => String((await one(`select status from projects where project_number = $1`, [project])).status);
  const preview = async (project: string) => (await one(`select invoice_final_preview(id) v from projects where project_number = $1`, [project])).v as R;
  const billing = async (project: string) => (await one(`select project_billing(id) v from projects where project_number = $1`, [project])).v as R;
  const dash = async (project: string) => one(`select invoice_status, invoice_blocker, needs_attention, invoice_amount_inc_gst::text amount from v_dashboard_projects where project_number = $1`, [project]);
  const close = async (project: string) => (await one(`select project_transition_guard(p, 'CLOSED') v from projects p where project_number = $1`, [project])).v as string | null;
  const expected = async (project: string) => (await one(`select x.expected from v_airtable_expected x join projects p on p.id = x.entity_id where p.project_number = $1`, [project])).expected as R;
  const today = async () => String((await one(`select app_today()::text d`)).d);
  const integrity = async (key: string) => one(`select status, refs from integrity_check() where check_key = $1`, [key]);
  const prepare = (project: string) => rows.send(db, { event_id: `EVT-LIFE-${String(++seq)}`, event_type: 'invoice.prepare_requested', source: 'airtable', actor_id: APPROVER,
    occurred_at: new Date().toISOString(), payload: { project_number: project, airtable_record_id: recFor(project) } }, 'n8n:test');
  const approve = (project: string) => rows.send(db, { event_id: `EVT-LIFE-${String(++seq)}`, event_type: 'invoice.approved', source: 'airtable', actor_id: APPROVER,
    occurred_at: new Date(Date.now() + 1000).toISOString(), payload: { project_number: project, airtable_record_id: recFor(project) } }, 'n8n:test');
  /** AC-14: settle the project's final invoice the only way RoofOps trusts: its write completed and linked, then a
   *  verified Xero read (PAID) recorded by a repair reconciliation (wf_reconcile_external, as 07 calls it). */
  const settleInXero = async (project: string) => {
    const [f] = await q(`select i.id, i.invoice_number, i.total_inc_gst::text total, o.payload ->> 'xero_invoice_number' xno, o.payload ->> 'xero_tenant_id' tenant
        from invoices i join projects p on p.id = i.project_id join outbox o on o.aggregate_id = i.id and o.topic = 'xero.create_draft_invoice'
       where p.project_number = $1 and i.invoice_type = 'FINAL'`, [project]);
    const xid = createHash('md5').update(String(f!.id)).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    await force(`update invoices set sync_status = 'SYNCED' where id = $1`, [f!.id]);
    await force(`update approvals set status = 'EXECUTED', executed_at = now(), execution_result = '{"verified": true}' where business_reference = $1 and status = 'EXECUTING'`, [project]);
    await q(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at) values ('XERO', 'invoice', $1, 'Invoice', $2, now(), now())`, [f!.id, xid]);
    expect(await close(project)).toMatch(/not verified in Xero/);                      // a local PAID flag is never enough
    const run = `RECON-LIFE-${String(++seq)}`;
    await q(`insert into reconciliation_runs (run_key, trigger, mode) values ($1, 'test', 'repair')`, [run]);
    const total = Number(f!.total);
    await q(`select wf_reconcile_external($1, 'XERO', $2::jsonb)`, [run, JSON.stringify([{ invoice_number: f!.invoice_number, project_number: project, invoice_id: xid,
      xero_invoice_number: f!.xno, tenant_id: f!.tenant, http: 200, status: 'PAID', total, expected_total: total, reference: project, expected_reference: project,
      xero: { InvoiceID: xid, Type: 'ACCREC', InvoiceNumber: f!.xno, Reference: project, Status: 'PAID', Total: total, AmountDue: 0, AmountPaid: total, AmountCredited: 0 } }])]);
    await q(`update reconciliation_runs set status = 'COMPLETED', finished_at = now() where run_key = $1`, [run]);
  };
  const rejectedReason =(r: R) => ((r.rejected as { reason?: string }[] | undefined) ?? [])[0]?.reason ?? '';

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`update app_settings set value = '11111111-2222-3333-4444-555555555555' where key = 'xero.demo_tenant_id';
                   insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
  }, 120_000);
  afterAll(async () => { await db.close(); });

  it('1. accepted quote -> project: PLANNING, both completion items To do and projected to Airtable as supported staff fields; acceptance is idempotent', async () => {
    const ev = { event_id: 'EVT-LIFE-ACCEPT', correlation_id: 'CORR-LIFE-ACCEPT', event_type: 'quote.accepted', source: 'airtable', actor_id: 'airtable-automation',
      occurred_at: '2026-09-29T09:00:00+10:00', payload: { quote_id: 'Q-2026-0041', accepted_version: 1, accepted_on: '2026-09-29', airtable_record_id: 'recTESTTESTTEST01' } };
    const created = await call('wf_quote_accepted', ev);
    P = String(created.project_number);
    await q(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
             select 'AIRTABLE', 'project', id, 'Record', $2, now(), now() from projects where project_number = $1`, [P, recFor(P)]);
    expect(await status(P)).toBe('PLANNING');
    expect(await items(P)).toMatchObject({ COMPLETION_PHOTOS: { status: 'OPEN' }, COMPLIANCE_CERTIFICATE: { status: 'OPEN' } });
    expect(await expected(P)).toMatchObject({ [F.photos]: 'To do', [F.cert]: 'To do' });
    expect(await q(`select airtable_name, owner, reconcile from field_contract where airtable_field_id = any($1) order by airtable_name`,
                   [[F.photos, F.photosNote, F.cert, F.certNote]])).toEqual([
      { airtable_name: 'Completion Photos', owner: 'AIRTABLE_EDIT', reconcile: 'APPLY_VIA_HANDLER' },
      { airtable_name: 'Completion Photos Note', owner: 'INPUT', reconcile: 'IGNORE' },
      { airtable_name: 'Compliance Certificate', owner: 'AIRTABLE_EDIT', reconcile: 'APPLY_VIA_HANDLER' },
      { airtable_name: 'Compliance Certificate Note', owner: 'INPUT', reconcile: 'IGNORE' }]);
    expect(String((await one(`select editable_in from field_contract where entity = 'checklist' and field_key = 'items'`)).editable_in)).not.toMatch(/NOT SUPPORTED/);
    expect(await preview(P)).toMatchObject({ ok: false, error_class: 'INVALID_STATE' });
    expect((await dash(P)).invoice_status).toBe('NOT_YET_DUE');
    // 13 (duplicate lifecycle event): the same acceptance again creates nothing new.
    expect(await call('wf_quote_accepted', ev)).toMatchObject({ duplicate: true, project_number: P });
    expect((await one(`select count(*)::int n from projects p join quotes qt on qt.id = p.quote_id where qt.quote_number = 'Q-2026-0041'`)).n).toBe(1);
  });

  it('2. no work started: Done is refused and Airtable corrected; no final invoice; no jump to Completed', async () => {
    const r = await change(P, { [F.photos]: 'Done' });
    expect(r.outcome).toBe('REJECTED');
    expect(rejectedReason(r)).toMatch(/not started/);
    expect(r.corrections).toMatchObject({ [F.photos]: 'To do' });
    expect((await items(P)).COMPLETION_PHOTOS).toMatchObject({ status: 'OPEN', completed_on: null });
    expect(await change(P, { [F.status]: 'Completed' })).toMatchObject({ outcome: 'REJECTED' });
    expect(await status(P)).toBe('PLANNING');
    expect(await prepare(P)).toMatchObject({ error_class: 'INVALID_STATE' });
  });

  it('3. in progress: Done / Waived / Not applicable through Airtable, attributed, reason required, state machine enforced', async () => {
    expect(await change(P, { [F.start]: '2026-10-01', [F.end]: '2026-10-20' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await change(P, { [F.status]: 'Scheduled' })).toMatchObject({ outcome: 'APPLIED' });
    // AC-13B: the job starts only once its pre-start items are satisfied.
    expect(await change(P, { [F.swms]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await change(P, { [F.materials]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await change(P, { [F.status]: 'In Progress' })).toMatchObject({ outcome: 'APPLIED' });

    const unmapped = await change(P, { [F.photos]: 'Done' }, { actor: UNMAPPED });
    expect([unmapped.outcome, rejectedReason(unmapped)]).toEqual(['REJECTED', expect.stringMatching(/not mapped to a RoofOps employee/)]);
    expect(unmapped.corrections).toMatchObject({ [F.photos]: 'To do' });

    const noReason = await change(P, { [F.photos]: 'Waived' }, { current: { [F.photosNote]: '   ' } });
    expect([noReason.outcome, rejectedReason(noReason)]).toEqual(['REJECTED', expect.stringMatching(/Completion Photos Note/)]);
    expect((await items(P)).COMPLETION_PHOTOS).toMatchObject({ status: 'OPEN' });

    expect(await change(P, { [F.photos]: 'Maybe' })).toMatchObject({ outcome: 'REJECTED' });

    const done = await change(P, { [F.photos]: 'Done' });
    expect(done).toMatchObject({ outcome: 'APPLIED', corrections: {} });
    expect((await items(P)).COMPLETION_PHOTOS).toMatchObject({ status: 'DONE', completed_on: await today(), completed_by: 'EMP-900', waived_reason: null });
    expect(await one(`select actor_id, before_state, after_state from audit_events where action = 'project.checklist.changed' and business_reference = $1 order by seq desc limit 1`, [P]))
      .toMatchObject({ actor_id: APPROVER, before_state: { item: 'COMPLETION_PHOTOS', status: 'OPEN' }, after_state: { item: 'COMPLETION_PHOTOS', status: 'DONE', employee: 'EMP-900' } });

    const skip = await change(P, { [F.photos]: 'Waived' }, { current: { [F.photosNote]: 'Customer declined photos' } });
    expect([skip.outcome, rejectedReason(skip)]).toEqual(['REJECTED', expect.stringMatching(/To do first/)]);
    expect(skip.corrections).toMatchObject({ [F.photos]: 'Done' });

    expect(await change(P, { [F.photos]: 'To do' })).toMatchObject({ outcome: 'APPLIED' });                       // undo
    expect((await items(P)).COMPLETION_PHOTOS).toMatchObject({ status: 'OPEN', completed_on: null, completed_by: null });
    expect(await change(P, { [F.photos]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });

    const na = await change(P, { [F.cert]: 'Not applicable' }, { current: { [F.certNote]: 'Repair only: no certificate for this job' } });
    expect(na).toMatchObject({ outcome: 'APPLIED' });
    expect((await items(P)).COMPLIANCE_CERTIFICATE).toMatchObject({ status: 'NOT_APPLICABLE', waived_reason: 'Repair only: no certificate for this job', completed_on: null });
    expect(await expected(P)).toMatchObject({ [F.photos]: 'Done', [F.cert]: 'Not applicable' });
    expect(await change(P, { [F.cert]: 'To do' })).toMatchObject({ outcome: 'APPLIED' });                        // back to open for case 4
    expect(await prepare(P)).toMatchObject({ error_class: 'INVALID_STATE' });                                   // not completed yet
  });

  it('4. completed but not fully invoiced: held only by the open completion item, then ready through the supported path; amount = remaining_billable', async () => {
    expect(await change(P, { [F.status]: 'Completed' })).toMatchObject({ outcome: 'APPLIED' });
    const blocked = await preview(P);
    expect(blocked).toMatchObject({ ok: false, error_class: 'MISSING_DOCUMENT' });
    expect(String(blocked.message)).toMatch(/Compliance certificate issued/);
    expect(String(blocked.message)).toMatch(/Compliance Certificate.*Airtable|Airtable.*Compliance Certificate/);
    expect(await dash(P)).toMatchObject({ invoice_status: 'NOT_READY' });
    expect(await close(P)).toMatch(/left to bill: the final invoice has not been raised yet/);

    expect(await change(P, { [F.cert]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
    const ready = await preview(P);
    expect(ready).toMatchObject({ ok: true });
    const b = await billing(P);
    expect((ready.preview as R).amount_inc_gst).toBe(Number(b.remaining));
    expect(Number(b.remaining)).toBe(Number(b.entitlement));                                                       // nothing billed yet
    expect(await dash(P)).toMatchObject({ invoice_status: 'READY_TO_INVOICE', amount: Number(b.remaining).toFixed(2) });

    // The real stuck project: imported PRJ-2026-0007 (Completed, photos never marked) gets the same supported path.
    expect(await preview('PRJ-2026-0007')).toMatchObject({ error_class: 'MISSING_DOCUMENT' });
    expect(await change('PRJ-2026-0007', { [F.photos]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
    const b7 = await billing('PRJ-2026-0007');
    expect(await preview('PRJ-2026-0007')).toMatchObject({ ok: true, preview: { amount_inc_gst: Number(b7.remaining) } });
    // An imported project never had a Compliance Certificate item: nothing to set, Airtable stays blank.
    const none = await change('PRJ-2026-0007', { [F.cert]: 'Done' });
    expect([none.outcome, rejectedReason(none)]).toEqual(['REJECTED', expect.stringMatching(/no Compliance Certificate item/)]);
    expect(none.corrections).toHaveProperty(F.cert, null);
  });

  it('9. an approved variation after completion (before the final) is entitlement: the final includes it (AC-09 project_billing)', async () => {
    await rolledBack(async () => {
      await q(`insert into variations (variation_number, project_id, description, amount_inc_gst, status, customer_approved_at, approved_by)
               select 'VAR-LIFE-1', p.id, 'Extra flashing', 1100, 'APPROVED', now(), (select id from employees order by id limit 1) from projects p where p.project_number = $1`, [P]);
      const b = await billing(P);
      expect(await preview(P)).toMatchObject({ ok: true, preview: { amount_inc_gst: Number(b.remaining) } });
      expect(Number(b.remaining)).toBe(Number(b.quote) + 1100);
    });
  });

  it('5 + 6. the final invoice is raised; fully invoiced but unpaid: checklist locked, cannot be cancelled or closed', async () => {
    expect(await prepare(P)).toMatchObject({ outcome: 'PREVIEW_READY' });
    expect(await approve(P)).toMatchObject({ outcome: 'APPROVED' });
    expect(await one(`select i.invoice_type, i.status, i.sync_status from invoices i join projects p on p.id = i.project_id where p.project_number = $1`, [P]))
      .toMatchObject({ invoice_type: 'FINAL', status: 'APPROVED', sync_status: 'PENDING' });
    expect(Number((await billing(P)).remaining)).toBe(0);
    expect((await dash(P)).invoice_status).toBe('CREATING_IN_XERO');

    const reopen = await change(P, { [F.photos]: 'To do' });
    expect([reopen.outcome, rejectedReason(reopen)]).toEqual(['REJECTED', expect.stringMatching(/final invoice INV-[0-9-]+ already exists/)]);
    expect(reopen.corrections).toMatchObject({ [F.photos]: 'Done' });
    expect((await items(P)).COMPLETION_PHOTOS).toMatchObject({ status: 'DONE' });
    expect(await close(P)).toMatch(/not every invoice is paid yet/);
    expect(await change(P, { [F.status]: 'Cancelled' }, { current: { [F.reason]: 'Customer moved' } })).toMatchObject({ outcome: 'REJECTED' });
    expect(await prepare(P)).toMatchObject({ outcome: 'ALREADY_INVOICED' });
  });

  it('10. an UNKNOWN (ambiguous) Xero write: the checklist, cancel, close and a second final all stay refused (AC-04 semantics)', async () => {
    await rolledBack(async () => {
      await force(`update invoices set sync_status = 'UNKNOWN' where project_id = (select id from projects where project_number = $1)`, [P]);
      expect(await dash(P)).toMatchObject({ invoice_status: 'CHECKING_WITH_XERO', needs_attention: true });
      expect(await change(P, { [F.cert]: 'To do' })).toMatchObject({ outcome: 'REJECTED' });
      expect(await close(P)).not.toBeNull();
      expect(await preview(P)).toMatchObject({ ok: false, already_invoiced: true });
    });
    // A final invoice being created in Xero right now (approval in flight, no invoice row visible yet): locked too.
    await rolledBack(async () => {
      expect(await prepare('PRJ-2026-0007')).toMatchObject({ outcome: 'PREVIEW_READY' });
      await force(`update approvals set status = 'EXECUTING', decided_by = (select id from employees where employee_code = 'EMP-900'), decided_at = now() where business_reference = 'PRJ-2026-0007' and status = 'PENDING'`);
      const r = await change('PRJ-2026-0007', { [F.photos]: 'To do' });
      expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/being created in Xero/)]);
    });
  });

  it('12. the final exists but entitlement later grows: flagged, integrity warns, and the project cannot close until it is billed', async () => {
    await rolledBack(async () => {
      await q(`insert into variations (variation_number, project_id, description, amount_inc_gst, status, customer_approved_at, approved_by)
               select 'VAR-LIFE-2', p.id, 'Late extra', 550, 'APPROVED', now(), (select id from employees order by id limit 1) from projects p where p.project_number = $1`, [P]);
      expect(Number((await billing(P)).remaining)).toBe(550);
      const d = await dash(P);
      expect(d.needs_attention).toBe(true);
      expect(String(d.invoice_blocker)).toMatch(/550\.00 left to bill after the final invoice/);
      expect(await integrity('final_invoice_settles_entitlement')).toMatchObject({ status: 'WARNING' });
      await settleInXero(P);                                                           // the final paid, verified in Xero (AC-14)
      expect(await close(P)).toMatch(/550\.00 left to bill/);
    });
  });

  it('7. fully paid: closes only when billed = entitlement, everything is paid and the completion gate is satisfied', async () => {
    // P: while its Xero write is in flight it cannot close, even if marked paid; a local PAID flag is never enough (AC-14);
    // once Xero verified it paid (reconciliation), the guard lets it close.
    await rolledBack(async () => {
      await force(`update invoices set status = 'PAID' where project_id = (select id from projects where project_number = $1)`, [P]);
      expect(await close(P)).toMatch(/Xero write is still in flight/);
      await settleInXero(P);
      expect(await close(P)).toBeNull();
    });
    // PRJ-2026-0012: fully billed and paid by progress invoices while still In Progress, photos never marked.
    const X = 'PRJ-2026-0012';
    expect(Number((await billing(X)).remaining)).toBe(0);
    expect(await change(X, { [F.status]: 'Completed' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await dash(X)).toMatchObject({ invoice_status: 'FULLY_INVOICED', invoice_blocker: null });         // not "invoice after the documents"
    expect(await close(X)).toMatch(/completion items are still open \(Completion \/ compliance photos uploaded\)/);
    expect(await change(X, { [F.status]: 'Closed' })).toMatchObject({ outcome: 'REJECTED' });
    expect(await change(X, { [F.photos]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await close(X)).toBeNull();
    expect(await change(X, { [F.status]: 'Closed' })).toMatchObject({ outcome: 'APPLIED' });
    const after = await change(X, { [F.photos]: 'To do' });
    expect([after.outcome, rejectedReason(after)]).toEqual(['REJECTED', expect.stringMatching(/closed/i)]);
    expect(await prepare(X)).toMatchObject({ error_class: 'INVALID_STATE' });
    expect(await integrity('closed_project_settled')).toMatchObject({ status: 'PASS' });
  });

  it('8. cancelled: the checklist is locked and nothing is final-invoiced', async () => {
    // PRJ-2026-0001 as on hosted: cancelled after completion (no final invoice), its progress invoices kept.
    expect(await change('PRJ-2026-0001', { [F.status]: 'Cancelled' }, { current: { [F.reason]: 'Customer moved interstate' } })).toMatchObject({ outcome: 'APPLIED' });
    const r = await change('PRJ-2026-0001', { [F.photos]: 'To do' });
    expect([r.outcome, rejectedReason(r)]).toEqual(['REJECTED', expect.stringMatching(/cancelled/i)]);
    expect(await prepare('PRJ-2026-0001')).toMatchObject({ error_class: 'INVALID_STATE' });
    await rolledBack(async () => {
      expect(await change('PRJ-2026-0013', { [F.status]: 'Cancelled' }, { current: { [F.reason]: 'Customer withdrew' } })).toMatchObject({ outcome: 'APPLIED' });
      expect(await change('PRJ-2026-0013', { [F.photos]: 'Not applicable' }, { current: { [F.photosNote]: 'Job cancelled' } })).toMatchObject({ outcome: 'REJECTED' });
    });
  });

  it('11. over-billed stays OVER_BILLED whatever the paperwork says, and cannot close (AC-08)', async () => {
    await rolledBack(async () => {
      expect(await change('PRJ-2026-0006', { [F.photos]: 'To do' })).toMatchObject({ outcome: 'APPLIED' });
      expect(await preview('PRJ-2026-0006')).toMatchObject({ over_billed: true });
      expect(await dash('PRJ-2026-0006')).toMatchObject({ invoice_status: 'OVER_BILLED', needs_attention: true });
      expect(await close('PRJ-2026-0006')).toMatch(/over-billed/);
    });
  });

  it('13. duplicate, out-of-order and unattributed lifecycle events change nothing', async () => {
    const X = 'PRJ-2026-0007';
    const audits = async () => Number((await one(`select count(*)::int n from audit_events where action = 'project.checklist.changed' and business_reference = $1`, [X])).n);
    const before = await audits();
    // A newer edit, then the same delivery again: applied once.
    const id = `airtable:achLIFE:txnDUP:${recFor(X)}`;
    const at = new Date(Date.UTC(2026, 9, 5)).toISOString();
    expect(await change(X, { [F.photos]: 'To do' }, { id, at })).toMatchObject({ outcome: 'APPLIED' });
    expect(await change(X, { [F.photos]: 'To do' }, { id, at })).toMatchObject({ duplicate: true });
    expect(await audits()).toBe(before + 1);
    // An older edit delivered late: ignored.
    const late = await change(X, { [F.photos]: 'Done' }, { at: new Date(Date.UTC(2026, 9, 2)).toISOString() });
    expect(late.stale).toHaveLength(1);
    expect((await items(X)).COMPLETION_PHOTOS).toMatchObject({ status: 'OPEN' });
    // A missed edit replayed by the reconciler has no Airtable user: not applied (a person sets it again), Airtable corrected.
    const replay = await change(X, { [F.photos]: 'Done' }, { source: 'reconciler', actor: 'reconciliation', id: `reconcile:RECON-LIFE:${recFor(X)}:${F.photos}` });
    expect([replay.outcome, rejectedReason(replay)]).toEqual(['REJECTED', expect.stringMatching(/attribut/)]);
    expect((await items(X)).COMPLETION_PHOTOS).toMatchObject({ status: 'OPEN' });
    expect(await audits()).toBe(before + 1);
    // A duplicate status delivery.
    const sid = `airtable:achLIFE:txnSTATUS:${recFor(P)}`;
    const first = await change(P, { [F.status]: 'Completed' }, { id: sid });
    expect(await change(P, { [F.status]: 'Completed' }, { id: sid })).toMatchObject({ duplicate: true, outcome: first.outcome });
    expect(await status(P)).toBe('COMPLETED');
  });

  it('integrity: no closed project is unsettled; completed projects waiting on completion items are listed', async () => {
    expect(await integrity('closed_project_settled')).toMatchObject({ status: 'PASS' });
    // A Closed project with money still to bill (only reachable by bypassing the guard) is a FAIL, named.
    await rolledBack(async () => {
      await force(`update projects set status = 'CLOSED' where project_number = 'PRJ-2026-0002'`);
      expect(await integrity('closed_project_settled')).toMatchObject({ status: 'FAIL', refs: ['PRJ-2026-0002'] });
    });
    const waiting = await integrity('completed_awaiting_completion_items');
    expect(waiting.status).toBe('WARNING');
    expect(waiting.refs).toEqual(expect.arrayContaining([expect.stringMatching(/^PRJ-2026-0007/)]));
  });
});
