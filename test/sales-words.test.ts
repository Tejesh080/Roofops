/** SALES-01: the live GST preview on the quote builder and the one next step an enquiry page leads with (pure). */
import { describe, expect, it } from 'vitest';
import { leadNextStep, quoteTotals, salesRefusal } from '../web/lib/sales.ts';
import type { InspectionSummary, Lead, Quote } from '../web/lib/sales.ts';

const lead = (o: Partial<Lead> = {}): Lead => ({
  lead_number: 'LEAD-2026-0099', status: 'NEW', source: 'PHONE', contact_name: 'Synthetic Caller', phone: null, email: null, property_address_text: null,
  notes: null, lost_reason: null, received_at: '2026-09-29 09:00', contacted_at: null, record_version: 1,
  customer_number: null, customer_name: null, property_number: null, site: null, created_by_name: null, inspections: [], quotes: [], project_number: null, ...o,
});
const inspection = (o: Partial<InspectionSummary> = {}): InspectionSummary => ({
  inspection_number: 'INS-2026-0099', status: 'SCHEDULED', inspector: 'Synthetic Estimator', scheduled_for: '2026-10-01T09:00', inspected_on: null,
  roof_type: null, roof_area_sqm: null, pitch_degrees: null, measurement_method: null, findings: null, record_version: 1, ...o,
});
const quote = (o: Partial<Quote> = {}): Quote => ({
  quote_number: 'Q-2026-0099', status: 'DRAFT', job_type: 'LEAK_REPAIR', created_on: '2026-09-29', sent_on: null, valid_until: null, accepted_on: null, lost_reason: null,
  record_version: 1, lead_number: 'LEAD-2026-0099', customer_number: 'CUST-0099', customer_name: 'Synthetic Caller', property_number: 'PROP-0099', site: '1 Test St',
  estimator: null, version_number: 1, line_amount_type: 'INCLUSIVE', subtotal_ex_gst: 0, gst_amount: 0, total_inc_gst: 0, scope_summary: null, lines: [],
  airtable_handoff: null, airtable_handoff_error: null, in_airtable: false, project_number: null, ...o,
});
const customer = { customer_number: 'CUST-0099', customer_name: 'Synthetic Caller', property_number: 'PROP-0099', site: '1 Test St' };

describe('quoteTotals (matches quote_versions)', () => {
  it('inclusive prices carry 1/11 GST', () => {
    expect(quoteTotals([{ quantity: 12, unit_price: 95 }, { quantity: 4, unit_price: 62.5 }], 'INCLUSIVE')).toEqual({ subtotal: 1263.64, gst: 126.36, total: 1390 });
  });
  it('exclusive prices add 10%', () => {
    expect(quoteTotals([{ quantity: 1, unit_price: 1870 }], 'EXCLUSIVE')).toEqual({ subtotal: 1870, gst: 187, total: 2057 });
  });
  it('rounds each line to cents before summing', () => {
    expect(quoteTotals([{ quantity: 3, unit_price: 0.333 }, { quantity: 3, unit_price: 0.333 }], 'EXCLUSIVE').subtotal).toBe(2);
  });
  it('no lines is zero', () => {
    expect(quoteTotals([], 'INCLUSIVE')).toEqual({ subtotal: 0, gst: 0, total: 0 });
  });
});

describe('leadNextStep', () => {
  it('walks the enquiry from customer to quote', () => {
    expect(leadNextStep(lead(), []).title).toBe('Record the customer and the site');
    expect(leadNextStep(lead({ ...customer, status: 'CONTACTED' }), []).title).toBe('Book the inspection');
    expect(leadNextStep(lead({ ...customer, status: 'INSPECTION_BOOKED', inspections: [inspection()] }), []).title).toBe('Inspection INS-2026-0099 booked');
    expect(leadNextStep(lead({ ...customer, inspections: [inspection({ status: 'COMPLETED' })] }), []).title).toBe('Prepare the quote');
    expect(leadNextStep(lead({ ...customer }), [quote()]).title).toBe('Check and send Q-2026-0099');
  });
  it('a sent quote waits for Airtable, then for the customer; a failed hand-off says why', () => {
    const l = lead({ ...customer, status: 'QUOTED' });
    expect(leadNextStep(l, [quote({ status: 'SENT' })]).title).toBe('Q-2026-0099 sent; being added to Airtable');
    expect(leadNextStep(l, [quote({ status: 'SENT', airtable_handoff: 'FAILED', airtable_handoff_error: 'Airtable said 422' })]).detail).toContain('Airtable said 422');
    expect(leadNextStep(l, [quote({ status: 'SENT', in_airtable: true })]).title).toBe('Waiting for the customer to accept Q-2026-0099');
  });
  it('won and closed enquiries say so', () => {
    expect(leadNextStep(lead({ ...customer, status: 'WON', project_number: 'PRJ-2026-0099' }), [quote({ status: 'ACCEPTED' })]).title).toBe('Won: project PRJ-2026-0099');
    expect(leadNextStep(lead({ status: 'LOST', lost_reason: 'Went with another roofer' }), [])).toEqual({ title: 'Closed', detail: 'Went with another roofer' });
  });
});

describe('salesRefusal', () => {
  it('words known codes, keeps the detail, and never echoes detail on sign-out', () => {
    expect(salesRefusal({ code: 'STALE', detail: 'version 2' })).toBe('Someone changed this since you opened the page. Reload and check it again. (version 2)');
    expect(salesRefusal({ code: 'SIGNED_OUT', detail: 'x' })).toBe('Your sign-in has ended. Sign in again as yourself.');
    expect(salesRefusal({ code: 'SOMETHING_NEW', detail: 'Plain words' })).toBe('Plain words');
  });
});
