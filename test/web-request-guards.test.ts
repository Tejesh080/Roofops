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
