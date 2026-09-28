import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QuoteAcceptedEvent, quoteAcceptedIdempotencyKey } from '../src/events/envelope.js';
import { loadBundle } from '../src/data/bundle.js';

const W = 'test/fixtures/webhooks/';
const read = (f: string) => readFileSync(W + f, 'utf8');
const bundle = loadBundle('data/normalised');

describe('webhook fixtures (contract for Phase 2)', () => {
  const original = QuoteAcceptedEvent.parse(JSON.parse(read('quote-accepted.Q-2026-0005.json')));

  it('the original quote.accepted fixture is valid and refers to a real accepted quote at its accepted version', () => {
    const q = bundle.quotes.rows.find((r) => r.quote_id === original.payload.quote_id)!;
    expect(q.quote_status).toBe('Accepted');
    expect(String(original.payload.accepted_version)).toBe(q.quote_version);
    expect(original.payload.accepted_on).toBe(q.quote_accepted_date);
  });

  it('transport duplicate: byte-identical redelivery, same idempotency key', () => {
    expect(read('quote-accepted.Q-2026-0005.redelivery.json')).toBe(read('quote-accepted.Q-2026-0005.json'));
  });

  it('semantic duplicate: different event_id and source, SAME business idempotency key', () => {
    const dup = QuoteAcceptedEvent.parse(JSON.parse(read('quote-accepted.Q-2026-0005.semantic-duplicate.json')));
    expect(dup.event_id).not.toBe(original.event_id);
    expect(dup.source).not.toBe(original.source);
    expect(quoteAcceptedIdempotencyKey(dup)).toBe(quoteAcceptedIdempotencyKey(original));
    expect(quoteAcceptedIdempotencyKey(original)).toBe('quote.accepted:Q-2026-0005:v2');
  });

  it('missing required field is rejected with a precise path (non-retryable validation error)', () => {
    const r = QuoteAcceptedEvent.safeParse(JSON.parse(read('quote-accepted.missing-quote-id.json')));
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join('.'))).toContain('payload.quote_id');
  });

  it('wrong type is rejected', () => {
    const r = QuoteAcceptedEvent.safeParse(JSON.parse(read('quote-accepted.wrong-type.json')));
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join('.'))).toContain('payload.accepted_version');
  });

  it('truncated body is not valid JSON', () => {
    expect(() => JSON.parse(read('quote-accepted.truncated.json.txt')) as unknown).toThrow(SyntaxError);
  });

  it('unknown fields are rejected (strict envelope)', () => {
    const r = QuoteAcceptedEvent.safeParse({ ...original, surprise: true });
    expect(r.success).toBe(false);
  });
});

describe('HTTP failure fixtures', () => {
  const files = readdirSync('test/fixtures/http');
  const load = (f: string) => JSON.parse(readFileSync(`test/fixtures/http/${f}`, 'utf8')) as Record<string, unknown>;

  it('cover 429 (Xero and Airtable), 500, timeout before commit and ambiguous timeout after commit', () => {
    expect(files.sort()).toEqual(['airtable-429.json', 'timeout-after-commit.json', 'timeout-before-commit.json', 'upstream-500.json', 'xero-429-minute-limit.json']);
    expect(load('xero-429-minute-limit.json')).toMatchObject({ status: 429, headers: { 'retry-after': '7' } });
    expect(load('airtable-429.json')).toMatchObject({ status: 429, minimum_wait_ms: 30000 });
    expect(load('timeout-before-commit.json')).toMatchObject({ kind: 'timeout', remote_committed: false });
    expect(load('timeout-after-commit.json')).toMatchObject({ kind: 'timeout', remote_committed: true });
  });

  it('the ambiguous-write fixture references a real invoice', () => {
    const ref = load('timeout-after-commit.json').remote_reference;
    expect(bundle.invoices.rows.some((i) => i.invoice_id === ref)).toBe(true);
  });
});
