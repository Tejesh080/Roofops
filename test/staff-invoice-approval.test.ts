/**
 * STAFF-OPS-01 (migration 20261016000000): final invoices prepared and approved by named staff in the dashboard, and
 * Xero draft writes sent on a staff request through n8n 09 → 05, with the existing safeguards. Two synthetic people:
 * EMP-801 (FINANCE) prepares, EMP-802 (ADMIN) approves; EMP-002 (ESTIMATOR) may do neither.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPostgres, type Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';
import { deletedReissueScenario } from './helpers/reissue-scenario.js';
import { TOOLS } from '../web/lib/copilot/tools.ts';

type R = Record<string, unknown>;
const PW = 'pilot test password 1';
const TENANT = '11111111-2222-3333-4444-555555555555';

describe.each(TARGETS)('staff invoice approval and Xero dispatch [%s]', (target) => {
  let db: Db;
  const tok: Record<string, string> = {};
  const one = async (sql: string, p: unknown[] = []) => (await db.query<R>(sql, p))[0]!;
  const call = async (sql: string, p: unknown[]) => (await one(sql, p)).r as R;
  const prepare = (t: string, prj: string) => call('select web_invoice_prepare($1, $2) r', [t, prj]);
  const decide = (t: string, apr: string, hash: string, d: 'approve' | 'reject', note: string | null = null) =>
    call('select web_invoice_decide($1, $2, $3, $4, $5) r', [t, apr, hash, d, note]);
  const overview = (t: string) => call('select web_invoice_overview($1) r', [t]);
  const request = (t: string, inv: string, gen: number, sha: string) => call('select web_xero_dispatch_request($1, $2, $3, $4) r', [t, inv, gen, sha]);
  const next = async () => {
    await db.exec('set role roofops_workflow');
    try { return await call(`select wf_xero_dispatch_next('n8n:09:test') r`, []); } finally { await db.exec('reset role'); }
  };
  const draft = async (inv: string) => ((await overview(tok.finance!)).drafts as R[]).find((d) => d.invoice_number === inv)!;
  const fail = (key: string, cls: string, step: string, msg: string, http: number | null = null) =>
    call('select wf_fail_side_effect($1, $2, $3, $4, 0) r', [key, cls, `${step}: ${msg}`, http]);
  const complete = async (key: string) => {
    const p = (await one('select payload from outbox where idempotency_key = $1', [key])).payload as R;
    return call('select wf_complete_side_effect($1, $2::jsonb) r', [key, JSON.stringify({ verified: true, tenant_id: p.xero_tenant_id, organisation_class: 'DEMO',
      invoice_id: 'abcdef01-2345-6789-abcd-ef0123456789', invoice_number: p.xero_invoice_number, reference: p.reference, status: 'DRAFT', type: 'ACCREC',
      amount_paid: 0, sent_to_contact: false, contact_id: 'abcdef01-2345-6789-abcd-000000000001', contact_number: p.xero_contact_number,
      total: p.amount_inc_gst, total_tax: p.gst_amount, currency: 'AUD', line_amount_types: 'Inclusive', matching_invoices: 1 })]);
  };
  /** Prepare as Finance and approve as Admin; returns the approval, invoice and its write key. */
  const approved = async (prj: string) => {
    const p = await prepare(tok.finance!, prj);
    expect(p, JSON.stringify(p)).toMatchObject({ ok: true, outcome: 'PREVIEW_READY' });
    const d = await decide(tok.admin!, String(p.approval_number), String(p.payload_hash), 'approve');
    expect(d, JSON.stringify(d)).toMatchObject({ ok: true, outcome: 'APPROVED' });
    return { apr: String(p.approval_number), inv: String(d.invoice_number), key: String(d.xero_key), hash: String(p.payload_hash) };
  };

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.query(`update app_settings set value = $1 where key = 'xero.demo_tenant_id'`, [TENANT]);
    await db.query(`insert into employees (employee_code, full_name, email, role, is_active) values
      ('EMP-801', 'Synthetic Finance Requester', 'f@example.test', 'FINANCE', true), ('EMP-802', 'Synthetic Admin Approver', 'a@example.test', 'ADMIN', true)`);
    for (const [emp, login] of [['EMP-801', 'finance'], ['EMP-802', 'admin'], ['EMP-002', 'estimator']] as const) {
      expect(await call('select ops_staff_set_password($1, $2, $3) r', [emp, login, PW])).toMatchObject({ ok: true });
      tok[login] = String((await call('select web_staff_sign_in($1, $2) r', [login, PW])).token);
    }
  }, 180_000);
  afterAll(async () => { await db.close(); });

  it('privileges: the web functions are the dashboard\'s, the poller is n8n\'s, the decision core is nobody\'s', async () => {
    const can = async (f: string, role: string) => String((await one(`select has_function_privilege('${role}', '${f}', 'execute') v`)).v);
    for (const f of ['web_invoice_overview(text)', 'web_invoice_prepare(text,text)', 'web_invoice_decide(text,text,text,text,text)', 'web_xero_dispatch_request(text,text,integer,text)']) {
      expect([await can(f, 'roofops_dashboard'), await can(f, 'roofops_workflow')], f).toEqual(['true', 'false']);
    }
    expect([await can('wf_xero_dispatch_next(text)', 'roofops_workflow'), await can('wf_xero_dispatch_next(text)', 'roofops_dashboard')]).toEqual(['true', 'false']);
    for (const role of ['roofops_dashboard', 'roofops_workflow']) expect(await can('wf_invoice_decide_core(jsonb,text,uuid)', role)).toBe('false');
    expect(await one(`select count(*)::int n from pg_proc where proname = 'wf_invoice_decide_core'`)).toEqual({ n: 1 });
  });

  it('a signed-out token and a role without permission are refused; nothing is prepared', async () => {
    expect(await prepare('0'.repeat(64), 'PRJ-2026-0004')).toMatchObject({ ok: false, code: 'SIGNED_OUT' });
    expect(await prepare(tok.estimator!, 'PRJ-2026-0004')).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    expect(await overview('0'.repeat(64))).toMatchObject({ ok: false, code: 'SIGNED_OUT' });
    expect(await one(`select count(*)::int n from approvals where business_reference = 'PRJ-2026-0004' and action_type = 'CREATE_INVOICE'`)).toEqual({ n: 0 });
  });

  it('Finance prepares: the preview records the employee and shows customer, amounts, GST and lines; Finance cannot approve it', async () => {
    const p = await prepare(tok.finance!, 'PRJ-2026-0004');
    expect(p).toMatchObject({ ok: true, outcome: 'PREVIEW_READY' });
    expect(await prepare(tok.finance!, 'PRJ-2026-0004')).toMatchObject({ ok: true, outcome: 'ALREADY_PENDING', approval_number: p.approval_number });
    expect(await one(`select e.employee_code, a.status from approvals a join employees e on e.id = a.requested_by_employee_id where a.approval_number = $1`, [p.approval_number]))
      .toEqual({ employee_code: 'EMP-801', status: 'PENDING' });
    const pending = ((await overview(tok.admin!)).pending as R[]).find((x) => x.approval_number === p.approval_number)!;
    expect(pending).toMatchObject({ project_number: 'PRJ-2026-0004', requested_by: 'Synthetic Finance Requester', i_requested_it: false, requested_via: 'dashboard', payload_hash: p.payload_hash });
    expect(pending.preview).toMatchObject({ amount_inc_gst: 14664.49, gst_amount: 1333.14 });
    expect(String((pending.preview as R).customer_name)).not.toBe('');
    expect(((pending.preview as R).lines as R[])[0]).toMatchObject({ line_no: 1 });
    expect(await decide(tok.finance!, String(p.approval_number), String(p.payload_hash), 'approve')).toMatchObject({ ok: false, code: 'SAME_PERSON' });
    expect(await decide(tok.estimator!, String(p.approval_number), String(p.payload_hash), 'approve')).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    expect(await decide(tok.admin!, String(p.approval_number), 'not-the-hash', 'approve')).toMatchObject({ ok: false, code: 'PREVIEW_CHANGED' });
    expect(await one(`select status from approvals where approval_number = $1`, [p.approval_number])).toEqual({ status: 'PENDING' });
  });

  it('Admin approves the exact preview: one FINAL invoice, one Xero write, one staff request; a repeat does nothing', async () => {
    const p = ((await overview(tok.admin!)).pending as R[]).find((x) => x.project_number === 'PRJ-2026-0004')!;
    const d = await decide(tok.admin!, String(p.approval_number), String(p.payload_hash), 'approve', 'Checked amount and customer');
    expect(d).toMatchObject({ ok: true, outcome: 'APPROVED', decided_by: 'Synthetic Admin Approver' });
    expect(await decide(tok.admin!, String(p.approval_number), String(p.payload_hash), 'approve')).toMatchObject({ ok: false, code: 'ALREADY_PROCESSED' });
    expect(await one(`select a.status, e.employee_code by_emp from approvals a join employees e on e.id = a.decided_by where a.approval_number = $1`, [p.approval_number]))
      .toEqual({ status: 'EXECUTING', by_emp: 'EMP-802' });
    expect(await one(`select count(*)::int finals from invoices i join projects p on p.id = i.project_id where p.project_number = 'PRJ-2026-0004' and i.invoice_type = 'FINAL'`)).toEqual({ finals: 1 });
    expect(await one(`select count(*)::int n, min(status) s from outbox where topic = 'xero.create_draft_invoice' and idempotency_key = $1`, [d.xero_key])).toEqual({ n: 1, s: 'PENDING' });
    expect(await one(`select r.status, e.employee_code from xero_dispatch_requests r join employees e on e.id = r.requested_by where r.xero_key = $1`, [d.xero_key]))
      .toEqual({ status: 'QUEUED', employee_code: 'EMP-802' });
    expect(await one(`select actor_id from audit_events where action = 'approval.approve' and business_reference = $1`, [p.approval_number])).toEqual({ actor_id: 'EMP-802' });
    expect(await draft(String(d.invoice_number))).toMatchObject({ state: 'QUEUED', generation: 1, request: { requested_by: 'Synthetic Admin Approver' } });
  });

  it('n8n 09 hands exactly that one write to 05, once; 05\'s claim and read-back finish it; staff see it created', async () => {
    const inv = String((await one(`select i.invoice_number from invoices i join projects p on p.id = i.project_id where p.project_number = 'PRJ-2026-0004' and i.invoice_type = 'FINAL'`)).invoice_number);
    const d0 = await draft(inv);
    expect(await request(tok.finance!, inv, 1, String(d0.payload_sha256))).toMatchObject({ ok: false, code: 'ALREADY_QUEUED' });
    const n = await next();
    expect(n.writes).toEqual([expect.objectContaining({ invoice_number: inv, generation: 1 })]);
    const key = String((n.writes as R[])[0]!.xero_key);
    expect((await next()).writes).toEqual([]);                                   // nothing twice
    expect(await draft(inv)).toMatchObject({ state: 'STARTING' });
    expect(await call(`select wf_claim_side_effect($1, 'n8n:05', 120) r`, [key])).toMatchObject({ claimed: true });
    expect(await draft(inv)).toMatchObject({ state: 'SENDING' });
    await complete(key);
    expect(await draft(inv)).toMatchObject({ state: 'CREATED', xero_invoice_id: 'abcdef01-2345-6789-abcd-ef0123456789' });
    expect(await request(tok.finance!, inv, 1, String(d0.payload_sha256))).toMatchObject({ ok: false, code: 'ALREADY_CREATED' });
    expect(await one(`select xero_invoice_id from v_dashboard_projects where project_number = 'PRJ-2026-0004'`)).toEqual({ xero_invoice_id: 'abcdef01-2345-6789-abcd-ef0123456789' });
  });

  it('a failed write shows when it can be retried; staff retry it once it is due; a changed payload is refused', async () => {
    const a = await approved('PRJ-2026-0005');
    const n = await next();
    expect((n.writes as R[])[0]).toMatchObject({ xero_key: a.key });
    await call(`select wf_claim_side_effect($1, 'n8n:05', 120) r`, [a.key]);
    expect(await fail(a.key, 'NETWORK', 'search by invoice number', 'ECONNRESET')).toMatchObject({ retry: true });
    const d = await draft(a.inv);
    expect(d.state).toMatch(/RETRY_LATER|FAILED/);
    expect(d.last_error).toContain('ECONNRESET');
    if (d.state === 'RETRY_LATER') expect(await request(tok.finance!, a.inv, 1, String(d.payload_sha256))).toMatchObject({ ok: false, code: 'NOT_DUE' });
    await db.query(`update outbox set next_attempt_at = now() - interval '1 second' where idempotency_key = $1`, [a.key]);
    expect(await request(tok.finance!, a.inv, 1, 'stale-hash')).toMatchObject({ ok: false, code: 'PAYLOAD_CHANGED' });
    expect(await request(tok.estimator!, a.inv, 1, String(d.payload_sha256))).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    expect(await request(tok.finance!, a.inv, 1, String(d.payload_sha256))).toMatchObject({ ok: true, code: 'QUEUED' });
    expect((await draft(a.inv)).state).toBe('QUEUED');
    expect(((await next()).writes as R[])[0]).toMatchObject({ xero_key: a.key });
  });

  it('an ambiguous create is UNCERTAIN: never requested, and a queued request is refused by the poller (fail closed)', async () => {
    const a = (await one(`select o.idempotency_key k, i.invoice_number inv from outbox o join invoices i on i.id = o.aggregate_id join projects p on p.id = i.project_id
                           where p.project_number = 'PRJ-2026-0005' and o.topic = 'xero.create_draft_invoice'`)) as { k: string; inv: string };
    await call(`select wf_claim_side_effect($1, 'n8n:05', 120) r`, [a.k]);
    expect(await fail(a.k, 'TIMEOUT', 'create draft invoice', 'ETIMEDOUT after 20s')).toMatchObject({ retry: true });
    const d = await draft(a.inv);
    expect(d).toMatchObject({ state: 'UNCERTAIN' });
    await db.query(`update outbox set next_attempt_at = now() - interval '1 second' where idempotency_key = $1`, [a.k]);
    expect(await request(tok.finance!, a.inv, 1, String(d.payload_sha256))).toMatchObject({ ok: false, code: 'UNCERTAIN' });
    // A request queued before the outcome became uncertain: the poller re-checks and refuses it, handing nothing to 05.
    await db.query(`insert into xero_dispatch_requests (invoice_id, generation, xero_key, payload_sha256, requested_by, reason)
                    select i.id, 1, $1, xero_payload_sha256(o.payload), e.id, 'test' from invoices i, outbox o, employees e
                     where i.invoice_number = $2 and o.idempotency_key = $1 and e.employee_code = 'EMP-801'`, [a.k, a.inv]);
    const n = await next();
    expect(n.writes).toEqual([]);
    expect(n.refused).toEqual([{ invoice_number: a.inv, code: 'UNCERTAIN' }]);
  });

  it('a preview from the shared Airtable account cannot be approved here (no requester), but can be rejected; an expired one is refused', async () => {
    const apr = String((await call(`select wf_invoice_prepare($1::jsonb, 'n8n:04') r`, [JSON.stringify({ event_id: 'airtable:T:1', event_type: 'invoice.prepare_requested',
      source: 'airtable', actor_id: 'usr7uCnNO15fCefbH', occurred_at: new Date().toISOString(), payload: { project_number: 'PRJ-2026-0002' } })])).approval_number);
    const hash = String((await one('select payload_hash from approvals where approval_number = $1', [apr])).payload_hash);
    expect((((await overview(tok.admin!)).pending as R[]).find((x) => x.approval_number === apr))).toMatchObject({ requested_via: 'airtable' });
    expect(await decide(tok.admin!, apr, hash, 'approve')).toMatchObject({ ok: false, code: 'REQUESTER_UNKNOWN' });
    expect(await decide(tok.admin!, apr, hash, 'reject', 'Prepared on the shared account; preparing it again')).toMatchObject({ ok: true, outcome: 'REJECTED_BY_APPROVER' });
    expect(await one(`select status, decision_reason from approvals where approval_number = $1`, [apr])).toEqual({ status: 'REJECTED', decision_reason: 'Prepared on the shared account; preparing it again' });
    const p = await prepare(tok.finance!, 'PRJ-2026-0002');
    await db.query(`update approvals set expires_at = now() - interval '1 second' where approval_number = $1`, [p.approval_number]);
    expect(await decide(tok.admin!, String(p.approval_number), String(p.payload_hash), 'approve')).toMatchObject({ ok: false, outcome: 'INVALID_STATE' });
    expect(await one(`select status from approvals where approval_number = $1`, [p.approval_number])).toEqual({ status: 'EXPIRED' });
  });

  it('an exception from a rejected Airtable event says which record it came from (dashboard-readable, no payload)', async () => {
    const r = await call(`select wf_quote_accepted($1::jsonb) r`, [JSON.stringify({ event_id: 'EVT-SRC-1', event_type: 'quote.accepted', source: 'airtable',
      actor_id: 'airtable-automation', occurred_at: new Date().toISOString(), payload: { accepted_version: 1, airtable_record_id: 'recSOURCETEST0001' } })]);
    expect(r).toMatchObject({ status: 'REJECTED' });
    await db.exec('begin; set local role roofops_dashboard;');
    try {
      const src = await one(`select * from v_dashboard_exception_sources where airtable_record_id = 'recSOURCETEST0001'`);
      expect(src).toMatchObject({ source: 'airtable', event_type: 'quote.accepted', airtable_record_id: 'recSOURCETEST0001', named_record: null });
      expect(Object.keys(src).sort()).toEqual(['airtable_record_id', 'event_type', 'exception_number', 'named_record', 'occurred_at', 'source']);
    } finally { await db.exec('rollback'); }
  });

  it('a Copilot preview asked for by a signed-in employee records that employee (run with the dashboard role\'s privileges)', async () => {
    await db.exec('begin; set local role roofops_dashboard;');
    let r: R;
    try {
      const asDashboard = ((sql: string, params: unknown[] = []) => db.query(sql, params)) as never;
      r = (await TOOLS.prepare_invoice!.run({ project_number: 'PRJ-2026-0002' },
        { query: asDashboard, requestId: 'copilot-staff-test', lastUserMessage: 'Prepare invoice for PRJ-2026-0002', token: tok.finance! })).data as R;
    } finally { await db.exec('commit'); }
    expect(r).toMatchObject({ outcome: 'Prepared: awaiting approval', requires_human_approval: true });
    expect(String(r.how_it_gets_approved)).toContain('Finance → Invoice approvals');
    expect(await one(`select e.employee_code from approvals a join employees e on e.id = a.requested_by_employee_id where a.approval_number = $1`, [r.approval_reference]))
      .toEqual({ employee_code: 'EMP-801' });
    const p = ((await overview(tok.admin!)).pending as R[]).find((x) => x.approval_number === r.approval_reference)!;
    expect(p).toMatchObject({ requested_by: 'Synthetic Finance Requester', requested_via: 'dashboard' });
    expect(await decide(tok.admin!, String(r.approval_reference), String(p.payload_hash), 'approve')).toMatchObject({ ok: true, outcome: 'APPROVED' });
  });

  it('a reissue\'s replacement (generation 2) is sent on a Finance/Admin request with the exact generation', async () => {
    const s = await deletedReissueScenario(db, { project: 'PRJ-2026-0001', xid: 'aaaaaaaa-bbbb-cccc-dddd-00000000e001' });
    // Voided (its draft was deleted in Xero): never listed as a draft "in Xero", never sent (found in the browser, 2026-10-15).
    expect(((await overview(tok.finance!)).drafts as R[]).map((d) => d.invoice_number)).not.toContain(s.invoice.number);
    expect(await request(tok.finance!, s.invoice.number, 1, 'any')).toMatchObject({ ok: false, code: 'VOIDED' });
    const r = await call('select web_reissue_request($1, $2, $3) r', [tok.finance, s.invoice.number, 'Deleted in Xero by mistake; reissue the same invoice']);
    expect(await call('select web_reissue_decide($1, $2, null) r', [tok.admin, r.approval_number])).toMatchObject({ ok: true, generation: 2 });
    const d = await draft(s.invoice.number);
    expect(d).toMatchObject({ state: 'READY_TO_SEND', generation: 2 });
    expect(await request(tok.finance!, s.invoice.number, 1, String(d.payload_sha256))).toMatchObject({ ok: false, code: 'NOT_CURRENT_GENERATION' });
    expect(await request(tok.finance!, s.invoice.number, 2, String(d.payload_sha256))).toMatchObject({ ok: true, code: 'QUEUED' });
    // The poller hands over one write per run, oldest request first: earlier approvals in this file go first.
    let mine: R | undefined;
    for (let i = 0; i < 5 && !mine; i++) {
      const w = (await next()).writes as R[];
      if (!w.length) break;
      mine = w.find((x) => x.invoice_number === s.invoice.number);
    }
    expect(mine).toMatchObject({ invoice_number: s.invoice.number, generation: 2 });
  });
});

