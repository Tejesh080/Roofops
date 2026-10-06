/**
 * AC-14C Part B2: the committed scenario builder for the supervised final-invoice reissue.
 *
 * It builds the one state the reissue facility exists for, on any migrated local database, entirely through the real
 * workflow functions - no network, no external system:
 *
 *   04 prepare/approve  -> an APPROVED final invoice whose Xero draft write is queued (wf_invoice_prepare / wf_invoice_decide)
 *   05 claim/complete   -> the write DONE with read-back proofs and the verified Xero invoice link in the bound tenant
 *   07 reconciliation   -> a verified VOIDED or DELETED read of that linked InvoiceID (xero_record_settlement)
 *
 * The invoice is then VOIDED (not collectible, `project_billing` still owes the money, the close gate still refuses)
 * and `ops_reissue_request` / `ops_reissue_decide` have everything they require: a void proof of the exact linked
 * InvoiceID in the bound tenant, no payment and no credit, no live write. `APPROVED` builds the same state without the
 * void read: the invoice is live, so a reissue must be refused (`INVOICE_NOT_VOIDED`).
 *
 * Usage (tests, validators, and anything driving `scripts/reissue.ts`):
 *   const s = await deletedReissueScenario(db);          // a migrated + imported Db you own; s.close() is a no-op
 *   const s = await voidedReissueScenario('postgres');   // the builder opens, migrates, imports and drops its own db
 *   s.invoice.number                                     // the number the CLI takes (--invoice)
 *   s.request('EMP-900', 'a real reason')                // ops_reissue_request, the database's own answer
 *   s.decide(String(r.approval_number), 'EMP-900')       // ops_reissue_decide
 */
import { createHash } from 'node:crypto';
import { importBundle } from '../../src/import/importer.js';
import type { Db } from '../../src/db/db.js';
import { InvoiceRows } from './airtable04.js';
import { migratedDb } from './db.js';

/** The two verified Xero void families the facility accepts, plus a live (never voided) invoice. */
export type ScenarioFamily = 'DELETED' | 'VOIDED' | 'APPROVED';
export type ScenarioTarget = 'pglite' | 'postgres';

/** The outcome of ops_reissue_request / ops_reissue_decide: `ok`, or a canonical refusal `code` with a `detail`. */
export interface Outcome { ok: boolean; code: string; detail?: string; [key: string]: unknown }

export interface ScenarioInvoice {
  id: string;
  number: string;
  project: string;
  /** The generation-1 outbox idempotency key of the draft write. */
  key: string;
  /** The draft write payload (invoice number, totals, bound tenant, ...). */
  payload: Record<string, unknown>;
  total: number;
  xeroNumber: string;
  /** The InvoiceID the draft was read back as (the linked Xero identity). */
  xid: string;
  approvalId: string;
}

export interface ReissueScenario {
  db: Db & { url?: string };
  family: ScenarioFamily;
  project: string;
  invoice: ScenarioInvoice;
  /** Closes the database only when this builder opened it; a Db you supplied stays yours. */
  close(): Promise<void>;
  /** The invoice row: status, sync_status, voided_reason, record_version, approval_id. */
  state(): Promise<Record<string, unknown>>;
  /** Every generation of this invoice, oldest first (the ledger). */
  ledger(): Promise<Record<string, unknown>[]>;
  /** Every `xero.create_draft_invoice` write of this invoice, oldest first. */
  outbox(): Promise<Record<string, unknown>[]>;
  /** The single current XERO Invoice link of the invoice, or null. */
  link(): Promise<string | null>;
  /** The latest recorded observation of the invoice (verdict, settlement, tenant, InvoiceID). */
  latestObservation(): Promise<Record<string, unknown> | null>;
  /** The read-model row of `v_invoice_balances` for the invoice. */
  balance(): Promise<Record<string, unknown>>;
  /** The integrity rules currently FAILing (empty on any healthy state). */
  integrityFails(): Promise<string[]>;
  /** `ops_reissue_request` - the database decides, the helper only calls it. */
  request(by: string, reason?: string | null): Promise<Outcome>;
  /** `ops_reissue_decide` - same rule: the helper never re-implements the facility. */
  decide(approval: string, by: string, note?: string | null): Promise<Outcome>;
}

