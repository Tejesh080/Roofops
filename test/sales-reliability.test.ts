/**
 * Sales reliability (Factory review): three business failures, reproduced before the fix (migration 20261017040000).
 *  1. A SENT quote revised later kept its old version and amount in the Airtable hand-off, so the office could accept
 *     an offer the customer was never given. Since 20261017060000 a sent quote is final (a different price is a new
 *     quote), so Airtable only ever holds the version that was sent; see quote-publish-lifecycle.test.ts.
 *  2. The hand-off proof must be what Airtable holds (customer, property and quote records read back: RoofOps IDs,
 *     numbers, owner and quote links, version and amount), not the values n8n 10 was asked to write.
 *  3. A site another customer owns must not silently gain a second active owner (reconciliation projects one owner).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';
import { recorded } from './helpers/n8n-sdk-shim.js';
import { N8nRun, type Item } from './helpers/n8n-runner.js';

type R = Record<string, unknown>;
const PW = 'sales reliability password 1';
const LINES = [{ line_kind: 'LABOUR', description: 'Replace tiles', quantity: '10', unit: 'hrs', unit_price: '95' }];
const F = { version: 'fldEjEqlzE8Y0M1nf', amount: 'fldbfUE8DVh1Dwjfs' };

/** The proof n8n 10 sends after reading the three records back from Airtable (here: exactly what Airtable would hold). */
export function fullProof(p: R, o: Partial<{ customer: R; property: R; quote: R }> = {}): R {
  const qf = p.quote_fields as R;
  // Airtable record ids of this quote's three records (unique per quote: one Airtable record per RoofOps record).
  const d = String(p.quote_number).replace(/\D/g, '').padEnd(12, '0').slice(0, 12);
  const [QU, CU, PR] = [`recQU${d}`, `recCU${d}`, `recPR${d}`];
  return { verified: true, quote_number: p.quote_number, customer_number: p.customer_number, property_number: p.property_number,
    quote_record_id: QU, customer_record_id: CU, property_record_id: PR,
    quote_customer_link_ids: [CU], quote_property_link_ids: [PR],
    customer_read_back: { id: CU, roofops_id: p.customer_id, number: p.customer_number, ...o.customer },
    property_read_back: { id: PR, roofops_id: p.property_id, number: p.property_number, owner_link_ids: [CU], ...o.property },
    quote_record_count: 1,   // exactly one Airtable quote record carries it (20261017060000)
    quote_read_back: { id: QU, roofops_id: p.quote_id, number: p.quote_number, version: qf[F.version], amount: qf[F.amount], status: 'Sent',
      customer_link_ids: [CU], property_link_ids: [PR], ...o.quote } };
}

