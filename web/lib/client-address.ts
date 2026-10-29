/**
 * The client address the sign-in throttle counts against. The nearest proxy appends the address it saw as the LAST
 * x-forwarded-for entry (Vercel replaces the whole header with that one address), so every earlier entry is whatever
 * the client sent and is never trusted. Without the header (a local server, no proxy) all requests share one bucket.
 */
export function clientAddress(forwardedFor: string | null | undefined): string {
  return (forwardedFor ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop() ?? 'local';
}
