import { describe, expect, it } from 'vitest';
import { groupTimeline } from '../web/lib/timeline.ts';
import { attentionToday, describeIssue, healthStrip } from '../web/lib/insights.ts';
import type { ExceptionRow, ProjectRow, TimelineEntry } from '../web/lib/queries.ts';

const ev = (t: string, kind: string, status: string | null, over: Partial<TimelineEntry> = {}): TimelineEntry => ({
  source: status === null ? 'AUDIT' : 'EVENT', occurred_at: `2026-09-29 ${t.slice(0, 5)}`, occurred_iso: `2026-09-29T${t}`, kind, status,
  error_class: null, actor: 'n8n-roofops', reference: 'PRJ-2026-0033', reason: null, external_reference: null, channel: 'n8n', ...over,
});

// The real PRJ-2026-0033 story (hosted data, 29 Sep 2026): 17 raw rows.
const PRJ33: TimelineEntry[] = [
  ev('07:47:21', 'quote.accepted', 'SUCCEEDED', { reference: 'Q-2026-0048', channel: 'airtable' }),
  ev('07:47:21', 'quote.accept', null, { reference: 'Q-2026-0048' }),
  ev('07:47:21', 'project.created', 'SUCCEEDED'), ev('07:47:21', 'project.create', null),
  ev('07:47:21', 'materials.review_requested', 'SUCCEEDED'), ev('07:47:21', 'task.create', null),
  ev('07:47:22', 'automation.retry_scheduled', 'FAILED'), ev('07:47:26', 'automation.retry_scheduled', 'FAILED'),
  ev('07:47:31', 'automation.retry_scheduled', 'FAILED'), ev('07:47:38', 'automation.retry_scheduled', 'FAILED'),
  ev('07:47:51', 'automation.failed', 'FAILED'),
  ev('07:49:30', 'exception.retry_queued', null, { actor: 'operator:phase2-test', reason: 'Cause fixed (Drive root restored); re-queued drive:project-folder:x after 5 attempts' }),
  ev('07:49:34', 'quote.accepted', 'DUPLICATE_IGNORED', { reference: 'Q-2026-0048', reason: 'transport redelivery of the same event_id' }),
  ev('07:49:38', 'drive.project_folder.verified', 'SUCCEEDED'), ev('07:49:38', 'drive.folder.link', null),
  ev('07:49:41', 'airtable.project_writeback.verified', 'SUCCEEDED'), ev('07:49:41', 'airtable.project.writeback', null),
].reverse();   // the query returns newest first

describe('automation history as a story', () => {
  const g = groupTimeline(PRJ33, 'PRJ-2026-0033');

  it('17 raw rows become 5 readable steps, newest first', () => {
    expect(g.map((x) => x.title)).toEqual(['Retried by staff', 'Google Drive temporarily unavailable', 'Material review requested', 'Project created', 'Quote accepted by customer']);
  });
  it('five failed attempts become one "stopped safely" entry with the real duration', () => {
    expect(g[1]).toMatchObject({ tone: 'attention', detail: '5 attempts over 29 seconds', lines: ['Automation stopped safely: nothing was created twice'] });
    expect(g[1]!.entries).toHaveLength(5);
  });
  it('the staff retry carries the recovery and the safely-ignored repeat', () => {
    expect(g[0]).toMatchObject({ tone: 'done', detail: 'Cause fixed (Drive root restored)' });
    expect(g[0]!.lines).toEqual(['Google Drive folder created and checked', 'Airtable updated and checked',
      'Repeated request ignored safely: nothing was created twice', 'Completed successfully']);
  });
  it('audit rows that only mirror an automation event are folded away', () => {
    expect(g.flatMap((x) => x.entries).some((e) => e.kind === 'project.create' || e.kind === 'quote.accept')).toBe(false);
  });
});

const row = (over: Partial<ProjectRow>): ProjectRow => ({
  project_number: 'PRJ-2026-0011', status: 'SCHEDULED', is_active: true, customer_name: 'Ethan Morgan', customer_number: 'CUST-0011', customer_type: 'RESIDENTIAL',
  site_address: '81 Ironbark Court, Bundaberg West', project_manager: 'Lachlan Reed', quote_number: 'Q-2026-0011', quote_version: 2, quote_total_inc_gst: 48768,
  job_type: 'EXTENSION_ROOF', accepted_on: '2026-07-22', planned_start_date: '2026-09-27', planned_completion_date: '2026-10-01', actual_start_date: null,
  actual_completion_date: null, risk_level: 'HIGH', risk_reasons: ['PM_FLAGGED', 'START_DATE_PASSED', 'SUPPLIER_ACK_OVERDUE'], delay_reason: null,
  material_status: 'CONFIRMATION_OVERDUE', waiting_on_materials: true, material_eta: '2026-08-20', purchase_orders: 1, invoice_status: 'PROGRESS_INVOICED',
  invoice_blocker: null, invoice_amount_inc_gst: null, final_invoice_number: null, final_invoice_sync: null, xero_invoice_id: null, xero_invoice_number: null,
  pending_approval_number: null, outstanding_inc_gst: 0, has_overdue_invoice: false, open_exceptions: 0, drive_folder_url: null, airtable_record_id: null,
  needs_attention: true, ...over,
});

describe('business interpretations', () => {
  it('health strip names schedule, materials, finance and automation in plain words', () => {
    expect(healthStrip(row({}), []).map((h) => `${h.label}:${h.value}:${h.tone}`))
      .toEqual(['Schedule:Delayed:bad', 'Materials:At risk:bad', 'Finance:Progress invoiced:neutral', 'Automation:Healthy:good']);
    expect(healthStrip(row({ is_active: false, status: 'COMPLETED', invoice_status: 'XERO_DRAFT_CREATED' }), [{ resolution_status: 'RESOLVED' } as ExceptionRow])
      .map((h) => h.value)).toEqual(['Complete', 'Complete', 'Draft invoice in Xero', 'Recovered']);
  });
  it('"needs me today" puts the most serious first and explains each item in a line', () => {
    const items = attentionToday([row({ project_number: 'PRJ-B', risk_reasons: ['PM_FLAGGED'] }), row({})], [], 5);
    expect(items[0]).toMatchObject({ project: 'PRJ-2026-0011', severity: 'high', summary: 'Start date passed · Supplier confirmation overdue · Flagged by project manager' });
    expect(items[1]).toMatchObject({ project: 'PRJ-B', severity: 'medium' });
  });
  it('technical issue classes are never the headline', () => {
    const d = describeIssue({ error_class: 'SCHEMA_MISMATCH', error_message: 'Supplier payload missing expected field', attempt_count: 1 });
    expect(d).toEqual({ title: 'Supplier information was incomplete', explanation: 'RoofOps stopped safely because a required supplier field was missing.' });
    for (const c of ['SERVICE_UNAVAILABLE', 'TIMEOUT', 'AMBIGUOUS_WRITE', 'PERMISSION_DENIED', 'SOMETHING_NEW']) {
      expect(describeIssue({ error_class: c, error_message: 'x', attempt_count: 2 }).title).not.toMatch(/[A-Z]{3,}_[A-Z]/);
    }
  });
});
