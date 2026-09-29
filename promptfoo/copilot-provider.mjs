/**
 * Promptfoo provider for the RoofOps Operations Copilot: calls the REAL /api/copilot of the running web app
 * (npm run dev in web/) with a session signed locally from web/.env.local, exactly as a signed-in user would.
 * Returns JSON the assertions can check structurally: reply, tools called (with tier), cards, and whether the
 * reply contains any server secret (the secrets themselves never leave this process).
 */
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import pg from 'pg';

for (const f of ['web/.env.local', '.env', '.env.local']) if (existsSync(f)) process.loadEnvFile(f);
const BASE = process.env.COPILOT_EVAL_URL ?? 'http://127.0.0.1:3000';

const b64url = (b) => Buffer.from(b).toString('base64url');
function sessionCookie() {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('AUTH_SECRET missing (web/.env.local)');
  const payload = b64url(JSON.stringify({ u: process.env.DEMO_USERNAME ?? 'kyle', exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `roofops_session=${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function secretValues() {
  const out = [];
  for (const k of ['DEEPSEEK_API_KEY', 'AUTH_SECRET', 'DEMO_PASSWORD', 'RECONCILE_TRIGGER_TOKEN', 'N8N_API_KEY']) if (process.env[k]?.length >= 8) out.push(process.env[k]);
  for (const k of ['DASHBOARD_DATABASE_URL', 'SUPABASE_DB_URL']) {
    const v = process.env[k];
    if (v) { try { const u = new URL(v); if (u.password) out.push(decodeURIComponent(u.password)); out.push(v); } catch { /* not a URL */ } }
  }
  return out;
}

/** Identifiers created during the run (e.g. an approval number from "Prepare invoice"), read with the dashboard's read-only role. */
async function liveIds() {
  const url = process.env.DASHBOARD_DATABASE_URL;
  if (!url) return [];
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try { return (await c.query("select pending_approval_number v from v_dashboard_projects where pending_approval_number is not null")).rows.map((r) => r.v); }
  finally { await c.end(); }
}

export default class CopilotProvider {
  id() { return 'roofops-copilot'; }
  async callApi(prompt) {
    const res = await fetch(`${BASE}/api/copilot`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: sessionCookie() },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(120_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: `HTTP ${res.status}: ${body.error ?? ''}` };
    const reply = String(body.reply ?? '');
    const leaked = secretValues().some((s) => reply.includes(s));
    return { output: JSON.stringify({ reply, tools: (body.steps ?? []).map((s) => ({ tool: s.tool, tier: s.tier })), cards: (body.cards ?? []).map((c) => c.kind), leaked_secret: leaked, live_ids: await liveIds() }) };
  }
}
