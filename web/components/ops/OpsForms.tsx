'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useSubmit } from '@/components/ui/useSubmit';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { createTask, scheduleVisit, updateTask, updateVisit, type OpsActionState } from '@/app/(ops)/work/actions';
import type { StaffMember } from '@/lib/ops';
import { TASK_TYPE, VISIT_TYPE } from '@/lib/ops';

/** A fresh key per form: a double click or a resubmitted page sends the same key and is answered with the first result. */
function useRequestKey(state: OpsActionState) {
  const [key, setKey] = useState(() => crypto.randomUUID());
  useEffect(() => { if (state.ok) setKey(crypto.randomUUID()); }, [state.ok, state.at]);
  return key;
}
const Result = ({ s }: { s: OpsActionState }) => (s.message
  ? s.ok ? <p className="resolve-done" role="status"><CheckCircle2 size={15} aria-hidden /> {s.message}</p> : <p className="form-error" role="alert">{s.message}</p>
  : null);
const Submit = ({ pending, label, busy, primary = true }: { pending: boolean; label: string; busy: string; primary?: boolean }) => (
  <button className={`btn btn-sm${primary ? ' btn-primary' : ''}`} disabled={pending}>{pending ? <><Loader2 size={14} className="spin" aria-hidden /> {busy}</> : label}</button>
);

/** Schedule a site visit: kind, times (Brisbane), crew and leading hand, a note for the crew. */
export function ScheduleVisitForm({ project, staff, defaultDay }: { project: string; staff: StaffMember[]; defaultDay: string }) {
  const [state, action, pending] = useActionState<OpsActionState, FormData>(scheduleVisit, {});
  const submit = useSubmit(action, pending);
  const key = useRequestKey(state);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state.ok) form.current?.reset(); }, [state.ok, state.at]);
  return (
    <details className="ops-details" open={false}>
      <summary className="btn btn-sm">Schedule a site visit</summary>
      <form ref={form} onSubmit={submit} className="ops-form" aria-label={`Schedule a site visit for ${project}`}>
        <input type="hidden" name="project" value={project} />
        <input type="hidden" name="request_key" value={key} />
        <label className="field"><span>Kind of visit</span>
          <select name="type" defaultValue="INSTALL">{Object.entries(VISIT_TYPE).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
        <div className="ops-row">
          <label className="field"><span>Start</span><input type="datetime-local" name="start" required defaultValue={`${defaultDay}T07:00`} /></label>
          <label className="field"><span>End</span><input type="datetime-local" name="end" required defaultValue={`${defaultDay}T15:30`} /></label>
        </div>
        <fieldset className="crew-pick"><legend>Crew</legend>
          {staff.map((s) => (
            <label key={s.employee_code} className="check-line"><input type="checkbox" name="crew" value={s.employee_code} /> {s.full_name} <span className="t-meta">{s.role.replace(/_/g, ' ').toLowerCase()}</span></label>
          ))}
        </fieldset>
        <label className="field"><span>Leading hand (optional: otherwise the first person ticked above)</span>
          <select name="lead" defaultValue=""><option value="">—</option>{staff.map((s) => <option key={s.employee_code} value={s.employee_code}>{s.full_name}</option>)}</select></label>
        <label className="field"><span>Note for the crew (optional)</span><textarea name="note" rows={2} maxLength={2000} placeholder="e.g. Bring the long ladder; gate code 4512" /></label>
        <Result s={state} />
        <Submit pending={pending} label="Schedule visit" busy="Scheduling…" />
      </form>
    </details>
  );
}

/** The buttons that fit a visit's state for this person: crew start/complete/delay; planners also reschedule/cancel. */
export function VisitActions({ job, status, version, planner, crew, start, end }: { job: string; status: string; version: number; planner: boolean; crew: boolean; start: string; end: string }) {
  const [state, action, pending] = useActionState<OpsActionState, FormData>(updateVisit, {});
  const submit = useSubmit(action, pending);
  const [mode, setMode] = useState<'' | 'weather_delay' | 'cancel' | 'reschedule' | 'complete'>('');
  const can = (a: string) => ({
    start: (crew || planner) && status === 'SCHEDULED', complete: (crew || planner) && status === 'IN_PROGRESS',
    weather_delay: (crew || planner) && (status === 'SCHEDULED' || status === 'IN_PROGRESS'),
    reschedule: planner && (status === 'SCHEDULED' || status === 'WEATHER_DELAYED'), cancel: planner && (status === 'SCHEDULED' || status === 'WEATHER_DELAYED'),
  } as Record<string, boolean>)[a];
  // After a change the page re-renders with the visit's new state and version; the confirmation stays until the next action.
  useEffect(() => { if (state.ok) setMode(''); }, [state.ok, state.at]);
  if (!['start', 'complete', 'weather_delay', 'reschedule', 'cancel'].some(can)) return state.ok ? <Result s={state} /> : null;
  return (
    <form onSubmit={submit} className="resolve-form" aria-label={`Update ${job}`}>
      <input type="hidden" name="job" value={job} />
      <input type="hidden" name="version" value={version} />
      {mode === 'reschedule' && (
        <div className="ops-row">
          <label className="field"><span>New start</span><input type="datetime-local" name="start" required defaultValue={start} /></label>
          <label className="field"><span>New end</span><input type="datetime-local" name="end" required defaultValue={end} /></label>
        </div>
      )}
      {mode && (
        <label className="field"><span>{mode === 'complete' ? 'What was done (optional, kept as a site note)' : mode === 'reschedule' ? 'Why (optional)' : 'Why (required)'}</span>
          <textarea name="reason" rows={1} maxLength={2000} required={mode === 'weather_delay' || mode === 'cancel'}
            placeholder={mode === 'weather_delay' ? 'e.g. Heavy rain from 10am' : mode === 'cancel' ? 'e.g. Customer postponed' : ''} /></label>
      )}
      <Result s={state} />
      <div className="form-buttons">
        {!mode && can('start') && <button className="btn btn-sm btn-primary" name="action" value="start" disabled={pending}>Start visit</button>}
        {!mode && can('complete') && <button type="button" className="btn btn-sm btn-primary" onClick={() => setMode('complete')}>Complete…</button>}
        {!mode && can('weather_delay') && <button type="button" className="btn btn-sm" onClick={() => setMode('weather_delay')}>Weather delay…</button>}
        {!mode && can('reschedule') && <button type="button" className="btn btn-sm" onClick={() => setMode('reschedule')}>Reschedule…</button>}
        {!mode && can('cancel') && <button type="button" className="btn btn-sm" onClick={() => setMode('cancel')}>Cancel visit…</button>}
        {mode && <button className="btn btn-sm btn-primary" name="action" value={mode} disabled={pending}>
          {pending ? 'Saving…' : ({ complete: 'Complete visit', weather_delay: 'Mark weather delayed', reschedule: 'Save new times', cancel: 'Cancel this visit' } as Record<string, string>)[mode]}</button>}
        {mode && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMode('')} disabled={pending}>Back</button>}
      </div>
    </form>
  );
}

