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

    it('integrity: an invoice put back to APPROVED on a reissue approval without its bound generation is a FAIL (see H2 below too)', async () => {
      s = await voidedReissueScenario(target);
      const r = await s.request(FINANCE, REASON);
      await force(`update invoices set status = 'APPROVED', sync_status = 'PENDING', approval_id = (select id from approvals where approval_number = $2) where id = $1`,
        [s.invoice.id, String(r.approval_number)]);
      expect(await s.integrityFails()).toContain('reissue_transition_bound');
    });
  });

  describe('H2: generation 2 is the approved preview, generated from canonical truth, never copied from generation 1', () => {
    const gen = async (g: number) => one(`select payload from outbox where idempotency_key = xero_draft_outbox_key($1, $2)`, [s!.invoice.id, g]).then((r) => r.payload as R);
    const ledgerRow = async (g: number) => one(`select generation, xero_invoice_id, xero_invoice_number, tenant_id, outbox_idempotency_key, approval_id
        from invoice_xero_draft_generations where invoice_id = $1 and generation = $2`, [s!.invoice.id, g]);
    /** A legitimate canonical change after generation 1: the customer's contact details and the invoice line (price too). */
    const changeCanonical = async (suffix = '', contactOnly = false) => {
      await q(`update customers set display_name = 'Ella Thompson-Reid' || $2, email = 'ella.reid@example.com' where id = (select customer_id from invoices where id = $1)`, [s!.invoice.id, suffix]);
      if (contactOnly) return;
      await q(`update invoice_lines set description = 'Final invoice, reissued: corrected scope' || $2, unit_price = unit_price - 100 where invoice_id = $1 and line_no = 1`, [s!.invoice.id, suffix]);
    };

    it('generation 1 is built by the same canonical builder: its payload contains xero_draft_payload exactly', async () => {
      s = await voidedReissueScenario(target);
      expect((await one(`select o.payload @> xero_draft_payload(o.aggregate_id, o.payload ->> 'xero_tenant_id') ok from outbox o
                          where o.idempotency_key = xero_draft_outbox_key($1, 1)`, [s.invoice.id])).ok).toBe(true);
    });

    it('canonical data changed since generation 1: generation 2 carries the fresh approved draft; generation 1 is untouched', async () => {
      s = await deletedReissueScenario(target);
      const g1Before = await gen(1);
      const l1Before = await ledgerRow(1);
      await changeCanonical();
      const inv = await one(`select total_inc_gst::numeric t, gst_amount::numeric g, record_version from invoices where id = $1`, [s.invoice.id]);
      expect(Number(inv.t)).toBe(s.invoice.total - 100);                                  // the totals derive from the corrected line
      const r = await s.request(FINANCE, REASON);
      expect(r).toMatchObject({ ok: true });
      const ap = await one(`select action_payload, payload_hash from approvals where approval_number = $1`, [String(r.approval_number)]);
      const draft = (ap.action_payload as R).draft as R;
      expect(draft).toMatchObject({ amount_inc_gst: Number(inv.t), gst_amount: Number(inv.g), xero_contact_name: 'Ella Thompson-Reid [CUST-0004]',
        customer_email: 'ella.reid@example.com', xero_invoice_number: g1Before.xero_invoice_number, reference: g1Before.reference, xero_tenant_id: g1Before.xero_tenant_id });
      expect(((draft.lines as R[])[0]!).description).toBe('Final invoice, reissued: corrected scope');

      expect(await s.decide(String(r.approval_number), FINANCE)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED', generation: 2 });
      const g2 = await gen(2);
      // The queued payload IS the approved draft (every Xero-facing value), bound to the approval's hash.
      expect((await one(`select $1::jsonb @> $2::jsonb ok`, [JSON.stringify(g2), JSON.stringify(draft)])).ok).toBe(true);
      expect(g2).toMatchObject({ generation: 2, approval_number: String(r.approval_number), reissue_preview_hash: ap.payload_hash,
        amount_inc_gst: Number(inv.t), xero_invoice_number: g1Before.xero_invoice_number, reference: g1Before.reference, xero_tenant_id: g1Before.xero_tenant_id });
      // ... and not generation 1's stale values.
      expect(g2.amount_inc_gst).not.toBe(g1Before.amount_inc_gst);
      expect(g2.xero_contact_name).not.toBe(g1Before.xero_contact_name);
      expect(((g2.lines as R[])[0]!).description).not.toBe(((g1Before.lines as R[])[0]!).description);
      // Generation 1's history is unchanged (its payload, its Xero identity, its keys).
      expect(await gen(1)).toEqual(g1Before);
      expect(await ledgerRow(1)).toEqual(l1Before);
      expect((await ledgerRow(2)).xero_invoice_number).toBe(g1Before.xero_invoice_number);
      expect(await s.integrityFails()).toEqual([]);
    });

    it('canonical data changing between request and decision is refused (PREVIEW_CHANGED): nothing is queued from a stale preview', async () => {
      s = await voidedReissueScenario(target);
      const r = await s.request(FINANCE, REASON);
      await changeCanonical(' (later)', true);                                          // the contact only: not on the invoice row, so only the draft catches it
      expect(await s.decide(String(r.approval_number), FINANCE)).toMatchObject({ ok: false, code: 'PREVIEW_CHANGED' });
      expect(await s.ledger()).toHaveLength(1);
      expect(await s.state()).toMatchObject({ status: 'VOIDED' });
    });

    it('the transition is refused when the queued write is not the approved draft, even with every other decide artefact present', async () => {
      s = await voidedReissueScenario(target);
      const r = await s.request(FINANCE, REASON);
      const apr = String(r.approval_number);
      const ap = await one(`select action_payload, payload_hash from approvals where approval_number = $1`, [apr]);
      await force(`update approvals set status = 'EXECUTING', decided_at = now(), decided_by = (select id from employees where employee_code = $2) where approval_number = $1`, [apr, FINANCE]);
      await force(`insert into processed_events (consumer, idempotency_key, first_event_id, status, request_hash, locked_by, lease_expires_at)
                   values ('invoice.reissue:' || $1, $1, (select event_id from automation_events limit 1), 'PROCESSING', 'x', 'raw sql', now() + interval '5 minutes')`, [apr]);
      await force(`update invoice_xero_draft_generations set status = 'SUPERSEDED', superseded_at = now() where invoice_id = $1 and generation = 1`, [s.invoice.id]);
      await force(`insert into invoice_xero_draft_generations (invoice_id, generation, status, outbox_idempotency_key, approval_id, opened_by)
                   values ($1, 2, 'PENDING', xero_draft_outbox_key($1, 2), (select id from approvals where approval_number = $2), 'raw sql')`, [s.invoice.id, apr]);
      const tampered = { ...((ap.action_payload as R).draft as R), amount_inc_gst: Number(((ap.action_payload as R).draft as R).amount_inc_gst) + 1,
        generation: 2, approval_number: apr, reissue_preview_hash: ap.payload_hash };
      await force(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, generation)
                   values ('xero.create_draft_invoice', 'invoice', $1, gen_random_uuid(), xero_draft_outbox_key($1, 2), $2::jsonb, 2)`, [s.invoice.id, JSON.stringify(tampered)]);
      await expect(transition(apr)).rejects.toThrow(/only ops_reissue_decide/);
      expect(await s.state()).toMatchObject({ status: 'VOIDED' });
    });

    it('a generation-2 payload that no longer matches its approved draft is an integrity FAIL', async () => {
      s = await deletedReissueScenario(target);
      const r = await s.request(FINANCE, REASON);
      expect(await s.decide(String(r.approval_number), FINANCE)).toMatchObject({ ok: true });
      await force(`update outbox set payload = jsonb_set(payload, '{amount_inc_gst}', to_jsonb((payload ->> 'amount_inc_gst')::numeric + 1))
                   where idempotency_key = xero_draft_outbox_key($1, 2)`, [s.invoice.id]);
      expect(await s.integrityFails()).toContain('reissue_transition_bound');
    });
  });
});
