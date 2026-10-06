/**
 * AC-14C Part B1 (docs/defect-ledger.md): one live Xero draft generation per invoice.
 *
 * Part B1 makes a SECOND xero.create_draft_invoice write for one invoice expressible without breaking the schema's
 * scalar "the draft write" lookups:
 *  * outbox.generation + two partial unique indexes (one row per (topic, aggregate_id, generation); at most one LIVE
 *    PENDING/DISPATCHING draft write per invoice) - the database refuses a second live draft, raw SQL included.
 *  * invoice_xero_draft_generations: the durable per-invoice ledger of draft generations (Xero InvoiceID, number,
 *    tenant, approval, operator, supersede reason). History is append-only: nothing is deleted or rewritten.
 *  * the backfill of pre-B1 history, proven non-vacuously here: the migration chain up to 20261001140000 is applied,
 *    a pre-B1 world is built through the real approval flow (draft writes in every outbox status, a dead-lettered
 *    UNKNOWN invoice, a verified link with its bound tenant), then the B1 migration runs and every existing draft
 *    write must have exactly one ledger row with the mapped status - and no historical row may change.
 *  * ledger maintenance for NEW writes: opening on queue, mirroring PENDING -> DISPATCHING -> CREATED (capturing the
 *    Xero InvoiceID, number and tenant), FAILED for a safe failure, UNKNOWN for an ambiguous one.
 *  * generation-aware idempotency keys: generation 1 stays byte-identical to history; generation >= 2 gets new keys.
 *  * generation-aware replacements of the eight scalar lookups; with two generations present nothing raises a
 *    multi-row SQL error, a local void refuses as documented, and a SUPERSEDED Xero InvoiceID is inert everywhere.
 * This suite runs on PGlite and (when TEST_DATABASE_URL is set) on PostgreSQL 17, like every database suite here.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { migrate, MIGRATIONS_DIR } from '../src/db/migrate.js';
import { importBundle } from '../src/import/importer.js';
import { InvoiceRows } from './helpers/airtable04.js';
import { TARGETS, col, freshDb, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const APPROVER = 'usr7uCnNO15fCefbH';
const TENANT = '11111111-2222-3333-4444-555555555555';        // the pin, and every write's bound tenant
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;
const uuidFor = (seed: string) => createHash('md5').update(seed).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const B1_FILE = '20261001150000_one_live_xero_draft_generation.sql';
const LAST_PRE_B1 = '20261001140000_xero_deletion_follows_the_void_path.sql';   // Part A: the chain the B1 migration lands on

type Job = { project: string; invoice: string; id: string; key: string; payload: R; approvalId: string };

/**
 * The real paths, exactly as the other suites drive them: n8n 04's Prepare/Approve (through wf_invoice_prepare and
 * wf_invoice_decide), then 05's claim / complete-with-proof / fail, and 07's settle path where a test needs it.
 */