describe.each(TARGETS)('sales reliability [%s]', (target) => {
  let db: Db;
  let est = '';
  const one = async (sql: string, p: unknown[] = []) => (await db.query<R>(sql, p))[0]!;
  const call = async (sql: string, p: unknown[]) => (await one(sql, p)).r as R;
  const asWorkflow = async (sql: string, p: unknown[]) => { await db.exec('set role roofops_workflow'); try { return await call(sql, p); } finally { await db.exec('reset role'); } };
  let n = 0;
  /** An enquiry converted to a new customer at a new site, quoted and sent. */
  const sentQuote = async () => {
    n++;
    const lead = await call('select web_lead_create($1,$2,$3,$4,$5,$6,$7,$8,$9) r', [est, `Rel Person ${target} ${n}`, `0455 10${n} ${n}0${n}`, null, null, 'PHONE', null, `rel-lead-${target}-${n}`, true]);
    const conv = await call('select web_lead_convert($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) r', [est, lead.lead_number, 1, null,
      JSON.stringify({ display_name: `Rel Person ${target} ${n}`, customer_type: 'RESIDENTIAL', phone: `0455 10${n} ${n}0${n}` }),
      JSON.stringify({ address_line1: `${n} Reliability Rd ${target}`, suburb: 'Avoca', state: 'QLD', postcode: '4670' }), true]);
    expect(conv, JSON.stringify(conv)).toMatchObject({ ok: true });
    const q = await call('select web_quote_save($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) r', [est, lead.lead_number, null, null, 'LEAK_REPAIR', 'INCLUSIVE', null, JSON.stringify(LINES), `rel-quote-${target}-${n}`]);
    const s = await call('select web_quote_send($1,$2,$3) r', [est, q.quote_number, (await one('select record_version::int v from quotes where quote_number = $1', [q.quote_number])).v]);
    expect(s).toMatchObject({ ok: true, status: 'SENT' });
    return { lead: String(lead.lead_number), quote: String(q.quote_number), key: String(s.airtable_key) };
  };
  const payload = async (key: string) => (await one('select payload from outbox where idempotency_key = $1', [key])).payload as R;
  const claim = (key: string) => asWorkflow(`select wf_claim_side_effect($1, 'n8n:10', 180) r`, [key]);
  /** Reported by the attempt that holds the hand-off (20261017060000). */
  const complete = async (key: string, proof: R) => asWorkflow('select wf_complete_side_effect($1, $2::jsonb) r',
    [key, JSON.stringify({ attempt: (await one('select attempts::int a from outbox where idempotency_key = $1', [key])).a, ...proof })]);
  const revise = async (quote: string, hours: string, key: string) => call('select web_quote_save($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) r', [est, null, quote,
    (await one('select record_version::int v from quotes where quote_number = $1', [quote])).v, 'LEAK_REPAIR', 'INCLUSIVE', null, JSON.stringify([{ ...LINES[0]!, quantity: hours }]), key]);
  const accept = (quote: string, version: number, id: string) => asWorkflow('select wf_quote_accepted($1::jsonb) r', [JSON.stringify({ event_id: id, correlation_id: `C-${id}`,
    event_type: 'quote.accepted', source: 'airtable', actor_id: 'usr7uCnNO15fCefbH', occurred_at: new Date().toISOString(), payload: { quote_id: quote, accepted_version: version } })]);

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.query('select ops_staff_set_password($1, $2, $3)', ['EMP-002', 'estimator', PW]);
    est = String((await call('select web_staff_sign_in($1, $2) r', ['estimator', PW])).token);
  }, 180_000);
  afterAll(async () => { await db.close(); });

  describe('1. a sent quote', () => {
    it('is published as sent and cannot be revised (quote publishing lifecycle, 20261017060000): nothing is written; once accepted it is final too', async () => {
      const s = await sentQuote();
      await claim(s.key);
      expect(await complete(s.key, fullProof(await payload(s.key)))).toMatchObject({ status: 'RECORDED' });
      expect(await one('select in_airtable from v_dashboard_quotes where quote_number = $1', [s.quote])).toEqual({ in_airtable: true });
      expect(await revise(s.quote, '12', `rel-rev-${target}-1`)).toMatchObject({ ok: false, code: 'QUOTE_SENT_FINAL' });
      expect(await one('select count(*)::int n from quote_versions v join quotes q on q.id = v.quote_id where q.quote_number = $1', [s.quote])).toEqual({ n: 1 });
      expect(await one('select count(*)::int n from outbox o join quotes q on q.id = o.aggregate_id where q.quote_number = $1', [s.quote])).toEqual({ n: 1 });
      // The office accepts the version Airtable shows (the only one): one project. Accepted is final.
      expect(await accept(s.quote, 1, `rel-acc-${target}`)).toMatchObject({ status: 'CREATED' });
      expect(await revise(s.quote, '14', `rel-rev-${target}-2`)).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    });
  });

  describe('2. hand-off proof is what Airtable holds', () => {
    it('proof without the read-back records, or with any record that does not match, is refused and the hand-off stays undone; the exact read-back is recorded', async () => {
      const s = await sentQuote();
      await claim(s.key);
      const p = await payload(s.key);
      const legacy = fullProof(p); delete legacy.customer_read_back; delete legacy.property_read_back; delete legacy.quote_read_back;
      await expect(complete(s.key, legacy)).rejects.toThrow(/read back/);
      const bad: [string, Partial<{ customer: R; property: R; quote: R }>][] = [
        ['customer RoofOps ID', { customer: { roofops_id: '00000000-0000-0000-0000-000000000000' } }],
        ['customer number', { customer: { number: 'CUST-9999' } }],
        ['customer record', { customer: { id: 'recSOMEOTHER00001' } }],
        ['property RoofOps ID', { property: { roofops_id: '00000000-0000-0000-0000-000000000000' } }],
        ['property owner link', { property: { owner_link_ids: ['recSOMEOTHER00001'] } }],
        ['property number', { property: { number: 'PROP-9999' } }],
        ['quote RoofOps ID', { quote: { roofops_id: '00000000-0000-0000-0000-000000000000' } }],
        ['quote version', { quote: { version: 7 } }],
        ['quote amount', { quote: { amount: 1 } }],
        ['quote customer link', { quote: { customer_link_ids: [] } }],
      ];
      for (const [what, o] of bad) await expect(complete(s.key, fullProof(p, o)), what).rejects.toThrow();
      expect(await one('select status from outbox where idempotency_key = $1', [s.key])).toEqual({ status: 'DISPATCHING' });
      expect(await complete(s.key, fullProof(p))).toMatchObject({ status: 'RECORDED' });
      expect(await one(`select after_state -> 'property_read_back' ->> 'roofops_id' v from audit_events where action = 'airtable.quote.published' and business_reference = $1`, [s.quote]))
        .toEqual({ v: p.property_id });
    });

    it('n8n 10 (its real code) builds the proof from the records it read back, and refuses when Airtable holds something else', async () => {
      if (!recorded.nodes.has('Verify Quote Read-Back')) {
        recorded.nodes.clear(); recorded.edges.length = 0;
        const sdk = '../n8n/10-airtable-quote-publish.sdk.ts';
        await import(/* @vite-ignore */ sdk);
      }
      const job = { quote_number: 'Q-2026-0901', quote_id: 'aaaaaaaa-0000-0000-0000-000000000001', customer_number: 'CUST-0901', customer_id: 'bbbbbbbb-0000-0000-0000-000000000001',
        property_number: 'PROP-0901', property_id: 'cccccccc-0000-0000-0000-000000000001', quote_fields: { [F.version]: 2, [F.amount]: 1140 } };
      const quoteRec = { id: 'recQ0000000000001', fields: { fldyP20HNafS614d5: 'Q-2026-0901', fldVUpqZkVKid3Fyy: job.quote_id, fld4LsEu8c9EMFj0h: ['recC0000000000001'], fldisUv1ckHz2Detv: ['recP0000000000001'], [F.version]: 2, [F.amount]: 1140, fldQpTa5tvrzlNg1h: 'Sent' } };
      const custRec = { id: 'recC0000000000001', fields: { fldzmWSHtLVZ4OTmZ: 'CUST-0901', fldDClu1e0ffwnojn: job.customer_id } };
      const propRec = { id: 'recP0000000000001', fields: { fldIy8ab7Ky67jL31: 'PROP-0901', fldm6rtleyV6yp8ZS: job.property_id, fldVpX0MOcA8TnGvo: ['recC0000000000001'] } };
      const verify = async (c: R, pr: R, q: R) => {
        const r = new N8nRun(recorded.nodes, recorded.edges, { db: { query: () => { throw new Error('no db'); } } as unknown as Db, http: () => { throw new Error('no http'); } });
        const seed = (name: string, items: Item[]) => { r.seed(name, items); };
        seed('Claim Quote Publish', [{ json: { c: { claimed: true, attempt: 1, payload: job } } }]);
        seed('Check Quote Look-Up', [{ json: { ok: true, create: false, record_id: 'recQ0000000000001' } }]);
        seed('Build Quote', [{ json: { ok: true, customer_record_id: 'recC0000000000001', property_record_id: 'recP0000000000001' } }]);
        seed('Read Back Quote', [{ json: { statusCode: 200, body: { records: [q] } } }]);
        seed('Read Back Customer', [{ json: { statusCode: 200, body: c } }]);
        await r.run('Verify Quote Read-Back', [{ json: { statusCode: 200, body: pr } }], recorded.edges.filter((e) => e.from === 'Verify Quote Read-Back').map((e) => e.to));
        return r.out.get('Verify Quote Read-Back')![0]!.json as R;
      };
      const ok = await verify(custRec, propRec, quoteRec);
      expect(ok).toMatchObject({ ok: true, proof: { customer_number: 'CUST-0901', property_number: 'PROP-0901',
        customer_read_back: { id: 'recC0000000000001', roofops_id: job.customer_id, number: 'CUST-0901' },
        property_read_back: { roofops_id: job.property_id, owner_link_ids: ['recC0000000000001'] }, quote_read_back: { version: 2, amount: 1140, status: 'Sent' }, quote_record_count: 1, attempt: 1 } });
      const wrongCustomer = await verify({ ...custRec, fields: { ...custRec.fields, fldzmWSHtLVZ4OTmZ: 'CUST-0999' } }, propRec, quoteRec);
      expect(wrongCustomer).toMatchObject({ ok: false, failure: { error_class: 'RECONCILIATION_MISMATCH' } });
      const otherOwner = await verify(custRec, { ...propRec, fields: { ...propRec.fields, fldVpX0MOcA8TnGvo: ['recSOMEONEELSE001'] } }, quoteRec);
      expect(otherOwner).toMatchObject({ ok: false, failure: { error_class: 'RECONCILIATION_MISMATCH' } });
      const oldVersion = await verify(custRec, propRec, { ...quoteRec, fields: { ...quoteRec.fields, [F.version]: 1 } });
      expect(oldVersion).toMatchObject({ ok: false });
      const blankStatus = await verify(custRec, propRec, { ...quoteRec, fields: { ...quoteRec.fields, fldQpTa5tvrzlNg1h: undefined } });
      expect(blankStatus).toMatchObject({ ok: false, failure: { error_class: 'RECONCILIATION_MISMATCH', message: expect.stringContaining('Status is blank') as unknown } });
    });
  });

  describe('3. one owner per site', () => {
    const owned = async () => one(`select p.address_line1, p.suburb, p.state, p.postcode, p.property_number, c.customer_number, c.display_name
      from customer_properties cp join properties p on p.id = cp.property_id join customers c on c.id = cp.customer_id where cp.relationship = 'OWNER' order by p.property_number limit 1`);
    const owners = async (prop: unknown) => one(`select count(*)::int n from customer_properties cp join properties p on p.id = cp.property_id where p.property_number = $1 and cp.relationship = 'OWNER' and cp.valid_to is null`, [prop]);

    it('a site another customer owns is refused for a new customer and for a different existing customer (nothing written); its own owner reuses it', async () => {
      const site = await owned();
      const addr = JSON.stringify({ address_line1: String(site.address_line1).toUpperCase(), suburb: site.suburb, state: site.state, postcode: site.postcode });
      const lead = await call('select web_lead_create($1,$2,$3,$4,$5,$6,$7,$8,$9) r', [est, 'Tess Tenant', '0466 777 001', null, null, 'PHONE', null, `rel-own-${target}-1`, true]);
      const before = await one('select count(*)::int n from customers');
      const refusedNew = await call('select web_lead_convert($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) r', [est, lead.lead_number, 1, null,
        JSON.stringify({ display_name: 'Tess Tenant', customer_type: 'RESIDENTIAL', phone: '0466 777 001' }), addr, true]);
      expect(refusedNew).toMatchObject({ ok: false, code: 'SITE_OWNED_BY_ANOTHER_CUSTOMER', owner: { customer_number: site.customer_number } });
      expect(await one('select count(*)::int n from customers')).toEqual(before);                      // no customer created
      expect(await owners(site.property_number)).toEqual({ n: 1 });
      expect(await one('select customer_id, property_id, record_version::int v from leads where lead_number = $1', [lead.lead_number])).toEqual({ customer_id: null, property_id: null, v: 1 });
      const other = String((await one(`select customer_number from customers where customer_number <> $1 and status = 'ACTIVE' order by 1 limit 1`, [site.customer_number])).customer_number);
      expect(await call('select web_lead_convert($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) r', [est, lead.lead_number, 1, other, null, addr, false]))
        .toMatchObject({ ok: false, code: 'SITE_OWNED_BY_ANOTHER_CUSTOMER' });
      expect(await call('select web_lead_convert($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) r', [est, lead.lead_number, 1, site.customer_number, null, addr, false]))
        .toMatchObject({ ok: true, customer_number: site.customer_number, property_number: site.property_number });
      expect(await owners(site.property_number)).toEqual({ n: 1 });
    });

    it('the database itself refuses a second active owner of a site (whatever writes it)', async () => {
      const site = await owned();
      await expect(db.query(`insert into customer_properties (customer_id, property_id, relationship, valid_from)
        select (select id from customers where customer_number <> $1 order by customer_number limit 1), p.id, 'OWNER', current_date from properties p where p.property_number = $2`,
        [site.customer_number, site.property_number])).rejects.toThrow(/duplicate key|one_active_owner/);
      expect(await owners(site.property_number)).toEqual({ n: 1 });
    });
  });
});
