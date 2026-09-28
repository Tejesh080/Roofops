/**
 * Phase 2 live verification: the HOSTED control layer after the real Airtable → n8n → Postgres → Drive → Airtable runs.
 * Read-only. Runs only with RUN_HOSTED_TESTS=1.
 *
 * These assertions are the Postgres side of the evidence. Airtable was read back with an independent Airtable
 * connection and Google Drive with the read-only [RoofOps] 98 Drive Read-Back workflow (see docs/phase2-status.md);
 * the external IDs asserted here are the ones those read-backs returned.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { HOSTED, col, openHosted } from './helpers/db.js';

const LIVE = {
  'Q-2026-0041': { project: 'PRJ-2026-0031', airtable: 'recDT4dQPmrjy5Mmu', drive: '1cI9mwecHdt2qA5961tXTa0sAgWhE6Wu9', folder: 'PRJ-2026-0031 - Oliver Grant' },
  'Q-2026-0044': { project: 'PRJ-2026-0032', airtable: 'reczFqGxwhWTHzpsP', drive: '1LoiHZu_Md0x5UJTcZqJaAbXLE45KO5qm', folder: 'PRJ-2026-0032 - Ella Thompson' },
  'Q-2026-0048': { project: 'PRJ-2026-0033', airtable: 'recIxvTNChcgkctnx', drive: '123xVm4g_FgNRyp5jddum3Q9EaEFcjzZT', folder: 'PRJ-2026-0033 - Chloe Bennett' },
} as const;

describe.runIf(HOSTED)('Phase 2 live workflow evidence [hosted]', () => {
  let db: Db;
  beforeAll(async () => { db = await openHosted(); });
  afterAll(async () => { await db.close(); });

  const forQuote = (q: string, sql: string) => col(db, sql.replaceAll(':quote', `'${q}'`));

  describe.each(Object.entries(LIVE))('%s', (quote, want) => {
    it('exactly one project, one material review, five checklist items; quote ACCEPTED', async () => {
      expect(await forQuote(quote, `select q.status || '|' || p.project_number v from quotes q join projects p on p.quote_id = q.id where q.quote_number = :quote`))
        .toEqual([`ACCEPTED|${want.project}`]);
      expect(await forQuote(quote, `select count(*)::text v from tasks t join projects p on p.id = t.project_id join quotes q on q.id = p.quote_id
                                    where q.quote_number = :quote and t.task_type = 'MATERIAL_REVIEW'`)).toEqual(['1']);
      expect(await forQuote(quote, `select count(*)::text v from project_checklist_items c join projects p on p.id = c.project_id join quotes q on q.id = p.quote_id
                                    where q.quote_number = :quote`)).toEqual(['5']);
    });

    it('both side effects DONE once, run SUCCEEDED, and every external ID verified', async () => {
      expect(await forQuote(quote, `select o.topic || ':' || o.status v from outbox o join projects p on p.id = o.aggregate_id join quotes q on q.id = p.quote_id
                                    where q.quote_number = :quote order by 1`)).toEqual(['airtable.project_writeback:DONE', 'drive.ensure_project_folder:DONE']);
      expect(await forQuote(quote, `select r.status v from workflow_runs r join projects p on p.id = r.entity_id join quotes q on q.id = p.quote_id where q.quote_number = :quote`))
        .toEqual(['SUCCEEDED']);
      const links = await forQuote(quote, `select l.provider || ':' || l.external_type || ':' || l.external_id || ':' || (l.verified_at is not null)::text v
        from external_links l join projects p on p.id = l.entity_id and l.entity_type = 'project' join quotes q on q.id = p.quote_id where q.quote_number = :quote order by 1`);
      expect(links).toHaveLength(7);
      expect(links).toContain(`AIRTABLE:Record:${want.airtable}:true`);
      expect(links).toContain(`GOOGLE_DRIVE:Folder:${want.drive}:true`);
      expect(links.filter((l) => l.startsWith('GOOGLE_DRIVE:Folder:0') && l.endsWith(':true'))).toHaveLength(5);
      expect(await forQuote(quote, `select o.result->>'name' v from outbox o join projects p on p.id = o.aggregate_id join quotes q on q.id = p.quote_id
                                    where q.quote_number = :quote and o.topic = 'drive.ensure_project_folder'`)).toEqual([want.folder]);
    });

    it('the audit trail explains the project from acceptance to verified write-back', async () => {
      const actions = await forQuote(quote, `select a.action v from audit_events a join projects p on a.entity_id in (p.id, p.quote_id) join quotes q on q.id = p.quote_id
                                             where q.quote_number = :quote order by a.seq`);
      for (const a of ['quote.accept', 'project.create', 'drive.folder.link', 'airtable.project.writeback']) expect(actions).toContain(a);
    });
  });

  it('duplicates: Q-2026-0041 was delivered 6 times (transport + semantic, incl. concurrent pings) and still has one of everything', async () => {
    expect(await col(db, `select delivery_count::text v from processed_events where idempotency_key = 'quote.accepted:Q-2026-0041:v1'`)).toEqual(['6']);
    const reasons = await col(db, `select metadata->>'reason' v from automation_events where business_reference = 'Q-2026-0041' and status = 'DUPLICATE_IGNORED' order by 1`);
    expect(reasons.filter((r) => r.startsWith('transport'))).toHaveLength(3);
    expect(reasons.filter((r) => r.startsWith('semantic'))).toHaveLength(2);
  });

  it('validation failure: Q-2026-0035 (LOST) got no project and exactly one open exception for the fact', async () => {
    expect(await col(db, `select status v from quotes where quote_number = 'Q-2026-0035'`)).toEqual(['LOST']);
    expect(await col(db, `select count(*)::text v from projects p join quotes q on q.id = p.quote_id where q.quote_number = 'Q-2026-0035'`)).toEqual(['0']);
    expect(await col(db, `select exception_number || '|' || error_class || '|' || resolution_status v from workflow_exceptions
                          where business_reference = 'Q-2026-0035' order by 1`))
      .toEqual(['EXC-0013|INVALID_STATE|OPEN', 'EXC-0014|INVALID_STATE|RESOLVED']);   // EXC-0014: pre-fix duplicate, folded by migration 700
    expect(await col(db, `select count(*)::text v from automation_events where business_reference = 'Q-2026-0035' and status = 'REJECTED'`)).toEqual(['3']);
  });

  it('transient failure: bounded retries logged per attempt; recovery; exhaustion opened an exception that auto-resolved after re-queue', async () => {
    expect(await col(db, `select s.attempt || ':' || s.status || ':' || coalesce(s.error_class, '') || ':' || coalesce(s.retry_delay_ms::text, '') v
                          from workflow_run_steps s join workflow_runs r on r.id = s.run_id where r.business_reference = 'PRJ-2026-0032' and s.step_key = 'drive.ensure_project_folder' order by s.seq`))
      .toEqual(['1:FAILED:SERVICE_UNAVAILABLE:1000', '2:FAILED:SERVICE_UNAVAILABLE:2000', '3:FAILED:SERVICE_UNAVAILABLE:4000', '4:SUCCEEDED::']);
    expect(await col(db, `select count(*)::text v from workflow_exceptions where business_reference = 'PRJ-2026-0032'`)).toEqual(['0']);
    expect(await col(db, `select error_class || '|' || resolution_status || '|' || attempt_count || '|' || resolved_by_system v from workflow_exceptions where business_reference = 'PRJ-2026-0033'`))
      .toEqual(['SERVICE_UNAVAILABLE|RESOLVED|5|workflow:quote_to_project']);
    expect(await col(db, `select attempts::text v from outbox o join projects p on p.id = o.aggregate_id where p.project_number = 'PRJ-2026-0033' and o.topic = 'drive.ensure_project_folder'`))
      .toEqual(['6']);
    expect(await col(db, `select action v from audit_events where business_reference = 'PRJ-2026-0033' and action = 'exception.retry_queued'`)).toEqual(['exception.retry_queued']);
  });

  it('no external ID is linked twice, the Airtable webhook cursor only moved forward, and the audit chain verifies', async () => {
    expect(await col(db, `select count(*)::text v from (select provider, external_id from external_links group by 1, 2 having count(*) > 1) d`)).toEqual(['0']);
    expect(Number((await col(db, `select cursor_value::text v from integration_cursors where provider = 'AIRTABLE' and cursor_key = 'ach6PdRNqU0HAb2oV'`))[0])).toBeGreaterThanOrEqual(9);
    expect(await col(db, `select coalesce(verify_audit_chain()::text, 'intact') v`)).toEqual(['intact']);
  });
});