/**
 * Operations status (v_dashboard_ops_status), on its own fresh database: every line is driven through the real
 * functions (staff prepare/approve, the n8n 09 poller, 05's claim and failure report, the reconciler, the health probe);
 * only timestamps are moved, to make something old. Read with the dashboard role's privileges.
 */
describe.each(TARGETS)('operations status [%s]', (target) => {
  let db: Db;
  const tok: Record<string, string> = {};
  const one = async (sql: string, p: unknown[] = []) => (await db.query<R>(sql, p))[0]!;
  const call = async (sql: string, p: unknown[]) => (await one(sql, p)).r as R;
  const status = async () => {
    await db.exec('begin; set local role roofops_dashboard;');
    // count is bigint: a string on Postgres, a number on PGlite; compare numbers on both.
    try {
      return Object.fromEntries((await db.query<R>('select key, state, count from v_dashboard_ops_status'))
        .map((r) => [String(r.key), { ...r, count: r.count === null ? null : Number(r.count) }]));
    }
    finally { await db.exec('rollback'); }
  };
  const asWorkflow = async (sql: string, p: unknown[]) => {
    await db.exec('set role roofops_workflow');
    try { return await call(sql, p); } finally { await db.exec('reset role'); }
  };

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.query(`update app_settings set value = $1 where key = 'xero.demo_tenant_id'`, [TENANT]);
    await db.query(`insert into employees (employee_code, full_name, email, role, is_active) values
      ('EMP-801', 'Synthetic Finance Requester', 'f@example.test', 'FINANCE', true), ('EMP-802', 'Synthetic Admin Approver', 'a@example.test', 'ADMIN', true)`);
    for (const [emp, login] of [['EMP-801', 'finance'], ['EMP-802', 'admin']] as const) {
      expect(await call('select ops_staff_set_password($1, $2, $3) r', [emp, login, PW])).toMatchObject({ ok: true });
      tok[login] = String((await call('select web_staff_sign_in($1, $2) r', [login, PW])).token);
    }
  }, 180_000);
  afterAll(async () => { await db.close(); });

  it('with no evidence nothing is "ok": no reconciliation and no health check are unknown; empty queues are facts', async () => {
    const st = await status();
    expect(st.reconciliation).toMatchObject({ state: 'unknown' });
    expect(st.health_probe).toMatchObject({ state: 'unknown' });
    for (const k of ['approvals', 'xero_queue', 'xero_stuck', 'xero_uncertain', 'xero_stopped', 'xero_retrying']) expect(st[k], k).toMatchObject({ state: 'ok', count: 0 });
    expect(Object.keys(st).sort()).toEqual(['approvals', 'exceptions', 'health_probe', 'reconciliation', 'xero_queue', 'xero_retrying', 'xero_stopped', 'xero_stuck', 'xero_uncertain']);
  });

  it('a recent reconciliation and health check are ok; old ones are stale (never ok)', async () => {
    const run = await call(`select wf_reconcile_start('schedule', 'observe') r`, []);
    expect(run, JSON.stringify(run)).toMatchObject({ started: true });
    await db.query(`select wf_reconcile_finish($1, '{}'::jsonb, '[]'::jsonb)`, [run.run_key]);
    await asWorkflow(`select wf_record_health($1::jsonb) r`, [JSON.stringify([{ service: 'n8n', ok: true, detail: { check: 'test' } }])]);
    let st = await status();
    expect(st.reconciliation).toMatchObject({ state: 'ok' });
    expect(st.health_probe).toMatchObject({ state: 'ok' });
    await db.query(`update reconciliation_runs set finished_at = finished_at - interval '30 hours', started_at = started_at - interval '30 hours'`);
    await db.query(`update integration_health set checked_at = checked_at - interval '1 hour'`);
    st = await status();
    expect(st.reconciliation).toMatchObject({ state: 'stale' });
    expect(st.health_probe).toMatchObject({ state: 'stale' });
  });

  it('approvals: one waiting is info, one waiting more than 2 days needs attention', async () => {
    const p = await call('select web_invoice_prepare($1, $2) r', [tok.finance, 'PRJ-2026-0004']);
    expect(p).toMatchObject({ ok: true, outcome: 'PREVIEW_READY' });
    expect((await status()).approvals).toMatchObject({ state: 'info', count: 1 });
    await db.query(`update approvals set created_at = created_at - interval '3 days' where approval_number = $1`, [p.approval_number]);
    expect((await status()).approvals).toMatchObject({ state: 'attention', count: 1 });
  });

  it('the staff dispatch queue: a fresh request is info, one nobody picked up for 5 minutes is a problem, a picked-up one clears', async () => {
    const p = (await one(`select approval_number, payload_hash from approvals where business_reference = 'PRJ-2026-0004' and status = 'PENDING'`)) as { approval_number: string; payload_hash: string };
    const d = await call('select web_invoice_decide($1, $2, $3, $4, null) r', [tok.admin, p.approval_number, p.payload_hash, 'approve']);
    expect(d).toMatchObject({ ok: true, outcome: 'APPROVED' });
    const st = await status();
    expect(st.approvals).toMatchObject({ state: 'ok', count: 0 });
    expect(st.xero_queue).toMatchObject({ state: 'info', count: 1 });
    await db.query(`update xero_dispatch_requests set requested_at = requested_at - interval '10 minutes' where xero_key = $1`, [d.xero_key]);
    expect((await status()).xero_queue).toMatchObject({ state: 'problem', count: 1 });
    expect(((await asWorkflow(`select wf_xero_dispatch_next('n8n:09:test') r`, [])).writes as R[])[0]).toMatchObject({ xero_key: d.xero_key });
    expect((await status()).xero_queue).toMatchObject({ state: 'ok', count: 0 });
  });

  it('a creation that never reported back is stuck; an ambiguous one is uncertain; both are problems', async () => {
    const key = String((await one(`select xero_key from xero_dispatch_requests order by requested_at desc limit 1`)).xero_key);
    expect(await asWorkflow(`select wf_claim_side_effect($1, 'n8n:05', 120) r`, [key])).toMatchObject({ claimed: true });
    await db.query(`update outbox set locked_until = now() - interval '1 minute' where idempotency_key = $1`, [key]);
    expect((await status()).xero_stuck).toMatchObject({ state: 'problem', count: 1 });
    await db.query(`update outbox set locked_until = now() + interval '2 minutes' where idempotency_key = $1`, [key]);
    expect(await asWorkflow(`select wf_fail_side_effect($1, $2, $3, $4, 0) r`, [key, 'TIMEOUT', 'create draft invoice: ETIMEDOUT after 20s', null])).toMatchObject({ retry: true });
    const st = await status();
    expect(st.xero_stuck).toMatchObject({ state: 'ok', count: 0 });
    expect(st.xero_uncertain).toMatchObject({ state: 'problem', count: 1 });
  });
});

