import type { Db } from '../../src/db/db.js';

type Result = Record<string, unknown> & { outcome?: string };
const aud = (v: unknown) => `$${Number(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

/**
 * The Airtable Projects rows as n8n 04 leaves them (n8n/04-approved-project-to-xero-draft-invoice.sdk.ts): after each
 * Invoice Action it writes the outcome to the row's Invoice Preview (a preview starts with the marker Postgres returned),
 * reads the row back and reports the verified text (Record Preview Shown In Postgres). A decision carries the text the
 * row shows (Read Row Before Decide). Tests use it to send exactly what 04 sends.
 */
export class InvoiceRows {
  readonly text = new Map<string, string>();

  /** What the row's Invoice Preview shows now ('' if 04 never wrote it). */
  shown(rec: string) { return this.text.get(rec) ?? ''; }

  /** 04 after an action on `rec`. `writeFails`: the Airtable write never happened, so nothing changes or is reported. */
  async after(db: Db, rec: string, eventId: string, r: Result, writeFails = false) {
    if (writeFails) return;
    const p = (r.preview ?? {}) as Record<string, unknown>;
    const text = r.outcome === 'PREVIEW_READY' || r.outcome === 'ALREADY_PENDING'
      ? `${String(r.preview_marker)} - awaiting approval by a finance approver\nProject: ${String(p.project_number)}   Customer: ${String(p.customer_name)}\n`
        + `Amount: ${aud(p.amount_inc_gst)} inc GST  (GST ${aud(p.gst_amount)}, ex GST ${aud(p.amount_ex_gst)})\nTo create it, set Invoice Action = Approve Xero draft invoice.`
      : `${String(r.outcome)}: ${typeof r.message === 'string' ? r.message : (typeof r.approval_number === 'string' ? r.approval_number : '')}. Nothing was sent to Xero.`;
    this.text.set(rec, `${text}\n[event ${eventId}]`);
    await db.query(`select wf_invoice_preview_verified($1, $2, $3)`, [eventId, rec, this.text.get(rec)]);
  }

  /** Sends an Airtable invoice event as 04 does (a decision carries the row's text) and plays 04's write-back. */
  async send(db: Db, event: Record<string, unknown> & { event_id: string; event_type: string; payload: Record<string, unknown> }, worker: string, writeFails = false) {
    const rec = String(event.payload.airtable_record_id);
    const prepare = event.event_type === 'invoice.prepare_requested';
    const sent = prepare ? event : { ...event, payload: { ...event.payload, displayed_preview: this.shown(rec) } };
    const [row] = await db.query<{ r: Result }>(`select ${prepare ? 'wf_invoice_prepare' : 'wf_invoice_decide'}($1::jsonb, $2) as r`, [JSON.stringify(sent), worker]);
    await this.after(db, rec, event.event_id, row!.r, writeFails);
    return row!.r;
  }
}
