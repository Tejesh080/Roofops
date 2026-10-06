/**
 * AC-14C Part B2 (docs/defect-ledger.md; mission architecture 4.2 item 11): the operator CLI and the committed
 * scenario builder - both engines.
 *
 * Pinned here:
 *  * the CLI (`scripts/reissue.ts`, `npm run reissue`) drives the database's own rules: `request` and `decide` produce
 *    exactly the state changes a direct SQL call produces (approval bound to invoice/state/preview, generation 2 with
 *    new keys, the invoice APPROVED / sync PENDING, the audit trail), and for the same input the CLI prints the
 *    function's answer unchanged.
 *  * every refusal the CLI meets exits 2 with the database's canonical code (unauthorized actor, missing or short
 *    reason, an invoice that is not voided, an unknown reference, a replay) and writes nothing.
 *  * on PostgreSQL the real process path runs too: `tsx scripts/reissue.ts` against a throwaway database, with the
 *    same state changes and the same exit codes.
 *  * the scenario builder (`test/helpers/reissue-scenario.ts`) deterministically builds the verified DELETED and
 *    VOIDED states through the real workflow functions on both engines, and can open, migrate, import and drop its
 *    own database.
 *  * the CLI ships documented, packaged and rule-free: no write of its own, no external call, no rule logic.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USAGE, runReissue } from '../scripts/reissue.js';
import { openPostgres, type Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';
import {
  approvedReissueScenario, deletedReissueScenario, voidedReissueScenario, type ReissueScenario,
} from './helpers/reissue-scenario.js';

type R = Record<string, unknown>;
const FINANCE = 'EMP-900';                                    // FINANCE, active (the dataset's approver)
const ADMIN = 'EMP-901';                                      // ADMIN, active (the builder's fixture)
const PM = 'EMP-001';                                         // PROJECT_MANAGER (outside invoice.reissue_roles)
const TENANT = '11111111-2222-3333-4444-555555555555';        // the pinned tenant, and every write's bound tenant
const P4 = 'PRJ-2026-0004';                                   // 14,664.49 left to bill
const P5 = 'PRJ-2026-0005';
const XID1 = 'aaaaaaaa-bbbb-cccc-dddd-0000000000a1';
const XID4 = 'aaaaaaaa-bbbb-cccc-dddd-0000000000a4';
const XID5 = 'aaaaaaaa-bbbb-cccc-dddd-0000000000a5';
const REASON = 'Xero deleted the draft; the customer still owes the job';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/reissue.ts', import.meta.url));

/** One CLI invocation, collected the way an operator (or a CI job) sees it. */
async function cli(db: Db, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runReissue(args, db, { print: (l) => out.push(l), error: (l) => err.push(l) });
  return { code, out, err, json: (out.length ? JSON.parse(out.join('\n')) : null) as R | null };
}

const counts = async (db: Db) => (await db.query<R>(`select (select count(*) from invoices)::int invoices,
    (select count(*) from outbox)::int outbox, (select count(*) from approvals)::int approvals,
    (select count(*) from audit_events)::int audit, (select count(*) from invoice_xero_draft_generations)::int ledger,
    (select count(*) from xero_invoice_observations)::int observations`))[0]!;

/** Nothing moved: one generation, one write, the invoice still in the state the builder left it in. */
async function untouched(s: ReissueScenario, status = 'VOIDED'): Promise<void> {
  expect(await s.ledger()).toHaveLength(1);
  expect(await s.outbox()).toHaveLength(1);
  expect(await s.state()).toMatchObject({ status, sync_status: 'SYNCED' });
}

const billing = async (db: Db, project: string) => (await db.query<R>(
  `select project_billing(p.id) b from projects p where p.project_number = $1`, [project]))[0]!.b as R;

