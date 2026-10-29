/**
 * One synthetic customer's whole business lifecycle at the database boundary, through the same functions the real callers
 * use, asserting the database after every step:
 *   dashboard (web_* with a staff session token): enquiry -> customer and site -> quote (lines, GST) -> sent
 *   n8n 10 (outbox claim / complete with read-back proof): the quote hand-off to Airtable
 *   n8n 01 (wf_quote_accepted): one project with its checklist, material-review task and Drive + Airtable side effects
 *   n8n 02 / 03 (outbox): the Drive folder and the Airtable project write-back, each completed with read-back proof
 *   n8n 06 (wf_airtable_change): Planned Start, Scheduled, the pre-start gate (SWMS / Materials), In Progress, completion
 *     items, Completed
 *   dashboard (web_visit_schedule / web_visit_update): a crewed site visit scheduled, started and completed
 *   n8n 04 (wf_invoice_prepare / wf_invoice_decide, played by test/helpers/airtable04.ts): final invoice prepared and approved
 *   n8n 05 (outbox): exactly one Xero draft write, completed with read-back proof -> invoice SYNCED with a verified link
 *   integrity_check: no FAIL at the end.
 * Failure cases sit next to the step they challenge, each its own it().
 *
 * SIMULATED, never real: every "proof" below (Airtable record ids, Drive folder ids, Xero InvoiceID / ContactID, Xero
 * totals) is made up by this test in the exact shape the n8n workflow sends after its read-back. Nothing here talks to
 * Airtable, Google Drive, Xero or n8n; the proofs only exercise what Postgres accepts or refuses.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPostgres, type Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { InvoiceRows } from './helpers/airtable04.js';
import { TARGETS, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const PW = 'business lifecycle pw 01';
const TENANT = '11111111-2222-3333-4444-555555555555';   // the pinned Xero Demo Company tenant (synthetic id)
const APPROVER = 'usr7uCnNO15fCefbH';                     // Airtable user mapped to EMP-900 (bundle fixture)
const T_PROJECTS = 'tblvUPIoebC3zoacv';
const F = {
  status: 'fldi2Qwz1dAh2tcTE', start: 'fld8rf6RZLgfs6Ron', end: 'fldvZtiassZEgLMAN',
  swms: 'fldM6kgPz6QZagPAC', materials: 'fldozWSCU877wEZHq', photos: 'fldbbksVL3dT6cqyS', cert: 'fldf7iJiyHFxOQgUy',
};
const PEOPLE = [['EMP-830', 'bl-est', 'Synthetic Lifecycle Estimator', 'ESTIMATOR'], ['EMP-831', 'bl-planner', 'Synthetic Lifecycle Planner', 'OPERATIONS_MANAGER'],
  ['EMP-832', 'bl-crew1', 'Synthetic Lifecycle Leading Hand', 'FIELD_CREW'], ['EMP-833', 'bl-crew2', 'Synthetic Lifecycle Roofer', 'FIELD_CREW']] as const;
const LINES = [
  { line_kind: 'LABOUR', description: 'Replace cracked tiles and re-point ridge', quantity: '12', unit: 'hrs', unit_price: '95' },
  { line_kind: 'MATERIAL', product_code: 'PROD-0002', description: 'Ridge capping', quantity: '4', unit: 'PACK', unit_price: '62.50' },
  { line_kind: 'EQUIPMENT', description: 'Scaffold hire (1 week)', quantity: '1', unit: 'LOT', unit_price: '480' },
];
const SUBFOLDERS = ['01 Quote', '02 Site', '03 Materials', '04 Supplier', '05 Completion'];
const FOLDER = 'application/vnd.google-apps.folder';
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
/** A deterministic, made-up Airtable record id (SIMULATED: no such record exists anywhere). */
const fakeRec = (seed: string) => `rec${md5(seed).replace(/[^a-zA-Z0-9]/g, '').slice(0, 14)}`;
/** A deterministic, made-up UUID for Xero ids (SIMULATED). */
const fakeUuid = (seed: string) => md5(seed).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

/** The small database API every block uses; `db` is the connection the calls run on. */
function api(db: Db) {
  const one = async (sql: string, p: unknown[] = []) => (await db.query<R>(sql, p))[0]!;
  const call = async (sql: string, p: unknown[] = []) => (await one(sql, p)).r as R;
  /** n8n calls Postgres as roofops_workflow. */
  const asWorkflow = async (sql: string, p: unknown[] = []) => {
    await db.exec('set role roofops_workflow');
    try { return await call(sql, p); } finally { await db.exec('reset role'); }
  };
  return { one, call, asWorkflow };
}

/** Synthetic staff with dashboard sessions (the real sign-in path). */
async function staff(db: Db): Promise<Record<string, string>> {
  const tok: Record<string, string> = {};
  for (const [code, login, name, role] of PEOPLE) {
    await db.query('insert into employees (employee_code, full_name, email, role, is_active) values ($1, $2, $3, $4, true) on conflict (employee_code) do nothing',
      [code, name, `${code.toLowerCase()}@example.test`, role]);
    await db.query('select ops_staff_set_password($1, $2, $3)', [code, login, PW]);
    tok[login] = String((await db.query<{ r: R }>('select web_staff_sign_in($1, $2) r', [login, PW]))[0]!.r.token);
  }
  return tok;
}

