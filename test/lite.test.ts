/**
 * RoofOps Lite: the four n8n workflows built from a config, run with their REAL node code against the demo Airtable
 * (Lite schema enforced: unknown fields, bad select options and bad links are refused) and the TEST message sink.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, WORKFLOWS } from '../lite/build.js';
import { configProblems, loadConfig, type LiteConfig } from '../lite/config/config.js';
import { FakeAirtable } from '../lite/demo/fake-airtable.js';
import { seed, type Seeded } from '../lite/demo/fixtures.js';
import { loadWorkflow, type LoadedWorkflow } from '../lite/tools/load-workflow.js';
import { runNow, runWebhook } from '../lite/tools/runner.js';

type R = Record<string, unknown>;
const OUT = 'lite/dist/.test';
const config = loadConfig('lite/config/demo.json');
const wf: Record<string, LoadedWorkflow> = {};
let at: FakeAirtable;
let ids: Seeded;
const lead = (o: R = {}) => ({ name: 'ZZ Lite Demo Emma Walsh', first_name: 'Emma', phone: '0400 000 201', email: 'emma.walsh@example.test', address: '7 Coral Demo Court',
  suburb: 'Bargara', postcode: '4670', service: 'roof leak repair', source: 'website', consent_sms: true, consent_email: true, demo: true, ...o });
const post = (w: string, body: unknown) => runWebhook(wf[w]!, at.http, body).response!;
const writes = () => at.requests.filter((r) => r.method !== 'GET');
const fresh = () => { at = new FakeAirtable(config.airtable.baseId, config.airtable.tables); ids = seed(at); };
const messages = (workflow: string) => at.all('messages').map((m) => m.fields).filter((m) => m.Workflow === workflow);
const job = (key: string) => at.get('jobs', ids.jobs[key]!)!.fields;

beforeAll(async () => {
  const b = await build('lite/config/demo.json', OUT);
  for (const w of WORKFLOWS) wf[w] = await loadWorkflow(join(b.out, `${w}.sdk.ts`));
}, 60_000);
afterAll(() => { rmSync(OUT, { recursive: true, force: true }); });

describe('configuration and build', () => {
  it('the demo config is valid; the blank template and unsafe values are refused with clear reasons', () => {
    expect(configProblems(config)).toEqual([]);
    const template = JSON.parse(readFileSync('lite/config/template.json', 'utf8')) as LiteConfig;
    expect(configProblems(template).join('\n')).toMatch(/business\.name is missing[\s\S]*airtable\.baseId[\s\S]*googleReviewUrl/);
    const bad = structuredClone(config) as unknown as { messaging: { mode: string }; reviews: { sms: string }; reactivation: { sms: string; stages: string[] } };
    bad.messaging.mode = 'twilio'; bad.reviews.sms = 'no link'; bad.reactivation.sms = 'no way out'; bad.reactivation.stages = ['Sold'];
    expect(configProblems(bad as unknown as LiteConfig).join('\n')).toMatch(/test-sink[\s\S]*\{reviewUrl\}[\s\S]*reactivation\.stages[\s\S]*STOP/);
  });

  it('builds four inactive n8n imports, every connection to a real node, every Airtable call on the configured base with the configured credential', () => {
    for (const w of WORKFLOWS) {
      const j = JSON.parse(readFileSync(join(OUT, `${w}.json`), 'utf8')) as { active: boolean; nodes: R[]; connections: Record<string, { main: { node: string }[][] }> };
      expect(j.active, w).toBe(false);
      const names = new Set(j.nodes.map((n) => n.name));
      for (const [from, c] of Object.entries(j.connections)) { expect(names.has(from), `${w}: ${from}`).toBe(true); for (const t of c.main.flat()) expect(names.has(t.node), `${w}: ${t.node}`).toBe(true); }
      for (const n of j.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest')) {
        expect(String((n.parameters as R).url), `${w}: ${String(n.name)}`).toMatch(new RegExp(`^=?https://api\\.airtable\\.com/v0/${config.airtable.baseId}/`));
        expect(n.credentials, `${w}: ${String(n.name)}`).toEqual({ airtableTokenApi: config.airtable.credential });
      }
      expect(readFileSync(join(OUT, `${w}.sdk.ts`), 'utf8')).toContain(config.business.name);   // config inlined
    }
  });

  it('another business is a config change only: names, review link, webhook path and base all follow the config', async () => {
    const other = structuredClone(config);
    other.business.name = 'ZZ Test Plumbing Co'; other.business.signoff = 'The ZZ Test Plumbing team'; other.reviews.googleReviewUrl = 'https://g.page/r/ZZ-OTHER/review';
    other.leadIntake.webhookPath = 'zz-plumbing/lead'; other.airtable.baseId = 'appZZZZZZZZZZZZZZ';
    const dir = mkdtempSync(join(tmpdir(), 'lite-other-'));
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(dir, 'other.json'), JSON.stringify(other));
      await build(join(dir, 'other.json'), join(OUT, 'other'));
      const sdk = readFileSync(join(OUT, 'other', 'lead-follow-up.sdk.ts'), 'utf8');
      expect(sdk).toContain('ZZ Test Plumbing Co'); expect(sdk).toContain('zz-plumbing/lead'); expect(sdk).toContain('appZZZZZZZZZZZZZZ');
      expect(sdk).not.toContain('Harbourside'); expect(sdk).not.toContain(config.airtable.baseId);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('1-2. lead intake and instant follow-up', () => {
  beforeAll(fresh);

  it('a new lead becomes Contact + Property + Job, is acknowledged once by SMS through the test sink, logged, and moves to Contacted', () => {
    const r = post('lead-follow-up', lead());
    expect(r).toMatchObject({ status: 200, body: { ok: true, duplicate: false, new_contact: true, stage: 'Contacted', acknowledgement: { status: 'Simulated Sent', channel: 'SMS' } } });
    const c = at.all('contacts').find((x) => x.fields.Email === 'emma.walsh@example.test')!;
    expect(c.fields).toMatchObject({ 'First Name': 'Emma', 'Phone Normalized': '0400000201', 'Consent SMS': true, 'Demo Data': true });
    expect(c.fields['Opted Out']).toBeFalsy();
    const j = at.all('jobs').find((x) => (x.fields.Contact as string[])[0] === c.id)!;
    expect(j.fields).toMatchObject({ Stage: 'Contacted', Service: 'roof leak repair', Source: 'Website', 'Invoice Status': 'Not Invoiced' });
    expect(at.get('properties', (j.fields.Property as string[])[0]!)!.fields).toMatchObject({ Address: '7 Coral Demo Court', Contact: [c.id] });
    const m = messages('Lead Follow-Up');
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ Status: 'Simulated Sent', Channel: 'SMS', To: '0400000201', Provider: 'lite-test-sink' });
    expect(String(m[0]!.Body)).toMatch(/^Hi Emma, thanks for contacting Harbourside Roofing \(Lite demo\) about roof leak repair/);
  });

  it('the same person again (same email, or the same phone written as +61): no second contact or job; the repeat is logged, not messaged', () => {
    const before = { c: at.all('contacts').length, j: at.all('jobs').length };
    expect(post('lead-follow-up', lead({ message: 'did you get this?' }))).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(post('lead-follow-up', lead({ email: '', phone: '+61 400 000 201' }))).toMatchObject({ status: 200, body: { duplicate: true } });
    expect({ c: at.all('contacts').length, j: at.all('jobs').length }).toEqual(before);
    expect(messages('Lead Follow-Up').map((m) => m.Status)).toEqual(['Simulated Sent', 'Skipped', 'Skipped']);
  });

  it('an invalid lead is refused (400) and nothing is written', () => {
    const n = writes().length;
    expect(post('lead-follow-up', { name: 'Z', email: 'not-an-email', phone: '123' })).toEqual({ status: 400,
      body: { ok: false, errors: ['name is required', 'email is not a valid address', 'phone is not a valid Australian number', 'an email address or phone number is required'] } });
    expect(writes().length).toBe(n);
  });

  it('no consent: the lead is saved (New Lead) but not messaged; an existing opted-out contact is never messaged', () => {
    expect(post('lead-follow-up', { name: 'ZZ Lite Demo Ethan Cole', email: 'ethan.cole@example.test', source: 'google' }))
      .toMatchObject({ status: 200, body: { stage: 'New Lead', acknowledgement: { status: 'Skipped', reason: 'no consent or no reachable contact detail' } } });
    // Priya opted out earlier; a new enquiry from her is recorded (a new job) but she gets no message.
    expect(post('lead-follow-up', { name: 'ZZ Lite Demo Priya Nair', phone: '0400 000 103', consent_sms: true, service: 'new gutters' }))
      .toMatchObject({ status: 200, body: { duplicate: false, new_contact: false, acknowledgement: { status: 'Skipped', reason: 'opted out' } } });
  });

  it('an Airtable failure fails the run (no false "ok"), and the demo Airtable refuses fields that are not in the Lite schema', () => {
    const real = at.http;
    const failing = (req: Parameters<typeof real>[0]) => (req.method === 'POST' && req.url.endsWith(encodeURIComponent('Lite Jobs')) ? { statusCode: 503, body: { error: 'down' } } : real(req));
    expect(() => runWebhook(wf['lead-follow-up']!, failing, lead({ email: 'ava.z@example.test', phone: '0400 000 299' }))).toThrow(/create job: Airtable HTTP 503/);
    expect(at.http({ method: 'POST', url: `https://api.airtable.com/v0/${config.airtable.baseId}/${encodeURIComponent('Lite Jobs')}`, query: {},
      body: { records: [{ fields: { Stage: 'Sold' } }] } })).toMatchObject({ statusCode: 422 });
  });
});

describe('3. Google review requests', () => {
  beforeAll(fresh);

  it('one request per finished job after the delay, only with consent and never to an opted-out contact; the review link is in the message', () => {
    const { summary } = runNow(wf['review-requests']!, at.http);
    expect(summary).toMatchObject({ finished_jobs: 5, sent: 2, skipped: 2, not_due_yet: 1, skip_reasons: { 'opted out': 1, 'no consent or no reachable contact detail': 1 } });
    expect(job('R1')).toMatchObject({ 'Review Status': 'Sent' });
    expect(job('R2')).toMatchObject({ 'Review Status': 'Sent' });
    expect(job('R3')).toMatchObject({ 'Review Status': 'Skipped', 'Review Skip Reason': 'opted out' });
    expect(job('R4')).toMatchObject({ 'Review Status': 'Skipped' });
    expect(job('R5')['Review Status']).toBeUndefined();                               // finished yesterday: not yet
    const sent = messages('Review Request').filter((m) => m.Status === 'Simulated Sent');
    expect(sent.map((m) => [m.Channel, m.To])).toEqual([['SMS', '0400000101'], ['Email', 'marcus.webb@example.test']]);
    for (const m of sent) expect(String(m.Body)).toContain(config.reviews.googleReviewUrl);
  });

  it('running again asks nobody twice; a request logged but not marked on the job is marked, not resent', () => {
    expect(runNow(wf['review-requests']!, at.http).summary).toMatchObject({ sent: 0, skipped: 0, finished_jobs: 1 });
    delete at.get('jobs', ids.jobs.R1!)!.fields['Review Status'];                    // as if the run had stopped before marking it
    expect(runNow(wf['review-requests']!, at.http).summary).toMatchObject({ sent: 0, already_requested: 1 });
    expect(job('R1')['Review Status']).toBe('Sent');
    expect(messages('Review Request').filter((m) => m.Status === 'Simulated Sent')).toHaveLength(2);
  });
});

describe('4. lead reactivation and replies', () => {
  beforeAll(fresh);

  it('only quiet leads with marketing permission, no opt-out, consent and outside the cooldown get one follow-up; a second run sends none', () => {
    const { summary } = runNow(wf['lead-reactivation']!, at.http);
    expect(summary).toMatchObject({ sent: 2, exclusion_reasons: { 'no marketing permission': 1, 'opted out': 1, 'followed up within the cooldown': 1 } });
    expect(messages('Reactivation').map((m) => [m.To, m.Channel])).toEqual([['mia.rossi@example.test', 'Email'], ['0400000106', 'SMS']]);   // longest-waiting first
    expect(job('A1')).toMatchObject({ 'Reactivation Count': 1 });
    expect(job('A2')['Reactivation Sent At']).toBeUndefined();                         // Sophie: no marketing permission
    expect(job('A3')['Reactivation Sent At']).toBeUndefined();                         // Liam: opted out
    expect(runNow(wf['lead-reactivation']!, at.http).summary).toMatchObject({ sent: 0 });
  });

  it('the run is capped by maxPerRun (oldest first); the rest wait for the next run', async () => {
    const capped = structuredClone(config); capped.reactivation.maxPerRun = 1;
    const dir = mkdtempSync(join(tmpdir(), 'lite-cap-'));
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(dir, 'cap.json'), JSON.stringify(capped));
      await build(join(dir, 'cap.json'), join(OUT, 'cap'));
      const w = await loadWorkflow(join(OUT, 'cap', 'lead-reactivation.sdk.ts'));
      const a = new FakeAirtable(config.airtable.baseId, config.airtable.tables); seed(a);
      const { summary } = runNow(w, a.http);
      expect(summary).toMatchObject({ sent: 1, deferred_to_next_run: 1 });
      expect(a.all('messages').map((m) => m.fields.To)).toEqual(['mia.rossi@example.test']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a reply brings the enquiry back (Last Activity now; a New Lead becomes Contacted); STOP opts the contact out of everything', () => {
    const before = String(job('A1')['Last Activity At']);
    expect(post('inbound-replies', { from: '0400 000 106', text: 'Yes please call me' })).toMatchObject({ status: 200, body: { known_contact: true, opted_out: false, job_ref: 'LJ-DEMO-A1' } });
    expect(Date.parse(String(job('A1')['Last Activity At']))).toBeGreaterThan(Date.parse(before));
    post('lead-follow-up', { name: 'ZZ Lite Demo Ethan Cole', email: 'ethan.cole@example.test' });   // a New Lead with no consent
    expect(post('inbound-replies', { from: 'Ethan.Cole@example.test', text: 'Can you come Tuesday?' })).toMatchObject({ body: { known_contact: true, opted_out: false } });
    expect(at.all('jobs').find((j) => String(j.fields['Job Ref']).startsWith('LJ-2') && (at.get('contacts', (j.fields.Contact as string[])[0]!)!.fields.Email === 'ethan.cole@example.test'))!.fields.Stage).toBe('Contacted');
    expect(post('inbound-replies', { from: '+61400000101', text: ' stop ' })).toMatchObject({ body: { opted_out: true } });
    expect(at.get('contacts', ids.contacts.olivia!)!.fields).toMatchObject({ 'Opted Out': true, 'Marketing Opt-In': false });
    expect(messages('Inbound Reply').map((m) => m.Status)).toEqual(['Received', 'Received', 'Opt-Out']);
    // Olivia is never messaged again: a new finished job of hers is skipped.
    at.insert('jobs', { 'Job Ref': 'LJ-DEMO-R9', Contact: [ids.contacts.olivia!], Stage: 'Completed', 'Completed At': new Date(Date.now() - 5 * 864e5).toISOString(), 'Demo Data': true });
    runNow(wf['review-requests']!, at.http);
    expect(at.all('jobs').find((j) => j.fields['Job Ref'] === 'LJ-DEMO-R9')!.fields).toMatchObject({ 'Review Status': 'Skipped', 'Review Skip Reason': 'opted out' });
  });

  it('a reply from someone unknown is logged (not lost) and answered; an empty reply is refused', () => {
    expect(post('inbound-replies', { from: '0400 999 999', text: 'who is this?' })).toMatchObject({ status: 200, body: { known_contact: false } });
    expect(messages('Inbound Reply').at(-1)).toMatchObject({ Status: 'Received', Reason: 'sender is not in the CRM' });
    expect(post('inbound-replies', { from: '0400 999 999', text: ' ' })).toMatchObject({ status: 400 });
  });

  it('every request went to the configured Airtable base: no message provider or any other host was called', () => {
    expect(at.requests.length).toBeGreaterThan(20);
    expect(at.requests.every((r) => r.url.startsWith(`https://api.airtable.com/v0/${config.airtable.baseId}/`))).toBe(true);
  });
});

describe('Airtable setup (lite/airtable/setup.ts), against a scripted Meta API', () => {
  it('dry run: five tables first, then link fields; the "Lite Jobs" back-link is left to Airtable', async () => {
    const { plan } = await import('../lite/airtable/setup.js');
    const p = plan('appZZZZZZZZZZZZZZ');
    expect(p.slice(0, 5).map((c) => (c.body as { name: string }).name)).toEqual(['Lite Contacts', 'Lite Properties', 'Lite Jobs', 'Lite Quotes', 'Lite Message Log']);
    expect(p.slice(5).map((c) => c.note)).toEqual(['link Lite Properties.Contact -> Lite Contacts', 'link Lite Jobs.Contact -> Lite Contacts', 'link Lite Jobs.Property -> Lite Properties',
      'link Lite Quotes.Job -> Lite Jobs', 'link Lite Message Log.Job -> Lite Jobs', 'link Lite Message Log.Contact -> Lite Contacts']);
    const jobs = (p[2]!.body as { fields: { name: string; options?: { choices?: { name: string }[] } }[] }).fields;
    expect(jobs.find((f) => f.name === 'Stage')!.options!.choices!.map((c) => c.name)).toEqual(['New Lead', 'Contacted', 'Quoted', 'Accepted', 'Job In Progress', 'Completed', 'Invoiced', 'Paid', 'Lost']);
  });

  it('apply creates only (refuses when a Lite table exists, before any write); verify reports what is missing', async () => {
    const { apply, verify } = await import('../lite/airtable/setup.js');
    const calls: string[] = [];
    let n = 0;
    const fake = (existing: string[]) => (path: string, init: { method: string }) => {
      calls.push(`${init.method} ${path}`);
      if (init.method === 'GET') return Promise.resolve({ status: 200, json: { tables: existing.map((name) => ({ name, fields: [] })) } });
      return Promise.resolve({ status: 200, json: { id: `tblZZZZZZZZZZZZ${String(++n).padStart(2, '0')}` } });
    };
    await expect(apply('appZZZZZZZZZZZZZZ', fake(['Quotes', 'Lite Jobs']), () => undefined)).rejects.toThrow(/Lite Jobs already exist[\s\S]*Nothing was changed/);
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);
    const ids = await apply('appZZZZZZZZZZZZZZ', fake(['Customers', 'Quotes']), () => undefined);
    expect(Object.keys(ids)).toEqual(['contacts', 'properties', 'jobs', 'quotes', 'messages']);
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(11);
    expect(calls.some((c) => /DELETE|PATCH/.test(c))).toBe(false);
    expect((await verify('appZZZZZZZZZZZZZZ', fake(['Customers']))).slice(0, 2)).toEqual(['missing table Lite Contacts', 'missing table Lite Properties']);
  });
});
