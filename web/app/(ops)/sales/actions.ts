'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/session';
import { query } from '@/lib/db';
import { salesMissing, salesRefusal } from '@/lib/sales';

export interface SalesActionState {
  ok?: boolean; message?: string; at?: number; lead_number?: string; quote_number?: string;
  lookalikes?: { customer_number: string; display_name: string; reasons: string[] }[];
  similar_enquiries?: { lead_number: string; contact_name: string; status: string; received: string; reasons: string[] }[];
}
type Outcome = Record<string, unknown> & { ok: boolean; code?: string; detail?: string; duplicate?: boolean };

/** One web_lead_* / web_inspection_* / web_quote_* call as the signed-in employee; the database holds every rule. */
async function asStaff(sql: string, args: unknown[]): Promise<Outcome | { signedOut: true }> {
  const s = await verifySession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!s?.t) return { signedOut: true };
  const [row] = await query<{ r: Outcome }>(sql, [s.t, ...args]);
  return row!.r;
}
const SIGNED_OUT = 'Sign in as yourself to do this (the shared demo login can only look).';
function failed(e: unknown): SalesActionState {
  console.error('sales action failed:', (e as Error)?.message ?? e);   // server log only: the person sees a safe message
  if (salesMissing(e)) return { message: 'Enquiries and quotes are not available on this server yet.' };
  revalidatePath('/', 'layout');
  return { message: 'Could not confirm the result (the database did not answer). Reload and check before trying again; a repeat of the same form is never done twice.' };
}
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const version = (f: FormData) => { const n = Number(str(f, 'version')); return Number.isInteger(n) && n > 0 ? n : null; };
const done = (r: Outcome, message: string, extra: Partial<SalesActionState> = {}): SalesActionState => {
  revalidatePath('/', 'layout');
  return { ok: true, at: Date.now(), message, ...extra };
};
async function run(sql: string, args: unknown[], ok: (r: Outcome) => SalesActionState): Promise<SalesActionState> {
  try {
    const r = await asStaff(sql, args);
    if ('signedOut' in r) return { message: SIGNED_OUT };
    if (!r.ok) return { message: salesRefusal(r), lookalikes: (r.lookalikes as SalesActionState['lookalikes']) ?? undefined,
                        similar_enquiries: (r.similar_enquiries as SalesActionState['similar_enquiries']) ?? undefined };
    return ok(r);
  } catch (e) {
    return failed(e);
  }
}

export async function createLead(_p: SalesActionState, f: FormData): Promise<SalesActionState> {
  if (str(f, 'contact_name').length < 2) return { message: 'Enter the person’s name.' };
  if (!str(f, 'phone') && !str(f, 'email')) return { message: 'Enter a phone number or an email address.' };
  return run('select web_lead_create($1, $2, $3, $4, $5, $6, $7, $8, $9) r',
    [str(f, 'contact_name'), str(f, 'phone') || null, str(f, 'email') || null, str(f, 'address') || null, str(f, 'source'), str(f, 'notes') || null, str(f, 'request_key'),
      f.get('confirm_separate') === 'on'],
    (r) => done(r, r.duplicate ? `${String(r.lead_number)} was already recorded (nothing added twice).` : `${String(r.lead_number)} recorded.`,
      { lead_number: String(r.lead_number), lookalikes: (r.lookalikes as SalesActionState['lookalikes']) ?? [] }));
}

export async function updateLead(_p: SalesActionState, f: FormData): Promise<SalesActionState> {
  const action = str(f, 'action'); const v = version(f);
  if (!v) return { message: 'Reload the page and try again.' };
  if ((action === 'lost' || action === 'disqualify') && str(f, 'reason').length < 5) return { message: 'Say why (a few words).' };
  return run('select web_lead_update($1, $2, $3, $4, $5) r', [str(f, 'lead'), action, v, str(f, 'reason') || null],
    (r) => done(r, `${String(r.lead_number)} is now ${String(r.status).toLowerCase().replace('_', ' ')}.`));
}

export async function convertLead(_p: SalesActionState, f: FormData): Promise<SalesActionState> {
  const v = version(f);
  if (!v) return { message: 'Reload the page and try again.' };
  const existing = str(f, 'customer_number');
  const customer = { display_name: str(f, 'display_name'), customer_type: str(f, 'customer_type') || 'RESIDENTIAL', email: str(f, 'c_email'), phone: str(f, 'c_phone') };
  const property = { address_line1: str(f, 'address_line1'), address_line2: str(f, 'address_line2'), suburb: str(f, 'suburb'), state: str(f, 'state'),
    postcode: str(f, 'postcode'), property_type: str(f, 'property_type') || 'DETACHED_HOUSE', storeys: str(f, 'storeys') || '1', access_notes: str(f, 'access_notes') };
  if (!existing && customer.display_name.length < 2) return { message: 'Pick an existing customer, or enter the new customer’s name.' };
  if (!/^\d{4}$/.test(property.postcode)) return { message: 'The postcode has 4 digits.' };
  return run('select web_lead_convert($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) r',
    [str(f, 'lead'), v, existing || null, JSON.stringify(customer), JSON.stringify(property), f.get('confirm_new') === 'on'],
    (r) => done(r, `${r.new_customer ? 'New customer' : 'Customer'} ${String(r.customer_number)} at ${String(r.property_number)}.`));
}