function kit(db: Db, rows: InvoiceRows, seq: { n: number }) {
  const q1 = async (sql: string, p: unknown[] = []) => (await db.query<{ r: R }>(sql, p))[0]!.r;
  const one = async (sql: string, p: unknown[] = []) => (await db.query<R>(sql, p))[0]!;
  /** Fixture-only escape (established pattern): build a state the guards would not permit, never used to assert. */
  const force = async (sql: string, p: unknown[] = []) => {
    await db.exec(`set session_replication_role = replica`);
    try { await db.query(sql, p); } finally { await db.exec(`set session_replication_role = origin`).catch(() => undefined); }
  };
  const rejects = async (sql: string, pattern: RegExp) => {
    await db.exec('begin');                                              // the probe is undone on both engines
    try {
      await db.query(sql);
    } catch (e) {
      await db.exec('rollback');
      expect((e as Error).message).toMatch(pattern);
      return;
    }
    await db.exec('rollback');
    throw new Error(`expected rejection: ${sql.slice(0, 90)}`);
  };

  const ev = (type: string, project: string, dt = 0) => ({ event_id: `EVT-GEN-${String(++seq.n)}`, event_type: type, source: 'airtable', actor_id: APPROVER,
    occurred_at: new Date(Date.now() + dt).toISOString(), payload: { project_number: project, airtable_record_id: recFor(project) } });
  /** Prepare and approve a project's final invoice as n8n 04 does; returns the invoice, its job and its approval. */
  const approve = async (project: string): Promise<Job> => {
    expect(await rows.send(db, ev('invoice.prepare_requested', project), 'n8n:test')).toMatchObject({ outcome: 'PREVIEW_READY' });
    const r = await rows.send(db, ev('invoice.approved', project, 1000), 'n8n:test');
    expect(r).toMatchObject({ outcome: 'APPROVED' });
    const [job] = await db.query<{ key: string; payload: R; approval_id: string }>(
      `select o.idempotency_key key, o.payload, i.approval_id::text approval_id from outbox o join invoices i on i.id = o.aggregate_id
        where o.aggregate_id = $1 and o.topic = 'xero.create_draft_invoice'`, [r.invoice_id]);
    return { project, invoice: String(r.invoice_number), id: String(r.invoice_id), key: job!.key, payload: job!.payload, approvalId: job!.approval_id };
  };
  const claim = (key: string, w: string) => q1(`select wf_claim_side_effect($1, $2, 120) r`, [key, w]);
  /** What 05's Record Xero Failure sends: the message always starts with the step name. */
  const fail = (key: string, cls: string, step: string, msg: string, http: number | null = null) =>
    q1(`select wf_fail_side_effect($1, $2, $3, $4, 0) r`, [key, cls, `${step}: ${msg}`, http]);
  const retryDue = (key: string) => db.query(`update outbox set next_attempt_at = now() where idempotency_key = $1 and status = 'FAILED' and next_attempt_at <> 'infinity'`, [key]);
  /** What 05 sends after reading its draft back from Xero. */
  const proof = (p: R, over: R = {}) => ({ verified: true, tenant_id: TENANT, organisation_class: 'DEMO', invoice_id: uuidFor(`xero:${String(p.invoice_id)}`),
    invoice_number: p.xero_invoice_number, reference: p.reference, status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false,
    contact_id: uuidFor(`contact:${String(p.customer_id)}`), contact_number: p.xero_contact_number, total: p.amount_inc_gst, total_tax: p.gst_amount,
    currency: 'AUD', line_amount_types: 'Inclusive', matching_invoices: 1, ...over });
  const complete = (a: Job, over: R = {}) => q1(`select wf_complete_side_effect($1, $2::jsonb) r`, [a.key, JSON.stringify(proof(a.payload, over))]);
  const ledger = (id: string) => db.query<R>(`select generation, status, outbox_idempotency_key key, xero_invoice_id, xero_invoice_number, tenant_id, opened_by,
      approval_id::text approval_id, superseded_at::text superseded_at, superseded_reason
    from invoice_xero_draft_generations where invoice_id = $1 order by generation`, [id]);
  /** The invoice and the given write's own outbox row. */
  const state = async (a: Job) => (await db.query<R>(`select i.status, i.sync_status, i.voided_reason, o.status outbox_status, o.next_attempt_at = 'infinity' dead,
      (select external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id) xero_link
    from invoices i join outbox o on o.aggregate_id = i.id and o.idempotency_key = $2 where i.id = $1`, [a.id, a.key]))[0]!;
  /** A verified Xero read recorded for the invoice (the shape 07 leaves behind); the real path is covered elsewhere. */
  const insertObs = async (a: Job, o: { verdict: string; settlement: string | null; tenantId: string | null; xeroInvoiceId: string | null }) => {
    // The run is backdated: a synthetic observation must not hold the real 2-minute reconciliation quota shut.
    const run = (await db.query<{ id: string }>(
      `insert into reconciliation_runs (run_key, trigger, mode, status, started_at, finished_at)
       values ('GEN-OBS-' || gen_random_uuid(), 'test', 'observe', 'COMPLETED', now() - interval '1 hour', now() - interval '1 hour')
       returning id::text id`))[0]!;
    await db.query(`insert into xero_invoice_observations (invoice_id, run_id, tenant_id, bound_tenant_id, xero_invoice_id, verdict, settlement, xero_status, detail)
                    values ($1, $2, $3, $4, $5, $6, $7, $7, 'synthetic observation for the generation tests')`,
      [a.id, run.id, o.tenantId, TENANT, o.xeroInvoiceId, o.verdict, o.settlement]);
  };
  const startRun = async (mode: 'repair' | 'observe' = 'repair') => String((await q1(`select wf_reconcile_start('schedule', $1) r`, [mode])).run_key);

  /**
   * The two-generation state a supervised reissue creates, built as a fixture (the real reissue is Part B2): the old
   * generation is superseded (its Xero document was verified deleted - the reason for a reissue), a new generation is
   * opened and its write is queued with the generation-aware keys, and the invoice's sync goes back to PENDING.
   * `complete` additionally mirrors what completion does for a later generation (ledger CREATED, write DONE, sync
   * SYNCED, the current link moved to the new InvoiceID) - with the same proofs the real path requires.
   */
  const supersede = async (a: Job, o: { replacementNumber?: string; complete?: boolean; verifiedDeletion?: boolean } = {}) => {
    const linked = (await db.query<{ external_id: string }>(`select external_id from external_links
       where provider = 'XERO' and external_type = 'Invoice' and entity_id = $1`, [a.id]))[0];
    if (linked === undefined) throw new Error('the two-generation fixture needs generation 1 to be linked in Xero');
    const oldLink = linked.external_id;
    // The verified deletion of the linked document is what motivates a reissue (AC-14C-A's void exemption relies on it
    // too), so it is part of the two-generation state unless a test wants the plain "draft exists" path.
    if (o.verifiedDeletion !== false) await insertObs(a, { verdict: 'VERIFIED', settlement: 'DELETED', tenantId: TENANT, xeroInvoiceId: oldLink });
    const replacementNumber = o.replacementNumber ?? String(a.payload.xero_invoice_number);
    const newXid = uuidFor(`replacement:${a.id}`);
    await db.query(`update invoice_xero_draft_generations set status = 'SUPERSEDED', superseded_at = now(),
        superseded_reason = 'superseded by the supervised reissue (test fixture)'
      where invoice_id = $1 and generation = 1`, [a.id]);
    await db.query(`insert into invoice_xero_draft_generations (invoice_id, generation, status, outbox_idempotency_key, xero_invoice_number, tenant_id, opened_by)
      values ($1, 2, 'PENDING', xero_draft_outbox_key($1, 2), $2, $3, 'operator:EMP-901')`, [a.id, replacementNumber, TENANT]);
    await db.query(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, status, generation)
      select 'xero.create_draft_invoice', 'invoice', $1, correlation_id, xero_draft_outbox_key($1, 2),
             jsonb_set(jsonb_set(payload, '{xero_invoice_number}', to_jsonb($2::text)), '{xero_idempotency_key}', to_jsonb(xero_draft_provider_key($1, 2))),
             'PENDING', 2
        from outbox where idempotency_key = $3`, [a.id, replacementNumber, a.key]);
    await force(`update invoices set sync_status = 'PENDING' where id = $1`, [a.id]);   // the reissue's statement (Part B2)
    const gen2: Job = { ...a, key: `xero:invoice:${a.id}:g2`, payload: { ...a.payload, xero_invoice_number: replacementNumber } };
    if (o.complete) {
      // The proofs a generation >= 2 completion carries (Part B2 moves the link for it): the new write is DONE with
      // the new InvoiceID linked, the ledger captures it, the invoice is SYNCED, and the old ID stays in history.
      await force(`update outbox set status = 'DONE', dispatched_at = now() where idempotency_key = $1`, [gen2.key]);
      await db.query(`update external_links set external_id = $2, verified_at = now() where provider = 'XERO' and external_type = 'Invoice' and entity_id = $1`, [a.id, newXid]);
      await db.query(`update invoice_xero_draft_generations set status = 'CREATED', xero_invoice_id = $2 where invoice_id = $1 and generation = 2`, [a.id, newXid]);
      await force(`update invoices set sync_status = 'SYNCED' where id = $1`, [a.id]);
    }
    return { gen2, oldLink, newXid, replacementNumber };
  };

  /** Row-content fingerprints (count + md5 of every row) for the tables the migration must not touch. */
  const fingerprint = () => col(db, `
    select 'invoices ' || count(*) || ' ' || coalesce(md5(string_agg(to_jsonb(t)::text, '|' order by t.id)), '-') v from invoices t
    union all select 'outbox ' || count(*) || ' ' || coalesce(md5(string_agg((to_jsonb(t) - 'generation')::text, '|' order by t.id)), '-') from outbox t
    union all select 'observations ' || count(*) || ' ' || coalesce(md5(string_agg(to_jsonb(t)::text, '|' order by t.id)), '-') from xero_invoice_observations t
    union all select 'approvals ' || count(*) || ' ' || coalesce(md5(string_agg(to_jsonb(t)::text, '|' order by t.id)), '-') from approvals t
    union all select 'audit ' || count(*) || ' ' || coalesce(md5(string_agg(to_jsonb(t)::text, '|' order by t.audit_id)), '-') from audit_events t`);

  return { q1, one, force, rejects, approve, claim, fail, retryDue, complete, proof, ledger, state, insertObs, startRun, supersede, fingerprint };
}

const pinTenant = (db: Db) => db.exec(`
  update app_settings set value = '${TENANT}' where key = 'xero.demo_tenant_id';
  insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
  select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);

describe.each(TARGETS)('AC-14C B1: Xero draft generations [%s]', (target) => {
  const rows = new InvoiceRows();
  const seq = { n: 0 };

  // --------------------------------------------------------------------------------------------------------------
  // The backfill, proven on real pre-B1 history: the chain up to 20261001140000, fixtures through the real flow,
  // then the B1 migration - and nothing historical may change.
  // --------------------------------------------------------------------------------------------------------------
  describe('the backfill of pre-B1 history', () => {
    let db: Db;
    let k: ReturnType<typeof kit>;
    let jobs: { pending: Job; dispatching: Job; done: Job; unknown: Job; retry: Job; dead: Job };
    let before: string[];
    let dirA: string;
    let dirB1: string;

    beforeAll(async () => {
      db = await freshDb(target);
      const all = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
      dirA = mkdtempSync(join(tmpdir(), 'roofops-b1-pre-'));
      dirB1 = mkdtempSync(join(tmpdir(), 'roofops-b1-plus-'));
      for (const f of all.filter((f) => f <= LAST_PRE_B1)) { cpSync(join(MIGRATIONS_DIR, f), join(dirA, f)); cpSync(join(MIGRATIONS_DIR, f), join(dirB1, f)); }
      expect(all).toContain(B1_FILE);                                     // the new migration exists and sorts after Part A
      expect(all.indexOf(B1_FILE)).toBeGreaterThan(all.indexOf(LAST_PRE_B1));
      cpSync(join(MIGRATIONS_DIR, B1_FILE), join(dirB1, B1_FILE));
      const first = await migrate(db, dirA);                              // the pre-B1 world
      expect(first.applied).toContain(LAST_PRE_B1);
      expect(first.applied).not.toContain(B1_FILE);
      await importBundle(db);
      await pinTenant(db);
      k = kit(db, rows, seq);

      // Draft-write outbox rows in every status, through the real approval/claim/complete/fail path. Only four COMPLETED
      // projects can be final-invoiced in this dataset (0003 has an unapproved draft, 0006/0008 are over-billed, 0007 is
      // missing completion documents), so the two closed-but-not-creating writes are fixture rows like the ones this
      // schema already holds.
      const pending = await k.approve('PRJ-2026-0004');                   // queued
      const dispatching = await k.approve('PRJ-2026-0002');               // claimed, being written
      const done = await k.approve('PRJ-2026-0001');                      // created in Xero and read back (verified link + bound tenant)
      const unknown = await k.approve('PRJ-2026-0005');                   // an ambiguous failure, dead-lettered: sync stays UNKNOWN
      expect(await k.claim(dispatching.key, 'w1')).toMatchObject({ claimed: true });
      expect(await k.claim(done.key, 'w1')).toMatchObject({ claimed: true });
      expect(await k.complete(done)).toMatchObject({ status: 'RECORDED' });
      expect(await k.claim(unknown.key, 'w1')).toMatchObject({ claimed: true });
      expect(await k.fail(unknown.key, 'TIMEOUT', 'create draft invoice', 'ETIMEDOUT after 20s')).toMatchObject({ retry: true });
      for (let i = 0; i < 4; i++) {                                       // retries that prove nothing: it may still exist
        await k.retryDue(unknown.key);
        expect(await k.claim(unknown.key, `w${String(i + 2)}`)).toMatchObject({ claimed: true });
        await k.fail(unknown.key, 'RATE_LIMITED', 'search by invoice number', 'HTTP 429', 429);
      }
      expect(await k.state(unknown)).toMatchObject({ outbox_status: 'FAILED', dead: true, sync_status: 'UNKNOWN' });

      /** A fixture invoice with one draft write already closed (nothing was created in Xero). */
      const closedWrite = async (project: string, number: string, sync: string, attempts: number, nextAttempt: string): Promise<Job> => {
        const [inv] = await db.query<{ id: string }>(`insert into invoices (invoice_number, project_id, customer_id, invoice_type, status, sync_status,
            line_amount_type, approved_by, approved_at, idempotency_key)
          select $2, p.id, p.customer_id, 'FINAL', 'APPROVED', $3, 'INCLUSIVE', (select id from employees limit 1), now(), 'invoice:final:' || p.id
            from projects p where p.project_number = $1 returning id::text`, [project, number, sync]);
        const key = `xero:invoice:${inv!.id}`;
        await db.query(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, status, attempts, next_attempt_at)
          values ('xero.create_draft_invoice', 'invoice', $1, gen_random_uuid(), $2,
                  jsonb_build_object('xero_tenant_id', $3::text, 'xero_invoice_number', $4::text, 'reference', $5::text,
                                     'xero_idempotency_key', 'roofops-' || $1::uuid, 'customer_id', (select customer_id::text from invoices where id = $1)),
                  'FAILED', $6, $7)`, [inv!.id, key, TENANT, number, project, attempts, nextAttempt]);
        return { project, invoice: number, id: inv!.id, key, payload: { xero_invoice_number: number, reference: project, xero_tenant_id: TENANT }, approvalId: '' };
      };
      // A safe failure with a retry pending: the write is closed, the invoice is queued for the retry, nothing exists.
      const retry = await closedWrite('PRJ-2026-0007', 'RO-INV-2026-9002', 'PENDING', 3, new Date(Date.now() + 60_000).toISOString());
      // ... and a dead-lettered one that failed safely: nothing was created and no retry will come.
      const dead = await closedWrite('PRJ-2026-0006', 'RO-INV-2026-9001', 'FAILED', 5, 'infinity');
      jobs = { pending, dispatching, done, unknown, retry, dead };

      before = await k.fingerprint();                                     // the whole pre-B1 history, before the B1 migration
    }, 180_000);
    afterEach(async () => { /* the whole describe shares one database */ });
    afterAll(async () => { await db.close(); rmSync(dirA, { recursive: true, force: true }); rmSync(dirB1, { recursive: true, force: true }); });

    it('VAL-GEN-001: every pre-B1 draft write becomes exactly one mapped generation-1 ledger row, and rerunning inserts nothing', async () => {
      const m = await migrate(db, dirB1);                                 // apply the B1 migration (Part A files are skipped by name+checksum)
      expect(m.applied).toEqual([B1_FILE]);
      expect(m.skipped).toEqual(readdirSync(dirA).filter((f: string) => f.endsWith('.sql')).sort());

      const ledger = await db.query<R>(`select g.invoice_id::text invoice_id, g.generation, g.status, g.outbox_idempotency_key key,
          g.xero_invoice_id, g.xero_invoice_number, g.tenant_id, g.created_at::text created_at, o.created_at::text outbox_created
        from invoice_xero_draft_generations g join outbox o on o.idempotency_key = g.outbox_idempotency_key order by g.invoice_id`);
      expect(ledger).toHaveLength(6);                                     // non-vacuous: exactly the six draft writes, no more

      const byInvoice = new Map(ledger.map((r) => [String(r.invoice_id), r]));
      const expectRow = (a: Job, o: R) => { expect(byInvoice.get(a.id)).toMatchObject(o); };
      // The mapping precedence: sync UNKNOWN wins; otherwise the outbox status (DONE -> CREATED, PENDING/DISPATCHING
      // mirrored, FAILED -> FAILED). Key and created_at come from the write; number and tenant come from its payload.
      expectRow(jobs.pending, { generation: 1, status: 'PENDING', key: jobs.pending.key, xero_invoice_number: jobs.pending.payload.xero_invoice_number, tenant_id: TENANT });
      expectRow(jobs.dispatching, { generation: 1, status: 'DISPATCHING', key: jobs.dispatching.key, tenant_id: TENANT });
      expectRow(jobs.done, { generation: 1, status: 'CREATED', key: jobs.done.key, xero_invoice_id: String((await k.state(jobs.done)).xero_link), tenant_id: TENANT });
      expectRow(jobs.retry, { generation: 1, status: 'FAILED', key: jobs.retry.key, tenant_id: TENANT });
      expectRow(jobs.dead, { generation: 1, status: 'FAILED', key: jobs.dead.key, xero_invoice_number: jobs.dead.payload.xero_invoice_number, tenant_id: TENANT });
      expectRow(jobs.unknown, { generation: 1, status: 'UNKNOWN', key: jobs.unknown.key, tenant_id: TENANT });
      for (const r of ledger) expect(r.created_at).toBe(r.outbox_created);
      expect(byInvoice.get(jobs.done.id)!.xero_invoice_id).toBe(uuidFor(`xero:${jobs.done.id}`));   // the verified link's Xero InvoiceID

      // Rerunning the backfill inserts no new rows and changes no existing row.
      const inserted = (await db.query<{ n: number }>(`select invoice_xero_draft_generations_backfill() n`))[0]!.n;
      expect(inserted).toBe(0);
      const after = await db.query<R>(`select to_jsonb(g)::text v from invoice_xero_draft_generations g order by g.invoice_id`);
      const rerun = await db.query<R>(`select to_jsonb(g)::text v from invoice_xero_draft_generations g order by g.invoice_id`);
      expect(rerun.map((r) => r.v)).toEqual(after.map((r) => r.v));
    }, 120_000);

    it('VAL-GEN-011: the migration changed no invoice, outbox, observation, approval or audit row, and created no invoice or outbox row', async () => {
      const after = await k.fingerprint();
      expect(after).toEqual(before);                                      // identical counts and content md5 per table
    }, 120_000);
  });

  // --------------------------------------------------------------------------------------------------------------
  // Ledger maintenance for new writes, through the real approval and side-effect path.
  // --------------------------------------------------------------------------------------------------------------
  describe('the ledger tracks a new write', () => {
    let db: Db;
    let k: ReturnType<typeof kit>;
    beforeEach(async () => {
      db = await migratedDb(target);
      await importBundle(db);
      await pinTenant(db);
      k = kit(db, rows, seq);
    }, 120_000);
    afterEach(async () => { await db.close(); });

    it('VAL-GEN-002: a first-time draft opens generation 1 and goes PENDING -> DISPATCHING -> CREATED with the Xero InvoiceID, number and tenant', async () => {
      const a = await k.approve('PRJ-2026-0004');
      expect(a.key).toBe(`xero:invoice:${a.id}`);                                            // the legacy key for generation 1
      expect(await k.ledger(a.id)).toMatchObject([{ generation: 1, status: 'PENDING', key: a.key, xero_invoice_id: null, xero_invoice_number: a.payload.xero_invoice_number,
        tenant_id: TENANT, opened_by: 'workflow', approval_id: a.approvalId, superseded_at: null }]);
      expect(await k.state(a)).toMatchObject({ sync_status: 'PENDING', outbox_status: 'PENDING', xero_link: null });

      expect(await k.claim(a.key, 'w1')).toMatchObject({ claimed: true });
      expect(await k.ledger(a.id)).toMatchObject([{ status: 'DISPATCHING' }]);

      expect(await k.complete(a)).toMatchObject({ status: 'RECORDED' });
      const [row] = await k.ledger(a.id);
      expect(row).toMatchObject({ status: 'CREATED', xero_invoice_id: String((await k.state(a)).xero_link), xero_invoice_number: a.payload.xero_invoice_number, tenant_id: TENANT });

      // No other invoice gains a ledger row.
      expect(await col(db, `select count(*)::text v from invoice_xero_draft_generations`)).toEqual(['1']);
    }, 120_000);

    it('VAL-GEN-002: a retryable failure mirrors FAILED while the retry is pending, then DISPATCHING -> CREATED as the write progresses', async () => {
      const a = await k.approve('PRJ-2026-0005');
      expect(await k.claim(a.key, 'w1')).toMatchObject({ claimed: true });
      expect(await k.fail(a.key, 'NETWORK', 'search by invoice number', 'ECONNRESET')).toMatchObject({ retry: true });
      expect(await k.state(a)).toMatchObject({ sync_status: 'PENDING', outbox_status: 'FAILED', dead: false });
      expect(await k.ledger(a.id)).toMatchObject([{ status: 'FAILED' }]);                     // the write is closed, nothing was created

      await k.retryDue(a.key);
      expect(await k.claim(a.key, 'w2')).toMatchObject({ claimed: true });
      expect(await k.ledger(a.id)).toMatchObject([{ status: 'DISPATCHING' }]);                // it is being written again
      expect(await k.complete(a)).toMatchObject({ status: 'RECORDED' });
      expect(await k.ledger(a.id)).toMatchObject([{ status: 'CREATED', xero_invoice_id: String((await k.state(a)).xero_link) }]);
    }, 120_000);

    it('VAL-GEN-002: a dead-lettered write shows FAILED, and the invoice sync state is recorded truthfully', async () => {
      const a = await k.approve('PRJ-2026-0002');
      expect(await k.claim(a.key, 'w1')).toMatchObject({ claimed: true });
      expect(await k.fail(a.key, 'VALIDATION_ERROR', 'create contact', 'Xero refused the contact', 400)).toMatchObject({ retry: false });
      expect(await k.state(a)).toMatchObject({ sync_status: 'FAILED', outbox_status: 'FAILED', dead: true });
      expect(await k.ledger(a.id)).toMatchObject([{ status: 'FAILED', xero_invoice_id: null }]);
    }, 120_000);

    it('VAL-GEN-009: an ambiguous write records UNKNOWN in the ledger and the invoice sync, is never CREATED or FAILED, and never links', async () => {
      const a = await k.approve('PRJ-2026-0001');
      expect(await k.claim(a.key, 'w1')).toMatchObject({ claimed: true });
      expect(await k.fail(a.key, 'TIMEOUT', 'create draft invoice', 'ETIMEDOUT after 20s')).toMatchObject({ retry: true });
      expect(await k.state(a)).toMatchObject({ sync_status: 'UNKNOWN', outbox_status: 'FAILED' });
      expect(await k.ledger(a.id)).toMatchObject([{ status: 'UNKNOWN' }]);                    // may exist: never success, never a safe failure

      for (let i = 0; i < 4; i++) {                                                           // the uncertain dead letter stays UNKNOWN
        await k.retryDue(a.key);
        expect(await k.claim(a.key, `w${String(i + 2)}`)).toMatchObject({ claimed: true });
        await k.fail(a.key, 'RATE_LIMITED', 'search by invoice number', 'HTTP 429', 429);
      }
      expect(await k.state(a)).toMatchObject({ sync_status: 'UNKNOWN', outbox_status: 'FAILED', dead: true, xero_link: null });
      expect(await k.ledger(a.id)).toMatchObject([{ status: 'UNKNOWN', xero_invoice_id: null }]);
    }, 120_000);
  });

  // --------------------------------------------------------------------------------------------------------------
  // What Postgres itself refuses.
  // --------------------------------------------------------------------------------------------------------------
  describe('database-enforced invariants', () => {
    let db: Db;
    let k: ReturnType<typeof kit>;
    let a: Job;
    beforeEach(async () => {
      db = await migratedDb(target);
      await importBundle(db);
      await pinTenant(db);
      k = kit(db, rows, seq);
      a = await k.approve('PRJ-2026-0004');               // one queued generation-1 draft write exists
    }, 120_000);
    afterEach(async () => { await db.close(); });

    it('VAL-GEN-003: PostgreSQL rejects a second live draft write per invoice, a duplicate generation, and a second non-superseded ledger row - with the exact names', async () => {
      await k.rejects(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, status, generation)
        values ('xero.create_draft_invoice', 'invoice', '${a.id}', gen_random_uuid(), 'gen:second-live', '{}'::jsonb, 'PENDING', 2)`,
        /outbox_one_live_draft_per_invoice/);                                                    // (the first write is still PENDING)
      await k.rejects(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, status, generation)
        values ('xero.create_draft_invoice', 'invoice', '${a.id}', gen_random_uuid(), 'gen:dup-generation', '{}'::jsonb, 'PENDING', 1)`,
        /outbox_one_row_per_draft_generation/);
      await k.rejects(`insert into invoice_xero_draft_generations (invoice_id, generation, status, outbox_idempotency_key)
        values ('${a.id}', 2, 'PENDING', 'gen:ledger-second-live')`,
        /invoice_xero_draft_generations_one_live/);
      await k.rejects(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, status, generation)
        values ('xero.create_draft_invoice', 'invoice', '${a.id}', gen_random_uuid(), 'gen:negative', '{}'::jsonb, 'PENDING', 0)`,
        /outbox_generation_positive/);
      // A claimed (DISPATCHING) write is live too, and a DONE row stops blocking a replacement generation.
      expect(await k.claim(a.key, 'w1')).toMatchObject({ claimed: true });
      await k.rejects(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, status, generation)
        values ('xero.create_draft_invoice', 'invoice', '${a.id}', gen_random_uuid(), 'gen:second-live-2', '{}'::jsonb, 'PENDING', 3)`,
        /outbox_one_live_draft_per_invoice/);
      expect(await k.complete(a)).toMatchObject({ status: 'RECORDED' });
      await db.query(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, status, generation)
        values ('xero.create_draft_invoice', 'invoice', $1, gen_random_uuid(), xero_draft_outbox_key($1, 2), '{}'::jsonb, 'FAILED', 2)`, [a.id]);
      expect(await col(db, `select status v from outbox where idempotency_key = xero_draft_outbox_key($1, 2)`, [a.id])).toEqual(['FAILED']);
    }, 120_000);

    it('VAL-GEN-004: a duplicate (invoice_id, generation) ledger row is rejected, and the SUPERSEDED state is consistent by constraint', async () => {
      await k.rejects(`insert into invoice_xero_draft_generations (invoice_id, generation, status, outbox_idempotency_key)
        values ('${a.id}', 1, 'PENDING', 'gen:dup')`, /invoice_xero_draft_generations_invoice_id_generation_key/);
      await k.rejects(`insert into invoice_xero_draft_generations (invoice_id, generation, status, outbox_idempotency_key)
        values ('${a.id}', 3, 'SUPERSEDED', 'gen:superseded-without-at')`,
        /invoice_xero_draft_generations_superseded_consistency/);
      await k.rejects(`insert into invoice_xero_draft_generations (invoice_id, generation, status, outbox_idempotency_key)
        values ('${a.id}', 4, 'LIVEISH', 'gen:bad-status')`, /invoice_xero_draft_generations_status_check/);
      // A properly superseded row does not count against the one-live rule.
      await db.query(`update invoice_xero_draft_generations set status = 'SUPERSEDED', superseded_at = now(), superseded_reason = 'test' where invoice_id = $1 and generation = 1`, [a.id]);
      await db.query(`insert into invoice_xero_draft_generations (invoice_id, generation, status, outbox_idempotency_key)
        values ($1, 2, 'PENDING', xero_draft_outbox_key($1, 2))`, [a.id]);
      expect(await col(db, `select count(*)::text v from invoice_xero_draft_generations where invoice_id = $1`, [a.id])).toEqual(['2']);
    }, 120_000);
  });

  // --------------------------------------------------------------------------------------------------------------
  // Generation-aware idempotency keys.
  // --------------------------------------------------------------------------------------------------------------
  describe('generation-aware idempotency keys', () => {
    let db: Db;
    let k: ReturnType<typeof kit>;
    let a: Job;
    beforeEach(async () => {
      db = await migratedDb(target);
      await importBundle(db);
      await pinTenant(db);
      k = kit(db, rows, seq);
      a = await k.approve('PRJ-2026-0004');
    }, 120_000);
    afterEach(async () => { await db.close(); });

    it('VAL-GEN-005: generation 1 is byte-identical to the legacy keys, generation >= 2 is new, and every writer uses the helpers', async () => {
      expect(a.key).toBe(`xero:invoice:${a.id}`);
      expect(a.payload.xero_idempotency_key).toBe(`roofops-${a.id}`);
      const keys = await k.one(`select xero_draft_outbox_key($1, 1) k1, xero_draft_outbox_key($1, 2) k2, xero_draft_outbox_key($1, 7) k7,
          xero_draft_provider_key($1, 1) p1, xero_draft_provider_key($1, 2) p2, xero_draft_provider_key($1, 7) p7`, [a.id]);
      expect(keys).toEqual({ k1: `xero:invoice:${a.id}`, k2: `xero:invoice:${a.id}:g2`, k7: `xero:invoice:${a.id}:g7`,
        p1: `roofops-${a.id}`, p2: `roofops-${a.id}-g2`, p7: `roofops-${a.id}-g7` });
      expect(keys.k1).toBe(a.key);                                                                 // the queued row equals the helper output
      expect(keys.p1).toBe(a.payload.xero_idempotency_key);
      const all = [keys.k1, keys.k2, keys.k7, keys.p1, keys.p2, keys.p7];
      expect(new Set(all).size).toBe(all.length);                                                  // no two generations share a key

      // The keys are unique in the database: a second row carrying the generation-1 key is refused.
      await k.rejects(`insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, status, generation)
        values ('xero.create_draft_invoice', 'invoice', '${a.id}', gen_random_uuid(), xero_draft_outbox_key('${a.id}', 1), '{}'::jsonb, 'FAILED', 2)`,
        /outbox_idempotency_key_key/);

      // The writer composes no draft key by hand: the live function body calls the helpers and contains no key literal.
      const [src] = await db.query<{ v: string }>(`select prosrc v from pg_proc where proname = 'wf_invoice_decide_core'`);
      expect(src!.v).toContain('xero_draft_outbox_key(');
      expect(src!.v).toContain('xero_draft_provider_key(');
      expect(src!.v).not.toContain('xero:invoice:');
      expect(src!.v).not.toContain("'roofops-'");
    }, 120_000);
  });

  // --------------------------------------------------------------------------------------------------------------
  // With two generations present: history kept, the current generation used, the superseded identity inert.
  // --------------------------------------------------------------------------------------------------------------
  describe('a superseded generation is history', () => {
    let db: Db;
    let k: ReturnType<typeof kit>;
    let a: Job;
    beforeEach(async () => {
      db = await migratedDb(target);
      await importBundle(db);
      await pinTenant(db);
      k = kit(db, rows, seq);
      a = await k.approve('PRJ-2026-0004');
      expect(await k.claim(a.key, 'w1')).toMatchObject({ claimed: true });
      expect(await k.complete(a)).toMatchObject({ status: 'RECORDED' });     // generation 1 is CREATED with a verified link
    }, 120_000);
    afterEach(async () => { await db.close(); });

    it('VAL-GEN-006: the superseded generation keeps its Xero InvoiceID, number, tenant and reason, and no history row is lost', async () => {
      const oldLink = String((await k.state(a)).xero_link);
      const counts = await k.one(`select (select count(*) from outbox)::int outbox, (select count(*) from audit_events)::int audit,
        (select count(*) from approvals)::int approvals, (select count(*) from xero_invoice_observations)::int observations`);
      const { gen2, newXid, replacementNumber } = await k.supersede(a, { replacementNumber: `${String(a.payload.xero_invoice_number)}-R`, complete: true });

      const rowsNow = await k.ledger(a.id);
      expect(rowsNow).toHaveLength(2);
      expect(rowsNow[0]).toMatchObject({ generation: 1, status: 'SUPERSEDED', xero_invoice_id: oldLink, xero_invoice_number: a.payload.xero_invoice_number,
        tenant_id: TENANT, superseded_reason: expect.stringMatching(/supervised reissue/) as unknown });
      expect(rowsNow[0]!.superseded_at).not.toBeNull();
      expect(rowsNow[1]).toMatchObject({ generation: 2, status: 'CREATED', xero_invoice_id: newXid, xero_invoice_number: replacementNumber });

      // The current identity moved; the old Xero InvoiceID is still queryable from the ledger and the observations.
      expect((await k.state(a)).xero_link).toBe(newXid);
      expect(await col(db, `select xero_invoice_id v from invoice_xero_draft_generations where invoice_id = $1 and generation = 1`, [a.id])).toEqual([oldLink]);
      expect(await col(db, `select distinct xero_invoice_id v from xero_invoice_observations where invoice_id = $1 and xero_invoice_id = $2`, [a.id, oldLink])).toEqual([oldLink]);
      expect(await col(db, `select idempotency_key v from outbox where aggregate_id = $1 order by generation`, [a.id])).toEqual([a.key, gen2.key]);

      // Nothing was deleted or rewritten: every outbox, approval, observation and audit row from before is still there.
      const countsNow = await k.one(`select (select count(*) from outbox)::int outbox, (select count(*) from audit_events)::int audit,
        (select count(*) from approvals)::int approvals, (select count(*) from xero_invoice_observations)::int observations`);
      expect(countsNow.outbox).toBe(Number(counts.outbox) + 1);            // the replacement write
      expect(countsNow.audit).toBe(Number(counts.audit));
      expect(countsNow.approvals).toBe(Number(counts.approvals));
      expect(countsNow.observations).toBe(Number(counts.observations) + 1); // the verified deletion that motivated the reissue

      // Rerunning the backfill still changes nothing - not even the superseded row.
      expect((await db.query<{ n: number }>(`select invoice_xero_draft_generations_backfill() n`))[0]!.n).toBe(0);
      expect((await k.ledger(a.id))[0]).toMatchObject({ generation: 1, status: 'SUPERSEDED', xero_invoice_id: oldLink });

      // The Airtable projection is written only while the canonical invoice state is stable, and it projects the
      // CURRENT generation: the replacement's number and the link that moved to the replacement's Xero InvoiceID.
      const expected = await k.one(`select expected e from v_airtable_expected where record_id = $1`, [recFor('PRJ-2026-0004')]);
      expect((expected.e as R)).toMatchObject({ fldgkN0Vm6k1MZLJp: replacementNumber, fld3sDI9LIX8Voo4u: newXid });
    }, 120_000);

    it('VAL-GEN-007: every replaced lookup reads the current generation, and a local void with two generations refuses without a multi-row error', async () => {
      await k.supersede(a, { replacementNumber: `${String(a.payload.xero_invoice_number)}-R`, verifiedDeletion: false });
      const gen2 = await k.one(`select generation, idempotency_key key from outbox_current('xero.create_draft_invoice', $1)`, [a.id]);
      expect(gen2).toMatchObject({ generation: 2, key: `xero:invoice:${a.id}:g2` });

      // No scalar lookup errors with two rows; each reports the CURRENT generation's number, not an arbitrary row.
      const xeroState = await k.one(`select invoice_xero_state($1) s`, [a.id]);
      expect(xeroState.s).toMatchObject({ xero_invoice_number: `${String(a.payload.xero_invoice_number)}-R`, sync_status: 'PENDING' });
      // The projection is empty mid-flight (the invoice is not SYNCED): no invoice fields at all, and no multi-row error.
      const expected = await k.one(`select expected e from v_airtable_expected where record_id = $1`, [recFor('PRJ-2026-0004')]);
      expect((expected.e as R).fldgkN0Vm6k1MZLJp).toBeUndefined();
      const targets = await k.q1(`select wf_reconcile_targets($1) r`, [await k.startRun('observe')]);
      expect(targets.xero_uncertain).toEqual([]);                           // sync PENDING: nothing uncertain to look up

      // A local void with a replacement queued: refused as documented - never "more than one row returned".
      const attempt = await db.query(`update invoices set status = 'VOIDED', voided_reason = 'local void attempt' where id = $1`, [a.id])
        .then(() => 'voided' as const, (e: unknown) => (e as Error).message);
      expect(attempt).toMatch(/cannot be voided: its Xero draft (exists|is queued)/);
      expect(attempt).not.toMatch(/more than one row/);
      expect(await k.state(a)).toMatchObject({ status: 'APPROVED', sync_status: 'PENDING' });

      // 05's claim of the queued replacement behaves per the current generation: it claims it (no multi-row error).
      const gen2Job: Job = { ...a, key: `xero:invoice:${a.id}:g2` };
      expect(await k.claim(gen2Job.key, 'w2')).toMatchObject({ claimed: true });
      expect(await k.ledger(a.id)).toMatchObject([{ generation: 1, status: 'SUPERSEDED' }, { generation: 2, status: 'DISPATCHING' }]);

      // The AC-14C-A void exemption survives with a superseded generation present: when the linked document was verified
      // deleted in Xero (the reason for the reissue), the local void follows Xero - and no history row is touched.
      const b = await k.approve('PRJ-2026-0001');
      expect(await k.claim(b.key, 'w1')).toMatchObject({ claimed: true });
      expect(await k.complete(b)).toMatchObject({ status: 'RECORDED' });
      const { oldLink } = await k.supersede(b);
      await db.query(`update invoices set status = 'VOIDED', voided_reason = 'deleted in Xero, verified by reconciliation' where id = $1`, [b.id]);
      expect(await k.state(b)).toMatchObject({ status: 'VOIDED', voided_reason: 'deleted in Xero, verified by reconciliation' });
      expect(await k.ledger(b.id)).toHaveLength(2);
      expect(await col(db, `select xero_invoice_id v from invoice_xero_draft_generations where invoice_id = $1 and generation = 1`, [b.id])).toEqual([oldLink]);
    }, 120_000);

    it('VAL-GEN-008: a superseded Xero InvoiceID is discounted - a lookup that returns only it proves the replacement absent, and no read of it changes the invoice', async () => {
      const { oldLink, replacementNumber } = await k.supersede(a);
      const gen2: Job = { ...a, key: `xero:invoice:${a.id}:g2`, payload: { ...a.payload, xero_invoice_number: replacementNumber } };
      // The replacement write's create answer was lost, then it dead-lettered: the invoice stays UNKNOWN.
      expect(await k.claim(gen2.key, 'w2')).toMatchObject({ claimed: true });
      expect(await k.fail(gen2.key, 'TIMEOUT', 'create draft invoice', 'ETIMEDOUT after 20s')).toMatchObject({ retry: true });
      for (let i = 0; i < 4; i++) {
        await k.retryDue(gen2.key);
        expect(await k.claim(gen2.key, `w${String(i + 3)}`)).toMatchObject({ claimed: true });
        await k.fail(gen2.key, 'RATE_LIMITED', 'search by invoice number', 'HTTP 429', 429);
      }
      expect(await k.state(gen2)).toMatchObject({ sync_status: 'UNKNOWN', outbox_status: 'FAILED', dead: true });

      // 07's targets: the current (uncertain) generation only.
      const run = await k.startRun('repair');
      const targets = await k.q1(`select wf_reconcile_targets($1) r`, [run]);
      expect(targets.xero_uncertain).toEqual([expect.objectContaining({ key: gen2.key })]);

      // Xero answers the replacement's lookups with only the OLD document (deleted): proof of absence of the new one.
      const oldDoc = { InvoiceID: oldLink, InvoiceNumber: replacementNumber, Reference: a.payload.reference, Type: 'ACCREC', Status: 'DELETED',
        Total: a.payload.amount_inc_gst, TotalTax: a.payload.gst_amount, AmountPaid: 0, CurrencyCode: 'AUD', LineAmountTypes: 'Inclusive',
        Contact: { ContactID: uuidFor(`contact:${String(a.payload.customer_id)}`) } };
      const settled = await k.q1(`select wf_reconcile_xero_uncertain($1, $2::jsonb) r`, [run, JSON.stringify([
        { key: gen2.key, invoice_number: a.invoice, tenant_id: TENANT, http_number: 200, http_reference: 200, by_number: [oldDoc], by_reference: [oldDoc] }])]);
      expect(settled.items).toEqual([expect.objectContaining({ outcome: 'PROVEN_ABSENT' })]);
      expect(await k.state(gen2)).toMatchObject({ status: 'APPROVED', sync_status: 'FAILED', xero_link: oldLink });   // failed safely, never linked

      // A settlement read of the superseded document applies nothing (the invoice is not SYNCED in its current generation).
      const run2 = await k.startRun('repair');
      await k.q1(`select xero_record_settlement($1, $2::jsonb) r`, [run2, JSON.stringify([{ invoice_id: oldLink, xero_invoice_number: replacementNumber,
        tenant_id: TENANT, http: 200, xero: { ...oldDoc, Status: 'DELETED', AmountDue: 0 } }])]);
      expect(await k.state(gen2)).toMatchObject({ status: 'APPROVED', voided_reason: null, xero_link: oldLink });
      // The superseded identity is still retrievable after everything above.
      expect(await col(db, `select xero_invoice_id v from invoice_xero_draft_generations where invoice_id = $1 and generation = 1`, [a.id])).toEqual([oldLink]);
    }, 120_000);

    it('VAL-GEN-010: integrity stays green with a superseded generation, and done_has_proof applies to the current generation only', async () => {
      expect(await col(db, `select check_key v from integrity_check() where status = 'FAIL'`)).toEqual([]);
      await k.supersede(a);                                                  // gen 1 CREATED+SUPERSEDED, gen 2 queued: history, not proof-by-sync
      expect(await col(db, `select check_key v from integrity_check() where status = 'FAIL'`)).toEqual([]);
      const gen2: Job = { ...a, key: `xero:invoice:${a.id}:g2` };
      expect(await k.claim(gen2.key, 'w2')).toMatchObject({ claimed: true });
      await expect(k.complete(gen2, { invoice_id: uuidFor(`replacement:${a.id}`) }))
        .rejects.toThrow(/already linked to Xero invoice/);                   // B1 cannot move the link yet (Part B2 does)
      expect(await col(db, `select check_key v from integrity_check() where status = 'FAIL'`)).toEqual([]);
    }, 120_000);
  });
});
