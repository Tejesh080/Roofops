/**
 * Synthetic Lite demo data. Every record is clearly fake: names start "ZZ Lite Demo", e-mails are @example.test, phones
 * are in the 0400 000 xxx range, and Demo Data is ticked. Dates are relative to "now" so the demo always shows each case.
 *
 * Consent: these are invented test people, so their consent is invented too, and labelled as such ("Synthetic demo
 * fixture"). Zoe shows what happens to a real contact whose Marketing Opt-In box is ticked without any record of where
 * or when: Lite does not message her. Never copy this evidence onto real contacts.
 */
import type { FakeAirtable } from './fake-airtable.js';

const ago = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();

export interface Seeded { contacts: Record<string, string>; jobs: Record<string, string> }

export function seed(at: FakeAirtable): Seeded {
  const contacts: Record<string, string> = {};
  const jobs: Record<string, string> = {};
  const person = (key: string, name: string, f: Record<string, unknown>) => {
    const first = name.replace('ZZ Lite Demo ', '').split(' ')[0];
    contacts[key] = at.insert('contacts', { Name: name, 'First Name': first, Source: 'Website', 'Demo Data': true, ...f }).id;
  };
  const job = (key: string, contact: string, f: Record<string, unknown>) => {
    const prop = at.insert('properties', { Address: `${10 + Object.keys(jobs).length} Demo Street`, Suburb: 'Bundaberg', Postcode: '4670', Contact: [contacts[contact]!], 'Demo Data': true });
    jobs[key] = at.insert('jobs', { 'Job Ref': `LJ-DEMO-${key}`, Contact: [contacts[contact]!], Property: [prop.id], Source: 'Website', 'Invoice Status': 'Not Invoiced', 'Demo Data': true, ...f }).id;
  };
  const sms = (n: string) => ({ Phone: `0400 000 ${n}`, 'Phone Normalized': `0400000${n}`, 'Consent SMS': true, 'Preferred Channel': 'SMS' });
  const email = (local: string) => ({ Email: `${local}@example.test`, 'Consent Email': true });
  // The wording names each purpose with its tag ([reviews], [marketing]), as Lite requires of any recorded consent.
  const recorded = (d: number, what: string) => ({ 'Consent Source': 'Synthetic demo fixture (website form)', 'Consent Recorded At': ago(d),
    'Consent Wording': what.split(', ').map((p) => (p === 'service' ? p : `${p} [${p}]`)).join(', ') });

  // Review requests (finished jobs)
  person('olivia', 'ZZ Lite Demo Olivia Chen', { ...sms('101'), ...email('olivia.chen'), 'Review Opt-In': true, 'Marketing Opt-In': true, ...recorded(40, 'service, reviews, marketing') });
  job('R1', 'olivia', { Stage: 'Completed', Service: 'roof restoration', 'Lead Received At': ago(40), 'Last Activity At': ago(5), 'Completed At': ago(5) });
  person('marcus', 'ZZ Lite Demo Marcus Webb', { ...email('marcus.webb'), 'Preferred Channel': 'Email', 'Review Opt-In': true, ...recorded(60, 'service, reviews') });
  job('R2', 'marcus', { Stage: 'Paid', Service: 'gutter replacement', 'Lead Received At': ago(60), 'Last Activity At': ago(10), 'Completed At': ago(10),
    'Invoice Status': 'Paid', 'Invoice Amount': 2850 });
  person('priya', 'ZZ Lite Demo Priya Nair', { ...sms('103'), 'Review Opt-In': true, ...recorded(30, 'service, reviews'), 'Opted Out': true, 'Opted Out At': ago(20) });
  job('R3', 'priya', { Stage: 'Completed', Service: 'leak repair', 'Lead Received At': ago(30), 'Last Activity At': ago(4), 'Completed At': ago(4) });
  person('tom', 'ZZ Lite Demo Tom Fraser', { Phone: '0400 000 104', 'Phone Normalized': '0400000104' });   // gave a number, no consent
  job('R4', 'tom', { Stage: 'Invoiced', Service: 'ridge capping', 'Lead Received At': ago(25), 'Last Activity At': ago(3), 'Completed At': ago(3),
    'Invoice Status': 'Invoiced', 'Invoice Amount': 1200 });
  person('grace', 'ZZ Lite Demo Grace Lee', { ...sms('105'), 'Review Opt-In': true, ...recorded(15, 'service, reviews') });
  job('R5', 'grace', { Stage: 'Completed', Service: 'skylight install', 'Lead Received At': ago(15), 'Last Activity At': ago(1), 'Completed At': ago(1) });   // not due yet
  person('ben', 'ZZ Lite Demo Ben Carter', { ...sms('112'), ...recorded(20, 'service') });   // SMS about his job only: no review request
  job('R6', 'ben', { Stage: 'Completed', Service: 'downpipe repair', 'Lead Received At': ago(20), 'Last Activity At': ago(6), 'Completed At': ago(6) });

  // Reactivation (quiet open enquiries)
  person('daniel', 'ZZ Lite Demo Daniel Brooks', { ...sms('106'), 'Marketing Opt-In': true, ...recorded(130, 'service, marketing') });
  job('A1', 'daniel', { Stage: 'Quoted', Service: 'full re-roof', 'Lead Received At': ago(130), 'Last Activity At': ago(120) });
  person('sophie', 'ZZ Lite Demo Sophie Turner', { ...sms('107'), ...recorded(210, 'service') });   // no marketing permission
  job('A2', 'sophie', { Stage: 'Contacted', Service: 'roof inspection', 'Lead Received At': ago(210), 'Last Activity At': ago(200) });
  person('liam', 'ZZ Lite Demo Liam OBrien', { ...sms('108'), 'Marketing Opt-In': true, ...recorded(150, 'service, marketing'), 'Opted Out': true, 'Opted Out At': ago(60) });
  job('A3', 'liam', { Stage: 'New Lead', 'Lead Received At': ago(150), 'Last Activity At': ago(150) });
  person('ava', 'ZZ Lite Demo Ava Patel', { ...sms('109'), 'Marketing Opt-In': true, ...recorded(110, 'service, marketing') });
  job('A4', 'ava', { Stage: 'Quoted', Service: 'gutter guard', 'Lead Received At': ago(110), 'Last Activity At': ago(100), 'Reactivation Sent At': ago(30), 'Reactivation Count': 1 });
  person('noah', 'ZZ Lite Demo Noah Kim', { ...email('noah.kim'), 'Marketing Opt-In': true, 'Preferred Channel': 'Email', ...recorded(25, 'service, marketing') });
  job('A5', 'noah', { Stage: 'Contacted', Service: 'solar-ready roof check', 'Lead Received At': ago(25), 'Last Activity At': ago(20) });   // still active
  person('mia', 'ZZ Lite Demo Mia Rossi', { ...email('mia.rossi'), 'Marketing Opt-In': true, 'Preferred Channel': 'Email', ...recorded(160, 'service, marketing') });
  job('A6', 'mia', { Stage: 'Quoted', Service: 'roof painting', 'Lead Received At': ago(160), 'Last Activity At': ago(150) });   // reactivated by email (test sink)
  person('zoe', 'ZZ Lite Demo Zoe Park', { ...sms('113'), 'Marketing Opt-In': true });   // box ticked on an old import, no record of consent: not messaged
  job('A7', 'zoe', { Stage: 'Quoted', Service: 'roof repaint', 'Lead Received At': ago(140), 'Last Activity At': ago(130) });

  // A couple of in-progress jobs, so the pipeline shows every stage
  person('jack', 'ZZ Lite Demo Jack Murray', { ...sms('111'), ...recorded(12, 'service') });
  job('P1', 'jack', { Stage: 'Accepted', Service: 'storm damage repair', 'Lead Received At': ago(12), 'Last Activity At': ago(2) });
  job('P2', 'jack', { Stage: 'Job In Progress', Service: 'flashing repair', 'Lead Received At': ago(9), 'Last Activity At': ago(1) });
  at.insert('quotes', { 'Quote Ref': 'LQ-DEMO-P1', Job: [jobs.P1!], Amount: 4200, Status: 'Accepted', 'Sent At': ago(8), 'Accepted At': ago(2), 'Demo Data': true });
  at.insert('quotes', { 'Quote Ref': 'LQ-DEMO-A1', Job: [jobs.A1!], Amount: 18950, Status: 'Sent', 'Sent At': ago(125), 'Demo Data': true });
  return { contacts, jobs };
}
