/**
 * npm run reissue -- request  --invoice INV-2026-0004 --by EMP-900 --reason "why this invoice must be reissued"
 * npm run reissue -- decide   --approval APR-2026-0009 --by EMP-900 [--note "what you checked"]
 * npm run reissue -- status   --invoice INV-2026-0004
 * npm run reissue -- dispatch --invoice INV-2026-0004 --hosted
 * (add --hosted to any subcommand to run it against the hosted Supabase database, SUPABASE_DB_URL in .env.local)
 *
 * The operator CLI for the supervised reissue of a voided final invoice (AC-14C Part B2, audit P2-D3). It is a
 * convenience only - the database decides: `request` and `decide` call ops_reissue_request / ops_reissue_decide on the
 * owner connection and print the JSON those functions return. `status` reads where the invoice's current Xero draft
 * generation stands. `dispatch` asks [RoofOps] 08 in n8n to send the proven reissue write through the unchanged
 * [RoofOps] 05 (src/ops/reissue-dispatch.ts) and reports how it settled. No rule of its own, no write of its own; the
 * only external call is 08's operator webhook, and only with --hosted (08 reads the hosted database).
 *
 * Without --hosted, DATABASE_URL selects the database; the default is the local Docker Postgres
 * (postgresql://postgres:postgres@127.0.0.1:54322/roofops) and a non-local DATABASE_URL is refused.
 * --invoice takes the invoice number (INV-2026-0004) or a uuid; a number is resolved with one read-only lookup, and a
 * number that names no row is sent as the nil uuid so the database's own NOT_FOUND is the answer.
 *
 * Exit codes: 0 success (ok true) - 2 a refusal or an unfinished outcome (ok false; the code is in the JSON) - 1 usage,
 * connection or unexpected error. Usage: `npm run reissue -- --help`.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeUrl, hostedDbConfig } from '../src/config/env.js';
import { openPostgres, type Db } from '../src/db/db.js';
import { dispatchReissue, n8nReissueTrigger, reissueStatus, type DispatchSelection } from '../src/ops/reissue-dispatch.js';

const LOCAL_DEFAULT = 'postgresql://postgres:postgres@127.0.0.1:54322/roofops';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

export const USAGE = [
  'usage:',
  '  npm run reissue -- request --invoice INV-2026-0004 --by EMP-900 --reason "why this invoice must be reissued"',
  '  npm run reissue -- decide  --approval APR-2026-0009 --by EMP-900 [--note "what you checked"]',
  '  npm run reissue -- status  --invoice INV-2026-0004',
  '  npm run reissue -- dispatch --invoice INV-2026-0004 --hosted',
  '',
  'request asks for a reissue of a voided final invoice (a FINANCE or ADMIN employee, a real reason);',
  'decide approves the fresh request and queues exactly one new Xero draft generation for the same invoice;',
  'status shows the invoice\'s current Xero draft generation, its write and any open exception;',
  'dispatch asks [RoofOps] 08 in n8n to create exactly that invoice\'s queued generation in Xero (REISSUE_DISPATCH_TOKEN;',
  'no other queued reissue can be sent) and waits for it.',
  '--hosted runs against the hosted database (SUPABASE_DB_URL); without it DATABASE_URL picks the local database',
  '(default postgresql://postgres:postgres@127.0.0.1:54322/roofops). dispatch needs --hosted.',
  'Exit codes: 0 success, 2 refused or not finished (the code is in the JSON), 1 usage or connection error.',
].join('\n');

/** Where the CLI writes; tests pass a collector instead of the console. */
export interface ReissueIo { print: (line: string) => void; error: (line: string) => void }
/** How `dispatch` reaches [RoofOps] 08 and waits; main() wires the n8n webhook only for --hosted, tests inject it. */
export interface ReissueDeps { trigger?: (selection: DispatchSelection) => Promise<void>; sleep?: (ms: number) => Promise<void>; polls?: number }

const FLAGS: Record<string, readonly string[]> = {
  request: ['--invoice', '--by', '--reason'],
  decide: ['--approval', '--by', '--note'],
  status: ['--invoice'],
  dispatch: ['--invoice'],
};
const REQUIRED: Record<string, readonly string[]> = {
  request: ['--invoice', '--by'], decide: ['--approval', '--by'], status: ['--invoice'], dispatch: ['--invoice'],
};

