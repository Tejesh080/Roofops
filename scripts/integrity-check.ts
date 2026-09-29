/**
 * npm run integrity:check            executable invariants against the HOSTED database (read-only)
 * npm run integrity:check -- --local against the local Docker database (DATABASE_URL)
 * Prints PASS / FAIL / WARNING per rule, grouped by entity. Exit code 1 if any rule FAILs.
 */
import { openPostgres } from '../src/db/db.js';
import { hostedDbConfig, loadLocalEnv } from '../src/config/env.js';

const local = process.argv.includes('--local');
let db;
if (local) {
  loadLocalEnv();
  db = await openPostgres(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/roofops');
} else {
  const cfg = hostedDbConfig();
  db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
}
const C = { PASS: '\x1b[32m', FAIL: '\x1b[31m', WARNING: '\x1b[33m' } as const;
try {
  const rows = await db.query<{ entity: string; check_key: string; status: keyof typeof C; failing: number; detail: string; refs: string[] | null }>(
    `select entity, check_key, status, failing, detail, refs from integrity_check()`);
  let entity = '';
  for (const r of rows) {
    if (r.entity !== entity) { entity = r.entity; console.log(`\n${entity.toUpperCase()}`); }
    const refs = r.refs?.length ? `  → ${r.refs.slice(0, 6).join('; ')}${r.refs.length > 6 ? ` (+${r.refs.length - 6} more)` : ''}` : '';
    console.log(`  ${C[r.status]}${r.status.padEnd(7)}\x1b[0m ${r.check_key.padEnd(34)} ${r.detail}${r.status === 'PASS' ? '' : refs}`);
  }
  const n = (s: string) => rows.filter((r) => r.status === s).length;
  console.log(`\n${String(n('PASS'))} PASS, ${String(n('WARNING'))} WARNING, ${String(n('FAIL'))} FAIL  (${local ? 'local' : 'hosted'} database)`);
  if (n('FAIL') > 0) process.exitCode = 1;
} finally {
  await db.close();
}
