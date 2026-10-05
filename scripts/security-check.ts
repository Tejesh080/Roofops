/**
 * npm run security:check   read-only privilege audit of the HOSTED database (prints names and counts only).
 * Expected: the dashboard role reads no table and can run only the read/preview functions; the workflow role runs only
 * wf_* entry points; Supabase anon/authenticated see nothing; no function is executable by PUBLIC; every table has RLS.
 */
import { openPostgres } from '../src/db/db.js';
import { hostedDbConfig } from '../src/config/env.js';

const cfg = hostedDbConfig();
const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
const list = async (sql: string) => (await db.query<{ v: string }>(sql)).map((r) => r.v);
const PUB = `from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`;
let failures = 0;
const check = (name: string, got: string[], ok: (g: string[]) => boolean) => {
  const pass = ok(got);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${got.length > 12 ? `${got.length} items` : JSON.stringify(got)}`);
};
try {
  check('dashboard role: readable tables', await list(`select c.relname v from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('roofops_dashboard', c.oid, 'select')`), (g) => g.length === 0);
  check('dashboard role: SECURITY DEFINER functions', await list(`select p.proname v ${PUB} and p.prosecdef and has_function_privilege('roofops_dashboard', p.oid, 'execute') order by 1`),
    (g) => g.every((f) => ['app_today', 'at_link', 'integrity_check', 'invoice_final_preview', 'project_left_to_bill_after_final', 'project_over_billing', 'sm_label', 'wf_invoice_prepare'].includes(f)));
  check('dashboard role: can it write via wf_* (other than prepare)?', await list(`select p.proname v ${PUB} and p.proname like 'wf\\_%'
      and p.proname <> 'wf_invoice_prepare' and has_function_privilege('roofops_dashboard', p.oid, 'execute')`), (g) => g.length === 0);
  check('workflow role: executable functions', await list(`select p.proname v ${PUB} and has_function_privilege('roofops_workflow', p.oid, 'execute') order by 1`),
    (g) => g.every((f) => f.startsWith('wf_')));
  check('anon/authenticated: readable or writable objects', await list(`select c.relname || ':' || r.r v from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated')) r(r) where n.nspname = 'public' and c.relkind in ('r', 'v')
      and exists (select 1 from pg_roles where rolname = r.r) and (has_table_privilege(r.r, c.oid, 'select') or has_table_privilege(r.r, c.oid, 'insert'))`), (g) => g.length === 0);
  check('functions executable by PUBLIC', await list(`select p.proname v ${PUB} and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE')`), (g) => g.length === 0);
  check('tables without row level security', await list(`select c.relname v from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`), (g) => g.length === 0);
  check('Xero writes pinned to the proven Demo tenant', await list(`select value v from app_settings where key = 'xero.demo_tenant_id'`),
    (g) => g[0] === '96643bb0-3a0a-406e-96fb-ab8a933ee6b8');
  check('reconcile trigger token stored only as a hash', await list(`select length(value)::text v from app_settings where key = 'reconcile.trigger_token_sha256'`),
    (g) => g[0] === '64');
  console.log(failures ? `\n${failures} FAIL` : '\nall privilege checks pass');
  if (failures) process.exitCode = 1;
} finally {
  await db.close();
}
