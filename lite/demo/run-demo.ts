/**
 * RoofOps Lite local demo. Builds the five workflows for a config, then runs their REAL node code against an in-memory
 * Airtable (the Lite schema) and either the TEST message sink (test-sink configs) or a local fake of the Twilio API
 * (twilio configs). Leads and Twilio's webhooks arrive as real HTTP requests to a local server (127.0.0.1), the way a
 * website form and Twilio send them (Twilio's are form-encoded and signed). Nothing leaves this machine.
 *
 *   npx tsx lite/demo/run-demo.ts                                                   test sink (lite/config/demo.json)
 *   npx tsx lite/demo/run-demo.ts lite/config/example-plumbing-twilio.json lite/demo/output-twilio    Twilio, simulated
 *
 * In twilio mode the live allowlist is replaced, in this local run only, by the synthetic fixture numbers.
 * Writes <outDir>/demo-report.md and <outDir>/airtable-after.json.
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, WORKFLOWS } from '../build.js';
import { loadConfig } from '../config/config.js';
import { loadWorkflow, type LoadedWorkflow } from '../tools/load-workflow.js';
import { runNow, runWebhook } from '../tools/runner.js';
import { FakeAirtable } from './fake-airtable.js';
import { FakeTwilio, route } from './fake-twilio.js';
import { seed } from './fixtures.js';

const FIXTURE_NUMBERS = ['101', '103', '105', '106', '107', '109', '111', '112', '113', '201', '301', '302'].map((n) => `+61400000${n}`);

export async function demo(configFile = 'lite/config/demo.json', outDir = 'lite/demo/output', quiet = false) {
  const log = (...a: unknown[]) => { if (!quiet) console.log(...a); };
  const config = loadConfig(configFile);
  const twilio = config.messaging.mode === 'twilio';
  if (twilio) config.messaging.twilio!.allowedRecipients = [...FIXTURE_NUMBERS, ...(config.monitoring.operatorPhone ? [config.monitoring.operatorPhone] : [])];
  const tmp = mkdtempSync(join(tmpdir(), 'lite-demo-'));
  writeFileSync(join(tmp, 'config.json'), JSON.stringify(config));
  const built = await build(join(tmp, 'config.json'), join(outDir, 'workflows'));
  rmSync(tmp, { recursive: true, force: true });
  const wf: Record<string, LoadedWorkflow> = {};
  for (const w of WORKFLOWS) wf[w] = await loadWorkflow(join(built.out, `${w}.sdk.ts`));   // one at a time: one recorder
  const at = new FakeAirtable(config.airtable.baseId, config.airtable.tables);
  const seeded = seed(at);
  const tw = twilio ? new FakeTwilio(config.messaging.twilio!.accountSid) : null;
  const http = tw ? route(tw, at.http) : at.http;
  const vars = { [config.messaging.twilio?.signatureVariable ?? 'LITE_TWILIO_AUTH_TOKEN']: tw?.authToken ?? '' };
  let exec = 0;

  // The local server: POST /webhook/<path>[?event=status] runs the workflow whose webhook has that path.
  const routes: Record<string, string> = { [`/webhook/${config.leadIntake.webhookPath}`]: 'lead-follow-up', [`/webhook/${config.replies.webhookPath}`]: 'inbound-replies' };
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://local');
    const name = routes[u.pathname];
    if (req.method !== 'POST' || !name) { res.writeHead(404).end(); return; }
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => {
      try {
        const form = String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded');
        const body: unknown = form ? Object.fromEntries(new URLSearchParams(raw)) : raw ? JSON.parse(raw) : {};
        const r = runWebhook(wf[name]!, http, body, { executionId: `local-${++exec}`, vars, query: Object.fromEntries(u.searchParams),
          headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])) });
        const text = typeof r.response!.body === 'string';
        res.writeHead(r.response!.status, { 'content-type': text ? 'text/xml' : 'application/json' }).end(text ? String(r.response!.body) : JSON.stringify(r.response!.body));
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: (e as Error).message })); }
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}/webhook/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  /** A reply or a delivery receipt, the way Twilio sends it: form-encoded, signed for the public n8n URL. Test sink: JSON. */
  const fromPhone = async (from: string, text: string) => {
    if (!tw) return post(config.replies.webhookPath, { from, text, demo: true });
    const p = tw.inbound(from, config.messaging.twilio!.from ?? '', text);
    const r = await fetch(`${base}/webhook/${config.replies.webhookPath}`, { method: 'POST', body: new URLSearchParams(p).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': tw.sign(`${config.n8n.baseUrl}/webhook/${config.replies.webhookPath}`, p) } });
    return { status: r.status, body: await r.text() };
  };
  const receipt = async (sid: string, status: string) => {
    const p = tw!.statusCallback(sid, status);
    const r = await fetch(`${base}/webhook/${config.replies.webhookPath}?event=status`, { method: 'POST', body: new URLSearchParams(p).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': tw!.sign(`${config.n8n.baseUrl}/webhook/${config.replies.webhookPath}?event=status`, p) } });
    return { status: r.status };
  };
  const run = (w: string) => runNow(wf[w]!, http, { executionId: `local-${++exec}`, vars }).summary;
  const tick = (logRef: string, fields: Record<string, unknown>) => {
    const m = at.all('messages').find((x) => x.fields['Log Ref'] === logRef)!;
    at.http({ method: 'PATCH', url: `https://api.airtable.com/v0/${config.airtable.baseId}/${encodeURIComponent(config.airtable.tables.messages)}`, query: {}, body: { records: [{ id: m.id, fields }] } });
  };

  const steps: { step: string; result: unknown }[] = [];
  const note = (step: string, result: unknown) => { steps.push({ step, result }); log(`\n## ${step}\n`, JSON.stringify(result, null, 1)); };
  try {
    const lead = { name: 'ZZ Lite Demo Emma Walsh', first_name: 'Emma', phone: '0400 000 201', email: 'emma.walsh@example.test', suburb: 'Bargara', address: '7 Coral Demo Court',
      postcode: '4670', service: 'roof leak repair', message: 'Water coming through the ceiling after last night\'s storm.', source: 'website',
      consent_sms: true, consent_email: true, consent_reviews: true, marketing_opt_in: false, preferred_channel: 'sms', demo: true };
    note('1. New website lead (HTTP POST to the lead webhook)', await post(config.leadIntake.webhookPath, lead));
    note('2. The same person submits the form again (duplicate)', await post(config.leadIntake.webhookPath, { ...lead, message: 'Just checking you got this?' }));
    note('3. An invalid lead (no phone or email)', await post(config.leadIntake.webhookPath, { name: 'ZZ Lite Demo Nobody', source: 'Facebook', demo: true }));
    note('4. A lead that gave an email but no consent to be messaged', await post(config.leadIntake.webhookPath,
      { name: 'ZZ Lite Demo Ethan Cole', first_name: 'Ethan', email: 'ethan.cole@example.test', service: 'gutter clean', source: 'google', demo: true }));
    note('5. Google review requests: first run', run('review-requests'));
    note('6. Google review requests: run again (no one is asked twice)', run('review-requests'));
    note('7. Lead reactivation: first run', run('lead-reactivation'));
    note('8. Lead reactivation: run again (cooldown, nobody messaged twice)', run('lead-reactivation'));
    note('9. Daniel replies YES to the reactivation SMS', await fromPhone('+61400000106', 'Yes please, call me this week'));
    note('10. Olivia replies STOP', await fromPhone('+61400000101', 'STOP'));
    note('11. Reactivation again after the replies (Daniel is active again, Olivia opted out)', run('lead-reactivation'));
    if (tw) {
      const emma = at.all('messages').find((m) => m.fields.Workflow === 'Lead Follow-Up' && m.fields.Status === 'Sent')!;
      note('12. Twilio reports Emma\'s acknowledgement delivered (signed status callback)', await receipt(String(emma.fields['Provider Message ID']), 'delivered'));
      tw.rules.set('+61400000301', 'invalid');
      note('13. A lead whose mobile number Twilio refuses (error 21211)', await post(config.leadIntake.webhookPath,
        { name: 'ZZ Lite Demo Sam Typo', first_name: 'Sam', phone: '0400 000 301', service: 'blocked drain', consent_sms: true, demo: true }));
    }
    note(`${tw ? '14' : '12'}. Monitor: failed and unconfirmed messages, leads nobody contacted, finished jobs without a date`, run('monitor'));
    if (tw) {
      const failed = at.all('messages').find((m) => m.fields.Status === 'Failed')!;
      tick(String(failed.fields['Log Ref']), { To: '0400000302', 'Retry Requested': true });
      note('15. Staff fix the number and tick Retry Requested; Twilio refused it, so Monitor resends it once', run('monitor'));
      note('16. Monitor again: nothing is resent', run('monitor'));
    }
  } finally { server.close(); }

  // Report
  const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  const name = (key: 'contacts' | 'jobs', id?: string) => (id ? text((at.get(key, id)?.fields ?? {})[key === 'contacts' ? 'Name' : 'Job Ref']) || id : '');
  const messages = at.all('messages').map((m) => m.fields);
  const stages = ['New Lead', 'Contacted', 'Quoted', 'Accepted', 'Job In Progress', 'Completed', 'Invoiced', 'Paid', 'Lost'];
  const pipeline = stages.map((s) => ({ stage: s, jobs: at.all('jobs').filter((j) => j.fields.Stage === s).map((j) => String(j.fields['Job Ref'])) }));
  const sentOk = (m: Record<string, unknown>) => m.Status === 'Simulated Sent' || m.Status === 'Sent' || m.Status === 'Delivered';
  const md = [
    `# RoofOps Lite demo run (${new Date().toISOString()})`, '',
    `Config: \`${configFile}\` (${config.business.name}). Messaging: **${config.messaging.mode}**${tw ? ' against a LOCAL FAKE of the Twilio API (signed webhooks, real error codes)' : ''}: nothing was sent to a real phone or inbox.`,
    `Workflows built into \`${built.out}\`: ${built.summary.map((s) => `${s.name} (${s.nodes} nodes)`).join(', ')}.`, '',
    '## Steps', '', ...steps.flatMap((s) => [`### ${s.step}`, '', '```json', JSON.stringify(s.result, null, 1), '```', '']),
    '## Pipeline after the run (Lite Jobs by Stage)', '', '| Stage | Jobs |', '|---|---|', ...pipeline.map((p) => `| ${p.stage} | ${p.jobs.join(', ') || '-'} |`), '',
    '## Message Log', '', '| Workflow | Purpose | Contact | Job | Channel | Status | Reason / To |', '|---|---|---|---|---|---|---|',
    ...messages.map((m) => `| ${String(m.Workflow)} | ${text(m.Purpose)} | ${name('contacts', (m.Contact as string[] | undefined)?.[0])} | ${name('jobs', (m.Job as string[] | undefined)?.[0])} | ${text(m.Channel)} | ${text(m.Status)} | ${text(m.Reason) || text(m.To)} |`), '',
    '## Lite Alerts', '', '| Kind | Record | Detail |', '|---|---|---|', ...at.all('alerts').map((a) => `| ${text(a.fields.Kind)} | ${text(a.fields['Record Ref'])} | ${text(a.fields.Detail)} |`), '',
    ...(tw ? ['## What the fake Twilio received (accepted messages)', '', '| To | Body |', '|---|---|', ...tw.sent.map((m) => `| ${m.to} | ${m.body.replace(/\n/g, ' ')} |`), ''] : []),
    '## Sample message bodies', '', ...messages.filter(sentOk).slice(0, 4).flatMap((m) => [`**${String(m.Workflow)} to ${String(m.To)} (${String(m.Channel)})**`, '', '```', String(m.Body), '```', '']),
  ].join('\n');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'demo-report.md'), md);
  writeFileSync(join(outDir, 'airtable-after.json'), JSON.stringify(Object.fromEntries([...at.tables.entries()].map(([k, v]) => [k, [...v.values()]])), null, 1));
  log(`\nReport: ${join(outDir, 'demo-report.md')}`);
  return { at, steps, seeded, messages, pipeline, twilio: tw };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('lite/demo/run-demo.ts')) {
  demo(process.argv[2], process.argv[3]).catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}