/** A normalised fingerprint of the state one request + decision left behind (invoice ids replaced by placeholders). */
async function shape(s: ReissueScenario, approval: string): Promise<R> {
  const placeholder = (text: unknown) => String(text).split(s.invoice.id).join('<invoice>')
    .split(s.invoice.number).join('<number>').split(s.invoice.xid).join('<xid>').split(approval).join('<approval>');
  const st = await s.state();
  const led = await s.ledger();
  const out = await s.outbox();
  const ap = (await s.db.query<R>(`select action_type, entity_type, status, required_permission, payload_hash,
      expected_record_version, idempotency_key, execution_result from approvals where approval_number = $1`, [approval]))[0]!;
  return {
    invoice: `${String(st.status)}/${String(st.sync_status)}`,
    ledger: led.map((g) => [g.generation, g.status, placeholder(g.key), placeholder(g.xero_invoice_id), g.opened_by,
      placeholder(g.superseded_reason)].map(String).join(':')),
    outbox: out.map((o) => [o.generation, o.status, placeholder(o.idempotency_key)].map(String).join(':')),
    writes: out.map((o) => {
      const p = o.payload as R;
      return [o.generation, p.xero_tenant_id, p.generation, p.reissued_from_generation, p.reissued_by,
        placeholder(p.xero_invoice_number)].map(String).join(':');
    }),
    approval: [ap.action_type, ap.entity_type, ap.status, ap.required_permission, String(ap.payload_hash).length,
      String(ap.expected_record_version).length > 0, placeholder(ap.idempotency_key), String(ap.execution_result).length > 2].map(String).join(':'),
    bound: st.approval_id !== null,
  };
}

