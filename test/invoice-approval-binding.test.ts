/**
 * AC-03 (docs/defect-ledger.md): an Airtable "Approve" must approve only the preview the approver saw, for the project
 * whose Airtable record sent it. Events have n8n 04's real shape: payload = the row's Project Number cell, its record id
 * and its RoofOps ID cell; no approval number (04 sends none); occurred_at = Airtable's transaction time. 04 shows
 * "PREVIEW APR-…" on a row only after an Airtable Prepare on that row returned PREVIEW_READY or ALREADY_PENDING. The
 * dashboard and the Copilot prepare through the same function, but never write Airtable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';

type Result = Record<string, unknown> & { outcome?: string };
const APPROVER = 'usr7uCnNO15fCefbH';   // mapped to EMP-900 Demo Finance Approver (FINANCE)
const TENANT = '11111111-2222-3333-4444-555555555555';
let seq = 0;

async function call(db: Db, fn: string, event: unknown, worker: string): Promise<Result> {
  const [r] = await db.query<{ r: Result }>(`select ${fn}($1::jsonb, $2) as r`, [JSON.stringify(event), worker]);
  return r!.r;
}
const row = async (db: Db, project: string) => (await db.query<{ rec: string; id: string }>(
  `select l.external_id rec, p.id::text id from projects p join external_links l on l.provider = 'AIRTABLE' and l.entity_type = 'project'
     and l.external_type = 'Record' and l.entity_id = p.id where p.project_number = $1`, [project]))[0]!;

/** What n8n 04 sends when someone sets Invoice Action on an Airtable Projects row. */
async function airtable(db: Db, type: string, onRowOf: string, o: { cell?: string; at?: Date } = {}) {
  const r = await row(db, onRowOf);
  const id = `airtable:achINVOICEHOOK001:txn${String(++seq)}:${r.rec}`;
  const event = { event_id: id, correlation_id: id, event_type: type, source: 'airtable', actor_id: APPROVER, actor_name: 'Demo Finance Approver',
                  occurred_at: (o.at ?? new Date()).toISOString(), payload: { project_number: o.cell ?? onRowOf, airtable_record_id: r.rec, project_uuid: r.id } };
  return call(db, type === 'invoice.prepare_requested' ? 'wf_invoice_prepare' : 'wf_invoice_decide', event, `n8n:${String(seq)}`);
}
/** The dashboard / Copilot prepare_invoice tool (web/lib/queries.ts prepareInvoice). */
const copilot = (db: Db, project: string) => call(db, 'wf_invoice_prepare', { event_id: `dashboard:copilot:${String(++seq)}`, event_type: 'invoice.prepare_requested',
  source: 'roofops-dashboard', actor_id: 'kyle', occurred_at: new Date().toISOString(), payload: { project_number: project } }, 'dashboard');

/** Test setup only: withdraw a project's invoice approvals and anything they created, so a test starts clean. */
async function withdraw(db: Db, project: string) {
  await db.exec(`set session_replication_role = replica`);
  try {
    await db.query(`with p as (select id from projects where project_number = $1), i as (select id from invoices where project_id = (select id from p) and invoice_type = 'FINAL'),
                         o as (delete from outbox where aggregate_id in (select id from i)), l as (delete from invoice_lines where invoice_id in (select id from i))
                    delete from invoices where id in (select id from i)`, [project]);
    await db.query(`update approvals set status = 'CANCELLED' where entity_id = (select id from projects where project_number = $1) and status in ('PENDING', 'EXECUTING')`, [project]);
  } finally { await db.exec(`set session_replication_role = origin`); }
}
const approvals = (db: Db, project: string) => col(db, `select a.approval_number || ' ' || a.status v from approvals a join projects p on p.id = a.entity_id
                                                         where p.project_number = $1 order by a.created_at`, [project]);
const finals = (db: Db, project: string) => col(db, `select i.invoice_number || ' ' || i.total_inc_gst v from invoices i join projects p on p.id = i.project_id
                                                      where p.project_number = $1 and i.invoice_type = 'FINAL'`, [project]);
const xeroWrites = (db: Db, project: string) => col(db, `select o.idempotency_key v from outbox o where o.topic = 'xero.create_draft_invoice'
                                                          and o.payload ->> 'reference' = $1`, [project]);

