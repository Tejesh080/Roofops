/**
 * AC-14C follow-up, audit P2-D2 (Postgres side): 05's claim and completion are generation-aware.
 *
 * A generation >= 2 draft write is claimed only when xero_reissue_proof proves it is the supervised reissue (executed
 * reissue approval, payload = the approved draft under its hash, predecessor superseded, invoice APPROVED on that
 * approval, tenant pinned); the claim then hands 05 the superseded Xero InvoiceIDs so stale documents can be recognised
 * and never control the new generation. Completion refuses a proof that names a superseded InvoiceID. Generation 1's
 * claim and completion are unchanged.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openPostgres } from '../src/db/db.js';
import { TARGETS } from './helpers/db.js';
import { approvedReissueScenario, deletedReissueScenario, type ReissueScenario, type ScenarioTarget } from './helpers/reissue-scenario.js';

type R = Record<string, unknown>;
const FINANCE = 'EMP-900';
const REASON = 'Customer asked for the voided final to be reissued unchanged';
const uuidFor = (seed: string) => createHash('md5').update(seed).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

describe.each(TARGETS)('AC-14C P2-D2: generation-aware claim and completion [%s]', (t) => {
  const target = t as ScenarioTarget;
  let s: ReissueScenario | null = null;
  afterEach(async () => { await s?.close(); s = null; });
  const q = async (sql: string, p: unknown[] = []) => s!.db.query<R>(sql, p);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0]!;
  const force = async (sql: string, p: unknown[] = []) => {
    await s!.db.exec(`set session_replication_role = replica`);
    try { await s!.db.query(sql, p); } finally { await s!.db.exec(`set session_replication_role = origin`).catch(() => undefined); }
  };
  const claim = async (key: string) => (await one(`select wf_claim_side_effect($1, 'n8n:05', 120) c`, [key])).c as R;
  const complete = (key: string, proof: R) => q(`select wf_complete_side_effect($1, $2::jsonb) r`, [key, JSON.stringify(proof)]);
  /** What 05 sends after reading a draft back (as the AC-14C scenario builder does for generation 1). */
  const proofFor = (p: R, invoiceId: string) => ({ verified: true, tenant_id: p.xero_tenant_id, organisation_class: 'DEMO', invoice_id: invoiceId,
    invoice_number: p.xero_invoice_number, reference: p.reference, status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false,
    contact_id: uuidFor(`contact:${String(p.customer_id)}`), contact_number: p.xero_contact_number, total: p.amount_inc_gst, total_tax: p.gst_amount,
    currency: 'AUD', line_amount_types: 'Inclusive', matching_invoices: 1 });
  const reissued = async () => {
    s = await deletedReissueScenario(target);
    const r = await s.request(FINANCE, REASON);
    expect(await s.decide(String(r.approval_number), FINANCE)).toMatchObject({ ok: true, generation: 2 });
    const key = String((await one(`select xero_draft_outbox_key($1, 2) k`, [s.invoice.id])).k);
    const payload = (await one(`select payload from outbox where idempotency_key = $1`, [key])).payload as R;
    return { key, payload, apr: String(r.approval_number) };
  };

  it('a proven generation-2 write is claimed, with the superseded Xero InvoiceIDs and the reissue approval for 05', async () => {
    const { key, apr } = await reissued();
    expect(await claim(key)).toMatchObject({ claimed: true, generation: 2, superseded_xero_invoice_ids: [s!.invoice.xid], reissue_approval_number: apr });
  });

  it('an unproven generation-2 write is not claimed (REISSUE_NOT_PROVEN): the write stays queued and a person is told', async () => {
    const { key } = await reissued();
    await force(`update outbox set payload = jsonb_set(payload, '{amount_inc_gst}', to_jsonb((payload ->> 'amount_inc_gst')::numeric + 1)) where idempotency_key = $1`, [key]);
    expect(await claim(key)).toMatchObject({ claimed: false, status: 'REISSUE_NOT_PROVEN', message: expect.stringMatching(/not the approved draft/) as unknown });
    expect(await one(`select status from outbox where idempotency_key = $1`, [key])).toMatchObject({ status: 'PENDING' });
    expect((await q(`select error_class from workflow_exceptions where business_reference = $1 and resolution_status = 'OPEN'`, [s!.invoice.number])).map((r) => r.error_class))
      .toContain('RECONCILIATION_MISMATCH');
  });

  it('a stale (superseded) Xero InvoiceID can never complete generation 2; a fresh one links it and settles the generation', async () => {
    const { key, payload } = await reissued();
    expect(await claim(key)).toMatchObject({ claimed: true });
    await expect(complete(key, proofFor(payload, s!.invoice.xid))).rejects.toThrow(/superseded Xero invoice/);
    expect(await s!.link()).toBe(s!.invoice.xid);                                        // the link did not move
    const fresh = uuidFor(`replacement:${s!.invoice.id}`);
    await complete(key, proofFor(payload, fresh));
    expect(await s!.link()).toBe(fresh);
    expect(await s!.state()).toMatchObject({ status: 'APPROVED', sync_status: 'SYNCED' });
    expect((await s!.ledger()).map((g) => [g.generation, g.status])).toEqual([[1, 'SUPERSEDED'], [2, 'CREATED']]);
    expect(await s!.integrityFails()).toEqual([]);
  });

  it('completion re-proves the reissue: a write tampered after its claim is never linked', async () => {
    const { key, payload } = await reissued();
    expect(await claim(key)).toMatchObject({ claimed: true });
    await force(`update outbox set payload = jsonb_set(payload, '{reissue_preview_hash}', '"forged"') where idempotency_key = $1`, [key]);
    await expect(complete(key, proofFor(payload, uuidFor(`replacement:${s!.invoice.id}`)))).rejects.toThrow(/not the approved draft/);
    expect(await s!.link()).toBe(s!.invoice.xid);
  });

  it('two simultaneous 05 claims of one generation-2 write (two connections): exactly one claims it, once', async () => {
    const { key } = await reissued();
    const url = (s!.db as { url?: string }).url;
    if (target !== 'postgres' || !url) { expect(target).toBe('pglite'); return; }   // PGlite has one connection
    const other = await openPostgres(url);
    try {
      const results = await Promise.all([claim(key),
        other.query<{ c: R }>(`select wf_claim_side_effect($1, 'n8n:05b', 120) c`, [key]).then((r) => r[0]!.c)]);
      expect(results.filter((r) => r.claimed === true), JSON.stringify(results)).toHaveLength(1);
      expect(results.find((r) => r.claimed === true)).toMatchObject({ generation: 2, superseded_xero_invoice_ids: [s!.invoice.xid] });
      expect(await one(`select status, attempts from outbox where idempotency_key = $1`, [key])).toMatchObject({ status: 'DISPATCHING', attempts: 1 });
      expect((await s!.ledger()).map((g) => [g.generation, g.status])).toEqual([[1, 'SUPERSEDED'], [2, 'DISPATCHING']]);
    } finally { await other.close(); }
  }, 120_000);

  it('generation 1 is unchanged: its claim result carries no generation keys', async () => {
    s = await approvedReissueScenario(target);
    await force(`update outbox set status = 'PENDING', next_attempt_at = now() where idempotency_key = xero_draft_outbox_key($1, 1)`, [s.invoice.id]);
    await force(`update invoices set sync_status = 'PENDING' where id = $1`, [s.invoice.id]);
    const c = await claim(String((await one(`select xero_draft_outbox_key($1, 1) k`, [s.invoice.id])).k));
    expect(c).toMatchObject({ claimed: true });
    expect(c).not.toHaveProperty('generation');
    expect(c).not.toHaveProperty('superseded_xero_invoice_ids');
  });

  it('ambiguity still fails safe: an uncertain generation-2 dead letter is not recovered from a stale document by number', async () => {
    const { key } = await reissued();
    expect(await claim(key)).toMatchObject({ claimed: true });
    await q(`select wf_fail_side_effect($1, 'TIMEOUT', 'create draft invoice: ETIMEDOUT after 20s', null, 0)`, [key]);
    for (let i = 0; i < 4; i++) {
      await force(`update outbox set next_attempt_at = now() where idempotency_key = $1`, [key]);
      if ((await claim(key)).claimed) await q(`select wf_fail_side_effect($1, 'RATE_LIMITED', 'search by invoice number: HTTP 429', 429, 0)`, [key]);
    }
    expect(await s!.state()).toMatchObject({ sync_status: 'UNKNOWN' });
    expect((await one(`select wf_reissue_dispatch('x', 'test') d`)).d).toMatchObject({ ok: false });   // no token: nothing dispatched
    await q(`update app_settings set value = encode(sha256(convert_to('t', 'UTF8')), 'hex') where key = 'reissue.dispatch_token_sha256'`);
    expect(((await one(`select wf_reissue_dispatch('t', 'test') d`)).d as R).writes).toEqual([]);  // a dead letter is never redispatched
    expect(await s!.link()).toBe(s!.invoice.xid);
  });
});
