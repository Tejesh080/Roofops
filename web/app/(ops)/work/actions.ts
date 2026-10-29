'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/session';
import { query } from '@/lib/db';
import { opsMissing, opsRefusal } from '@/lib/ops';

export interface OpsActionState { ok?: boolean; message?: string; at?: number }
type Outcome = { ok: boolean; code?: string; detail?: string; duplicate?: boolean; job_number?: string; task_number?: string; status?: string };

/** One web_visit_* / web_task_* call as the signed-in employee; the database checks session, role, state and version. */
async function asStaff(sql: string, args: unknown[]): Promise<Outcome | { signedOut: true }> {
  const s = await verifySession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!s?.t) return { signedOut: true };
  const [row] = await query<{ r: Outcome }>(sql, [s.t, ...args]);
  return row!.r;
}

const SIGNED_OUT = 'Sign in as yourself to do this (the shared demo login can only look).';
/** A failure we cannot interpret may still have committed: never claim success, ask for a reload. */
function failed(e: unknown): OpsActionState {
  console.error('site visits/tasks action failed:', (e as Error)?.message ?? e);   // server log only: the person sees a safe message
  if (opsMissing(e)) return { message: 'Site visits and tasks are not available on this server yet.' };
  revalidatePath('/', 'layout');
  return { message: 'Could not confirm the result (the database did not answer). Reload and check before trying again; a repeat of the same form is never done twice.' };
}
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
/** A "YYYY-MM-DDTHH:MM" from a datetime-local field is Brisbane time (UTC+10, no daylight saving). */
const brisbane = (v: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v}:00+10:00` : null);
const version = (f: FormData) => { const n = Number(str(f, 'version')); return Number.isInteger(n) && n > 0 ? n : null; };

export async function scheduleVisit(_prev: OpsActionState, form: FormData): Promise<OpsActionState> {
  const start = brisbane(str(form, 'start')); const end = brisbane(str(form, 'end'));
  const crew = form.getAll('crew').map(String).filter(Boolean);
  if (!start || !end) return { message: 'Enter a start and an end date and time.' };
  if (end <= start) return { message: 'The end must be after the start.' };
  if (!crew.length) return { message: 'Pick at least one person for the crew.' };
  try {
    const r = await asStaff('select web_visit_schedule($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::text[], $7, $8, $9) r',
      [str(form, 'project'), str(form, 'type'), start, end, crew, str(form, 'lead') || null, str(form, 'note') || null, str(form, 'request_key')]);
    if ('signedOut' in r) return { message: SIGNED_OUT };
    if (!r.ok) return { message: opsRefusal(r) };
    revalidatePath('/', 'layout');
    return { ok: true, at: Date.now(), message: r.duplicate ? `${r.job_number} was already scheduled (nothing added twice).` : `${r.job_number} scheduled. The crew sees it under My work.` };
  } catch (e) {
    return failed(e);
  }
}

export async function updateVisit(_prev: OpsActionState, form: FormData): Promise<OpsActionState> {
  const action = str(form, 'action'); const v = version(form);
  if (!v) return { message: 'Reload the page and try again.' };
  const start = action === 'reschedule' ? brisbane(str(form, 'start')) : null; const end = action === 'reschedule' ? brisbane(str(form, 'end')) : null;
  if (action === 'reschedule' && (!start || !end)) return { message: 'Enter the new start and end.' };
  if ((action === 'weather_delay' || action === 'cancel') && str(form, 'reason').length < 5) return { message: 'Say why (a few words), so the office and the customer can be told.' };
  try {
    const r = await asStaff('select web_visit_update($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz) r', [str(form, 'job'), action, v, str(form, 'reason') || null, start, end]);
    if ('signedOut' in r) return { message: SIGNED_OUT };
    if (!r.ok) return { message: opsRefusal(r) };
    revalidatePath('/', 'layout');
    const done: Record<string, string> = { start: 'started: the crew is on site', complete: 'completed. The project itself is not marked complete: when all the work is done, set its Status to Completed in Airtable (Projects › Status)', weather_delay: 'marked weather delayed: a planner reschedules it',
      reschedule: 'rescheduled', cancel: 'cancelled' };
    return { ok: true, at: Date.now(), message: `${r.job_number} ${done[action] ?? 'updated'}.` };
  } catch (e) {
    return failed(e);
  }
}

export async function createTask(_prev: OpsActionState, form: FormData): Promise<OpsActionState> {
  const title = str(form, 'title');
  if (title.length < 3) return { message: 'Give the task a short title (at least 3 characters).' };
  const due = str(form, 'due');
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { message: 'Pick a valid due date.' };
  try {
    const r = await asStaff('select web_task_create($1, $2, $3, $4, $5, $6::date, $7, $8) r',
      [str(form, 'project') || null, str(form, 'type') || 'GENERAL', title, str(form, 'assignee') || null, due || null, str(form, 'description') || null, str(form, 'request_key')]);
    if ('signedOut' in r) return { message: SIGNED_OUT };
    if (!r.ok) return { message: opsRefusal(r) };
    revalidatePath('/', 'layout');
    return { ok: true, at: Date.now(), message: r.duplicate ? `${r.task_number} already exists (nothing added twice).` : `${r.task_number} created.` };
  } catch (e) {
    return failed(e);
  }
}

export async function updateTask(_prev: OpsActionState, form: FormData): Promise<OpsActionState> {
  const action = str(form, 'action'); const v = version(form);
  if (!v) return { message: 'Reload the page and try again.' };
  if (action === 'cancel' && str(form, 'note').length < 5) return { message: 'Say why it is no longer needed (a few words).' };
  if (action === 'reassign' && !str(form, 'assignee')) return { message: 'Pick who should do it.' };
  if (action === 'due' && !/^\d{4}-\d{2}-\d{2}$/.test(str(form, 'due'))) return { message: 'Pick the new due date.' };
  try {
    const r = await asStaff('select web_task_update($1, $2, $3, $4, $5, $6::date, $7) r',
      [str(form, 'task'), action, v, str(form, 'assignee') || null, str(form, 'due') || null, str(form, 'note') || null]);
    if ('signedOut' in r) return { message: SIGNED_OUT };
    if (!r.ok) return { message: opsRefusal(r) };
    revalidatePath('/', 'layout');
    const done: Record<string, string> = { start: 'started', done: 'done', cancel: 'cancelled', reassign: 'reassigned', due: 'due date changed' };
    return { ok: true, at: Date.now(), message: `${r.task_number} ${done[action] ?? 'updated'}.` };
  } catch (e) {
    return failed(e);
  }
}
