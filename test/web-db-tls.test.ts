import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dashboardDbTarget } from '../web/lib/db-tls.ts';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';
const REMOTE = 'postgresql://roofops_web.ref:pw@aws-0-region.pooler.supabase.com:5432/postgres';

describe('dashboard database TLS', () => {
  it('a local database is plain TCP, whatever sslmode the URL carries', () => {
    expect(dashboardDbTarget('postgresql://u:p@127.0.0.1:54322/roofops_sprint?sslmode=disable', {}))
      .toEqual({ connectionString: 'postgresql://u:p@127.0.0.1:54322/roofops_sprint', ssl: false });
    expect(dashboardDbTarget('postgresql://u:p@localhost:5432/db', {}).ssl).toBe(false);
  });
  it('a remote database without a CA is refused (never an unverified connection)', () => {
    expect(() => dashboardDbTarget(REMOTE, {})).toThrow(/cannot be verified/);
    expect(() => dashboardDbTarget(REMOTE, { DASHBOARD_DB_CA_PEM: 'not a certificate' })).toThrow(/cannot be verified/);
  });
  it('a remote database is verified against DASHBOARD_DB_CA_PEM (\\n-escaped, as on Vercel)', () => {
    const t = dashboardDbTarget(`${REMOTE}?sslmode=require`, { DASHBOARD_DB_CA_PEM: PEM.replace(/\n/g, '\\n') });
    expect(t).toEqual({ connectionString: REMOTE, ssl: { ca: PEM, rejectUnauthorized: true } });
  });
  it('or against the CA file named by DASHBOARD_DB_CA_CERT', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'roofops-ca-')), 'ca.crt');
    writeFileSync(f, PEM + '\n');
    expect(dashboardDbTarget(REMOTE, { DASHBOARD_DB_CA_CERT: f }).ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
  });
  it('URL parameters cannot switch verification off (pg lets them override the ssl option)', () => {
    const t = dashboardDbTarget(`${REMOTE}?sslmode=no-verify&sslrootcert=/x`, { DASHBOARD_DB_CA_PEM: PEM });
    expect(t.connectionString).toBe(REMOTE);
    expect(t.ssl).toMatchObject({ rejectUnauthorized: true });
  });
});
