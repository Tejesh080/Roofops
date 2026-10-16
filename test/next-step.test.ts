/** OPS-01: what a project needs next, and where it is done (pure; the project page and My work use it). */
import { describe, expect, it } from 'vitest';
import { nextSteps } from '../web/lib/next-step.ts';
import { opsRefusal, visitWhen } from '../web/lib/ops.ts';
import type { ChecklistItem, ProjectRow } from '../web/lib/queries.ts';
import type { Task, Visit } from '../web/lib/ops.ts';

const TODAY = '2026-09-29';
const project = (o: Partial<ProjectRow> = {}): ProjectRow => ({
  project_number: 'PRJ-2026-0099', status: 'SCHEDULED', is_active: true, customer_name: 'Synthetic Customer', customer_number: 'CUST-0099', customer_type: 'RESIDENTIAL',
  site_address: '1 Test St', project_manager: 'Pat Manager', quote_number: 'Q-2026-0099', quote_version: 1, quote_total_inc_gst: 1000, job_type: 'REPAIR', accepted_on: TODAY,
  planned_start_date: '2026-10-01', planned_completion_date: '2026-10-03', actual_start_date: null, actual_completion_date: null, risk_level: 'LOW', risk_reasons: [],
  delay_reason: null, material_status: 'DELIVERED', waiting_on_materials: false, material_eta: null, purchase_orders: 0, invoice_status: 'NOT_YET_DUE', invoice_blocker: null,
  invoice_amount_inc_gst: null, final_invoice_number: null, final_invoice_sync: null, xero_invoice_id: null, xero_invoice_number: null, pending_approval_number: null,
  outstanding_inc_gst: 0, has_overdue_invoice: false, open_exceptions: 0, drive_folder_url: null, airtable_record_id: null, needs_attention: false, status_changed_at: null,
  airtable_status_seen: null, airtable_status_seen_at: null, status_out_of_sync: false, drift_fields: 0, last_reconciled_at: null, ...o,
});
const visit = (o: Partial<Visit> = {}): Visit => ({
  job_number: 'JOB-2026-0001', project_number: 'PRJ-2026-0099', customer_name: 'Synthetic Customer', site: '1 Test St', project_manager: null, job_type: 'REPAIR',
  status: 'SCHEDULED', scheduled_start: '2026-10-01T07:00', scheduled_end: '2026-10-01T15:00', actual_start: null, actual_end: null, notes: null, status_reason: null,
  record_version: 1, visit_date: '2026-10-01', crew: [{ code: 'EMP-811', name: 'Lee Hand', crew_role: 'LEADING_HAND' }], ...o,
});
const task = (o: Partial<Task> = {}): Task => ({
  task_number: 'TASK-0001', project_number: 'PRJ-2026-0099', task_type: 'GENERAL', title: 'Call the customer', description: null, status: 'OPEN', due_on: null,
  status_note: null, record_version: 1, assignee_code: null, assignee_name: null, created_by_name: null, overdue: false, ...o,
});
const photos = (status: string): ChecklistItem => ({ kind: 'CHECKLIST', stage: 'COMPLETION', title: 'Completion / compliance photos uploaded', status, is_required: true, done_on: null, due_on: null, assignee: null });