describe.each(TARGETS)('AC-14C B2: the operator CLI and the scenario builder [%s]', (target) => {
  let db: Db & { url?: string };
  beforeEach(async () => {
    db = await migratedDb(target);
    await importBundle(db);
  }, 120_000);
  afterEach(async () => { await db.close(); });

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-CLI-001: the CLI drives the same database rules.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-CLI-001 request/decide through the CLI leave exactly the state a direct SQL call leaves', async () => {
    const viaCli = await deletedReissueScenario(db, { project: P4, xid: XID4 });
    const viaSql = await deletedReissueScenario(db, { project: 'PRJ-2026-0001', xid: XID1 });
    const before = await counts(db);

    const req = await cli(db, ['request', '--invoice', viaCli.invoice.number, '--by', FINANCE, '--reason', REASON]);
    expect(req.code).toBe(0);
    expect(req.json).toMatchObject({ ok: true, code: 'REISSUE_REQUESTED', invoice_number: viaCli.invoice.number,
      invoice_id: viaCli.invoice.id, target_generation: 2 });
    expect(String(req.json!.approval_number)).toMatch(/^APR-\d{4}-\d{4}$/);
    expect(String(req.json!.payload_hash)).toMatch(/^[0-9a-f]{64}$/);
    // The request itself queues nothing: the write is still generation 1.
    expect(await viaCli.outbox()).toHaveLength(1);
    expect(await viaCli.ledger()).toHaveLength(1);

    // The same act through the function directly, on its own invoice.
    const sqlReq = await viaSql.request(FINANCE, REASON);
    expect(sqlReq).toMatchObject({ ok: true, code: 'REISSUE_REQUESTED', target_generation: 2 });

    const dec = await cli(db, ['decide', '--approval', String(req.json!.approval_number), '--by', FINANCE]);
    expect(dec.code).toBe(0);
    expect(dec.json).toMatchObject({ ok: true, code: 'REISSUE_QUEUED', invoice_number: viaCli.invoice.number, generation: 2,
      superseded_generation: 1, outbox_idempotency_key: `xero:invoice:${viaCli.invoice.id}:g2`,
      xero_idempotency_key: `roofops-${viaCli.invoice.id}-g2` });
    expect(await viaSql.decide(String(sqlReq.approval_number), FINANCE)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED', generation: 2 });

    // The two paths are indistinguishable: same ledger, same writes, same approval binding, same invoice state.
    expect(await shape(viaCli, String(req.json!.approval_number))).toEqual(await shape(viaSql, String(sqlReq.approval_number)));
    expect(await viaCli.ledger()).toMatchObject([
      { generation: 1, status: 'SUPERSEDED', xero_invoice_id: XID4, tenant_id: TENANT },
      { generation: 2, status: 'PENDING', key: `xero:invoice:${viaCli.invoice.id}:g2`, opened_by: `operator:${FINANCE}` }]);
    expect(await viaCli.state()).toMatchObject({ status: 'APPROVED', sync_status: 'PENDING', invoice_number: viaCli.invoice.number });
    const audit = await db.query<{ v: string }>(`select action v from audit_events where entity_id = $1 and action like 'invoice.reissue%'`, [viaCli.invoice.id]);
    expect(audit.map((r) => r.v)).toEqual(expect.arrayContaining(['invoice.reissue_requested', 'invoice.reissued']));
    expect(await viaCli.integrityFails()).toEqual([]);
    // Nothing was deleted: one more outbox row and approval per path, two audit events per path, one ledger row per path.
    expect(await counts(db)).toMatchObject({ invoices: before.invoices, outbox: Number(before.outbox) + 2,
      approvals: Number(before.approvals) + 2, audit: Number(before.audit) + 4, ledger: Number(before.ledger) + 2 });
  }, 180_000);

  // ---------------------------------------------------------------------------------------------------------------
  // VAL-CLI-002: refusals surface the canonical code with exit 2, and nothing is written.
  // ---------------------------------------------------------------------------------------------------------------
  it('VAL-CLI-002 refusals exit 2 with the database code and no writes; the CLI is a pass-through', async () => {
    const s = await deletedReissueScenario(db, { project: P4, xid: XID4 });
    const live = await approvedReissueScenario(db, { project: P5, xid: XID5 });
    const before = await counts(db);

    const cases: { args: string[]; code: string }[] = [
      { args: ['request', '--invoice', s.invoice.number, '--by', PM, '--reason', REASON], code: 'ACTOR_UNAUTHORIZED' },
      { args: ['request', '--invoice', s.invoice.number, '--by', FINANCE], code: 'REASON_REQUIRED' },
      { args: ['request', '--invoice', s.invoice.number, '--by', FINANCE, '--reason', 'nope'], code: 'REASON_REQUIRED' },
      { args: ['request', '--invoice', s.invoice.number, '--by', FINANCE, '--reason', '   '], code: 'REASON_REQUIRED' },
      { args: ['request', '--invoice', live.invoice.number, '--by', FINANCE, '--reason', REASON], code: 'INVOICE_NOT_VOIDED' },
      { args: ['request', '--invoice', 'INV-2099-9999', '--by', FINANCE, '--reason', REASON], code: 'NOT_FOUND' },
      { args: ['decide', '--approval', 'APR-2099-9999', '--by', FINANCE], code: 'NOT_FOUND' },
    ];
    for (const c of cases) {
      const r = await cli(db, c.args);
      expect(r.code, JSON.stringify(c.args)).toBe(2);
      expect(r.json, JSON.stringify(c.args)).toMatchObject({ ok: false, code: c.code });
      expect(String(r.json!.detail).length).toBeGreaterThan(0);
    }
    // No refusal wrote anything, anywhere.
    expect(await counts(db)).toEqual(before);
    await untouched(s);
    await untouched(live, 'APPROVED');

    // The CLI prints exactly what the database function answers: it holds no rules of its own.
    const throughCli = await cli(db, ['request', '--invoice', live.invoice.number, '--by', FINANCE, '--reason', REASON]);
    const throughSql = await live.request(FINANCE, REASON);
    expect(throughCli.json).toEqual(throughSql);

    // An open request: the decide path refuses an unauthorized actor, then a replay - both without writing.
    const ok = await cli(db, ['request', '--invoice', s.invoice.number, '--by', FINANCE, '--reason', REASON]);
    expect(ok.code).toBe(0);
    const approval = String(ok.json!.approval_number);
    const wrongActor = await cli(db, ['decide', '--approval', approval, '--by', PM]);
    expect(wrongActor.code).toBe(2);
    expect(wrongActor.json).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    expect(await s.state()).toMatchObject({ status: 'VOIDED' });

    const decided = await cli(db, ['decide', '--approval', approval, '--by', FINANCE, '--note', 'checked the customer account']);
    expect(decided.code).toBe(0);
    expect(decided.json).toMatchObject({ ok: true, code: 'REISSUE_QUEUED', generation: 2 });
    const after = await counts(db);
    const replay = await cli(db, ['decide', '--approval', approval, '--by', FINANCE]);
    expect(replay.code).toBe(2);
    expect(replay.json).toMatchObject({ ok: false, code: 'ALREADY_PROCESSED', duplicate: true });
    expect(await counts(db)).toEqual(after);

    // Usage mistakes never reach the database: exit 1, the usage text, no JSON.
    for (const bad of [[], ['request', '--invoice', s.invoice.number], ['decide', '--by', FINANCE],
      ['request', '--invoice', s.invoice.number, '--by', FINANCE, '--reason'], ['frobnicate', '--by', FINANCE]]) {
      const r = await cli(db, bad);
      expect(r.code, JSON.stringify(bad)).toBe(1);
      expect(r.json, JSON.stringify(bad)).toBeNull();
      expect(r.err.join('\n'), JSON.stringify(bad)).toContain('usage:');
    }
  }, 180_000);

  // ---------------------------------------------------------------------------------------------------------------
  // The scenario builder: both void families, one engine at a time, through the real workflow functions.
  // ---------------------------------------------------------------------------------------------------------------
  it('the scenario builder builds the verified DELETED and VOIDED states the facility needs', async () => {
    const deleted = await deletedReissueScenario(db, { project: P4, xid: XID4 });
    expect(await deleted.state()).toMatchObject({ status: 'VOIDED', sync_status: 'SYNCED' });
    expect(await deleted.link()).toBe(XID4);
    expect(await deleted.latestObservation()).toMatchObject({ verdict: 'VERIFIED', settlement: 'DELETED', tenant_id: TENANT, xero_invoice_id: XID4 });
    expect(await deleted.ledger()).toMatchObject([{ generation: 1, status: 'CREATED', xero_invoice_id: XID4, tenant_id: TENANT }]);
    expect((await deleted.outbox())[0]).toMatchObject({ generation: 1, status: 'DONE' });
    // The B1b state the facility exists for: not collectible, still owed, the close gate still refusing.
    expect(await deleted.balance()).toMatchObject({ outstanding: '0.00', is_overdue: false });
    expect(Number((await billing(db, P4)).remaining)).toBeGreaterThan(0);
    expect(await deleted.integrityFails()).toEqual([]);
    // ... and the facility works on the built state, which is the whole point of the builder.
    const req = await deleted.request(FINANCE, REASON);
    expect(req).toMatchObject({ ok: true, code: 'REISSUE_REQUESTED', target_generation: 2 });
    expect(await deleted.decide(String(req.approval_number), FINANCE)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED', generation: 2 });

    const voided = await voidedReissueScenario(db, { project: P5, xid: XID5 });
    expect(await voided.state()).toMatchObject({ status: 'VOIDED', sync_status: 'SYNCED' });
    expect(String((await voided.state()).voided_reason)).toMatch(/^Voided in Xero \(verified by reconciliation/);
    expect(await voided.latestObservation()).toMatchObject({ verdict: 'VERIFIED', settlement: 'VOIDED', tenant_id: TENANT, xero_invoice_id: XID5 });
    expect(await voided.balance()).toMatchObject({ outstanding: '0.00', is_overdue: false });
    expect(Number((await billing(db, P5)).remaining)).toBeGreaterThan(0);
    expect(await voided.integrityFails()).toEqual([]);
    const req2 = await voided.request(ADMIN, REASON);
    expect(req2).toMatchObject({ ok: true, code: 'REISSUE_REQUESTED' });
    expect(await voided.decide(String(req2.approval_number), ADMIN)).toMatchObject({ ok: true, code: 'REISSUE_QUEUED', generation: 2 });

    // The live fixture is the "not reissuable" state: nothing is voided, so the database refuses.
    const live = await approvedReissueScenario(db, { project: 'PRJ-2026-0002', xid: 'aaaaaaaa-bbbb-cccc-dddd-0000000000a2' });
    expect(await live.state()).toMatchObject({ status: 'APPROVED', sync_status: 'SYNCED' });
    expect(await live.link()).toBe('aaaaaaaa-bbbb-cccc-dddd-0000000000a2');
    expect(await live.request(FINANCE, REASON)).toMatchObject({ ok: false, code: 'INVOICE_NOT_VOIDED' });
  }, 180_000);

  it('the builder can open, migrate, import and drop a database of its own', async () => {
    const s = await deletedReissueScenario(target === 'postgres' ? 'postgres' : 'pglite');
    if (target === 'postgres') expect(String(s.db.url)).toContain('roofops_t_');
    try {
      expect(await s.state()).toMatchObject({ status: 'VOIDED' });
      expect(await s.outbox()).toHaveLength(1);
      expect(await s.integrityFails()).toEqual([]);
    } finally {
      await s.close();
    }
    // A closed throwaway Postgres database is really gone (PGlite holds no server to drop).
    if (target === 'postgres') await expect(openPostgres(String(s.db.url))).rejects.toThrow();
  }, 180_000);

  // ---------------------------------------------------------------------------------------------------------------
  // On PostgreSQL: the real process, exactly as `npm run reissue` runs it.
  // ---------------------------------------------------------------------------------------------------------------
  it.runIf(target === 'postgres')('the real CLI process drives the throwaway database (request, decide, replay, refusal)', async () => {
    const s = await deletedReissueScenario(db, { project: P4, xid: XID4 });
    const run = (args: string[]) => spawnSync(process.execPath, [TSX, SCRIPT, ...args],
      { cwd: ROOT, env: { ...process.env, DATABASE_URL: db.url }, encoding: 'utf8', timeout: 120_000, windowsHide: true });

    const req = run(['request', '--invoice', s.invoice.number, '--by', FINANCE, '--reason', REASON]);
    expect(req.status, req.stderr).toBe(0);
    const reqJson = JSON.parse(req.stdout.trim()) as R;
    expect(reqJson).toMatchObject({ ok: true, code: 'REISSUE_REQUESTED', invoice_number: s.invoice.number });
    expect(await s.ledger()).toHaveLength(1);

    const dec = run(['decide', '--approval', String(reqJson.approval_number), '--by', FINANCE]);
    expect(dec.status, dec.stderr).toBe(0);
    expect(JSON.parse(dec.stdout.trim())).toMatchObject({ ok: true, code: 'REISSUE_QUEUED', generation: 2 });
    expect(await s.state()).toMatchObject({ status: 'APPROVED', sync_status: 'PENDING' });

    const replay = run(['decide', '--approval', String(reqJson.approval_number), '--by', FINANCE]);
    expect(replay.status, replay.stderr).toBe(2);
    expect(JSON.parse(replay.stdout.trim())).toMatchObject({ ok: false, code: 'ALREADY_PROCESSED' });

    const unauthorized = run(['request', '--invoice', s.invoice.number, '--by', PM, '--reason', REASON]);
    expect(unauthorized.status).toBe(2);
    expect(JSON.parse(unauthorized.stdout.trim())).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });

    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stderr).toContain('npm run reissue -- request');
    expect(await s.integrityFails()).toEqual([]);
  }, 180_000);

  // ---------------------------------------------------------------------------------------------------------------
  // Documented, packaged, rule-free.
  // ---------------------------------------------------------------------------------------------------------------
  it('the CLI is documented, packaged and carries no rules of its own', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).toContain('ops_reissue_request');
    expect(source).toContain('ops_reissue_decide');
    // No write of its own and no external call: two decisions and one read-only lookup, nothing else.
    expect(source).not.toMatch(/insert into|delete from|update \w+ set|fetch\(|https?:\/\//i);
    expect(source.match(/select /gi)).toHaveLength(3);
    const calls = [...source.matchAll(/select\s+([a-z_]+)\(/gi)].map((m) => m[1]);
    expect(calls.sort()).toEqual(['ops_reissue_decide', 'ops_reissue_request']);

    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.reissue).toBe('tsx scripts/reissue.ts');

    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
    expect(readme).toContain('npm run reissue -- request');
    expect(readme).toContain('npm run reissue -- decide');
    expect(USAGE).toContain('request --invoice');
    expect(USAGE).toContain('decide  --approval');
    expect(USAGE).toMatch(/0 success, 2 refused .*1 usage/);
  });
});
