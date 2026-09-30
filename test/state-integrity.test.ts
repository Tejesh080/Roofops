import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPostgres, type Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';

/**
 * Phase 6: state integrity. Every Airtable edit goes through wf_airtable_change (the production path n8n 06 and the
 * reconciler use); the state machines live in Postgres (state_transitions) and are enforced by triggers, so these tests
 * are GENERATED from that table and check both the returned outcome and the database afterwards.
 */
type R = Record<string, unknown> & { outcome?: string; corrections?: Record<string, unknown> };
const T = { projects: 'tblvUPIoebC3zoacv', quotes: 'tblzenPRNVV5O7lZP', pos: 'tbluIbl4zpMiAlMVw', customers: 'tblHKX79FJFHn5FDc' };
const F = {
  pStatus: 'fldi2Qwz1dAh2tcTE', pReason: 'fld5MhzMBtA4CBUHo', pPM: 'fldnZcRBxG7hTebD5', pStart: 'fld8rf6RZLgfs6Ron', pEnd: 'fldvZtiassZEgLMAN',
  pActualStart: 'fldIje5e0a72cBfVD', pActualEnd: 'fldWKRobTLlOjeN9j', pSync: 'fldVrJOuyhbNtxnVh',
  qStatus: 'fldQpTa5tvrzlNg1h', qLost: 'fld1sZibwdMVnI4Hd', qSentOn: 'fldMnoHiondm5jBWv',
  poStatus: 'fldMtDddp1Rm4tDHf', poEta: 'fldqkJourPRGAcJya', poRef: 'fldJ4Z5Rg5adnEFU0', cName: 'fldI46VewtlNRnwui',
};
const APPROVER = 'usr7uCnNO15fCefbH';
let seq = 0;

async function call(db: Db, fn: string, ...args: unknown[]): Promise<R> {
  const params = args.map((_, i) => `$${String(i + 1)}`).join(', ');
  const [r] = await db.query<{ r: R }>(`select ${fn}(${params}) as r`, args.map((a) => (a !== null && typeof a === 'object' ? JSON.stringify(a) : a)));
  return r!.r;
}
const one = async (db: Db, sql: string, p: unknown[] = []) => (await col(db, sql, p))[0];

async function rec(db: Db, entity: string, key: string): Promise<string> {
  const keyCol = { project: 'project_number', quote: 'quote_number', purchase_order: 'po_number', customer: 'customer_number' }[entity]!;
  const table = { project: 'projects', quote: 'quotes', purchase_order: 'purchase_orders', customer: 'customers' }[entity]!;
  return (await one(db, `select l.external_id v from external_links l join ${table} x on x.id = l.entity_id
                          where l.provider = 'AIRTABLE' and l.entity_type = $1 and x.${keyCol} = $2`, [entity, key]))!;
}

/** An Airtable webhook change exactly as n8n 06 hands it over. */
async function change(db: Db, table: string, entity: string, key: string, fields: Record<string, unknown>,
                      o: { previous?: Record<string, unknown>; at?: string; id?: string; actor?: string; current?: Record<string, unknown> } = {}): Promise<R> {
  seq += 1;
  const changes = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, o.previous && k in o.previous
    ? { current: v, previous: o.previous[k], has_previous: true } : { current: v }]));
  return call(db, 'wf_airtable_change', {
    event_id: o.id ?? `airtable:achTEST:txn${String(seq)}:${key}`, source: 'airtable', actor_id: o.actor ?? 'usrSTAFFMEMBER01',
    occurred_at: o.at ?? new Date(Date.UTC(2026, 8, 29, 0, 0, seq)).toISOString(), table_id: table, record_id: await rec(db, entity, key),
    changes, current: { ...(o.current ?? {}), ...fields },
  }, 'test');
}
const project = (db: Db, key: string, fields: Record<string, unknown>, o = {}) => change(db, T.projects, 'project', key, fields, o);

/** Put a row in a given state for a test case, bypassing triggers (setup only; never used by production code). */
async function force(db: Db, sql: string, p: unknown[] = []) {
  await db.exec(`set session_replication_role = replica`);
  try { await db.query(sql, p); } finally { await db.exec(`set session_replication_role = origin`); }
}

/**
 * n8n 06 as it really runs, for one Airtable record (AC-10). Every write to the simulated record, by staff or by n8n's
 * PATCH, becomes one webhook transaction with Airtable's shape (current and previous). One `run()` is one 06 execution:
 * every undelivered transaction goes through wf_airtable_change first; then each item's corrections are written, read
 * back and proved in order; the cursor advances only if every proof verifies (otherwise the batch is redelivered).
 */
class Airtable06 {
  cells: Record<string, unknown> = {};
  txns: { n: number; at: string; who: 'staff' | 'api' | 'n8n'; changes: Record<string, { current: unknown; previous: unknown }> }[] = [];
  outcomes: { n: number; who: string; outcome: string; duplicate: boolean }[] = [];
  cursor = 0;
  executions = 0;
  failReadBackOnce = new Set<number>();
  /** withOrigin: 06 passes Airtable's actionMetadata.source (staff in the UI: 'client'; n8n's PATCH and any other API client ('api'): 'publicApi'). */
  constructor(private db: Db, private table: string, readonly record: string, private withOrigin = false) {}
  async init() {
    const [r] = await this.db.query<{ e: Record<string, unknown> }>(`select expected e from v_airtable_expected where record_id = $1`, [this.record]);
    this.cells = Object.fromEntries(Object.entries(r!.e).map(([k, v]) => [k, v !== null && typeof v === 'object' && !Array.isArray(v) ? null : v]));
    // Airtable stamps a new edit after every change already applied (earlier tests may have dated some a little ahead).
    const [v] = await this.db.query<{ at: string | null }>(`select max(f.last_source_at)::text at from external_field_versions f
      join external_links l on l.entity_type = f.entity_type and l.entity_id = f.entity_id where l.provider = 'AIRTABLE' and l.external_id = $1`, [this.record]);
    this.notBefore = v?.at ? Date.parse(v.at) + 1000 : 0;
    return this;
  }
  private notBefore = 0;
  get last() { return this.txns.at(-1)?.n ?? 0; }
  write(fields: Record<string, unknown>, who: 'staff' | 'api' | 'n8n') {
    const changes: Record<string, { current: unknown; previous: unknown }> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (JSON.stringify(this.cells[k] ?? null) === JSON.stringify(v ?? null)) continue;   // Airtable emits nothing for an unchanged cell
      changes[k] = { current: v, previous: this.cells[k] ?? null };
      this.cells[k] = v;
    }
    if (!Object.keys(changes).length) return;
    const at = Math.max(Date.now(), this.notBefore);
    this.notBefore = at + 1;
    this.txns.push({ n: this.last + 1, at: new Date(at).toISOString(), who, changes });
  }
  async run(times = 1) {
    for (let i = 0; i < times; i++) {
      const worker = `n8n:sim${String(++this.executions)}`;              // 06 passes 'n8n:' + $execution.id
      const batch = this.txns.filter((t) => t.n > this.cursor);
      const results: { n: number; r: R }[] = [];
      for (const t of batch) {                                            // Apply Change In Postgres: every item first
        const r = await call(this.db, 'wf_airtable_change', {
          event_id: `airtable:achSIM:txn${String(t.n)}:${this.record}`, source: 'airtable', actor_id: 'usr7uCnNO15fCefbH', occurred_at: t.at,
          ...(this.withOrigin ? { origin: t.who === 'staff' ? 'client' : 'publicApi' } : {}),
          table_id: this.table, record_id: this.record,
          changes: Object.fromEntries(Object.entries(t.changes).map(([k, v]) => [k, { ...v, has_previous: true }])),
          current: { ...this.cells, ...Object.fromEntries(Object.entries(t.changes).map(([k, v]) => [k, v.current])) } }, worker);
        results.push({ n: t.n, r });
        this.outcomes.push({ n: t.n, who: t.who, outcome: String(r.outcome), duplicate: r.duplicate === true });
      }
      const writes = results.filter(({ r }) => Object.keys(r.corrections ?? {}).length);
      for (const { r } of writes) this.write(r.corrections!, 'n8n');     // then every PATCH (computed at Apply time)
      let ok = true;
      for (const { n, r } of writes) {                                    // then every read-back and its proof
        if (this.failReadBackOnce.delete(n)) { ok = false; break; }         // transient read-back failure: execution fails
        const readback = Object.fromEntries(Object.keys(r.corrections!).map((k) => [k, this.cells[k] ?? null]));
        const v = await call(this.db, 'wf_airtable_writeback_verified', `airtable:achSIM:txn${String(n)}:${this.record}`, this.table, this.record, readback);
        if (!v.verified) { ok = false; break; }
      }
      if (ok && batch.length) this.cursor = batch.at(-1)!.n;
    }
  }
  /** Transactions RoofOps itself caused (n8n PATCHes) that wf_airtable_change applied as if a person had made them. */
  get ownWritesApplied() { return this.outcomes.filter((o) => o.who === 'n8n' && !o.duplicate && o.outcome === 'APPLIED'); }
}

async function setup(db: Db) {
  await importBundle(db);
  // The Airtable record ids that the live base load recorded (verify-airtable-load.ts); synthetic but well-formed here.
  await db.exec(`
    insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
    select 'AIRTABLE', e.t, e.id, 'Record', 'rec' || substr(md5(e.t || e.id::text), 1, 14), now(), now() from (
      select 'project' t, id from projects union all select 'quote', id from quotes union all select 'purchase_order', id from purchase_orders
      union all select 'customer', id from customers) e
    on conflict do nothing;`);
}