export interface ScenarioOptions {
  /** Which project hosts the final invoice. The imported bundle allows 0001, 0002, 0004 and 0005 only. */
  project?: string;
  /** The Xero InvoiceID the draft is read back as (must be unique inside one database). */
  xid?: string;
}

const APPROVER = 'usr7uCnNO15fCefbH';                     // the Airtable approver the invoice flow uses
const TENANT = '11111111-2222-3333-4444-555555555555';    // the pinned tenant, and every write's bound tenant
const ADMIN = 'EMP-901';                                  // ADMIN, active (fixture)
const INACTIVE = 'EMP-902';                               // FINANCE, not active (fixture)
const DEFAULT_PROJECT = 'PRJ-2026-0004';
const DEFAULT_XID = 'aaaaaaaa-bbbb-cccc-dddd-0000000000a4';

/** Deterministic ids: same calls, same ids, no randomness and no clock reads. */
let counter = 0;
const next = () => String(++counter);

const recFor = (project: string) => `rec${md5(project).slice(0, 14)}`;
const uuidFor = (seed: string) => md5(seed).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

/** md5 as the repo's fixtures use it (deterministic ids, never a security use). */
const md5 = (value: string): string => createHash('md5').update(value).digest('hex');

const invariant = (ok: boolean, message: string): void => { if (!ok) throw new Error(`reissue scenario: ${message}`); };

/** The first row, or a plain error naming what the database did not give back. */
const required = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) throw new Error(`reissue scenario: ${message}`);
  return value;
};

/**
 * Builds the scenario: migrate/import when given a target, then prepare/approve, complete with proofs, and (for the
 * two void families) apply the verified VOIDED/DELETED read of the linked document through the real 07 path.
 */
export async function buildReissueScenario(
  target: ScenarioTarget | (Db & { url?: string }),
  family: ScenarioFamily,
  opts: ScenarioOptions = {},
): Promise<ReissueScenario> {
  const project = opts.project ?? DEFAULT_PROJECT;
  const xid = opts.xid ?? DEFAULT_XID;
  const opened = typeof target === 'string';
  const db = opened ? await migratedDb(target) : target;
  try {
    await importBundle(db);                                // a no-op when the dataset is already there
    await fixtures(db);
    const rows = new InvoiceRows();
    const invoice = await buildFinal(db, rows, project, xid);
    if (family !== 'APPROVED') await applyVoid(db, invoice, family);
    return scenario(db, family, project, invoice, opened);
  } catch (e) {
    if (opened) await db.close();                          // never leak a database the builder opened
    throw e;
  }
}

/** A final invoice whose linked Xero draft was verified DELETED (the AC-14C-A path). */
export const deletedReissueScenario = (target: ScenarioTarget | (Db & { url?: string }), opts?: ScenarioOptions) =>
  buildReissueScenario(target, 'DELETED', opts);

/** A final invoice whose linked Xero draft was verified VOIDED (the AC-14B path). */
export const voidedReissueScenario = (target: ScenarioTarget | (Db & { url?: string }), opts?: ScenarioOptions) =>
  buildReissueScenario(target, 'VOIDED', opts);

/** A live final invoice with its verified draft: nothing is voided, so no reissue is allowed. */
export const approvedReissueScenario = (target: ScenarioTarget | (Db & { url?: string }), opts?: ScenarioOptions) =>
  buildReissueScenario(target, 'APPROVED', opts);

