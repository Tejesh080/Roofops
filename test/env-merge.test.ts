import { describe, expect, it } from 'vitest';
import { mergeEnvFile } from '../src/config/env.ts';

describe('mergeEnvFile (provision-dashboard-role writes only the keys it owns)', () => {
  const existing = '# header\nDASHBOARD_DATABASE_URL=old\nDEMO_USERNAME=sam\nDEMO_PASSWORD=keep-me-123\nAUTH_SECRET=s3cret\nDASHBOARD_DB_CA_CERT=/ca.crt\n';
  it('replaces owned keys in place and keeps the sign-in, CA and comment lines', () => {
    const out = mergeEnvFile(existing, { DASHBOARD_DATABASE_URL: 'new', DEEPSEEK_MODEL: 'm' });
    expect(out).toBe('# header\nDASHBOARD_DATABASE_URL=new\nDEMO_USERNAME=sam\nDEMO_PASSWORD=keep-me-123\nAUTH_SECRET=s3cret\nDASHBOARD_DB_CA_CERT=/ca.crt\nDEEPSEEK_MODEL=m\n');
  });
  it('creates the file content when there is none', () => {
    expect(mergeEnvFile('', { A: '1' })).toBe('A=1\n');
  });
  it('handles CRLF files', () => {
    expect(mergeEnvFile('A=1\r\nB=2\r\n', { B: '3' })).toBe('A=1\nB=3\n');
  });
});