describe('next steps', () => {
  it('a scheduled job with no visit: schedule one here; missing manager and dates are Airtable steps', () => {
    const s = nextSteps(project({ project_manager: null, planned_start_date: null }), [], [], [], TODAY);
    expect(s.map((x) => [x.title, x.where])).toEqual([
      ['Assign a project manager', 'airtable'], ['Set the planned start and completion dates', 'airtable'], ['Schedule the first site visit', 'dashboard']]);
  });

  it('with a visit booked: it names the visit, day and crew; on the day it reminds to set In Progress in Airtable', () => {
    const later = nextSteps(project(), [], [visit()], [], TODAY);
    expect(later[0]).toMatchObject({ title: 'JOB-2026-0001 on Thu 1 Oct, 07:00–15:00', where: 'dashboard' });
    expect(later[0]!.detail).toContain('Lee Hand');
    expect(later.some((x) => x.title.startsWith('When work starts'))).toBe(false);
    expect(nextSteps(project(), [], [visit({ visit_date: TODAY })], [], TODAY).some((x) => x.title.startsWith('When work starts') && x.where === 'airtable')).toBe(true);
  });

  it('a planned start that has passed and an unconfirmed supplier order are said, not hidden behind "schedule a visit" (seen on PRJ-2026-0011)', () => {
    const s = nextSteps(project({ planned_start_date: '2026-09-27', material_status: 'CONFIRMATION_OVERDUE', waiting_on_materials: true, material_eta: '2026-08-20' }), [], [], [], TODAY);
    expect(s.map((x) => x.title)).toEqual(['The planned start has passed', 'The supplier has not confirmed the order', 'Schedule the first site visit']);
    expect(s[0]).toMatchObject({ tone: 'bad', where: 'airtable' });
  });

  it('overdue tasks and weather-delayed visits come first', () => {
    const s = nextSteps(project({ status: 'IN_PROGRESS', actual_start_date: TODAY }), [], [visit({ status: 'WEATHER_DELAYED', status_reason: 'Heavy rain' })],
      [task({ overdue: true, due_on: '2026-09-27', title: 'Order flashing' }), task({ task_number: 'TASK-0002', title: 'Book skip bin' })], TODAY);
    expect(s.map((x) => x.title)).toEqual(['Overdue task: Order flashing', 'Reschedule JOB-2026-0001 (weather delayed)', 'Task: Book skip bin']);
    expect(s[0]!.tone).toBe('bad');
  });

  it('on site, then finished: the crew completes the visit; with nothing left, set Completed in Airtable', () => {
    expect(nextSteps(project({ status: 'IN_PROGRESS' }), [], [visit({ status: 'IN_PROGRESS' })], [], TODAY)[0]).toMatchObject({ title: 'Crew on site: JOB-2026-0001' });
    expect(nextSteps(project({ status: 'IN_PROGRESS' }), [], [visit({ status: 'COMPLETED' })], [], TODAY)[0]).toMatchObject({ title: 'Work finished? Set the project to Completed', where: 'airtable' });
  });

  it('completed: an open completion item names the Airtable field and the honest choices; then invoicing on the Finance page', () => {
    const blocked = nextSteps(project({ status: 'COMPLETED', invoice_status: 'NOT_READY', invoice_blocker: 'missing completion documents' }), [photos('OPEN')], [], [], TODAY);
    expect(blocked).toHaveLength(1);   // the blocker is the open item, not said twice
    expect(blocked[0]!.detail).toContain('Projects › Completion Photos → Done once it is really there, or Waived / Not applicable with the reason in Completion Photos Note');
    expect(nextSteps(project({ status: 'COMPLETED', invoice_status: 'READY_TO_INVOICE' }), [photos('WAIVED')], [], [], TODAY)[0])
      .toMatchObject({ title: 'Prepare the final invoice', where: 'finance' });
    expect(nextSteps(project({ status: 'COMPLETED', invoice_status: 'AWAITING_APPROVAL', pending_approval_number: 'APR-2026-0001' }), [], [], [], TODAY)[0]!.title).toBe('Approve or reject APR-2026-0001');
    expect(nextSteps(project({ status: 'COMPLETED', invoice_status: 'XERO_DRAFT_CREATED', final_invoice_number: 'INV-1', xero_invoice_number: 'RO-INV-1', outstanding_inc_gst: 5 }), [], [], [], TODAY)[0])
      .toMatchObject({ title: 'Invoiced: RO-INV-1', detail: 'Waiting for payment.', tone: 'good' });
  });

  it('cancelled and closed projects have nothing to do', () => {
    expect(nextSteps(project({ status: 'CANCELLED' }), [], [], [task()], TODAY)).toEqual([{ title: 'Cancelled: nothing more to do', detail: '', where: 'none', tone: 'neutral' }]);
  });
});

describe('visit wording', () => {
  it('times read in Brisbane local time, on one day or across days; refusals keep the database detail', () => {
    expect(visitWhen('2026-10-01T07:00', '2026-10-01T15:30')).toBe('Thu 1 Oct, 07:00–15:30');
    expect(visitWhen('2026-10-01T07:00', '2026-10-02T12:00')).toBe('Thu 1 Oct 07:00 – Fri 2 Oct 12:00');
    expect(opsRefusal({ code: 'CREW_CONFLICT', detail: 'Lee Hand is already on JOB-2026-0002' })).toBe('Someone on the crew is already booked at that time. (Lee Hand is already on JOB-2026-0002)');
    expect(opsRefusal({ code: 'SIGNED_OUT', detail: 'x' })).toBe('Your sign-in has ended. Sign in again as yourself.');
    expect(opsRefusal({ detail: 'something else' })).toBe('something else');
  });
});