describe.each(TARGETS)('AC-03: an Airtable Approve approves only the preview shown on that row [%s]', (target) => {
  let db: Db;
  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`update app_settings set value = '${TENANT}' where key = 'xero.demo_tenant_id'`);
    // The Airtable record ids the live base load recorded (verify-airtable-load.ts); synthetic but well-formed here.
    await db.exec(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5('project' || id::text), 1, 14), now(), now() from projects
                   on conflict do nothing`);
  }, 120_000);
  afterAll(async () => { await db.close(); });

  it('a preview re-prepared by the Copilot after the Airtable one went stale is not approved by an Airtable Approve', async () => {
    const p = 'PRJ-2026-0005';
    const shown = await airtable(db, 'invoice.prepare_requested', p);      // 04 shows PREVIEW APR-… $17,831.91 on the row
    expect(shown).toMatchObject({ outcome: 'PREVIEW_READY' });
    await db.query(`insert into variations (variation_number, project_id, description, amount_inc_gst, status, customer_approved_at, approved_by)
                   select 'VAR-AC03-1', p.id, 'Extra flashing', 990.00, 'APPROVED', now(), (select id from employees where employee_code = 'EMP-900')
                   from projects p where p.project_number = $1`, [p]);
    expect(await airtable(db, 'invoice.approved', p)).toMatchObject({ outcome: 'INVALID_STATE', message: expect.stringMatching(/stale/) as unknown });
    const unseen = await copilot(db, p);                                    // $18,821.91: Airtable still shows "stale, prepare a new preview"
    expect(unseen).toMatchObject({ outcome: 'PREVIEW_READY' });
    const r = await airtable(db, 'invoice.approved', p);                   // the approver tries Approve again from the row
    expect(r).toMatchObject({ outcome: 'INVALID_STATE', approval_number: unseen.approval_number, nothing_approved: true,
                              message: expect.stringMatching(/prepared in the RoofOps dashboard and has not been shown on this row/) as unknown });
    expect([await finals(db, p), await xeroWrites(db, p)]).toEqual([[], []]);
    expect(await approvals(db, p)).toEqual([`${shown.approval_number as string} CANCELLED`, `${unseen.approval_number as string} PENDING`]);
  });

  it('guard: once an Airtable Prepare shows the Copilot\'s pending preview on the row, Approve approves exactly that one', async () => {
    const p = 'PRJ-2026-0005';
    await withdraw(db, p);
    const prepared = await copilot(db, p);
    expect(prepared).toMatchObject({ outcome: 'PREVIEW_READY' });
    const shown = await airtable(db, 'invoice.prepare_requested', p);
    expect(shown).toMatchObject({ outcome: 'ALREADY_PENDING', approval_number: prepared.approval_number });   // 04 now shows it on the row
    const r = await airtable(db, 'invoice.approved', p, { at: new Date(Date.now() + 1000) });
    expect(r).toMatchObject({ outcome: 'APPROVED', approval_number: shown.approval_number,
                              amount_inc_gst: (shown.preview as { amount_inc_gst: number }).amount_inc_gst });
    expect(await xeroWrites(db, p)).toHaveLength(1);
  });

  it('an Approve from one project\'s row whose Project Number cell was edited to another project approves nothing', async () => {
    const other = 'PRJ-2026-0004';
    const shown = await airtable(db, 'invoice.prepare_requested', other);  // PRJ-2026-0004's own row shows its preview
    expect(shown).toMatchObject({ outcome: 'PREVIEW_READY' });
    const r = await airtable(db, 'invoice.approved', 'PRJ-2026-0002', { cell: other });   // PRJ-2026-0002's record, cell edited
    expect(r).toMatchObject({ outcome: 'INVALID_STATE', error_class: 'RECONCILIATION_MISMATCH', project_number: 'PRJ-2026-0002', nothing_approved: true });
    expect([await finals(db, other), await xeroWrites(db, other)]).toEqual([[], []]);
    expect(await approvals(db, other)).toEqual([`${shown.approval_number as string} PENDING`]);
  });

  it('guard: a preview prepared and approved from its own row is approved', async () => {
    const p = 'PRJ-2026-0004';
    await withdraw(db, p);
    const shown = await airtable(db, 'invoice.prepare_requested', p);
    const r = await airtable(db, 'invoice.approved', p, { at: new Date(Date.now() + 1000) });
    expect(r).toMatchObject({ outcome: 'APPROVED', approval_number: shown.approval_number, amount_inc_gst: 14664.49 });
    expect(await finals(db, p)).toHaveLength(1);
  });

  it('an Approve clicked before the preview it would approve existed (e.g. 04 ran the batch\'s Prepare first) approves nothing', async () => {
    const p = 'PRJ-2026-0002';
    const clicked = new Date(Date.now() - 60_000);                         // the approver's click, a minute ago: no preview then
    const later = await airtable(db, 'invoice.prepare_requested', p);      // a Prepare processed afterwards (same row)
    expect(later).toMatchObject({ outcome: 'PREVIEW_READY' });
    const r = await airtable(db, 'invoice.approved', p, { at: clicked });
    expect(r).toMatchObject({ outcome: 'INVALID_STATE', approval_number: later.approval_number, nothing_approved: true,
                              message: expect.stringMatching(/shown on this row only after this decision/) as unknown });
    expect([await finals(db, p), await xeroWrites(db, p)]).toEqual([[], []]);
    expect(await approvals(db, p)).toEqual([`${later.approval_number as string} PENDING`]);
  });

  it('a decision from anywhere but Airtable must name its approval, and a payload hash that is not the pending preview\'s is refused', async () => {
    const p = 'PRJ-2026-0002';                     // its preview is pending (previous test)
    const base = { event_type: 'invoice.approved', source: 'ops-script', actor_id: APPROVER, occurred_at: new Date().toISOString() };
    const unnamed = await call(db, 'wf_invoice_decide', { ...base, event_id: 'ops:ac03:1', payload: { project_number: p } }, 'ops');
    expect(unnamed).toMatchObject({ outcome: 'INVALID_STATE', nothing_approved: true, message: expect.stringMatching(/must name the approval/) as unknown });
    const [pending] = await col(db, `select a.approval_number v from approvals a join projects p on p.id = a.entity_id where p.project_number = $1 and a.status = 'PENDING'`, [p]);
    const wrongHash = await call(db, 'wf_invoice_decide', { ...base, event_id: 'ops:ac03:2',
      payload: { project_number: p, approval_number: pending, payload_hash: 'not-the-preview-hash' } }, 'ops');
    expect(wrongHash).toMatchObject({ outcome: 'INVALID_STATE', approval_number: pending, nothing_approved: true });
    expect([await finals(db, p), await xeroWrites(db, p), await approvals(db, p)]).toEqual([[], [], [`${pending!} PENDING`]]);
  });
});