/**
 * SIMULATED n8n 10 read-back proof for a quote hand-off: the three Airtable records as n8n 10 would read them back after
 * writing (ids made up here), in the shape test/enquiry-to-quote.test.ts uses.
 */
function quoteHandoffProof(p: R, attempt: number, tag: string): R {
  const qf = p.quote_fields as R;
  const [QU, CU, PR] = [fakeRec(`quote:${tag}`), fakeRec(`customer:${tag}`), fakeRec(`property:${tag}`)];
  return { verified: true, attempt, quote_record_count: 1, quote_number: p.quote_number, customer_number: p.customer_number, property_number: p.property_number,
    quote_record_id: QU, customer_record_id: CU, property_record_id: PR, quote_customer_link_ids: [CU], quote_property_link_ids: [PR],
    customer_read_back: { id: CU, roofops_id: p.customer_id, number: p.customer_number },
    property_read_back: { id: PR, roofops_id: p.property_id, number: p.property_number, owner_link_ids: [CU] },
    quote_read_back: { id: QU, roofops_id: p.quote_id, number: p.quote_number, version: qf.fldEjEqlzE8Y0M1nf, amount: qf.fldbfUE8DVh1Dwjfs, status: 'Sent',
      customer_link_ids: [CU], property_link_ids: [PR] } };
}

/** An enquiry converted, quoted and sent from the dashboard; returns what the later steps need. */
async function sentQuote(db: Db, tok: Record<string, string>, tag: string, phone: string) {
  const { call, one } = api(db);
  const name = `Lifecycle ${tag}`;
  const lead = await call('select web_lead_create($1, $2, $3, $4, $5, $6, $7, $8, $9) r',
    [tok['bl-est'], name, phone, `${tag.toLowerCase()}@example.test`, `${tag.length} Lifecycle Rd, Avoca`, 'PHONE', 'Leaking over the kitchen', `bl-lead-${tag}`, true]);
  const conv = await call('select web_lead_convert($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) r', [tok['bl-est'], lead.lead_number, lead.record_version, null,
    JSON.stringify({ display_name: name, customer_type: 'RESIDENTIAL', phone, email: `${tag.toLowerCase()}@example.test` }),
    JSON.stringify({ address_line1: `${String(tag.length)} Lifecycle Road`, suburb: 'Avoca', state: 'QLD', postcode: '4670', property_type: 'DETACHED_HOUSE', storeys: '1' }), true]);
  const q = await call('select web_quote_save($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) r',
    [tok['bl-est'], lead.lead_number, null, null, 'LEAK_REPAIR', 'INCLUSIVE', 'Repair the leak above the kitchen', JSON.stringify(LINES), `bl-quote-${tag}`]);
  const v = Number((await one('select record_version::int v from quotes where quote_number = $1', [q.quote_number])).v);
  const sent = await call('select web_quote_send($1, $2, $3) r', [tok['bl-est'], q.quote_number, v]);
  return { lead, conv, q, sent, quote: String(q.quote_number), key: String(sent.airtable_key) };
}

/** n8n 10's hand-off, completed with the SIMULATED proof above. */
async function publishQuote(db: Db, key: string, tag: string) {
  const { one, asWorkflow } = api(db);
  const claim = await asWorkflow(`select wf_claim_side_effect($1, 'n8n:10', 120) r`, [key]);
  const p = (await one('select payload from outbox where idempotency_key = $1', [key])).payload as R;
  const done = await asWorkflow('select wf_complete_side_effect($1, $2::jsonb) r', [key, JSON.stringify(quoteHandoffProof(p, Number(claim.attempt), tag))]);
  return { claim, done, payload: p, quoteRecord: fakeRec(`quote:${tag}`) };
}

/** The acceptance event n8n 01 sends when the office marks the quote Accepted in Airtable. */
const acceptance = (eventId: string, quote: string, today: string, rec: string) => ({ event_id: eventId, correlation_id: `CORR-${eventId}`,
  event_type: 'quote.accepted', source: 'airtable', actor_id: 'airtable-automation', occurred_at: `${today}T09:00:00+10:00`,
  payload: { quote_id: quote, accepted_version: 1, accepted_on: today, airtable_record_id: rec } });

