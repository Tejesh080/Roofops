import { query } from '@/lib/db';
import { getHealthz } from '@/lib/healthz';

export const dynamic = 'force-dynamic';

/**
 * Public, for an outside uptime monitor (master plan Task 1.2): 200 when nothing needs a person, 503 when something
 * does or the database cannot be read. States and counts only (web/lib/health.ts healthzVerdict); no session needed,
 * so the proxy lets this one path through. Read-only, through the dashboard's least-privilege role.
 */
export async function GET() {
  const headers = { 'cache-control': 'no-store' };
  try {
    const v = await getHealthz(query);
    return Response.json(v, { status: v.status === 'ok' ? 200 : 503, headers });
  } catch {
    return Response.json({ status: 'unavailable', reasons: ['the RoofOps database could not be read'] }, { status: 503, headers });
  }
}
