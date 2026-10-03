/**
 * Reliability defect (found while verifying AC-06, 2026-10-04): the dashboard role silently used the server's real date.
 * app_today() was a plain SQL function reading app_settings.business_date_override as the CALLER. roofops_dashboard had a
 * column grant on app_settings, but RLS is on with no policy, so it saw no row and fell back to the real Brisbane date:
 * the dashboard and the Copilot ran on a different "today" from every Postgres workflow (PRJ-2026-0011 gained "Past the
 * planned finish date" once the real date passed 2026-10-01).
 *
 * Rule: there is one RoofOps business date, resolved by app_today() with the owner's rights, for every caller.
 *  * business_date_override set to a date: that date. Missing or empty: no override, the real date in Brisbane.
 *  * Anything else is refused with an error, never replaced by another date.
 *  * The dashboard reads the date only through app_today(); it has no access to app_settings rows.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';
import { TOOLS, type ToolContext } from '../web/lib/copilot/tools.ts';
import type { Query } from '../web/lib/queries.ts';

const DEMO_DATE = '2026-09-29';   // data/normalised manifest demo_date, set by the importer
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;

describe.each(TARGETS)('One RoofOps business date for every caller [%s]', (target) => {
  let db: Db;
  /** Run fn inside a transaction as the given role, then roll back. */
  const as = async <T>(role: string, fn: () => Promise<T>): Promise<T> => {
    await db.exec(`begin; set local role ${role};`);
    try { return await fn(); } finally { await db.exec('rollback'); }
  };
  const today = async () => (await col(db, `select app_today()::text v`))[0];
  const brisbane = async () => (await col(db, `select ((now() at time zone 'Australia/Brisbane')::date)::text v`))[0];
  const setOverride = (v: string | null) => v === null
    ? db.query(`delete from app_settings where key = 'business_date_override'`)
    : db.query(`insert into app_settings (key, value) values ('business_date_override', $1) on conflict (key) do update set value = excluded.value`, [v]);

  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
  }, 120_000);
  afterAll(async () => { await db.close(); });

  it('1. the dashboard role gets the configured business date', async () => {
    expect(await today()).toBe(DEMO_DATE);
    expect(await as('roofops_dashboard', today)).toBe(DEMO_DATE);
  });

  it('2. the dashboard role still cannot read ordinary app settings', async () => {
    for (const sql of [`select key, value from app_settings`, `select value from app_settings where key = 'business_date_override'`,
                       `select value from app_settings where key = 'xero.demo_tenant_id'`]) {
      await expect(as('roofops_dashboard', () => db.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it('3. a missing or empty setting means "no override" (the real Brisbane date); a malformed one is refused, never replaced', async () => {
    try {
      await setOverride(null);
      expect(await as('roofops_dashboard', today)).toBe(await brisbane());
      await setOverride('');
      expect(await as('roofops_dashboard', today)).toBe(await brisbane());
      for (const bad of ['not-a-date', '2026-13-40', '29/09/2026x']) {
        await setOverride(bad);
        await expect(today()).rejects.toThrow(/business_date_override .* is not a date/);
        await expect(as('roofops_dashboard', today)).rejects.toThrow(/business_date_override .* is not a date/);
      }
    } finally { await setOverride(DEMO_DATE); }
    expect(await as('roofops_dashboard', today)).toBe(DEMO_DATE);
  });

  it('4. Postgres workflows, the dashboard and the Copilot all resolve the same date', async () => {
    // Workflow side: the invoice preview n8n 04 gets is dated with the business date.
    const prepared = await as('roofops_workflow', async () => (await db.query<{ r: { preview?: { invoice_date?: string } } }>(`select wf_invoice_prepare($1::jsonb, 'n8n:test') r`, [JSON.stringify({
      event_id: 'EVT-DATE-1', event_type: 'invoice.prepare_requested', source: 'airtable', actor_id: 'usr7uCnNO15fCefbH', occurred_at: new Date().toISOString(),
      payload: { project_number: 'PRJ-2026-0004', airtable_record_id: recFor('PRJ-2026-0004') } })]))[0]!.r);
    expect(prepared.preview?.invoice_date).toBe(DEMO_DATE);
    // Dashboard side: the read models' as-of date, and the Copilot's "today" (which comes from them).
    const dash = await as('roofops_dashboard', async () => {
      const query: Query = (sql, params = []) => db.query(sql, params) as never;
      const ctx: ToolContext = { query, requestId: 'date-test', lastUserMessage: 'what needs attention today?' };
      return {
        kpis: (await col(db, `select as_of::text v from v_dashboard_kpis`))[0],
        copilot: ((await TOOLS.what_needs_attention_today!.run({}, ctx)).data as { today: string }).today,
      };
    });
    expect(dash).toEqual({ kpis: DEMO_DATE, copilot: DEMO_DATE });
  });

  it('5. PRJ-2026-0011\'s risk reasons follow the business date, not the server clock', async () => {
    const reasons = () => as('roofops_dashboard', () => col(db, `select unnest(risk_reasons) v from v_dashboard_projects where project_number = 'PRJ-2026-0011'`));
    expect(await reasons()).toEqual(['START_DATE_PASSED', 'SUPPLIER_ACK_OVERDUE', 'PM_FLAGGED']);
    try {
      await setOverride('2026-10-05');                                                   // after its planned finish (2026-10-01)
      expect(await reasons()).toContain('PAST_PLANNED_COMPLETION');
    } finally { await setOverride(DEMO_DATE); }
    expect(await reasons()).toEqual(['START_DATE_PASSED', 'SUPPLIER_ACK_OVERDUE', 'PM_FLAGGED']);
  });
});
