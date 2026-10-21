/**
 * RoofOps Lite: the five n8n workflows built from a config, run with their REAL node code against the demo Airtable
 * (Lite schema enforced: unknown fields, bad select options and bad links are refused), the TEST message sink, and a
 * local fake of the Twilio API and webhooks (lite/demo/fake-twilio.ts). Nothing leaves this machine.
 * The acceptance tests A-H of the client-ready MVP are marked in the test names.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, WORKFLOWS } from '../lite/build.js';
import { configProblems, loadConfig, type LiteConfig } from '../lite/config/config.js';
import { FakeAirtable } from '../lite/demo/fake-airtable.js';
import { FakeTwilio, route } from '../lite/demo/fake-twilio.js';
import { seed, type Seeded } from '../lite/demo/fixtures.js';
import { loadWorkflow, type LoadedWorkflow } from '../lite/tools/load-workflow.js';
import { runError, runNow, runWebhook, type HttpReq } from '../lite/tools/runner.js';

type R = Record<string, unknown>;
type Wfs = Record<(typeof WORKFLOWS)[number], LoadedWorkflow>;
const OUT = 'lite/dist/.test';
const config = loadConfig('lite/config/demo.json');
const lead = (o: R = {}) => ({ name: 'ZZ Lite Demo Emma Walsh', first_name: 'Emma', phone: '0400 000 201', email: 'emma.walsh@example.test', address: '7 Coral Demo Court',
  suburb: 'Bargara', postcode: '4670', service: 'roof leak repair', source: 'website', consent_sms: true, consent_email: true, demo: true, ...o });
const daysAgo = (d: number) => new Date(Date.now() - d * 864e5).toISOString();

/** Builds a config into OUT/<name> and loads its five workflows (one at a time: one recorder). */
async function buildAll(cfg: LiteConfig, name: string): Promise<Wfs> {
  const dir = mkdtempSync(join(tmpdir(), 'lite-cfg-'));
  try {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(cfg));
    const b = await build(join(dir, `${name}.json`), join(OUT, name));
    const wf = {} as Wfs;
    for (const w of WORKFLOWS) wf[w] = await loadWorkflow(join(b.out, `${w}.sdk.ts`));
    return wf;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const imports = (name: string, w: string) => JSON.parse(readFileSync(join(OUT, name, `${w}.json`), 'utf8')) as { active: boolean; settings: R; nodes: R[]; connections: Record<string, { main: { node: string }[][] }> };

let wf: Wfs;
beforeAll(async () => { wf = await buildAll(config, 'demo'); }, 60_000);
afterAll(() => { rmSync(OUT, { recursive: true, force: true }); });

// ---- test-sink world (the demo config) ------------------------------------------------------------------------------
let at: FakeAirtable;
let ids: Seeded;
const fresh = () => { at = new FakeAirtable(config.airtable.baseId, config.airtable.tables); ids = seed(at); };
const post = (w: 'lead-follow-up' | 'inbound-replies', body: unknown) => runWebhook(wf[w], at.http, body).response!;
const writes = () => at.requests.filter((r) => r.method !== 'GET');
const messages = (workflow: string) => at.all('messages').map((m) => m.fields).filter((m) => m.Workflow === workflow);
const job = (key: string) => at.get('jobs', ids.jobs[key]!)!.fields;

describe('configuration and build', () => {
  it('the demo config is valid; the blank template and unsafe values are refused with clear reasons', () => {
    expect(configProblems(config)).toEqual([]);
    const template = JSON.parse(readFileSync('lite/config/template.json', 'utf8')) as LiteConfig;
    expect(configProblems(template).join('\n')).toMatch(/business\.name is missing[\s\S]*airtable\.baseId[\s\S]*n8n\.baseUrl[\s\S]*googleReviewUrl/);
    const bad = structuredClone(config);
    bad.reviews.sms = 'no link'; bad.reactivation.sms = 'Hi, come back'; bad.reactivation.stages = ['Sold']; bad.leadIntake.sms = 'Thanks!';
    expect(configProblems(bad).join('\n')).toMatch(/\{reviewUrl\}[\s\S]*leadIntake\.sms must identify the sender[\s\S]*reactivation\.sms must tell people how to opt out[\s\S]*reactivation\.stages/);
  });

  it('Twilio mode is refused without a sender that can receive STOP, without a live-test allowlist, or with an unknown account', () => {
    const t = loadConfig('lite/config/example-plumbing-twilio.json');
    expect(configProblems(t)).toEqual([]);
    const bad = structuredClone(t);
    bad.messaging.twilio!.from = 'ZZPlumbing'; bad.messaging.twilio!.allowedRecipients = []; bad.messaging.twilio!.accountSid = 'AC123';
    expect(configProblems(bad).join('\n')).toMatch(/accountSid[\s\S]*alphanumeric sender cannot receive STOP[\s\S]*allowedRecipients is empty/);
    bad.messaging.twilio = null;
    expect(configProblems(bad).join()).toMatch(/messaging\.twilio is required/);
  });

  it('trial and n8n Starter options are checked: a Twilio template instead of a sender, the credential type, Basic or Header Auth needing their credential', () => {
    const t = loadConfig('lite/config/example-plumbing-twilio.json');
    const trial = structuredClone(t);
    Object.assign(trial.messaging.twilio!, { from: null, trialTemplate: 'sms_appointment_reminders', credentialType: 'twilioApi', inboundAuth: 'basic-auth',
      inboundCredential: { id: 'ZZExampleHook001', name: 'ZZ reply webhook login' }, statusCallbacks: true });
    expect(configProblems(trial)).toEqual([]);
    const bad = structuredClone(trial);
    Object.assign(bad.messaging.twilio!, { from: '+61491570006', credentialType: 'apiKey' });
    expect(configProblems(bad).join('\n')).toMatch(/trialTemplate sends from Twilio's trial number: leave from and messagingServiceSid empty[\s\S]*credentialType must be "twilioApi" or "httpBasicAuth"/);
    Object.assign(bad.messaging.twilio!, { from: null, trialTemplate: 'my_own_text', credentialType: 'twilioApi', inboundAuth: 'header-auth', inboundCredential: null });
    expect(configProblems(bad).join('\n')).toMatch(/trialTemplate must be one of Twilio's trial templates \(sms_2fa, [\s\S]*inboundCredential must be/);
    Object.assign(bad.messaging.twilio!, { trialTemplate: null });
    expect(configProblems(bad).join()).toMatch(/needs exactly one of from \(an E\.164 number\) or messagingServiceSid/);
  });

  it('builds five inactive n8n imports with the business timezone, every connection to a real node, every Airtable call on the configured base and credential', () => {
    for (const w of WORKFLOWS) {
      const j = imports('demo', w);
      expect(j.active, w).toBe(false);
      expect(j.settings, w).toMatchObject({ timezone: 'Australia/Brisbane', executionOrder: 'v1' });
      const names = new Set(j.nodes.map((n) => n.name));
      for (const [from, c] of Object.entries(j.connections)) { expect(names.has(from), `${w}: ${from}`).toBe(true); for (const x of c.main.flat()) expect(names.has(x.node), `${w}: ${x.node}`).toBe(true); }
      for (const n of j.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest')) {
        expect(String((n.parameters as R).url), `${w}: ${String(n.name)}`).toMatch(new RegExp(`^=?(https://api\\.airtable\\.com/v0/${config.airtable.baseId}/|\\{\\{ \\$json\\.(url|write\\.url) \\}\\})`));
        expect(n.credentials, `${w}: ${String(n.name)}`).toEqual({ airtableTokenApi: config.airtable.credential });
      }
      expect(readFileSync(join(OUT, 'demo', `${w}.sdk.ts`), 'utf8')).toContain(config.business.name);   // config inlined
    }
    expect(imports('demo', 'monitor').nodes.map((n) => n.type)).toContain('n8n-nodes-base.errorTrigger');
  });
});

describe('A. lead intake creates the CRM records (test sink)', () => {
  beforeAll(fresh);

  it('a new lead becomes Contact (with its consent, source, time and wording) + Property + Job, is acknowledged once and moves to Contacted', () => {
    const r = post('lead-follow-up', lead({ consent_reviews: true, source_url: 'https://harbourside.example/contact' }));
    expect(r).toMatchObject({ status: 200, body: { ok: true, duplicate: false, new_contact: true, stage: 'Contacted', acknowledgement: { status: 'Simulated Sent', channel: 'SMS' } } });
    const c = at.all('contacts').find((x) => x.fields.Email === 'emma.walsh@example.test')!;
    expect(c.fields).toMatchObject({ 'First Name': 'Emma', 'Phone Normalized': '0400000201', 'Consent SMS': true, 'Review Opt-In': true, 'Marketing Opt-In': false, 'Demo Data': true,
      'Consent Source': 'Website form (https://harbourside.example/contact)' });
    expect(String(c.fields['Consent Wording'])).toBe(`${config.consent.wording.service} [SMS, email]\n${config.consent.wording.reviews}`);
    expect(Date.now() - Date.parse(String(c.fields['Consent Recorded At']))).toBeLessThan(60_000);
    const j = at.all('jobs').find((x) => (x.fields.Contact as string[])[0] === c.id)!;
    expect(j.fields).toMatchObject({ Stage: 'Contacted', Service: 'roof leak repair', Source: 'Website', 'Invoice Status': 'Not Invoiced' });
    expect(at.get('properties', (j.fields.Property as string[])[0]!)!.fields).toMatchObject({ Address: '7 Coral Demo Court', Contact: [c.id] });
    const m = messages('Lead Follow-Up');
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ Status: 'Simulated Sent', Purpose: 'Operational', Channel: 'SMS', To: '0400000201', Provider: 'lite-test-sink', Attempts: 1 });
    expect(String(m[0]!['Provider Message ID'])).toMatch(/^SIM/);
    expect(String(m[0]!.Body)).toMatch(/^Hi Emma, thanks for contacting Harbourside Roofing \(Lite demo\) about roof leak repair/);
  });

  it('C (test sink). The same person again (same email, or the same phone written as +61): no second contact, job or message', () => {
    const before = { c: at.all('contacts').length, j: at.all('jobs').length };
    expect(post('lead-follow-up', lead({ message: 'did you get this?' }))).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(post('lead-follow-up', lead({ email: '', phone: '+61 400 000 201' }))).toMatchObject({ status: 200, body: { duplicate: true } });
    expect({ c: at.all('contacts').length, j: at.all('jobs').length }).toEqual(before);
    expect(messages('Lead Follow-Up').map((m) => m.Status)).toEqual(['Simulated Sent', 'Skipped', 'Skipped']);
  });

  it('an invalid lead is refused (400) and nothing is written; a bot filling the hidden field gets a quiet "ok" and nothing is saved', () => {
    const n = writes().length;
    expect(post('lead-follow-up', { name: 'Z', email: 'not-an-email', phone: '123' })).toEqual({ status: 400,
      body: { ok: false, errors: ['name is required', 'email is not a valid address', 'phone is not a valid Australian number', 'an email address or phone number is required'] } });
    expect(post('lead-follow-up', lead({ name: 'ZZ Bot', email: 'bot@example.test', website: 'http://spam.example' }))).toEqual({ status: 200, body: { ok: true } });
    expect(writes().length).toBe(n);
  });

  it('no consent: saved (New Lead) but not messaged, and no consent is recorded; an opted-out contact is never messaged and the opt-out stands', () => {
    expect(post('lead-follow-up', { name: 'ZZ Lite Demo Ethan Cole', email: 'ethan.cole@example.test', source: 'google' }))
      .toMatchObject({ status: 200, body: { stage: 'New Lead', acknowledgement: { status: 'Skipped', reason: 'no consent or no reachable contact detail' } } });
    const ethan = at.all('contacts').find((x) => x.fields.Email === 'ethan.cole@example.test')!.fields;
    expect(ethan['Consent Recorded At']).toBeUndefined(); expect(ethan['Consent Source']).toBeUndefined();
    expect(post('lead-follow-up', { name: 'ZZ Lite Demo Priya Nair', phone: '0400 000 103', consent_sms: true, marketing_opt_in: true, service: 'new gutters' }))
      .toMatchObject({ status: 200, body: { duplicate: false, new_contact: false, acknowledgement: { status: 'Skipped', reason: 'opted out' } } });
    expect(at.get('contacts', ids.contacts.priya!)!.fields).toMatchObject({ 'Opted Out': true });
    expect(at.get('contacts', ids.contacts.priya!)!.fields['Marketing Opt-In']).toBeFalsy();
  });

  it('a returning person who ticks a new box: the consent is added to their contact with its evidence (nothing is removed)', () => {
    expect(post('lead-follow-up', { name: 'ZZ Lite Demo Sophie Turner', phone: '0400 000 107', consent_sms: true, marketing_opt_in: true, service: 'roof inspection' }))
      .toMatchObject({ body: { new_contact: false, acknowledgement: { status: 'Simulated Sent' } } });
    expect(at.get('contacts', ids.contacts.sophie!)!.fields).toMatchObject({ 'Consent SMS': true, 'Marketing Opt-In': true, 'Consent Source': `Website form (${config.leadIntake.webhookPath})`,
      'Consent Wording': `${config.consent.wording.service} [SMS]\n${config.consent.wording.marketing}` });
  });

  it('an Airtable failure fails the run (no false "ok"), and the demo Airtable refuses fields that are not in the Lite schema', () => {
    const real = at.http;
    const failing = (req: Parameters<typeof real>[0]) => (req.method === 'POST' && req.url.endsWith(encodeURIComponent('Lite Jobs')) ? { statusCode: 503, body: { error: 'down' } } : real(req));
    expect(() => runWebhook(wf['lead-follow-up'], failing, lead({ email: 'ava.z@example.test', phone: '0400 000 299' }))).toThrow(/create job: Airtable HTTP 503/);
    expect(at.http({ method: 'POST', url: `https://api.airtable.com/v0/${config.airtable.baseId}/${encodeURIComponent('Lite Jobs')}`, query: {},
      body: { records: [{ fields: { Stage: 'Sold' } }] } })).toMatchObject({ statusCode: 422 });
  });
});

describe('D. review requests (test sink)', () => {
  beforeAll(fresh);

  it('one request per finished job after the delay, only with review permission recorded (source and date) and a consented channel, never to an opted-out contact', () => {
    const { summary } = runNow(wf['review-requests'], at.http);
    expect(summary).toMatchObject({ finished_jobs: 6, sent: 2, skipped: 3, not_due_yet: 1, skip_reasons: { 'opted out': 1, 'no permission for review requests': 2 } });
    expect(job('R1')).toMatchObject({ 'Review Status': 'Sent' });
    expect(job('R2')).toMatchObject({ 'Review Status': 'Sent' });
    expect(job('R3')).toMatchObject({ 'Review Status': 'Skipped', 'Review Skip Reason': 'opted out' });
    expect(job('R4')).toMatchObject({ 'Review Status': 'Skipped', 'Review Skip Reason': 'no permission for review requests' });   // Tom: no consent at all
    expect(job('R6')).toMatchObject({ 'Review Status': 'Skipped', 'Review Skip Reason': 'no permission for review requests' });   // Ben: SMS about his job only
    expect(job('R5')['Review Status']).toBeUndefined();                               // finished yesterday: not yet
    const sent = messages('Review Request').filter((m) => m.Status === 'Simulated Sent');
    expect(sent.map((m) => [m.Channel, m.To, m.Purpose])).toEqual([['SMS', '0400000101', 'Review'], ['Email', 'marcus.webb@example.test', 'Review']]);
    for (const m of sent) { expect(String(m.Body)).toContain(config.reviews.googleReviewUrl); expect(String(m.Body)).toMatch(/STOP/); expect(String(m.Body)).toContain(config.business.name); }
  });

  it('running again asks nobody twice; a request logged but not marked on the job is marked, not resent', () => {
    expect(runNow(wf['review-requests'], at.http).summary).toMatchObject({ sent: 0, skipped: 0, finished_jobs: 1 });
    delete at.get('jobs', ids.jobs.R1!)!.fields['Review Status'];                    // as if the run had stopped before marking it
    expect(runNow(wf['review-requests'], at.http).summary).toMatchObject({ sent: 0, already_requested: 1 });
    expect(job('R1')['Review Status']).toBe('Sent');
    expect(messages('Review Request').filter((m) => m.Status === 'Simulated Sent')).toHaveLength(2);
  });

  it('a job dragged to Completed without a Completed At date is not forgotten: the run records the date, and the request goes once the delay has passed', () => {
    const r8 = at.insert('jobs', { 'Job Ref': 'LJ-DEMO-R8', Contact: [ids.contacts.olivia!], Stage: 'Completed', Service: 'roof restoration', 'Demo Data': true });
    expect(runNow(wf['review-requests'], at.http).summary).toMatchObject({ sent: 0, completed_at_recorded: 1, not_due_yet: 2 });   // R8 and R5 (finished yesterday)
    const f = () => at.get('jobs', r8.id)!.fields;
    expect(Date.parse(String(f()['Completed At']))).toBeGreaterThan(Date.now() - 60_000);
    expect(f()['Review Status']).toBeUndefined();
    f()['Completed At'] = daysAgo(config.reviews.delayDays + 1);   // the delay has passed
    expect(runNow(wf['review-requests'], at.http).summary).toMatchObject({ sent: 1, completed_at_recorded: 0 });
    expect(f()).toMatchObject({ 'Review Status': 'Sent' });
  });

  it('Monitor, which runs more often, records a missing Completed At too, instead of raising an alarm about it', () => {
    const r7 = at.insert('jobs', { 'Job Ref': 'LJ-DEMO-R7', Contact: [ids.contacts.olivia!], Stage: 'Completed', Service: 'gutter replacement', 'Demo Data': true });
    expect(runNow(wf.monitor, at.http).summary).toMatchObject({ completed_at_recorded: 1 });
    expect(Date.parse(String(at.get('jobs', r7.id)!.fields['Completed At']))).toBeGreaterThan(Date.now() - 60_000);
    expect(at.all('alerts').filter((a) => a.fields.Kind === 'Incomplete Job')).toHaveLength(0);
  });

  it('consent.reviewRequests "service": SMS/email consent is enough (Ben and Tom differ: Ben consented to SMS, Tom to nothing)', async () => {
    const svc = structuredClone(config); svc.consent.reviewRequests = 'service';
    const w = await buildAll(svc, 'service-reviews');
    const a = new FakeAirtable(config.airtable.baseId, config.airtable.tables); seed(a);
    expect(runNow(w['review-requests'], a.http).summary).toMatchObject({ sent: 3, skip_reasons: { 'opted out': 1, 'no consent or no reachable contact detail': 1 } });
  });
});

describe('E. lead reactivation and replies (test sink)', () => {
  beforeAll(fresh);

  it('only quiet leads with marketing permission recorded (source and date), no opt-out and outside the cooldown get one follow-up; a ticked box without a record is not consent', () => {
    const { summary } = runNow(wf['lead-reactivation'], at.http);
    expect(summary).toMatchObject({ open_leads: 7, sent: 2, still_active: 1,
      exclusion_reasons: { 'no marketing permission': 1, 'opted out': 1, 'followed up within the cooldown': 1, 'consent not recorded (source and date)': 1 } });
    expect(messages('Reactivation').map((m) => [m.To, m.Channel, m.Purpose])).toEqual([['mia.rossi@example.test', 'Email', 'Marketing'], ['0400000106', 'SMS', 'Marketing']]);   // longest-waiting first
    expect(job('A1')).toMatchObject({ 'Reactivation Count': 1 });
    expect(job('A7')['Reactivation Sent At']).toBeUndefined();                         // Zoe: Marketing Opt-In ticked, never recorded
    expect(runNow(wf['lead-reactivation'], at.http).summary).toMatchObject({ sent: 0 });
  });

  it('the run is capped by maxPerRun (oldest first); the rest wait for the next run', async () => {
    const capped = structuredClone(config); capped.reactivation.maxPerRun = 1;
    const w = await buildAll(capped, 'cap');
    const a = new FakeAirtable(config.airtable.baseId, config.airtable.tables); seed(a);
    expect(runNow(w['lead-reactivation'], a.http).summary).toMatchObject({ sent: 1, deferred_to_next_run: 1 });
    expect(a.all('messages').map((m) => m.fields.To)).toEqual(['mia.rossi@example.test']);
  });

  it('a reply brings the enquiry back; STOP opts the contact out of everything, and no later review request or follow-up reaches them', () => {
    const before = String(job('A1')['Last Activity At']);
    expect(post('inbound-replies', { from: '0400 000 106', text: 'Yes please call me' })).toMatchObject({ status: 200, body: { known_contact: true, opted_out: false, job_ref: 'LJ-DEMO-A1' } });
    expect(Date.parse(String(job('A1')['Last Activity At']))).toBeGreaterThan(Date.parse(before));
    post('lead-follow-up', { name: 'ZZ Lite Demo Ethan Cole', email: 'ethan.cole@example.test' });   // a New Lead with no consent
    expect(post('inbound-replies', { from: 'Ethan.Cole@example.test', text: 'Can you come Tuesday?' })).toMatchObject({ body: { known_contact: true, opted_out: false } });
    expect(post('inbound-replies', { from: '+61400000101', text: ' stop ' })).toMatchObject({ body: { opted_out: true } });
    expect(at.get('contacts', ids.contacts.olivia!)!.fields).toMatchObject({ 'Opted Out': true, 'Marketing Opt-In': false });
    expect(messages('Inbound Reply').map((m) => [m.Status, m.Purpose])).toEqual([['Received', 'Inbound'], ['Received', 'Inbound'], ['Opt-Out', 'Inbound']]);
    at.insert('jobs', { 'Job Ref': 'LJ-DEMO-R9', Contact: [ids.contacts.olivia!], Stage: 'Completed', 'Completed At': daysAgo(5), 'Demo Data': true });
    at.insert('jobs', { 'Job Ref': 'LJ-DEMO-A9', Contact: [ids.contacts.olivia!], Stage: 'Quoted', 'Lead Received At': daysAgo(300), 'Last Activity At': daysAgo(300), 'Demo Data': true });
    runNow(wf['review-requests'], at.http);
    expect(at.all('jobs').find((j) => j.fields['Job Ref'] === 'LJ-DEMO-R9')!.fields).toMatchObject({ 'Review Status': 'Skipped', 'Review Skip Reason': 'opted out' });
    expect(runNow(wf['lead-reactivation'], at.http).summary).toMatchObject({ sent: 0 });
    expect(at.all('messages').filter((m) => (m.fields.Contact as string[] | undefined)?.[0] === ids.contacts.olivia && m.fields.Status === 'Simulated Sent' && Date.parse(String(m.fields['Attempted At'])) > Date.now() - 60_000)).toHaveLength(0);
  });

  it('a reply from someone unknown is logged (not lost) and answered; an empty reply is refused', () => {
    expect(post('inbound-replies', { from: '0400 999 999', text: 'who is this?' })).toMatchObject({ status: 200, body: { known_contact: false } });
    expect(messages('Inbound Reply').at(-1)).toMatchObject({ Status: 'Received', Reason: 'sender is not in the CRM' });
    expect(post('inbound-replies', { from: '0400 999 999', text: ' ' })).toMatchObject({ status: 400 });
  });

  it('a reply about a finished job is logged on that job, which stays finished', () => {
    const before = { ...job('R2') };
    expect(post('inbound-replies', { from: 'marcus.webb@example.test', text: 'Thanks, the gutters look great' })).toMatchObject({ status: 200, body: { known_contact: true, job_ref: 'LJ-DEMO-R2' } });
    expect(messages('Inbound Reply').at(-1)).toMatchObject({ Status: 'Received', Job: [ids.jobs.R2], Reason: 'reply recorded on the finished job (not reopened)' });
    expect(job('R2')).toMatchObject({ Stage: 'Paid', 'Last Activity At': before['Last Activity At'] });
  });

  it('in test-sink mode only the configured Airtable base is called: no message provider, no other host', () => {
    expect(at.requests.length).toBeGreaterThan(20);
    expect(at.requests.every((r) => r.url.startsWith(`https://api.airtable.com/v0/${config.airtable.baseId}/`))).toBe(true);
  });
});

// ---- Twilio world (a second client, Twilio mode, fake Twilio) -------------------------------------------------------
const base = loadConfig('lite/config/example-plumbing-twilio.json');
const TW = structuredClone(base);
// For the tests the live allowlist holds the synthetic fixture numbers (and the operator's); everyone else stays blocked.
TW.reviews.delayDays = 2;   // as in the demo, so Grace (finished yesterday) is not due yet
TW.messaging.twilio!.allowedRecipients = [...['101','103', '105', '106', '107', '109', '111', '112', '113', '201', '202', '301', '302', '303', '304', '305'].map((n) => `+61400000${n}`), '+61491570110'];
let tw: FakeTwilio;
let tat: FakeAirtable;
let tids: Seeded;
let twf: Wfs;
let http: (r: HttpReq) => { statusCode: number; body: unknown };
const VARS = { LITE_TWILIO_AUTH_TOKEN: 'zz-test-auth-token' };
const tfresh = () => { tat = new FakeAirtable(TW.airtable.baseId, TW.airtable.tables); tids = seed(tat); tw = new FakeTwilio(TW.messaging.twilio!.accountSid, VARS.LITE_TWILIO_AUTH_TOKEN); http = route(tw, tat.http); };
const hookUrl = (status: boolean) => `${TW.n8n.baseUrl}/webhook/${TW.replies.webhookPath}${status ? '?event=status' : ''}`;
const tpost = (body: unknown) => runWebhook(twf['lead-follow-up'], http, body, { vars: VARS }).response!;
const sms = (params: Record<string, string>, opt: { status?: boolean; sign?: string | false } = {}) => runWebhook(twf['inbound-replies'], http, params, {
  vars: VARS, query: opt.status ? { event: 'status' } : {},
  headers: opt.sign === false ? {} : { 'X-Twilio-Signature': opt.sign ?? tw.sign(hookUrl(!!opt.status), params) } }).response!;
const tlog = () => tat.all('messages').map((m): R & { id: string } => ({ ...m.fields, id: m.id }));
const tjob = (key: string) => tat.get('jobs', tids.jobs[key]!)!.fields;
const monitor = () => runNow(twf.monitor, http, { vars: VARS }).summary;
const today = () => new Date().toISOString().slice(0, 10);

describe('B-C. Twilio: one acknowledgement SMS per lead, never twice', () => {
  beforeAll(async () => { twf = await buildAll(TW, 'twilio'); tfresh(); }, 60_000);

  it('B. an eligible new lead gets exactly one SMS through Twilio: E.164 number, configured sender, delivery receipts; logged Sent with the Message SID', () => {
    const r = tpost(lead());
    expect(r).toMatchObject({ status: 200, body: { stage: 'Contacted', acknowledgement: { status: 'Sent', channel: 'SMS' } } });
    expect(tw.sent).toHaveLength(1);
    const call = tw.calls.find((c) => c.method === 'POST')!;
    expect(call.body).toEqual({ To: '+61400000201', From: TW.messaging.twilio!.from, Body: expect.stringMatching(/^Hi Emma, thanks for contacting ZZ Example Plumbing \(test client\)/) as unknown,
      StatusCallback: hookUrl(true) });
    expect(call.credentials).toEqual({ httpBasicAuth: TW.messaging.twilio!.credential });
    expect(call.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${TW.messaging.twilio!.accountSid}/Messages.json`);
    const m = tlog().find((x) => x.Workflow === 'Lead Follow-Up')!;
    expect(m).toMatchObject({ Status: 'Sent', 'Provider Message ID': tw.sent[0]!.sid, Purpose: 'Operational', Provider: 'twilio', Attempts: 1 });
    expect(tat.all('jobs').find((j) => j.id === (m.Job as string[])[0])!.fields.Stage).toBe('Contacted');
  });

  it('C. the same lead again sends nothing; two copies of one form arriving together send one SMS (the second is marked a duplicate)', () => {
    expect(tpost(lead({ message: 'again' }))).toMatchObject({ body: { duplicate: true } });
    expect(tw.sent).toHaveLength(1);
    // Another request for Chloe is already sending her acknowledgement when this one arrives.
    tat.insert('messages', { 'Log Ref': 'LM-OTHER-RUN', Workflow: 'Lead Follow-Up', Purpose: 'Operational', Status: 'Sending', 'Dedupe Key': `lead-ack:0400000202:${today()}`, 'Attempted At': new Date().toISOString() });
    const r = tpost(lead({ name: 'ZZ Lite Demo Chloe Hart', first_name: 'Chloe', phone: '0400 000 202', email: 'chloe.hart@example.test' }));
    expect(r).toMatchObject({ body: { duplicate: true } });
    expect(tw.sent).toHaveLength(1);
    const mine = tlog().find((x) => String(x['Dedupe Key']) === `lead-ack:0400000202:${today()}` && x['Log Ref'] !== 'LM-OTHER-RUN')!;
    expect(mine).toMatchObject({ Status: 'Skipped', Reason: 'duplicate: LM-OTHER-RUN already handles this message' });
    expect(tat.all('jobs').find((j) => j.id === (mine.Job as string[])[0])!.fields.Stage).toBe('Lost');
  });

  it('live safety: a number not on the allowlist is never sent to; email-only consent is not sent by SMS', () => {
    expect(tpost(lead({ name: 'ZZ Lite Demo Max Bell', first_name: 'Max', phone: '0400 000 999', email: 'max.bell@example.test' })))
      .toMatchObject({ body: { stage: 'New Lead', acknowledgement: { status: 'Skipped', reason: 'not sent: +61400000999 is not on the live test allowlist' } } });
    expect(tpost(lead({ name: 'ZZ Lite Demo Nina Ross', phone: '', email: 'nina.ross@example.test', consent_sms: false })))
      .toMatchObject({ body: { acknowledgement: { status: 'Skipped', reason: 'no SMS consent or no mobile number' } } });
    expect(tw.sent).toHaveLength(1);
  });
});

describe('D-E. Twilio: review requests and reactivation, one permitted SMS each', () => {
  beforeAll(tfresh);

  it('D. a completed job produces one permitted review request (Olivia); no review permission, opted out, no SMS consent and not-due jobs get none; a second run sends nothing', () => {
    expect(runNow(twf['review-requests'], http).summary).toMatchObject({ mode: 'twilio', sent: 1, skipped: 4, not_due_yet: 1,
      skip_reasons: { 'opted out': 1, 'no permission for review requests': 2, 'no SMS consent or no mobile number': 1 } });
    expect(tw.sent.map((m) => m.to)).toEqual(['+61400000101']);
    expect(tw.sent[0]!.body).toContain(TW.reviews.googleReviewUrl);
    expect(tjob('R1')).toMatchObject({ 'Review Status': 'Sent' });
    expect(runNow(twf['review-requests'], http).summary).toMatchObject({ sent: 0 });
    expect(tw.sent).toHaveLength(1);
  });

  it('E. a consented inactive lead (Daniel) receives one reactivation SMS; no permission, unrecorded consent, opted out, cooldown and recent leads do not', () => {
    expect(runNow(twf['lead-reactivation'], http).summary).toMatchObject({ sent: 1, open_leads: 7, still_active: 1,
      exclusion_reasons: { 'no marketing permission': 1, 'opted out': 1, 'no SMS consent or no mobile number': 1, 'consent not recorded (source and date)': 1, 'followed up within the cooldown': 1 } });
    expect(tw.sent.map((m) => m.to)).toEqual(['+61400000101', '+61400000106']);
    expect(tw.sent[1]!.body).toMatch(/ZZ Example Plumbing[\s\S]*STOP/);
    expect(runNow(twf['lead-reactivation'], http).summary).toMatchObject({ sent: 0 });
    expect(tw.sent).toHaveLength(2);
  });
});

describe('F. Twilio: STOP, signed webhooks and delivery receipts', () => {
  beforeAll(tfresh);

  it('requests that are not from Twilio change nothing: no or a wrong signature, another account, or no signing secret', () => {
    const before = tat.requests.filter((r) => r.method !== 'GET').length;
    const p = tw.inbound('+61400000106', TW.messaging.twilio!.from!, 'STOP');
    expect(sms(p, { sign: false })).toMatchObject({ status: 403, body: 'invalid Twilio signature' });
    expect(sms(p, { sign: tw.sign(hookUrl(false), p, 'wrong-token') })).toMatchObject({ status: 403 });
    expect(sms({ ...p, Body: 'START' }, { sign: tw.sign(hookUrl(false), p) })).toMatchObject({ status: 403 });   // body changed after signing
    const other = { ...p, AccountSid: 'AC11111111111111111111111111111111' };
    expect(sms(other)).toMatchObject({ status: 403, body: 'request is not for this Twilio account' });
    expect(runWebhook(twf['inbound-replies'], http, p, { headers: { 'x-twilio-signature': tw.sign(hookUrl(false), p) } }).response).toMatchObject({ status: 503 });
    expect(tat.requests.filter((r) => r.method !== 'GET').length).toBe(before);
    expect(tat.get('contacts', tids.contacts.daniel!)!.fields['Opted Out']).toBeFalsy();
  });

  it('F. a signed STOP opts the contact out (TwiML answer, nothing sent back); afterwards no review request or reactivation reaches them', () => {
    const r = sms(tw.inbound('+61400000106', TW.messaging.twilio!.from!, 'Stop'));
    expect(r).toEqual({ status: 200, body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>' });
    expect(tat.get('contacts', tids.contacts.daniel!)!.fields).toMatchObject({ 'Opted Out': true, 'Marketing Opt-In': false });
    expect(tlog().at(-1)).toMatchObject({ Workflow: 'Inbound Reply', Status: 'Opt-Out', Purpose: 'Inbound', 'Provider Message ID': expect.stringMatching(/^SM/) as unknown });
    tat.insert('jobs', { 'Job Ref': 'LJ-DEMO-R8', Contact: [tids.contacts.daniel!], Stage: 'Completed', 'Completed At': daysAgo(5), 'Demo Data': true });
    expect(runNow(twf['lead-reactivation'], http).summary).toMatchObject({ sent: 0, exclusion_reasons: { 'opted out': 2 } });
    runNow(twf['review-requests'], http);
    expect(tat.all('jobs').find((j) => j.fields['Job Ref'] === 'LJ-DEMO-R8')!.fields).toMatchObject({ 'Review Status': 'Skipped', 'Review Skip Reason': 'opted out' });
    expect(tw.sent.some((m) => m.to === '+61400000106')).toBe(false);
  });

  it('START is recorded for staff and does not re-subscribe anyone', () => {
    expect(sms(tw.inbound('+61400000106', TW.messaging.twilio!.from!, 'START'))).toMatchObject({ status: 200 });
    expect(tlog().at(-1)).toMatchObject({ Status: 'Received', Reason: expect.stringMatching(/staff must confirm/) as unknown });
    expect(tat.get('contacts', tids.contacts.daniel!)!.fields['Opted Out']).toBe(true);
  });

  it('delivery receipts update the log (never backwards); a Twilio "unsubscribed" (21610) failure opts the contact out', () => {
    tpost(lead());
    const row = () => tlog().find((x) => x.Workflow === 'Lead Follow-Up')!;
    const sid = String(row()['Provider Message ID']);
    expect(sms(tw.statusCallback(sid, 'delivered'), { status: true })).toMatchObject({ status: 200 });
    expect(row().Status).toBe('Delivered');
    sms(tw.statusCallback(sid, 'sent'), { status: true });                              // a late "sent" receipt
    expect(row().Status).toBe('Delivered');
    tpost(lead({ name: 'ZZ Lite Demo Chloe Hart', first_name: 'Chloe', phone: '0400 000 202', email: 'chloe.hart@example.test' }));
    const chloe = tlog().find((x) => String(x['Dedupe Key']).startsWith('lead-ack:0400000202'))!;
    sms(tw.statusCallback(String(chloe['Provider Message ID']), 'undelivered', '21610'), { status: true });
    expect(tlog().find((x) => x.id === chloe.id)).toMatchObject({ Status: 'Failed', 'Error Code': '21610' });
    expect(tat.get('contacts', (chloe.Contact as string[])[0]!)!.fields).toMatchObject({ 'Opted Out': true });
  });
});

describe('G. Twilio: failed delivery is logged, raised and recoverable', () => {
  beforeAll(tfresh);
  const ack = (n: string) => tlog().find((x) => String(x['Dedupe Key']) === `lead-ack:0400000${n}:${today()}`)!;
  const person = (n: string, o: R = {}) => lead({ name: `ZZ Lite Demo Test ${n}`, first_name: 'Sam', phone: `0400 000 ${n}`, email: `test${n}@example.test`, ...o });

  it('a refused number (21211) is logged Failed with the reason, the job stays New Lead, and Monitor raises one alert (and texts the operator)', () => {
    tw.rules.set('+61400000301', 'invalid');
    expect(tpost(person('301'))).toMatchObject({ body: { stage: 'New Lead', acknowledgement: { status: 'Failed', reason: 'invalid phone number (not sent)' } } });
    expect(ack('301')).toMatchObject({ Status: 'Failed', 'Error Code': '21211' });
    const s = monitor();
    expect(s).toMatchObject({ failed: 1, stale_leads: 1, alerts_raised: 2 });   // and Liam's enquiry, New Lead for 150 days
    const alerts = () => tat.all('alerts').map((a) => a.fields);
    expect(alerts().filter((a) => a.Kind === 'Delivery Failed')).toEqual([expect.objectContaining({ Status: 'Open', 'Record Ref': ack('301')['Log Ref'] })]);
    expect(tw.sent.filter((m) => m.to === TW.monitoring.operatorPhone)).toHaveLength(1);
    expect(tw.sent.find((m) => m.to === TW.monitoring.operatorPhone)!.body).toMatch(/2 new alerts: 1 Delivery Failed, 1 Stuck Lead\. See Lite Alerts in Airtable\.$/);
    monitor();
    expect(alerts().filter((a) => a.Kind === 'Delivery Failed')).toHaveLength(1);            // raised once
    expect(tw.sent.filter((m) => m.to === TW.monitoring.operatorPhone)).toHaveLength(1);     // nothing new, no text
  });

  it('G. after fixing the number, Retry Requested resends it once (Twilio is checked first); the job then moves to Contacted; another run resends nothing', () => {
    const row = ack('301');
    tat.http({ method: 'PATCH', url: `https://api.airtable.com/v0/${TW.airtable.baseId}/${encodeURIComponent(TW.airtable.tables.messages)}`, query: {},
      body: { records: [{ id: row.id, fields: { To: '0400000302', 'Retry Requested': true } }] } });
    expect(monitor()).toMatchObject({ retry_requests: 1, retried: 1, resent: 1 });
    expect(tw.calls.some((c) => c.method === 'GET' && c.url.includes('To=%2B61400000302'))).toBe(true);   // checked before sending
    expect(tw.sent.filter((m) => m.to === '+61400000302')).toHaveLength(1);
    const retry = tlog().find((x) => x['Retry Of'] === row['Log Ref'])!;
    expect(retry).toMatchObject({ Status: 'Sent', Purpose: 'Operational', 'Dedupe Key': `${String(row['Dedupe Key'])}:retry:2` });
    expect(tlog().find((x) => x.id === row.id)).toMatchObject({ 'Retry Requested': false, Attempts: 2 });
    expect(tat.all('jobs').find((j) => j.id === (row.Job as string[])[0])!.fields.Stage).toBe('Contacted');
    monitor();
    expect(tw.sent.filter((m) => m.to === '+61400000302')).toHaveLength(1);
  });

  it('an unanswered send (timeout) is Unknown, not resent by itself; on Retry Requested, Twilio shows it went out, so the log is corrected and nothing is resent', () => {
    tw.rules.set('+61400000303', 'timeout-after-send');
    expect(tpost(person('303'))).toMatchObject({ body: { acknowledgement: { status: 'Unknown' } } });
    expect(tw.sent.filter((m) => m.to === '+61400000303')).toHaveLength(1);              // it did go out
    expect(runNow(twf['review-requests'], http).summary).toBeDefined();                  // other runs do not touch it
    const row = ack('303');
    expect(row).toMatchObject({ Status: 'Unknown', 'Error Code': 'no_response' });
    tat.http({ method: 'PATCH', url: `https://api.airtable.com/v0/${TW.airtable.baseId}/${encodeURIComponent(TW.airtable.tables.messages)}`, query: {}, body: { records: [{ id: row.id, fields: { 'Retry Requested': true } }] } });
    expect(monitor()).toMatchObject({ found_already_sent: 1, retried: 0 });
    expect(tw.sent.filter((m) => m.to === '+61400000303')).toHaveLength(1);
    expect(tlog().find((x) => x.id === row.id)).toMatchObject({ Status: 'Sent', 'Retry Requested': false, Reason: 'found at Twilio (sent): not resent' });
    expect(tat.all('jobs').find((j) => j.id === (row.Job as string[])[0])!.fields.Stage).toBe('Contacted');   // its On Success was applied
  });

  it('a Twilio server error (not sent) is Unknown; a retry is postponed while Twilio cannot be checked, then resends once when it can', () => {
    tw.rules.set('+61400000304', 'server-error');
    expect(tpost(person('304'))).toMatchObject({ body: { acknowledgement: { status: 'Unknown' } } });
    const row = ack('304');
    tat.http({ method: 'PATCH', url: `https://api.airtable.com/v0/${TW.airtable.baseId}/${encodeURIComponent(TW.airtable.tables.messages)}`, query: {}, body: { records: [{ id: row.id, fields: { 'Retry Requested': true } }] } });
    const down = (r: HttpReq) => (r.method === 'GET' && r.url.startsWith('https://api.twilio.com/') ? { statusCode: 503, body: {} } : http(r));
    expect(runNow(twf.monitor, down, { vars: VARS }).summary).toMatchObject({ retry_postponed: 1, retried: 0 });
    expect(tw.sent.filter((m) => m.to === '+61400000304')).toHaveLength(0);
    tw.rules.delete('+61400000304');
    expect(monitor()).toMatchObject({ retried: 1, resent: 1 });
    expect(tw.sent.filter((m) => m.to === '+61400000304')).toHaveLength(1);
  });

  it('never resent: an opted-out contact, a Twilio 21610, or a message that is not Failed or Unknown', () => {
    tw.rules.set('+61400000305', 'unsubscribed');
    expect(tpost(person('305'))).toMatchObject({ body: { acknowledgement: { status: 'Failed', reason: 'the person unsubscribed from this sender (replied STOP) (not sent)' } } });
    const row = ack('305');
    expect(tat.get('contacts', (row.Contact as string[])[0]!)!.fields).toMatchObject({ 'Opted Out': true });   // 21610 is an opt-out
    const sent = tlog().find((x) => x.Status === 'Sent')!;
    for (const id of [row.id, sent.id]) tat.http({ method: 'PATCH', url: `https://api.airtable.com/v0/${TW.airtable.baseId}/${encodeURIComponent(TW.airtable.tables.messages)}`, query: {}, body: { records: [{ id, fields: { 'Retry Requested': true } }] } });
    const customers = () => tw.sent.filter((m) => m.to !== TW.monitoring.operatorPhone).length;   // the operator may get an alert text
    const n = customers();
    expect(monitor()).toMatchObject({ retried: 0 });
    expect(customers()).toBe(n);
    expect(tlog().find((x) => x.id === row.id)).toMatchObject({ 'Retry Requested': false, Reason: 'not retried: the person unsubscribed from this number (Twilio 21610)' });
    expect(tlog().find((x) => x.id === sent.id)).toMatchObject({ 'Retry Requested': false, Reason: 'not retried: the message is Sent' });
  });

  it('a message stuck in Sending (a run that stopped) becomes Unknown and is raised; a failed workflow run (Error Trigger) is raised once', () => {
    tat.insert('messages', { 'Log Ref': 'LM-STUCK', Workflow: 'Review Request', Purpose: 'Review', Status: 'Sending', 'Dedupe Key': 'review:stuck', To: '0400000109', Channel: 'SMS', 'Attempted At': new Date(Date.now() - 3600_000).toISOString() });
    expect(monitor()).toMatchObject({ stuck_sending: 1 });
    expect(tlog().find((x) => x['Log Ref'] === 'LM-STUCK')).toMatchObject({ Status: 'Unknown', 'Error Code': 'stuck' });
    const stuck = tat.all('alerts').find((a) => a.fields.Kind === 'Delivery Unknown' && a.fields['Record Ref'] === 'LM-STUCK');
    expect(String(stuck?.fields.Detail)).toContain('has no confirmed result: no result recorded 15 minutes after sending started');   // found in the cloud run: the reason was empty
    const failure = { execution: { id: '9001', url: `${TW.n8n.baseUrl}/workflow/x/executions/9001`, lastNodeExecuted: 'Create Job', error: { message: 'create job: Airtable HTTP 503 down' }, mode: 'webhook' },
      workflow: { id: 'wfLead', name: '[Lite] Instant Lead Follow-Up' } };
    runError(twf.monitor, http, failure, { vars: VARS });
    runError(twf.monitor, http, failure, { vars: VARS });
    const a = tat.all('alerts').filter((x) => x.fields.Kind === 'Workflow Failed');
    expect(a.map((x) => x.fields)).toEqual([expect.objectContaining({ Workflow: '[Lite] Instant Lead Follow-Up', Execution: failure.execution.url, Status: 'Open',
      Detail: 'Stopped at "Create Job": create job: Airtable HTTP 503 down' })]);
  });
});

