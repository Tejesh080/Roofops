/**
 * AC-14C follow-up, audit P2-D3: the supported Finance/Admin operator path for a queued reissue, both engines.
 *
 * `npm run reissue -- request` / `decide` (Part B2) queue generation 2; `status` shows where the current generation
 * stands; `dispatch --hosted` asks [RoofOps] 08 to send the proven write through the unchanged 05 and reports how it
 * settled. Here the n8n side is simulated with the real database functions 08 and 05 call (wf_reissue_dispatch, the
 * generation-aware claim and completion), so every outcome the operator sees comes from the database.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runReissue } from '../scripts/reissue.js';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { n8nReissueTrigger } from '../src/ops/reissue-dispatch.js';
import { TARGETS, migratedDb } from './helpers/db.js';
import { approvedReissueScenario, deletedReissueScenario, type ReissueScenario } from './helpers/reissue-scenario.js';

type R = Record<string, unknown>;
const FINANCE = 'EMP-900';
const REASON = 'Xero deleted the draft; the customer still owes the job';
const P4 = 'PRJ-2026-0004';
const XID4 = 'aaaaaaaa-bbbb-cccc-dddd-0000000000a4';
const TOKEN = 'reissue-dispatch-test-token';
const uuidFor = (seed: string) => createHash('md5').update(seed).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const noSleep = async () => {};

describe.each(TARGETS)('AC-14C P2-D3: the reissue status and dispatch operator path [%s]', (target) => {
  let db: Db & { url?: string };
  let s: ReissueScenario;
  beforeEach(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.query(`update app_settings set value = encode(sha256(convert_to($1, 'UTF8')), 'hex') where key = 'reissue.dispatch_token_sha256'`, [TOKEN]);
  }, 120_000);
  afterEach(async () => { await db.close(); });

  const one = async (sql: string, p: unknown[] = []) => (await db.query<R>(sql, p))[0]!;
  const force = async (sql: string, p: unknown[] = []) => {
    await db.exec(`set session_replication_role = replica`);
    try { await db.query(sql, p); } finally { await db.exec(`set session_replication_role = origin`).catch(() => undefined); }
  };
  async function cli(args: string[], deps: Parameters<typeof runReissue>[3] = {}) {
    const out: string[] = []; const err: string[] = [];
    const code = await runReissue(args, db, { print: (l) => out.push(l), error: (l) => err.push(l) }, { sleep: noSleep, polls: 3, ...deps });
    return { code, err: err.join('\n'), json: (out.length ? JSON.parse(out.join('\n')) : null) as R | null };
  }
  /** A reissue decided through the CLI: generation 2 queued for the deleted final invoice. */
  async function queued() {
    s = await deletedReissueScenario(db, { project: P4, xid: XID4 });
    const req = await cli(['request', '--invoice', s.invoice.number, '--by', FINANCE, '--reason', REASON]);
    expect((await cli(['decide', '--approval', String(req.json!.approval_number), '--by', FINANCE])).json).toMatchObject({ ok: true, generation: 2 });
  }
  /**
   * What [RoofOps] 08 then 05 do in n8n, through the same database functions: 08 lists the proven writes for the token;
   * 05 claims each (re-proving it), creates the draft and completes with the read-back proof - or fails it.
   */
  const n8n = (token: string, o: { fail?: boolean } = {}) => {
    const calls: R[] = [];
    const trigger = async (sel: { invoice_number: string; generation: number }) => {
      const d = (await one(`select wf_reissue_dispatch($1, $2, $3, 'n8n:test') d`, [token, sel.invoice_number, sel.generation])).d as R;
      calls.push(d);
      for (const w of (d.writes ?? []) as R[]) {
        const key = String(w.xero_key);
        const c = (await one(`select wf_claim_side_effect($1, 'n8n:05', 120) c`, [key])).c as R;
        if (c.claimed !== true) continue;
        if (o.fail) { await db.query(`select wf_fail_side_effect($1, 'RATE_LIMITED', 'create draft invoice: HTTP 429', 429, 0)`, [key]); continue; }
        const p = (await one(`select payload from outbox where idempotency_key = $1`, [key])).payload as R;
        await db.query(`select wf_complete_side_effect($1, $2::jsonb)`, [key, JSON.stringify({ verified: true, tenant_id: p.xero_tenant_id,
          organisation_class: 'DEMO', invoice_id: uuidFor(`replacement:${s.invoice.id}`), invoice_number: p.xero_invoice_number, reference: p.reference,
          status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false, contact_id: uuidFor(`contact:${String(p.customer_id)}`),
          contact_number: p.xero_contact_number, total: p.amount_inc_gst, total_tax: p.gst_amount, currency: 'AUD', line_amount_types: 'Inclusive',
          matching_invoices: 1 })]);
      }
    };
    return { trigger, calls };
  };

  it('status shows the queued generation 2; dispatch creates it through 08 -> 05 and reports REISSUE_CREATED', async () => {
    await queued();
    const st = await cli(['status', '--invoice', s.invoice.number]);
    expect(st.code).toBe(0);
    expect(st.json).toMatchObject({ ok: true, invoice_number: s.invoice.number, status: 'APPROVED', sync_status: 'PENDING', generation: 2,
      ledger_status: 'PENDING', outbox_status: 'PENDING', xero_link: XID4, open_exceptions: [] });

    const fake = n8n(TOKEN);
    const r = await cli(['dispatch', '--invoice', s.invoice.number], { trigger: fake.trigger });
    expect(r.code, r.err).toBe(0);
    const fresh = uuidFor(`replacement:${s.invoice.id}`);
    expect(r.json).toMatchObject({ ok: true, code: 'REISSUE_CREATED', generation: 2, ledger_status: 'CREATED', sync_status: 'SYNCED',
      outbox_status: 'DONE', xero_invoice_id: fresh, xero_link: fresh, xero_invoice_number: (await s.ledger())[0]!.xero_invoice_number });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ ok: true, selection: { invoice_number: s.invoice.number, generation: 2 } });   // the one write the CLI named
    expect(await s.integrityFails()).toEqual([]);

    // Dispatching again sends nothing: the generation already exists.
    const again = n8n(TOKEN);
    expect((await cli(['dispatch', '--invoice', s.invoice.number], { trigger: again.trigger })).json).toMatchObject({ ok: true, code: 'REISSUE_CREATED' });
    expect(again.calls).toHaveLength(0);
  }, 180_000);

  it('a refused token or an unproven write dispatches nothing: STILL_PENDING, the link unchanged, the exception shown', async () => {
    await queued();
    const wrong = await cli(['dispatch', '--invoice', s.invoice.number], { trigger: n8n('not-the-token').trigger });
    expect(wrong.code).toBe(2);
    expect(wrong.json).toMatchObject({ ok: false, code: 'STILL_PENDING', outbox_status: 'PENDING', ledger_status: 'PENDING', xero_link: XID4 });

    // The write no longer carries the approved draft: 08 does not list it and 05's claim would refuse it.
    await force(`update outbox set payload = jsonb_set(payload, '{amount_inc_gst}', to_jsonb((payload ->> 'amount_inc_gst')::numeric + 1))
                  where idempotency_key = xero_draft_outbox_key($1, 2)`, [s.invoice.id]);
    await db.query(`select wf_claim_side_effect(xero_draft_outbox_key($1, 2), 'n8n:05', 120)`, [s.invoice.id]);   // 05 run by hand: refused
    const tampered = await cli(['dispatch', '--invoice', s.invoice.number], { trigger: n8n(TOKEN).trigger });
    expect(tampered.code).toBe(2);
    expect(tampered.json).toMatchObject({ ok: false, code: 'STILL_PENDING', xero_link: XID4 });
    expect((tampered.json!.open_exceptions as R[]).map((e) => e.error_class)).toContain('RECONCILIATION_MISMATCH');
  }, 180_000);

  it('a write 05 failed is reported REISSUE_NOT_CREATED with its error; a trigger n8n rejects exits 1', async () => {
    await queued();
    const failed = await cli(['dispatch', '--invoice', s.invoice.number], { trigger: n8n(TOKEN, { fail: true }).trigger });
    expect(failed.code).toBe(2);
    expect(failed.json).toMatchObject({ ok: false, code: 'REISSUE_NOT_CREATED', outbox_status: 'FAILED', xero_link: XID4,
      last_error: expect.stringMatching(/HTTP 429/) as unknown });

    const rejected = await cli(['dispatch', '--invoice', s.invoice.number], { trigger: () => Promise.reject(new Error('n8n did not accept the reissue dispatch trigger: HTTP 404')) });
    expect(rejected.code).toBe(1);
    expect(rejected.err).toMatch(/HTTP 404/);
  }, 180_000);

  it('no reissue queued: nothing is triggered; dispatch without --hosted and an unknown invoice are refused', async () => {
    s = await approvedReissueScenario(db, { project: 'PRJ-2026-0002', xid: 'aaaaaaaa-bbbb-cccc-dddd-0000000000a2' });
    const fake = n8n(TOKEN);
    const none = await cli(['dispatch', '--invoice', s.invoice.number], { trigger: fake.trigger });
    expect(none.code).toBe(2);
    expect(none.json).toMatchObject({ ok: false, code: 'NO_REISSUE_QUEUED', generation: 1 });
    expect(fake.calls).toHaveLength(0);

    const local = await cli(['dispatch', '--invoice', s.invoice.number]);
    expect(local.code).toBe(1);
    expect(local.err).toMatch(/dispatch needs --hosted/);
    expect(local.json).toBeNull();

    for (const cmd of ['status', 'dispatch']) {
      const unknown = await cli([cmd, '--invoice', 'INV-2099-9999'], { trigger: fake.trigger });
      expect(unknown.code, cmd).toBe(2);
      expect(unknown.json, cmd).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    }
    expect((await cli(['status'])).code).toBe(1);
  }, 180_000);
});