/** "YYYY-MM-DDTHH:MM" from a datetime-local field is Brisbane time (UTC+10, no daylight saving). */
const brisbane = (v: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v}:00+10:00` : null);

export async function bookInspection(_p: SalesActionState, f: FormData): Promise<SalesActionState> {
  const when = brisbane(str(f, 'when'));
  if (!when) return { message: 'Pick the day and time.' };
  if (!str(f, 'inspector')) return { message: 'Pick who inspects.' };
  return run('select web_inspection_book($1, $2, $3, $4::timestamptz, $5) r', [str(f, 'lead'), str(f, 'inspector'), when, str(f, 'request_key')],
    (r) => done(r, r.duplicate ? `${String(r.inspection_number)} was already booked.` : `${String(r.inspection_number)} booked.`));
}

export async function recordInspection(_p: SalesActionState, f: FormData): Promise<SalesActionState> {
  const v = version(f); const action = str(f, 'action') || 'complete';
  if (!v) return { message: 'Reload the page and try again.' };
  if (str(f, 'findings').length < 5) return { message: action === 'cancel' ? 'Say why it is cancelled (a few words).' : 'Write what you found (a few words at least).' };
  const findings = { roof_type: str(f, 'roof_type'), roof_area_sqm: str(f, 'roof_area_sqm'), pitch_degrees: str(f, 'pitch_degrees'),
    measurement_method: str(f, 'measurement_method'), findings: str(f, 'findings') };
  return run('select web_inspection_record($1, $2, $3, $4, $5::jsonb) r', [str(f, 'inspection'), v, action, JSON.stringify(findings)],
    (r) => done(r, `${String(r.inspection_number)} ${action === 'cancel' ? 'cancelled' : 'recorded'}.`));
}

export async function saveQuote(_p: SalesActionState, f: FormData): Promise<SalesActionState> {
  let lines: unknown;
  try { lines = JSON.parse(str(f, 'lines') || '[]'); } catch { return { message: 'The lines could not be read; reload the page.' }; }
  if (!Array.isArray(lines) || lines.length === 0) return { message: 'Add at least one line.' };
  const quote = str(f, 'quote');
  return run('select web_quote_save($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) r',
    [str(f, 'lead') || null, quote || null, quote ? version(f) : null, str(f, 'job_type'), str(f, 'amount_type'), str(f, 'scope') || null, JSON.stringify(lines), str(f, 'request_key')],
    (r) => done(r, r.duplicate ? `${String(r.quote_number)} was already saved (nothing added twice).`
      : `${String(r.quote_number)} version ${String(r.version)} saved: $${Number(r.total_inc_gst).toFixed(2)} inc GST.`, { quote_number: String(r.quote_number) }));
}

export async function sendQuote(_p: SalesActionState, f: FormData): Promise<SalesActionState> {
  const v = version(f);
  if (!v) return { message: 'Reload the page and try again.' };
  if (f.get('checked') !== 'on') return { message: 'Tick that you checked the customer, site, lines and total before sending.' };
  return run('select web_quote_send($1, $2, $3) r', [str(f, 'quote'), v],
    (r) => done(r, r.duplicate ? `${String(r.quote_number)} was already sent.` : `${String(r.quote_number)} sent, valid until ${String(r.valid_until)}. RoofOps adds it to Airtable for the office.`));
}

/** Correct a customer's phone or email (a typo, a new number). Invoices and documents already made keep what they had. */
export async function correctCustomerContact(_p: SalesActionState, f: FormData): Promise<SalesActionState> {
  const v = version(f);
  if (!v) return { message: 'Reload the page and try again.' };
  if (str(f, 'reason').length < 5) return { message: 'Say why (a few words), for the record.' };
  return run('select web_customer_correct_contact($1, $2, $3, $4, $5, $6) r', [str(f, 'customer'), v, str(f, 'phone') || null, str(f, 'email') || null, str(f, 'reason')],
    (r) => done(r, r.unchanged ? 'Nothing changed: those are already the details.' : `${String(r.customer_number)} corrected. Airtable shows it after the next check; update the Xero contact by hand if needed.`));
}