describe.each(TARGETS)('business lifecycle, one synthetic customer [%s]', (target) => {
  let db: Db;
  let tok: Record<string, string> = {};
  let today = '';
  let seq = 0;
  const rows = new InvoiceRows();
  const one = (sql: string, p: unknown[] = []) => api(db).one(sql, p);
  const call = (sql: string, p: unknown[] = []) => api(db).call(sql, p);
  const asWorkflow = (sql: string, p: unknown[] = []) => api(db).asWorkflow(sql, p);
  const n = async (sql: string, p: unknown[] = []) => Number((await one(sql, p)).n);

  // The happy path's state, filled in step by step.
  let S: Awaited<ReturnType<typeof sentQuote>>;
  let quoteRec = '';
  let P = '';                 // project number
  let PID = '';               // project id
  let projectRec = '';        // the project's (simulated) Airtable record id
  let accEvent: ReturnType<typeof acceptance>;
  let visitJob = '';
  let xeroKey = '';
  let invoiceId = '';
  let lastStatusAt = '';

  /** An Airtable Projects edit exactly as n8n 06 hands it over; occurred_at advances one second per edit. */
  const change = (rec: string, fields: R, o: { at?: string } = {}) => {
    seq += 1;
    const at = o.at ?? new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString();
    return asWorkflow(`select wf_airtable_change($1::jsonb, 'test') r`, [JSON.stringify({
      event_id: `airtable:achBIZLIFE:txn${String(seq)}:${rec}`, source: 'airtable', actor_id: APPROVER, occurred_at: at, table_id: T_PROJECTS, record_id: rec,
      changes: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { current: v }])), current: fields })]);
  };
  const rejectedReason = (r: R) => ((r.rejected as { reason?: string }[] | undefined) ?? [])[0]?.reason ?? '';
  const project = () => one(`select status, planned_start_date::text planned_start, actual_start_date::text actual_start, record_version::int rv from projects where project_number = $1`, [P]);
  const checklist = async () => Object.fromEntries((await db.query<R>(`select ci.item_code, ci.status from project_checklist_items ci where ci.project_id = $1`, [PID]))
    .map((r) => [String(r.item_code), String(r.status)]));
  const invoiceEvent = (type: string) => ({ event_id: `EVT-BIZLIFE-INV-${String(++seq)}`, event_type: type, source: 'airtable', actor_id: APPROVER,
    occurred_at: new Date(Date.now() + seq * 1000).toISOString(), payload: { project_number: P, airtable_record_id: projectRec } });
  const at = (days: number, hour: number) => `${new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00+10:00`;
  const visit = async (t: string, job: string, action: string, reason: string | null = null) => {
    const v = (await one(`select record_version v from jobs where job_number = $1`, [job])).v;
    return call('select web_visit_update($1, $2, $3, $4, $5, $6, $7) r', [t, job, action, v, reason, null, null]);
  };
  /** SIMULATED n8n 05 read-back of the Xero draft it just created (ids and totals made up from the payload). */
  const xeroProof = (p: R, over: R = {}): R => ({ verified: true, tenant_id: TENANT, organisation_class: 'DEMO', invoice_id: fakeUuid(`xero-invoice:${P}`),
    invoice_number: p.xero_invoice_number, reference: p.reference, status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false,
    contact_id: fakeUuid(`xero-contact:${String(p.customer_id)}`), contact_number: p.xero_contact_number, total: p.amount_inc_gst, total_tax: p.gst_amount,
    currency: 'AUD', line_amount_types: 'Inclusive', matching_invoices: 1, ...over });
  const fails = async () => (await db.query<{ v: string }>(`select entity || '.' || check_key v from integrity_check() where status = 'FAIL' order by 1`)).map((r) => r.v);

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.query(`update app_settings set value = $1 where key = 'xero.demo_tenant_id'`, [TENANT]);
    tok = await staff(db);
    today = String((await one('select app_today()::text d')).d);
  }, 180_000);
  afterAll(async () => { await db.close(); });

  // ------------------------------------------------------------------------------------------------- sales
  it('1. the enquiry is recorded once, by the signed-in estimator', async () => {
    expect(await fails()).toEqual([]);                                   // the baseline the last step compares with
    S = await sentQuote(db, tok, 'Ivy', '0477 100 200');
    expect(S.lead).toMatchObject({ ok: true, record_version: 1 });
    expect(await one(`select actor_id from audit_events where action = 'lead.created' and business_reference = $1`, [S.lead.lead_number])).toEqual({ actor_id: 'EMP-830' });
    expect(await n(`select count(*)::int n from leads where request_key = 'bl-lead-Ivy'`)).toBe(1);
  });

  it('2. customer and site are created from the enquiry', async () => {
    expect(S.conv).toMatchObject({ ok: true, new_customer: true });
    expect(await one(`select c.display_name, c.phone, pr.address_line1, pr.suburb, pr.state, pr.postcode from customers c join properties pr on pr.property_number = $2
                       where c.customer_number = $1`, [S.conv.customer_number, S.conv.property_number]))
      .toEqual({ display_name: 'Lifecycle Ivy', phone: '0477 100 200', address_line1: '3 Lifecycle Road', suburb: 'Avoca', state: 'QLD', postcode: '4670' });
    expect(await one(`select customer_number from v_dashboard_leads where lead_number = $1`, [S.lead.lead_number])).toEqual({ customer_number: S.conv.customer_number });
  });

  it('3. the quote is drafted with its three lines; prices include GST, GST is 1/11 of the total', async () => {
    // 12 x 95 + 4 x 62.50 + 480 = 1870.00 inc GST; GST = 1870 / 11 = 170.00
    expect(S.q).toMatchObject({ ok: true, version: 1, status: 'DRAFT', total_inc_gst: 1870, gst_amount: 170 });
    expect(await one(`select version_number, line_amount_type, total_inc_gst::text t, jsonb_array_length(lines) n from v_dashboard_quotes where quote_number = $1`, [S.quote]))
      .toEqual({ version_number: 1, line_amount_type: 'INCLUSIVE', t: '1870.00', n: 3 });
  });

  it('4. the quote is sent: SENT today, valid 30 days, exactly one Airtable hand-off queued', async () => {
    expect(S.sent).toMatchObject({ ok: true, status: 'SENT' });
    expect(await one(`select status, sent_on::text s, (valid_until - sent_on) days from quotes where quote_number = $1`, [S.quote])).toEqual({ status: 'SENT', s: today, days: 30 });
    expect(await one(`select count(*)::int n, min(status) st from outbox where topic = 'airtable.quote_publish' and aggregate_id = (select id from quotes where quote_number = $1)`, [S.quote]))
      .toEqual({ n: 1, st: 'PENDING' });
    expect(await one(`select status from v_dashboard_leads where lead_number = $1`, [S.lead.lead_number])).toEqual({ status: 'QUOTED' });
  });

  it('5. the quote hand-off to Airtable completes with (simulated) read-back proof: quote, customer and site linked', async () => {
    const next = await asWorkflow(`select wf_quote_publish_next('n8n:10:bizlife') r`);
    expect((next.writes as R[]).map((w) => w.key)).toContain(S.key);
    const r = await publishQuote(db, S.key, 'Ivy');
    quoteRec = r.quoteRecord;
    expect(r.claim).toMatchObject({ claimed: true, attempt: 1 });
    expect(r.done).toMatchObject({ status: 'RECORDED' });
    expect(await one(`select status from outbox where idempotency_key = $1`, [S.key])).toEqual({ status: 'DONE' });
    expect(await one(`select in_airtable, airtable_handoff from v_dashboard_quotes where quote_number = $1`, [S.quote])).toEqual({ in_airtable: true, airtable_handoff: 'DONE' });
    expect(await n(`select count(*)::int n from external_links where provider = 'AIRTABLE' and external_type = 'Record' and verified_at is not null and external_id = any($1)`,
      [[quoteRec, fakeRec('customer:Ivy'), fakeRec('property:Ivy')]])).toBe(3);
  });

  // ---------------------------------------------------------------------------------------------- acceptance
  it('6. accepted (wf_quote_accepted): exactly one project, checklist, material-review task, Drive and Airtable side effects queued', async () => {
    accEvent = acceptance('EVT-BIZLIFE-ACCEPT', S.quote, today, quoteRec);
    const acc = await asWorkflow('select wf_quote_accepted($1::jsonb) r', [JSON.stringify(accEvent)]);
    expect(acc).toMatchObject({ status: 'CREATED', duplicate: false, quote_number: S.quote });
    P = String(acc.project_number); PID = String(acc.project_id);
    expect(await one(`select q.status, q.accepted_on::text a from quotes q where q.quote_number = $1`, [S.quote])).toEqual({ status: 'ACCEPTED', a: today });
    expect(await one(`select p.status, c.customer_number, pr.property_number from projects p join customers c on c.id = p.customer_id join properties pr on pr.id = p.property_id
                       where p.id = $1`, [PID])).toEqual({ status: 'PLANNING', customer_number: S.conv.customer_number, property_number: S.conv.property_number });
    expect(await n(`select count(*)::int n from projects p join quotes q on q.id = p.quote_id where q.quote_number = $1`, [S.quote])).toBe(1);
    expect(await checklist()).toMatchObject({ SWMS_SIGNED: 'OPEN', MATERIALS_REVIEWED: 'OPEN', COMPLETION_PHOTOS: 'OPEN', COMPLIANCE_CERTIFICATE: 'OPEN' });
    expect((await db.query<R>(`select task_type, status from tasks where project_id = $1`, [PID]))).toEqual([{ task_type: 'MATERIAL_REVIEW', status: 'OPEN' }]);
    expect((await db.query<R>(`select topic, status from outbox where aggregate_id = $1 order by topic`, [PID])))
      .toEqual([{ topic: 'airtable.project_writeback', status: 'PENDING' }, { topic: 'drive.ensure_project_folder', status: 'PENDING' }]);
    expect(await one(`select project_number, status from v_dashboard_leads where lead_number = $1`, [S.lead.lead_number])).toEqual({ project_number: P, status: 'WON' });
  });

  it('failure: the same acceptance delivered again creates nothing (one project)', async () => {
    const again = await asWorkflow('select wf_quote_accepted($1::jsonb) r', [JSON.stringify(accEvent)]);
    expect(again).toMatchObject({ duplicate: true, project_id: PID });
    const semantic = await asWorkflow('select wf_quote_accepted($1::jsonb) r', [JSON.stringify({ ...accEvent, event_id: 'EVT-BIZLIFE-ACCEPT-2', correlation_id: 'CORR-BIZLIFE-ACCEPT-2' })]);
    expect(semantic).toMatchObject({ duplicate: true, project_id: PID });
    expect(await n(`select count(*)::int n from projects p join quotes q on q.id = p.quote_id where q.quote_number = $1`, [S.quote])).toBe(1);
    expect(await n(`select count(*)::int n from outbox where aggregate_id = $1`, [PID])).toBe(2);
    expect(await n(`select count(*)::int n from tasks where project_id = $1`, [PID])).toBe(1);
  });

  it('7. the Drive folder and the Airtable project write-back complete with (simulated) read-back proof; the project is linked', async () => {
    const drive = `drive:project-folder:${PID}`;
    const airtable = `airtable:project-writeback:${PID}`;
    expect(await asWorkflow(`select wf_claim_side_effect($1, 'n8n:02', 120) r`, [drive])).toMatchObject({ claimed: true, attempt: 1 });
    const dp = (await one('select payload from outbox where idempotency_key = $1', [drive])).payload as R;
    // SIMULATED Drive read-back: folder and subfolder ids are made up.
    const folderId = `1BIZLIFE${md5(PID).slice(0, 12)}`;
    const driveProof = { verified: true, folder_id: folderId, mime_type: FOLDER, name: dp.folder_name, parent_id: '1ROOT', trashed: false,
      web_view_link: `https://drive.google.com/drive/folders/${folderId}`, app_properties: { roofops_project_id: PID },
      subfolders: SUBFOLDERS.map((s, i) => ({ id: `${folderId}-SUB${String(i)}`, name: s, parent_id: folderId, mime_type: FOLDER, trashed: false })) };
    expect(await asWorkflow('select wf_complete_side_effect($1, $2::jsonb) r', [drive, JSON.stringify(driveProof)])).toMatchObject({ status: 'RECORDED', remaining_side_effects: 1 });

    const claim = await asWorkflow(`select wf_claim_side_effect($1, 'n8n:03', 120) r`, [airtable]);
    expect(claim).toMatchObject({ claimed: true, payload: { project_number: P, quote_airtable_record_id: quoteRec, drive_folder: { folder_id: folderId } } });
    // SIMULATED Airtable read-back of the project record n8n 03 would have written.
    projectRec = fakeRec(`project:${P}`);
    const proof = { verified: true, project_record_id: projectRec, roofops_id: PID, project_number: P, linked_quote_record_ids: [quoteRec], drive_folder_url: driveProof.web_view_link };
    expect(await asWorkflow('select wf_complete_side_effect($1, $2::jsonb) r', [airtable, JSON.stringify(proof)])).toMatchObject({ status: 'RECORDED', remaining_side_effects: 0 });
    expect((await db.query<R>(`select topic, status from outbox where aggregate_id = $1 order by topic`, [PID])))
      .toEqual([{ topic: 'airtable.project_writeback', status: 'DONE' }, { topic: 'drive.ensure_project_folder', status: 'DONE' }]);
    expect(await one(`select external_id from external_links where provider = 'AIRTABLE' and entity_type = 'project' and entity_id = $1 and verified_at is not null`, [PID]))
      .toEqual({ external_id: projectRec });
  });

  it('failure: an unauthorised transition (Planning -> Completed) is refused and changes nothing', async () => {
    const before = await project();
    const r = await change(projectRec, { [F.status]: 'Completed' });
    expect(r.outcome).toBe('REJECTED');
    expect(rejectedReason(r)).toMatch(/not an allowed status change/);
    expect(r.corrections).toMatchObject({ [F.status]: 'Planning' });
    expect(await project()).toEqual(before);
  });

  // ------------------------------------------------------------------------------------------------ delivery
  it('8. Scheduled with a Planned Start (through Airtable)', async () => {
    const start = at(3, 0).slice(0, 10), end = at(10, 0).slice(0, 10);
    expect(await change(projectRec, { [F.start]: start, [F.end]: end })).toMatchObject({ outcome: 'APPLIED' });
    lastStatusAt = new Date(Date.UTC(2026, 9, 1, 0, 0, seq + 1)).toISOString();
    expect(await change(projectRec, { [F.status]: 'Scheduled' }, { at: lastStatusAt })).toMatchObject({ outcome: 'APPLIED' });
    expect(await project()).toMatchObject({ status: 'SCHEDULED', planned_start: start, actual_start: null });
  });

  it('failure: a status change replayed late (older than the applied one) is STALE and changes nothing', async () => {
    const before = await project();
    const audits = await n(`select count(*)::int n from audit_events where action = 'project.status.changed' and business_reference = $1`, [P]);
    const late = await change(projectRec, { [F.status]: 'Planning' }, { at: new Date(Date.parse(lastStatusAt) - 60_000).toISOString() });
    expect(late).toMatchObject({ outcome: 'STALE' });
    expect(late.stale).toHaveLength(1);
    expect(await project()).toEqual(before);
    expect(await n(`select count(*)::int n from audit_events where action = 'project.status.changed' and business_reference = $1`, [P])).toBe(audits);
  });

  it('9. In Progress is refused while SWMS and Materials are open; the row stays Scheduled', async () => {
    const r = await change(projectRec, { [F.status]: 'In Progress' });
    expect(r.outcome).toBe('REJECTED');
    expect(rejectedReason(r)).toMatch(/pre-start items are still open/);
    expect(r.corrections).toMatchObject({ [F.status]: 'Scheduled' });
    expect(await project()).toMatchObject({ status: 'SCHEDULED', actual_start: null });
  });

  it('10. SWMS signed and Materials reviewed through Airtable, attributed to the mapped employee', async () => {
    expect(await change(projectRec, { [F.swms]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await change(projectRec, { [F.materials]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await checklist()).toMatchObject({ SWMS_SIGNED: 'DONE', MATERIALS_REVIEWED: 'DONE' });
    expect(await n(`select count(*)::int n from project_checklist_items ci join employees e on e.id = ci.completed_by
                     where ci.project_id = $1 and ci.stage = 'PRE_START' and e.employee_code = 'EMP-900' and ci.completed_on = app_today()`, [PID])).toBe(2);
  });

  it('11. a site visit is scheduled with a crew, started and completed (dashboard)', async () => {
    const s = await call('select web_visit_schedule($1, $2, $3, $4, $5, $6, $7, $8, $9) r', [tok['bl-planner'], P, 'INSTALL', at(3, 7), at(3, 15), ['EMP-832', 'EMP-833'], null, null, 'bl-visit-0001']);
    expect(s).toMatchObject({ ok: true, status: 'SCHEDULED' });
    visitJob = String(s.job_number);
    expect((await db.query<R>(`select e.employee_code, a.crew_role from job_assignments a join employees e on e.id = a.employee_id join jobs j on j.id = a.job_id
                                 where j.job_number = $1 order by 1`, [visitJob]))).toEqual([{ employee_code: 'EMP-832', crew_role: 'LEADING_HAND' }, { employee_code: 'EMP-833', crew_role: 'CREW' }]);
    expect(await visit(tok['bl-crew1']!, visitJob, 'start')).toMatchObject({ ok: true, status: 'IN_PROGRESS' });
    expect(await visit(tok['bl-crew1']!, visitJob, 'complete', 'Tiles replaced, ridge re-pointed')).toMatchObject({ ok: true, status: 'COMPLETED' });
    expect(await one(`select status, actual_start is not null started, actual_end is not null ended from jobs where job_number = $1`, [visitJob]))
      .toEqual({ status: 'COMPLETED', started: true, ended: true });
  });

  it('12. In Progress now applies (the pre-start gate is satisfied); Actual Start is today', async () => {
    lastStatusAt = new Date(Date.UTC(2026, 9, 1, 0, 0, seq + 1)).toISOString();
    expect(await change(projectRec, { [F.status]: 'In Progress' }, { at: lastStatusAt })).toMatchObject({ outcome: 'APPLIED' });
    expect(await project()).toMatchObject({ status: 'IN_PROGRESS', actual_start: today });
  });

  it('13. completion items Done through Airtable, then Completed', async () => {
    expect(await change(projectRec, { [F.photos]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await change(projectRec, { [F.cert]: 'Done' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await checklist()).toMatchObject({ COMPLETION_PHOTOS: 'DONE', COMPLIANCE_CERTIFICATE: 'DONE' });
    expect(await change(projectRec, { [F.status]: 'Completed' })).toMatchObject({ outcome: 'APPLIED' });
    expect(await project()).toMatchObject({ status: 'COMPLETED' });
    expect(await one(`select invoice_status from v_dashboard_projects where project_number = $1`, [P])).toEqual({ invoice_status: 'READY_TO_INVOICE' });
  });

  // ------------------------------------------------------------------------------------------------- finance
  it('14. the final invoice is prepared and approved (the n8n 04 path): one FINAL invoice for the quoted amount, exactly one Xero draft write queued', async () => {
    const prep = await rows.send(db, invoiceEvent('invoice.prepare_requested'), 'n8n:04:bizlife');
    expect(prep, JSON.stringify(prep)).toMatchObject({ outcome: 'PREVIEW_READY', project_number: P });
    expect(prep.preview).toMatchObject({ amount_inc_gst: 1870, gst_amount: 170, amount_ex_gst: 1700, reference: P });
    expect(await n(`select count(*)::int n from invoices where project_id = $1`, [PID])).toBe(0);    // a preview is not an invoice
    const ok = await rows.send(db, invoiceEvent('invoice.approved'), 'n8n:04:bizlife');
    expect(ok, JSON.stringify(ok)).toMatchObject({ outcome: 'APPROVED', amount_inc_gst: 1870 });
    invoiceId = String(ok.invoice_id); xeroKey = String(ok.xero_key);
    expect(await one(`select invoice_type, status, sync_status, total_inc_gst::text t, gst_amount::text g from invoices where project_id = $1`, [PID]))
      .toEqual({ invoice_type: 'FINAL', status: 'APPROVED', sync_status: 'PENDING', t: '1870.00', g: '170.00' });
    expect((await db.query<R>(`select status, idempotency_key from outbox where topic = 'xero.create_draft_invoice' and aggregate_id = $1`, [invoiceId])))
      .toEqual([{ status: 'PENDING', idempotency_key: xeroKey }]);
    expect(await one(`select status from approvals where approval_number = $1`, [ok.approval_number])).toEqual({ status: 'EXECUTING' });
  });

  it('failure: approving the final again creates no second invoice and no second Xero write', async () => {
    const again = await rows.send(db, invoiceEvent('invoice.approved'), 'n8n:04:bizlife');
    expect(again).toMatchObject({ outcome: 'ALREADY_PROCESSED', first_outcome: 'APPROVED' });
    expect(await n(`select count(*)::int n from invoices where project_id = $1`, [PID])).toBe(1);
    expect(await n(`select count(*)::int n from outbox o join invoices i on i.id = o.aggregate_id where o.topic = 'xero.create_draft_invoice' and i.project_id = $1`, [PID])).toBe(1);
    expect(await rows.send(db, invoiceEvent('invoice.prepare_requested'), 'n8n:04:bizlife')).toMatchObject({ outcome: 'ALREADY_INVOICED' });
  });

  it('failure: a Xero read-back with the wrong invoice amount is refused; the invoice is not SYNCED and nothing is linked', async () => {
    expect(await asWorkflow(`select wf_claim_side_effect($1, 'n8n:05', 120) r`, [xeroKey])).toMatchObject({ claimed: true, attempt: 1 });
    const p = (await one('select payload from outbox where idempotency_key = $1', [xeroKey])).payload as R;
    for (const over of [{ total: Number(p.amount_inc_gst) + 0.01 }, { total: Number(p.amount_inc_gst) - 100 }]) {
      await expect(asWorkflow('select wf_complete_side_effect($1, $2::jsonb) r', [xeroKey, JSON.stringify(xeroProof(p, over))]), JSON.stringify(over)).rejects.toThrow(/does not match the approved/);
    }
    // The right total with the wrong GST is refused too.
    await expect(asWorkflow('select wf_complete_side_effect($1, $2::jsonb) r', [xeroKey, JSON.stringify(xeroProof(p, { total_tax: Number(p.gst_amount) + 1 }))])).rejects.toThrow();
    expect(await one(`select sync_status from invoices where id = $1`, [invoiceId])).toEqual({ sync_status: 'PENDING' });
    expect(await one(`select status from outbox where idempotency_key = $1`, [xeroKey])).toEqual({ status: 'DISPATCHING' });
    expect(await n(`select count(*)::int n from external_links where provider = 'XERO' and entity_id = $1`, [invoiceId])).toBe(0);
  });

  it('15. the Xero draft write completes with (simulated) read-back proof: invoice SYNCED, verified Xero link, approval EXECUTED', async () => {
    const p = (await one('select payload from outbox where idempotency_key = $1', [xeroKey])).payload as R;
    expect(p).toMatchObject({ xero_tenant_id: TENANT, reference: P, amount_inc_gst: 1870 });
    expect(await asWorkflow('select wf_complete_side_effect($1, $2::jsonb) r', [xeroKey, JSON.stringify(xeroProof(p))])).toMatchObject({ status: 'RECORDED' });
    expect(await one(`select status, sync_status from invoices where id = $1`, [invoiceId])).toEqual({ status: 'APPROVED', sync_status: 'SYNCED' });
    expect(await one(`select status from outbox where idempotency_key = $1`, [xeroKey])).toEqual({ status: 'DONE' });
    expect((await db.query<R>(`select external_type, external_id, verified_at is not null verified from external_links where provider = 'XERO' and entity_type = 'invoice' and entity_id = $1`, [invoiceId])))
      .toEqual([{ external_type: 'Invoice', external_id: fakeUuid(`xero-invoice:${P}`), verified: true }]);
    expect(await one(`select a.status from approvals a join invoices i on i.approval_id = a.id where i.id = $1`, [invoiceId])).toEqual({ status: 'EXECUTED' });
    expect(await n(`select count(*)::int n from outbox where topic = 'xero.create_draft_invoice' and aggregate_id = $1`, [invoiceId])).toBe(1);
  });

  // ----------------------------------------------------------------------------------- side-effect failure
  it('failure: a failed Airtable write-back is recorded as a failure, then retried: one record, one link, no duplicate', async () => {
    const X = await sentQuote(db, tok, 'Retry', '0477 300 400');
    const pub = await publishQuote(db, X.key, 'Retry');
    expect(pub.done).toMatchObject({ status: 'RECORDED' });
    const acc = await asWorkflow('select wf_quote_accepted($1::jsonb) r', [JSON.stringify(acceptance('EVT-BIZLIFE-RETRY', X.quote, today, pub.quoteRecord))]);
    expect(acc).toMatchObject({ status: 'CREATED' });
    const id = String(acc.project_id), num = String(acc.project_number);
    const drive = `drive:project-folder:${id}`, airtable = `airtable:project-writeback:${id}`;
    await asWorkflow(`select wf_claim_side_effect($1, 'n8n:02', 120) r`, [drive]);
    const dp = (await one('select payload from outbox where idempotency_key = $1', [drive])).payload as R;
    const folderId = `1BIZRETRY${md5(id).slice(0, 12)}`;           // SIMULATED Drive read-back
    const url = `https://drive.google.com/drive/folders/${folderId}`;
    expect(await asWorkflow('select wf_complete_side_effect($1, $2::jsonb) r', [drive, JSON.stringify({ verified: true, folder_id: folderId, mime_type: FOLDER, name: dp.folder_name,
      parent_id: '1ROOT', trashed: false, web_view_link: url, app_properties: { roofops_project_id: id },
      subfolders: SUBFOLDERS.map((s, i) => ({ id: `${folderId}-SUB${String(i)}`, name: s, parent_id: folderId, mime_type: FOLDER, trashed: false })) })])).toMatchObject({ status: 'RECORDED' });

    expect(await asWorkflow(`select wf_claim_side_effect($1, 'n8n:03', 120) r`, [airtable])).toMatchObject({ claimed: true, attempt: 1 });
    const f = await asWorkflow('select wf_fail_side_effect($1, $2, $3, $4, $5) r', [airtable, 'UPSTREAM_5XX', 'Airtable returned 503 (simulated)', 503, null]);
    expect(f).toMatchObject({ retry: true, attempt: 1 });
    expect(await one(`select status, attempts::int a, last_error from outbox where idempotency_key = $1`, [airtable])).toEqual({ status: 'FAILED', a: 1, last_error: 'Airtable returned 503 (simulated)' });
    expect(await n(`select count(*)::int n from external_links where provider = 'AIRTABLE' and entity_type = 'project' and entity_id = $1`, [id])).toBe(0);

    await db.query(`update outbox set next_attempt_at = now() where idempotency_key = $1`, [airtable]);   // the backoff has elapsed
    expect(await asWorkflow(`select wf_claim_side_effect($1, 'n8n:03', 120) r`, [airtable])).toMatchObject({ claimed: true, attempt: 2 });
    const rec = fakeRec(`project:${num}`);                         // SIMULATED Airtable read-back
    const proof = { verified: true, project_record_id: rec, roofops_id: id, project_number: num, linked_quote_record_ids: [pub.quoteRecord], drive_folder_url: url };
    expect(await asWorkflow('select wf_complete_side_effect($1, $2::jsonb) r', [airtable, JSON.stringify(proof)])).toMatchObject({ status: 'RECORDED', remaining_side_effects: 0 });
    // A late report of the same write (an n8n run that died after writing) records nothing new.
    expect(await asWorkflow('select wf_complete_side_effect($1, $2::jsonb) r', [airtable, JSON.stringify(proof)])).toMatchObject({ status: 'ALREADY_DONE' });
    expect(await one(`select status, attempts::int a from outbox where idempotency_key = $1`, [airtable])).toEqual({ status: 'DONE', a: 2 });
    expect(await n(`select count(*)::int n from outbox where topic = 'airtable.project_writeback' and aggregate_id = $1`, [id])).toBe(1);
    expect((await db.query<R>(`select external_id from external_links where provider = 'AIRTABLE' and entity_type = 'project' and entity_id = $1`, [id]))).toEqual([{ external_id: rec }]);
    // A late report naming a different record for the same project is ignored (the write is DONE): still one link.
    expect(await asWorkflow('select wf_complete_side_effect($1, $2::jsonb) r', [airtable, JSON.stringify({ ...proof, project_record_id: fakeRec(`other:${num}`) })]))
      .toMatchObject({ status: 'ALREADY_DONE' });
    expect(await n(`select count(*)::int n from external_links where provider = 'AIRTABLE' and entity_type = 'project' and entity_id = $1`, [id])).toBe(1);
  });

  // ------------------------------------------------------------------------------------------------ the end
  it('16. integrity_check has no FAIL at the end', async () => {
    expect(await fails()).toEqual([]);
    expect(await one(`select status from integrity_check() where check_key = 'done_has_proof'`)).toEqual({ status: 'PASS' });
    expect(await one(`select status from integrity_check() where check_key = 'accepted_at_most_one_project'`)).toEqual({ status: 'PASS' });
  });

  // Not covered here, on purpose: settlement in Xero and Close (07's verified read, wf_reconcile_external) are out of this
  // lifecycle's scope as specified; project-lifecycle.test.ts covers them on the same kind of project.
});

/** Real concurrency (PGlite has one connection): the same acceptance on two connections at once makes one project. */
describe.runIf(TARGETS.includes('postgres'))('business lifecycle: the same acceptance on two connections at once [postgres]', () => {
  let db: Db & { url?: string };
  let tok: Record<string, string> = {};
  beforeAll(async () => {
    db = await migratedDb('postgres');
    await importBundle(db);
    tok = await staff(db);
  }, 180_000);
  afterAll(async () => { await db.close(); });

  it('two simultaneous deliveries of one acceptance (two event ids, same quote and version): one CREATED, one DUPLICATE, one project', async () => {
    const S = await sentQuote(db, tok, 'Race', '0477 500 600');
    const pub = await publishQuote(db, S.key, 'Race');
    expect(pub.done).toMatchObject({ status: 'RECORDED' });
    const today = String((await db.query<R>('select app_today()::text d'))[0]!.d);
    const [a, b] = [await openPostgres(db.url!), await openPostgres(db.url!)];
    try {
      const sql = 'select wf_quote_accepted($1::jsonb) r';
      const out = (await Promise.all([
        a.query<{ r: R }>(sql, [JSON.stringify(acceptance('EVT-BIZLIFE-RACE-A', S.quote, today, pub.quoteRecord))]),
        b.query<{ r: R }>(sql, [JSON.stringify(acceptance('EVT-BIZLIFE-RACE-B', S.quote, today, pub.quoteRecord))]),
      ])).map((x) => x[0]!.r);
      expect(out.map((r) => r.status).sort()).toEqual(['CREATED', 'DUPLICATE']);
      expect(out[0]!.project_id).toBe(out[1]!.project_id);
    } finally { await a.close(); await b.close(); }
    expect((await db.query<R>(`select count(*)::int n from projects p join quotes q on q.id = p.quote_id where q.quote_number = $1`, [S.quote]))[0]).toEqual({ n: 1 });
    expect((await db.query<R>(`select count(*)::int n from outbox o join projects p on p.id = o.aggregate_id join quotes q on q.id = p.quote_id where q.quote_number = $1`, [S.quote]))[0])
      .toEqual({ n: 2 });
    expect((await db.query<R>(`select status from integrity_check() where check_key = 'accepted_at_most_one_project'`))[0]).toEqual({ status: 'PASS' });
  });
});
