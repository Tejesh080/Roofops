/** RoofOps Lite configuration: one JSON file per business (lite/config/<client>.json). Validated before any build. */
import { readFileSync } from 'node:fs';

type Cred = { id: string; name: string };

export interface LiteConfig {
  business: { name: string; trade: string; phone: string; signoff: string; timezone: string };
  airtable: { baseId: string; credential: Cred;
    tables: { contacts: string; properties: string; jobs: string; quotes: string; messages: string; alerts: string } };
  /** The n8n instance: its public URL (webhook and status callback addresses) and, once imported, the Monitor workflow id. */
  n8n: { baseUrl: string; errorWorkflowId?: string | null };
  /**
   * "test-sink" (the default): nothing is sent; each message is logged as Simulated Sent. "twilio": real SMS through
   * Twilio, but only to numbers on twilio.allowedRecipients until twilio.allowAllRecipients is set at go-live.
   */
  messaging: { mode: 'test-sink' | 'twilio'; provider: string; twilio?: TwilioConfig | null };
  consent: {
    /** Messaging rules applied. "AU": Spam Act 2003 (consent, sender identification, functional unsubscribe). */
    jurisdiction: 'AU';
    /** Where form consent is recorded from, e.g. "Website form". */
    formName: string;
    /** "express": review requests need Review Opt-In (or Marketing Opt-In) with a recorded source and date. "service": SMS/email consent is enough. */
    reviewRequests: 'express' | 'service';
    wording: { service: string; reviews: string; marketing: string };
  };
  leadIntake: { webhookPath: string; dedupeWindowDays: number; services?: string[]; sms: string; emailSubject: string; email: string };
  reviews: { googleReviewUrl: string; delayDays: number; maxPerRun: number; sms: string; emailSubject: string; email: string };
  reactivation: { inactivityDays: number; cooldownDays: number; maxPerRun: number; stages: string[]; sms: string; emailSubject: string; email: string };
  replies: { webhookPath: string; optOutKeywords: string[] };
  monitoring: { everyHours: number; stuckSendingMinutes: number; staleLeadHours: number; operatorPhone?: string | null };
  /** An n8n "Header Auth" credential the lead webhook (and, in test-sink mode, the reply webhook) requires. */
  webhookAuth?: Cred | null;
}

export interface TwilioConfig {
  /** AC... (an identifier, not a secret). */
  accountSid: string;
  /** The sender: an E.164 number that can receive replies (needed for STOP). Or set messagingServiceSid. */
  from?: string | null;
  messagingServiceSid?: string | null;
  /** n8n "Basic Auth" credential used to call Twilio: API Key SID + Secret (recommended) or Account SID + Auth Token. */
  credential: Cred;
  /**
   * How Twilio's webhooks are checked. "signature": X-Twilio-Signature with the Auth Token kept in the n8n Variable
   * signatureVariable (n8n Cloud Pro/Enterprise). "basic-auth": the webhook needs the n8n Basic Auth credential
   * inboundCredential, and Twilio's webhook URLs carry those credentials (set in the Twilio console).
   */
  inboundAuth: 'signature' | 'basic-auth';
  signatureVariable?: string;
  inboundCredential?: Cred | null;
  /** Live safety: only these numbers get real messages. Required until allowAllRecipients is true. */
  allowedRecipients: string[];
  allowAllRecipients?: boolean;
}

const STAGES = ['New Lead', 'Contacted', 'Quoted', 'Accepted', 'Job In Progress', 'Completed', 'Invoiced', 'Paid', 'Lost'];

/** A config as read from a file: any part may be missing until it is checked. */
type Incomplete<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object | null | undefined ? Incomplete<NonNullable<T[K]>> | null : T[K] };

const CRED_ID = /^[A-Za-z0-9]{16}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;

