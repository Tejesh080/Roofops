'use client';

import Link from 'next/link';
import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Plus, Trash2 } from 'lucide-react';
import { bookInspection, convertLead, createLead, recordInspection, saveQuote, sendQuote, updateLead, type SalesActionState } from '@/app/(ops)/sales/actions';
import { useRequestKey, useSubmit } from '@/components/ui/useSubmit';
import type { CustomerEntry, Product, Quote } from '@/lib/sales';
import { JOB_KIND, LINE_KIND, MEASURE, ROOF_TYPE, SOURCE, quoteTotals } from '@/lib/sales';
import type { StaffMember } from '@/lib/ops';

const Result = ({ s }: { s: SalesActionState }) => (s.message
  ? s.ok ? <p className="resolve-done" role="status"><CheckCircle2 size={15} aria-hidden /> {s.message}</p> : <p className="form-error" role="alert">{s.message}</p>
  : null);
const Submit = ({ pending, label, busy }: { pending: boolean; label: string; busy: string }) => (
  <button className="btn btn-sm btn-primary" disabled={pending}>{pending ? <><Loader2 size={14} className="spin" aria-hidden /> {busy}</> : label}</button>
);
const money = (n: number) => n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });

/** Record a new enquiry (phone call, web form, referral). Look-alike customers are pointed out straight away. */
export function NewLeadForm() {
  const [state, action, pending] = useActionState<SalesActionState, FormData>(createLead, {});
  const submit = useSubmit(action, pending);
  const key = useRequestKey(state.ok, state.at);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state.ok) form.current?.reset(); }, [state.ok, state.at]);
  return (
    <form ref={form} onSubmit={submit} className="ops-form" aria-label="New enquiry">
      <input type="hidden" name="request_key" value={key} />
      <div className="ops-row">
        <label className="field"><span>Name</span><input name="contact_name" required minLength={2} maxLength={120} autoComplete="off" /></label>
        <label className="field"><span>Where it came from</span>
          <select name="source" defaultValue="PHONE">{Object.entries(SOURCE).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
      </div>
      <div className="ops-row">
        <label className="field"><span>Phone</span><input name="phone" inputMode="tel" maxLength={30} /></label>
        <label className="field"><span>Email</span><input name="email" type="email" maxLength={200} /></label>
      </div>
      <label className="field"><span>Address of the job (as they said it)</span><input name="address" maxLength={300} /></label>
      <label className="field"><span>What they need</span><textarea name="notes" rows={2} maxLength={4000} placeholder="e.g. Leak over the kitchen after the storm" /></label>
      <Result s={state} />
      {state.ok && state.lead_number && <p><Link className="btn btn-sm" href={`/sales/${state.lead_number}`}>Open {state.lead_number}</Link></p>}
      {state.ok && !!state.lookalikes?.length && (
        <p className="t-meta" role="note">Possibly an existing customer: {state.lookalikes.map((c) => `${c.display_name} (${c.customer_number}: ${c.reasons.join(', ')})`).join('; ')}. Check before adding a new one.</p>
      )}
      <Submit pending={pending} label="Record enquiry" busy="Recording…" />
    </form>
  );
}

/** Contacted; lost or not a job (with a reason). */
export function LeadActions({ lead, status, version }: { lead: string; status: string; version: number }) {
  const [state, action, pending] = useActionState<SalesActionState, FormData>(updateLead, {});
  const submit = useSubmit(action, pending);
  const [mode, setMode] = useState<'' | 'lost' | 'disqualify'>('');
  useEffect(() => { if (state.ok) setMode(''); }, [state.ok, state.at]);
  const open = status === 'NEW' || status === 'CONTACTED' || status === 'INSPECTION_BOOKED';
  if (!open) return state.ok ? <Result s={state} /> : null;
  return (
    <form onSubmit={submit} className="resolve-form" aria-label={`Update ${lead}`}>
      <input type="hidden" name="lead" value={lead} />
      <input type="hidden" name="version" value={version} />
      {mode && <label className="field"><span>Why (required)</span><textarea name="reason" rows={1} required minLength={5} maxLength={2000}
        placeholder={mode === 'lost' ? 'e.g. Went with another roofer' : 'e.g. Wanted gutter cleaning only'} /></label>}
      <Result s={state} />
      <div className="form-buttons">
        {!mode && status === 'NEW' && <button className="btn btn-sm" name="action" value="contacted" disabled={pending}>Mark contacted</button>}
        {!mode && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMode('lost')}>Lost…</button>}
        {!mode && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMode('disqualify')}>Not a job…</button>}
        {mode && <button className="btn btn-sm btn-primary" name="action" value={mode} disabled={pending}>{mode === 'lost' ? 'Mark lost' : 'Mark not a job'}</button>}
        {mode && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMode('')}>Back</button>}
      </div>
    </form>
  );
}

