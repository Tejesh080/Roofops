import type { Db } from '../db/db.js';
import { requireEnv } from '../config/env.js';

/**
 * The operator side of a queued reissue (AC-14C, audit P2-D3): read where an invoice's current Xero draft generation
 * stands, and ask [RoofOps] 08 in n8n to dispatch the proven generation >= 2 writes (the same path a first issue takes
 * through 04 -> 05). Read-only against Postgres; the database and 05 decide everything. Never prints the token.
 */
export interface ReissueStatus {
  invoice_id: string; invoice_number: string; status: string; sync_status: string;
  generation: number; ledger_status: string; xero_invoice_number: string | null; xero_invoice_id: string | null;
  outbox_status: string | null; attempts: number | null; dead: boolean | null; last_error: string | null;
  xero_link: string | null; open_exceptions: { error_class: string; error_message: string }[];
}

/** The invoice and its one current (non-superseded) generation, its write and the open exceptions naming it. */
export async function reissueStatus(db: Db, invoiceId: string): Promise<ReissueStatus | undefined> {
  const rows = await db.query<ReissueStatus>(`
    select i.id::text invoice_id, i.invoice_number, i.status, i.sync_status, g.generation, g.status ledger_status,
           g.xero_invoice_number, g.xero_invoice_id, o.status outbox_status, o.attempts, o.next_attempt_at = 'infinity' dead, o.last_error,
           (select l.external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id) xero_link,
           coalesce((select jsonb_agg(jsonb_build_object('error_class', e.error_class, 'error_message', e.error_message) order by e.created_at)
                       from workflow_exceptions e where e.business_reference = i.invoice_number and e.resolution_status = 'OPEN'), '[]'::jsonb) open_exceptions
      from invoices i
      join invoice_xero_draft_generations g on g.invoice_id = i.id and g.superseded_at is null
      left join outbox o on o.idempotency_key = g.outbox_idempotency_key
     where i.id = $1`, [invoiceId]);
  // The ledger allows one non-superseded generation per invoice; anything else is reported, never guessed between.
  if (rows.length > 1) throw new Error(`${rows[0]!.invoice_number} has ${String(rows.length)} current Xero draft generations; run npm run integrity:check`);
  return rows[0];
}

/** The one write a dispatch names: 08 and Postgres refuse anything without it and never list another write. */
export interface DispatchSelection { invoice_number: string; generation: number }

/**
 * POSTs [RoofOps] 08's operator webhook with REISSUE_DISPATCH_TOKEN (checked in Postgres against its SHA-256) and the
 * selection in the body.
 */
export function n8nReissueTrigger(fetchImpl: typeof fetch = fetch): (selection: DispatchSelection) => Promise<void> {
  return async (selection) => {
    const token = requireEnv('REISSUE_DISPATCH_TOKEN');
    const base = process.env.N8N_BASE_URL ?? 'https://tejesh08.app.n8n.cloud';
    const res = await fetchImpl(`${base}/webhook/roofops/reissue/dispatch`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-roofops-token': token },
      body: JSON.stringify({ invoice_number: selection.invoice_number, generation: selection.generation }) });
    if (!res.ok) throw new Error(`n8n did not accept the reissue dispatch trigger: HTTP ${res.status}`);
  };
}

export interface DispatchOptions { trigger: (selection: DispatchSelection) => Promise<void>; sleep?: (ms: number) => Promise<void>; polls?: number; intervalMs?: number }

/**
 * Dispatches exactly this invoice's current generation (the selection 08 and Postgres require; no other queued reissue
 * can be sent) and waits for its write to settle. Outcomes (the CLI's report, not a rule):
 *  REISSUE_CREATED   the current generation >= 2 is CREATED and the invoice SYNCED (before or after the trigger)
 *  NO_REISSUE_QUEUED the current generation is 1: there is nothing for 08 to dispatch (the trigger is not sent)
 *  REISSUE_NOT_CREATED the write settled without a draft (05 refused or failed it; see last_error / open_exceptions)
 *  STILL_PENDING     nothing settled in time: the token was refused, 08 is not published, or the write is not proven
 */
export async function dispatchReissue(db: Db, invoiceId: string, o: DispatchOptions): Promise<Record<string, unknown>> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const before = await reissueStatus(db, invoiceId);
  if (before === undefined) return { ok: false, code: 'NOT_FOUND', detail: 'no invoice with a Xero draft generation has that id' };
  const created = (s: ReissueStatus) => s.generation >= 2 && s.ledger_status === 'CREATED' && s.sync_status === 'SYNCED';
  if (before.generation < 2) return { ok: false, code: 'NO_REISSUE_QUEUED', detail: 'the current Xero draft generation is 1; decide a reissue first', ...before };
  if (created(before)) return { ok: true, code: 'REISSUE_CREATED', detail: 'the reissued draft already exists', ...before };

  await o.trigger({ invoice_number: before.invoice_number, generation: before.generation });
  let now = before;
  for (let i = 0; i < (o.polls ?? 90); i += 1) {
    await sleep(o.intervalMs ?? 2000);
    now = (await reissueStatus(db, invoiceId)) ?? now;
    if (now.outbox_status !== 'PENDING' && now.outbox_status !== 'DISPATCHING') break;
  }
  if (created(now)) return { ok: true, code: 'REISSUE_CREATED', detail: 'generation ' + String(now.generation) + ' was created in Xero and linked', ...now };
  if (now.outbox_status === 'PENDING' || now.outbox_status === 'DISPATCHING') {
    return { ok: false, code: 'STILL_PENDING', detail: 'nothing settled: the dispatch token was refused, [RoofOps] 08 is not published, or the write is not proven (see open_exceptions)', ...now };
  }
  return { ok: false, code: 'REISSUE_NOT_CREATED', detail: 'the write settled without a draft; see last_error and open_exceptions', ...now };
}
