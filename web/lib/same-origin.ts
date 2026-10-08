/**
 * CSRF guard for the JSON API (server actions get Next's own origin check). A request from another site is refused:
 * a browser always sends Origin on a cross-site POST, and only a same-site page can send application/json without a
 * CORS preflight this server never answers. A request with no Origin (not a browser form) still needs the session
 * cookie, which is SameSite=Lax.
 */
export function sameOriginJson(req: Request): boolean {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return false;
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
