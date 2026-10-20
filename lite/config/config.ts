/** RoofOps Lite configuration: one JSON file per business (lite/config/<client>.json). Validated before any build. */
import { readFileSync } from 'node:fs';

export interface LiteConfig {
  business: { name: string; trade: string; phone: string; signoff: string; timezone: string };
  airtable: { baseId: string; credential: { id: string; name: string };
    tables: { contacts: string; properties: string; jobs: string; quotes: string; messages: string } };
  messaging: { mode: 'test-sink'; provider: string };
  leadIntake: { webhookPath: string; dedupeWindowDays: number; sms: string; emailSubject: string; email: string };
  reviews: { googleReviewUrl: string; delayDays: number; maxPerRun: number; sms: string; emailSubject: string; email: string };
  reactivation: { inactivityDays: number; cooldownDays: number; maxPerRun: number; stages: string[]; sms: string; emailSubject: string; email: string };
  replies: { webhookPath: string; optOutKeywords: string[] };
  /** Before go-live: an n8n "Header Auth" credential both webhooks require (the form and the provider send that header). */
  webhookAuth?: { id: string; name: string } | null;
}

const STAGES = ['New Lead', 'Contacted', 'Quoted', 'Accepted', 'Job In Progress', 'Completed', 'Invoiced', 'Paid', 'Lost'];

/** A config as read from a file: any part may be missing until it is checked. */
type Incomplete<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? Incomplete<T[K]> : T[K] };

/** Every problem with a config, or [] when it is usable. */
export function configProblems(input: LiteConfig | Incomplete<LiteConfig>): string[] {
  const c = input as Incomplete<LiteConfig>;
  const p: string[] = [];
  const text = (v: unknown, k: string) => { if (typeof v !== 'string' || !v.trim() || /^<.*>$/.test(v.trim())) p.push(`${k} is missing (still a <placeholder>?)`); };
  const pos = (v: unknown, k: string) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) p.push(`${k} must be a number >= 0`); };
  text(c.business?.name, 'business.name'); text(c.business?.phone, 'business.phone'); text(c.business?.signoff, 'business.signoff');
  if (!/^app[A-Za-z0-9]{14}$/.test(c.airtable?.baseId ?? '')) p.push('airtable.baseId must be an Airtable base id (appXXXXXXXXXXXXXX)');
  if (!/^[A-Za-z0-9]{16}$/.test(c.airtable?.credential?.id ?? '')) p.push('airtable.credential.id must be an n8n credential id');
  for (const k of ['contacts', 'properties', 'jobs', 'quotes', 'messages'] as const) text(c.airtable?.tables?.[k], `airtable.tables.${k}`);
  if (c.messaging?.mode !== 'test-sink') p.push('messaging.mode must be "test-sink" (Lite never sends real messages)');
  text(c.leadIntake?.webhookPath, 'leadIntake.webhookPath'); pos(c.leadIntake?.dedupeWindowDays, 'leadIntake.dedupeWindowDays');
  for (const k of ['sms', 'email', 'emailSubject'] as const) { text(c.leadIntake?.[k], `leadIntake.${k}`); text(c.reviews?.[k], `reviews.${k}`); text(c.reactivation?.[k], `reactivation.${k}`); }
  if (!/^https:\/\/\S+$/.test(c.reviews?.googleReviewUrl ?? '')) p.push('reviews.googleReviewUrl must be an https URL');
  if (!(c.reviews?.sms ?? '').includes('{reviewUrl}') || !(c.reviews?.email ?? '').includes('{reviewUrl}')) p.push('review templates must contain {reviewUrl}');
  pos(c.reviews?.delayDays, 'reviews.delayDays'); pos(c.reviews?.maxPerRun, 'reviews.maxPerRun');
  pos(c.reactivation?.inactivityDays, 'reactivation.inactivityDays'); pos(c.reactivation?.cooldownDays, 'reactivation.cooldownDays'); pos(c.reactivation?.maxPerRun, 'reactivation.maxPerRun');
  const stages = c.reactivation?.stages;
  if (!Array.isArray(stages) || !stages.length || stages.some((s) => !STAGES.includes(s))) p.push(`reactivation.stages must be some of: ${STAGES.join(', ')}`);
  if (!(c.reactivation?.sms ?? '').toUpperCase().includes('STOP')) p.push('reactivation.sms must tell people how to opt out (STOP)');
  text(c.replies?.webhookPath, 'replies.webhookPath');
  const words = c.replies?.optOutKeywords;
  if (!Array.isArray(words) || !words.includes('STOP')) p.push('replies.optOutKeywords must include STOP');
  if (c.webhookAuth && (!/^[A-Za-z0-9]{16}$/.test(c.webhookAuth.id) || !c.webhookAuth.name)) p.push('webhookAuth must be { id, name } of an n8n Header Auth credential, or null');
  return p;
}

export function loadConfig(file: string): LiteConfig {
  const c = JSON.parse(readFileSync(file, 'utf8')) as LiteConfig;
  const p = configProblems(c);
  if (p.length) throw new Error(`${file} is not a usable Lite config:\n  - ${p.join('\n  - ')}`);
  return c;
}
