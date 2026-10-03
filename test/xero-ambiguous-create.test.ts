/**
 * AC-04 (docs/adversarial-test-catalogue.md): a Xero draft that really exists must never be recorded as never created.
 * Reproduced: after a lost create response (TIMEOUT -> UNKNOWN), a later RATE_LIMITED reset the invoice to PENDING and
 * the final failure dead-lettered it to FAILED ("failed safely"), while reconciliation only ever read invoices that
 * already had a Xero link, so the draft was never found; AC-05 then allowed a void, and a re-queue could bill twice.
 *
 * Rule: a timeout or transport failure after the create request may have created the draft. From then on the invoice
 * stays UNKNOWN ("may exist in Xero") until a read of Xero proves presence or absence:
 *  * 05's failures are judged by step and class: before the create request = no new evidence; the create definitely
 *    refused by Xero (4xx / validation) = absent; the create with a lost answer, anything after it (read-back, verify,
 *    record) and a conflicting search (reconcile) = may exist. Nothing but proof of absence leaves UNKNOWN, and an
 *    uncertain dead letter stays UNKNOWN with one AMBIGUOUS_WRITE exception.
 *  * Reconciliation (07) also targets uncertain writes, looks them up by their deterministic Xero invoice number and by
 *    reference in the bound (pinned) tenant, and settles them: exactly one matching draft -> linked, SYNCED; none at
 *    all -> proven absent (retry permitted); anything else -> a person decides, never a guess. Repair mode only.
 * The Xero side is faked here: no Xero call is made.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { InvoiceRows } from './helpers/airtable04.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const APPROVER = 'usr7uCnNO15fCefbH';
const A = '11111111-2222-3333-4444-555555555555';   // the pinned (and bound) tenant
const B = '99999999-8888-7777-6666-555555555555';   // some other tenant
const uuidFor = (seed: string) => createHash('md5').update(seed).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;
type Job = { project: string; invoice: string; id: string; key: string; payload: R };

describe.each(TARGETS)('AC-04: an ambiguous Xero create is never recorded as never created [%s]', (target) => {
  const rows = new InvoiceRows();
  let n = 0;
  const kit = (db: Db) => {
    const q1 = async (sql: string, p: unknown[] = []) => (await db.query<{ r: R }>(sql, p))[0]!.r;
    const approve = async (project: string): Promise<Job> => {
      const ev = (type: string, dt = 0) => ({ event_id: `EVT-AC04-${String(++n)}`, event_type: type, source: 'airtable', actor_id: APPROVER,
        occurred_at: new Date(Date.now() + dt).toISOString(), payload: { project_number: project, airtable_record_id: recFor(project) } });
      expect(await rows.send(db, ev('invoice.prepare_requested'), 'n8n:test')).toMatchObject({ outcome: 'PREVIEW_READY' });
      const r = await rows.send(db, ev('invoice.approved', 1000), 'n8n:test');
      expect(r).toMatchObject({ outcome: 'APPROVED' });
      const [job] = await db.query<{ key: string; payload: R }>(`select idempotency_key key, payload from outbox where aggregate_id = $1`, [r.invoice_id]);
      return { project, invoice: String(r.invoice_number), id: String(r.invoice_id), key: job!.key, payload: job!.payload };
    };
    const claim = (a: Job, w: string) => q1(`select wf_claim_side_effect($1, $2, 120) r`, [a.key, w]);
    /** What 05's "Record Xero Failure" sends: the message always starts with the step. */
    const fail = (a: Job, cls: string, step: string, msg: string, http: number | null = null) =>
      q1(`select wf_fail_side_effect($1, $2, $3, $4, 0) r`, [a.key, cls, `${step}: ${msg}`, http]);
    /** Make a scheduled retry due now, and claim it. */
    const retry = async (a: Job, w: string) => {
      await db.query(`update outbox set next_attempt_at = now() where idempotency_key = $1 and status = 'FAILED' and next_attempt_at <> 'infinity'`, [a.key]);
      return claim(a, w);
    };
    /** A Xero invoice as GET /Invoices returns it (fake). */
    const xinv = (a: Job, o: R = {}) => ({ InvoiceID: uuidFor(`xero:${a.id}:${JSON.stringify(o)}`), InvoiceNumber: a.payload.xero_invoice_number, Reference: a.payload.reference,
      Type: 'ACCREC', Status: 'DRAFT', Total: a.payload.amount_inc_gst, TotalTax: a.payload.gst_amount, AmountPaid: 0, SentToContact: false, CurrencyCode: 'AUD',
      LineAmountTypes: 'Inclusive', Contact: { ContactID: uuidFor(`contact:${String(a.payload.customer_id)}`), Name: a.payload.xero_contact_name }, ...o });
    /** What 05 sends after reading its own draft back. */
    const proof = (a: Job, x: R, matching = 1) => ({ verified: true, tenant_id: A, organisation_class: 'DEMO', invoice_id: x.InvoiceID, invoice_number: x.InvoiceNumber,
      reference: x.Reference, status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false, contact_id: (x.Contact as R).ContactID,
      contact_number: a.payload.xero_contact_number, total: x.Total, total_tax: x.TotalTax, currency: 'AUD', line_amount_types: 'Inclusive', matching_invoices: matching });
    const complete = (a: Job, p: R) => q1(`select wf_complete_side_effect($1, $2::jsonb) r`, [a.key, JSON.stringify(p)]);
    /** What 07 sends for one uncertain write: its deterministic lookups (by number, by reference) in the given tenant. */
    const lookup = (a: Job, xero: R[], tenant = A, http = 200) => ({ key: a.key, invoice_number: a.invoice, tenant_id: tenant, http,
      by_number: xero.filter((x) => x.InvoiceNumber === a.payload.xero_invoice_number), by_reference: xero.filter((x) => x.Reference === a.payload.reference) });
    /** One 07 run: start (mode), settle the given lookups, finish. */
    const reconcile = async (lookups: R[], mode: 'repair' | 'observe' = 'repair') => {
      await db.exec(`update reconciliation_runs set started_at = started_at - interval '10 minutes', status = case when status = 'RUNNING' then 'FAILED' else status end`);
      const start = await q1(`select wf_reconcile_start('schedule', $1) r`, [mode]);
      expect(start).toMatchObject({ started: true });
      const targets = await q1(`select wf_reconcile_targets($1) r`, [start.run_key]);
      const res = await q1(`select wf_reconcile_xero_uncertain($1, $2::jsonb) r`, [start.run_key, JSON.stringify(lookups)]);
      return { run: String(start.run_key), targets, res };
    };
    const state = async (a: Job) => (await db.query<R>(`select i.status invoice, i.sync_status, o.status outbox, o.attempts, o.next_attempt_at = 'infinity' dead,
        ap.status approval,
        (select external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id) xero_link
        from invoices i join outbox o on o.aggregate_id = i.id join approvals ap on ap.id = i.approval_id where i.id = $1`, [a.id]))[0]!;
    const openExceptions = (a: Job) => col(db, `select error_class || ' ' || error_message v from workflow_exceptions
        where business_reference in ($1, $2) and resolution_status in ('OPEN', 'RETRY_QUEUED') order by created_at`, [a.invoice, a.project]);
    const voidIt = (a: Job) => db.query(`update invoices set status = 'VOIDED', voided_reason = 'Customer cancelled the job' where id = $1`, [a.id])
      .then(() => true as const, (e: unknown) => (e as Error).message);
    const changePin = (v: string) => db.query(`update app_settings set value = $1 where key = 'xero.demo_tenant_id'`, [v])
      .then(() => true as const, (e: unknown) => (e as Error).message);
    /** Lost create answer, then retries that fail before the create, until dead-lettered (5 attempts). */
    const ambiguousThenDead = async (a: Job) => {
      expect(await claim(a, 'w1')).toMatchObject({ claimed: true });
      expect(await fail(a, 'TIMEOUT', 'create draft invoice', 'ETIMEDOUT after 20s')).toMatchObject({ retry: true });
      for (const [i, [cls, step, http]] of ([['RATE_LIMITED', 'search by invoice number', 429], ['RATE_LIMITED', 'search by reference', 429],
        ['RATE_LIMITED', 'find contact', 429], ['UPSTREAM_5XX', 'list connections', 503]] as const).entries()) {
        expect(await retry(a, `w${String(i + 2)}`)).toMatchObject({ claimed: true });
        await fail(a, cls, step, `HTTP ${String(http)}`, http);
      }
      expect(await state(a)).toMatchObject({ outbox: 'FAILED', dead: true, attempts: 5 });
    };
    return { q1, approve, claim, fail, retry, xinv, proof, complete, lookup, reconcile, state, openExceptions, voidIt, changePin, ambiguousThenDead };
  };
  const setup = async () => {
    const db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`update app_settings set value = '${A}' where key = 'xero.demo_tenant_id';
                   insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
    return db;
  };

  describe('what a failure proves', () => {
    let db: Db;
    let k: ReturnType<typeof kit>;
    beforeAll(async () => { db = await setup(); k = kit(db); }, 120_000);
    afterAll(async () => { await db.close(); });

    it('1. a failure before the create request reaches Xero schedules a safe retry; the invoice stays PENDING', async () => {
      const a = await k.approve('PRJ-2026-0004');
      expect(await k.claim(a, 'w1')).toMatchObject({ claimed: true });
      expect(await k.fail(a, 'NETWORK', 'search by invoice number', 'ECONNRESET')).toMatchObject({ retry: true });
      expect(await k.state(a)).toMatchObject({ sync_status: 'PENDING', outbox: 'FAILED', dead: false });
    });

    it('2. Xero definitely refusing the create (after a clean search) is a safe failure: FAILED, even after an earlier ambiguous attempt', async () => {
      const a = await k.approve('PRJ-2026-0005');
      expect(await k.claim(a, 'w1')).toMatchObject({ claimed: true });
      expect(await k.fail(a, 'TIMEOUT', 'create draft invoice', 'ETIMEDOUT after 20s')).toMatchObject({ retry: true });
      expect((await k.state(a)).sync_status).toBe('UNKNOWN');
      // The retry searched (nothing found: it went on to create) and Xero refused the create outright.
      expect(await k.retry(a, 'w2')).toMatchObject({ claimed: true });
      expect(await k.fail(a, 'VALIDATION_ERROR', 'create draft invoice', 'Account code 200 is archived', 400)).toMatchObject({ retry: false });
      expect(await k.state(a)).toMatchObject({ sync_status: 'FAILED', outbox: 'FAILED', dead: true, approval: 'EXECUTION_FAILED', xero_link: null });
    });

    it('2b. only Xero\'s explicit refusal of the create request (its own HTTP 4xx / 429) proves absence; anything RoofOps cannot prove was refused stays UNKNOWN', async () => {
      const evidence = async (cls: string, msg: string, http: number | null) =>
        (await col(db, `select xero_failure_evidence($1, $2, $3) v`, [cls, msg, http]))[0];
      expect(await evidence('RATE_LIMITED', 'create draft invoice: HTTP 429', 429)).toBe('ABSENT');
      expect(await evidence('VALIDATION_ERROR', 'create draft invoice: Account code 200 is archived', 400)).toBe('ABSENT');
      expect(await evidence('AUTH_FAILURE', 'create draft invoice: unauthorised', 401)).toBe('ABSENT');
      // 05's refuse() for a 200 answer without an InvoiceID carries no HTTP status: not provably refused.
      expect(await evidence('VALIDATION_ERROR', 'create draft invoice: response had no InvoiceID', null)).toBe('MAY_EXIST');
      expect(await evidence('RATE_LIMITED', 'create draft invoice: HTTP 429', null)).toBe('MAY_EXIST');
      expect(await evidence('UPSTREAM_5XX', 'create draft invoice: HTTP 502', 502)).toBe('MAY_EXIST');
      expect(await evidence('TIMEOUT', 'create draft invoice: ETIMEDOUT', 408)).toBe('MAY_EXIST');   // a timeout class is never a refusal
      expect(await evidence('NETWORK', 'create draft invoice: ECONNRESET', null)).toBe('MAY_EXIST');
    });

    it('3. Xero creates the draft and the answer arrives: SYNCED as before', async () => {
      const a = await k.approve('PRJ-2026-0002');
      expect(await k.claim(a, 'w1')).toMatchObject({ claimed: true });
      const x = k.xinv(a);
      expect(await k.complete(a, k.proof(a, x))).toMatchObject({ status: 'RECORDED' });
      expect(await k.state(a)).toMatchObject({ sync_status: 'SYNCED', outbox: 'DONE', approval: 'EXECUTED', xero_link: x.InvoiceID });
    });

    it('4. the create answer is lost: UNKNOWN, kept through later failures of any class and through the dead letter; never FAILED', async () => {
      const a = await k.approve('PRJ-2026-0001');
      await k.ambiguousThenDead(a);
      expect(await k.state(a)).toMatchObject({ sync_status: 'UNKNOWN', approval: 'EXECUTING', xero_link: null });
      expect(await k.openExceptions(a)).toEqual(expect.arrayContaining([expect.stringMatching(
        new RegExp(`^AMBIGUOUS_WRITE .*${String(a.payload.xero_invoice_number)} may already exist in Xero`)) as unknown]));
    });
  });

  describe('failures after the create, and reconciliation of an uncertain write', () => {
    let db: Db;
    let k: ReturnType<typeof kit>;
    beforeAll(async () => { db = await setup(); k = kit(db); }, 120_000);
    afterAll(async () => { await db.close(); });

    it('4b. a failure after the create (read-back, verify, record) or a conflicting search means the draft may exist: UNKNOWN, not FAILED', async () => {
      const a = await k.approve('PRJ-2026-0004');
      expect(await k.claim(a, 'w1')).toMatchObject({ claimed: true });
      expect(await k.fail(a, 'RECONCILIATION_MISMATCH', 'verify read-back', 'GST 1333.13 != 1333.14')).toMatchObject({ retry: false });
      expect(await k.state(a)).toMatchObject({ sync_status: 'UNKNOWN', dead: true, approval: 'EXECUTING' });
      // Reconciliation finds exactly that one draft: 5. linked and recovered to SYNCED (repair mode only).
      const x = k.xinv(a);
      const dry = await k.reconcile([k.lookup(a, [x])], 'observe');
      expect(dry.targets.xero_uncertain).toEqual([expect.objectContaining({ key: a.key, invoice_number: a.invoice, tenant_id: A,
        xero_invoice_number: a.payload.xero_invoice_number, reference: a.project })]);
      expect(dry.res).toMatchObject({ ok: true, recovered: 0, items: [{ invoice_number: a.invoice, outcome: 'WOULD_RECOVER', applied: false }] });
      expect((await k.state(a)).sync_status).toBe('UNKNOWN');
      const run = await k.reconcile([k.lookup(a, [x])]);
      expect(run.res).toMatchObject({ ok: true, recovered: 1, items: [{ invoice_number: a.invoice, outcome: 'RECOVERED', applied: true }] });
      expect(await k.state(a)).toMatchObject({ sync_status: 'SYNCED', outbox: 'DONE', approval: 'EXECUTED', xero_link: x.InvoiceID });
      expect((await k.openExceptions(a)).filter((e) => e.startsWith('AMBIGUOUS_WRITE'))).toEqual([]);   // resolved, with an audit row
      expect(await col(db, `select action v from audit_events where entity_id = $1 and action in ('xero.invoice.draft_recovered', 'exception.resolved') order by seq`, [a.id]))
        .toContain('xero.invoice.draft_recovered');
    });

    it('6. reconciliation finds no draft at all: proven absent. A dead letter becomes FAILED (safe: retry permitted); a scheduled retry may go ahead (PENDING)', async () => {
      const dead = await k.approve('PRJ-2026-0005');
      await k.ambiguousThenDead(dead);
      const live = await k.approve('PRJ-2026-0002');
      expect(await k.claim(live, 'w1')).toMatchObject({ claimed: true });
      expect(await k.fail(live, 'TIMEOUT', 'create draft invoice', 'ETIMEDOUT after 20s')).toMatchObject({ retry: true });
      await db.query(`update outbox set next_attempt_at = now() + interval '1 hour' where idempotency_key = $1`, [live.key]);   // not due now
      const run = await k.reconcile([k.lookup(dead, []), k.lookup(live, [])]);
      expect(run.res).toMatchObject({ ok: true, proven_absent: 2 });
      expect(await k.state(dead)).toMatchObject({ sync_status: 'FAILED', dead: true, approval: 'EXECUTION_FAILED' });
      expect(await k.state(live)).toMatchObject({ sync_status: 'PENDING', outbox: 'FAILED', dead: false });
      // A lookup that failed proves nothing.
      const other = await k.approve('PRJ-2026-0001');
      await k.ambiguousThenDead(other);
      expect((await k.reconcile([k.lookup(other, [], A, 503)])).res).toMatchObject({ items: [{ outcome: 'LOOKUP_FAILED', applied: false }] });
      expect((await k.state(other)).sync_status).toBe('UNKNOWN');
    });

    it('7. several plausible drafts (or one that differs, or only a voided/deleted one): a person decides, nothing is linked or guessed', async () => {
      const a = await k.approve('PRJ-2026-0004').catch(() => null);
      expect(a).toBeNull();                                  // PRJ-2026-0004 is already invoiced in this database (4b)
      const [r] = await db.query<{ key: string; invoice: string; id: string; project: string; payload: R }>(`select o.idempotency_key key, i.invoice_number invoice,
          i.id::text id, p.project_number project, o.payload from invoices i join outbox o on o.aggregate_id = i.id join projects p on p.id = i.project_id
          where p.project_number = 'PRJ-2026-0001'`);
      const j = r as Job;
      expect((await k.state(j)).sync_status).toBe('UNKNOWN');
      const cases: [string, R[]][] = [
        ['two drafts with its number', [k.xinv(j), k.xinv(j, { InvoiceID: uuidFor('second') })]],
        ['another live invoice with its reference', [k.xinv(j), k.xinv(j, { InvoiceID: uuidFor('ref'), InvoiceNumber: 'INV-9999' })]],
        ['one draft that differs in total', [k.xinv(j, { Total: 1 })]],
        ['only a voided one', [k.xinv(j, { Status: 'VOIDED' })]],
        ['one that was sent to the customer', [k.xinv(j, { SentToContact: true })]],
      ];
      for (const [why, xero] of cases) {
        const run = await k.reconcile([k.lookup(j, xero)]);
        expect(run.res, why).toMatchObject({ needs_person: 1, items: [{ outcome: 'NEEDS_PERSON', applied: true }] });
        expect(await k.state(j), why).toMatchObject({ sync_status: 'UNKNOWN', xero_link: null });
      }
      expect((await k.openExceptions(j)).filter((e) => e.startsWith('REQUIRES_HUMAN') || e.startsWith('RECONCILIATION_MISMATCH')).length).toBeGreaterThan(0);
    });
  });

  describe('repeats, retries, and AC-05 / AC-06 during recovery', () => {
    let db: Db;
    let k: ReturnType<typeof kit>;
    beforeAll(async () => { db = await setup(); k = kit(db); }, 120_000);
    afterAll(async () => { await db.close(); });

    it('8. repeated reconciliation is idempotent: no second link, audit row or exception', async () => {
      const a = await k.approve('PRJ-2026-0004');
      await k.ambiguousThenDead(a);
      const x = k.xinv(a);
      expect((await k.reconcile([k.lookup(a, [x])])).res).toMatchObject({ recovered: 1 });
      const audits = async () => col(db, `select count(*)::text v from audit_events where entity_id = $1`, [a.id]);
      const before = { audits: await audits(), exceptions: await k.openExceptions(a) };
      const again = await k.reconcile([k.lookup(a, [x])]);
      expect(again.targets.xero_uncertain).toEqual([]);
      expect(again.res).toMatchObject({ recovered: 0, items: [{ outcome: 'SKIPPED', applied: false }] });
      expect({ audits: await audits(), exceptions: await k.openExceptions(a) }).toEqual(before);
      expect(await col(db, `select count(*)::text v from external_links where provider = 'XERO' and external_type = 'Invoice' and entity_id = $1`, [a.id])).toEqual(['1']);
    });

    it('9. while the outcome is UNKNOWN no second draft can be recorded: same number and key on every attempt, a second draft is refused, reconciliation never races 05', async () => {
      const a = await k.approve('PRJ-2026-0005');
      expect(await k.claim(a, 'w1')).toMatchObject({ claimed: true });
      expect(await k.fail(a, 'TIMEOUT', 'create draft invoice', 'ETIMEDOUT after 20s')).toMatchObject({ retry: true });
      const first = k.xinv(a);                                                           // created in Xero; the answer was lost
      const c2 = await k.retry(a, 'w2');
      expect(c2).toMatchObject({ claimed: true, payload: { xero_invoice_number: a.payload.xero_invoice_number, xero_idempotency_key: a.payload.xero_idempotency_key } });
      // 05 holds the job right now: reconciliation leaves it alone.
      expect((await k.reconcile([k.lookup(a, [first])])).res).toMatchObject({ items: [{ outcome: 'SKIPPED', applied: false }] });
      // A second draft cannot be recorded: two live invoices with the number are refused, then the one draft is recorded.
      const second = k.xinv(a, { InvoiceID: uuidFor('second draft') });
      await expect(k.complete(a, k.proof(a, second, 2))).rejects.toThrow(/expected exactly one Xero invoice numbered/);
      expect(await k.complete(a, k.proof(a, first))).toMatchObject({ status: 'RECORDED' });
      expect(await k.state(a)).toMatchObject({ sync_status: 'SYNCED', xero_link: first.InvoiceID });
    });

    it('10. AC-05: the void stays refused while existence is uncertain, including an uncertain dead letter; allowed once absence is proven', async () => {
      const a = await k.approve('PRJ-2026-0002');
      await k.ambiguousThenDead(a);
      expect(await k.voidIt(a)).toMatch(/cannot be voided: .*may already exist in Xero/);
      expect((await k.reconcile([k.lookup(a, [])])).res).toMatchObject({ proven_absent: 1 });
      expect(await k.voidIt(a)).toBe(true);
    });

    it('11. AC-06: the pin stays fixed while the write is uncertain, and only a lookup in the bound, pinned tenant can settle it', async () => {
      const a = await k.approve('PRJ-2026-0001');
      await k.ambiguousThenDead(a);
      expect(await k.changePin(B)).toMatch(/cannot be changed or cleared while a Xero write for it is not finished: .*ambiguous/);
      const x = k.xinv(a);
      const wrong = await k.reconcile([k.lookup(a, [x], B)]);
      expect(wrong.res).toMatchObject({ recovered: 0, items: [{ outcome: 'WRONG_TENANT', applied: true }] });   // an exception, nothing settled
      expect(await k.openExceptions(a)).toEqual(expect.arrayContaining([expect.stringMatching(
        new RegExp(`^PERMISSION_DENIED ${a.invoice}: Xero was asked about .* in tenant 99999999…, but the write is bound to 11111111…`)) as unknown]));
      expect(await k.state(a)).toMatchObject({ sync_status: 'UNKNOWN', xero_link: null });
      expect((await k.reconcile([k.lookup(a, [x], A)])).res).toMatchObject({ recovered: 1 });
      expect(await k.state(a)).toMatchObject({ sync_status: 'SYNCED', xero_link: x.InvoiceID });
    });
  });
});
