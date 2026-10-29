/**
 * Signed session tokens for the interview-demo login. Web Crypto only, so the same code runs in the
 * proxy and in route handlers. Token = base64url(payload) "." base64url(HMAC-SHA256(AUTH_SECRET, payload)).
 * Fails closed: without a strong AUTH_SECRET nothing verifies.
 */
export const SESSION_COOKIE = 'roofops_session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** u: display name. A staff session also carries t (the database session token), e (employee code) and r (role). */
export interface Session { u: string; exp: number; t?: string; e?: string; r?: string }

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function secret(): string | null {
  const s = process.env.AUTH_SECRET;
  return s && s.length >= 32 ? s : null;
}

async function hmac(key: string, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

export async function signSession(username: string, staff?: { t: string; e: string; r: string }): Promise<string> {
  const key = secret();
  if (!key) throw new Error('AUTH_SECRET is not configured (min 32 characters)');
  const payload = b64url(enc.encode(JSON.stringify({ u: username, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS, ...staff } satisfies Session)));
  return `${payload}.${b64url(await hmac(key, payload))}`;
}

export async function verifySession(token: string | undefined | null): Promise<Session | null> {
  const key = secret();
  if (!key || !token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = new Uint8Array(await hmac(key, payload));
  let given: Uint8Array;
  try { given = fromB64url(sig); } catch { return null; }
  if (given.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ given[i]!;
  if (diff !== 0) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Session;
    const optional = (v: unknown) => v === undefined || typeof v === 'string';
    return typeof s.u === 'string' && typeof s.exp === 'number' && s.exp > Date.now() / 1000 && optional(s.t) && optional(s.e) && optional(s.r) ? s : null;
  } catch {
    return null;
  }
}
