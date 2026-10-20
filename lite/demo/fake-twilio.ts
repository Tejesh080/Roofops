/**
 * A local stand-in for the Twilio REST API (Messages) and its webhooks, for the Lite tests and demo. Nothing leaves this
 * machine. It answers what Lite calls: create a message, fetch one by SID, list by recipient. Behaviour per recipient
 * (E.164) can be scripted: refused (Twilio's real error codes), rate-limited, server error, or a timeout, either after
 * Twilio accepted the message ("timeout-after-send") or before ("timeout"). It also builds signed webhook requests
 * (X-Twilio-Signature: HMAC-SHA1 of URL + sorted parameters with the Auth Token), as Twilio sends them.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { HttpReq } from '../tools/runner.js';

export type Behaviour = 'invalid' | 'landline' | 'unsubscribed' | 'rate-limit' | 'server-error' | 'timeout' | 'timeout-after-send';
export interface TwMessage { sid: string; to: string; from: string; body: string; status: string; date_created: string; date_sent: string | null; error_code: number | null }

const ERRORS: Record<string, { code: number; message: string }> = {
  invalid: { code: 21211, message: "The 'To' number is not a valid phone number." },
  landline: { code: 21614, message: "'To' number is not a valid mobile number" },
  unsubscribed: { code: 21610, message: 'Attempt to send to unsubscribed recipient' },
};

export class FakeTwilio {
  readonly messages: TwMessage[] = [];
  readonly calls: HttpReq[] = [];
  readonly rules = new Map<string, Behaviour>();
  constructor(readonly accountSid: string, readonly authToken = 'zz-test-auth-token') {}

  /** Real sends: accepted "create message" calls. */
  get sent() { return this.messages; }

  readonly http = (req: HttpReq): { statusCode: number; body: unknown } => {
    this.calls.push(req);
    const u = new URL(req.url);
    const base = `/2010-04-01/Accounts/${this.accountSid}/Messages`;
    if (!(req.credentials as { httpBasicAuth?: unknown } | undefined)?.httpBasicAuth) return { statusCode: 401, body: { code: 20003, message: 'Authenticate' } };
    if (req.method === 'POST' && u.pathname === `${base}.json`) {
      const b = (req.body ?? {}) as Record<string, string>;
      if (req.contentType !== 'form-urlencoded') return { statusCode: 400, body: { code: 21603, message: 'expected a form body' } };
      if (!b.To || !(b.From || b.MessagingServiceSid) || !b.Body) return { statusCode: 400, body: { code: 21604, message: 'To, From and Body are required' } };
      const rule = this.rules.get(b.To);
      if (rule && ERRORS[rule]) return { statusCode: 400, body: { ...ERRORS[rule], status: 400, more_info: `https://www.twilio.com/docs/errors/${ERRORS[rule].code}` } };
      if (rule === 'rate-limit') return { statusCode: 429, body: { code: 20429, message: 'Too Many Requests' } };
      if (rule === 'server-error') return { statusCode: 500, body: { code: 20500, message: 'Internal Server Error' } };
      if (rule === 'timeout') throw new Error('ETIMEDOUT');
      const m: TwMessage = { sid: `SM${randomBytes(16).toString('hex')}`, to: b.To, from: b.From ?? 'MG', body: b.Body, status: 'queued', date_created: new Date().toUTCString(), date_sent: null, error_code: null };
      this.messages.push(m);
      if (rule === 'timeout-after-send') { m.status = 'sent'; m.date_sent = new Date().toUTCString(); throw new Error('ESOCKETTIMEDOUT'); }
      return { statusCode: 201, body: { ...m } };
    }
    if (req.method === 'GET' && u.pathname.startsWith(`${base}/`)) {
      const m = this.messages.find((x) => `${base}/${x.sid}.json` === u.pathname);
      return m ? { statusCode: 200, body: { ...m } } : { statusCode: 404, body: { code: 20404, message: 'not found' } };
    }
    if (req.method === 'GET' && u.pathname === `${base}.json`) {
      const to = u.searchParams.get('To'); const after = u.searchParams.get('DateSent>');
      const list = this.messages.filter((m) => (!to || m.to === to) && (!after || (m.date_sent && Date.parse(m.date_sent) >= Date.parse(after))));
      return { statusCode: 200, body: { messages: list.map((m) => ({ ...m })) } };
    }
    return { statusCode: 404, body: { code: 20404, message: `no fake for ${req.method} ${u.pathname}` } };
  };

  /** Twilio's signature for a webhook request to `url` with these form parameters. */
  sign(url: string, params: Record<string, string>, token = this.authToken) {
    return createHmac('sha1', token).update(url + Object.keys(params).sort().map((k) => k + String(params[k])).join(''), 'utf8').digest('base64');
  }
  /** A delivery receipt for one of our messages, as Twilio would POST it to StatusCallback. */
  statusCallback(sid: string, status: string, errorCode?: string) {
    const m = this.messages.find((x) => x.sid === sid);
    if (m) { m.status = status; if (status !== 'queued') m.date_sent ??= new Date().toUTCString(); }
    return { AccountSid: this.accountSid, MessageSid: sid, SmsSid: sid, MessageStatus: status, SmsStatus: status, To: m?.to ?? '', From: m?.from ?? '', ApiVersion: '2010-04-01',
      ...(errorCode ? { ErrorCode: errorCode } : {}) };
  }
  /** An SMS a person sends to the business number, as Twilio would POST it to the messaging webhook. */
  inbound(from: string, to: string, body: string) {
    return { AccountSid: this.accountSid, MessageSid: `SM${randomBytes(16).toString('hex')}`, SmsSid: '', From: from, To: to, Body: body, NumMedia: '0', NumSegments: '1', SmsStatus: 'received', ApiVersion: '2010-04-01' };
  }
}

/** One HTTP handler for the runner: Twilio calls to the fake Twilio, everything else to the given handler (the Airtable). */
export const route = (tw: FakeTwilio, other: (r: HttpReq) => { statusCode: number; body: unknown }) => (r: HttpReq) => (r.url.startsWith('https://api.twilio.com/') ? tw.http(r) : other(r));