/** Every problem with a config, or [] when it is usable. */
export function configProblems(input: LiteConfig | Incomplete<LiteConfig>): string[] {
  const c = input as Incomplete<LiteConfig>;
  const p: string[] = [];
  const text = (v: unknown, k: string) => { if (typeof v !== 'string' || !v.trim() || /^<.*>$/.test(v.trim())) p.push(`${k} is missing (still a <placeholder>?)`); };
  const pos = (v: unknown, k: string) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) p.push(`${k} must be a number >= 0`); };
  const cred = (v: Incomplete<Cred> | null | undefined, k: string) => { if (!v || !CRED_ID.test(v.id ?? '') || !v.name) p.push(`${k} must be { id, name } of an n8n credential`); };
  text(c.business?.name, 'business.name'); text(c.business?.phone, 'business.phone'); text(c.business?.signoff, 'business.signoff');
  if (!/^[A-Za-z]+\/[A-Za-z_]+/.test(c.business?.timezone ?? '')) p.push('business.timezone must be an IANA time zone, e.g. Australia/Brisbane');
  if (!/^app[A-Za-z0-9]{14}$/.test(c.airtable?.baseId ?? '')) p.push('airtable.baseId must be an Airtable base id (appXXXXXXXXXXXXXX)');
  cred(c.airtable?.credential, 'airtable.credential');
  for (const k of ['contacts', 'properties', 'jobs', 'quotes', 'messages', 'alerts'] as const) text(c.airtable?.tables?.[k], `airtable.tables.${k}`);
  if (!/^https:\/\/[^/\s]+$/.test(c.n8n?.baseUrl ?? '')) p.push('n8n.baseUrl must be the https address of the n8n instance, without a trailing slash');
  if (c.n8n?.errorWorkflowId && !CRED_ID.test(c.n8n.errorWorkflowId)) p.push('n8n.errorWorkflowId must be the id of the imported [Lite] Monitor workflow, or null');

  // Messaging: test sink by default; Twilio only with a sender that can receive STOP and a live-test allowlist.
  const mode = c.messaging?.mode;
  if (mode !== 'test-sink' && mode !== 'twilio') p.push('messaging.mode must be "test-sink" or "twilio"');
  text(c.messaging?.provider, 'messaging.provider');
  if (mode === 'twilio') {
    const t = c.messaging?.twilio;
    if (!t) p.push('messaging.twilio is required when messaging.mode is "twilio"');
    else {
      if (!/^AC[0-9a-f]{32}$/.test(t.accountSid ?? '')) p.push('messaging.twilio.accountSid must be an Account SID (AC + 32 hex characters)');
      if (!t.from === !t.messagingServiceSid) p.push('messaging.twilio needs exactly one of from (an E.164 number) or messagingServiceSid');
      if (t.from && !E164.test(t.from)) p.push('messaging.twilio.from must be an E.164 phone number (+61...): an alphanumeric sender cannot receive STOP replies, so it cannot be used');
      if (t.messagingServiceSid && !/^MG[0-9a-f]{32}$/.test(t.messagingServiceSid)) p.push('messaging.twilio.messagingServiceSid must be MG + 32 hex characters');
      cred(t.credential, 'messaging.twilio.credential');
      if (t.inboundAuth === 'signature') { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.signatureVariable ?? '')) p.push('messaging.twilio.signatureVariable must name the n8n Variable that holds the Twilio Auth Token'); }
      else if (t.inboundAuth === 'basic-auth') cred(t.inboundCredential, 'messaging.twilio.inboundCredential');
      else p.push('messaging.twilio.inboundAuth must be "signature" or "basic-auth"');
      const list = t.allowedRecipients;
      if (!Array.isArray(list) || list.some((n) => typeof n !== 'string' || !E164.test(n))) p.push('messaging.twilio.allowedRecipients must be a list of E.164 numbers');
      else if (!list.length && t.allowAllRecipients !== true) p.push('messaging.twilio.allowedRecipients is empty: add the approved test number, or set allowAllRecipients at go-live');
    }
  }

  // Consent (Australia: Spam Act 2003).
  if (c.consent?.jurisdiction !== 'AU') p.push('consent.jurisdiction must be "AU" (the rules Lite implements)');
  text(c.consent?.formName, 'consent.formName');
  if (c.consent?.reviewRequests !== 'express' && c.consent?.reviewRequests !== 'service') p.push('consent.reviewRequests must be "express" or "service"');
  for (const k of ['service', 'reviews', 'marketing'] as const) text(c.consent?.wording?.[k], `consent.wording.${k}`);

  text(c.leadIntake?.webhookPath, 'leadIntake.webhookPath'); pos(c.leadIntake?.dedupeWindowDays, 'leadIntake.dedupeWindowDays');
  for (const k of ['sms', 'email', 'emailSubject'] as const) { text(c.leadIntake?.[k], `leadIntake.${k}`); text(c.reviews?.[k], `reviews.${k}`); text(c.reactivation?.[k], `reactivation.${k}`); }
  if (!/^https:\/\/\S+$/.test(c.reviews?.googleReviewUrl ?? '')) p.push('reviews.googleReviewUrl must be an https URL');
  if (!(c.reviews?.sms ?? '').includes('{reviewUrl}') || !(c.reviews?.email ?? '').includes('{reviewUrl}')) p.push('review templates must contain {reviewUrl}');
  // Every message names the sender; commercial ones (reviews, reactivation) say how to unsubscribe.
  for (const [k, v] of [['leadIntake.sms', c.leadIntake?.sms], ['reviews.sms', c.reviews?.sms], ['reviews.email', c.reviews?.email], ['reactivation.sms', c.reactivation?.sms], ['reactivation.email', c.reactivation?.email]] as const)
    if (typeof v === 'string' && !v.includes('{businessName}')) p.push(`${k} must identify the sender ({businessName})`);
  for (const [k, v] of [['reviews.sms', c.reviews?.sms], ['reviews.email', c.reviews?.email], ['reactivation.sms', c.reactivation?.sms], ['reactivation.email', c.reactivation?.email]] as const)
    if (typeof v === 'string' && !v.toUpperCase().includes('STOP')) p.push(`${k} must tell people how to opt out (STOP)`);
  pos(c.reviews?.delayDays, 'reviews.delayDays'); pos(c.reviews?.maxPerRun, 'reviews.maxPerRun');
  pos(c.reactivation?.inactivityDays, 'reactivation.inactivityDays'); pos(c.reactivation?.cooldownDays, 'reactivation.cooldownDays'); pos(c.reactivation?.maxPerRun, 'reactivation.maxPerRun');
  const stages = c.reactivation?.stages;
  if (!Array.isArray(stages) || !stages.length || stages.some((s) => !STAGES.includes(s))) p.push(`reactivation.stages must be some of: ${STAGES.join(', ')}`);
  text(c.replies?.webhookPath, 'replies.webhookPath');
  const words = c.replies?.optOutKeywords;
  if (!Array.isArray(words) || !['STOP', 'UNSUBSCRIBE'].every((w) => words.includes(w))) p.push('replies.optOutKeywords must include STOP and UNSUBSCRIBE');
  if (typeof c.monitoring?.everyHours !== 'number' || c.monitoring.everyHours < 1 || c.monitoring.everyHours > 24) p.push('monitoring.everyHours must be 1 to 24');
  pos(c.monitoring?.stuckSendingMinutes, 'monitoring.stuckSendingMinutes'); pos(c.monitoring?.staleLeadHours, 'monitoring.staleLeadHours');
  if (c.monitoring?.operatorPhone && !E164.test(c.monitoring.operatorPhone)) p.push('monitoring.operatorPhone must be an E.164 number, or null');
  if (c.webhookAuth && (!CRED_ID.test(c.webhookAuth.id ?? '') || !c.webhookAuth.name)) p.push('webhookAuth must be { id, name } of an n8n Header Auth credential, or null');
  return p;
}

export function loadConfig(file: string): LiteConfig {
  const c = JSON.parse(readFileSync(file, 'utf8')) as LiteConfig;
  const p = configProblems(c);
  if (p.length) throw new Error(`${file} is not a usable Lite config:\n  - ${p.join('\n  - ')}`);
  return c;
}
