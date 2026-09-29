import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, verifySession, type Session } from './session';

/**
 * Defence in depth: the proxy already blocks unauthenticated requests, but every page and API route
 * that reads operational data checks the session again itself (never rely on the proxy alone).
 */
export async function currentSession(): Promise<Session | null> {
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function requireSession(): Promise<Session> {
  const s = await currentSession();
  if (!s) redirect('/login');
  return s;
}

export function authConfigured(): boolean {
  return Boolean(process.env.DEMO_USERNAME && (process.env.DEMO_PASSWORD?.length ?? 0) >= 12 && (process.env.AUTH_SECRET?.length ?? 0) >= 32);
}
