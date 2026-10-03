/**
 * AC-06 (docs/adversarial-test-catalogue.md): unpinning or re-pointing the Xero tenant must not let a write run against
 * another tenant, or leave a draft in Xero that RoofOps records as failed.
 * The tenant is copied into the outbox payload at approval, and wf_claim_side_effect / wf_complete_side_effect trusted the
 * payload: with the pin cleared (the documented "no writes possible" state) or changed to another tenant, a queued or
 * retrying job was still claimed, written by n8n 05 to the old tenant, and recorded SYNCED (reproduced: claimed=true,
 * RECORDED, SYNCED with the pin empty and with the pin re-pointed). Refusing only at completion is not enough: a worker
 * that claimed before the change still POSTs to the old tenant.
 *
 * Rule: a Xero write is bound for good to the tenant it was approved for. The pin cannot be changed, cleared or deleted
 * while a write for the pinned tenant is not finished (queued, being written, retry scheduled, ambiguous). Pin changes
 * and claims are serialized (claims shared, changes exclusive), so a race has two outcomes only: worker first, the change
 * waits and is refused; change first, the claim waits, sees the new pin and does not claim (no Xero call). Completion
 * re-checks the pin as defence in depth. n8n 05 is unchanged.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPostgres, type Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { InvoiceRows } from './helpers/airtable04.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const APPROVER = 'usr7uCnNO15fCefbH';
const A = '11111111-2222-3333-4444-555555555555';   // the tenant the invoices are approved for
const B = '99999999-8888-7777-6666-555555555555';   // another tenant
const C = 'cccccccc-8888-7777-6666-555555555555';   // and a third
/** A stable synthetic Xero id (Xero ids are UUIDs). */
const uuidFor = (seed: string) => createHash('md5').update(seed).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;
/** The guard's refusal, naming the open write and its state. */
const blocked = (invoice: string, state: string) => new RegExp(`^The pinned Xero tenant 11111111… cannot be changed or cleared while a Xero write for it is not finished: `
  + `.*${invoice} \\(${state.replace(/[()]/g, '\\$&')}\\)`);

