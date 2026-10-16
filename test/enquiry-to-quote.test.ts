/**
 * SALES-01 (migration 20261017020000): enquiry -> customer and site -> inspection -> quote -> one Airtable hand-off ->
 * acceptance through the existing wf_quote_accepted. Synthetic people: EMP-820 estimator (sales), EMP-821 field crew (no
 * sales role). The Airtable hand-off is completed with the proof n8n 10 would send (no Airtable call).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPostgres, type Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const PW = 'sales test password 1';
const ADDRESS = { address_line1: '7  Wattle   Court', suburb: 'bundaberg  east', state: 'qld', postcode: '4670', property_type: 'DETACHED_HOUSE', storeys: '1', access_notes: 'Side gate' };
const LINES = [
  { line_kind: 'LABOUR', description: 'Replace cracked tiles and re-point ridge', quantity: '12', unit: 'hrs', unit_price: '95' },
  { line_kind: 'MATERIAL', product_code: 'PROD-0002', description: 'Ridge capping', quantity: '4', unit: 'PACK', unit_price: '62.50' },
  { line_kind: 'EQUIPMENT', description: 'Scaffold hire (1 week)', quantity: '1', unit: 'LOT', unit_price: '480' },
];

async function setup(db: Db, tok: Record<string, string>) {
  await importBundle(db);
  await db.query(`insert into employees (employee_code, full_name, email, role, is_active) values
    ('EMP-820', 'Synthetic Estimator Sales', 'e820@example.test', 'ESTIMATOR', true), ('EMP-821', 'Synthetic Crew Sales', 'e821@example.test', 'FIELD_CREW', true)`);
  for (const [code, login] of [['EMP-820', 'est'], ['EMP-821', 'crew']] as const) {
    await db.query('select ops_staff_set_password($1, $2, $3)', [code, login, PW]);
    tok[login] = String((await db.query<{ r: R }>('select web_staff_sign_in($1, $2) r', [login, PW]))[0]!.r.token);
  }
}

describe.each(TARGETS)('enquiry to quote [%s]', (target) => {
  let db: Db;
  const tok: Record<string, string> = {};
  const one = async (sql: string, p: unknown[] = []) => (await db.query<R>(sql, p))[0]!;
  const call = async (sql: string, p: unknown[]) => (await one(sql, p)).r as R;
  const lead = (t: string, o: Partial<{ name: string; phone: string | null; email: string | null; source: string; key: string }> = {}) =>
    call('select web_lead_create($1, $2, $3, $4, $5, $6, $7, $8) r', [t, o.name ?? 'Olive Sample', o.phone === undefined ? '0412 345 678' : o.phone,
      o.email === undefined ? 'olive.sample@example.test' : o.email, '7 Wattle Ct, Bundaberg East', o.source ?? 'PHONE', 'Leaking over the kitchen', o.key ?? 'lead-key-0001']);
  const leadRow = (n: string) => one('select * from v_dashboard_leads where lead_number = $1', [n]);
  const convert = (t: string, n: string, v: number, o: { customer?: string | null; newCustomer?: R; property?: R; confirm?: boolean } = {}) =>
    call('select web_lead_convert($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) r', [t, n, v, o.customer ?? null,
      JSON.stringify(o.newCustomer ?? { display_name: 'Olive Sample', customer_type: 'RESIDENTIAL', phone: '0412 345 678', email: 'olive.sample@example.test' }),
      JSON.stringify(o.property ?? ADDRESS), o.confirm ?? false]);
  const save = (t: string, o: { lead?: string | null; quote?: string | null; version?: number | null; job?: string; amount?: string; lines?: unknown[]; key: string }) =>
    call('select web_quote_save($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) r', [t, o.lead ?? null, o.quote ?? null, o.version ?? null, o.job ?? 'LEAK_REPAIR',
      o.amount ?? 'INCLUSIVE', 'Repair the leak above the kitchen', JSON.stringify(o.lines ?? LINES), o.key]);
  const asWorkflow = async (sql: string, p: unknown[]) => {
    await db.exec('set role roofops_workflow');
    try { return await call(sql, p); } finally { await db.exec('reset role'); }
  };

  beforeAll(async () => {
    db = await migratedDb(target);
    await setup(db, tok);
  }, 180_000);
  afterAll(async () => { await db.close(); });

  it('privileges: staff functions are the dashboard\'s, the hand-off poller is n8n\'s, the helpers are nobody\'s', async () => {
    const can = async (role: string, fn: string) => (await one(`select bool_or(has_function_privilege($1, p.oid, 'execute')) ok from pg_proc p where p.proname = $2`, [role, fn])).ok;
    for (const fn of ['web_lead_create', 'web_lead_update', 'web_lead_convert', 'web_inspection_book', 'web_inspection_record', 'web_quote_save', 'web_quote_send']) {
      expect(await can('roofops_dashboard', fn), fn).toBe(true);
    }
    expect(await can('roofops_workflow', 'wf_quote_publish_next')).toBe(true);
    expect(await can('roofops_dashboard', 'wf_quote_publish_next')).toBe(false);
    for (const fn of ['customer_lookalikes', 'quote_lines_problem', 'quote_insert_version', 'quote_publish_payload']) {
      expect(await can('roofops_dashboard', fn), fn).toBe(false);
      expect(await can('roofops_workflow', fn), fn).toBe(false);
    }
  });

  it('an enquiry: validated, recorded once (a repeat submit returns it), refused for roles without sales; an existing customer is flagged', async () => {
    expect(await lead('not-a-token')).toMatchObject({ ok: false, code: 'SIGNED_OUT' });
    expect(await lead(tok.crew!, { key: 'lead-key-x001' })).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    expect(await lead(tok.est!, { name: 'A', key: 'lead-key-x002' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(await lead(tok.est!, { phone: null, email: null, key: 'lead-key-x003' })).toMatchObject({ ok: false, code: 'INVALID', detail: expect.stringContaining('phone number or an email') as unknown });
    expect(await lead(tok.est!, { email: 'not-an-email', key: 'lead-key-x004' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(await lead(tok.est!, { phone: '12', key: 'lead-key-x005' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(await lead(tok.est!, { source: 'CARRIER_PIGEON', key: 'lead-key-x006' })).toMatchObject({ ok: false, code: 'INVALID' });
    const r = await lead(tok.est!);
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, record_version: 1, lookalikes: [] });
    expect(String(r.lead_number)).toMatch(/^LEAD-\d{4}-\d{4}$/);
    expect(await lead(tok.est!)).toEqual({ ok: true, duplicate: true, lead_number: r.lead_number });
    expect(await one(`select count(*)::int n from leads where request_key like 'lead-key-%'`)).toEqual({ n: 1 });
    // Noah Richards is an existing customer (CUST-0003): same phone digits and name are pointed out.
    const again = await lead(tok.est!, { name: 'noah richards', phone: '0400-000-003', email: null, key: 'lead-key-0002' });
    expect(again.lookalikes).toEqual([{ customer_number: 'CUST-0003', display_name: 'Noah Richards', reasons: ['same phone', 'same name'] }]);
    expect(await one(`select actor_id from audit_events where action = 'lead.created' and business_reference = $1`, [r.lead_number])).toEqual({ actor_id: 'EMP-820' });
  });

  it('moving an enquiry on: contacted; lost needs a reason; stale screens and finished ones refused', async () => {
    const n = String((await lead(tok.est!, { name: 'Peter Lostcase', key: 'lead-key-0003' })).lead_number);
    expect(await call('select web_lead_update($1, $2, $3, $4, $5) r', [tok.est, n, 'contacted', 1, null])).toMatchObject({ ok: true, status: 'CONTACTED', record_version: 2 });
    expect(await call('select web_lead_update($1, $2, $3, $4, $5) r', [tok.est, n, 'contacted', 2, null])).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    expect(await call('select web_lead_update($1, $2, $3, $4, $5) r', [tok.est, n, 'lost', 1, 'Went with a competitor'])).toMatchObject({ ok: false, code: 'STALE' });
    expect(await call('select web_lead_update($1, $2, $3, $4, $5) r', [tok.est, n, 'lost', 2, 'no'])).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(await call('select web_lead_update($1, $2, $3, $4, $5) r', [tok.est, n, 'lost', 2, 'Went with a competitor'])).toMatchObject({ ok: true, status: 'LOST' });
    expect(await leadRow(n)).toMatchObject({ status: 'LOST', lost_reason: 'Went with a competitor' });
    expect(await convert(tok.est!, n, 3)).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
  });

  it('customer and site: a look-alike is refused until confirmed (then queued for review); an existing customer and an existing address are reused; converting twice keeps the first', async () => {
    const dup = String((await lead(tok.est!, { name: 'Noah Richards', phone: '0400 000003', email: null, key: 'lead-key-0004' })).lead_number);
    const refused = await convert(tok.est!, dup, 1, { newCustomer: { display_name: 'Noah Richards', customer_type: 'RESIDENTIAL', phone: '0400 000003' } });
    expect(refused).toMatchObject({ ok: false, code: 'POSSIBLE_DUPLICATE', lookalikes: [{ customer_number: 'CUST-0003' }] });
    expect(String(refused.detail)).toContain('Noah Richards (CUST-0003)');
    // The usual answer: it IS that customer, at a site we already know (PROP-0002, typed differently).
    const reuse = await convert(tok.est!, dup, 1, { customer: 'CUST-0003', property: { address_line1: '18 banksia rise', suburb: 'BUNDABERG NORTH', state: 'QLD', postcode: '4670', property_type: 'DETACHED_HOUSE' } });
    expect(reuse).toMatchObject({ ok: true, customer_number: 'CUST-0003', new_customer: false, property_number: 'PROP-0002' });
    expect(await convert(tok.est!, dup, 99)).toMatchObject({ ok: true, duplicate: true, customer_number: 'CUST-0003', property_number: 'PROP-0002' });

    // A genuinely different person with the same name: confirmed new, and the pair is queued for a person to check.
    const other = String((await lead(tok.est!, { name: 'Noah Richards', phone: '0499 111222', email: null, key: 'lead-key-0005' })).lead_number);
    const made = await convert(tok.est!, other, 1, { newCustomer: { display_name: 'Noah Richards', customer_type: 'RESIDENTIAL', phone: '0499 111222' }, confirm: true,
      property: { address_line1: '3 Other St', suburb: 'Kepnock', state: 'QLD', postcode: '4670' } });
    expect(made).toMatchObject({ ok: true, new_customer: true });
    expect(await one(`select m.status, m.match_reasons from customer_match_candidates m join customers a on a.id in (m.customer_id, m.candidate_customer_id)
                       where a.customer_number = $1`, [made.customer_number])).toEqual({ status: 'OPEN', match_reasons: ['same name'] });

    // Validation of the site.
    const third = String((await lead(tok.est!, { name: 'Vera Validate', key: 'lead-key-0006' })).lead_number);
    for (const [p, msg] of [[{ ...ADDRESS, postcode: '46' }, 'postcode'], [{ ...ADDRESS, state: 'XX' }, 'state'], [{ ...ADDRESS, address_line1: '' }, 'street'],
      [{ ...ADDRESS, storeys: '9' }, 'storeys']] as const) {
      const r = await convert(tok.est!, third, 1, { newCustomer: { display_name: 'Vera Validate', customer_type: 'RESIDENTIAL', email: 'vera@example.test' }, property: p });
      expect(r, msg).toMatchObject({ ok: false, code: 'INVALID' });
      expect(String(r.detail)).toContain(msg);
    }
    expect(await one(`select count(*)::int n from customers where display_name = 'Vera Validate'`)).toEqual({ n: 0 });   // nothing half-written
  });

  let L = ''; let Q = '';
  it('the full path: convert (new customer, new site), book and record the inspection, draft, revise and send the quote', async () => {
    L = String((await lead(tok.est!, { name: 'Iris Journey', phone: '0433 222 111', email: 'iris.journey@example.test', key: 'lead-key-0100' })).lead_number);
    const c = await convert(tok.est!, L, 1, { newCustomer: { display_name: 'Iris Journey', customer_type: 'RESIDENTIAL', phone: '0433 222 111', email: 'iris.journey@example.test' } });
    expect(c).toMatchObject({ ok: true, new_customer: true });
    expect(await one(`select address_line1, suburb, state from properties where property_number = $1`, [c.property_number])).toEqual({ address_line1: '7 Wattle Court', suburb: 'Bundaberg East', state: 'QLD' });
    expect(await leadRow(L)).toMatchObject({ status: 'CONTACTED', customer_number: c.customer_number });

    const today = String((await one('select app_today()::text d')).d);
    const when = `${today}T15:00:00+10:00`;
    const book = (inspector: string, key: string, at = when) => call('select web_inspection_book($1, $2, $3, $4::timestamptz, $5) r', [tok.est, L, inspector, at, key]);
    expect(await book('EMP-821', 'ins-key-x1')).toMatchObject({ ok: false, code: 'INSPECTOR_UNKNOWN' });   // field crew do not inspect
    expect(await book('EMP-820', 'ins-key-x2', '2000-01-01T09:00:00+10:00')).toMatchObject({ ok: false, code: 'IN_PAST' });
    const b = await book('EMP-820', 'ins-key-0001');
    expect(b).toMatchObject({ ok: true });
    expect(await book('EMP-820', 'ins-key-0001')).toMatchObject({ ok: true, duplicate: true, inspection_number: b.inspection_number });
    expect(await book('EMP-820', 'ins-key-x3')).toMatchObject({ ok: false, code: 'ALREADY_BOOKED' });
    expect(await leadRow(L)).toMatchObject({ status: 'INSPECTION_BOOKED' });

    const record = (v: number, f: R, action = 'complete') => call('select web_inspection_record($1, $2, $3, $4, $5::jsonb) r', [tok.est, b.inspection_number, v, action, JSON.stringify(f)]);
    expect(await record(1, { roof_type: 'TILE', roof_area_sqm: '180', findings: 'Cracked tiles over kitchen' })).toMatchObject({ ok: false, code: 'INVALID', detail: expect.stringContaining('measured') as unknown });
    expect(await record(1, { roof_type: 'TILE', roof_area_sqm: '-3', measurement_method: 'TAPE', findings: 'Cracked tiles' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(await record(2, { roof_type: 'TILE', findings: 'x' })).toMatchObject({ ok: false, code: 'STALE' });
    const done = await record(1, { roof_type: 'TERRACOTTA_TILE', roof_area_sqm: '182.46', pitch_degrees: '22.5', measurement_method: 'TAPE', findings: 'Six cracked tiles above the kitchen; ridge mortar failing' });
    expect(done).toMatchObject({ ok: true, status: 'COMPLETED' });
    expect(await one(`select i.roof_area_sqm::text a, i.inspected_on::text d, pr.roof_type from inspections i join properties pr on pr.id = i.property_id where i.inspection_number = $1`, [b.inspection_number]))
      .toEqual({ a: '182.5', d: today, roof_type: 'TERRACOTTA_TILE' });

    // Draft: lines validated; totals derived (prices include GST: GST is 1/11 of the total).
    expect(await save(tok.est!, { lead: L, lines: [], key: 'quote-key-x1' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(await save(tok.est!, { lead: L, lines: [{ line_kind: 'MATERIAL', description: 'Tiles', quantity: '10', unit: 'EA', unit_price: '5' }], key: 'quote-key-x2' }))
      .toMatchObject({ ok: false, code: 'INVALID', detail: expect.stringContaining('product') as unknown });
    expect(await save(tok.est!, { lead: L, lines: [{ line_kind: 'LABOUR', description: 'Work', quantity: '0', unit: 'hrs', unit_price: '5' }], key: 'quote-key-x3' }))
      .toMatchObject({ ok: false, code: 'INVALID', detail: expect.stringContaining('more than 0') as unknown });
    expect(await save(tok.crew!, { lead: L, key: 'quote-key-x4' })).toMatchObject({ ok: false, code: 'ACTOR_UNAUTHORIZED' });
    const d = await save(tok.est!, { lead: L, key: 'quote-key-0001' });
    expect(d, JSON.stringify(d)).toMatchObject({ ok: true, version: 1, status: 'DRAFT', total_inc_gst: 1870, gst_amount: 170 });   // 1140 + 250 + 480 inc GST
    Q = String(d.quote_number);
    expect(await save(tok.est!, { lead: L, key: 'quote-key-0001' })).toEqual({ ok: true, duplicate: true, quote_number: Q });
    expect(await save(tok.est!, { lead: L, key: 'quote-key-0002' })).toMatchObject({ ok: false, code: 'ALREADY_QUOTED' });
    expect(await one(`select q.lead_source, i.inspection_number, e.employee_code from quotes q join inspections i on i.id = q.inspection_id join employees e on e.id = q.estimator_id where q.quote_number = $1`, [Q]))
      .toEqual({ lead_source: 'PHONE', inspection_number: b.inspection_number, employee_code: 'EMP-820' });

    // Revise: a new version, prices now exclusive of GST (GST 10% on top); the old version stays as history.
    expect(await save(tok.est!, { quote: Q, version: 2, amount: 'EXCLUSIVE', key: 'quote-key-r1' })).toMatchObject({ ok: false, code: 'STALE' });
    const r2 = await save(tok.est!, { quote: Q, version: 1, amount: 'EXCLUSIVE', job: 'STORM_DAMAGE_REPAIR', key: 'quote-key-r1' });
    expect(r2).toMatchObject({ ok: true, version: 2, total_inc_gst: 2057, gst_amount: 187, record_version: 2 });
    expect(await save(tok.est!, { quote: Q, version: 1, amount: 'EXCLUSIVE', key: 'quote-key-r1' })).toEqual({ ok: true, duplicate: true, quote_number: Q });
    expect(await one(`select count(*)::int n from quote_versions v join quotes q on q.id = v.quote_id where q.quote_number = $1`, [Q])).toEqual({ n: 2 });
    expect(await one('select version_number, line_amount_type, total_inc_gst::text t, job_type, jsonb_array_length(lines) n from v_dashboard_quotes where quote_number = $1', [Q]))
      .toEqual({ version_number: 2, line_amount_type: 'EXCLUSIVE', t: '2057.00', job_type: 'STORM_DAMAGE_REPAIR', n: 3 });

    // Send: Sent on the business date, valid for 30 days, handed to Airtable exactly once; the enquiry is Quoted.
    const send = (v: number) => call('select web_quote_send($1, $2, $3) r', [tok.est, Q, v]);
    expect(await send(1)).toMatchObject({ ok: false, code: 'STALE' });
    const s = await send(2);
    expect(s).toMatchObject({ ok: true, status: 'SENT', airtable_key: expect.stringMatching(/^airtable:quote-publish:/) as unknown });
    expect(await send(3)).toMatchObject({ ok: true, duplicate: true });
    expect(await one(`select sent_on::text s, (valid_until - sent_on) days from quotes where quote_number = $1`, [Q])).toEqual({ s: today, days: 30 });
    expect(await one(`select count(*)::int n, min(status) st from outbox where topic = 'airtable.quote_publish' and aggregate_id = (select id from quotes where quote_number = $1)`, [Q])).toEqual({ n: 1, st: 'PENDING' });
    expect(await leadRow(L)).toMatchObject({ status: 'QUOTED' });
    const payload = (await one(`select payload from outbox where idempotency_key = $1`, [s.airtable_key])).payload as R;
    expect(payload).toMatchObject({ quote_number: Q, customer_number: c.customer_number, property_number: c.property_number,
      quote_fields: { fldyP20HNafS614d5: Q, fldQpTa5tvrzlNg1h: 'Sent', fldEjEqlzE8Y0M1nf: 2, fldbfUE8DVh1Dwjfs: 2057 },
      customer_fields: { fldzmWSHtLVZ4OTmZ: c.customer_number, fldI46VewtlNRnwui: 'Iris Journey' }, property_fields: { fldIy8ab7Ky67jL31: c.property_number } });
    expect((await db.query(`select action from audit_events where business_reference in ($1, $2) and action ~ '^(lead|inspection|quote)\\.' order by occurred_at, action`, [L, Q])).map((a) => a.action))
      .toEqual(['lead.created', 'lead.converted', 'inspection.booked', 'inspection.completed', 'quote.drafted', 'quote.revised', 'quote.sent']);
  });

  it('the Airtable hand-off (n8n 10, simulated): one write; incomplete proof refused; verified proof links quote, customer and property; then acceptance makes one project', async () => {
    const next = await asWorkflow(`select wf_quote_publish_next('n8n:10:test') r`, []);
    expect(next.writes).toEqual([{ key: expect.stringMatching(/^airtable:quote-publish:/) as unknown, quote_number: Q }]);
    const key = String((next.writes as R[])[0]!.key);
    expect(await asWorkflow(`select wf_claim_side_effect($1, 'n8n:10', 120) r`, [key])).toMatchObject({ claimed: true });
    expect((await asWorkflow(`select wf_quote_publish_next('n8n:10:test') r`, [])).writes).toEqual([]);   // never handed out twice
    const p = (await one('select payload from outbox where idempotency_key = $1', [key])).payload as R;
    const proof = { verified: true, quote_number: Q, customer_number: p.customer_number, property_number: p.property_number,
      quote_record_id: 'recQUOTESALES0001', customer_record_id: 'recCUSTSALES00001', property_record_id: 'recPROPSALES00001',
      quote_customer_link_ids: ['recCUSTSALES00001'], quote_property_link_ids: ['recPROPSALES00001'] };
    const complete = async (r: R) => {
      await db.exec('set role roofops_workflow');
      try { return (await one(`select wf_complete_side_effect($1, $2::jsonb) r`, [key, JSON.stringify(r)])).r as R; } finally { await db.exec('reset role'); }
    };
    await expect(complete({ ...proof, quote_property_link_ids: [] })).rejects.toThrow(/not linked to its customer and property/);
    await expect(complete({ ...proof, customer_number: 'CUST-9999' })).rejects.toThrow(/do not carry/);
    await expect(complete({ ...proof, quote_record_id: 'nope' })).rejects.toThrow(/needs quote_record_id/);
    expect(await one('select status from outbox where idempotency_key = $1', [key])).toEqual({ status: 'DISPATCHING' });
    expect(await complete(proof)).toMatchObject({ status: 'RECORDED' });
    expect((await db.query(`select entity_type, external_id from external_links where provider = 'AIRTABLE' and external_id like 'rec%SALES%' order by 1`)))
      .toEqual([{ entity_type: 'customer', external_id: 'recCUSTSALES00001' }, { entity_type: 'property', external_id: 'recPROPSALES00001' }, { entity_type: 'quote', external_id: 'recQUOTESALES0001' }]);
    expect(await one(`select in_airtable, airtable_handoff from v_dashboard_quotes where quote_number = $1`, [Q])).toEqual({ in_airtable: true, airtable_handoff: 'DONE' });
    // From now on reconciliation keeps the Airtable quote canonical, like every imported one.
    expect(await one(`select x.expected ->> 'fldQpTa5tvrzlNg1h' st, (x.expected ->> 'fldbfUE8DVh1Dwjfs')::numeric amt from v_airtable_expected x join quotes q on q.id = x.entity_id where q.quote_number = $1`, [Q]))
      .toEqual({ st: 'Sent', amt: '2057.00' });
    expect(await one(`select status from integrity_check() where check_key = 'done_has_proof'`)).toEqual({ status: 'PASS' });

    // The office marks it Accepted in Airtable -> n8n 01 -> the existing wf_quote_accepted: one project for this customer and site.
    const ev = { event_id: 'EVT-SALES-ACCEPT', correlation_id: 'CORR-SALES-ACCEPT', event_type: 'quote.accepted', source: 'airtable', actor_id: 'airtable-automation',
      occurred_at: new Date().toISOString(), payload: { quote_id: Q, accepted_version: 2, accepted_on: String((await one('select app_today()::text d')).d), airtable_record_id: 'recQUOTESALES0001' } };
    const acc = await asWorkflow('select wf_quote_accepted($1::jsonb) r', [JSON.stringify(ev)]);
    expect(acc).toMatchObject({ status: 'CREATED' });
    expect(await one(`select c.display_name, pr.property_number, p.status from projects p join customers c on c.id = p.customer_id join properties pr on pr.id = p.property_id where p.project_number = $1`, [acc.project_number]))
      .toEqual({ display_name: 'Iris Journey', property_number: p.property_number, status: 'PLANNING' });
    expect(await one(`select payload ->> 'quote_airtable_record_id' rec from outbox where topic = 'airtable.project_writeback' and aggregate_id = (select id from projects where project_number = $1)`, [acc.project_number]))
      .toEqual({ rec: 'recQUOTESALES0001' });   // n8n 03 links the new project to this quote's Airtable record
    expect(await leadRow(L)).toMatchObject({ project_number: acc.project_number, status: 'WON' });
  });
});

/** Real concurrency: the same enquiry converted from two screens at once creates one customer. */
describe.runIf(TARGETS.includes('postgres'))('enquiry conversion under real concurrency [postgres]', () => {
  let db: Db & { url?: string };
  const tok: Record<string, string> = {};
  beforeAll(async () => { db = await migratedDb('postgres'); await setup(db, tok); }, 180_000);
  afterAll(async () => { await db.close(); });

  it('two people converting the same enquiry at once: one customer, one site, the same answer', async () => {
    const lead = (await db.query<{ r: R }>(`select web_lead_create($1, 'Rita Race', '0455 666 777', null, null, 'PHONE', null, 'race-lead-0001') r`, [tok.est]))[0]!.r;
    const [a, b] = [await openPostgres(db.url!), await openPostgres(db.url!)];
    try {
      const sql = `select web_lead_convert($1, $2, 1, null, $3::jsonb, $4::jsonb, false) r`;
      const args = [tok.est, lead.lead_number, JSON.stringify({ display_name: 'Rita Race', customer_type: 'RESIDENTIAL', phone: '0455 666 777' }),
        JSON.stringify({ address_line1: '9 Race Rd', suburb: 'Avoca', state: 'QLD', postcode: '4670' })];
      const out = (await Promise.all([a.query<{ r: R }>(sql, args), b.query<{ r: R }>(sql, args)])).map((x) => x[0]!.r);
      expect(out.every((r) => r.ok)).toBe(true);
      expect(new Set(out.map((r) => r.customer_number)).size).toBe(1);
      expect((await db.query<R>(`select count(*)::int n from customers where display_name = 'Rita Race'`))[0]).toEqual({ n: 1 });
      expect((await db.query<R>(`select count(*)::int n from properties where address_line1 = '9 Race Rd'`))[0]).toEqual({ n: 1 });
    } finally { await a.close(); await b.close(); }
  });
});
