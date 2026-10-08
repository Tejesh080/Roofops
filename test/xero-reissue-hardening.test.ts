/**
 * AC-14C hardening (independent audit, P2-H1 / P2-H2).
 *
 * H1: the VOIDED -> APPROVED guard accepted a merely PENDING reissue approval, so privileged raw SQL could move a voided
 *     final invoice back to APPROVED with no replacement generation opened (and the approval never consumed). The only
 *     valid recovery path is the ops_reissue_decide transaction: approval EXECUTING with its consumption claim in
 *     progress, the predecessor generation SUPERSEDED, and the next generation's ledger row and draft write queued and
 *     bound to that approval.
 * H2: generation 2's draft payload was copied from the previous generation, not generated from the approved reissue
 *     preview. The draft is now generated deterministically from canonical invoice state inside the hashed preview, and
 *     the queued payload is exactly that approved draft.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TARGETS } from './helpers/db.js';
import { voidedReissueScenario, deletedReissueScenario, type ReissueScenario, type ScenarioTarget } from './helpers/reissue-scenario.js';

type R = Record<string, unknown>;
const FINANCE = 'EMP-900';
const REASON = 'Customer asked for the voided final to be reissued unchanged';

describe.each(TARGETS)('AC-14C hardening: reissue only through ops_reissue_decide; the draft is the approved preview [%s]', (t) => {
  const target = t as ScenarioTarget;                                   // TARGETS never includes 'hosted' here (mutating tests)
  let s: ReissueScenario | null = null;
  afterEach(async () => { await s?.close(); s = null; });
  const q = async (sql: string, p: unknown[] = []) => (await s!.db.query<R>(sql, p));
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0]!;
  const force = async (sql: string, p: unknown[] = []) => {
    await s!.db.exec(`set session_replication_role = replica`);
    try { await s!.db.query(sql, p); } finally { await s!.db.exec(`set session_replication_role = origin`).catch(() => undefined); }
  };
  const transition = (approval: string) => q(`update invoices set status = 'APPROVED', sync_status = 'PENDING',
      approval_id = (select id from approvals where approval_number = $2) where id = $1`, [s!.invoice.id, approval]);
  const approval = async (n: string) => one(`select status from approvals where approval_number = $1`, [n]);

  describe('H1: VOIDED -> APPROVED happens only inside ops_reissue_decide', () => {
    it('a raw UPDATE carrying a valid PENDING reissue approval is refused: no generation, the approval untouched', async () => {
      s = await voidedReissueScenario(target);
      const r = await s.request(FINANCE, REASON);
      expect(r).toMatchObject({ ok: true });
      await expect(transition(String(r.approval_number))).rejects.toThrow(/only ops_reissue_decide/);
      expect(await s.state()).toMatchObject({ status: 'VOIDED' });
      expect(await s.ledger()).toHaveLength(1);
      expect(await approval(String(r.approval_number))).toMatchObject({ status: 'PENDING' });
      // ... and the supported decision still works on the same request.
      expect(await s.decide(String(r.approval_number), FINANCE)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED', generation: 2 });
    });

    it('a forged EXECUTING approval without the replacement generation is refused', async () => {
      s = await deletedReissueScenario(target);
      const r = await s.request(FINANCE, REASON);
      await force(`update approvals set status = 'EXECUTING', decided_at = now(), decided_by = (select id from employees where employee_code = $2) where approval_number = $1`,
        [String(r.approval_number), FINANCE]);
      await expect(transition(String(r.approval_number))).rejects.toThrow(/only ops_reissue_decide/);
      expect(await s.state()).toMatchObject({ status: 'VOIDED' });
    });

    it('a forged generation 2 is refused unless it is the decide transaction itself: no draft write, not bound to the approval, or the approval not being consumed', async () => {
      s = await voidedReissueScenario(target);
      const r = await s.request(FINANCE, REASON);
      const apr = String(r.approval_number);
      await force(`update approvals set status = 'EXECUTING', decided_at = now(), decided_by = (select id from employees where employee_code = $2) where approval_number = $1`, [apr, FINANCE]);
      await force(`insert into processed_events (consumer, idempotency_key, first_event_id, status, request_hash, locked_by, lease_expires_at)
                   values ('invoice.reissue:' || $1, $1, (select event_id from automation_events limit 1), 'PROCESSING', 'x', 'raw sql', now() + interval '5 minutes')`, [apr]);
      await force(`update invoice_xero_draft_generations set status = 'SUPERSEDED', superseded_at = now() where invoice_id = $1 and generation = 1`, [s.invoice.id]);
      await force(`insert into invoice_xero_draft_generations (invoice_id, generation, status, outbox_idempotency_key, approval_id, opened_by)
                   values ($1, 2, 'PENDING', xero_draft_outbox_key($1, 2), (select id from approvals where approval_number = $2), 'raw sql')`, [s.invoice.id, apr]);
      await expect(transition(apr)).rejects.toThrow(/only ops_reissue_decide/);                       // no draft write queued
      await force(`update invoice_xero_draft_generations set approval_id = null where invoice_id = $1 and generation = 2`, [s.invoice.id]);
      await force(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, generation)
                   select 'xero.create_draft_invoice', 'invoice', $1, correlation_id, xero_draft_outbox_key($1, 2),
                          payload || jsonb_build_object('generation', 2, 'approval_number', $2::text), 2
                     from outbox where idempotency_key = xero_draft_outbox_key($1, 1)`, [s.invoice.id, apr]);
      await expect(transition(apr)).rejects.toThrow(/only ops_reissue_decide/);                       // generation not bound to this approval
      await force(`update invoice_xero_draft_generations set approval_id = (select id from approvals where approval_number = $2) where invoice_id = $1 and generation = 2`, [s.invoice.id, apr]);
      await force(`delete from processed_events where consumer = 'invoice.reissue:' || $1`, [apr]);
      await expect(transition(apr)).rejects.toThrow(/only ops_reissue_decide/);                       // the approval is not being consumed by a decision
      await force(`insert into processed_events (consumer, idempotency_key, first_event_id, status, request_hash, locked_by, lease_expires_at, completed_at, result)
                   values ('invoice.reissue:' || $1, $1, (select event_id from automation_events limit 1), 'COMPLETED', 'x', 'raw sql', null, now(), '{}')`, [apr]);
      await expect(transition(apr)).rejects.toThrow(/only ops_reissue_decide/);                       // ... nor by one that already finished
      await force(`update processed_events set status = 'PROCESSING', completed_at = null, result = null, lease_expires_at = now() + interval '5 minutes'
                   where consumer = 'invoice.reissue:' || $1`, [apr]);
      await force(`update approvals set status = 'PENDING', decided_at = null, decided_by = null where approval_number = $1`, [apr]);
      await expect(transition(apr)).rejects.toThrow(/only ops_reissue_decide/);                       // every artefact but the approval was never decided
      expect(await s.state()).toMatchObject({ status: 'VOIDED' });
    });

    it('an APPROVED (or already EXECUTED) reissue approval no longer authorises a raw transition', async () => {
      s = await voidedReissueScenario(target);
      const r = await s.request(FINANCE, REASON);
      for (const st of ['APPROVED', 'EXECUTED']) {
        await force(`update approvals set status = $2, decided_at = now(), decided_by = (select id from employees where employee_code = 'EMP-900'),
                     executed_at = case when $2 = 'EXECUTED' then now() end, execution_result = case when $2 = 'EXECUTED' then '{}'::jsonb end
                     where approval_number = $1`, [String(r.approval_number), st]);
        await expect(transition(String(r.approval_number))).rejects.toThrow(/only ops_reissue_decide/);
      }
      expect(await s.state()).toMatchObject({ status: 'VOIDED' });
    });

    it('the supported decision is unchanged: one transaction, generation 2 queued, the approval EXECUTED, a replay refused', async () => {
      s = await deletedReissueScenario(target);
      const r = await s.request(FINANCE, REASON);
      const d = await s.decide(String(r.approval_number), FINANCE);
      expect(d).toMatchObject({ ok: true, code: 'REISSUE_QUEUED', generation: 2, superseded_generation: 1 });
      expect(await s.state()).toMatchObject({ status: 'APPROVED', sync_status: 'PENDING' });
      expect(await approval(String(r.approval_number))).toMatchObject({ status: 'EXECUTED' });
      expect((await s.ledger()).map((g) => [g.generation, g.status])).toEqual([[1, 'SUPERSEDED'], [2, 'PENDING']]);
      expect(await s.decide(String(r.approval_number), FINANCE)).toMatchObject({ ok: false, code: 'ALREADY_PROCESSED' });
      expect(await s.integrityFails()).toEqual([]);
    });

    it('integrity: an invoice put back to APPROVED on a reissue approval without its bound generation is a FAIL', async () => {
      s = await voidedReissueScenario(target);
      const r = await s.request(FINANCE, REASON);
      await force(`update invoices set status = 'APPROVED', sync_status = 'PENDING', approval_id = (select id from approvals where approval_number = $2) where id = $1`,
        [s.invoice.id, String(r.approval_number)]);
      expect(await s.integrityFails()).toContain('reissue_transition_bound');
    });
  });
});
