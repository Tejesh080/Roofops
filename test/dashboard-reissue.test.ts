/**
 * Reissue from the dashboard (REISSUE-UI-01): staff request and approve a reissue as themselves (session token, resolved
 * by the database); the requester can never approve it here; the existing reissue rules apply unchanged. After the
 * replacement draft is created, Airtable's projection carries the CURRENT Xero identity in Invoice Preview, and the
 * reconciler compares it (PROJECTION) only for reissued invoices.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TARGETS, migratedDb } from './helpers/db.js';
import { deletedReissueScenario, type ReissueScenario } from './helpers/reissue-scenario.js';
import type { Db } from '../src/db/db.js';

type R = Record<string, unknown>;
const PW = 'pilot test password 1';
const REASON = 'Draft deleted in Xero by mistake; the verified deletion is recorded, reissue the same invoice';
const uuidFor = (seed: string) => createHash('md5').update(seed).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

describe.each(TARGETS)('dashboard reissue and the Airtable identity [%s]', (target) => {
  let db: Db; let s: ReissueScenario;
  const tok: Record<string, string> = {};
  const one = async (sql: string, p: unknown[] = []) => (await db.query<R>(sql, p))[0]!;
  const call = async (sql: string, p: unknown[]) => (await one(sql, p)).r as R;
  const overview = (t: string) => call(`select web_reissue_overview($1) r`, [t]);
  const request = (t: string, inv: string, reason: string) => call(`select web_reissue_request($1, $2, $3) r`, [t, inv, reason]);
  const decide = (t: string, apr: string) => call(`select web_reissue_decide($1, $2, null) r`, [t, apr]);
  const item = async (t: string) => ((await overview(t)).items as R[]).find((x) => x.invoice_number === s.invoice.number)!;
  const expected = async () => (await one(`select x.expected from v_airtable_expected x join projects p on p.id = x.entity_id
                                            where x.entity_type = 'project' and p.project_number = $1`, [s.invoice.project])).expected as R;

  beforeAll(async () => {
    db = await migratedDb(target);
    s = await deletedReissueScenario(db, { project: 'PRJ-2026-0004', xid: 'aaaaaaaa-bbbb-cccc-dddd-00000000d001' });
    // The project's existing Airtable record (the import does not create the links), so it has an Airtable projection.
    await db.query(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, verified_at)
      select 'AIRTABLE', 'project', id, 'Record', 'recDashReissue0001', now() from projects where project_number = 'PRJ-2026-0004'
      on conflict do nothing`);
    for (const [emp, login] of [['EMP-900', 'finance'], ['EMP-901', 'admin'], ['EMP-002', 'estimator']] as const) {
      expect(await call(`select ops_staff_set_password($1, $2, $3) r`, [emp, login, PW])).toMatchObject({ ok: true });
      tok[login] = String((await call(`select web_staff_sign_in($1, $2) r`, [login, PW])).token);
    }
  }, 180_000);
  afterAll(async () => { await db.close(); });

  it('only the dashboard role runs the three web_reissue functions; the reissue core stays owner-only', async () => {
    const fn = async (f: string, role: string) => String((await one(`select has_function_privilege('${role}', '${f}', 'execute') v`)).v);
    for (const f of ['web_reissue_overview(text)', 'web_reissue_request(text,text,text)', 'web_reissue_decide(text,text,text)']) {
      expect(await fn(f, 'roofops_dashboard'), f).toBe('true');
      expect(await fn(f, 'roofops_workflow'), f).toBe('false');
    }
    for (const f of ['ops_reissue_request(uuid,text,text)', 'ops_reissue_decide(text,text,text)', 'invoice_reissue_check(uuid)']) {
      expect(await fn(f, 'roofops_dashboard'), f).toBe('false');
    }
  });

  it('the overview needs a staff session and shows the voided invoice, why it can be reissued, and who may', async () => {
    expect(await overview('0'.repeat(64))).toMatchObject({ ok: false });
    const fin = await overview(tok.finance!);
    expect(fin).toMatchObject({ ok: true, me: { employee_code: 'EMP-900', may_reissue: true } });
    expect(await item(tok.finance!)).toMatchObject({ status: 'VOIDED', check: { ok: true, target_generation: 2 }, pending: null });
    expect(await overview(tok.estimator!)).toMatchObject({ ok: true, me: { may_reissue: false } });
  });

  it('a request is made as the session employee; a role that may not reissue, a weak reason or a bad session changes nothing', async () => {
    expect(await request(tok.estimator!, s.invoice.number, REASON)).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    expect(await request(tok.finance!, s.invoice.number, 'too short')).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(await request('f'.repeat(64), s.invoice.number, REASON)).toMatchObject({ ok: false, code: 'SIGNED_OUT' });
    expect(await request(tok.finance!, 'INV-2099-9999', REASON)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(String((await one(`select count(*) v from approvals where action_type = 'REISSUE_INVOICE'`)).v)).toBe('0');
    const r = await request(tok.finance!, s.invoice.number, REASON);
    expect(r).toMatchObject({ ok: true, code: 'REISSUE_REQUESTED' });
    expect(await one(`select (select employee_code from employees e where e.id = a.requested_by_employee_id) by_emp, status from approvals a where approval_number = $1`,
      [r.approval_number])).toEqual({ by_emp: 'EMP-900', status: 'PENDING' });
    expect((await item(tok.finance!)).pending).toMatchObject({ approval_number: r.approval_number, requested_by: 'EMP-900', i_requested_it: true,
      xero_invoice_number: expect.stringMatching(/^RO-INV-/) as unknown, reason: REASON });
    expect((await item(tok.admin!)).pending).toMatchObject({ i_requested_it: false });
  });

  it('the requester can never approve from the dashboard (even with the CLI setting off); a second person does, once', async () => {
    const apr = String(((await item(tok.finance!)).pending as R).approval_number);
    expect(String((await one(`select value v from app_settings where key = 'invoice.reissue_requires_second_person'`)).v)).toBe('false');
    expect(await decide(tok.finance!, apr)).toMatchObject({ ok: false, code: 'SAME_PERSON', detail: expect.stringMatching(/second person/) as unknown });
    expect(await one(`select status from approvals where approval_number = $1`, [apr])).toEqual({ status: 'PENDING' });
    expect((await s.ledger()).length).toBe(1);
    expect(await decide(tok.estimator!, apr)).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    expect(await decide(tok.admin!, apr)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED', generation: 2 });
    expect(await decide(tok.admin!, apr)).toMatchObject({ ok: false, code: 'ALREADY_PROCESSED' });   // a double click decides once
    expect(await one(`select a.status, (select employee_code from employees e where e.id = a.decided_by) by_emp from approvals a where approval_number = $1`, [apr]))
      .toEqual({ status: 'EXECUTED', by_emp: 'EMP-901' });
    expect((await item(tok.finance!)).latest_decided).toMatchObject({ approval_number: apr, status: 'EXECUTED', generation: 2, write_status: 'PENDING' });
  });

  it('until the replacement exists, Airtable is not given a preview; once 05 creates it, the projection shows the current identity', async () => {
    expect((await expected()).fldt9KIOPXh3c3pGU).toBeUndefined();
    const key = String((await one(`select xero_draft_outbox_key($1, 2) k`, [s.invoice.id])).k);
    const p = (await one(`select payload from outbox where idempotency_key = $1`, [key])).payload as R;
    expect((await one(`select wf_claim_side_effect($1, 'n8n:05', 120) c`, [key])).c).toMatchObject({ claimed: true, generation: 2 });
    const xid = uuidFor(`replacement:${s.invoice.id}`);
    await db.query(`select wf_complete_side_effect($1, $2::jsonb)`, [key, JSON.stringify({ verified: true, tenant_id: p.xero_tenant_id, organisation_class: 'DEMO',
      invoice_id: xid, invoice_number: p.xero_invoice_number, reference: p.reference, status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false,
      contact_id: uuidFor(`contact:${String(p.customer_id)}`), contact_number: p.xero_contact_number, total: p.amount_inc_gst, total_tax: p.gst_amount,
      currency: 'AUD', line_amount_types: 'Inclusive', matching_invoices: 1 })]);
    const e = await expected();
    expect(e.fld3sDI9LIX8Voo4u).toBe(xid);
    const preview = String(e.fldt9KIOPXh3c3pGU);
    expect(preview).toContain(`XERO DRAFT ${String(p.xero_invoice_number)} (InvoiceID ${xid})`);
    expect(preview).toContain(`Replaces InvoiceID ${s.invoice.xid}`);
    expect(preview).toMatch(/Reissued under APR-\d{4}-\d{4}: requested by .+, approved by Ada Admin/);
    expect(preview).toMatch(/Amount: \$[\d,]+\.\d\d inc GST/);
    expect((await item(tok.finance!)).latest_decided).toMatchObject({ write_status: 'DONE', xero_invoice_id: xid, generation_status: 'CREATED' });
    expect(await one(`select reconcile from field_contract where field_key = 'invoice_preview'`)).toEqual({ reconcile: 'PROJECTION' });
  });

  it('the reconciler finds the stale generation-1 preview in Airtable and repairs it to the current identity (PROJECTION)', async () => {
    const e = await expected();
    const stale = `XERO DRAFT ${String(e.fldgkN0Vm6k1MZLJp)} (InvoiceID ${s.invoice.xid}) in Demo Company (AU)\nApproved by Demo Finance Approver under APR-2026-0001`;
    const rec = String((await one(`select x.record_id from v_airtable_expected x join projects p on p.id = x.entity_id
                                    where x.entity_type = 'project' and p.project_number = $1`, [s.invoice.project])).record_id);
    const records = [{ id: rec, fields: { ...e, fldt9KIOPXh3c3pGU: stale } }];
    const start = async (mode: string) => call(`select wf_reconcile_start('schedule', $1) r`, [mode]);
    await db.exec(`update reconciliation_runs set started_at = started_at - interval '5 minutes'`);   // the scenario's own run (quota guard)
    const obs = await start('observe');
    expect(obs, JSON.stringify(obs)).toMatchObject({ started: true });
    const o = await call(`select wf_reconcile_airtable($1, 'tblvUPIoebC3zoacv', $2::jsonb) r`, [obs.run_key, JSON.stringify(records)]);
    expect(o, JSON.stringify(o)).toMatchObject({ ok: true, drift: 1, corrections: [] });
    // (Other projects get row-level findings here only because this fake read contains just this one record.)
    expect(await db.query(`select field, classification, action from reconciliation_findings f join reconciliation_runs r on r.id = f.run_id
                           where r.run_key = $1 and f.entity_ref = $2 and f.field is not null`, [obs.run_key, s.invoice.project]))
      .toEqual([{ field: 'Invoice Preview', classification: 'SAFE_AUTO_REPAIR', action: 'NONE_OBSERVE_ONLY' }]);
    await db.query(`select wf_reconcile_finish($1, '{}'::jsonb, '[]'::jsonb)`, [obs.run_key]);
    await db.exec(`update reconciliation_runs set started_at = started_at - interval '5 minutes'`);
    const rep = await start('repair');
    const r = await call(`select wf_reconcile_airtable($1, 'tblvUPIoebC3zoacv', $2::jsonb) r`, [rep.run_key, JSON.stringify(records)]);
    expect(r.corrections).toEqual([{ id: rec, fields: expect.objectContaining({ fldt9KIOPXh3c3pGU: e.fldt9KIOPXh3c3pGU }) as unknown }]);
    // Airtable matching the projection is no drift.
    await db.query(`select wf_reconcile_finish($1, '{}'::jsonb, '[]'::jsonb)`, [rep.run_key]);
    await db.exec(`update reconciliation_runs set started_at = started_at - interval '5 minutes'`);
    const again = await start('observe');
    expect(await call(`select wf_reconcile_airtable($1, 'tblvUPIoebC3zoacv', $2::jsonb) r`, [again.run_key, JSON.stringify([{ id: rec, fields: e }])]))
      .toMatchObject({ ok: true, drift: 0 });
  });

  it('a project that was never reissued gets no preview expectation (the AC-03 preview flow is untouched)', async () => {
    const others = await db.query<{ n: number | string }>(`select count(*) n from v_airtable_expected x join projects p on p.id = x.entity_id
      where x.entity_type = 'project' and p.project_number <> $1 and x.expected ? 'fldt9KIOPXh3c3pGU'`, [s.invoice.project]);
    expect(String(others[0]!.n)).toBe('0');
    expect(await s.integrityFails()).toEqual([]);
  });
});
