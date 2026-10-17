/**
 * Enquiries, inspections and quotes (SALES-01): read models (v_dashboard_leads, v_dashboard_quotes, v_dashboard_products,
 * v_dashboard_customer_directory) and the words staff see. Pure: the caller supplies `query`. Writes go through the
 * web_lead_* / web_inspection_* / web_quote_* functions (app/(ops)/sales/actions.ts), which hold every rule.
 */
import type { Query } from './queries.ts';

export type LeadStatus = 'NEW' | 'CONTACTED' | 'INSPECTION_BOOKED' | 'QUOTED' | 'WON' | 'LOST' | 'DISQUALIFIED';
export interface InspectionSummary {
  inspection_number: string; status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED'; inspector: string | null; scheduled_for: string | null; inspected_on: string | null;
  roof_type: string | null; roof_area_sqm: number | null; pitch_degrees: number | null; measurement_method: string | null; findings: string | null; record_version: number;
}
export interface Lead {
  lead_number: string; status: LeadStatus; source: string; contact_name: string; phone: string | null; email: string | null; property_address_text: string | null;
  notes: string | null; lost_reason: string | null; received_at: string; contacted_at: string | null; record_version: number;
  customer_number: string | null; customer_name: string | null; property_number: string | null; site: string | null; created_by_name: string | null;
  inspections: InspectionSummary[]; quotes: { quote_number: string; status: string; record_version: number }[]; project_number: string | null;
}
export interface QuoteLine { line_no: number; line_kind: string; product_code: string | null; description: string; quantity: number; unit: string; unit_price: number; line_amount: number }
export interface Quote {
  quote_number: string; status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'LOST' | 'EXPIRED'; job_type: string; created_on: string; sent_on: string | null; valid_until: string | null;
  accepted_on: string | null; lost_reason: string | null; record_version: number; lead_number: string | null; customer_number: string; customer_name: string;
  property_number: string; site: string; estimator: string | null; version_number: number; line_amount_type: 'INCLUSIVE' | 'EXCLUSIVE' | 'NO_TAX';
  subtotal_ex_gst: number; gst_amount: number; total_inc_gst: number; scope_summary: string | null; lines: QuoteLine[];
  airtable_handoff: string | null; airtable_handoff_error: string | null; in_airtable: boolean; project_number: string | null;
}
export interface Product { product_code: string; name: string; category: string | null; unit: string }
export interface CustomerEntry { customer_number: string; display_name: string; customer_type: string; email: string | null; phone: string | null; record_version: number }

const LEAD_COLUMNS = `lead_number, status, source, contact_name, phone, email, property_address_text, notes, lost_reason,
  to_char(received_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI') received_at,
  to_char(contacted_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI') contacted_at, record_version::int,
  customer_number, customer_name, property_number, site, created_by_name, inspections, quotes, project_number`;
const QUOTE_COLUMNS = `quote_number, status, job_type, created_on::text, sent_on::text, valid_until::text, accepted_on::text, lost_reason, record_version::int,
  lead_number, customer_number, customer_name, property_number, site, estimator, version_number::int, line_amount_type,
  subtotal_ex_gst::float8 subtotal_ex_gst, gst_amount::float8 gst_amount, total_inc_gst::float8 total_inc_gst, scope_summary, lines,
  airtable_handoff, airtable_handoff_error, in_airtable, project_number`;

export const LEAD_NUMBER = /^LEAD-\d{4}-\d{4}$/;
export const listLeads = (q: Query) => q<Lead>(`select ${LEAD_COLUMNS} from v_dashboard_leads order by (status in ('LOST','DISQUALIFIED','WON')), received_at desc`);
export async function getLead(q: Query, n: string): Promise<Lead | null> {
  if (!LEAD_NUMBER.test(n)) return null;
  return (await q<Lead>(`select ${LEAD_COLUMNS} from v_dashboard_leads where lead_number = $1`, [n]))[0] ?? null;
}
export const getQuotesForLead = (q: Query, n: string) => q<Quote>(`select ${QUOTE_COLUMNS} from v_dashboard_quotes where lead_number = $1 order by created_on, quote_number`, [n]);
export const getProducts = (q: Query) => q<Product>('select product_code, name, category, unit from v_dashboard_products order by name');
export const getCustomerDirectory = (q: Query) => q<CustomerEntry>('select customer_number, display_name, customer_type, email, phone, record_version::int from v_dashboard_customer_directory order by display_name');

