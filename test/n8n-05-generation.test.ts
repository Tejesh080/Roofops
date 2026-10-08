/**
 * AC-14C follow-up, audit P2-D2 (n8n side): [RoofOps] 05's real Reconcile Before Create and Verify Xero Read-Back code,
 * run offline through the recorder with seeded inputs (no Xero, no database).
 *
 * Generation 1 behaves exactly as before. Generation >= 2 (the claim proved it and handed over the superseded Xero
 * InvoiceIDs): the superseded document(s) with the same invoice number, VOIDED or DELETED, are expected and tolerated;
 * a superseded document that is live again, an unknown dead document with the same number, or a generation >= 2 claim
 * without its superseded list are refused; an idempotent retry adopts only a fresh, matching DRAFT; a stale InvoiceID
 * can never be read back as the new generation's draft.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { recorded } from './helpers/n8n-sdk-shim.js';
import { N8nRun, type Item } from './helpers/n8n-runner.js';

type R = Record<string, unknown>;
const C = 'cccccccc-0000-0000-0000-000000000001';               // the Xero ContactID the contact step resolved
const OLD = 'aaaaaaaa-0000-0000-0000-000000000001';              // generation 1's Xero InvoiceID (superseded)
const NEW = 'bbbbbbbb-0000-0000-0000-000000000002';              // generation 2's draft
const TENANT = '11111111-2222-3333-4444-555555555555';
const JOB = { xero_invoice_number: 'RO-INV-2026-0039', reference: 'PRJ-2026-0004', amount_inc_gst: 14564.49, gst_amount: 1324.04,
  xero_contact_number: 'RO-CUST-0004', xero_tenant_id: TENANT };
const inv = (o: R) => ({ InvoiceID: NEW, Type: 'ACCREC', InvoiceNumber: JOB.xero_invoice_number, Reference: JOB.reference, Status: 'DRAFT',
  Contact: { ContactID: C, Name: 'Ella [CUST-0004]' }, Total: JOB.amount_inc_gst, TotalTax: JOB.gst_amount, SubTotal: 13240.45,
  LineAmountTypes: 'Inclusive', CurrencyCode: 'AUD', AmountPaid: 0, ...o });
const noDb = { query: () => { throw new Error('no database in a code-node test'); }, exec: () => { throw new Error('no database'); }, close: async () => {} } as unknown as Db;

describe('AC-14C P2-D2: 05 is generation-aware (real node code)', () => {
  beforeAll(async () => {
    recorded.nodes.clear(); recorded.edges.length = 0;
    const sdk = '../n8n/05-xero-draft-invoice.sdk.ts';                             // a variable: typecheck does not follow it into n8n's SDK
    await import(/* @vite-ignore */ sdk);
  });
  const claimItem = (g?: { generation: number; superseded?: string[] }) => [{ json: { c: { claimed: true, attempt: 1, payload: JOB,
    ...(g ? { generation: g.generation, ...(g.superseded ? { superseded_xero_invoice_ids: g.superseded } : {}), reissue_approval_number: 'APR-2026-0009' } : {}) } } }];
  const runNode = async (name: string, seeds: Record<string, Item[]>, input: Item[]) => {
    const r = new N8nRun(recorded.nodes, recorded.edges, { db: noDb, http: () => { throw new Error('no HTTP in a code-node test'); } });
    for (const [k, v] of Object.entries(seeds)) r.seed(k, v);
    await r.run(name, input, recorded.edges.filter((e) => e.from === name).map((e) => e.to));
    return r.out.get(name)![0]!.json;
  };
  const reconcile = (byNumber: R[], g?: { generation: number; superseded?: string[] }, byReference: R[] = byNumber) => runNode('Reconcile Before Create', {
    'Claim Xero Draft': claimItem(g), 'Search Xero By Invoice Number': [{ json: { statusCode: 200, body: { Invoices: byNumber } } }],
    'Check Contact Search': [{ json: { found: true, contact_id: C } }] }, [{ json: { statusCode: 200, body: { Invoices: byReference } } }]);
  const verify = (readBack: R, created: string, g?: { generation: number; superseded?: string[] }) => runNode('Verify Xero Read-Back', {
    'Claim Xero Draft': claimItem(g), 'Read Back Invoice': [{ json: { statusCode: 200, body: { Invoices: [readBack] } } }],
    'Reconcile Before Create': [{ json: { ok: true, exists: false, contact_id: C } }], 'Check Invoice Create': [{ json: { ok: true, invoice_id: created, contact_id: C } }],
    'Check Pinned Tenant Connected': [{ json: { tenant_id: TENANT, tenant_name: 'Demo Company (AU)' } }], 'Check Demo Company': [{ json: { organisation_class: 'DEMO' } }] },
    [{ json: { statusCode: 200, body: { Invoices: [readBack].filter((i) => !['VOIDED', 'DELETED'].includes(String(i.Status))) } } }]);

  describe('generation 1: unchanged', () => {
    it('nothing in Xero: create', async () => {
      expect(await reconcile([])).toEqual({ ok: true, exists: false, contact_id: C });
    });
    it('only a VOIDED document with the number: a person decides (as before)', async () => {
      expect(await reconcile([inv({ InvoiceID: OLD, Status: 'VOIDED' })])).toMatchObject({ ok: false, failure: { error_class: 'RECONCILIATION_MISMATCH', message: expect.stringMatching(/exists in Xero as VOIDED; a person must decide/) as unknown } });
    });
    it('a matching live DRAFT: adopt it', async () => {
      expect(await reconcile([inv({})])).toEqual({ ok: true, exists: true, invoice_id: NEW, contact_id: C, adopted: true });
    });
    it('read-back of the created draft: verified', async () => {
      expect(await verify(inv({}), NEW)).toMatchObject({ ok: true, proof: { invoice_id: NEW, matching_invoices: 1 } });
    });
  });

  describe('generation 2: the superseded document is expected, never adopted or linked', () => {
    const g2 = { generation: 2, superseded: [OLD] };
    it('the superseded document VOIDED or DELETED with the same number: create the replacement', async () => {
      for (const st of ['VOIDED', 'DELETED']) expect([st, await reconcile([inv({ InvoiceID: OLD, Status: st })], g2)]).toEqual([st, { ok: true, exists: false, contact_id: C }]);
    });
    it('the superseded document is live again (AUTHORISED or DRAFT): refused', async () => {
      for (const st of ['AUTHORISED', 'DRAFT']) {
        expect(await reconcile([inv({ InvoiceID: OLD, Status: st })], g2)).toMatchObject({ ok: false, failure: { error_class: 'RECONCILIATION_MISMATCH', message: expect.stringMatching(/superseded/) as unknown } });
      }
    });
    it('a retry after a lost answer: the fresh matching DRAFT is adopted, beside the superseded document', async () => {
      expect(await reconcile([inv({ InvoiceID: OLD, Status: 'VOIDED' }), inv({})], g2)).toEqual({ ok: true, exists: true, invoice_id: NEW, contact_id: C, adopted: true });
    });
    it('a fresh live document that differs (total): refused', async () => {
      expect(await reconcile([inv({ InvoiceID: OLD, Status: 'VOIDED' }), inv({ Total: 1 })], g2)).toMatchObject({ ok: false, failure: { error_class: 'RECONCILIATION_MISMATCH' } });
    });
    it('an unknown dead document with the same number (not a superseded one): a person decides', async () => {
      expect(await reconcile([inv({ InvoiceID: 'dddddddd-0000-0000-0000-000000000009', Status: 'VOIDED' })], g2)).toMatchObject({ ok: false, failure: { error_class: 'RECONCILIATION_MISMATCH', message: expect.stringMatching(/not a superseded generation/) as unknown } });
    });
    it('another live invoice with the reference: refused (unchanged rule)', async () => {
      expect(await reconcile([inv({ InvoiceID: OLD, Status: 'VOIDED' })], g2, [inv({ InvoiceID: OLD, Status: 'VOIDED' }), inv({ InvoiceID: 'eeeeeeee-0000-0000-0000-000000000001', InvoiceNumber: 'RO-INV-2026-0099' })]))
        .toMatchObject({ ok: false, failure: { message: expect.stringMatching(/refusing to bill twice/) as unknown } });
    });
    it('a generation-2 claim without its superseded list is refused (stale ids must be known)', async () => {
      expect(await reconcile([inv({ InvoiceID: OLD, Status: 'VOIDED' })], { generation: 2 })).toMatchObject({ ok: false, failure: { message: expect.stringMatching(/superseded Xero invoice ids/) as unknown } });
    });
    it('read-back: the new draft verifies; a superseded InvoiceID never does', async () => {
      expect(await verify(inv({}), NEW, g2)).toMatchObject({ ok: true, proof: { invoice_id: NEW } });
      expect(await verify(inv({ InvoiceID: OLD }), OLD, g2)).toMatchObject({ ok: false, failure: { message: expect.stringMatching(/superseded/) as unknown } });
    });
  });
});
