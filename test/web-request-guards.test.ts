import { describe, expect, it } from 'vitest';
import { clientAddress } from '../web/lib/client-address.ts';
import { sameOriginJson } from '../web/lib/same-origin.ts';

describe('sign-in throttle: client address', () => {
  it('counts against the address the nearest proxy appended, never one the client sent', () => {
    expect(clientAddress('203.0.113.9')).toBe('203.0.113.9');                    // Vercel: one address, set by the platform
    expect(clientAddress('1.2.3.4, 203.0.113.9')).toBe('203.0.113.9');            // a spoofed first entry is ignored
    expect(clientAddress('6.6.6.6, 7.7.7.7 , 203.0.113.9 ')).toBe('203.0.113.9');
  });
  it('without the header (a local server) every request shares one bucket', () => {
    expect(clientAddress(null)).toBe('local');
    expect(clientAddress('')).toBe('local');
    expect(clientAddress(' , ')).toBe('local');
  });
});

describe('copilot API: same-origin JSON only', () => {
  const req = (headers: Record<string, string>) => new Request('http://127.0.0.1:3000/api/copilot', { method: 'POST', headers, body: '{}' });
  it('accepts the dashboard\'s own fetch', () => {
    expect(sameOriginJson(req({ 'content-type': 'application/json', origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' }))).toBe(true);
    expect(sameOriginJson(req({ 'content-type': 'application/json; charset=utf-8', origin: 'https://roofops.example', host: 'internal:3000', 'x-forwarded-host': 'roofops.example' }))).toBe(true);
    expect(sameOriginJson(req({ 'content-type': 'application/json', host: '127.0.0.1:3000' }))).toBe(true);     // no Origin: not a cross-site browser POST
  });
  it('refuses another site and the content types a cross-site form can send without a preflight', () => {
    expect(sameOriginJson(req({ 'content-type': 'application/json', origin: 'https://attacker.example', host: '127.0.0.1:3000' }))).toBe(false);
    expect(sameOriginJson(req({ 'content-type': 'text/plain', origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' }))).toBe(false);
    expect(sameOriginJson(req({ 'content-type': 'application/x-www-form-urlencoded', host: '127.0.0.1:3000' }))).toBe(false);
    expect(sameOriginJson(req({ 'content-type': 'application/json', origin: 'null', host: '127.0.0.1:3000' }))).toBe(false);
  });
});

describe('staff Xero dispatch switch', () => {
  it('is off unless explicitly "on" (staging keeps approve and send disabled while n8n 09 is inactive)', async () => {
    const { staffDispatchEnabled } = await import('../web/lib/dispatch.ts');
    expect(staffDispatchEnabled({})).toBe(false);
    expect(staffDispatchEnabled({ STAFF_XERO_DISPATCH: 'true' })).toBe(false);
    expect(staffDispatchEnabled({ STAFF_XERO_DISPATCH: 'off' })).toBe(false);
    expect(staffDispatchEnabled({ STAFF_XERO_DISPATCH: 'on' })).toBe(true);
    expect(staffDispatchEnabled({ STAFF_XERO_DISPATCH: 'on\r' })).toBe(false);   // a stray carriage return stays off (seen on staging)
  });
});

describe('Xero drafts: staff request wording', () => {
  it('a claim 05 has already taken reads as handed over, never "claimed"', async () => {
    const { requestStatus } = await import('../web/lib/xero-request.ts');
    const req = (status: string) => ({ status, requested_by: 'A', requested_at: '2026-10-16T00:00:00Z', reason: 'r', closed_reason: null });
    expect(requestStatus({ state: 'QUEUED', request: req('QUEUED') })).toBe('waiting for the automation');
    expect(requestStatus({ state: 'STARTING', request: req('CLAIMED') })).toBe('picked up by the automation');
    for (const state of ['SENDING', 'CREATED', 'RETRY_LATER', 'FAILED', 'UNCERTAIN', 'STUCK'] as const) {
      expect(requestStatus({ state, request: req('CLAIMED') })).toBe('handed over to the automation');
    }
    expect(requestStatus({ state: 'CREATED', request: req('HANDED_OVER') })).toBe('handed over to the automation');
    expect(requestStatus({ state: 'READY_TO_SEND', request: req('REFUSED') })).toBe('refused');
    expect(requestStatus({ state: 'READY_TO_SEND', request: req('EXPIRED') })).toBe('expired');
  });
});