describe('AC-14C P2-D3: the dispatch trigger', () => {
  const saved = { token: process.env.REISSUE_DISPATCH_TOKEN, base: process.env.N8N_BASE_URL };
  afterEach(() => {
    if (saved.token === undefined) delete process.env.REISSUE_DISPATCH_TOKEN; else process.env.REISSUE_DISPATCH_TOKEN = saved.token;
    if (saved.base === undefined) delete process.env.N8N_BASE_URL; else process.env.N8N_BASE_URL = saved.base;
  });

  it('POSTs [RoofOps] 08\'s webhook path with the token header; a non-2xx answer or a missing token is an error', async () => {
    process.env.REISSUE_DISPATCH_TOKEN = TOKEN;
    process.env.N8N_BASE_URL = 'https://n8n.example.test';
    const seen: { url: string; init: RequestInit }[] = [];
    const ok = ((url: string, init: RequestInit) => { seen.push({ url, init }); return Promise.resolve(new Response(null, { status: 200 })); }) as unknown as typeof fetch;
    await n8nReissueTrigger(ok)({ invoice_number: 'INV-2026-0040', generation: 2 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://n8n.example.test/webhook/roofops/reissue/dispatch');
    expect(seen[0]!.init).toMatchObject({ method: 'POST', headers: { 'x-roofops-token': TOKEN } });
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ invoice_number: 'INV-2026-0040', generation: 2 });   // exactly one selected write
    // The path is exactly 08's webhook path.
    expect(readFileSync(fileURLToPath(new URL('../n8n/08-reissue-dispatch.sdk.ts', import.meta.url)), 'utf8')).toContain("path: 'roofops/reissue/dispatch'");

    const refused = (() => Promise.resolve(new Response(null, { status: 403 }))) as unknown as typeof fetch;
    await expect(n8nReissueTrigger(refused)({ invoice_number: 'INV-2026-0040', generation: 2 })).rejects.toThrow(/HTTP 403/);
    delete process.env.REISSUE_DISPATCH_TOKEN;
    await expect(n8nReissueTrigger(ok)({ invoice_number: 'INV-2026-0040', generation: 2 })).rejects.toThrow(/REISSUE_DISPATCH_TOKEN/);
    expect(seen).toHaveLength(1);
  });

  it('the operator module writes nothing and calls nothing but 08\'s webhook', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/ops/reissue-dispatch.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/insert into|delete from|update \w+ set|select\s+(wf|ops)_\w+\(/i);
    expect(source.match(/fetchImpl\(/g)).toHaveLength(1);
    expect(source).toContain('/webhook/roofops/reissue/dispatch');
  });
});