export const salesMissing = (e: unknown) => /v_dashboard_(leads|quotes|products|customer_directory)|web_(lead|inspection|quote)_/.test(String((e as Error)?.message ?? e)) && /does not exist/.test(String((e as Error)?.message ?? e));

type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';
export const LEAD_STATUS: Record<LeadStatus, { text: string; tone: Tone }> = {
  NEW: { text: 'New', tone: 'warn' }, CONTACTED: { text: 'Contacted', tone: 'info' }, INSPECTION_BOOKED: { text: 'Inspection booked', tone: 'info' },
  QUOTED: { text: 'Quoted', tone: 'info' }, WON: { text: 'Won', tone: 'good' }, LOST: { text: 'Lost', tone: 'neutral' }, DISQUALIFIED: { text: 'Not a job', tone: 'neutral' },
};
export const QUOTE_STATUS: Record<Quote['status'], { text: string; tone: Tone }> = {
  DRAFT: { text: 'Draft', tone: 'warn' }, SENT: { text: 'Sent', tone: 'info' }, ACCEPTED: { text: 'Accepted', tone: 'good' },
  LOST: { text: 'Lost', tone: 'neutral' }, EXPIRED: { text: 'Expired', tone: 'neutral' },
};
export const SOURCE: Record<string, string> = {
  PHONE: 'Phone call', WEBSITE_FORM: 'Website form', REFERRAL: 'Referral', REPEAT_CUSTOMER: 'Repeat customer', BUILDER_REFERRAL: 'Builder referral',
  GOOGLE_ADS: 'Google Ads', ORGANIC_SEARCH: 'Search', FACEBOOK: 'Facebook', LOCAL_SIGNAGE: 'Signage', OTHER: 'Other',
};
export const JOB_KIND: Record<string, string> = {
  LEAK_REPAIR: 'Leak repair', ROOF_RESTORATION: 'Roof restoration', ROOF_REPLACEMENT: 'Roof replacement', FULL_REROOF: 'Full re-roof',
  EXTENSION_ROOF: 'Extension roof', STORM_DAMAGE_REPAIR: 'Storm damage repair',
};
export const ROOF_TYPE: Record<string, string> = { TILE: 'Concrete tile', TERRACOTTA_TILE: 'Terracotta tile', METAL: 'Metal', COLORBOND: 'Colorbond', ZINCALUME: 'Zincalume', OTHER: 'Other' };
export const MEASURE: Record<string, string> = { TAPE: 'Tape measure', DRONE: 'Drone', AERIAL_IMAGERY: 'Aerial imagery', PLAN_TAKEOFF: 'Plan take-off' };
export const LINE_KIND: Record<string, string> = { LABOUR: 'Labour', MATERIAL: 'Material', EQUIPMENT: 'Equipment', OTHER: 'Other' };

export const SALES_CODE: Record<string, string> = {
  SIGNED_OUT: 'Your sign-in has ended. Sign in again as yourself.',
  ACTOR_UNAUTHORIZED: 'Your role cannot do this.',
  NOT_FOUND: 'That record does not exist (any more).',
  STALE: 'Someone changed this since you opened the page. Reload and check it again.',
  INVALID: 'Check the form.',
  INVALID_TRANSITION: 'That is not possible in its current state.',
  REASON_REQUIRED: 'A short reason is needed.',
  POSSIBLE_DUPLICATE: 'This looks like a customer we already have.',
  POSSIBLE_DUPLICATE_ENQUIRY: 'This person already has an open enquiry.',
  NOT_CONVERTED: 'Record the customer and the site first.',
  ALREADY_BOOKED: 'An inspection is already booked.',
  INSPECTOR_UNKNOWN: 'That person cannot inspect.',
  INSPECTOR_BUSY: 'The inspector is busy then.',
  IN_PAST: 'That time is in the past.',
  ALREADY_QUOTED: 'This enquiry already has an open quote.',
};
export const salesRefusal = (r: { code?: string; detail?: string }) =>
  r.code && SALES_CODE[r.code] ? `${SALES_CODE[r.code]}${r.detail && r.code !== 'SIGNED_OUT' ? ` (${r.detail})` : ''}` : (r.detail ?? 'Not done.');

