/**
 * Staff sign-in (STAFF-AUTH-01): a person signs in as themselves; the password is checked inside Postgres; the session
 * token is random and only its SHA-256 is stored; every dashboard staff action passes the token and is attributed to the
 * session's employee, never to a typed employee code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';

type R = Record<string, unknown>;
const PW = 'correct horse battery staple';

describe.each(TARGETS)('staff sign-in and sessions [%s]', (target) => {
  let db: Db;
  const q1 = async (sql: string, p: unknown[] = []) => (await db.query<{ r: R | null }>(sql, p))[0]!.r;
  const setPw = (emp: string, login: string, pw: string) => q1(`select ops_staff_set_password($1, $2, $3) r`, [emp, login, pw]);
  const signIn = (login: string, pw: string) => q1(`select web_staff_sign_in($1, $2) r`, [login, pw]);
  const session = (t: unknown) => q1(`select web_staff_session($1) r`, [t]);
  const resolve = (t: unknown, exc: string, note: string) => q1(`select web_resolve_exception($1, $2, $3) r`, [t, exc, note]);

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
  }, 120_000);
  afterAll(async () => { await db.close(); });

  it('only the owner sets passwords; the dashboard role can sign in, read its session, sign out and resolve; nobody reads the tables', async () => {
    const fn = async (f: string, role: string) => (await col(db, `select has_function_privilege('${role}', '${f}', 'execute')::text v`))[0];
    expect(await fn('ops_staff_set_password(text,text,text)', 'roofops_dashboard')).toBe('false');
    expect(await fn('ops_staff_set_password(text,text,text)', 'roofops_workflow')).toBe('false');
    for (const f of ['web_staff_sign_in(text,text)', 'web_staff_session(text)', 'web_staff_sign_out(text)', 'web_resolve_exception(text,text,text)']) {
      expect(await fn(f, 'roofops_dashboard'), f).toBe('true');
      expect(await fn(f, 'roofops_workflow'), f).toBe('false');
    }
    for (const t of ['staff_accounts', 'staff_sessions']) {
      expect(await col(db, `select has_table_privilege('roofops_dashboard', '${t}', 'select')::text v`)).toEqual(['false']);
    }
  });

  it('refuses weak passwords, short logins, unknown or inactive employees and a login another employee owns', async () => {
    await db.exec(`update employees set is_active = false where employee_code = 'EMP-007'`);
    expect(await setPw('EMP-900', 'finance', 'short')).toMatchObject({ ok: false, reason: expect.stringMatching(/12 characters/) as unknown });
    expect(await setPw('EMP-900', 'ab', PW)).toMatchObject({ ok: false, reason: expect.stringMatching(/login/) as unknown });
    expect(await setPw('EMP-999', 'nobody', PW)).toMatchObject({ ok: false });
    expect(await setPw('EMP-007', 'inactive', PW)).toMatchObject({ ok: false, reason: expect.stringMatching(/not an active/) as unknown });
    expect(await setPw('EMP-900', ' Finance.Approver ', PW)).toMatchObject({ ok: true, login: 'finance.approver' });
    expect(await setPw('EMP-002', 'finance.approver', PW)).toMatchObject({ ok: false, reason: expect.stringMatching(/another employee/) as unknown });
    expect(await setPw('EMP-002', 'estimator', PW)).toMatchObject({ ok: true });
    // Only a bcrypt hash is stored.
    const [h] = await col(db, `select password_hash v from staff_accounts a join employees e on e.id = a.employee_id where e.employee_code = 'EMP-900'`);
    expect(h).toMatch(/^\$2[aby]\$10\$/);
    expect(h).not.toContain(PW);
    expect(await col(db, `select count(*)::text v from audit_events where action = 'staff.password_set' and not (after_state::text ilike '%horse%')`)).toEqual(['2']);
  });

  it('signs in with the right password (any case of login), a random token stored only as its SHA-256; wrong or unknown logins get one generic answer', async () => {
    const generic = { ok: false, reason: 'That login and password did not match.' };
    expect(await signIn('finance.approver', 'wrong password!')).toEqual(generic);
    expect(await signIn('no.such.login', PW)).toEqual(generic);
    const s = await signIn('FINANCE.APPROVER', PW);
    expect(s).toMatchObject({ ok: true, employee_code: 'EMP-900', role: 'FINANCE' });
    expect(String(s!.token)).toMatch(/^[0-9a-f]{64}$/);
    expect(await col(db, `select count(*)::text v from staff_sessions where token_sha256 = $1`.replace('$1', `'${String(s!.token)}'`))).toEqual(['0']);
    expect(await col(db, `select count(*)::text v from staff_sessions where token_sha256 = encode(sha256(convert_to('${String(s!.token)}', 'UTF8')), 'hex')`)).toEqual(['1']);
    expect(await session(s!.token)).toEqual({ employee_code: 'EMP-900', name: expect.any(String) as unknown, role: 'FINANCE', may_resolve_exceptions: true });
    expect(await session('0'.repeat(64))).toBeNull();
    expect(await session(null)).toBeNull();
    expect(await col(db, `select count(*)::text v from audit_events where action = 'staff.signed_in' and actor_id = 'EMP-900'`)).toEqual(['1']);
  });

  it('a session ends at sign-out, at expiry, when the employee is deactivated, and when the password is reset', async () => {
    const t = async () => String((await signIn('estimator', PW))!.token);
    const a = await t();
    await db.query(`select web_staff_sign_out($1)`, [a]);
    expect(await session(a)).toBeNull();
    const b = await t();
    await db.exec(`update staff_sessions set expires_at = now() - interval '1 second' where token_sha256 = encode(sha256(convert_to('${b}', 'UTF8')), 'hex')`);
    expect(await session(b)).toBeNull();
    const c = await t();
    await db.exec(`update employees set is_active = false where employee_code = 'EMP-002'`);
    expect(await session(c)).toBeNull();
    expect(await signIn('estimator', PW)).toMatchObject({ ok: false });   // an inactive employee cannot sign in
    await db.exec(`update employees set is_active = true where employee_code = 'EMP-002'`);
    const d = await t();
    expect(await session(d)).toMatchObject({ employee_code: 'EMP-002' });
    await setPw('EMP-002', 'estimator', PW + '!');
    expect(await session(d)).toBeNull();
  });

  it('five wrong passwords lock the login for 10 minutes (even the right password is refused), audited; then it signs in again', async () => {
    for (let i = 0; i < 5; i++) expect(await signIn('estimator', 'nope nope nope')).toMatchObject({ ok: false });
    expect(await signIn('estimator', PW + '!')).toEqual({ ok: false, reason: 'Too many attempts. Try again in a few minutes.' });
    expect(await col(db, `select count(*)::text v from audit_events where action = 'staff.login_locked' and business_reference = 'EMP-002'`)).toEqual(['1']);
    await db.exec(`update staff_accounts set locked_until = now() - interval '1 second' where login = 'estimator'`);
    expect(await signIn('estimator', PW + '!')).toMatchObject({ ok: true, employee_code: 'EMP-002' });
  });

  it('resolves an exception as the session employee only: no session, an ended session or a role that may not resolve changes nothing', async () => {
    const [{ r }] = await db.query<{ r: R }>(`select wf_invoice_prepare($1::jsonb, 'test') r`, [JSON.stringify({ event_id: 'EVT-STAFF-1', event_type: 'invoice.prepare_requested',
      source: 'airtable', actor_id: 'usr7uCnNO15fCefbH', occurred_at: new Date().toISOString(), payload: { project_number: 'PRJ-2026-0009' } })]) as [{ r: R }];
    const exc = String(r.exception_number);
    const note = 'Project is still in Planning; nothing to invoice yet';
    const state = async () => (await db.query<R>(`select resolution_status, (select employee_code from employees e where e.id = x.resolved_by) by_emp
                                                  from workflow_exceptions x where exception_number = $1`, [exc]))[0];
    expect(await resolve('f'.repeat(64), exc, note)).toMatchObject({ resolved: false, reason: expect.stringMatching(/Sign in again/) as unknown });
    const estimator = String((await signIn('estimator', PW + '!'))!.token);
    expect(await session(estimator)).toMatchObject({ may_resolve_exceptions: false });
    expect(await resolve(estimator, exc, note)).toMatchObject({ resolved: false, reason: expect.stringMatching(/may not resolve/) as unknown });
    expect(await state()).toEqual({ resolution_status: 'OPEN', by_emp: null });
    const finance = String((await signIn('finance.approver', PW))!.token);
    expect(await resolve(finance, exc, note)).toMatchObject({ resolved: true, resolved_by: 'EMP-900' });
    expect(await state()).toEqual({ resolution_status: 'RESOLVED', by_emp: 'EMP-900' });
    expect(await resolve(finance, exc, note)).toMatchObject({ resolved: false, already_resolved: true });   // a double submit is safe
    expect(await col(db, `select actor_type || ':' || actor_id v from audit_events where action = 'exception.resolved' and business_reference = '${exc}'`)).toEqual(['USER:EMP-900']);
  });
});
