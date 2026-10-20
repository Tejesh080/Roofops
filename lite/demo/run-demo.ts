/**
 * RoofOps Lite local demo. Builds the four workflows for a config, then runs their REAL node code against an in-memory
 * Airtable (the Lite schema) and the TEST message sink. Lead and reply events arrive as real HTTP requests to a local
 * webhook server (127.0.0.1), exactly as a website form or SMS provider would send them. Nothing leaves this machine.
 *
 *   npx tsx lite/demo/run-demo.ts [lite/config/demo.json]
 *
 * Writes lite/demo/output/demo-report.md and lite/demo/output/airtable-after.json.
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { build } from '../build.js';
import { loadConfig } from '../config/config.js';
import { loadWorkflow } from '../tools/load-workflow.js';
import { runNow, runWebhook } from '../tools/runner.js';
import { FakeAirtable } from './fake-airtable.js';
import { seed } from './fixtures.js';

export async function demo(configFile = 'lite/config/demo.json', outDir = 'lite/demo/output', quiet = false) {
  const log = (...a: unknown[]) => { if (!quiet) console.log(...a); };
  const config = loadConfig(configFile);
  const built = await build(configFile, join(outDir, 'workflows'));
  const wf: Record<string, Awaited<ReturnType<typeof loadWorkflow>>> = {};
  for (const w of ['lead-follow-up', 'review-requests', 'lead-reactivation', 'inbound-replies']) wf[w] = await loadWorkflow(join(built.out, `${w}.sdk.ts`));   // one at a time: one recorder
  const at = new FakeAirtable(config.airtable.baseId, config.airtable.tables);
  const seeded = seed(at);
  let exec = 0;

  // The webhook server: POST /webhook/<path> runs the workflow whose webhook has that path.
  const routes: Record<string, keyof typeof wf> = { [`/webhook/${config.leadIntake.webhookPath}`]: 'lead-follow-up', [`/webhook/${config.replies.webhookPath}`]: 'inbound-replies' };
  const server = createServer((req, res) => {
    const name = routes[req.url ?? ''];
    if (req.method !== 'POST' || !name) { res.writeHead(404).end(); return; }
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => {
      try {
        const r = runWebhook(wf[name]!, at.http, raw ? JSON.parse(raw) : {}, `local-${++exec}`);
        res.writeHead(r.response!.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.response!.body));
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: (e as Error).message })); }
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}/webhook/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };

  const steps: { step: string; result: unknown }[] = [];
  const note = (step: string, result: unknown) => { steps.push({ step, result }); log(`\n## ${step}\n`, JSON.stringify(result, null, 1)); };
  try {
    const lead = { name: 'ZZ Lite Demo Emma Walsh', first_name: 'Emma', phone: '0400 000 201', email: 'emma.walsh@example.test', suburb: 'Bargara', address: '7 Coral Demo Court',
      postcode: '4670', service: 'roof leak repair', message: 'Water coming through the ceiling after last night\'s storm.', source: 'website',
      consent_sms: true, consent_email: true, marketing_opt_in: false, preferred_channel: 'sms', demo: true };
    note('1. New website lead (HTTP POST to the lead webhook)', await post(config.leadIntake.webhookPath, lead));
    note('2. The same person submits the form again (duplicate)', await post(config.leadIntake.webhookPath, { ...lead, message: 'Just checking you got this?' }));
    note('3. An invalid lead (no phone or email)', await post(config.leadIntake.webhookPath, { name: 'ZZ Lite Demo Nobody', source: 'Facebook', demo: true }));
    note('4. A lead that gave an email but no consent to be messaged', await post(config.leadIntake.webhookPath,
      { name: 'ZZ Lite Demo Ethan Cole', first_name: 'Ethan', email: 'ethan.cole@example.test', service: 'gutter clean', source: 'google', demo: true }));
    note('5. Google review requests: first run', runNow(wf['review-requests']!, at.http, `local-${++exec}`).summary);
    note('6. Google review requests: run again (no one is asked twice)', runNow(wf['review-requests']!, at.http, `local-${++exec}`).summary);
    note('7. Lead reactivation: first run', runNow(wf['lead-reactivation']!, at.http, `local-${++exec}`).summary);
    note('8. Lead reactivation: run again (cooldown, nobody messaged twice)', runNow(wf['lead-reactivation']!, at.http, `local-${++exec}`).summary);
    note('9. Daniel replies YES to the reactivation SMS', await post(config.replies.webhookPath, { from: '0400 000 106', text: 'Yes please, call me this week', demo: true }));
    note('10. Olivia replies STOP', await post(config.replies.webhookPath, { from: '+61 400 000 101', text: 'STOP', demo: true }));
    note('11. Reactivation again after the replies (Daniel is active again, Olivia opted out)', runNow(wf['lead-reactivation']!, at.http, `local-${++exec}`).summary);
  } finally { server.close(); }

  // Report
  const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  const name = (key: 'contacts' | 'jobs', id?: string) => (id ? text((at.get(key, id)?.fields ?? {})[key === 'contacts' ? 'Name' : 'Job Ref']) || id : '');
  const messages = at.all('messages').map((m) => m.fields);
  const stages = ['New Lead', 'Contacted', 'Quoted', 'Accepted', 'Job In Progress', 'Completed', 'Invoiced', 'Paid', 'Lost'];
  const pipeline = stages.map((s) => ({ stage: s, jobs: at.all('jobs').filter((j) => j.fields.Stage === s).map((j) => String(j.fields['Job Ref'])) }));
  const md = [
    `# RoofOps Lite demo run (${new Date().toISOString()})`, '',
    `Config: \`${configFile}\` (${config.business.name}). Messaging: **${config.messaging.mode}**, nothing was sent to a real phone or inbox.`,
    `Workflows built into \`${built.out}\`: ${built.summary.map((s) => `${s.name} (${s.nodes} nodes)`).join(', ')}.`, '',
    '## Steps', '', ...steps.flatMap((s) => [`### ${s.step}`, '', '```json', JSON.stringify(s.result, null, 1), '```', '']),
    '## Pipeline after the run (Lite Jobs by Stage)', '', '| Stage | Jobs |', '|---|---|', ...pipeline.map((p) => `| ${p.stage} | ${p.jobs.join(', ') || '-'} |`), '',
    '## Message Log', '', '| Workflow | Contact | Job | Channel | Status | Reason / To |', '|---|---|---|---|---|---|',
    ...messages.map((m) => `| ${String(m.Workflow)} | ${name('contacts', (m.Contact as string[] | undefined)?.[0])} | ${name('jobs', (m.Job as string[] | undefined)?.[0])} | ${text(m.Channel)} | ${text(m.Status)} | ${text(m.Reason) || text(m.To)} |`), '',
    '## Sample message bodies', '', ...messages.filter((m) => m.Status === 'Simulated Sent').slice(0, 4).flatMap((m) => [`**${String(m.Workflow)} to ${String(m.To)} (${String(m.Channel)})**`, '', '```', String(m.Body), '```', '']),
  ].join('\n');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'demo-report.md'), md);
  writeFileSync(join(outDir, 'airtable-after.json'), JSON.stringify(Object.fromEntries([...at.tables.entries()].map(([k, v]) => [k, [...v.values()]])), null, 1));
  log(`\nReport: ${join(outDir, 'demo-report.md')}`);
  return { at, steps, seeded, messages, pipeline };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('lite/demo/run-demo.ts')) {
  demo(process.argv[2]).catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}
