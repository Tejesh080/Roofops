/**
 * Current definitions in git (docs/master-plan.md Task 3.1): supabase/schema.sql and supabase/current/functions/ are
 * generated from the migrations by scripts/export-current-schema.ts, and CI's `schema` job fails when they are stale.
 * These tests cover what the script decides on its own (normalising a dump, one file per function) and that the
 * committed files are there to read. The generation itself runs against a real Postgres in the CI job.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FUNCTIONS_DIR, GENERATED, PG_VERSION, SCHEMA_FILE, functionFiles, normaliseDump } from '../scripts/export-current-schema.js';

describe('current definitions in git (master plan Task 3.1)', () => {
  it('a dump loses only what changes between runs: the random \\restrict key and the version lines', () => {
    const dump = ['--', '-- PostgreSQL database dump', '--', '', '\\restrict AbC123', '', '-- Dumped from database version 17.11',
      '-- Dumped by pg_dump version 17.11', '', 'SET statement_timeout = 0;', 'CREATE TABLE public.t (id integer);', '', '\\unrestrict AbC123', ''].join('\n');
    const out = normaliseDump(dump);
    expect(out.startsWith(`${GENERATED}\n`)).toBe(true);
    expect(out).not.toMatch(/restrict|Dumped (from|by)/);
    expect(out).toContain('SET statement_timeout = 0;\nCREATE TABLE public.t (id integer);');
    expect(out).not.toMatch(/\n\n\n/);
    expect(out.endsWith(';\n')).toBe(true);
    expect(normaliseDump(dump.replaceAll('AbC123', 'zzz999'))).toBe(out);
    expect(normaliseDump(dump.replaceAll('\n', '\r\n'))).toBe(out);
  });

  it('one file per function name, overloads together in signature order, each marked generated', () => {
    const files = functionFiles([
      { name: 'wf_b', args: 'p text', def: 'CREATE OR REPLACE FUNCTION public.wf_b(p text)\n BODY B\n' },
      { name: 'wf_a', args: 'p_key text, p_n integer', def: 'DEF A2\n' },
      { name: 'wf_a', args: 'p_key text', def: 'DEF A1\n' },
    ]);
    expect([...files.keys()]).toEqual(['wf_a.sql', 'wf_b.sql']);
    expect(files.get('wf_a.sql')).toBe(`${GENERATED}\n\nDEF A1\n\nDEF A2\n`);
    expect(files.get('wf_b.sql')).toBe(`${GENERATED}\n\nCREATE OR REPLACE FUNCTION public.wf_b(p text)\n BODY B\n`);
  });

  it('the CI job generates with the same Postgres version as the committed files', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const start = ci.indexOf('\n  schema:\n');
    expect(start).toBeGreaterThan(0);
    const rest = ci.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/);           // the next job's header
    const job = next === -1 ? rest : rest.slice(0, next + 1);
    expect(job).toContain(`image: postgres:${PG_VERSION}-alpine`);
    expect(job).toContain('npm run schema:export');
  });

  it('anyone can read the current body of integrity_check in one file, and the whole schema in another', () => {
    const f = join(FUNCTIONS_DIR, 'integrity_check.sql');
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, 'utf8')).toMatch(/CREATE OR REPLACE FUNCTION public\.integrity_check\(\)/);
    expect(readFileSync(join(FUNCTIONS_DIR, 'wf_claim_side_effect.sql'), 'utf8')).toContain('wf_claim_side_effect_core');
    expect(readFileSync(SCHEMA_FILE, 'utf8')).toMatch(/^CREATE TABLE public\.outbox \(/m);
  });
});