// ---- Twilio trial account on n8n Starter (no Variables): the set-up of the live test -------------------------------
// A trial may send only To, a Twilio template key as Body, and StatusCallback; Twilio picks the trial sender and accepts
// verified recipients only. n8n Starter has no Variables, so webhooks use n8n's own Basic Auth (or a relay's header).
const TRIAL = structuredClone(TW);
Object.assign(TRIAL.messaging.twilio!, { from: null, trialTemplate: 'sms_appointment_reminders', credentialType: 'twilioApi',
  credential: { id: 'ZZExampleTwiApi1', name: 'ZZ example Twilio account' }, inboundAuth: 'basic-auth', signatureVariable: undefined,
  inboundCredential: { id: 'ZZExampleHook001', name: 'ZZ example reply webhook login' }, statusCallbacks: true,
  allowedRecipients: ['+61400000201', '+61400000202', '+61491570156'] });
const VERIFIED = ['+61400000201', '+61400000202'];

describe('Twilio trial account on n8n Starter: template messages, n8n credentials, no Variables', () => {
  let x: Wfs; let xt: FakeTwilio; let xa: FakeAirtable; let xhttp: (r: HttpReq) => { statusCode: number; body: unknown };
  const xlog = () => xa.all('messages').map((m): R & { id: string } => ({ ...m.fields, id: m.id }));
  const xpost = (body: unknown) => runWebhook(x['lead-follow-up'], xhttp, body).response!;   // no vars: Starter has none
  const xsms = (params: Record<string, string>, status = false) => runWebhook(x['inbound-replies'], xhttp, params, { query: status ? { event: 'status' } : {} }).response!;
  const ack = (n: string) => xlog().find((m) => String(m['Dedupe Key']) === `lead-ack:0400000${n}:${today()}`)!;
  beforeAll(async () => {
    x = await buildAll(TRIAL, 'trial');
    xa = new FakeAirtable(TRIAL.airtable.baseId, TRIAL.airtable.tables); seed(xa);
    xt = new FakeTwilio(TRIAL.messaging.twilio!.accountSid, 'zz-test-auth-token', { trial: { verified: VERIFIED } }); xhttp = route(xt, xa.http);
  }, 60_000);

  it('the build calls Twilio with the n8n Twilio credential, protects the reply webhook with n8n Basic Auth, and no node reads $vars', () => {
    for (const w of WORKFLOWS) {
      const j = imports('trial', w);
      for (const n of j.nodes.filter((y) => y.type === 'n8n-nodes-base.httpRequest' && String((y.parameters as R).url).includes('api.twilio.com'))) {
        expect(n.parameters, `${w}: ${String(n.name)}`).toMatchObject({ authentication: 'predefinedCredentialType', nodeCredentialType: 'twilioApi' });
        expect(n.credentials, `${w}: ${String(n.name)}`).toEqual({ twilioApi: TRIAL.messaging.twilio!.credential });
      }
      for (const n of j.nodes.filter((y) => y.type === 'n8n-nodes-base.code')) expect(String((n.parameters as R).jsCode), `${w}: ${String(n.name)}`).not.toContain('$vars');
    }
    const hook = imports('trial', 'inbound-replies').nodes.find((n) => n.name === 'Reply Webhook')!;
    expect(hook.parameters).toMatchObject({ authentication: 'basicAuth' });
    expect(hook.credentials).toEqual({ httpBasicAuth: TRIAL.messaging.twilio!.inboundCredential });
  });

  it('a lead gets one SMS as Twilio\'s template (no From, no custom text) with a StatusCallback URL that carries no password; the log keeps the real wording and says why', () => {
    expect(xpost(lead())).toMatchObject({ status: 200, body: { stage: 'Contacted', acknowledgement: { status: 'Sent', channel: 'SMS' } } });
    expect(xt.sent).toHaveLength(1);
    const call = xt.calls.find((c) => c.method === 'POST')!;
    expect(call.body).toEqual({ To: '+61400000201', Body: 'sms_appointment_reminders', StatusCallback: `${TRIAL.n8n.baseUrl}/webhook/${TRIAL.replies.webhookPath}?event=status` });
    expect(call.credentials).toEqual({ twilioApi: TRIAL.messaging.twilio!.credential });
    expect(ack('201')).toMatchObject({ Status: 'Sent', 'Provider Message ID': xt.sent[0]!.sid, Body: expect.stringMatching(/^Hi Emma, thanks for contacting ZZ Example Plumbing/) as unknown,
      Reason: 'Twilio trial: sent as the Twilio template sms_appointment_reminders (a trial account cannot send this text)' });
  });

  it('an allowlisted number that is not a verified trial recipient is refused by Twilio: nothing sent, logged Failed with a plain reason', () => {
    expect(xpost(lead({ name: 'ZZ Lite Demo Fiction Test', first_name: 'Sam', phone: '0491 570 156', email: 'fiction@example.test' })))
      .toMatchObject({ body: { stage: 'New Lead', acknowledgement: { status: 'Failed', reason: 'trial account: the number is not a verified recipient (not sent)' } } });
    expect(xlog().find((m) => String(m['Dedupe Key']).startsWith('lead-ack:0491570156'))).toMatchObject({ Status: 'Failed', 'Error Code': '572002' });
    expect(xt.sent).toHaveLength(1);
  });

  it('a retry never resends a message that Twilio already sent as its template text (the log holds Lite\'s wording, Twilio holds the template)', () => {
    xt.rules.set('+61400000202', 'timeout-after-send');
    expect(xpost(lead({ name: 'ZZ Lite Demo Chloe Hart', first_name: 'Chloe', phone: '0400 000 202', email: 'chloe.hart@example.test' })))
      .toMatchObject({ body: { acknowledgement: { status: 'Unknown' } } });
    expect(xt.sent.filter((m) => m.to === '+61400000202')).toHaveLength(1);
    const row = ack('202');
    xa.http({ method: 'PATCH', url: `https://api.airtable.com/v0/${TRIAL.airtable.baseId}/${encodeURIComponent(TRIAL.airtable.tables.messages)}`, query: {}, body: { records: [{ id: row.id, fields: { 'Retry Requested': true } }] } });
    expect(runNow(x.monitor, xhttp).summary).toMatchObject({ found_already_sent: 1, retried: 0 });
    expect(xt.sent.filter((m) => m.to === '+61400000202')).toHaveLength(1);
  });

  it('with Basic Auth on the webhook, a STOP reply and a delivery receipt are processed without any Variable; a request for another account changes nothing', () => {
    const sid = String(ack('201')['Provider Message ID']);
    expect(xsms(xt.statusCallback(sid, 'delivered'), true)).toMatchObject({ status: 200 });
    expect(ack('201').Status).toBe('Delivered');
    const stop = xt.inbound('+61400000201', '+61491570006', 'STOP');
    expect(xsms({ ...stop, AccountSid: 'AC11111111111111111111111111111111' })).toMatchObject({ status: 403, body: 'request is not for this Twilio account' });
    expect(xsms(stop)).toEqual({ status: 200, body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>' });
    expect(xa.all('contacts').find((c) => c.fields['Phone Normalized'] === '0400000201')!.fields).toMatchObject({ 'Opted Out': true });
  });

  it('a relay that checks Twilio\'s signature can sit in front: the reply webhook then requires the n8n Header Auth credential, and receipts go to the relay', async () => {
    const relay = structuredClone(TRIAL);
    const fn = 'https://lite-relay-0000.twil.io/reply?event=status';
    Object.assign(relay.messaging.twilio!, { inboundAuth: 'header-auth', inboundCredential: { id: 'ZZExampleRelay01', name: 'ZZ reply relay key' }, statusCallbackUrl: fn });
    expect(configProblems(relay)).toEqual([]);
    expect(configProblems({ ...relay, messaging: { ...relay.messaging, twilio: { ...relay.messaging.twilio!, statusCallbackUrl: 'https://user:pw@lite-relay.twil.io/reply?event=status' } } }).join())
      .toMatch(/statusCallbackUrl must be an https URL ending in \?event=status, with no credentials in it/);
    await buildAll(relay, 'relay');
    const hook = imports('relay', 'inbound-replies').nodes.find((n) => n.name === 'Reply Webhook')!;
    expect(hook.parameters).toMatchObject({ authentication: 'headerAuth' });
    expect(hook.credentials).toEqual({ httpHeaderAuth: relay.messaging.twilio!.inboundCredential });
    const send = imports('relay', 'lead-follow-up').nodes.find((n) => n.name === 'Send SMS (Twilio)')!;
    expect(((send.parameters as R).bodyParameters as { parameters: { name: string; value: string }[] }).parameters).toContainEqual({ name: 'StatusCallback', value: fn });
  }, 60_000);

  it('the relay (lite/twilio/reply-relay.js) forwards Twilio\'s parameters to n8n with the secret header and answers empty TwiML; if n8n refuses, it tells Twilio (502)', async () => {
    const src = readFileSync('lite/twilio/reply-relay.js', 'utf8');
    const posts: { url: string; init: RequestInit }[] = [];
    let answer = 200;
    class TwilioResponse { status = 200; body: unknown = null; setStatusCode(s: number) { this.status = s; } setBody(b: unknown) { this.body = b; } }
    class MessagingResponse { toString() { return '<?xml version="1.0" encoding="UTF-8"?><Response/>'; } }
    const mod = { exports: {} as { handler?: (c: R, e: R, cb: (err: unknown, r: unknown) => void) => Promise<void> } };
    runInNewContext(src, { exports: mod.exports, module: mod, URLSearchParams, Object, String,
      fetch: (url: string, init: RequestInit) => { posts.push({ url, init }); return Promise.resolve({ ok: answer >= 200 && answer < 300 }); },
      Twilio: { Response: TwilioResponse, twiml: { MessagingResponse } } });
    const ctx = { N8N_REPLY_URL: 'https://zz-example.app.n8n.cloud/webhook/zz-plumbing/sms', RELAY_HEADER_NAME: 'X-Lite-Relay-Key', RELAY_SECRET: 'zz-relay-secret' };
    const call = (e: R) => new Promise<unknown>((ok) => { void mod.exports.handler!(ctx, e, (_err, r) => { ok(r); }); });
    const sms = { AccountSid: 'AC00000000000000000000000000000000', From: '+61491570156', Body: 'STOP', request: { headers: { 'x-twilio-signature': 'abc' } } };
    expect(await call(sms)).toBeInstanceOf(MessagingResponse);
    expect(posts[0]!.url).toBe(ctx.N8N_REPLY_URL);
    expect(posts[0]!.init.headers).toMatchObject({ 'X-Lite-Relay-Key': 'zz-relay-secret', 'content-type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(new URLSearchParams(posts[0]!.init.body as string))).toEqual({ AccountSid: sms.AccountSid, From: sms.From, Body: 'STOP' });
    expect(await call({ AccountSid: sms.AccountSid, MessageSid: 'SM' + '0'.repeat(32), MessageStatus: 'delivered', event: 'status' })).toBe('');
    expect(posts[1]!.url).toBe(`${ctx.N8N_REPLY_URL}?event=status`);
    answer = 401;
    expect(await call(sms)).toMatchObject({ status: 502 });
  });
});

describe('H. a new client is installed from its config alone (no workflow source edits)', () => {
  let x: Wfs;
  beforeAll(async () => { x = await buildAll(base, 'example'); }, 60_000);

  it('the example plumbing client builds from lite/config/example-plumbing-twilio.json: its base, tables, Twilio account, paths, timezone and error workflow; nothing of the demo client', () => {
    for (const w of WORKFLOWS) {
      const j = imports('example', w);
      const text = JSON.stringify(j);
      expect(j.active, w).toBe(false);
      expect(j.settings, w).toMatchObject({ timezone: 'Australia/Sydney', ...(w === 'monitor' ? {} : { errorWorkflow: 'ZZExampleMonitr1' }) });
      if (w === 'monitor') expect(j.settings).not.toHaveProperty('errorWorkflow');
      expect(text, w).not.toMatch(/Harbourside|Lite%20Contacts|appMc8V0Wm29tEeHQ|roofops-lite/);
      for (const n of j.nodes.filter((y) => y.type === 'n8n-nodes-base.httpRequest')) {
        const twilio = ['Send SMS (Twilio)', 'Alert Operator', 'Check Delivery'].includes(String(n.name));
        expect(n.credentials, `${w} ${String(n.name)}`).toEqual(twilio ? { httpBasicAuth: base.messaging.twilio!.credential } : { airtableTokenApi: base.airtable.credential });
        if (twilio && n.name !== 'Check Delivery') expect(String((n.parameters as R).url)).toBe(`https://api.twilio.com/2010-04-01/Accounts/${base.messaging.twilio!.accountSid}/Messages.json`);
      }
    }
    expect(JSON.stringify(imports('example', 'lead-follow-up'))).toContain('Plumbing%20Contacts');
    expect(imports('example', 'inbound-replies').nodes.find((n) => n.type === 'n8n-nodes-base.webhook')!.parameters).toMatchObject({ path: 'zz-plumbing/sms' });
    const form = readFileSync(join(OUT, 'example', 'lead-form.html'), 'utf8');
    expect(form).toContain('https://zz-example.app.n8n.cloud/webhook/zz-plumbing/lead');
    for (const s of ['ZZ Example Plumbing (test client)', 'Blocked drain', base.consent.wording.marketing]) expect(form).toContain(s);
    expect(form).toMatch(/name="website"/);                                             // the honeypot
  });

  it('the tables are created under the client\'s names (setup), and the workflows run on them unchanged', async () => {
    const { apply } = await import('../lite/airtable/setup.js');
    const calls: { method: string; path: string; body?: string }[] = [];
    let n = 0;
    const meta = (path: string, init: { method: string; body?: string }) => {
      calls.push({ method: init.method, path, ...(init.body ? { body: init.body } : {}) });
      if (init.method === 'GET') return Promise.resolve({ status: 200, json: { tables: [] } });
      return Promise.resolve({ status: 200, json: { id: `tblZZ${String(++n).padStart(12, '0')}`, options: { inverseLinkFieldId: `fldZZ${String(n).padStart(12, '0')}` } } });
    };
    await apply(base.airtable.baseId, meta, () => undefined, base.airtable.tables);
    const created = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/tables')).map((c) => (JSON.parse(c.body!) as { name: string }).name);
    expect(created).toEqual(['Plumbing Contacts', 'Plumbing Sites', 'Plumbing Jobs', 'Plumbing Quotes', 'Plumbing Messages', 'Plumbing Alerts']);
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => JSON.parse(c.body!) as unknown)).toEqual([{ name: 'Lite Jobs' }]);   // the back-link the workflows read
    const a = new FakeAirtable(base.airtable.baseId, base.airtable.tables); seed(a);
    const t = new FakeTwilio(base.messaging.twilio!.accountSid);
    const r = runWebhook(x['lead-follow-up'], route(t, a.http), lead({ phone: '0491 570 156', name: 'ZZ Lite Demo New Client Lead' })).response!;
    expect(r).toMatchObject({ status: 200, body: { stage: 'Contacted', acknowledgement: { status: 'Sent' } } });
    expect(t.sent.map((m) => [m.to, m.from])).toEqual([['+61491570156', '+61491570006']]);
    expect(t.sent[0]!.body).toMatch(/^Hi Emma, thanks for contacting ZZ Example Plumbing \(test client\) about roof leak repair\. A plumber will call you today\./);
    expect(a.requests.every((q) => q.url.startsWith(`https://api.airtable.com/v0/${base.airtable.baseId}/Plumbing%20`))).toBe(true);
  });

  it('no credential value, token or secret is in any generated file (only credential ids and names)', () => {
    for (const dir of ['demo', 'example', 'twilio']) for (const w of WORKFLOWS) {
      const s = readFileSync(join(OUT, dir, `${w}.json`), 'utf8') + readFileSync(join(OUT, dir, `${w}.sdk.ts`), 'utf8');
      expect(s, `${dir}/${w}`).not.toMatch(/zz-test-auth-token|\bpat[A-Za-z0-9]{14}\.[a-f0-9]{20,}|\bSK[0-9a-f]{32}\b|Bearer [A-Za-z0-9]/);
    }
  });
});

describe('Airtable setup (lite/airtable/setup.ts), against a scripted Meta API', () => {
  it('dry run: six tables first, then link fields; the "Lite Jobs" back-link is left to Airtable', async () => {
    const { plan } = await import('../lite/airtable/setup.js');
    const p = plan('appZZZZZZZZZZZZZZ');
    expect(p.slice(0, 6).map((c) => (c.body as { name: string }).name)).toEqual(['Lite Contacts', 'Lite Properties', 'Lite Jobs', 'Lite Quotes', 'Lite Message Log', 'Lite Alerts']);
    expect(p.slice(6).map((c) => c.note)).toEqual(['link Lite Properties.Contact -> Lite Contacts', 'link Lite Jobs.Contact -> Lite Contacts', 'link Lite Jobs.Property -> Lite Properties',
      'link Lite Quotes.Job -> Lite Jobs', 'link Lite Message Log.Job -> Lite Jobs', 'link Lite Message Log.Contact -> Lite Contacts']);
    const log = (p[4]!.body as { fields: { name: string; options?: { choices?: { name: string }[] } }[] }).fields;
    expect(log.find((f) => f.name === 'Status')!.options!.choices!.map((c) => c.name)).toEqual(['Simulated Sent', 'Sending', 'Sent', 'Delivered', 'Skipped', 'Failed', 'Unknown', 'Received', 'Opt-Out']);
  });

  it('apply creates only (refuses when a Lite table exists, before any write); verify reports what is missing', async () => {
    const { apply, verify } = await import('../lite/airtable/setup.js');
    const calls: string[] = [];
    let n = 0;
    const fake = (existing: string[]) => (path: string, init: { method: string }) => {
      calls.push(`${init.method} ${path}`);
      if (init.method === 'GET') return Promise.resolve({ status: 200, json: { tables: existing.map((name) => ({ id: 'tblX', name, fields: [] })) } });
      return Promise.resolve({ status: 200, json: { id: `tblZZZZZZZZZZZZ${String(++n).padStart(2, '0')}` } });
    };
    await expect(apply('appZZZZZZZZZZZZZZ', fake(['Quotes', 'Lite Jobs']), () => undefined)).rejects.toThrow(/Lite Jobs already exist[\s\S]*Nothing was changed/);
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);
    const made = await apply('appZZZZZZZZZZZZZZ', fake(['Customers', 'Quotes']), () => undefined);
    expect(Object.keys(made)).toEqual(['contacts', 'properties', 'jobs', 'quotes', 'messages', 'alerts']);
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(12);
    expect(calls.some((c) => /DELETE|PATCH/.test(c))).toBe(false);
    expect((await verify('appZZZZZZZZZZZZZZ', fake(['Customers']))).slice(0, 2)).toEqual(['missing table Lite Contacts', 'missing table Lite Properties']);
  });

  it('upgrade (a base from the first Lite version): only adds the missing table and fields, never changes one; lists the select options to add by hand', async () => {
    const { upgrade, SCHEMA } = await import('../lite/airtable/setup.js');
    const NEW: Record<string, string[]> = { contacts: ['Review Opt-In', 'Consent Source', 'Consent Recorded At', 'Consent Wording'],
      messages: ['Purpose', 'Provider Message ID', 'Error Code', 'Attempts', 'Retry Requested', 'Retry Of', 'On Success'] };
    const old = SCHEMA.filter((t) => t.key !== 'alerts').map((t, i) => ({ id: `tblOLD0000000000${i}`, name: t.name, fields: t.fields.filter((f) => !(NEW[t.key] ?? []).includes(f.name))
      .map((f) => ({ name: f.name, type: f.type, options: f.options ? { choices: (t.key === 'messages' && f.name === 'Status' ? ['Simulated Sent', 'Skipped', 'Failed', 'Received', 'Opt-Out'] : f.options).map((name) => ({ name })) } : undefined })) }));
    const calls: { method: string; path: string; body?: string }[] = [];
    const meta = (path: string, init: { method: string; body?: string }) => {
      calls.push({ method: init.method, path, ...(init.body ? { body: init.body } : {}) });
      return Promise.resolve(init.method === 'GET' ? { status: 200, json: { tables: old } } : { status: 200, json: { id: 'tblNEWALERTS00001' } });
    };
    const r = await upgrade('appZZZZZZZZZZZZZZ', meta, () => undefined);
    expect(r.created).toEqual(['table Lite Alerts', ...NEW.contacts!.map((f) => `Lite Contacts.${f}`), ...NEW.messages!.map((f) => `Lite Message Log.${f}`)]);
    expect(r.manual).toEqual(['Sending', 'Sent', 'Delivered', 'Unknown'].map((o) => `Lite Message Log.Status: add the option "${o}"`));
    expect(calls.every((c) => c.method === 'GET' || c.method === 'POST')).toBe(true);
  });
});

describe('demo data for real Airtable (lite/airtable/seed-demo.ts), against the schema-enforcing Airtable', () => {
  it('creates contacts, properties, jobs and quotes in link order with real ids; refuses a second load before writing', async () => {
    const { seedDemo } = await import('../lite/airtable/seed-demo.js');
    const target = new FakeAirtable(config.airtable.baseId, config.airtable.tables);
    const fetchJson = (path: string, init: { method: string; body?: string }) => {
      const u = new URL(`https://api.airtable.com${path}`);
      const r = target.http({ method: init.method, url: `${u.origin}${u.pathname}`, query: Object.fromEntries(u.searchParams), ...(init.body ? { body: JSON.parse(init.body) as unknown } : {}) });
      return Promise.resolve({ status: r.statusCode, json: r.body });
    };
    expect(await seedDemo(config.airtable.baseId, config.airtable.tables, fetchJson, () => undefined)).toEqual({ contacts: 14, properties: 15, jobs: 15, quotes: 2 });
    expect(target.all('jobs').every((j) => target.get('contacts', (j.fields.Contact as string[])[0]!))).toBe(true);
    const n = target.requests.filter((r) => r.method === 'POST').length;
    await expect(seedDemo(config.airtable.baseId, config.airtable.tables, fetchJson, () => undefined)).rejects.toThrow(/already holds Demo Data/);
    expect(target.requests.filter((r) => r.method === 'POST').length).toBe(n);
    expect(runNow(wf['review-requests'], target.http).summary).toMatchObject({ sent: 2, skipped: 3, not_due_yet: 1 });
  });
});

describe('webhook protection', () => {
  it('lead webhook: with webhookAuth set it requires that Header Auth credential; Twilio replies: Basic Auth mode uses its credential and no signature secret', async () => {
    const secured = structuredClone(config); secured.webhookAuth = { id: 'HeaderAuthZZZ001', name: 'ZZ Lite webhook key' };
    await buildAll(secured, 'auth');
    for (const w of ['lead-follow-up', 'inbound-replies']) {
      const hook = imports('auth', w).nodes.find((n) => n.type === 'n8n-nodes-base.webhook')!;
      expect(hook.parameters, w).toMatchObject({ authentication: 'headerAuth' });
      expect(hook.credentials, w).toEqual({ httpHeaderAuth: secured.webhookAuth });
    }
    expect(imports('demo', 'lead-follow-up').nodes.find((n) => n.type === 'n8n-nodes-base.webhook')!.parameters).not.toHaveProperty('authentication');
    const basic = structuredClone(base); basic.messaging.twilio!.inboundAuth = 'basic-auth'; basic.messaging.twilio!.inboundCredential = { id: 'BasicAuthZZZZ001', name: 'ZZ Twilio webhook login' };
    await buildAll(basic, 'basic');
    const hook = imports('basic', 'inbound-replies').nodes.find((n) => n.type === 'n8n-nodes-base.webhook')!;
    expect(hook).toMatchObject({ parameters: { authentication: 'basicAuth' }, credentials: { httpBasicAuth: basic.messaging.twilio!.inboundCredential } });
    expect(JSON.stringify(imports('basic', 'lead-follow-up'))).not.toContain('StatusCallback');   // receipts are set in the Twilio console (with the login)
    const bad = structuredClone(config); bad.webhookAuth = { id: 'x', name: '' };
    expect(configProblems(bad).join()).toMatch(/webhookAuth/);
  });

  it('a workflow whose webhook needs a login saves no production executions: n8n keeps the request headers, login included, in saved executions', () => {
    const NO_SAVE = { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none' };
    for (const w of ['lead-follow-up', 'inbound-replies']) expect(imports('auth', w).settings, w).toMatchObject(NO_SAVE);
    expect(imports('basic', 'inbound-replies').settings).toMatchObject(NO_SAVE);
    expect(imports('basic', 'lead-follow-up').settings).not.toHaveProperty('saveDataSuccessExecution');
    for (const w of WORKFLOWS) expect(imports('demo', w).settings, w).not.toHaveProperty('saveDataSuccessExecution');
  });
});
