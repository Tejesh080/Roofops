import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, verifySession, type Session } from './session';
import { query } from './db';

/** A signed-in employee, as the database confirms it for this request. */
export interface StaffIdentity { employee_code: string; name: string; role: string; may_resolve_exceptions: boolean }

/**
 * A staff session is valid only while the database says so: the token is re-checked on every request, so signing out,
 * a password reset, an expired session or a deactivated employee ends it immediately. Cached per request.
 */
export const staffIdentity = cache(async (token: string | undefined): Promise<StaffIdentity | null> => {
  if (!token) return null;
  try {
    const [row] = await query<{ s: StaffIdentity | null }>('select web_staff_session($1) s', [token]);
    return row?.s ?? null;
  } catch {
    return null;   // fail closed: staff sign-in not available on this database
  }
});

/**
 * Defence in depth: the proxy already blocks unauthenticated requests, but every page and API route
 * that reads operational data checks the session again itself (never rely on the proxy alone).
 */
export async function currentSession(): Promise<Session | null> {
  const s = await verifySession((await cookies()).get(SESSION_COOKIE)?.value);
  if (s?.t && !(await staffIdentity(s.t))) return null;   // a staff session the database no longer accepts
  return s;
}

export async function requireSession(): Promise<Session> {
  const s = await currentSession();
  if (!s) redirect('/login');
  return s;
}

/** The demo sign-in (one shared viewer: browse, ask, prepare previews; never resolve or approve) is configured; staff sign-in needs only AUTH_SECRET. */
export function demoLoginConfigured(): boolean {
  return Boolean(process.env.DEMO_USERNAME && (process.env.DEMO_PASSWORD?.length ?? 0) >= 12);
}

export function authConfigured(): boolean {
  return (process.env.AUTH_SECRET?.length ?? 0) >= 32;
}
