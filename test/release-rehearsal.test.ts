/**
 * scripts/release-rehearsal.ts, its two decisions (the Docker part is exercised by running it on a real backup):
 *  - which migrations a backup lacks, and the order their rollback files run in (newest first);
 *  - which pg_restore errors are expected (the dump's own CREATE SCHEMA public) and which stop the rehearsal.
 */
import { describe, expect, it } from 'vitest';
import { planRehearsal, restoreProblems } from '../scripts/release-rehearsal.ts';

const FILES = ['20261017060000_a.sql', '20261022000000_b.sql', '20261022070000_c.sql', '20261029120000_d.sql'];
const DOWNS = ['20261022000000_b.down.sql', '20261022070000_c.down.sql', '20261029120000_d.down.sql'];

describe('planRehearsal', () => {
  it('pending = files the backup does not have, in order; rollbacks run newest first', () => {
    expect(planRehearsal(['20261017060000_a.sql'], FILES, DOWNS)).toEqual({
      pending: ['20261022000000_b.sql', '20261022070000_c.sql', '20261029120000_d.sql'],
      rollbacks: ['20261029120000_d.down.sql', '20261022070000_c.down.sql', '20261022000000_b.down.sql'],
      problems: [],
    });
  });
  it('a pending migration without a rollback file is a problem (the round trip cannot be proven)', () => {
    expect(planRehearsal(['20261017060000_a.sql'], FILES, DOWNS.slice(1)).problems)
      .toEqual(['20261022000000_b.sql has no ops/rollback/20261022000000_b.down.sql']);
  });
  it('a migration the backup has but the repository does not is a problem (hosted drift)', () => {
    expect(planRehearsal(['20261017060000_a.sql', '20261020000000_hotfix.sql'], FILES, DOWNS).problems)
      .toEqual(['the backup has 20261020000000_hotfix.sql, which is not in supabase/migrations']);
  });
  it('nothing pending is not a problem, just nothing to rehearse', () => {
    expect(planRehearsal(FILES, FILES, DOWNS)).toEqual({ pending: [], rollbacks: [], problems: [] });
  });
});

describe('restoreProblems', () => {
  it("ignores only the dump's own CREATE SCHEMA public (the scratch database already has it)", () => {
    const stderr = [
      'pg_restore: while PROCESSING TOC:',
      'pg_restore: from TOC entry 6; 2615 2200 SCHEMA public postgres',
      'pg_restore: error: could not execute query: ERROR:  schema "public" already exists',
      'Command was: CREATE SCHEMA public;',
      'pg_restore: warning: errors ignored on restore: 1',
    ].join('\n');
    expect(restoreProblems(stderr)).toEqual([]);
  });
  it('reports every other error', () => {
    const stderr = [
      'pg_restore: error: could not execute query: ERROR:  schema "public" already exists',
      'pg_restore: error: could not execute query: ERROR:  role "service_role" does not exist',
      'pg_restore: warning: errors ignored on restore: 2',
    ].join('\n');
    expect(restoreProblems(stderr)).toEqual(['ERROR:  role "service_role" does not exist']);
  });
});
