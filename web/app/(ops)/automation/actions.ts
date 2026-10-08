'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/session';
import { query } from '@/lib/db';

export interface ResolveState { ok?: boolean; message?: string }

/**
 * Resolve an exception as the signed-in employee. The database resolves the session token to the employee and applies
 * the same rules as `npm run exception:resolve` (an allowed role, a real note, OPEN only, audited). A repeat submit of
 * an already resolved exception is refused, never applied twice.
 */
export async function resolveException(_prev: ResolveState, form: FormData): Promise<ResolveState> {
  const s = await verifySession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!s?.t) return { message: 'Sign in as yourself to resolve issues (the shared demo login cannot resolve, approve or change records).' };
  const exception = String(form.get('exception') ?? '');
  const note = String(form.get('note') ?? '').trim();
  if (note.length < 10) return { message: 'Say what was checked or done (at least 10 characters), so the next person knows why it was closed.' };
  try {
    const [row] = await query<{ r: { resolved: boolean; reason?: string; already_resolved?: boolean } }>(
      'select web_resolve_exception($1, $2, $3) r', [s.t, exception, note]);
    const r = row!.r;
    if (!r.resolved) return { message: r.reason ?? 'Not resolved.' };
  } catch {
    return { message: 'Resolving from the dashboard is not available on this server yet.' };
  }
  revalidatePath('/', 'layout');
  return { ok: true, message: `${exception} resolved by you. It moves to Resolved with your note.` };
}
