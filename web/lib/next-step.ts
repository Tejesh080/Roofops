/**
 * What has to happen next on a project, and who does it where, from canonical state only (the project row, its completion
 * checklist, its site visits and its open tasks). Pure, so it is unit-tested and shared by the project page and My work.
 *
 * Where a step is done matters: project status, dates, the project manager and the completion checklist are edited in
 * Airtable (n8n 06 applies them); site visits and tasks are run here; invoices on the Finance page.
 */
import type { ChecklistItem, ProjectRow } from './queries.ts';
import type { Task, Visit } from './ops.ts';
import { visitWhen } from './ops.ts';

export type StepWhere = 'airtable' | 'dashboard' | 'finance' | 'none';
export interface NextStep { title: string; detail: string; where: StepWhere; tone: 'good' | 'warn' | 'bad' | 'info' | 'neutral' }

const CHECK_FIELD: Record<string, string> = {
  'Completion / compliance photos uploaded': 'Completion Photos',
  'Compliance certificate received': 'Compliance Certificate',
};
const fieldFor = (title: string) => CHECK_FIELD[title] ?? title;

/** Ordered: the first step is the one to do now; the rest follow. Never empty for an active project. */
export function nextSteps(p: ProjectRow, checklist: ChecklistItem[], visits: Visit[], tasks: Task[], today: string): NextStep[] {
  const steps: NextStep[] = [];
  const live = visits.filter((v) => v.status === 'SCHEDULED' || v.status === 'IN_PROGRESS' || v.status === 'WEATHER_DELAYED');
  const onSite = visits.find((v) => v.status === 'IN_PROGRESS');
  const delayed = visits.filter((v) => v.status === 'WEATHER_DELAYED');
  const upcoming = visits.filter((v) => v.status === 'SCHEDULED').sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start));
  const openTasks = tasks.filter((t) => t.status === 'OPEN' || t.status === 'IN_PROGRESS');
  const overdue = openTasks.filter((t) => t.overdue);
  const completionGaps = checklist.filter((c) => c.kind === 'CHECKLIST' && c.stage === 'COMPLETION' && c.is_required && c.status === 'OPEN');

  if (p.status === 'CANCELLED' || p.status === 'CLOSED') {
    return [{ title: p.status === 'CANCELLED' ? 'Cancelled: nothing more to do' : 'Closed: nothing more to do', detail: '', where: 'none', tone: 'neutral' }];
  }
  for (const t of overdue) {
    steps.push({ title: `Overdue task: ${t.title}`, detail: `${t.task_number}, due ${t.due_on}${t.assignee_name ? `, ${t.assignee_name}` : ', nobody assigned'}`, where: 'dashboard', tone: 'bad' });
  }
  for (const v of delayed) {
    steps.push({ title: `Reschedule ${v.job_number} (weather delayed)`, detail: `${v.status_reason ?? 'Delayed'}. A planner picks new times under Site visits.`, where: 'dashboard', tone: 'bad' });
  }

  switch (p.status) {
    case 'PLANNING':
    case 'MATERIALS_PENDING':
    case 'SCHEDULED':
      if (!p.project_manager) steps.push({ title: 'Assign a project manager', detail: 'In Airtable: Projects › Project Manager.', where: 'airtable', tone: 'warn' });
      if (!p.planned_start_date) steps.push({ title: 'Set the planned start and completion dates', detail: 'In Airtable: Projects › Planned Start / Planned Completion.', where: 'airtable', tone: 'warn' });
      if (p.planned_start_date && p.planned_start_date < today && !onSite) {
        steps.push({ title: 'The planned start has passed', detail: `Planned for ${p.planned_start_date}. Book the visit (Site visits) or move the planned dates in Airtable (Projects › Planned Start).`, where: 'airtable', tone: 'bad' });
      }
      if (p.status === 'MATERIALS_PENDING' || p.waiting_on_materials || p.material_status === 'CONFIRMATION_OVERDUE') {
        steps.push({ title: p.material_status === 'CONFIRMATION_OVERDUE' ? 'The supplier has not confirmed the order' : 'Materials are not all in yet',
          detail: p.material_eta ? `Expected by ${p.material_eta}. Follow up the open purchase orders (Airtable › Purchase Orders).` : 'Follow up the open purchase orders (Airtable › Purchase Orders).', where: 'airtable', tone: 'warn' });
      }
      if (upcoming.length) {
        const v = upcoming[0]!;
        steps.push({ title: `${v.job_number} on ${visitWhen(v.scheduled_start, v.scheduled_end)}`, detail: `Crew: ${v.crew.map((c) => c.name).join(', ')}. The crew starts it on the day.`, where: 'dashboard', tone: 'info' });
      } else if (!live.length) {
        steps.push({ title: 'Schedule the first site visit', detail: 'Pick the crew and times under Site visits (a planner: admin, operations or project manager).', where: 'dashboard', tone: 'warn' });
      }
      if (p.status !== 'MATERIALS_PENDING' && upcoming.length && upcoming[0]!.visit_date <= today) {
        steps.push({ title: 'When work starts, set the project to In Progress', detail: 'In Airtable: Projects › Status → In Progress (with the actual start date).', where: 'airtable', tone: 'info' });
      }
      break;
    case 'IN_PROGRESS':
      if (onSite) {
        steps.push({ title: `Crew on site: ${onSite.job_number}`, detail: `${onSite.crew.map((c) => c.name).join(', ')}. The crew completes the visit when they finish.`, where: 'dashboard', tone: 'info' });
      } else if (upcoming.length) {
        const v = upcoming[0]!;
        steps.push({ title: `Next visit ${v.job_number} on ${visitWhen(v.scheduled_start, v.scheduled_end)}`, detail: `Crew: ${v.crew.map((c) => c.name).join(', ')}.`, where: 'dashboard', tone: 'info' });
      } else if (!delayed.length) {
        steps.push({ title: 'Work finished? Set the project to Completed', detail: 'In Airtable: Projects › Status → Completed (with the actual completion date). Or schedule another visit if work remains.', where: 'airtable', tone: 'warn' });
      }
      break;
    case 'COMPLETED':
      for (const c of completionGaps) {
        steps.push({ title: `Completion item open: ${c.title}`, detail: `In Airtable: Projects › ${fieldFor(c.title)} → Done once it is really there, or Waived / Not applicable with the reason in ${fieldFor(c.title)} Note.`, where: 'airtable', tone: 'warn' });
      }
      if (p.invoice_status === 'READY_TO_INVOICE') {
        steps.push({ title: 'Prepare the final invoice', detail: 'Finance page › Ready to invoice › Prepare invoice; a second person approves it.', where: 'finance', tone: 'info' });
      } else if (p.invoice_status === 'AWAITING_APPROVAL') {
        steps.push({ title: `Approve or reject ${p.pending_approval_number ?? 'the invoice preview'}`, detail: 'Finance page › Invoice approvals (someone other than the person who prepared it).', where: 'finance', tone: 'info' });
      } else if (p.invoice_status === 'NOT_READY' || p.invoice_status === 'OVER_BILLED') {
        if (!completionGaps.length && p.invoice_blocker) steps.push({ title: 'Final invoice blocked', detail: p.invoice_blocker, where: 'finance', tone: 'bad' });
      } else if (p.final_invoice_number) {
        steps.push({ title: `Invoiced: ${p.xero_invoice_number ?? p.final_invoice_number}`, detail: p.outstanding_inc_gst > 0 ? 'Waiting for payment.' : 'Nothing outstanding.', where: 'none', tone: 'good' });
      }
      break;
    case 'ON_HOLD':
      steps.push({ title: 'On hold', detail: p.delay_reason ?? 'Resume it in Airtable (Projects › Status) when the reason is cleared.', where: 'airtable', tone: 'warn' });
      break;
  }
  for (const t of openTasks.filter((x) => !x.overdue).slice(0, 3)) {
    steps.push({ title: `Task: ${t.title}`, detail: `${t.task_number}${t.due_on ? `, due ${t.due_on}` : ''}${t.assignee_name ? `, ${t.assignee_name}` : ', nobody assigned'}`, where: 'dashboard', tone: 'neutral' });
  }
  if (!steps.length) steps.push({ title: 'Nothing waiting', detail: '', where: 'none', tone: 'good' });
  return steps;
}