describe.each(TARGETS)('state integrity [%s]', (target) => {
  let db: Db & { url?: string };
  let labels: Record<string, Record<string, string>>;
  let transitions: Set<string>;
  beforeAll(async () => {
    db = await migratedDb(target);
    await setup(db);
    const s = await db.query<{ machine: string; state: string; label: string }>(`select machine, state, label from state_machine_states`);
    labels = {};
    for (const r of s) (labels[r.machine] ??= {})[r.state] = r.label;
    transitions = new Set((await db.query<{ k: string }>(`select machine || ':' || from_state || '>' || to_state k from state_transitions`)).map((r) => r.k));
  }, 120_000);
  afterAll(async () => { await db.close(); });

  describe('generated: every (from, to) pair of every machine, enforced by the database trigger', () => {
    it('illegal transitions are refused by Postgres even when application code is bypassed; legal ones pass', async () => {
      await db.exec(`begin; create temp table sm_probe (id int primary key, machine text, s text) on commit drop;`);
      let checked = 0;
      for (const machine of Object.keys(labels)) {
        if (machine === 'project') continue;   // projects also have guards: covered through the real handler below
        await db.exec(`drop trigger if exists sm_probe_m on sm_probe;
          create trigger sm_probe_m before update of s on sm_probe for each row execute function enforce_state_machine('${machine}', 's');`);
        for (const from of Object.keys(labels[machine]!)) for (const to of Object.keys(labels[machine]!)) {
          if (from === to) continue;
          await db.exec(`savepoint p; insert into sm_probe values (1, '${machine}', '${from}');`);
          const ok = await db.query(`update sm_probe set s = '${to}' where id = 1`).then(() => true, (e: unknown) => {
            expect((e as Error).message).toMatch(/state machine check failed: illegal/); return false; });
          expect(`${machine}:${from}>${to}=${String(ok)}`).toBe(`${machine}:${from}>${to}=${String(transitions.has(`${machine}:${from}>${to}`))}`);
          await db.exec(`rollback to savepoint p`);
          checked += 1;
        }
      }
      await db.exec('rollback');
      expect(checked).toBe(242);   // every ordered pair of every non-project machine
    });

    it('terminal states have no way out', async () => {
      const escapes = await col(db, `select s.machine || ':' || s.state v from state_machine_states s join state_transitions t
                                       on t.machine = s.machine and t.from_state = s.state where s.is_terminal`);
      expect(escapes).toEqual([]);
    });
  });

  describe('generated: every project status change through the production path (Airtable → wf_airtable_change)', () => {
    const PRJ = 'PRJ-2026-0013';   // PLANNING, a deposit invoice only
    const shape: Record<string, string> = {
      PLANNING: `actual_start_date = null, actual_completion_date = null`,
      MATERIALS_PENDING: `actual_start_date = null, actual_completion_date = null`,
      SCHEDULED: `actual_start_date = null, actual_completion_date = null`,
      IN_PROGRESS: `actual_start_date = '2026-09-20', actual_completion_date = null`,
      ON_HOLD: `actual_start_date = null, actual_completion_date = null, on_hold_reason = 'Weather'`,
      COMPLETED: `actual_start_date = '2026-09-20', actual_completion_date = '2026-09-25'`,
      CLOSED: `actual_start_date = '2026-09-20', actual_completion_date = '2026-09-25'`,
      CANCELLED: `actual_start_date = null, actual_completion_date = null, cancellation_reason = 'Customer withdrew'`,
    };
    it('valid pairs apply (status, dates, audit); invalid pairs are refused, the row is unchanged and Airtable is corrected', async () => {
      await db.exec('begin');
      const summary: string[] = [];
      for (const from of Object.keys(shape)) for (const to of Object.keys(shape)) {
        if (from === to) continue;
        await db.exec('savepoint c');
        await force(db, `update projects set status = '${from}', ${shape[from]!} where project_number = '${PRJ}'`);
        const guard = await one(db, `select project_transition_guard(p, $1) v from projects p where project_number = '${PRJ}'`, [to]);
        const legal = transitions.has(`project:${from}>${to}`) && guard === 'null';
        const audits = Number(await one(db, `select count(*) v from audit_events where action = 'project.status.changed' and business_reference = '${PRJ}'`));
        const r = await project(db, PRJ, { [F.pStatus]: labels.project![to] }, { current: { [F.pReason]: to === 'CANCELLED' ? 'Customer moved interstate' : null } });
        const now = await one(db, `select status v from projects where project_number = '${PRJ}'`);
        const audited = Number(await one(db, `select count(*) v from audit_events where action = 'project.status.changed' and business_reference = '${PRJ}'`)) - audits;
        if (legal) {
          expect([from, to, r.outcome, now, audited]).toEqual([from, to, 'APPLIED', to, 1]);
          expect(r.corrections?.[F.pStatus]).toBeUndefined();
        } else {
          expect([from, to, r.outcome, now, audited]).toEqual([from, to, 'REJECTED', from, 0]);
          expect(r.corrections).toMatchObject({ [F.pStatus]: labels.project![from] });
          expect(String(r.corrections?.[F.pSync])).toContain('not applied');
        }
        summary.push(`${from}>${to}:${legal ? 'ok' : 'no'}`);
        await db.exec('rollback to savepoint c');
      }
      await db.exec('rollback');
      expect(summary).toHaveLength(56);
      expect(summary).toEqual(expect.arrayContaining(['COMPLETED>CANCELLED:ok', 'CANCELLED>PLANNING:no', 'COMPLETED>IN_PROGRESS:no', 'CLOSED>COMPLETED:no']));
    });
  });

  describe('PRJ-2026-0001: Completed → Cancelled (the regression that started Phase 6)', () => {
    it('before: RoofOps says Completed and ready to invoice', async () => {
      expect(await one(db, `select status || '|' || invoice_status v from v_dashboard_projects where project_number = 'PRJ-2026-0001'`)).toBe('COMPLETED|READY_TO_INVOICE');
    });
    it('the Airtable edit is applied through the handler, with the reason, audit trail and history preserved', async () => {
      const invoicesBefore = await col(db, `select invoice_number v from invoices where project_id = (select id from projects where project_number = 'PRJ-2026-0001') order by 1`);
      const r = await project(db, 'PRJ-2026-0001', { [F.pStatus]: 'Cancelled' }, { previous: { [F.pStatus]: 'Completed' }, current: { [F.pReason]: 'Customer cancelled remaining works' } });
      expect(r).toMatchObject({ outcome: 'APPLIED', business_key: 'PRJ-2026-0001', applied: [{ field: 'Status', from: 'Completed', to: 'Cancelled' }] });
      expect(r).toMatchObject({ corrections: {}, note: expect.stringContaining('✓ Status: Completed → Cancelled applied') as unknown });   // nothing to write back
      expect(await one(db, `select status || '|' || cancellation_reason v from projects where project_number = 'PRJ-2026-0001'`)).toBe('CANCELLED|Customer cancelled remaining works');
      expect(await col(db, `select invoice_number v from invoices where project_id = (select id from projects where project_number = 'PRJ-2026-0001') order by 1`)).toEqual(invoicesBefore);
      expect(await col(db, `select actor_id || '|' || (before_state->>'status') || '>' || (after_state->>'status') v from audit_events
                             where action = 'project.status.changed' and business_reference = 'PRJ-2026-0001'`)).toEqual(['usrSTAFFMEMBER01|COMPLETED>CANCELLED']);
    });
    it('dashboard shows Cancelled, it is no longer ready to invoice, and invoice preparation is refused', async () => {
      expect(await one(db, `select status || '|' || invoice_status v from v_dashboard_projects where project_number = 'PRJ-2026-0001'`)).not.toMatch(/READY_TO_INVOICE|COMPLETED/);
      expect(await one(db, `select status v from v_dashboard_projects where project_number = 'PRJ-2026-0001'`)).toBe('CANCELLED');
      const prep = await call(db, 'wf_invoice_prepare', { event_id: 'dash:prep:0001', event_type: 'invoice.prepare_requested', source: 'roofops-dashboard',
        actor_id: 'dashboard:copilot', occurred_at: '2026-09-29T09:00:00+10:00', payload: { project_number: 'PRJ-2026-0001' } });
      expect(prep.outcome).not.toBe('PREVIEW_READY');
      expect(JSON.stringify(prep)).toMatch(/CANCELLED/);
      expect(await one(db, `select count(*) v from approvals where business_reference = 'PRJ-2026-0001' and status = 'PENDING'`)).toBe('0');
    });
    it('Cancelled is final: re-opening from Airtable is refused and Airtable is put back', async () => {
      for (const to of ['Planning', 'Completed', 'In Progress']) {
        const r = await project(db, 'PRJ-2026-0001', { [F.pStatus]: to }, { previous: { [F.pStatus]: 'Cancelled' } });
        expect(r).toMatchObject({ outcome: 'REJECTED', corrections: { [F.pStatus]: 'Cancelled' } });
        expect(String(r.corrections![F.pSync])).toMatch(/Cancelled is final/);
      }
      expect(await one(db, `select status v from projects where project_number = 'PRJ-2026-0001'`)).toBe('CANCELLED');
    });
  });

  describe('delivery failures: duplicate, 20×, delayed / out of order, echo of our own write', () => {
    it('the same Airtable transaction delivered 20 times changes the project once', async () => {
      const id = 'airtable:achTEST:txn900:PRJ-2026-0009';
      const results: R[] = [];
      for (let i = 0; i < 20; i += 1) results.push(await project(db, 'PRJ-2026-0009', { [F.pStatus]: 'Scheduled' }, { id }));
      expect(results[0]).toMatchObject({ outcome: 'APPLIED' });
      expect(results.slice(1).every((r) => r.duplicate === true && Object.keys(r.corrections ?? {}).length === 0)).toBe(true);
      expect(results[19]).toMatchObject({ delivery_count: 20 });
      expect(await one(db, `select count(*) v from audit_events where action = 'project.status.changed' and business_reference = 'PRJ-2026-0009'`)).toBe('1');
      expect(await one(db, `select status v from projects where project_number = 'PRJ-2026-0009'`)).toBe('SCHEDULED');
    });
    it('a delayed older change arriving after a newer one is ignored (no rollback to the old value, no Airtable write)', async () => {
      const newer = await project(db, 'PRJ-2026-0009', { [F.pStart]: '2026-10-16' }, { at: '2026-09-29T02:00:00Z' });
      expect(newer.outcome).toBe('APPLIED');
      const older = await project(db, 'PRJ-2026-0009', { [F.pStart]: '2026-10-14' }, { at: '2026-09-29T01:00:00Z' });
      expect(older).toMatchObject({ outcome: 'STALE', corrections: {}, note: expect.stringContaining('arrived late') as unknown });
      expect(await one(db, `select planned_start_date::text v from projects where project_number = 'PRJ-2026-0009'`)).toBe('2026-10-16');
    });
    it('if n8n fails after Postgres committed, a redelivery re-issues the Airtable correction until it is verified', async () => {
      const id = 'airtable:achTEST:txn902:PRJ-2026-0010';
      const first = await project(db, 'PRJ-2026-0010', { [F.pStatus]: 'Closed' }, { id });
      expect(first).toMatchObject({ outcome: 'REJECTED', corrections: { [F.pStatus]: 'Materials Pending' } });
      const again = await project(db, 'PRJ-2026-0010', { [F.pStatus]: 'Closed' }, { id });   // write-back never confirmed
      expect(again).toMatchObject({ duplicate: true, corrections: { [F.pStatus]: 'Materials Pending' } });
      expect(await call(db, 'wf_airtable_writeback_verified', id, T.projects, await rec(db, 'project', 'PRJ-2026-0010'), { [F.pStatus]: 'Materials Pending' }))
        .toMatchObject({ verified: true });
      expect(await project(db, 'PRJ-2026-0010', { [F.pStatus]: 'Closed' }, { id })).toMatchObject({ duplicate: true, corrections: {} });
      expect(await one(db, `select status v from projects where project_number = 'PRJ-2026-0010'`)).toBe('MATERIALS_PENDING');
    });
    it('a wrong read-back is not accepted as proof', async () => {
      const r = await call(db, 'wf_airtable_writeback_verified', 'x:bad', T.projects, await rec(db, 'project', 'PRJ-2026-0010'), { [F.pStatus]: 'Closed' });
      expect(r).toMatchObject({ verified: false, mismatched_fields: [F.pStatus] });
    });
    it('our own correction echoing back is a no-op', async () => {
      const r = await project(db, 'PRJ-2026-0009', { [F.pStatus]: 'Scheduled', [F.pStart]: '2026-10-16' });
      expect(r).toMatchObject({ outcome: 'NO_CHANGE', corrections: {} });
    });
    it('invalid or unknown events stop safely with an actionable exception, once', async () => {
      expect(await call(db, 'wf_airtable_change', { event_id: 'x', table_id: 'nope', record_id: 'rec1', changes: {} })).toMatchObject({ outcome: 'INVALID_EVENT' });
      const ev = { event_id: 'airtable:achTEST:txn901:recUNKNOWN000001', table_id: T.projects, record_id: 'recUNKNOWN0000001',
                   changes: { [F.pStatus]: { current: 'Cancelled' } }, occurred_at: '2026-09-29T00:00:00Z' };
      const a = await call(db, 'wf_airtable_change', ev);
      const b = await call(db, 'wf_airtable_change', { ...ev, event_id: ev.event_id + ':again' });
      expect(a).toMatchObject({ outcome: 'UNKNOWN_RECORD' });
      expect(b.exception_number).toBe(a.exception_number);
    });
  });

  describe('concurrent edits are decided by compare-and-set, never last-write-wins', () => {
    it('Scheduled → Cancelled and Scheduled → In Progress: the first one wins, the second is refused and explained', async () => {
      const a = await project(db, 'PRJ-2026-0011', { [F.pStatus]: 'Cancelled' }, { previous: { [F.pStatus]: 'Scheduled' } });
      const b = await project(db, 'PRJ-2026-0011', { [F.pStatus]: 'In Progress' }, { previous: { [F.pStatus]: 'Scheduled' } });
      expect(a.outcome).toBe('APPLIED');
      expect(b).toMatchObject({ outcome: 'REJECTED', rejected: [{ conflict: true }], corrections: { [F.pStatus]: 'Cancelled' } });
      expect(String(b.corrections![F.pSync])).toMatch(/someone else changed it at the same time/);
      expect(await one(db, `select status v from projects where project_number = 'PRJ-2026-0011'`)).toBe('CANCELLED');
    });
  });

  describe('project rules', () => {
    it('cancelling withdraws a pending invoice preview and open tasks; a final invoice blocks cancellation', async () => {
      const prep = await call(db, 'wf_invoice_prepare', { event_id: 'dash:prep:0005', event_type: 'invoice.prepare_requested', source: 'roofops-dashboard',
        actor_id: 'dashboard:copilot', occurred_at: '2026-09-29T09:00:00+10:00', payload: { project_number: 'PRJ-2026-0005' } });
      expect(prep.outcome).toBe('PREVIEW_READY');
      await db.exec(`insert into tasks (project_id, task_type, title) select id, 'GENERAL', 'Test task' from projects where project_number = 'PRJ-2026-0005'`);
      const r = await project(db, 'PRJ-2026-0005', { [F.pStatus]: 'Cancelled' });
      expect(r.outcome).toBe('APPLIED');
      expect(await one(db, `select status v from approvals where approval_number = $1`, [prep.approval_number])).toBe('CANCELLED');
      expect(await one(db, `select count(*) v from tasks t join projects p on p.id = t.project_id where p.project_number = 'PRJ-2026-0005' and t.status = 'OPEN'`)).toBe('0');
      expect(await one(db, `select count(*) v from audit_events where action = 'approval.withdrawn' and business_reference = $1`, [prep.approval_number])).toBe('1');

      await db.exec(`insert into invoices (invoice_number, project_id, customer_id, invoice_type) select 'INV-TEST-FINAL', id, customer_id, 'FINAL' from projects where project_number = 'PRJ-2026-0002'`);
      const blocked = await project(db, 'PRJ-2026-0002', { [F.pStatus]: 'Cancelled' });
      expect(blocked).toMatchObject({ outcome: 'REJECTED', rejected: [{ reason: expect.stringMatching(/final invoice \(INV-TEST-FINAL\) already exists/) as unknown }] });
      expect(await one(db, `select status v from projects where project_number = 'PRJ-2026-0002'`)).toBe('COMPLETED');
    });
    it('In Progress sets Actual Start, Completed sets Actual Completion, and Airtable is told both', async () => {
      const r = await project(db, 'PRJ-2026-0015', { [F.pStatus]: 'In Progress' });
      expect(r).toMatchObject({ outcome: 'APPLIED', corrections: { [F.pActualStart]: '2026-09-29' } });
      const c = await project(db, 'PRJ-2026-0015', { [F.pStatus]: 'Completed' });
      expect(c).toMatchObject({ outcome: 'APPLIED', corrections: { [F.pActualEnd]: '2026-09-29' } });
      expect(await one(db, `select actual_start_date || '|' || actual_completion_date v from projects where project_number = 'PRJ-2026-0015'`)).toBe('2026-09-29|2026-09-29');
    });
    it('schedule and project manager changes are validated', async () => {
      expect(await project(db, 'PRJ-2026-0017', { [F.pStart]: '2026-10-30' })).toMatchObject({ outcome: 'REJECTED', corrections: { [F.pStart]: '2026-10-19' } });
      expect(await project(db, 'PRJ-2026-0017', { [F.pEnd]: '2026-10-25' })).toMatchObject({ outcome: 'APPLIED' });
      expect(await project(db, 'PRJ-2026-0004', { [F.pEnd]: '2026-12-01' })).toMatchObject({ outcome: 'REJECTED', rejected: [{ reason: expect.stringMatching(/locked/) as unknown }] });
      expect(await project(db, 'PRJ-2026-0017', { [F.pPM]: 'Sophie Carter' })).toMatchObject({ outcome: 'APPLIED' });
      const bad = await project(db, 'PRJ-2026-0017', { [F.pPM]: 'Chloe Mason' });
      expect(bad).toMatchObject({ outcome: 'REJECTED', corrections: { [F.pPM]: 'Sophie Carter' } });
      expect(await one(db, `select e.full_name v from projects p join employees e on e.id = p.project_manager_id where p.project_number = 'PRJ-2026-0017'`)).toBe('Sophie Carter');
    });
    it('fields owned by RoofOps are reverted, not applied', async () => {
      const r = await project(db, 'PRJ-2026-0016', { [F.pActualStart]: '2026-01-01' });
      expect(r).toMatchObject({ outcome: 'REVERTED', corrections: { [F.pActualStart]: '2026-09-27' } });
      const c = await change(db, T.customers, 'customer', 'CUST-0001', { [F.cName]: 'Someone Else' });
      expect(c.outcome).toBe('REVERTED');
      expect(await one(db, `select display_name v from customers where customer_number = 'CUST-0001'`)).not.toBe('Someone Else');
    });
  });

  describe('quotes and purchase orders', () => {
    it('quote: Draft → Sent, Sent → Lost apply; Sent → Accepted is left to the Quote → Project workflow; terminal states hold', async () => {
      const sent = await change(db, T.quotes, 'quote', 'Q-2026-0033', { [F.qStatus]: 'Sent' });
      expect(sent).toMatchObject({ outcome: 'APPLIED', corrections: { [F.qSentOn]: expect.any(String) as unknown } });
      const lost = await change(db, T.quotes, 'quote', 'Q-2026-0033', { [F.qStatus]: 'Lost' }, { current: { [F.qLost]: 'Price' } });
      expect(lost.outcome).toBe('APPLIED');
      expect(await one(db, `select status || '|' || lost_reason v from quotes where quote_number = 'Q-2026-0033'`)).toBe('LOST|Price');
      expect(await change(db, T.quotes, 'quote', 'Q-2026-0033', { [F.qStatus]: 'Sent' })).toMatchObject({ outcome: 'REJECTED', corrections: { [F.qStatus]: 'Lost' } });
      const acc = await change(db, T.quotes, 'quote', 'Q-2026-0032', { [F.qStatus]: 'Accepted' });
      expect(acc).toMatchObject({ outcome: 'DEFERRED', corrections: {} });
      expect(await one(db, `select status v from quotes where quote_number = 'Q-2026-0032'`)).toBe('SENT');
      const draftAcc = await change(db, T.quotes, 'quote', 'Q-2026-0065', { [F.qStatus]: 'Accepted' });
      expect(draftAcc).toMatchObject({ outcome: 'REJECTED', corrections: { [F.qStatus]: 'Draft' } });
    });
    it('purchase order: supplier confirmed, delivery date, reference; no going backwards; approval needs an approver', async () => {
      const po = await one(db, `select po_number v from purchase_orders where status = 'SENT' order by 1 limit 1`);
      expect(await change(db, T.pos, 'purchase_order', po!, { [F.poStatus]: 'Acknowledged' })).toMatchObject({ outcome: 'APPLIED' });
      expect(await one(db, `select (acknowledged_at is not null)::text v from purchase_orders where po_number = $1`, [po])).toBe('true');
      expect(await change(db, T.pos, 'purchase_order', po!, { [F.poEta]: '2026-10-20', [F.poRef]: 'SUP-REF-77' })).toMatchObject({ outcome: 'APPLIED' });
      expect(await change(db, T.pos, 'purchase_order', po!, { [F.poEta]: '2020-01-01' })).toMatchObject({ outcome: 'REJECTED' });
      expect(await change(db, T.pos, 'purchase_order', po!, { [F.poStatus]: 'Sent' })).toMatchObject({ outcome: 'REJECTED', corrections: { [F.poStatus]: 'Acknowledged' } });
      const delivered = await one(db, `select po_number v from purchase_orders where status = 'DELIVERED' limit 1`);
      expect(await change(db, T.pos, 'purchase_order', delivered!, { [F.poStatus]: 'Approved' })).toMatchObject({ outcome: 'REJECTED' });

      const draft = await one(db, `select po_number v from purchase_orders where status = 'DRAFT' order by 1 limit 1`);
      await db.query(`update purchase_orders set record_origin = 'ROOFOPS' where po_number = $1`, [draft]);
      expect(await change(db, T.pos, 'purchase_order', draft!, { [F.poStatus]: 'Approved' })).toMatchObject({ outcome: 'REJECTED' });
      expect(await change(db, T.pos, 'purchase_order', draft!, { [F.poStatus]: 'Approved' }, { actor: APPROVER })).toMatchObject({ outcome: 'APPLIED' });
      expect(await one(db, `select e.employee_code v from purchase_orders po join employees e on e.id = po.approved_by where po_number = $1`, [draft])).toBe('EMP-900');
    });
  });

  /** What an n8n 07 read of the Airtable table would return if in sync, with `patch` applied. */
  const snapshot = async (table: string, patch: (id: string, f: Record<string, unknown>) => void) => {
    const rows = await db.query<{ record_id: string; expected: Record<string, unknown> }>(`select record_id, expected from v_airtable_expected where table_id = $1`, [table]);
    return rows.map((r) => {
      const f = Object.fromEntries(Object.entries(r.expected).map(([k, v]) => [k, v !== null && typeof v === 'object' && !Array.isArray(v) ? null : v]));
      patch(r.record_id, f);
      return { id: r.record_id, fields: f };
    });
  };

  describe('reconciliation', () => {
    it('a missed webhook (PRJ-2026-0020 Cancelled in Airtable) is observed, then repaired through the same validation', async () => {
      const id20 = await rec(db, 'project', 'PRJ-2026-0020');
      const id12 = await rec(db, 'project', 'PRJ-2026-0012');
      const drifted = (id: string, f: Record<string, unknown>) => {
        if (id === id20) f[F.pStatus] = 'Cancelled';
        if (id === id12) f[F.pActualStart] = '2025-01-01';   // RoofOps-owned field edited in Airtable
      };
      expect(await call(db, 'wf_reconcile_start', 'manual', 'repair', 'wrong-token')).toMatchObject({ started: false });
      const obs = await call(db, 'wf_reconcile_start', 'schedule', 'observe');
      expect(obs.started).toBe(true);
      const records = [...await snapshot(T.projects, drifted), { id: 'recONLYINAIRTABLE1', fields: {} }];
      const o = await call(db, 'wf_reconcile_airtable', obs.run_key, T.projects, records);
      expect(o).toMatchObject({ ok: true, drift: 2, corrections: [] });
      expect(await one(db, `select status v from projects where project_number = 'PRJ-2026-0020'`)).toBe('IN_PROGRESS');
      expect(await one(db, `select airtable_status_seen || '|' || drift_fields v from v_dashboard_projects where project_number = 'PRJ-2026-0020'`)).toBe('Cancelled|1');
      await call(db, 'wf_reconcile_finish', obs.run_key, {}, []);

      await db.exec(`update reconciliation_runs set started_at = started_at - interval '5 minutes'`);
      const run = await call(db, 'wf_reconcile_start', 'schedule', 'repair');
      const rep = await call(db, 'wf_reconcile_airtable', run.run_key, T.projects, records);
      expect(await one(db, `select status v from projects where project_number = 'PRJ-2026-0020'`)).toBe('CANCELLED');
      const corr = rep.corrections as unknown as { id: string; fields: Record<string, unknown> }[];
      expect(corr.find((c) => c.id === id12)?.fields).toMatchObject({ [F.pActualStart]: '2026-09-27' });
      expect(await col(db, `select classification || '/' || action v from reconciliation_findings f join reconciliation_runs r on r.id = f.run_id
                             where r.run_key = $1 order by 1`, [run.run_key]))
        .toEqual(['SAFE_AUTO_REPAIR/APPLIED_TO_POSTGRES', 'UNAUTHORIZED_STATE/REPAIRED_AIRTABLE', 'UNKNOWN/EXCEPTION_OPENED']);
      // n8n writes the corrections and reports the read-back: drift is gone.
      await call(db, 'wf_airtable_writeback_verified', 'reconcile:test', T.projects, id12, { [F.pActualStart]: '2026-09-27' });
      expect(await col(db, `select business_key || ':' || field v from v_state_drift where entity_type = 'project'`)).toEqual([]);

      const ext = await call(db, 'wf_reconcile_external', run.run_key, 'DRIVE', [
        { project_number: 'PRJ-2026-0020', folder_id: 'f1', http: 404 }, { project_number: 'PRJ-2026-0012', folder_id: 'f2', http: 200, trashed: false }]);
      expect(ext).toMatchObject({ verified: 1, drift: 1 });
      const fin = await call(db, 'wf_reconcile_finish', run.run_key, { projects: rep }, []);
      expect(fin).toMatchObject({ ok: true, mode: 'repair' });
      expect(await one(db, `select count(*) v from workflow_exceptions where error_class = 'EXTERNAL_MISSING' and business_reference = 'PRJ-2026-0020'`)).toBe('1');
    });
    it('an Accepted quote that RoofOps never heard about needs a person (never silently turned into a project)', async () => {
      await db.exec(`update reconciliation_runs set started_at = started_at - interval '5 minutes'`);
      const run = await call(db, 'wf_reconcile_start', 'schedule', 'repair');
      const idQ = await rec(db, 'quote', 'Q-2026-0064');
      const r = await call(db, 'wf_reconcile_airtable', run.run_key, T.quotes, await snapshot(T.quotes, (id, f) => { if (id === idQ) f[F.qStatus] = 'Accepted'; }));
      expect(r).toMatchObject({ drift: 1 });
      expect(await one(db, `select classification v from reconciliation_findings f join reconciliation_runs r on r.id = f.run_id where r.run_key = $1`, [run.run_key])).toBe('REQUIRES_HUMAN');
      expect(await one(db, `select status v from quotes where quote_number = 'Q-2026-0064'`)).toBe('SENT');
      await call(db, 'wf_reconcile_finish', run.run_key, {}, []);
    });
    it('AC-01: an Airtable read taken before a webhook edit never reverts that edit (re-checked next run instead)', async () => {
      await db.exec(`update reconciliation_runs set started_at = started_at - interval '5 minutes'`);
      const run = await call(db, 'wf_reconcile_start', 'schedule', 'repair');
      const id28 = await rec(db, 'project', 'PRJ-2026-0028');
      const read = await snapshot(T.projects, () => {});   // n8n 07 reads the Projects table: in sync
      // While 07 is still reading, staff move the finish and put the job on hold; n8n 06 applies both.
      expect((await project(db, 'PRJ-2026-0028', { [F.pEnd]: '2026-12-18' }, { previous: { [F.pEnd]: '2026-10-01' } })).outcome).toBe('APPLIED');
      expect((await project(db, 'PRJ-2026-0028', { [F.pStatus]: 'On Hold' }, { previous: { [F.pStatus]: 'In Progress' } })).outcome).toBe('APPLIED');
      const r = await call(db, 'wf_reconcile_airtable', run.run_key, T.projects, read);
      expect(await one(db, `select status || ' ' || planned_completion_date v from projects where project_number = 'PRJ-2026-0028'`)).toBe('ON_HOLD 2026-12-18');
      expect((r.corrections as unknown as { id: string }[]).find((c) => c.id === id28)).toBeUndefined();
      expect(await col(db, `select f.field || ':' || f.classification || '/' || f.action v from reconciliation_findings f
                             join reconciliation_runs x on x.id = f.run_id where x.run_key = $1 order by 1`, [run.run_key]))
        .toEqual(['Planned Completion:STALE_EVENT/NONE', 'Status:STALE_EVENT/NONE']);
      // The old read is not recorded as what Airtable shows now: no hidden divergence, no false drift.
      expect(await col(db, `select field v from v_state_drift where business_key = 'PRJ-2026-0028'`)).toEqual([]);
      // The staff member's next edit applies (before the fix it was refused as a conflict with the reverted value).
      expect((await project(db, 'PRJ-2026-0028', { [F.pEnd]: '2026-12-22' }, { previous: { [F.pEnd]: '2026-12-18' }, current: { [F.pStatus]: 'On Hold' } })).outcome).toBe('APPLIED');
      await call(db, 'wf_reconcile_finish', run.run_key, {}, []);
    });
    it('AC-01: a replayed missed edit is dated by the Airtable read, so a later staff edit is not treated as stale', async () => {
      await db.exec(`update reconciliation_runs set started_at = started_at - interval '5 minutes'`);
      const run = await call(db, 'wf_reconcile_start', 'schedule', 'repair');
      await db.query(`update reconciliation_runs set started_at = started_at - interval '1 minute' where run_key = $1`, [run.run_key]);
      await force(db, `update projects set updated_at = updated_at - interval '1 hour' where project_number = 'PRJ-2026-0027'`);
      const id27 = await rec(db, 'project', 'PRJ-2026-0027');
      // Airtable shows a finish date whose webhook RoofOps never received: the repair run replays it.
      const r = await call(db, 'wf_reconcile_airtable', run.run_key, T.projects, await snapshot(T.projects, (id, f) => { if (id === id27) f[F.pEnd] = '2026-10-12'; }));
      expect(r).toMatchObject({ drift: 1 });
      expect(await one(db, `select planned_completion_date::text v from projects where project_number = 'PRJ-2026-0027'`)).toBe('2026-10-12');
      // A staff edit made after 07 read the table (30 s after the run started) arrives late, after the replay.
      const at = await one(db, `select (started_at + interval '30 seconds')::text v from reconciliation_runs where run_key = $1`, [run.run_key]);
      const late = await project(db, 'PRJ-2026-0027', { [F.pEnd]: '2026-10-14' }, { previous: { [F.pEnd]: '2026-10-12' }, at });
      expect(late.outcome).toBe('APPLIED');
      expect(await one(db, `select planned_completion_date::text v from projects where project_number = 'PRJ-2026-0027'`)).toBe('2026-10-14');
      await call(db, 'wf_reconcile_finish', run.run_key, {}, []);
    });

    // AC-02 (docs/defect-ledger.md). Real Airtable reads leave blank cells, and field ids that no longer exist, out of
    // `fields`; a date field switched to "include time" returns UTC instants. The snapshot helper above hides both.
    const allDates = () => col(db, `select project_number || '|' || coalesce(planned_start_date::text, '-') || '|' || coalesce(planned_completion_date::text, '-') v
                                    from projects order by project_number`);
    /** Airtable's instant for midnight of a Brisbane day (UTC+10, no daylight saving): the previous day at 14:00Z. */
    const bneMidnight = (day: string) => new Date(Date.parse(`${day}T00:00:00+10:00`)).toISOString();
    const findings = (runKey: unknown) => col(db, `select coalesce(f.entity_ref, '-') || ':' || coalesce(f.field, '-') || ':' || f.classification || '/' || f.action v
                                                  from reconciliation_findings f join reconciliation_runs x on x.id = f.run_id where x.run_key = $1 order by 1`, [runKey]);
    const newRun = async (mode = 'repair') => {
      await db.exec(`update reconciliation_runs set started_at = started_at - interval '5 minutes'`);
      return call(db, 'wf_reconcile_start', 'schedule', mode);
    };

    it('AC-02: a field missing from every record of the read (deleted or recreated in Airtable) is never replayed as "staff blanked it"', async () => {
      const before = await allDates();
      const run = await newRun();
      const id25 = await rec(db, 'project', 'PRJ-2026-0025');
      const read = (await snapshot(T.projects, (id, f) => {
        Reflect.deleteProperty(f, F.pStart); Reflect.deleteProperty(f, F.pEnd);                      // the two date field ids no longer exist in Airtable
        if (id === id25) f[F.pStatus] = 'Materials Pending';        // and one genuine missed staff edit in the same read
      }));
      const r = await call(db, 'wf_reconcile_airtable', run.run_key, T.projects, read);
      expect(await allDates()).toEqual(before);                                           // no canonical date touched
      expect(await one(db, `select status v from projects where project_number = 'PRJ-2026-0025'`)).toBe('MATERIALS_PENDING');   // not a blanket abort
      const corrected = (r.corrections as unknown as { fields: Record<string, unknown> }[]).flatMap((c) => Object.keys(c.fields));
      expect(corrected).not.toContain(F.pStart);                  // never write to a field id Airtable no longer has
      expect(corrected).not.toContain(F.pEnd);
      expect((await findings(run.run_key)).filter((x) => /Planned (Start|Completion)/.test(x)))
        .toEqual(['-:Planned Completion:REQUIRES_HUMAN/EXCEPTION_OPENED', '-:Planned Start:REQUIRES_HUMAN/EXCEPTION_OPENED']);
      expect(await one(db, `select count(*) v from workflow_exceptions where error_class = 'SCHEMA_MISMATCH' and resolution_status = 'OPEN'
                             and error_message like '%Planned Completion%'`)).toBe('1');
      expect(await col(db, `select business_key || ':' || field v from v_state_drift where field in ('Planned Start', 'Planned Completion')`)).toEqual([]);
      await call(db, 'wf_reconcile_finish', run.run_key, {}, []);
    });

    it('AC-02: a blank cell on one record (the field is present on others) is still a missed staff edit', async () => {
      const run = await newRun();
      const id30 = await rec(db, 'project', 'PRJ-2026-0030');
      await call(db, 'wf_reconcile_airtable', run.run_key, T.projects, await snapshot(T.projects, (id, f) => { if (id === id30) Reflect.deleteProperty(f, F.pEnd); }));
      expect(await one(db, `select coalesce(planned_completion_date::text, 'blank') v from projects where project_number = 'PRJ-2026-0030'`)).toBe('blank');
      expect(await findings(run.run_key)).toEqual(['PRJ-2026-0030:Planned Completion:SAFE_AUTO_REPAIR/APPLIED_TO_POSTGRES']);
      await call(db, 'wf_reconcile_finish', run.run_key, {}, []);
    });

    it('AC-02: dates returned as instants for the same Brisbane day are not drift, run after run', async () => {
      const before = await allDates();
      for (let i = 0; i < 2; i++) {
        const run = await newRun();
        const read = await snapshot(T.projects, (_id, f) => {
          for (const k of [F.pStart, F.pEnd, F.pActualStart, F.pActualEnd]) if (typeof f[k] === 'string') f[k] = bneMidnight(f[k]);
        });
        const r = await call(db, 'wf_reconcile_airtable', run.run_key, T.projects, read);
        expect([i, r.drift, r.corrections]).toEqual([i, 0, []]);
        expect(await findings(run.run_key)).toEqual([]);
        await call(db, 'wf_reconcile_finish', run.run_key, {}, []);
      }
      expect(await allDates()).toEqual(before);
    });

    it('AC-02: a real date change sent as an instant lands on the Brisbane business day (reconciler, webhook and read-back)', async () => {
      const run = await newRun();
      const id29 = await rec(db, 'project', 'PRJ-2026-0029');
      await call(db, 'wf_reconcile_airtable', run.run_key, T.projects,
        await snapshot(T.projects, (id, f) => { if (id === id29) f[F.pEnd] = bneMidnight('2026-11-20'); }));
      expect(await one(db, `select planned_completion_date::text v from projects where project_number = 'PRJ-2026-0029'`)).toBe('2026-11-20');
      // The next staff edit arrives through the webhook after the replay (dated after the run start, like AC-01).
      const at = await one(db, `select (started_at + interval '30 seconds')::text v from reconciliation_runs where run_key = $1`, [run.run_key]);
      await call(db, 'wf_reconcile_finish', run.run_key, {}, []);
      const hook = await project(db, 'PRJ-2026-0029', { [F.pEnd]: bneMidnight('2026-11-22') }, { previous: { [F.pEnd]: bneMidnight('2026-11-20') }, at });
      expect(hook).toMatchObject({ outcome: 'APPLIED' });
      expect(hook.corrections?.[F.pEnd]).toBeUndefined();          // Airtable already shows that day: nothing to write back
      expect(await one(db, `select planned_completion_date::text v from projects where project_number = 'PRJ-2026-0029'`)).toBe('2026-11-22');
      expect(await call(db, 'wf_airtable_writeback_verified', 'ac02:readback', T.projects, id29, { [F.pEnd]: bneMidnight('2026-11-22') }))
        .toMatchObject({ verified: true });
    });

    it('AC-02: the same field changed on many records in one read is a change to the field, not staff edits: nothing is replayed', async () => {
      // Not PRJ-0021/0023: the two-connection race tests below expect no recorded drift on those.
      const shifted = ['PRJ-2026-0014', 'PRJ-2026-0017', 'PRJ-2026-0018', 'PRJ-2026-0022', 'PRJ-2026-0024', 'PRJ-2026-0025', 'PRJ-2026-0026', 'PRJ-2026-0027'];
      const ids = new Set(await Promise.all(shifted.map((p) => rec(db, 'project', p))));
      const before = await allDates();
      const run = await newRun();
      const plusOne = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const r = await call(db, 'wf_reconcile_airtable', run.run_key, T.projects,
        await snapshot(T.projects, (id, f) => { const v = f[F.pEnd]; if (ids.has(id) && typeof v === 'string') f[F.pEnd] = plusOne(v); }));
      expect(await allDates()).toEqual(before);
      expect(r).toMatchObject({ drift: 8, corrections: [] });
      expect(await findings(run.run_key)).toEqual(['-:Planned Completion:REQUIRES_HUMAN/EXCEPTION_OPENED']);
      // What Airtable shows is still recorded, so the divergence stays visible until a person decides.
      expect(Number(await one(db, `select count(*) v from v_state_drift where field = 'Planned Completion'`))).toBe(8);
      await call(db, 'wf_reconcile_finish', run.run_key, {}, []);
    });

    const bulk = ['PRJ-2026-0014', 'PRJ-2026-0017', 'PRJ-2026-0018', 'PRJ-2026-0022', 'PRJ-2026-0024', 'PRJ-2026-0026'];   // 6 of 30 = 20%
    const bulkDates = () => col(db, `select project_number || ' ' || coalesce(planned_completion_date::text, '-') v from projects
                                     where project_number = any ($1) order by 1`, [bulk]);

    it('AC-02: a legitimate bulk edit through the webhook, while a run holds an older read, is kept: no mass-change alarm, no undo', async () => {
      const run = await newRun();
      const read = await snapshot(T.projects, () => {});                    // 07 reads Projects (before the bulk edit)
      const at = await one(db, `select (started_at + interval '30 seconds')::text v from reconciliation_runs where run_key = $1`, [run.run_key]);
      // Staff move six jobs to the same new finish date; n8n 06 applies each webhook normally.
      for (const p of bulk) {
        const prev = await one(db, `select planned_completion_date::text v from projects where project_number = $1`, [p]);
        expect((await project(db, p, { [F.pEnd]: '2026-12-11' }, { previous: { [F.pEnd]: prev }, at })).outcome).toBe('APPLIED');
      }
      const after = bulk.map((p) => `${p} 2026-12-11`);
      const r = await call(db, 'wf_reconcile_airtable', run.run_key, T.projects, read);
      expect(await bulkDates()).toEqual(after);                              // nothing undone or corrupted
      expect(r.corrections).toEqual([]);
      expect(await findings(run.run_key)).toEqual(bulk.map((p) => `${p}:Planned Completion:STALE_EVENT/NONE`));   // re-checked next run, no alarm
      expect(await one(db, `select count(*) v from workflow_exceptions where error_class = 'RECONCILIATION_MISMATCH' and resolution_status = 'OPEN'
                             and error_message like '%records show a different "Planned Completion"%' and last_attempt_at >= (select started_at from reconciliation_runs where run_key = $1)`, [run.run_key])).toBe('0');
      await call(db, 'wf_reconcile_finish', run.run_key, {}, []);
      // The next run reads Airtable after the edit: everything agrees.
      const next = await newRun();
      const n = await call(db, 'wf_reconcile_airtable', next.run_key, T.projects, await snapshot(T.projects, () => {}));
      expect([n.drift, n.corrections, await findings(next.run_key), await bulkDates()]).toEqual([0, [], [], after]);
      await call(db, 'wf_reconcile_finish', next.run_key, {}, []);
    });

    it('AC-02: a missed bulk edit (no webhook) is ambiguous: raised for a person, neither applied nor reverted, and stays raised', async () => {
      const before = await bulkDates();
      const ids = new Set(await Promise.all(bulk.map((p) => rec(db, 'project', p))));
      const staffRead = () => snapshot(T.projects, (id, f) => { if (ids.has(id)) f[F.pEnd] = '2026-12-18'; });
      for (let i = 0; i < 2; i++) {
        const run = await newRun();
        const r = await call(db, 'wf_reconcile_airtable', run.run_key, T.projects, await staffRead());
        expect(await bulkDates()).toEqual(before);                            // not applied to RoofOps
        expect(r).toMatchObject({ drift: 6, corrections: [] });               // not reverted in Airtable either
        expect(await findings(run.run_key)).toEqual(['-:Planned Completion:REQUIRES_HUMAN/EXCEPTION_OPENED']);
        expect(Number(await one(db, `select count(*) v from v_state_drift where field = 'Planned Completion' and business_key = any ($1)`, [bulk]))).toBe(6);
        await call(db, 'wf_reconcile_finish', run.run_key, {}, []);
      }
      // One actionable exception, reused on the second run (not one per run or per record).
      expect(await col(db, `select attempt_count::text v from workflow_exceptions where error_class = 'RECONCILIATION_MISMATCH' and resolution_status = 'OPEN'
                             and error_message like '6 of 30 Airtable Projects records show a different "Planned Completion"%'`)).toEqual(['2']);
    });
  });

  describe('AC-10: a value RoofOps wrote to Airtable is never applied back as a staff edit', () => {
    const day = async (p: string, c: string) => (await one(db, `select ${c}::text v from projects where project_number = $1`, [p]))!;
    const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const sim = async (p: string) => new Airtable06(db, T.projects, await rec(db, 'project', p)).init();

    it('a correction that landed but whose read-back failed, then a staff edit: no ping-pong, the staff edit wins, the cursor advances', async () => {
      const p = 'PRJ-2026-0016';
      const [start, finish] = [await day(p, 'planned_start_date'), await day(p, 'planned_completion_date')];
      const [invalid, wanted] = [plus(start, -1), plus(finish, 28)];
      const a = await sim(p);
      a.write({ [F.pEnd]: invalid }, 'staff');       // refused (before the start); RoofOps corrects Airtable back to the old finish
      a.failReadBackOnce.add(1);                     // that correction lands, but its read-back fails once
      await a.run();
      a.write({ [F.pEnd]: wanted }, 'staff');        // the staff member then moves the finish (valid)
      const canonical: string[] = [];
      for (let i = 0; i < 3; i++) {
        const end = a.last;
        await a.run();
        expect([i, a.cursor]).toEqual([i, end]);   // every execution consumes its whole batch: nothing is redelivered again
        canonical.push(await day(p, 'planned_completion_date'));
      }
      expect(a.ownWritesApplied).toEqual([]);                                 // before the fix: every run applied the echo
      expect(canonical).toEqual([wanted, wanted, wanted]);                    // never flips once the staff edit is in
      expect([a.cells[F.pEnd], a.cursor]).toEqual([wanted, a.last]);          // Airtable agrees; every payload consumed
      expect(await one(db, `select count(*) v from audit_events where action = 'project.planned_completion_date.changed' and business_reference = $1`, [p])).toBe('1');
    });

    it('a staff member who fixes their own refused edit before the correction lands is not told someone else changed it', async () => {
      const p = 'PRJ-2026-0012';
      const [start, finish] = [await day(p, 'planned_start_date'), await day(p, 'planned_completion_date')];
      const [invalid, fixed] = [plus(start, -1), plus(finish, 14)];
      const a = await sim(p);
      a.write({ [F.pEnd]: invalid }, 'staff');
      a.write({ [F.pEnd]: fixed }, 'staff');         // typed before 06 ran: both edits arrive in one batch
      await a.run(3);
      expect(a.outcomes.filter((o) => o.who === 'staff' && !o.duplicate).map((o) => o.outcome)).toEqual(['REJECTED', 'APPLIED']);
      expect(a.ownWritesApplied).toEqual([]);
      expect([await day(p, 'planned_completion_date'), a.cells[F.pEnd], a.cursor]).toEqual([fixed, fixed, a.last]);
    });

    it('reconciliation never replays a RoofOps write that Airtable still shows before its echo was processed', async () => {
      const p = 'PRJ-2026-0009';
      const [start, finish] = [await day(p, 'planned_start_date'), await day(p, 'planned_completion_date')];
      const [invalid, wanted] = [plus(start, -1), plus(finish, 21)];
      const a = await sim(p);
      a.write({ [F.pEnd]: invalid }, 'staff');
      a.failReadBackOnce.add(1);
      await a.run();
      a.write({ [F.pEnd]: wanted }, 'staff');
      await a.run();                                 // applies the staff edit; a re-issued, now stale, correction lands in Airtable
      expect(await day(p, 'planned_completion_date')).toBe(wanted);
      const stale = a.cells[F.pEnd];
      expect(stale).not.toBe(wanted);                // Airtable shows RoofOps's own out-of-date write; n8n 06 then goes down
      await db.exec(`update reconciliation_runs set started_at = started_at - interval '5 minutes'`);
      const run = await call(db, 'wf_reconcile_start', 'schedule', 'repair');
      const r = await call(db, 'wf_reconcile_airtable', run.run_key, T.projects, await snapshot(T.projects, (id, f) => { if (id === a.record) f[F.pEnd] = stale; }));
      expect(await day(p, 'planned_completion_date')).toBe(wanted);          // not replayed as a staff edit
      expect((r.corrections as unknown as { id: string; fields: Record<string, unknown> }[]).find((c) => c.id === a.record)?.fields)
        .toMatchObject({ [F.pEnd]: wanted });                                 // Airtable is put back to the staff member's value
      await call(db, 'wf_reconcile_finish', run.run_key, {}, []);
    });

    it('a reconciliation repair overtaken by a webhook change before 07 reads it back is proved as landed, and its echo converges', async () => {
      const p = 'PRJ-2026-0024';                     // In Progress, no Actual Completion yet
      const a = await sim(p);
      await db.exec(`update reconciliation_runs set started_at = started_at - interval '5 minutes'`);
      const run = await call(db, 'wf_reconcile_start', 'schedule', 'repair');
      // Someone typed an Actual Completion (owned by RoofOps) in Airtable: the repair run blanks it again.
      const r = await call(db, 'wf_reconcile_airtable', run.run_key, T.projects, await snapshot(T.projects, (id, f) => { if (id === a.record) f[F.pActualEnd] = '2026-09-01'; }));
      expect((r.corrections as unknown as { id: string; fields: Record<string, unknown> }[]).find((c) => c.id === a.record)?.fields).toMatchObject({ [F.pActualEnd]: null });
      a.cells[F.pActualEnd] = '2026-09-01';
      // Before 07 writes the repair, staff complete the job; 06 applies it (Actual Completion becomes today).
      a.write({ [F.pStatus]: 'Completed' }, 'staff');
      await a.run();
      const done = await day(p, 'actual_completion_date');
      // 07 now writes its (overtaken) repair and reads it back.
      a.write({ [F.pActualEnd]: null }, 'n8n');
      expect(await call(db, 'wf_airtable_writeback_verified', `reconcile:${String(run.run_key)}`, T.projects, a.record, { [F.pActualEnd]: null }))
        .toMatchObject({ verified: true, overtaken_fields: [F.pActualEnd] });
      await call(db, 'wf_reconcile_finish', run.run_key, {}, []);
      await a.run(2);                                // the echo of the repair: Airtable is put back to canonical
      expect([await day(p, 'actual_completion_date'), a.cells[F.pActualEnd], a.cursor, a.ownWritesApplied]).toEqual([done, done, a.last, []]);
    });

    it('a staff member may deliberately choose a value RoofOps once wrote (after its echo was seen)', async () => {
      const p = 'PRJ-2026-0010';
      const [start, finish] = [await day(p, 'planned_start_date'), await day(p, 'planned_completion_date')];
      const a = await sim(p);
      a.write({ [F.pEnd]: plus(start, -1) }, 'staff');        // refused; RoofOps writes `finish` back
      await a.run(2);
      a.write({ [F.pEnd]: plus(finish, 5) }, 'staff');
      await a.run(2);
      a.write({ [F.pEnd]: finish }, 'staff');                  // back to exactly the value RoofOps once wrote
      await a.run(2);
      expect([await day(p, 'planned_completion_date'), a.cells[F.pEnd], a.cursor]).toEqual([finish, finish, a.last]);
      expect(a.outcomes.filter((o) => o.who === 'staff' && !o.duplicate).map((o) => o.outcome)).toEqual(['REJECTED', 'APPLIED', 'APPLIED']);
    });

    /** The staff transaction's time relative to the still-unconsumed RoofOps write of the same value (minutes). */
    const insideWindow = async (a: Airtable06, value: string, n: number) => {
      const [w] = await db.query<{ at: string }>(`select issued_at::text at from airtable_writes where record_id = $1 and field_id = $2 and value = $3
                                                   and echoed_at is null order by issued_at limit 1`, [a.record, F.pEnd, value]);
      const m = (Date.parse(a.txns.find((t) => t.n === n)!.at) - Date.parse(w!.at)) / 60_000;
      return m >= -5 && m <= 30;                     // the webhook echo window: 5 minutes before to 30 minutes after issue
    };

    it('echo window: going back, in the same batch, to exactly the value a pending RoofOps correction writes is a staff edit', async () => {
      const p = 'PRJ-2026-0014';
      const [start, finish] = [await day(p, 'planned_start_date'), await day(p, 'planned_completion_date')];
      const audits = () => one(db, `select count(*) v from audit_events where action = 'project.planned_completion_date.changed' and business_reference = $1`, [p]);
      const audited = Number(await audits());
      const a = await sim(p);                        // no origin: holds with events from the current 06 too
      a.write({ [F.pEnd]: plus(start, -1) }, 'staff');        // refused; RoofOps will write `finish` back (not landed yet)
      a.write({ [F.pEnd]: plus(finish, 7) }, 'staff');         // fixed to a new valid date
      a.write({ [F.pEnd]: finish }, 'staff');                  // then deliberately back to `finish`, seconds later
      const [, , back] = a.txns;
      await a.run();
      expect(await insideWindow(a, finish, back!.n)).toBe(true);           // same value, inside the window, write unconsumed
      await a.run(2);
      expect(a.outcomes.filter((o) => o.who === 'staff' && !o.duplicate).map((o) => o.outcome)).toEqual(['REJECTED', 'APPLIED', 'APPLIED']);
      expect([await day(p, 'planned_completion_date'), a.cells[F.pEnd], a.cursor, a.ownWritesApplied]).toEqual([finish, finish, a.last, []]);
      expect(Number(await audits()) - audited).toBe(2);                     // the two staff edits; nothing for RoofOps's own write
    });

    it('echo window: a person in the Airtable UI choosing the value of an unconsumed RoofOps write from an earlier execution is a staff edit', async () => {
      const p = 'PRJ-2026-0017';
      const [start, finish] = [await day(p, 'planned_start_date'), await day(p, 'planned_completion_date')];
      const a = await new Airtable06(db, T.projects, await rec(db, 'project', p), true).init();
      a.write({ [F.pEnd]: plus(start, -1) }, 'staff');        // refused; RoofOps's correction to `finish` is issued...
      a.write({ [F.pEnd]: plus(finish, 7) }, 'staff');
      a.write({ [F.pEnd]: finish }, 'staff');                  // ...and lands on a cell that already shows `finish`: it never echoes
      await a.run();
      a.write({ [F.pEnd]: plus(finish, 3) }, 'staff');
      await a.run();
      a.write({ [F.pEnd]: finish }, 'staff');                  // minutes later, in a later execution: `finish` again
      expect(await insideWindow(a, finish, a.last)).toBe(true);
      await a.run(2);
      expect(a.outcomes.filter((o) => o.who === 'staff' && !o.duplicate).map((o) => o.outcome)).toEqual(['REJECTED', 'APPLIED', 'APPLIED', 'APPLIED', 'APPLIED']);
      expect([await day(p, 'planned_completion_date'), a.cells[F.pEnd], a.cursor, a.ownWritesApplied]).toEqual([finish, finish, a.last, []]);
    });

    it('the ledger of RoofOps writes is bounded: old settled and abandoned rows are pruned; a pending write is kept and still recognised', async () => {
      const p = 'PRJ-2026-0018';
      const [start, finish] = [await day(p, 'planned_start_date'), await day(p, 'planned_completion_date')];
      const [invalid, wanted] = [plus(start, -1), plus(finish, 10)];
      const a = await sim(p);
      a.write({ [F.pEnd]: invalid }, 'staff');
      a.failReadBackOnce.add(1);                     // the correction lands, its read-back fails: its write stays pending
      await a.run();
      const pending = await col(db, `select id::text v from airtable_writes where record_id = $1 and echoed_at is null and verified_at is null`, [a.record]);
      expect(pending.length).toBeGreaterThan(0);
      const age = (d: number, state: string) => `now() - interval '${String(d)} days', ${state}`;
      const junk = await col(db, `insert into airtable_writes (table_id, record_id, field_id, value, source_key, issued_at, echoed_at, verified_at)
        select $1, 'recRETENTION0001', $2, 'x', 'retention-test:' || s.k, s.at, s.echoed, s.verified from (values
          ('settled-10d', ${age(10, `now(), null`)}), ('echoed-40d', ${age(40, `now(), null`)}), ('verified-40d', ${age(40, `null, now()`)}),
          ('unsettled-40d', ${age(40, `null, null`)}), ('unsettled-100d', ${age(100, `null, null`)}))
          as s(k, at, echoed, verified)
        returning source_key v`, [T.projects, F.pEnd]);
      expect(junk).toHaveLength(5);
      a.write({ [F.pEnd]: wanted }, 'staff');
      await a.run(3);                                // recording writes prunes as it goes: no scheduler needed
      expect(await col(db, `select source_key v from airtable_writes where source_key like 'retention-test:%' order by 1`))
        .toEqual(['retention-test:settled-10d', 'retention-test:unsettled-40d']);   // kept: < 30 days settled, < 90 days unsettled
      expect(await col(db, `select id::text v from airtable_writes where id = any($1::bigint[])`, [pending])).toEqual(pending);   // pending kept
      // ...and still recognised: RoofOps's own write was not applied back, the staff edit stands, the cursor advanced.
      expect([await day(p, 'planned_completion_date'), a.cells[F.pEnd], a.cursor, a.ownWritesApplied]).toEqual([wanted, wanted, a.last, []]);
      expect(await one(db, `select count(*) v from airtable_writes where issued_at < now() - interval '90 days'
                              or (issued_at < now() - interval '30 days' and (echoed_at is not null or verified_at is not null))`)).toBe('0');
      await db.exec(`delete from airtable_writes where source_key like 'retention-test:%'`);
    });

    it('origin publicApi alone never makes a change an echo: it must match a recorded RoofOps write for that field', async () => {
      const p = 'PRJ-2026-0019';
      const [start, finish] = [await day(p, 'planned_start_date'), await day(p, 'planned_completion_date')];
      const a = await new Airtable06(db, T.projects, await rec(db, 'project', p), true).init();
      a.write({ [F.pEnd]: plus(finish, 2) }, 'api');           // another API client, nothing recorded for it: a staff edit
      await a.run();
      a.write({ [F.pEnd]: plus(start, -1) }, 'api');           // refused: RoofOps writes plus(finish, 2) back (recorded)
      await a.run(2);                                          // its echo (publicApi, matches the recorded write) is not applied
      a.write({ [F.pEnd]: plus(finish, 4) }, 'api');           // publicApi again, matching no pending RoofOps write
      await a.run(2);
      expect(a.outcomes.filter((o) => o.who === 'api' && !o.duplicate).map((o) => o.outcome)).toEqual(['APPLIED', 'REJECTED', 'APPLIED']);
      expect(a.outcomes.filter((o) => o.who === 'n8n' && !o.duplicate).map((o) => o.outcome)).toEqual(['NO_CHANGE']);
      expect([await day(p, 'planned_completion_date'), a.cells[F.pEnd], a.cursor, a.ownWritesApplied]).toEqual([plus(finish, 4), plus(finish, 4), a.last, []]);
      // Postgres sees the origin Airtable reported: every event of this record carries it.
      expect(await col(db, `select distinct payload ->> 'origin' v from automation_events where event_key like 'airtable:achSIM:%' || $1`, [a.record])).toEqual(['publicApi']);
    });
  });

  describe('health and webhook supervision', () => {
    const U = 'https://tejesh08.app.n8n.cloud/webhook/roofops/airtable/';
    it('a missed ping (unread payloads), an expiring hook and a missing hook are all detected; nothing is faked healthy', async () => {
      await db.query(`select wf_airtable_cursor_advance('achQUOTEHOOK00001', 40)`);
      const soon = new Date(Date.now() + 24 * 3600e3).toISOString(); const later = new Date(Date.now() + 6 * 24 * 3600e3).toISOString();
      const r = await call(db, 'wf_webhook_check', [
        { id: 'achQUOTEHOOK00001', notificationUrl: U + 'quote-events', isHookEnabled: true, expirationTime: later, cursorForNextPayload: 43, lastNotificationResult: { success: true } },
        { id: 'achINVOICEHOOK001', notificationUrl: U + 'project-invoice-events', isHookEnabled: true, expirationTime: soon, cursorForNextPayload: 1 }]);
      expect(r).toMatchObject({ ok: false, drain: [{ id: 'achQUOTEHOOK00001', unread: 3 }], refresh: ['achINVOICEHOOK001'], missing: [U + 'changes'] });
      expect(await one(db, `select ok::text v from v_system_health where service = 'airtable_webhooks'`)).toBe('false');
    });
    it('Xero is healthy only when the pinned Demo tenant is connected; tenant ids are not stored', async () => {
      await db.exec(`update app_settings set value = '11111111-2222-3333-4444-555555555555' where key = 'xero.demo_tenant_id'`);
      await call(db, 'wf_record_health', [{ service: 'xero', ok: true, detail: { tenant_ids: ['99999999-2222-3333-4444-555555555555'] } }]);
      expect(await one(db, `select ok::text || '|' || (detail ? 'tenant_ids')::text v from v_system_health where service = 'xero'`)).toBe('false|false');
      await call(db, 'wf_record_health', [{ service: 'xero', ok: true, detail: { tenant_ids: ['11111111-2222-3333-4444-555555555555'] } }]);
      expect(await one(db, `select ok::text v from v_system_health where service = 'xero'`)).toBe('true');
      expect(await one(db, `select count(*) v from v_system_health where checked_at is null`)).not.toBe('7');   // unknown services stay unknown, never "ok"
    });
  });

  describe('integrity:check', () => {
    it('every rule passes on the live-like data; breaking one (bypassing the triggers) is reported as FAIL', async () => {
      const fails = await col(db, `select entity || '.' || check_key v from integrity_check() where status = 'FAIL'`);
      expect(fails).toEqual([]);
      await db.exec('begin');
      await force(db, `update approvals set status = 'PENDING' where entity_id = (select id from projects where project_number = 'PRJ-2026-0005')`);
      expect(await col(db, `select entity || '.' || check_key v from integrity_check() where status = 'FAIL'`)).toContain('project.cancelled_has_no_open_work');
      await db.exec('rollback');
    });
  });

  describe.runIf(target === 'postgres')('real concurrency (two connections)', () => {
    it('invoice preparation and cancellation serialise on the project row: whichever commits first wins, deterministically', async () => {
      const b = await openPostgres(db.url!);
      try {
        // Cancellation first: preparation waits, then sees CANCELLED and refuses.
        await db.exec('begin');
        await project(db, 'PRJ-2026-0004', { [F.pStatus]: 'Cancelled' });
        const prep = call(b, 'wf_invoice_prepare', { event_id: 'race:prep:0004', event_type: 'invoice.prepare_requested', source: 'roofops-dashboard',
          actor_id: 'dashboard:copilot', occurred_at: '2026-09-29T09:00:00+10:00', payload: { project_number: 'PRJ-2026-0004' } });
        await new Promise((r) => setTimeout(r, 300));
        await db.exec('commit');
        expect((await prep).outcome).not.toBe('PREVIEW_READY');
        expect(await one(db, `select count(*) v from approvals where business_reference = 'PRJ-2026-0004' and status = 'PENDING'`)).toBe('0');

        // Two staff edits to the same project at the same time: one wins, the other is refused as a conflict.
        await db.exec('begin');
        const first = await project(db, 'PRJ-2026-0019', { [F.pStatus]: 'Cancelled' }, { previous: { [F.pStatus]: 'Scheduled' } });
        const second = change(b, T.projects, 'project', 'PRJ-2026-0019', { [F.pStatus]: 'In Progress' }, { previous: { [F.pStatus]: 'Scheduled' } });
        await new Promise((r) => setTimeout(r, 300));
        await db.exec('commit');
        expect([first.outcome, (await second).outcome]).toEqual(['APPLIED', 'REJECTED']);
        expect(await one(db, `select status v from projects where project_number = 'PRJ-2026-0019'`)).toBe('CANCELLED');
      } finally { await b.close(); }
    });

    /** True once the backend `pid` is blocked on a lock (checked from a third connection). */
    const waitingOnLock = async (pid: string) => {
      const w = await openPostgres(db.url!);
      try {
        for (let i = 0; i < 100; i += 1) {
          if (await one(w, `select count(*) v from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`, [Number(pid)]) === '1') return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return false;
      } finally { await w.close(); }
    };
    const pgNow = () => one(db, `select clock_timestamp()::text v`);

    it('AC-01 race: reconciliation with an older Airtable read waits for a concurrent staff edit, then defers it; the next run is normal', async () => {
      const recon = await openPostgres(db.url!);
      try {
        const reconPid = (await one(recon, `select pg_backend_pid()::text v`))!;
        await db.exec(`update reconciliation_runs set started_at = started_at - interval '5 minutes'`);
        const run = await call(db, 'wf_reconcile_start', 'schedule', 'repair');
        const id23 = await rec(db, 'project', 'PRJ-2026-0023');
        const read = await snapshot(T.projects, () => {});            // A: 07 reads Airtable (finish 2026-10-08)
        await db.exec('begin');                                        // B: a valid staff edit through n8n 06, not yet committed
        expect((await project(db, 'PRJ-2026-0023', { [F.pEnd]: '2026-10-10' }, { previous: { [F.pEnd]: '2026-10-08' }, at: await pgNow() })).outcome).toBe('APPLIED');
        const reconciling = call(recon, 'wf_reconcile_airtable', run.run_key, T.projects, read);   // A: continues with the older read
        expect(await waitingOnLock(reconPid)).toBe(true);
        await db.exec('commit');
        const r = await reconciling;                                   // resolves: no deadlock
        expect(await one(db, `select planned_completion_date::text v from projects where project_number = 'PRJ-2026-0023'`)).toBe('2026-10-10');
        expect(r).toMatchObject({ ok: true, rechecked_next_run: 1 });
        expect((r.corrections as unknown as { id: string }[]).find((c) => c.id === id23)).toBeUndefined();
        expect(await col(db, `select f.field || ':' || f.classification || '/' || f.action v from reconciliation_findings f
                               join reconciliation_runs x on x.id = f.run_id where x.run_key = $1 and f.entity_ref = 'PRJ-2026-0023'`, [run.run_key]))
          .toEqual(['Planned Completion:STALE_EVENT/NONE']);
        expect(await col(db, `select field v from v_state_drift where business_key = 'PRJ-2026-0023'`)).toEqual([]);
        await call(db, 'wf_reconcile_finish', run.run_key, {}, []);

        // Next run: a fresh read is compared normally. Airtable here also shows a later missed edit, which is replayed.
        await db.exec(`update reconciliation_runs set started_at = started_at - interval '5 minutes'`);
        const next = await call(db, 'wf_reconcile_start', 'schedule', 'repair');
        const r2 = await call(recon, 'wf_reconcile_airtable', next.run_key, T.projects, await snapshot(T.projects, (id, f) => { if (id === id23) f[F.pEnd] = '2026-10-12'; }));
        expect(r2).toMatchObject({ drift: 1, rechecked_next_run: 0 });
        expect(await col(db, `select f.classification || '/' || f.action v from reconciliation_findings f join reconciliation_runs x on x.id = f.run_id
                               where x.run_key = $1 and f.entity_ref = 'PRJ-2026-0023'`, [next.run_key])).toEqual(['SAFE_AUTO_REPAIR/APPLIED_TO_POSTGRES']);
        expect(await one(db, `select planned_completion_date::text v from projects where project_number = 'PRJ-2026-0023'`)).toBe('2026-10-12');
        await call(db, 'wf_reconcile_finish', next.run_key, {}, []);
      } finally { await recon.close(); }
    });

    it('AC-01 race, inverse: reconciliation holds the row first; a concurrent staff edit waits, then applies on top of the replay', async () => {
      const recon = await openPostgres(db.url!);
      try {
        const staffPid = (await one(db, `select pg_backend_pid()::text v`))!;
        await db.exec(`update reconciliation_runs set started_at = started_at - interval '5 minutes'`);
        const run = await call(db, 'wf_reconcile_start', 'schedule', 'repair');
        const id21 = await rec(db, 'project', 'PRJ-2026-0021');
        // A: Airtable shows a finish date (2026-10-30) whose webhook RoofOps never received; the repair replays it and
        // keeps the row locked until it commits.
        const read = await snapshot(T.projects, (id, f) => { if (id === id21) f[F.pEnd] = '2026-10-30'; });
        await recon.exec('begin');
        const r = await call(recon, 'wf_reconcile_airtable', run.run_key, T.projects, read);
        expect(r).toMatchObject({ drift: 1, rechecked_next_run: 0 });
        // B: staff (whose Airtable shows 2026-10-30) move it to 2026-11-02 while A is still open: B waits for A.
        const staff = project(db, 'PRJ-2026-0021', { [F.pEnd]: '2026-11-02' }, { previous: { [F.pEnd]: '2026-10-30' }, at: await pgNow() });
        expect(await waitingOnLock(staffPid)).toBe(true);
        await recon.exec('commit');
        // Deterministic: the replay commits first, then the staff edit is checked against it and applies. Newest value wins.
        expect((await staff).outcome).toBe('APPLIED');
        expect(await one(db, `select planned_completion_date::text v from projects where project_number = 'PRJ-2026-0021'`)).toBe('2026-11-02');
        expect(await col(db, `select f.classification || '/' || f.action v from reconciliation_findings f join reconciliation_runs x on x.id = f.run_id
                               where x.run_key = $1 and f.entity_ref = 'PRJ-2026-0021'`, [run.run_key])).toEqual(['SAFE_AUTO_REPAIR/APPLIED_TO_POSTGRES']);
        expect(await col(db, `select field v from v_state_drift where business_key = 'PRJ-2026-0021'`)).toEqual([]);
        await call(db, 'wf_reconcile_finish', run.run_key, {}, []);
      } finally {
        await recon.exec('rollback').catch(() => undefined);
        await recon.close();
      }
    });
  });
});