/** Add a task, optionally on a project, for someone, by a date. */
export function NewTaskForm({ project, staff, today }: { project: string | null; staff: StaffMember[]; today: string }) {
  const [state, action, pending] = useActionState<OpsActionState, FormData>(createTask, {});
  const submit = useSubmit(action, pending);
  const key = useRequestKey(state);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state.ok) form.current?.reset(); }, [state.ok, state.at]);
  return (
    <details className="ops-details">
      <summary className="btn btn-sm">Add a task</summary>
      <form ref={form} onSubmit={submit} className="ops-form" aria-label={project ? `Add a task to ${project}` : 'Add a task'}>
        <input type="hidden" name="project" value={project ?? ''} />
        <input type="hidden" name="request_key" value={key} />
        <label className="field"><span>What needs doing</span><input name="title" required minLength={3} maxLength={200} placeholder="e.g. Confirm the scaffold booking" /></label>
        <div className="ops-row">
          <label className="field"><span>Kind</span>
            <select name="type" defaultValue="GENERAL">{Object.entries(TASK_TYPE).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
          <label className="field"><span>Due (optional)</span><input type="date" name="due" min={today} /></label>
        </div>
        <label className="field"><span>Who does it (optional)</span>
          <select name="assignee" defaultValue=""><option value="">Nobody yet</option>{staff.map((s) => <option key={s.employee_code} value={s.employee_code}>{s.full_name}</option>)}</select></label>
        <label className="field"><span>Details (optional)</span><textarea name="description" rows={2} maxLength={2000} /></label>
        <Result s={state} />
        <Submit pending={pending} label="Add task" busy="Adding…" />
      </form>
    </details>
  );
}

/** A task's buttons for this person: the assignee starts and finishes it; a manager also reassigns, re-dates or cancels. */
export function TaskActions({ task, status, version, manager, mine, staff, today }: { task: string; status: string; version: number; manager: boolean; mine: boolean; staff: StaffMember[]; today: string }) {
  const [state, action, pending] = useActionState<OpsActionState, FormData>(updateTask, {});
  const submit = useSubmit(action, pending);
  const [mode, setMode] = useState<'' | 'cancel' | 'reassign' | 'due'>('');
  const open = status === 'OPEN' || status === 'IN_PROGRESS';
  useEffect(() => { if (state.ok) setMode(''); }, [state.ok, state.at]);
  if (!open || !(manager || mine)) return state.ok ? <Result s={state} /> : null;
  return (
    <form onSubmit={submit} className="resolve-form" aria-label={`Update ${task}`}>
      <input type="hidden" name="task" value={task} />
      <input type="hidden" name="version" value={version} />
      {mode === 'reassign' && <label className="field"><span>Give it to</span>
        <select name="assignee" required defaultValue=""><option value="" disabled>Pick someone</option>{staff.map((s) => <option key={s.employee_code} value={s.employee_code}>{s.full_name}</option>)}</select></label>}
      {mode === 'due' && <label className="field"><span>New due date</span><input type="date" name="due" required min={today} /></label>}
      {mode === 'cancel' && <label className="field"><span>Why it is no longer needed (required)</span><textarea name="note" rows={1} required minLength={5} maxLength={2000} /></label>}
      <Result s={state} />
      <div className="form-buttons">
        {!mode && status === 'OPEN' && <button className="btn btn-sm" name="action" value="start" disabled={pending}>Start</button>}
        {!mode && <button className="btn btn-sm btn-primary" name="action" value="done" disabled={pending}>{pending ? 'Saving…' : 'Mark done'}</button>}
        {!mode && manager && <button type="button" className="btn btn-sm" onClick={() => setMode('reassign')}>Reassign…</button>}
        {!mode && manager && <button type="button" className="btn btn-sm" onClick={() => setMode('due')}>Change due date…</button>}
        {!mode && manager && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMode('cancel')}>Cancel task…</button>}
        {mode && <button className="btn btn-sm btn-primary" name="action" value={mode} disabled={pending}>{pending ? 'Saving…' : ({ cancel: 'Cancel this task', reassign: 'Reassign', due: 'Save due date' } as Record<string, string>)[mode]}</button>}
        {mode && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMode('')} disabled={pending}>Back</button>}
      </div>
    </form>
  );
}
