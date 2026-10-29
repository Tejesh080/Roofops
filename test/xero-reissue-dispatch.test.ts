/**
 * AC-14C follow-up, audit P2-D1 and the release gate: a queued generation-2 xero.create_draft_invoice write had no
 * supported dispatcher, and the first dispatcher sent every due reissue at once.
 *
 * wf_reissue_dispatch(token, invoice_number, generation) (the workflow role, behind the operator token like 07's
 * reconcile trigger) lists at most the ONE write the operator selected, and only when it is the invoice's current
 * generation >= 2, due and proven: the live ledger row bound to an EXECUTED reissue approval, the payload containing
 * that approval's draft under its hash, the predecessor generation superseded and the invoice APPROVED on that approval.
 * No selection, generation 1, a generation that is not current, a write that is not due or an unproven write list
 * nothing. n8n 08 runs the unchanged 05 sub-workflow for that one write (as 04 does for a first issue); another queued
 * reissue is never listed, so it cannot be dispatched by accident.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TARGETS } from './helpers/db.js';
import { deletedReissueScenario, voidedReissueScenario, type ReissueScenario, type ScenarioTarget } from './helpers/reissue-scenario.js';
import { recorded } from './helpers/n8n-sdk-shim.js';
import { N8nRun } from './helpers/n8n-runner.js';

type R = Record<string, unknown>;
const FINANCE = 'EMP-900';
const REASON = 'Customer asked for the voided final to be reissued unchanged';
const TOKEN = 'test-reissue-dispatch-token';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe.each(TARGETS)('AC-14C P2-D1: generation-2 dispatch of one selected write [%s]', (t) => {
  const target = t as ScenarioTarget;
  let s: ReissueScenario | null = null;
  afterEach(async () => { await s?.close(); s = null; });
  const q = async (sql: string, p: unknown[] = []) => s!.db.query<R>(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0]!;
  const force = async (sql: string, p: unknown[] = []) => {
    await s!.db.exec(`set session_replication_role = replica`);
    try { await s!.db.query(sql, p); } finally { await s!.db.exec(`set session_replication_role = origin`).catch(() => undefined); }
  };
  const dispatch = async (token: string | null, invoice: string | null = s!.invoice.number, generation: number | null = 2) =>
    (await one(`select wf_reissue_dispatch($1, $2, $3, 'test') d`, [token, invoice, generation])).d as R;
  const reissue = async (sc: ReissueScenario) => {
    const r = await sc.request(FINANCE, REASON);
    expect(await sc.decide(String(r.approval_number), FINANCE)).toMatchObject({ ok: true, generation: 2 });
    return (await sc.db.query<{ k: string }>(`select xero_draft_outbox_key($1, 2) k`, [sc.invoice.id]))[0]!.k;
  };
  const reissued = async (build = deletedReissueScenario) => {
    s = await build(target);
    await q(`update app_settings set value = $1 where key = 'reissue.dispatch_token_sha256'`, [sha(TOKEN)]);
    return reissue(s);
  };
  const run08 = async (body: R, token = TOKEN) => {
    const r = new N8nRun(recorded.nodes, recorded.edges, { db: s!.db, http: () => { throw new Error('08 makes no HTTP call itself'); } });
    await r.run('Read Request', [{ json: { headers: { 'x-roofops-token': token }, body } }], ['Run Xero Draft Invoice']);
    return r.out.get('Reissue Writes To Dispatch')!.map((i) => i.json);
  };

  beforeAll(async () => {
    const sdk = '../n8n/08-reissue-dispatch.sdk.ts';                               // a variable: typecheck does not follow it into n8n's SDK
    await import(/* @vite-ignore */ sdk);
  });

  it('the operator token is required: none configured, a wrong one, or none given are refused', async () => {
    const key = await reissued();
    await q(`update app_settings set value = '' where key = 'reissue.dispatch_token_sha256'`);
    expect(await dispatch(TOKEN)).toMatchObject({ ok: false, code: 'TOKEN_REFUSED', writes: [] });
    await q(`update app_settings set value = $1 where key = 'reissue.dispatch_token_sha256'`, [sha(TOKEN)]);
    expect(await dispatch('wrong')).toMatchObject({ ok: false, code: 'TOKEN_REFUSED', writes: [] });
    expect(await dispatch(null)).toMatchObject({ ok: false, code: 'TOKEN_REFUSED', writes: [] });
    expect(await dispatch(TOKEN)).toMatchObject({ ok: true, writes: [{ xero_key: key, generation: 2, invoice_number: s!.invoice.number }] });
  });

  it('a dispatch must name one invoice and its current generation >= 2; anything else lists nothing; a repeat is the same answer', async () => {
    const key = await reissued(voidedReissueScenario);
    const d = await dispatch(TOKEN);
    expect(d).toMatchObject({ ok: true, selection: { invoice_number: s!.invoice.number, generation: 2 } });
    expect((d.writes as R[]).map((w) => w.xero_key)).toEqual([key]);
    expect(await dispatch(TOKEN)).toEqual(d);                                            // a pure read: repeated, the same
    for (const [inv, gen, code] of [[null, 2, 'SELECTION_REQUIRED'], ['', 2, 'SELECTION_REQUIRED'], [s!.invoice.number, null, 'SELECTION_REQUIRED'],
                                    [s!.invoice.number, 1, 'NOT_A_REISSUE'], [s!.invoice.number, 3, 'NOT_CURRENT_GENERATION'],
                                    ['INV-2099-9999', 2, 'NOT_FOUND']] as const) {
      expect([inv, gen, await dispatch(TOKEN, inv, gen)]).toEqual([inv, gen, expect.objectContaining({ ok: false, code, writes: [] })]);
    }
    // A due generation-1 write is 04's to dispatch, never 08's (forced: generation 2 done, generation 1 pending again).
    await force(`update outbox set status = 'DONE' where idempotency_key = $1`, [key]);
    await force(`update outbox set status = 'PENDING', next_attempt_at = now() where idempotency_key = xero_draft_outbox_key($1, 1)`, [s!.invoice.id]);
    expect(await dispatch(TOKEN, s!.invoice.number, 1)).toMatchObject({ ok: false, code: 'NOT_A_REISSUE', writes: [] });
    expect(await dispatch(TOKEN)).toMatchObject({ ok: false, code: 'NOT_DUE', writes: [] });
  });

  it('another queued reissue is never listed: selecting A lists only A, and 08 runs 05 for A alone while B stays untouched', async () => {
    const keyA = await reissued();
    const b = await voidedReissueScenario(s!.db, { project: 'PRJ-2026-0005', xid: 'aaaaaaaa-bbbb-cccc-dddd-0000000000a5' });
    const keyB = await reissue(b);
    // Both are due and proven: each can be dispatched, but only when it is the one named.
    expect((await dispatch(TOKEN, s!.invoice.number, 2)).writes).toEqual([{ xero_key: keyA, invoice_number: s!.invoice.number, generation: 2 }]);
    expect((await dispatch(TOKEN, b.invoice.number, 2)).writes).toEqual([{ xero_key: keyB, invoice_number: b.invoice.number, generation: 2 }]);
    // 08 (real nodes) with A selected hands exactly A's write to 05; with no selection, nothing.
    expect(await run08({ invoice_number: s!.invoice.number, generation: 2 })).toEqual([{ xero_key: keyA, invoice_number: s!.invoice.number, generation: 2, dispatched_by: 'reissue-dispatch' }]);
    expect(await run08({})).toEqual([expect.objectContaining({ none: true, refused: true, code: 'SELECTION_REQUIRED' })]);
    expect(await run08({ invoice_number: s!.invoice.number })).toEqual([expect.objectContaining({ none: true, code: 'SELECTION_REQUIRED' })]);
    expect(await run08({ invoice_number: s!.invoice.number, generation: 'all' })).toEqual([expect.objectContaining({ none: true, code: 'SELECTION_REQUIRED' })]);
    // 05 claims what 08 handed it: A moves, B is never claimed.
    expect((await one(`select wf_claim_side_effect($1, 'n8n:05', 120) c`, [keyA])).c).toMatchObject({ claimed: true, generation: 2 });
    expect(await one(`select status, attempts from outbox where idempotency_key = $1`, [keyA])).toMatchObject({ status: 'DISPATCHING', attempts: 1 });
    expect(await one(`select status, attempts from outbox where idempotency_key = $1`, [keyB])).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(await b.link()).toBe('aaaaaaaa-bbbb-cccc-dddd-0000000000a5');
    // A in flight is no longer due; selecting it again lists nothing, and B still needs its own selection.
    expect(await dispatch(TOKEN, s!.invoice.number, 2)).toMatchObject({ ok: false, code: 'NOT_DUE', writes: [] });
    expect(await run08({ invoice_number: s!.invoice.number, generation: 2 })).toEqual([expect.objectContaining({ none: true, code: 'NOT_DUE' })]);
  }, 180_000);

  it('an unproven selected write is refused with the reason and nothing listed (tampered payload, approval not executed)', async () => {
    const key = await reissued();
    await force(`update outbox set payload = jsonb_set(payload, '{amount_inc_gst}', to_jsonb((payload ->> 'amount_inc_gst')::numeric + 1)) where idempotency_key = $1`, [key]);
    expect(await dispatch(TOKEN)).toMatchObject({ ok: false, code: 'REISSUE_NOT_PROVEN', writes: [], problem: expect.stringMatching(/not the approved draft/) as unknown });
    await force(`update outbox set payload = jsonb_set(payload, '{amount_inc_gst}', to_jsonb((payload ->> 'amount_inc_gst')::numeric - 1)) where idempotency_key = $1`, [key]);
    expect((await dispatch(TOKEN)).writes).toHaveLength(1);
    await force(`update approvals set status = 'EXECUTING' where id = (select approval_id from invoices where id = $1)`, [s!.invoice.id]);
    expect(await dispatch(TOKEN)).toMatchObject({ ok: false, code: 'REISSUE_NOT_PROVEN', writes: [], problem: expect.stringMatching(/executed reissue approval/) as unknown });
  });

  it('write states: DISPATCHING, DONE and a dead letter are not due; a retry that is due is; one not yet due is not', async () => {
    const key = await reissued();
    for (const [st, next, listed] of [['DISPATCHING', 'now()', false], ['DONE', 'now()', false], ['FAILED', `'infinity'`, false],
                                      ['FAILED', `now() - interval '1 minute'`, true], ['PENDING', `now() + interval '1 hour'`, false], ['PENDING', 'now()', true]] as const) {
      await force(`update outbox set status = '${st}', next_attempt_at = ${next} where idempotency_key = $1`, [key]);
      const d = await dispatch(TOKEN);
      expect([st, next, (d.writes as R[]).length, d.code ?? null]).toEqual([st, next, listed ? 1 : 0, listed ? null : 'NOT_DUE']);
    }
  });

  it('privileges: the workflow role may run wf_reissue_dispatch; the dashboard role may not; the proof is owner-only; no unselected form remains', async () => {
    s = await voidedReissueScenario(target);
    const g = await one(`select has_function_privilege('roofops_workflow', 'wf_reissue_dispatch(text,text,integer,text)', 'execute') wf,
        has_function_privilege('roofops_dashboard', 'wf_reissue_dispatch(text,text,integer,text)', 'execute') dash,
        has_function_privilege('roofops_workflow', 'xero_reissue_proof(outbox)', 'execute') proof_wf,
        to_regprocedure('wf_reissue_dispatch(text,text)') is null old_form_gone,
        (select count(*)::int from pg_proc where proname = 'wf_reissue_dispatch') forms`);
    expect(g).toEqual({ wf: true, dash: false, proof_wf: false, old_form_gone: true, forms: 1 });
  });

  it('n8n 08 (real nodes): token from the header, selection from the body, then one 05 run; a refused token runs nothing', async () => {
    const key = await reissued();
    expect((await run08({ invoice_number: s!.invoice.number, generation: 2 })).map((i) => i.xero_key)).toEqual([key]);
    expect(recorded.edges).toEqual(expect.arrayContaining([{ from: 'Any Reissue Writes?', branch: 'true', to: 'Run Xero Draft Invoice' }]));
    expect((recorded.nodes.get('Run Xero Draft Invoice')!.config.parameters as R).workflowId).toMatchObject({ value: 'Y2deCFTZzpv1uo8C' });   // the same 05 that 04 runs
    expect(await run08({ invoice_number: s!.invoice.number, generation: 2 }, 'wrong')).toEqual([expect.objectContaining({ none: true, code: 'TOKEN_REFUSED' })]);
  });
});