/** The database handle, the built rows, the readers and the two facility calls - thin by design. */
function scenario(db: Db & { url?: string }, family: ScenarioFamily, project: string, invoice: ScenarioInvoice, owned: boolean): ReissueScenario {
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p))[0]!;
  const many = (sql: string, p: unknown[] = []) => db.query(sql, p);
  const call = async (sql: string, p: unknown[]): Promise<Outcome> => (await db.query<{ r: Outcome }>(sql, p))[0]!.r;
  return {
    db, family, project, invoice,
    close: async () => { if (owned) await db.close(); },
    state: () => one(`select id::text, invoice_number, status, sync_status, voided_reason, record_version, approval_id::text approval_id
                        from invoices where id = $1`, [invoice.id]),
    ledger: () => many(`select generation, status, outbox_idempotency_key key, xero_invoice_id, xero_invoice_number, tenant_id,
        opened_by, approval_id::text approval_id, superseded_reason
      from invoice_xero_draft_generations where invoice_id = $1 order by generation`, [invoice.id]),
    outbox: () => many(`select generation, status, idempotency_key, payload, next_attempt_at = 'infinity' as dead
      from outbox where aggregate_id = $1 and topic = 'xero.create_draft_invoice' order by generation`, [invoice.id]),
    link: async () => (await db.query<{ external_id: string }>(`select external_id from external_links
      where provider = 'XERO' and entity_type = 'invoice' and external_type = 'Invoice' and entity_id = $1`, [invoice.id]))[0]?.external_id ?? null,
    latestObservation: async () => (await many(`select verdict, settlement, tenant_id, xero_invoice_id, amount_paid, amount_credited, observed_at::text
      from xero_invoice_observations where invoice_id = $1 order by observed_at desc, id desc limit 1`, [invoice.id]))[0] ?? null,
    balance: () => one(`select outstanding::numeric(12,2)::text outstanding, is_overdue from v_invoice_balances where id = $1`, [invoice.id]),
    integrityFails: async () => (await db.query<{ v: string }>(`select check_key v from integrity_check() where status = 'FAIL'`)).map((r) => r.v),
    request: (by, reason = null) => call(`select ops_reissue_request($1, $2, $3) r`, [invoice.id, by, reason]),
    decide: (approval, by, note = null) => call(`select ops_reissue_decide($1, $2, $3) r`, [approval, by, note]),
  };
}

