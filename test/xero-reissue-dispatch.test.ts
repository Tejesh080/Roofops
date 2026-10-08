/**
 * AC-14C follow-up, audit P2-D1: a queued generation-2 xero.create_draft_invoice write had no supported dispatcher.
 *
 * wf_reissue_dispatch(token) (the workflow role, behind the operator token like 07's reconcile trigger) lists exactly
 * the generation >= 2 draft writes that are due and proven: the live ledger row bound to an EXECUTED reissue approval,
 * the payload containing that approval's draft under its hash, the predecessor generation superseded and the invoice
 * APPROVED on that approval. n8n 08 runs the unchanged 05 sub-workflow for each one (as 04 does for a first issue).
 * Generation 1 is never dispatched here; an unproven write is reported, never dispatched.
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

describe.each(TARGETS)('AC-14C P2-D1: generation-2 dispatch [%s]', (t) => {
  const target = t as ScenarioTarget;
  let s: ReissueScenario | null = null;
  afterEach(async () => { await s?.close(); s = null; });
  const q = async (sql: string, p: unknown[] = []) => s!.db.query<R>(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0]!;
  const force = async (sql: string, p: unknown[] = []) => {
    await s!.db.exec(`set session_replication_role = replica`);
    try { await s!.db.query(sql, p); } finally { await s!.db.exec(`set session_replication_role = origin`).catch(() => undefined); }
  };
  const dispatch = async (token: string | null) => (await one(`select wf_reissue_dispatch($1, 'test') d`, [token])).d as R;
  const reissued = async (build = deletedReissueScenario) => {
    s = await build(target);
    await q(`update app_settings set value = $1 where key = 'reissue.dispatch_token_sha256'`, [sha(TOKEN)]);
    const r = await s.request(FINANCE, REASON);
    expect(await s.decide(String(r.approval_number), FINANCE)).toMatchObject({ ok: true, generation: 2 });
    return (await one(`select xero_draft_outbox_key($1, 2) k`, [s.invoice.id])).k as string;
  };

  beforeAll(async () => {
    const sdk = '../n8n/08-reissue-dispatch.sdk.ts';                               // a variable: typecheck does not follow it into n8n's SDK
    await import(/* @vite-ignore */ sdk);
  });

  it('the operator token is required: none configured, a wrong one, or none given are refused', async () => {
    const key = await reissued();
    await q(`update app_settings set value = '' where key = 'reissue.dispatch_token_sha256'`);
    expect(await dispatch(TOKEN)).toMatchObject({ ok: false, code: 'TOKEN_REFUSED' });
    await q(`update app_settings set value = $1 where key = 'reissue.dispatch_token_sha256'`, [sha(TOKEN)]);
    expect(await dispatch('wrong')).toMatchObject({ ok: false, code: 'TOKEN_REFUSED' });
    expect(await dispatch(null)).toMatchObject({ ok: false, code: 'TOKEN_REFUSED' });
    expect(await dispatch(TOKEN)).toMatchObject({ ok: true, writes: [{ xero_key: key, generation: 2, invoice_number: s!.invoice.number }] });
  });

  it('only proven, due generation >= 2 writes are listed; generation 1 never is; a repeat is the same answer', async () => {
    const key = await reissued(voidedReissueScenario);
    const d = await dispatch(TOKEN);
    expect((d.writes as R[]).map((w) => w.xero_key)).toEqual([key]);
    expect((d.writes as R[]).every((w) => Number(w.generation) >= 2)).toBe(true);
    expect(await dispatch(TOKEN)).toEqual(d);                                            // a pure read: repeated, the same
    // A due generation-1 write is 04's to dispatch, never 08's (forced: generation 2 done, generation 1 pending again).
    await force(`update outbox set status = 'DONE' where idempotency_key = $1`, [key]);
    await force(`update outbox set status = 'PENDING', next_attempt_at = now() where idempotency_key = xero_draft_outbox_key($1, 1)`, [s!.invoice.id]);
    expect(await dispatch(TOKEN)).toMatchObject({ ok: true, writes: [], unproven: [] });
  });

  it('an unproven generation-2 write is reported, never dispatched (tampered payload, approval not executed, predecessor live)', async () => {
    const key = await reissued();
    await force(`update outbox set payload = jsonb_set(payload, '{amount_inc_gst}', to_jsonb((payload ->> 'amount_inc_gst')::numeric + 1)) where idempotency_key = $1`, [key]);
    let d = await dispatch(TOKEN);
    expect(d.writes).toEqual([]);
    expect(d.unproven).toEqual([expect.objectContaining({ xero_key: key, problem: expect.stringMatching(/not the approved draft/) as unknown })]);
    await force(`update outbox set payload = jsonb_set(payload, '{amount_inc_gst}', to_jsonb((payload ->> 'amount_inc_gst')::numeric - 1)) where idempotency_key = $1`, [key]);
    expect((await dispatch(TOKEN)).writes).toHaveLength(1);
    await force(`update approvals set status = 'EXECUTING' where id = (select approval_id from invoices where id = $1)`, [s!.invoice.id]);
    d = await dispatch(TOKEN);
    expect(d.writes).toEqual([]);
    expect(d.unproven).toEqual([expect.objectContaining({ problem: expect.stringMatching(/executed reissue approval/) as unknown })]);
  });

  it('write states: DISPATCHING, DONE and a dead letter are not listed; a retry that is due is; one not yet due is not', async () => {
    const key = await reissued();
    for (const [st, next, listed] of [['DISPATCHING', 'now()', false], ['DONE', 'now()', false], ['FAILED', `'infinity'`, false],
                                      ['FAILED', `now() - interval '1 minute'`, true], ['PENDING', `now() + interval '1 hour'`, false], ['PENDING', 'now()', true]] as const) {
      await force(`update outbox set status = '${st}', next_attempt_at = ${next} where idempotency_key = $1`, [key]);
      expect([st, next, ((await dispatch(TOKEN)).writes as R[]).length]).toEqual([st, next, listed ? 1 : 0]);
    }
  });

  it('privileges: the workflow role may run wf_reissue_dispatch; the dashboard role may not; the proof is owner-only', async () => {
    s = await voidedReissueScenario(target);
    const g = await one(`select has_function_privilege('roofops_workflow', 'wf_reissue_dispatch(text,text)', 'execute') wf,
        has_function_privilege('roofops_dashboard', 'wf_reissue_dispatch(text,text)', 'execute') dash,
        has_function_privilege('roofops_workflow', 'xero_reissue_proof(outbox)', 'execute') proof_wf`);
    expect(g).toEqual({ wf: true, dash: false, proof_wf: false });
  });

  it('n8n 08 (real nodes): the token from the request header, then one 05 run per listed write; a refused token runs nothing', async () => {
    const key = await reissued();
    const run = async (token: string) => {
      const r = new N8nRun(recorded.nodes, recorded.edges, { db: s!.db, http: () => { throw new Error('08 makes no HTTP call itself'); } });
      await r.run('Read Request', [{ json: { headers: { 'x-roofops-token': token }, body: {} } }], ['Run Xero Draft Invoice']);
      return r;
    };
    const ok = await run(TOKEN);
    const toRun = ok.out.get('Reissue Writes To Dispatch')!;
    expect(toRun.map((i) => i.json.xero_key)).toEqual([key]);
    expect(recorded.edges).toEqual(expect.arrayContaining([{ from: 'Any Reissue Writes?', branch: 'true', to: 'Run Xero Draft Invoice' }]));
    expect((recorded.nodes.get('Run Xero Draft Invoice')!.config.parameters as R).workflowId).toMatchObject({ value: 'Y2deCFTZzpv1uo8C' })                     // the same 05 that 04 runs;
    const refused = await run('wrong');
    expect(refused.out.get('Reissue Writes To Dispatch')![0]!.json).toMatchObject({ none: true });
  });
});