describe.each(TARGETS)('AC-06: a Xero write is bound to its approved tenant [%s]', (target) => {
  const rows = new InvoiceRows();
  let n = 0;
  /** Everything the tests do, against one database. */
  const kit = (db: Db) => {
    const q1 = async (sql: string, p: unknown[] = []) => (await db.query<{ r: R }>(sql, p))[0]!.r;
    const outcome = (p: Promise<unknown>) => p.then(() => true as const, (e: unknown) => (e as Error).message);
    /** What an operator can do to the pin (ops/pin-xero-demo-tenant.sql, or by hand): true, or Postgres's refusal. */
    const change = (v: string, on: Db = db) => outcome(on.query(`update app_settings set value = $1 where key = 'xero.demo_tenant_id'`, [v]));
    const remove = () => outcome(db.query(`delete from app_settings where key = 'xero.demo_tenant_id'`));
    const insert = (v: string) => outcome(db.query(`insert into app_settings (key, value) values ('xero.demo_tenant_id', $1)`, [v]));
    const pinNow = async () => (await col(db, `select value v from app_settings where key = 'xero.demo_tenant_id'`))[0];
    /** Prepare and approve a project's final invoice exactly as n8n 04 does (with tenant A pinned first, unless told not to). */
    const approve = async (project: string, pinFirst = true) => {
      if (pinFirst) expect(await outcome(db.query(`insert into app_settings (key, value) values ('xero.demo_tenant_id', $1)
        on conflict (key) do update set value = excluded.value`, [A]))).toBe(true);
      const ev = (type: string, dt = 0) => ({ event_id: `EVT-AC06-${String(++n)}`, event_type: type, source: 'airtable', actor_id: APPROVER,
        occurred_at: new Date(Date.now() + dt).toISOString(), payload: { project_number: project, airtable_record_id: recFor(project) } });
      expect(await rows.send(db, ev('invoice.prepare_requested'), 'n8n:test')).toMatchObject({ outcome: 'PREVIEW_READY' });
      const r = await rows.send(db, ev('invoice.approved', 1000), 'n8n:test');
      expect(r).toMatchObject({ outcome: 'APPROVED' });
      const [job] = await db.query<{ key: string; payload: R }>(`select idempotency_key key, payload from outbox where aggregate_id = $1`, [r.invoice_id]);
      expect(job!.payload.xero_tenant_id).toBe(A);
      return { project, invoice: String(r.invoice_number), id: String(r.invoice_id), key: job!.key, payload: job!.payload };
    };
    /** What [RoofOps] 05 sends after reading its draft back from Xero, from the given tenant. */
    const proof = (p: R, tenant: string | undefined) => ({ verified: true, tenant_id: tenant, organisation_class: 'DEMO', invoice_id: uuidFor(`xero-invoice:${String(p.invoice_id)}`),
      invoice_number: p.xero_invoice_number, reference: p.reference, status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false,
      contact_id: uuidFor(`xero-contact:${String(p.customer_id)}`), contact_number: p.xero_contact_number, total: p.amount_inc_gst, total_tax: p.gst_amount,
      currency: 'AUD', line_amount_types: 'Inclusive', matching_invoices: 1 });
    const claim = (key: string, w: string, on: Db = db) => on.query<{ r: R }>(`select wf_claim_side_effect($1, $2, 120) r`, [key, w]).then((x) => x[0]!.r);
    const complete = (a: { key: string; payload: R }, tenant: string | undefined, on: Db = db) =>
      on.query<{ r: R }>(`select wf_complete_side_effect($1, $2::jsonb) r`, [a.key, JSON.stringify(proof(a.payload, tenant))]).then((x) => x[0]!.r);
    const fail = (key: string, cls: string, msg: string) => q1(`select wf_fail_side_effect($1, $2, $3, null, 0) r`, [key, cls, msg]);
    const job = async (a: { id: string }) => (await db.query<R>(`select i.status invoice, i.sync_status, o.status outbox, o.attempts, o.payload ->> 'xero_tenant_id' tenant,
        exists (select 1 from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id) xero_linked
        from invoices i join outbox o on o.aggregate_id = i.id where i.id = $1`, [a.id]))[0]!;
    /** Every sync state the invoice has been in (from the audit trail and now). */
    const syncHistory = async (a: { id: string }) => col(db, `select distinct x v from (
        select after_state ->> 'sync_status' x from audit_events where entity_id = $1 and after_state ? 'sync_status'
        union all select sync_status from invoices where id = $1) s where x is not null`, [a.id]);
    /** The open exceptions a person sees for this project's stopped Xero write. */
    const holds = (project: string) => col(db, `select error_class || ' ' || error_message v from workflow_exceptions
        where business_reference = $1 and resolution_status = 'OPEN' and error_message like '%Xero write stopped%' order by created_at`, [project]);
    return { q1, change, remove, insert, pinNow, approve, claim, complete, fail, job, syncHistory, holds };
  };
  const setup = async () => {
    const db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
    return db;
  };
  const settled = (p: Promise<unknown>) => { const s = { done: false }; void p.then(() => { s.done = true; }, () => { s.done = true; }); return s; };
  const pause = () => new Promise((r) => setTimeout(r, 400));

  describe('an open write keeps the pin where it is', () => {
    let db: Db;
    let k: ReturnType<typeof kit>;
    beforeAll(async () => { db = await setup(); k = kit(db); }, 120_000);
    afterAll(async () => { await db.close(); });

    it('1. a PENDING (queued) write blocks changing, clearing and deleting the pin; it then runs in its own tenant, and once done the pin may move', async () => {
      const a = await k.approve('PRJ-2026-0004');
      for (const attempt of [k.change(B), k.change(''), k.remove()]) expect(await attempt).toMatch(blocked(a.invoice, 'queued'));
      expect(await k.pinNow()).toBe(A);
      expect(await k.job(a)).toMatchObject({ outbox: 'PENDING', attempts: 0, tenant: A });
      expect(await k.claim(a.key, 'w1')).toMatchObject({ claimed: true, payload: { xero_tenant_id: A } });
      expect(await k.complete(a, A)).toMatchObject({ status: 'RECORDED' });
      expect(await k.change(B)).toBe(true);                                           // finished: nothing for A is open any more
      expect(await k.change(A)).toBe(true);
    });

    it('2. an IN_PROGRESS (claimed, being written) write blocks the pin, and its tenant cannot be edited; it completes in its own tenant', async () => {
      const a = await k.approve('PRJ-2026-0005');
      expect(await k.claim(a.key, 'w1')).toMatchObject({ claimed: true });
      for (const attempt of [k.change(B), k.change(''), k.remove()]) expect(await attempt).toMatch(blocked(a.invoice, 'being written'));
      await expect(db.query(`update outbox set payload = jsonb_set(payload, '{xero_tenant_id}', to_jsonb($2::text)) where idempotency_key = $1`, [a.key, B]))
        .rejects.toThrow(/Xero tenant .* is fixed when it is approved/);
      expect(await k.complete(a, A)).toMatchObject({ status: 'RECORDED' });
      expect(await k.job(a)).toMatchObject({ outbox: 'DONE', sync_status: 'SYNCED', xero_linked: true, tenant: A });
    });

    it('3. an UNKNOWN (ambiguous) write blocks the pin, while its retry is scheduled and even once dead-lettered', async () => {
      const a = await k.approve('PRJ-2026-0002');
      expect(await k.claim(a.key, 'w1')).toMatchObject({ claimed: true });
      expect(await k.fail(a.key, 'TIMEOUT', 'create draft invoice: Xero POST timed out after 20s')).toMatchObject({ retry: true });
      expect(await k.job(a)).toMatchObject({ outbox: 'FAILED', sync_status: 'UNKNOWN' });
      expect(await k.change(B)).toMatch(blocked(a.invoice, 'ambiguous: it may already exist in Xero'));
      // An ambiguous attempt that is no longer retried (the outbox row is terminal) may still exist in Xero: still blocked.
      await db.query(`update outbox set next_attempt_at = 'infinity' where idempotency_key = $1`, [a.key]);
      for (const attempt of [k.change(B), k.change(''), k.remove()]) expect(await attempt).toMatch(blocked(a.invoice, 'ambiguous: it may already exist in Xero'));
      expect(await k.pinNow()).toBe(A);
    });

    it('completion proof from a different tenant than the job was approved for is refused (already enforced; guard)', async () => {
      const a = await k.approve('PRJ-2026-0001');
      expect(await k.claim(a.key, 'w1')).toMatchObject({ claimed: true });
      await expect(k.complete(a, B)).rejects.toThrow(/xero proof is from tenant 99999999-8888-7777-6666-555555555555, not the pinned Demo Company tenant/);
      await expect(k.complete(a, undefined)).rejects.toThrow(/not the pinned Demo Company tenant/);
      expect(await k.job(a)).toMatchObject({ outbox: 'DISPATCHING', xero_linked: false });
      expect((await k.job(a)).sync_status).not.toBe('SYNCED');
    });
  });

  describe('finished writes, retries, and a draft that exists', () => {
    let db: Db;
    let k: ReturnType<typeof kit>;
    beforeAll(async () => { db = await setup(); k = kit(db); }, 120_000);
    afterAll(async () => { await db.close(); });

    it('4. a safely FAILED (dead-lettered, nothing created) write lets the pin move; re-queued under another tenant it is not claimed, and pinning its own tenant again lets it run', async () => {
      const a = await k.approve('PRJ-2026-0004');
      expect(await k.claim(a.key, 'w1')).toMatchObject({ claimed: true });
      expect(await k.fail(a.key, 'VALIDATION_ERROR', 'create contact: Xero refused the contact')).toMatchObject({ retry: false });
      expect(await k.job(a)).toMatchObject({ outbox: 'FAILED', sync_status: 'FAILED' });
      expect(await k.change('')).toBe(true);
      expect(await k.remove()).toBe(true);
      expect(await k.insert(B)).toBe(true);
      // Re-queued by an operator (ops/requeue-dead-lettered-side-effect.sql) while B is pinned: held, visibly, no Xero call.
      await db.query(`update outbox set status = 'PENDING', next_attempt_at = now(), last_error = null where idempotency_key = $1`, [a.key]);
      for (const w of ['w2', 'w3']) expect(await k.claim(a.key, w)).toMatchObject({ claimed: false, status: 'TENANT_CHANGED' });
      expect(await k.job(a)).toMatchObject({ outbox: 'PENDING', attempts: 1, tenant: A, xero_linked: false });
      expect(await k.holds(a.project)).toEqual([expect.stringMatching(new RegExp(
        `^PERMISSION_DENIED ${a.invoice}: Xero write stopped\\. It was approved for Xero tenant 11111111…, but the pinned tenant is now 99999999…`)) as unknown]);
      // A write held for another tenant can never run, so it does not block the pin: its own tenant can be pinned again.
      expect(await k.change(C)).toBe(true);
      expect(await k.claim(a.key, 'w4')).toMatchObject({ claimed: false, status: 'TENANT_CHANGED' });
      expect(await k.change('')).toBe(true);
      expect(await k.claim(a.key, 'w5')).toMatchObject({ claimed: false, status: 'TENANT_NOT_PINNED' });
      expect(await k.holds(a.project)).toHaveLength(3);                                    // one per cause, updated, never duplicated
      expect(await k.change(A)).toBe(true);
      expect(await k.claim(a.key, 'w6')).toMatchObject({ claimed: true, attempt: 2, payload: { xero_tenant_id: A } });
      // (Completing a re-queued dead-lettered Xero write is refused by the invoice_sync state machine, FAILED -> SYNCED:
      //  pre-existing, outside AC-06.) From here the write is open again, so the pin is fixed once more.
      expect(await k.change(B)).toMatch(blocked(a.invoice, 'being written'));
    });

    it('7. a retry cannot run under another tenant: the pin cannot move while it is scheduled, and the retry runs in the same tenant', async () => {
      const a = await k.approve('PRJ-2026-0005');
      expect(await k.claim(a.key, 'w1')).toMatchObject({ claimed: true });
      expect(await k.fail(a.key, 'RATE_LIMITED', 'search by invoice number: Xero said 429')).toMatchObject({ retry: true });
      expect(await k.job(a)).toMatchObject({ outbox: 'FAILED', sync_status: 'PENDING' });
      for (const attempt of [k.change(B), k.change(''), k.remove()]) expect(await attempt).toMatch(blocked(a.invoice, 'retry scheduled'));
      await db.query(`update outbox set next_attempt_at = now() where idempotency_key = $1`, [a.key]);   // the retry is due
      expect(await k.claim(a.key, 'w2')).toMatchObject({ claimed: true, attempt: 2, payload: { xero_tenant_id: A } });
      expect(await k.complete(a, A)).toMatchObject({ status: 'RECORDED' });
      expect(await k.job(a)).toMatchObject({ outbox: 'DONE', sync_status: 'SYNCED', tenant: A });
    });

    it('8. no pin change can leave a draft in Xero that RoofOps records as FAILED: while 05 writes, every change is refused and the draft is recorded', async () => {
      const a = await k.approve('PRJ-2026-0002');
      expect(await k.claim(a.key, 'w1')).toMatchObject({ claimed: true });
      // ... 05 creates RO-INV-… in tenant A here ...
      for (const attempt of [k.change(''), k.change(B), k.remove()]) expect(await attempt).toMatch(blocked(a.invoice, 'being written'));
      expect(await k.complete(a, A)).toMatchObject({ status: 'RECORDED' });
      expect(await k.job(a)).toMatchObject({ outbox: 'DONE', sync_status: 'SYNCED', xero_linked: true });
      expect(await k.syncHistory(a)).not.toContain('FAILED');
    });

    it('defence in depth: if the guard is bypassed (triggers off), the completion still refuses to link a draft read back after the pin moved', async () => {
      const a = await k.approve('PRJ-2026-0001');
      expect(await k.claim(a.key, 'w1')).toMatchObject({ claimed: true });
      await db.exec(`set session_replication_role = replica`);
      try { await db.query(`update app_settings set value = $1 where key = 'xero.demo_tenant_id'`, [B]); } finally { await db.exec(`set session_replication_role = origin`); }
      await expect(k.complete(a, A)).rejects.toThrow(new RegExp(`^${a.invoice}: the pinned Xero tenant changed from 11111111… to 99999999… while the draft was written: `
        + `the Xero draft RO-${a.invoice} read back from tenant 11111111… was not linked`));
      await db.exec(`set session_replication_role = replica`);
      try { await db.query(`update app_settings set value = '' where key = 'xero.demo_tenant_id'`); } finally { await db.exec(`set session_replication_role = origin`); }
      await expect(k.complete(a, A)).rejects.toThrow(/no Xero tenant is pinned now \(it was approved for tenant 11111111…\)/);
      expect(await k.job(a)).toMatchObject({ outbox: 'DISPATCHING', xero_linked: false });
    });
  });

  describe.skipIf(target === 'pglite')('races, with two real PostgreSQL connections', () => {
    let db: Db & { url?: string };
    let other: Db;
    let k: ReturnType<typeof kit>;
    beforeAll(async () => { db = await setup(); k = kit(db); other = await openPostgres(db.url!); }, 120_000);
    afterAll(async () => { await other.close(); await db.close(); });

    it('5. worker claims first: the pin change waits for the claim, is then refused, and the worker stays bound to (and completes in) the same tenant', async () => {
      const a = await k.approve('PRJ-2026-0004');
      await other.exec('begin');
      try {
        expect(await k.claim(a.key, 'w1', other)).toMatchObject({ claimed: true });    // claimed, not committed yet
        const change = k.change(B);
        const cs = settled(change);
        await pause();
        expect(cs.done).toBe(false);                                                 // the change waits for the claim
        await other.exec('commit');
        expect(await change).toMatch(blocked(a.invoice, 'being written'));
      } finally { await other.exec('rollback').catch(() => undefined); }
      expect(await k.pinNow()).toBe(A);
      expect(await k.complete(a, A)).toMatchObject({ status: 'RECORDED' });
      expect(await k.job(a)).toMatchObject({ outbox: 'DONE', sync_status: 'SYNCED', tenant: A });
    });

    it('6. pin change first: the claim waits for the change, then sees the new pin and does not claim (no Xero call); the write stays bound to its tenant', async () => {
      await other.exec('begin');
      let a: Awaited<ReturnType<typeof k.approve>>;
      try {
        expect(await k.change(B, other)).toBe(true);                                 // allowed (nothing for A is open), not committed yet
        a = await k.approve('PRJ-2026-0005', false);                                  // approved meanwhile: bound to A, the pin it read
        const c = k.claim(a.key, 'w1');
        const cs = settled(c);
        await pause();
        expect(cs.done).toBe(false);                                                 // the claim waits for the change
        await other.exec('commit');
        expect(await c).toMatchObject({ claimed: false, status: 'TENANT_CHANGED' });
      } finally { await other.exec('rollback').catch(() => undefined); }
      expect(await k.job(a)).toMatchObject({ outbox: 'PENDING', attempts: 0, tenant: A, xero_linked: false });
      expect(await k.holds(a.project)).toHaveLength(1);
      // Its own tenant can be pinned again (a held write does not block), and it then runs there.
      expect(await k.change(A)).toBe(true);
      expect(await k.claim(a.key, 'w2')).toMatchObject({ claimed: true, payload: { xero_tenant_id: A } });
      expect(await k.complete(a, A)).toMatchObject({ status: 'RECORDED' });
    });
  });
});