/** Real concurrency on Postgres: separate connections act at the same instant; every financial effect happens once. */
describe.runIf(TARGETS.includes('postgres'))('staff invoice and dispatch under real concurrency [postgres]', () => {
  let db: Db & { url?: string };
  const tok: Record<string, string> = {};
  const one = async (c: Db, sql: string, p: unknown[] = []) => (await c.query<R>(sql, p))[0]!;
  const call = async (c: Db, sql: string, p: unknown[]) => (await one(c, sql, p)).r as R;
  const asWorkflow = async (c: Db, sql: string, p: unknown[]) => {
    await c.exec('set role roofops_workflow');
    try { return await call(c, sql, p); } finally { await c.exec('reset role'); }
  };
  const twoConnections = async <T>(fn: (a: Db, b: Db) => Promise<T>) => {
    const [a, b] = [await openPostgres(db.url!), await openPostgres(db.url!)];
    try { return await fn(a, b); } finally { await a.close(); await b.close(); }
  };

  beforeAll(async () => {
    db = await migratedDb('postgres');
    await importBundle(db);
    await db.query(`update app_settings set value = $1 where key = 'xero.demo_tenant_id'`, [TENANT]);
    await db.query(`insert into employees (employee_code, full_name, email, role, is_active) values
      ('EMP-801', 'Synthetic Finance Requester', 'f@example.test', 'FINANCE', true), ('EMP-802', 'Synthetic Admin Approver', 'a@example.test', 'ADMIN', true),
      ('EMP-804', 'Synthetic Second Approver', 's@example.test', 'FINANCE', true)`);
    for (const [emp, login] of [['EMP-801', 'finance'], ['EMP-802', 'admin'], ['EMP-804', 'second']] as const) {
      expect(await call(db, 'select ops_staff_set_password($1, $2, $3) r', [emp, login, PW])).toMatchObject({ ok: true });
      tok[login] = String((await call(db, 'select web_staff_sign_in($1, $2) r', [login, PW])).token);
    }
  }, 180_000);
  afterAll(async () => { await db.close(); });

  it('two people preparing the same project at once: one preview', async () => {
    const rs = await twoConnections((a, b) => Promise.all([
      call(a, 'select web_invoice_prepare($1, $2) r', [tok.finance, 'PRJ-2026-0004']),
      call(b, 'select web_invoice_prepare($1, $2) r', [tok.finance, 'PRJ-2026-0004'])]));
    expect(rs.map((r) => r.outcome).sort()).toEqual(['ALREADY_PENDING', 'PREVIEW_READY']);
    expect(rs[0].approval_number).toBe(rs[1].approval_number);
    expect(await one(db, `select count(*)::int n from approvals where business_reference = 'PRJ-2026-0004' and action_type = 'CREATE_INVOICE'`)).toEqual({ n: 1 });
  });

  it('two different approvers deciding the same preview at once: one approval, one invoice, one Xero write, one request', async () => {
    const p = (await one(db, `select approval_number, payload_hash from approvals where business_reference = 'PRJ-2026-0004' and status = 'PENDING'`)) as { approval_number: string; payload_hash: string };
    const rs = await twoConnections((a, b) => Promise.all([
      call(a, 'select web_invoice_decide($1, $2, $3, $4, null) r', [tok.admin, p.approval_number, p.payload_hash, 'approve']),
      call(b, 'select web_invoice_decide($1, $2, $3, $4, null) r', [tok.second, p.approval_number, p.payload_hash, 'approve'])]));
    expect(rs.filter((r) => r.outcome === 'APPROVED')).toHaveLength(1);
    expect(rs.filter((r) => r.outcome !== 'APPROVED')[0]).toMatchObject({ ok: false, code: 'ALREADY_PROCESSED' });
    expect(await one(db, `select (select count(*)::int from invoices i join projects p on p.id = i.project_id where p.project_number = 'PRJ-2026-0004' and i.invoice_type = 'FINAL') finals,
        (select count(*)::int from outbox o join invoices i on i.id = o.aggregate_id join projects p on p.id = i.project_id where p.project_number = 'PRJ-2026-0004' and o.topic = 'xero.create_draft_invoice') writes,
        (select count(*)::int from xero_dispatch_requests r join invoices i on i.id = r.invoice_id join projects p on p.id = i.project_id where p.project_number = 'PRJ-2026-0004') requests`))
      .toEqual({ finals: 1, writes: 1, requests: 1 });
  });

  it('two pollers at once: exactly one hands the write to 05', async () => {
    const rs = await twoConnections((a, b) => Promise.all([
      asWorkflow(a, `select wf_xero_dispatch_next('n8n:09:a') r`, []), asWorkflow(b, `select wf_xero_dispatch_next('n8n:09:b') r`, [])]));
    expect(rs.map((r) => (r.writes as R[]).length).sort()).toEqual([0, 1]);
    expect(await one(db, `select count(*)::int n from xero_dispatch_requests where status = 'CLAIMED'`)).toEqual({ n: 1 });
  });

  it('two "send again" requests at once after a failure: one queued, one told it is already waiting', async () => {
    const key = String((await one(db, `select xero_key from xero_dispatch_requests where status = 'CLAIMED'`)).xero_key);
    expect(await call(db, `select wf_claim_side_effect($1, 'n8n:05', 120) r`, [key])).toMatchObject({ claimed: true });
    expect(await call(db, `select wf_fail_side_effect($1, $2, $3, $4, 0) r`, [key, 'NETWORK', 'search by invoice number: ECONNRESET', null])).toMatchObject({ retry: true });
    await db.query(`update outbox set next_attempt_at = now() - interval '1 second' where idempotency_key = $1`, [key]);
    const inv = String((await one(db, `select i.invoice_number from invoices i join outbox o on o.aggregate_id = i.id where o.idempotency_key = $1`, [key])).invoice_number);
    const sha = String((await one(db, `select xero_payload_sha256(payload) s from outbox where idempotency_key = $1`, [key])).s);
    const rs = await twoConnections((a, b) => Promise.all([
      call(a, 'select web_xero_dispatch_request($1, $2, $3, $4) r', [tok.finance, inv, 1, sha]),
      call(b, 'select web_xero_dispatch_request($1, $2, $3, $4) r', [tok.admin, inv, 1, sha])]));
    expect(rs.map((r) => r.code).sort()).toEqual(['ALREADY_QUEUED', 'QUEUED']);
    expect(await one(db, `select count(*)::int n from xero_dispatch_requests where xero_key = $1 and status = 'QUEUED'`, [key])).toEqual({ n: 1 });
  });
});
