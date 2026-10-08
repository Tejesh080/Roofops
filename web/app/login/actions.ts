'use server';

import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from '@/lib/session';
import { authConfigured } from '@/lib/auth';

// Simple per-instance throttle: 5 failures per 10 minutes per client address, plus a fixed delay on failure.
const failures = new Map<string, { n: number; until: number }>();
const WINDOW_MS = 10 * 60 * 1000;

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export interface LoginState { error?: string; username?: string }

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  if (!authConfigured()) return { error: 'Sign-in is not configured on this server.' };
  const h = await headers();
  const client = (h.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || 'local';
  const f = failures.get(client);
  const username = String(form.get('username') ?? '');
  if (f && f.n >= 5 && f.until > Date.now()) return { error: 'Too many attempts. Try again in a few minutes.', username };

  const password = String(form.get('password') ?? '');
  const userOk = same(username, process.env.DEMO_USERNAME!);
  const passOk = same(password, process.env.DEMO_PASSWORD!);   // always compare both (no early exit)
  const ok = userOk && passOk;
  if (!ok) {
    const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + WINDOW_MS };
    failures.set(client, { n: cur.n + 1, until: cur.until });
    await new Promise((r) => setTimeout(r, 600));
    return { error: 'That username and password did not match.', username };
  }
  failures.delete(client);
  (await cookies()).set(SESSION_COOKIE, await signSession(username), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: SESSION_TTL_SECONDS,
  });
  redirect('/');
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}