/** The fixtures the real 04 path needs: the two extra employees, the pinned tenant and the Airtable project links. */
async function fixtures(db: Db): Promise<void> {
  await db.query(`insert into employees (employee_code, full_name, email, role, is_active) values
      ($1, 'Ada Admin', 'ada.admin@roofops.test', 'ADMIN', true),
      ($2, 'Ivan Inactive', 'ivan.inactive@roofops.test', 'FINANCE', false)
    on conflict (employee_code) do nothing`, [ADMIN, INACTIVE]);
  await db.query(`update app_settings set value = $1 where key = 'xero.demo_tenant_id'`, [TENANT]);
  await db.exec(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
    select 'AIRTABLE', 'project', p.id, 'Record', 'rec' || substr(md5(p.project_number), 1, 14), now(), now() from projects p
    where not exists (select 1 from external_links l where l.provider = 'AIRTABLE' and l.entity_type = 'project'
                        and l.entity_id = p.id and l.external_type = 'Record')`);
}

/** Prepare and approve the project's final invoice exactly as n8n 04 does; the Xero write is queued, not claimed. */
async function buildFinal(db: Db, rows: InvoiceRows, project: string, xid: string): Promise<ScenarioInvoice> {
  const ev = (type: string, at: number) => ({ event_id: `EVT-REI-${next()}`, event_type: type, source: 'airtable', actor_id: APPROVER,
    occurred_at: new Date(Date.now() + at).toISOString(), payload: { project_number: project, airtable_record_id: recFor(project) } });
  const prepare = await rows.send(db, ev('invoice.prepare_requested', 0), 'n8n:test');
  invariant(prepare.outcome === 'PREVIEW_READY', `${project} did not reach PREVIEW_READY (${JSON.stringify(prepare)})`);
  const approved = await rows.send(db, ev('invoice.approved', 1000), 'n8n:test');
  invariant(approved.outcome === 'APPROVED', `${project} was not approved (${JSON.stringify(approved)})`);
  const job = required((await db.query<{ key: string; payload: Record<string, unknown>; approval_id: string }>(
    `select o.idempotency_key key, o.payload, i.approval_id::text approval_id from outbox o join invoices i on i.id = o.aggregate_id
      where o.aggregate_id = $1 and o.topic = 'xero.create_draft_invoice'`, [String(approved.invoice_id)]))[0],
    `${project} queued no draft write`);
  const built: ScenarioInvoice = { id: String(approved.invoice_id), number: String(approved.invoice_number), project, key: job.key,
    payload: job.payload, total: Number(job.payload.amount_inc_gst), xeroNumber: String(job.payload.xero_invoice_number), xid, approvalId: job.approval_id };
  // 05: claim the write and complete it with the read-back proofs of the draft in the bound tenant.
  const claimed = await db.query<{ r: { claimed?: boolean } }>(`select wf_claim_side_effect($1, $2, 120) r`, [built.key, 'n8n:05']);
  invariant(claimed[0]!.r.claimed === true, `${project}: the draft write was not claimed`);
  const done = await db.query<{ r: { status?: string } }>(`select wf_complete_side_effect($1, $2::jsonb) r`,
    [built.key, JSON.stringify(proof(built))]);
  invariant(done[0]!.r.status === 'RECORDED', `${project}: the draft completion was refused (${JSON.stringify(done[0]!.r)})`);
  return built;
}

/** What 05 sends after reading its draft back from Xero (tenant, number, totals, DRAFT), bound to the InvoiceID. */
const proof = (a: ScenarioInvoice) => ({ verified: true, tenant_id: TENANT, organisation_class: 'DEMO', invoice_id: a.xid,
  invoice_number: a.xeroNumber, reference: a.project, status: 'DRAFT', type: 'ACCREC', amount_paid: 0, sent_to_contact: false,
  contact_id: uuidFor(`contact:${String(a.payload.customer_id)}`), contact_number: a.payload.xero_contact_number, total: a.payload.amount_inc_gst,
  total_tax: a.payload.gst_amount, currency: 'AUD', line_amount_types: 'Inclusive', matching_invoices: 1 });

/** The invoice as Xero's GET /Invoices/{id} returns it in each state (the 07 settlement recorder's input). */
const doc = (a: ScenarioInvoice, status: 'VOIDED' | 'DELETED') => ({ InvoiceID: a.xid, Type: 'ACCREC', InvoiceNumber: a.xeroNumber,
  Reference: a.project, Status: status, CurrencyCode: 'AUD', LineAmountTypes: 'Inclusive', Date: '2026-10-06', DueDate: '2026-10-20',
  Total: a.total, AmountDue: status === 'DELETED' ? 0 : a.total, AmountPaid: 0, AmountCredited: 0, Payments: [] });

/** The real 07 path: one repair run records the verified read of the linked document; the invoice follows Xero. */
async function applyVoid(db: Db, a: ScenarioInvoice, settlement: 'VOIDED' | 'DELETED'): Promise<void> {
  const runKey = `REI-SCENARIO-${next()}`;
  await db.query(`insert into reconciliation_runs (run_key, trigger, mode, status) values ($1, 'test', 'repair', 'RUNNING')`, [runKey]);
  const [res] = await db.query<{ r: { ok?: boolean; applied?: number; detail?: string } }>(
    `select xero_record_settlement($1, $2::jsonb) r`,
    [runKey, JSON.stringify([{ invoice_id: a.xid, tenant_id: TENANT, http: 200, xero_invoice_number: a.xeroNumber, xero: doc(a, settlement) }])]);
  invariant(res!.r.ok === true && res!.r.applied === 1, `${a.number}: the verified ${settlement} read was not applied (${JSON.stringify(res!.r)})`);
  const [state] = await db.query<{ status: string; sync_status: string }>(`select status, sync_status from invoices where id = $1`, [a.id]);
  invariant(state!.status === 'VOIDED' && state!.sync_status === 'SYNCED',
    `${a.number}: expected VOIDED / SYNCED after the verified ${settlement} read, got ${state!.status} / ${state!.sync_status}`);
}
