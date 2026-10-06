/**
 * npm run reissue -- request --invoice INV-2026-0004 --by EMP-900 --reason "why this invoice must be reissued"
 * npm run reissue -- decide  --approval APR-2026-0009 --by EMP-900 [--note "what you checked"]
 *
 * The local operator CLI for the supervised reissue of a voided final invoice (AC-14C Part B2). It is a convenience
 * only - the database decides: `request` and `decide` call ops_reissue_request / ops_reissue_decide on the owner
 * connection and print the JSON those functions return. No rule of its own, no write of its own, no external system.
 *
 * DATABASE_URL selects the database; the default is the local Docker Postgres
 * (postgresql://postgres:postgres@127.0.0.1:54322/roofops). A non-local host is refused: this CLI is offline-only.
 * --invoice takes the invoice number (INV-2026-0004) or a uuid; a number is resolved with one read-only lookup, and a
 * number that names no row is sent as the nil uuid so the database's own NOT_FOUND is the answer.
 *
 * Exit codes: 0 success (ok true) - 2 a refusal code from the database (ok false; the code is in the JSON) - 1 usage,
 * connection or unexpected error. Usage: `npm run reissue -- request|decide --help`.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeUrl } from '../src/config/env.js';
import { openPostgres, type Db } from '../src/db/db.js';

const LOCAL_DEFAULT = 'postgresql://postgres:postgres@127.0.0.1:54322/roofops';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

export const USAGE = [
  'usage:',
  '  npm run reissue -- request --invoice INV-2026-0004 --by EMP-900 --reason "why this invoice must be reissued"',
  '  npm run reissue -- decide  --approval APR-2026-0009 --by EMP-900 [--note "what you checked"]',
  '',
  'request asks for a reissue of a voided final invoice (a FINANCE or ADMIN employee, a real reason);',
  'decide approves the fresh request and queues exactly one new Xero draft generation for the same invoice.',
  'DATABASE_URL picks the local database (default postgresql://postgres:postgres@127.0.0.1:54322/roofops).',
  'Exit codes: 0 success, 2 refused by the database (the code is in the JSON), 1 usage or connection error.',
].join('\n');

/** Where the CLI writes; tests pass a collector instead of the console. */
export interface ReissueIo { print: (line: string) => void; error: (line: string) => void }

const FLAGS: Record<string, readonly string[]> = {
  request: ['--invoice', '--by', '--reason'],
  decide: ['--approval', '--by', '--note'],
};

/**
 * Runs one CLI invocation against `db` and returns the exit code (0 success, 2 refusal, 1 usage/error). It parses the
 * flags, resolves an invoice number to the row it names, calls the one database function the subcommand maps to and
 * prints exactly that JSON. Everything the operator sees about the outcome comes from the database.
 */
export async function runReissue(argv: string[], db: Db, io: ReissueIo): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h' || cmd === undefined) { io.error(USAGE); return cmd === undefined ? 1 : 0; }
  const allowed = FLAGS[cmd];
  if (allowed === undefined) { io.error(`reissue: unknown subcommand ${JSON.stringify(cmd)}\n${USAGE}`); return 1; }

  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    const value = rest[i + 1];
    if (name === undefined || value === undefined) { io.error(`reissue: ${JSON.stringify(name ?? '')} takes a value\n${USAGE}`); return 1; }
    if (!allowed.includes(name)) { io.error(`reissue: ${cmd} does not take ${name} (allowed: ${allowed.join(', ')})\n${USAGE}`); return 1; }
    flags.set(name, value);
  }
  for (const required of cmd === 'request' ? ['--invoice', '--by'] : ['--approval', '--by']) {
    if (!flags.has(required)) { io.error(`reissue: ${cmd} needs ${required}\n${USAGE}`); return 1; }
  }
  const by = flags.get('--by')!;

  try {
    const result = cmd === 'request' ? await request(db, flags, by) : await decide(db, flags, by);
    io.print(JSON.stringify(result));
    if (result.ok === true) return 0;
    if (result.ok === false) return 2;
    io.error(`reissue: the database returned an unexpected result: ${JSON.stringify(result)}`);
    return 1;
  } catch (e) {
    io.error(`reissue: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function request(db: Db, flags: Map<string, string>, by: string): Promise<Record<string, unknown>> {
  const invoice = flags.get('--invoice') ?? '';
  // One read-only lookup: a number names the row it names, anything else goes to the database unchanged.
  const id = UUID.test(invoice) ? invoice : (await db.query<{ id: string }>(
    `select id::text id from invoices where invoice_number = $1`, [invoice]))[0]?.id ?? NIL_UUID;
  return row(await db.query<{ r: Record<string, unknown> }>(`select ops_reissue_request($1, $2, $3) r`,
    [id, by, flags.get('--reason') ?? null]));
}

async function decide(db: Db, flags: Map<string, string>, by: string): Promise<Record<string, unknown>> {
  const approval = flags.get('--approval') ?? '';
  return row(await db.query<{ r: Record<string, unknown> }>(`select ops_reissue_decide($1, $2, $3) r`,
    [approval, by, flags.get('--note') ?? null]));
}

const row = (rows: { r: Record<string, unknown> }[]): Record<string, unknown> => {
  const first = rows[0];
  if (first === undefined) throw new Error('the database returned no result');
  return first.r;
};

/** Connects to DATABASE_URL (local only) and runs one invocation; the CLI owns the connection. */
async function main(argv: string[]): Promise<number> {
  const url = process.env.DATABASE_URL ?? LOCAL_DEFAULT;
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.includes(host)) {
    console.error(`reissue: refusing to run against ${describeUrl(url)} - this operator CLI is local-only (DATABASE_URL must point at a local database)`);
    return 1;
  }
  const db = await openPostgres(url);
  try {
    return await runReissue(argv, db, { print: (l) => { console.log(l); }, error: (l) => { console.error(l); } });
  } finally {
    await db.close();
  }
}

/** Only when this file is the entry point: importing it (tests) has no side effect. */
const isMain = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) process.exitCode = await main(process.argv.slice(2));