/** The customer (existing, or new) and the site of the job. A look-alike new customer is refused until confirmed. */
export function ConvertForm({ lead, version, contact, phone, email, customers }: { lead: string; version: number; contact: string; phone: string | null; email: string | null; customers: CustomerEntry[] }) {
  const [state, action, pending] = useActionState<SalesActionState, FormData>(convertLead, {});
  const submit = useSubmit(action, pending);
  const [existing, setExisting] = useState('');
  return (
    <form onSubmit={submit} className="ops-form" aria-label={`Customer and site for ${lead}`}>
      <input type="hidden" name="lead" value={lead} />
      <input type="hidden" name="version" value={version} />
      <label className="field"><span>Existing customer (leave empty for a new one)</span>
        <select name="customer_number" value={existing} onChange={(e) => setExisting(e.target.value)}>
          <option value="">New customer</option>
          {customers.map((c) => <option key={c.customer_number} value={c.customer_number}>{c.display_name} · {c.customer_number}{c.phone ? ` · ${c.phone}` : ''}</option>)}
        </select></label>
      {!existing && (
        <>
          <div className="ops-row">
            <label className="field"><span>Customer name</span><input name="display_name" defaultValue={contact} maxLength={120} /></label>
            <label className="field"><span>Kind</span><select name="customer_type" defaultValue="RESIDENTIAL">
              <option value="RESIDENTIAL">Residential</option><option value="COMMERCIAL">Commercial</option><option value="BUILDER">Builder</option><option value="STRATA">Strata</option></select></label>
          </div>
          <div className="ops-row">
            <label className="field"><span>Phone</span><input name="c_phone" defaultValue={phone ?? ''} maxLength={30} /></label>
            <label className="field"><span>Email</span><input name="c_email" type="email" defaultValue={email ?? ''} maxLength={200} /></label>
          </div>
        </>
      )}
      <fieldset className="crew-pick"><legend>Site of the job</legend>
        <label className="field"><span>Street address</span><input name="address_line1" required maxLength={200} placeholder="e.g. 7 Wattle Court" /></label>
        <div className="ops-row">
          <label className="field"><span>Suburb</span><input name="suburb" required maxLength={80} /></label>
          <label className="field"><span>Postcode</span><input name="postcode" required inputMode="numeric" pattern="[0-9]{4}" maxLength={4} /></label>
        </div>
        <div className="ops-row">
          <label className="field"><span>State</span><select name="state" defaultValue="QLD">{['QLD', 'NSW', 'VIC', 'TAS', 'SA', 'WA', 'NT', 'ACT'].map((s) => <option key={s}>{s}</option>)}</select></label>
          <label className="field"><span>Building</span><select name="property_type" defaultValue="DETACHED_HOUSE">
            <option value="DETACHED_HOUSE">House</option><option value="TOWNHOUSE">Townhouse</option><option value="SMALL_COMMERCIAL">Small commercial</option>
            <option value="INDUSTRIAL">Industrial</option><option value="STRATA_COMPLEX">Strata complex</option></select></label>
        </div>
        <div className="ops-row">
          <label className="field"><span>Storeys</span><input name="storeys" type="number" min={1} max={6} defaultValue={1} /></label>
          <label className="field"><span>Access notes (optional)</span><input name="access_notes" maxLength={500} placeholder="e.g. Side gate, dog in yard" /></label>
        </div>
      </fieldset>
      <Result s={state} />
      {!!state.lookalikes?.length && (
        <div className="reissue-wait" role="note">
          <p>Already in RoofOps: {state.lookalikes.map((c) => (
            <button type="button" key={c.customer_number} className="btn btn-sm" onClick={() => setExisting(c.customer_number)}>Use {c.display_name} ({c.customer_number})</button>))}</p>
          <label className="check-line"><input type="checkbox" name="confirm_new" /> This is a different person: add a new customer (the pair is listed for review)</label>
        </div>
      )}
      <Submit pending={pending} label="Save customer and site" busy="Saving…" />
    </form>
  );
}