/**
 * Runs one CLI invocation against `db` and returns the exit code (0 success, 2 refusal, 1 usage/error). It parses the
 * flags, resolves an invoice number to the row it names, calls the one database function (or read) the subcommand
 * maps to and prints exactly that JSON. Everything the operator sees about the outcome comes from the database.
 */
export async function runReissue(argv: string[], db: Db, io: ReissueIo, deps: ReissueDeps = {}): Promise<number> {
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
  for (const required of REQUIRED[cmd]!) {
    if (!flags.has(required)) { io.error(`reissue: ${cmd} needs ${required}\n${USAGE}`); return 1; }
  }
  if (cmd === 'dispatch' && deps.trigger === undefined) {
    io.error(`reissue: dispatch needs --hosted ([RoofOps] 08 in n8n reads the hosted database)\n${USAGE}`);
    return 1;
  }

  try {
    const result = cmd === 'request' ? await request(db, flags)
      : cmd === 'decide' ? await decide(db, flags)
        : cmd === 'status' ? await status(db, flags)
          : await dispatchReissue(db, await invoiceId(db, flags), { ...deps, trigger: deps.trigger! });
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

/** One read-only lookup: a number names the row it names, anything else goes to the database unchanged. */
async function invoiceId(db: Db, flags: Map<string, string>): Promise<string> {
  const invoice = flags.get('--invoice') ?? '';
  return UUID.test(invoice) ? invoice : (await db.query<{ id: string }>(
    `select id::text id from invoices where invoice_number = $1`, [invoice]))[0]?.id ?? NIL_UUID;
}

async function request(db: Db, flags: Map<string, string>): Promise<Record<string, unknown>> {
  return row(await db.query<{ r: Record<string, unknown> }>(`select ops_reissue_request($1, $2, $3) r`,
    [await invoiceId(db, flags), flags.get('--by'), flags.get('--reason') ?? null]));
}

async function decide(db: Db, flags: Map<string, string>): Promise<Record<string, unknown>> {
  return row(await db.query<{ r: Record<string, unknown> }>(`select ops_reissue_decide($1, $2, $3) r`,
    [flags.get('--approval'), flags.get('--by'), flags.get('--note') ?? null]));
}

async function status(db: Db, flags: Map<string, string>): Promise<Record<string, unknown>> {
  const s = await reissueStatus(db, await invoiceId(db, flags));
  return s === undefined ? { ok: false, code: 'NOT_FOUND', detail: 'no invoice with a Xero draft generation has that number or id' } : { ok: true, ...s };
}

const row = (rows: { r: Record<string, unknown> }[]): Record<string, unknown> => {
  const first = rows[0];
  if (first === undefined) throw new Error('the database returned no result');
  return first.r;
};

/**
 * Connects (local DATABASE_URL, or the hosted database with --hosted) and runs one invocation; the CLI owns the
 * connection. Only --hosted wires dispatch to [RoofOps] 08's webhook.
 */
async function main(argv: string[]): Promise<number> {
  const hosted = argv.includes('--hosted');
  const args = argv.filter((a) => a !== '--hosted');
  let url: string;
  let caPem: string | undefined;
  if (hosted) {
    const cfg = hostedDbConfig();
    url = cfg.url; caPem = cfg.caPem;
    console.error(`reissue: target HOSTED ${describeUrl(url)} (TLS ${cfg.verified ? 'verified against SUPABASE_CA_CERT' : 'encrypted, certificate NOT verified: set SUPABASE_CA_CERT'})`);
  } else {
    url = process.env.DATABASE_URL ?? LOCAL_DEFAULT;
    if (!LOCAL_HOSTS.includes(new URL(url).hostname)) {
      console.error(`reissue: refusing to run against ${describeUrl(url)} - without --hosted this operator CLI is local-only (DATABASE_URL must point at a local database)`);
      return 1;
    }
  }
  const db = await openPostgres(url, caPem ? { caPem } : undefined);
  try {
    return await runReissue(args, db, { print: (l) => { console.log(l); }, error: (l) => { console.error(l); } },
      hosted ? { trigger: n8nReissueTrigger() } : {});
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
