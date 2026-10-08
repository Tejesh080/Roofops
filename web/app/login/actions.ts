'use server';

import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession, verifySession } from '@/lib/session';
import { authConfigured, demoLoginConfigured } from '@/lib/auth';
import { clientAddress } from '@/lib/client-address';
import { query } from '@/lib/db';

// Simple per-instance throttle: 5 failures per 10 minutes per client address, plus a fixed delay on failure.
// (Staff logins are also locked in the database after 5 wrong passwords, whatever instance served them.)
const failures = new Map<string, { n: number; until: number }>();
const WINDOW_MS = 10 * 60 * 1000;

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export interface LoginState { error?: string; username?: string }

type StaffSignIn = { ok: true; token: string; employee_code: string; name: string; role: string } | { ok: false; reason: string };

/** A person's own login, checked by the database (bcrypt in Postgres). null when staff sign-in is not available here. */
async function staffSignIn(login: string, password: string): Promise<StaffSignIn | null> {
  try {
    const [row] = await query<{ r: StaffSignIn }>('select web_staff_sign_in($1, $2) r', [login, password]);
    return row?.r ?? null;
  } catch {
    return null;
  }
}

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  if (!authConfigured()) return { error: 'Sign-in is not configured on this server.' };
  const h = await headers();
  const client = clientAddress(h.get('x-forwarded-for'));
  const f = failures.get(client);
  const username = String(form.get('username') ?? '');
  if (f && f.n >= 5 && f.until > Date.now()) return { error: 'Too many attempts. Try again in a few minutes.', username };

  const password = String(form.get('password') ?? '');
  let session: string | null = null;
  let refusal = 'That username and password did not match.';
  // 1. The shared demo viewer (browse, ask, prepare previews; never resolve or approve), when configured: compare both values, no early exit.
  if (demoLoginConfigured()) {
    const userOk = same(username, process.env.DEMO_USERNAME!);
    const passOk = same(password, process.env.DEMO_PASSWORD!);
    if (userOk && passOk) session = await signSession(username);
  }
  // 2. A person's own staff login.
  if (!session) {
    const staff = await staffSignIn(username, password);
    if (staff?.ok) session = await signSession(staff.name, { t: staff.token, e: staff.employee_code, r: staff.role });
    else if (staff && !staff.ok) refusal = staff.reason;
  }
  if (!session) {
    const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + WINDOW_MS };
    if (failures.size > 10_000) for (const [k, v] of failures) if (v.until <= Date.now()) failures.delete(k);   // bounded memory
    failures.set(client, { n: cur.n + 1, until: cur.until });
    await new Promise((r) => setTimeout(r, 600));
    return { error: refusal, username };
  }
  failures.delete(client);
  (await cookies()).set(SESSION_COOKIE, session, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: SESSION_TTL_SECONDS,
  });
  redirect('/');
}

export async function logout() {
  const jar = await cookies();
  const s = await verifySession(jar.get(SESSION_COOKIE)?.value);
  if (s?.t) {
    // End the database session too (retried once); the cookie goes either way, and the session still expires.
    const revoke = () => query('select web_staff_sign_out($1)', [s.t]);
    await revoke().catch(() => revoke()).catch((e: unknown) => {
      console.error('sign-out: the database session could not be revoked; it ends at its expiry', (e as Error).message);
    });
  }
  jar.delete(SESSION_COOKIE);
  redirect('/login');
}