/** GST on a set of lines, the way quote_versions derives it (10%; inclusive prices carry 1/11 GST). For the live preview only. */
export function quoteTotals(lines: { quantity: number; unit_price: number }[], amountType: 'INCLUSIVE' | 'EXCLUSIVE') {
  const sum = Math.round(lines.reduce((s, l) => s + Math.round(l.quantity * l.unit_price * 100) / 100, 0) * 100) / 100;
  if (amountType === 'INCLUSIVE') { const gst = Math.round(sum * 0.1 / 1.1 * 100) / 100; return { subtotal: Math.round((sum - gst) * 100) / 100, gst, total: sum }; }
  const gst = Math.round(sum * 0.1 * 100) / 100;
  return { subtotal: sum, gst, total: Math.round((sum + gst) * 100) / 100 };
}

/** Where an enquiry stands and the one thing to do next (the page leads with it). */
export function leadNextStep(l: Lead, quotes: Quote[]): { title: string; detail: string } {
  const open = quotes.find((q) => q.status === 'DRAFT' || q.status === 'SENT');
  const booked = l.inspections.find((i) => i.status === 'SCHEDULED');
  const inspected = l.inspections.find((i) => i.status === 'COMPLETED');
  if (l.status === 'LOST' || l.status === 'DISQUALIFIED') return { title: 'Closed', detail: l.lost_reason ?? '' };
  if (l.project_number) return { title: `Won: project ${l.project_number}`, detail: 'The job continues on its project page.' };
  if (!l.customer_number) return { title: 'Record the customer and the site', detail: 'Step 2 below: pick the existing customer or add a new one, and the address of the job.' };
  if (open?.status === 'SENT') {
    return open.in_airtable
      ? { title: `Waiting for the customer to accept ${open.quote_number}`, detail: 'When they accept, set the quote’s Status to Accepted in Airtable: RoofOps then creates the project.' }
      : open.airtable_handoff === 'STOPPED'
        ? { title: `${open.quote_number} sent, but not added to Airtable`, detail: `The hand-off stopped: ${open.airtable_handoff_error ?? 'see Automation'}. An admin re-queues it from its exception once the cause is fixed.` }
        : { title: `${open.quote_number} sent; being added to Airtable`, detail: open.airtable_handoff === 'RETRYING'
            ? `The last try failed (${open.airtable_handoff_error ?? 'see Automation'}); RoofOps tries again automatically.`
            : 'RoofOps adds the customer, site and quote to Airtable (usually within a minute).' };
  }
  if (open?.status === 'DRAFT') return { title: `Check and send ${open.quote_number}`, detail: 'Step 4 below: revise it if needed, then Send.' };
  if (booked) return { title: `Inspection ${booked.inspection_number} booked`, detail: `${booked.inspector ?? 'Someone'} inspects on ${booked.scheduled_for?.replace('T', ' ') ?? 'the booked day'}; then record what was found.` };
  if (!inspected) return { title: 'Book the inspection', detail: 'Step 3 below: who measures the roof, and when. (A small repair can be quoted without one.)' };
  return { title: 'Prepare the quote', detail: 'Step 4 below: the lines, prices and GST.' };
}

const roleList = (v: string | null | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
export async function getSalesRoles(q: Query): Promise<string[]> {
  try {
    const [r] = await q<{ sales_roles: string | null }>('select sales_roles from v_dashboard_sales_roles');
    return roleList(r?.sales_roles);
  } catch {
    return [];   // not installed: nobody is offered the forms
  }
}
/** Who may correct a customer's phone or email (customer.correction_roles). */
export async function getCorrectionRoles(q: Query): Promise<string[]> {
  try {
    const [r] = await q<{ correction_roles: string | null }>('select correction_roles from v_dashboard_sales_roles');
    return roleList(r?.correction_roles);
  } catch {
    return [];
  }
}