/** Who inspects and when (an estimator or a manager). */
export function BookInspectionForm({ lead, staff, today }: { lead: string; staff: StaffMember[]; today: string }) {
  const [state, action, pending] = useActionState<SalesActionState, FormData>(bookInspection, {});
  const submit = useSubmit(action, pending);
  const key = useRequestKey(state.ok, state.at);
  const inspectors = staff.filter((s) => ['ESTIMATOR', 'PROJECT_MANAGER', 'OPERATIONS_MANAGER', 'ADMIN'].includes(s.role));
  return (
    <form onSubmit={submit} className="ops-form" aria-label={`Book the inspection for ${lead}`}>
      <input type="hidden" name="lead" value={lead} />
      <input type="hidden" name="request_key" value={key} />
      <div className="ops-row">
        <label className="field"><span>Inspector</span><select name="inspector" required defaultValue="">
          <option value="" disabled>Pick someone</option>{inspectors.map((s) => <option key={s.employee_code} value={s.employee_code}>{s.full_name}</option>)}</select></label>
        <label className="field"><span>When</span><input type="datetime-local" name="when" required defaultValue={`${today}T09:00`} /></label>
      </div>
      <Result s={state} />
      <Submit pending={pending} label="Book inspection" busy="Booking…" />
    </form>
  );
}

/** What the inspection found: roof type, area (and how it was measured), pitch, findings; or cancel it. */
export function RecordInspectionForm({ inspection, version }: { inspection: string; version: number }) {
  const [state, action, pending] = useActionState<SalesActionState, FormData>(recordInspection, {});
  const submit = useSubmit(action, pending);
  const [cancel, setCancel] = useState(false);
  return (
    <form onSubmit={submit} className="ops-form" aria-label={`Record ${inspection}`}>
      <input type="hidden" name="inspection" value={inspection} />
      <input type="hidden" name="version" value={version} />
      {!cancel && (
        <>
          <div className="ops-row">
            <label className="field"><span>Roof type</span><select name="roof_type" required defaultValue="">
              <option value="" disabled>Pick one</option>{Object.entries(ROOF_TYPE).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
            <label className="field"><span>Roof area m² (optional)</span><input name="roof_area_sqm" type="number" min={0.1} step={0.1} /></label>
          </div>
          <div className="ops-row">
            <label className="field"><span>Measured by (needed with an area)</span><select name="measurement_method" defaultValue="">
              <option value="">—</option>{Object.entries(MEASURE).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
            <label className="field"><span>Pitch ° (optional)</span><input name="pitch_degrees" type="number" min={0} max={75} step={0.5} /></label>
          </div>
        </>
      )}
      <label className="field"><span>{cancel ? 'Why it is cancelled (required)' : 'What you found'}</span><textarea name="findings" rows={2} required minLength={5} maxLength={4000} /></label>
      <Result s={state} />
      <div className="form-buttons">
        <button className="btn btn-sm btn-primary" name="action" value={cancel ? 'cancel' : 'complete'} disabled={pending}>{cancel ? 'Cancel inspection' : 'Save findings'}</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCancel(!cancel)}>{cancel ? 'Back' : 'Cancel inspection…'}</button>
      </div>
    </form>
  );
}

interface Line { line_kind: string; product_code: string; description: string; quantity: string; unit: string; unit_price: string }
const blank = (): Line => ({ line_kind: 'LABOUR', product_code: '', description: '', quantity: '1', unit: 'hrs', unit_price: '' });

/** The quote: kind of job, GST basis, scope and lines, with the total worked out as you type. Saving a sent or drafted quote makes a new version. */
export function QuoteBuilder({ lead, quote, products }: { lead: string; quote: Quote | null; products: Product[] }) {
  const [state, action, pending] = useActionState<SalesActionState, FormData>(saveQuote, {});
  const submit = useSubmit(action, pending);
  const key = useRequestKey(state.ok, state.at);
  const [lines, setLines] = useState<Line[]>(() => quote?.lines.length
    ? quote.lines.map((l) => ({ line_kind: l.line_kind, product_code: l.product_code ?? '', description: l.description, quantity: String(Number(l.quantity)), unit: l.unit, unit_price: String(Number(l.unit_price)) }))
    : [blank()]);
  const [amountType, setAmountType] = useState<'INCLUSIVE' | 'EXCLUSIVE'>(quote?.line_amount_type === 'EXCLUSIVE' ? 'EXCLUSIVE' : 'INCLUSIVE');
  const totals = useMemo(() => quoteTotals(lines.map((l) => ({ quantity: Number(l.quantity) || 0, unit_price: Number(l.unit_price) || 0 })), amountType), [lines, amountType]);
  const set = (i: number, k: keyof Line, v: string) => setLines((ls) => ls.map((l, j) => {
    if (j !== i) return l;
    const next = { ...l, [k]: v };
    if (k === 'product_code') { const p = products.find((x) => x.product_code === v); if (p) { next.unit = p.unit; if (!l.description) next.description = p.name; } }
    return next;
  }));
  return (
    <form onSubmit={submit} className="ops-form" aria-label={quote ? `Revise ${quote.quote_number}` : `Quote for ${lead}`}>
      <input type="hidden" name="lead" value={lead} />
      <input type="hidden" name="quote" value={quote?.quote_number ?? ''} />
      <input type="hidden" name="version" value={quote?.record_version ?? ''} />
      <input type="hidden" name="request_key" value={key} />
      <input type="hidden" name="lines" value={JSON.stringify(lines.map((l) => ({ ...l, product_code: l.line_kind === 'MATERIAL' ? l.product_code : '' })))} />
      <div className="ops-row">
        <label className="field"><span>Kind of job</span><select name="job_type" defaultValue={quote?.job_type ?? 'LEAK_REPAIR'}>
          {Object.entries(JOB_KIND).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
        <label className="field"><span>Prices</span><select name="amount_type" value={amountType} onChange={(e) => setAmountType(e.target.value as 'INCLUSIVE' | 'EXCLUSIVE')}>
          <option value="INCLUSIVE">include GST</option><option value="EXCLUSIVE">exclude GST (10% added)</option></select></label>
      </div>
      <label className="field"><span>Scope (what the customer gets)</span><textarea name="scope" rows={2} maxLength={4000} defaultValue={quote?.scope_summary ?? ''} /></label>
      <div className="quote-lines" role="table" aria-label="Quote lines">
        {lines.map((l, i) => (
          <div className="quote-line" role="row" key={i}>
            <label className="field"><span>Kind</span><select aria-label={`Line ${i + 1} kind`} value={l.line_kind} onChange={(e) => set(i, 'line_kind', e.target.value)}>
              {Object.entries(LINE_KIND).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
            {l.line_kind === 'MATERIAL' && <label className="field"><span>Product</span><select aria-label={`Line ${i + 1} product`} value={l.product_code} onChange={(e) => set(i, 'product_code', e.target.value)}>
              <option value="">Pick a product</option>{products.map((p) => <option key={p.product_code} value={p.product_code}>{p.name} ({p.unit})</option>)}</select></label>}
            <label className="field grow"><span>Description</span><input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => set(i, 'description', e.target.value)} maxLength={500} /></label>
            <label className="field"><span>Qty</span><input aria-label={`Line ${i + 1} quantity`} type="number" min={0.001} step="any" value={l.quantity} onChange={(e) => set(i, 'quantity', e.target.value)} /></label>
            <label className="field"><span>Unit</span><input aria-label={`Line ${i + 1} unit`} value={l.unit} onChange={(e) => set(i, 'unit', e.target.value)} maxLength={20} /></label>
            <label className="field"><span>Price</span><input aria-label={`Line ${i + 1} price`} type="number" min={0} step="0.01" value={l.unit_price} onChange={(e) => set(i, 'unit_price', e.target.value)} /></label>
            <span className="num line-amount">{money(Math.round((Number(l.quantity) || 0) * (Number(l.unit_price) || 0) * 100) / 100)}</span>
            <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} disabled={lines.length === 1}><Trash2 size={14} aria-hidden /></button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-sm" onClick={() => setLines((ls) => [...ls, blank()])} disabled={lines.length >= 50}><Plus size={14} aria-hidden /> Add line</button>
      <p className="quote-totals num" aria-live="polite">Ex GST {money(totals.subtotal)} · GST {money(totals.gst)} · <strong>Total {money(totals.total)}</strong></p>
      <Result s={state} />
      <Submit pending={pending} label={quote ? `Save as version ${quote.version_number + 1}` : 'Save draft quote'} busy="Saving…" />
    </form>
  );
}

/** Send a draft: the person ticks that they checked it. Sending hands it to Airtable for the office. */
export function SendQuoteForm({ quote, version, total }: { quote: string; version: number; total: number }) {
  const [state, action, pending] = useActionState<SalesActionState, FormData>(sendQuote, {});
  const submit = useSubmit(action, pending);
  if (state.ok) return <Result s={state} />;
  return (
    <form onSubmit={submit} className="resolve-form" aria-label={`Send ${quote}`}>
      <input type="hidden" name="quote" value={quote} />
      <input type="hidden" name="version" value={version} />
      <label className="check-line"><input type="checkbox" name="checked" /> I checked the customer, site, lines and the total of {money(total)}</label>
      <Result s={state} />
      <Submit pending={pending} label={`Send ${quote}`} busy="Sending…" />
    </form>
  );
}
