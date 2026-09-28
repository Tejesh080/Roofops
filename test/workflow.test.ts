import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPostgres, type Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, col, migratedDb } from './helpers/db.js';

type Result = Record<string, unknown> & { status: string };

function quoteAccepted(eventId: string, quote: string, version: number, extra: Record<string, unknown> = {}) {
  return {
    event_id: eventId, correlation_id: `CORR-${eventId}`, event_type: 'quote.accepted', source: 'airtable',
    actor_id: 'airtable-automation', occurred_at: '2026-09-29T09:00:00+10:00',
    payload: { quote_id: quote, accepted_version: version, accepted_on: '2026-09-29', airtable_record_id: 'recTESTTESTTEST01' },
    ...extra,
  };
}

async function call(db: Db, fn: string, ...args: unknown[]): Promise<Result> {
  const params = args.map((_, i) => `$${i + 1}`).join(', ');
  const [r] = await db.query<{ r: Result }>(`select ${fn}(${params}) as r`, args.map((a) => (a !== null && typeof a === 'object' ? JSON.stringify(a) : a)));
  return r!.r;
}
const count = async (db: Db, sql: string) => Number((await col(db, sql))[0]);

// Mutating tests: local engines only. The hosted DB is exercised through the real n8n workflow (Phase 2 E2E).
describe.each(TARGETS)('Quote Accepted -> Project workflow functions [%s]', (target) => {
  let db: Db & { url?: string };
  let created: Result;

  beforeAll(async () => { db = await migratedDb(target); await importBundle(db); });
  afterAll(async () => { await db.close(); });

  describe('happy path', () => {
    it('accepts a SENT quote and creates exactly one project with checklist, task, side effects, events and audit', async () => {
      expect(await col(db, `select status v from quotes where quote_number = 'Q-2026-0041'`)).toEqual(['SENT']);
      created = await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-0001', 'Q-2026-0041', 1));
      expect(created).toMatchObject({ status: 'CREATED', duplicate: false, project_number: 'PRJ-2026-0031', quote_number: 'Q-2026-0041',
                                       idempotency_key: 'quote.accepted:Q-2026-0041:v1' });
      const pid = created.project_id as string;
      expect(await col(db, `select status || '|' || accepted_on::text v from quotes where quote_number = 'Q-2026-0041'`)).toEqual(['ACCEPTED|2026-09-29']);
      expect(await col(db, `select c.customer_number || '|' || pr.property_number v from projects p join customers c on c.id = p.customer_id
                              join properties pr on pr.id = p.property_id where p.id = '${pid}'`)).toEqual(['CUST-0001|PROP-0041']);
      expect(await count(db, `select count(*) v from project_checklist_items where project_id = '${pid}'`)).toBe(5);
      expect(await col(db, `select task_type v from tasks where project_id = '${pid}'`)).toEqual(['MATERIAL_REVIEW']);
      expect(await col(db, `select topic || ':' || status v from outbox where aggregate_id = '${pid}' order by topic`))
        .toEqual(['airtable.project_writeback:PENDING', 'drive.ensure_project_folder:PENDING']);
      expect(await col(db, `select event_type || ':' || status v from automation_events where correlation_id = stable_uuid('correlation','CORR-EVT-T-0001') order by event_type`))
        .toEqual(['materials.review_requested:SUCCEEDED', 'project.created:SUCCEEDED', 'quote.accepted:SUCCEEDED']);
      expect(await col(db, `select action v from audit_events where correlation_id = stable_uuid('correlation','CORR-EVT-T-0001') order by seq`))
        .toEqual(['quote.accept', 'project.create', 'task.create']);
      expect(await col(db, `select status v from processed_events where idempotency_key = 'quote.accepted:Q-2026-0041:v1'`)).toEqual(['COMPLETED']);
      expect(await col(db, `select status v from workflow_runs where entity_id = '${pid}'`)).toEqual(['RUNNING']);
      expect(await col(db, `select coalesce(verify_audit_chain()::text, 'intact') v`)).toEqual(['intact']);
    });
  });

  describe('duplicates are safe', () => {
    it('transport redelivery (same event_id) returns the same project and creates nothing', async () => {
      const again = await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-0001', 'Q-2026-0041', 1));
      expect(again).toMatchObject({ status: 'DUPLICATE', duplicate: true, project_id: created.project_id, delivery_count: 2 });
      expect(await count(db, `select count(*) v from projects where quote_id = (select id from quotes where quote_number = 'Q-2026-0041')`)).toBe(1);
      expect(await col(db, `select d.status || '|' || d.error_class || '|' || o.event_key || '|' || (d.metadata->>'reason') v
                              from automation_events d join automation_events o on o.event_id = d.causation_id where d.event_key = 'EVT-T-0001:redelivery:1'`))
        .toEqual(['DUPLICATE_IGNORED|DUPLICATE_EVENT|EVT-T-0001|transport redelivery of the same event_id']);
      // the original event row is untouched
      expect(await col(db, `select status v from automation_events where event_key = 'EVT-T-0001'`)).toEqual(['SUCCEEDED']);
    });

    it('semantic duplicate (new event_id, same quote + version) is also blocked and explained', async () => {
      const dup = await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-0002', 'Q-2026-0041', 1));
      expect(dup).toMatchObject({ status: 'DUPLICATE', project_id: created.project_id, delivery_count: 3 });
      expect(await col(db, `select metadata->>'reason' v from automation_events where event_key = 'EVT-T-0002'`))
        .toEqual(['semantic duplicate: same quote and version already processed']);
      for (const [t, n] of [['projects', 1], ['tasks', 1], ['outbox', 2], ['project_checklist_items', 5]] as const) {
        const where = t === 'projects' ? `quote_id = (select id from quotes where quote_number = 'Q-2026-0041')`
          : `${t === 'outbox' ? 'aggregate_id' : 'project_id'} = '${created.project_id as string}'`;
        expect(await count(db, `select count(*) v from ${t} where ${where}`), t).toBe(n);
      }
      expect(await count(db, `select count(*) v from audit_events where action = 'project.create' and business_reference = 'PRJ-2026-0031'`)).toBe(1);
    });

    it('a duplicate still reports side effects that are not yet done, so a crashed run can be completed', async () => {
      const dup = await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-0003', 'Q-2026-0041', 1));
      expect((dup.pending_side_effects as unknown[]).length).toBe(2);
    });
  });

  describe('validation and business failures (non-retryable)', () => {
    it('rejects a missing quote_id with precise issues and opens exactly one exception, even on redelivery', async () => {
      const bad = quoteAccepted('EVT-T-BAD1', 'Q-2026-0042', 1);
      delete (bad.payload as Record<string, unknown>).quote_id;
      const r = await call(db, 'wf_quote_accepted', bad);
      expect(r).toMatchObject({ status: 'REJECTED', error_class: 'VALIDATION_ERROR', retryable: false });
      expect(r.issues).toEqual(['payload.quote_id: required, format Q-YYYY-NNNN']);
      const again = await call(db, 'wf_quote_accepted', bad);
      expect(again).toMatchObject({ status: 'REJECTED', redelivery: true, exception_number: r.exception_number });
      expect(await col(db, `select error_class || '|' || retryable::text || '|' || resolution_status v from workflow_exceptions where exception_number = '${r.exception_number as string}'`))
        .toEqual(['VALIDATION_ERROR|false|OPEN']);
      expect(await count(db, `select count(*) v from workflow_exceptions where event_id = stable_uuid('event','EVT-T-BAD1')`)).toBe(1);
    });

    it('rejects wrong types and unknown event types', async () => {
      const r = await call(db, 'wf_quote_accepted', { ...quoteAccepted('EVT-T-BAD2', 'Q-2026-0042', 1), event_type: 'quote.sent',
        payload: { quote_id: 'Q-2026-0042', accepted_version: 'two' } });
      expect(r.issues).toEqual(expect.arrayContaining(['event_type: must be quote.accepted', 'payload.accepted_version: required positive integer']));
    });

    it('NOT_FOUND, INVALID_STATE (lost quote) and INVALID_STATE (stale version) create no project', async () => {
      const projectsBefore = await count(db, 'select count(*) v from projects');
      expect(await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-NF', 'Q-2026-9999', 1))).toMatchObject({ status: 'REJECTED', error_class: 'NOT_FOUND' });
      expect(await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-LOST', 'Q-2026-0035', 1))).toMatchObject({ status: 'REJECTED', error_class: 'INVALID_STATE' });
      expect(await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-VER', 'Q-2026-0051', 1))).toMatchObject({ status: 'REJECTED', error_class: 'INVALID_STATE' });
      expect(await count(db, 'select count(*) v from projects')).toBe(projectsBefore);
      // the claim was released: the corrected event (current version v2) succeeds
      expect(await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-VER2', 'Q-2026-0051', 2))).toMatchObject({ status: 'CREATED' });
    });

    it('recovers the planted failure: accepted quote Q-2026-0031 without a project gets exactly one', async () => {
      expect(await col(db, `select quote_number v from v_accepted_quotes_without_project`)).toEqual(['Q-2026-0031']);
      expect(await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-0031', 'Q-2026-0031', 2))).toMatchObject({ status: 'CREATED' });
      expect(await col(db, `select quote_number v from v_accepted_quotes_without_project`)).toEqual([]);
    });
  });

  describe('external side effects: claim, prove, record', () => {
    const drive = () => `drive:project-folder:${created.project_id as string}`;
    const airtable = () => `airtable:project-writeback:${created.project_id as string}`;

    it('only one worker can claim a side effect', async () => {
      expect(await call(db, 'wf_claim_side_effect', drive(), 'worker-a', 120)).toMatchObject({ claimed: true, attempt: 1 });
      expect(await call(db, 'wf_claim_side_effect', drive(), 'worker-b', 120)).toMatchObject({ claimed: false, status: 'DISPATCHING' });
    });

    it('refuses to record a result without read-back verification', async () => {
      await expect(call(db, 'wf_complete_side_effect', drive(), { folder_id: 'abc', mime_type: 'application/vnd.google-apps.folder' }))
        .rejects.toThrow(/without read-back verification/);
    });

    it('transient failure: bounded backoff, not re-claimable until due, then succeeds on retry', async () => {
      const f = await call(db, 'wf_fail_side_effect', drive(), 'UPSTREAM_5XX', 'Drive returned 503', 503, null);
      expect(f).toMatchObject({ retry: true, retry_in_seconds: 1, attempt: 1 });
      expect(await col(db, `select status v from workflow_runs where entity_id = '${created.project_id as string}'`)).toEqual(['RETRY_SCHEDULED']);
      expect(await call(db, 'wf_claim_side_effect', drive(), 'worker-a', 120)).toMatchObject({ claimed: false, status: 'FAILED' });
      await new Promise((r) => setTimeout(r, 1100));
      expect(await call(db, 'wf_claim_side_effect', drive(), 'worker-a', 120)).toMatchObject({ claimed: true, attempt: 2 });
      const ok = await call(db, 'wf_complete_side_effect', drive(),
        { verified: true, folder_id: '1TESTfolderIdFromDrive', mime_type: 'application/vnd.google-apps.folder', name: 'PRJ-2026-0031 - Oliver Grant', parent_id: '1ROOT' });
      expect(ok).toMatchObject({ status: 'RECORDED', remaining_side_effects: 1 });
      expect(await col(db, `select external_id || '|' || (verified_at is not null)::text v from external_links where provider = 'GOOGLE_DRIVE' and entity_id = '${created.project_id as string}'`))
        .toEqual(['1TESTfolderIdFromDrive|true']);
      expect(await col(db, `select error_class || '|' || http_status::text || '|' || retry_delay_ms::text v from workflow_run_steps
                              where run_id = (select id from workflow_runs where entity_id = '${created.project_id as string}') and status = 'FAILED'`))
        .toEqual(['UPSTREAM_5XX|503|1000']);
    });

    it('a DONE side effect is never repeated, and a second folder for the same project is refused', async () => {
      expect(await call(db, 'wf_claim_side_effect', drive(), 'worker-c', 120)).toMatchObject({ claimed: false, status: 'DONE' });
      expect(await call(db, 'wf_complete_side_effect', drive(), { verified: true, folder_id: 'x', mime_type: 'application/vnd.google-apps.folder' }))
        .toMatchObject({ status: 'ALREADY_DONE' });
    });

    it('completing the last side effect marks the workflow run SUCCEEDED', async () => {
      expect(await call(db, 'wf_claim_side_effect', airtable(), 'worker-a', 120)).toMatchObject({ claimed: true });
      await expect(call(db, 'wf_complete_side_effect', airtable(), { verified: true, project_record_id: 'not-a-record' })).rejects.toThrow(/recXXXXXXXXXXXXXX/);
      expect(await call(db, 'wf_complete_side_effect', airtable(), { verified: true, project_record_id: 'recABCDEFGHIJKLMN' }))
        .toMatchObject({ status: 'RECORDED', remaining_side_effects: 0 });
      expect(await col(db, `select status v from workflow_runs where entity_id = '${created.project_id as string}'`)).toEqual(['SUCCEEDED']);
    });

    it('non-retryable failure (AUTH_FAILURE) dead-letters immediately with one open exception', async () => {
      const q = await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-AUTH', 'Q-2026-0044', 1));
      const key = `drive:project-folder:${q.project_id as string}`;
      await call(db, 'wf_claim_side_effect', key, 'worker-a', 120);
      const f = await call(db, 'wf_fail_side_effect', key, 'AUTH_FAILURE', 'Google token revoked', 401, null);
      expect(f).toMatchObject({ retry: false, reason: 'non-retryable error class' });
      expect(await col(db, `select status v from workflow_runs where entity_id = '${q.project_id as string}'`)).toEqual(['DEAD_LETTERED']);
      expect(await col(db, `select error_class || '|' || resolution_status v from workflow_exceptions where exception_number = '${f.exception_number as string}'`))
        .toEqual(['AUTH_FAILURE|OPEN']);
    });

    it('retryable failures stop after max attempts and open an exception', async () => {
      const q = await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-MAX', 'Q-2026-0048', 1));
      const key = `drive:project-folder:${q.project_id as string}`;
      let last: Result = { status: '' };
      for (let i = 1; i <= 5; i++) {
        await db.exec(`update outbox set next_attempt_at = now() where idempotency_key = '${key}'`);   // skip the wait in-test
        expect(await call(db, 'wf_claim_side_effect', key, 'w', 120)).toMatchObject({ claimed: true, attempt: i });
        last = await call(db, 'wf_fail_side_effect', key, 'RATE_LIMITED', 'HTTP 429', 429, 2);
        if (i < 5) expect(last).toMatchObject({ retry: true, retry_in_seconds: 2 });   // Retry-After honoured
      }
      expect(last).toMatchObject({ retry: false, reason: 'max attempts reached', attempt: 5 });
    });
  });

  describe('least privilege', () => {
    it('the workflow role can call the entry points but cannot read or write any table directly', async () => {
      await db.exec('begin; set local role roofops_workflow;');
      try {
        const r = await call(db, 'wf_claim_side_effect', 'no-such-key', 'w', 10);
        expect(r).toMatchObject({ claimed: false, status: 'UNKNOWN_KEY' });
        await db.exec('savepoint s');
        await expect(db.query('select * from projects limit 1')).rejects.toThrow(/permission denied/);
        await db.exec('rollback to savepoint s');
        await expect(db.query(`select wf_log_event('x', gen_random_uuid(), null, 'a.b', null, null, null, 'SYSTEM', null, 's', 'INFO', null, '{}', null)`))
          .rejects.toThrow(/permission denied/);
      } finally {
        await db.exec('rollback');
      }
    });
  });

  describe.runIf(target === 'postgres')('real concurrency (two connections)', () => {
    it('two workers delivering the same fact at the same instant create exactly one project', async () => {
      const [a, b] = [await openPostgres(db.url!), await openPostgres(db.url!)];
      try {
        const [r1, r2] = await Promise.all([
          call(a, 'wf_quote_accepted', quoteAccepted('EVT-RACE-A', 'Q-2026-0050', 1)),
          call(b, 'wf_quote_accepted', quoteAccepted('EVT-RACE-B', 'Q-2026-0050', 1)),
        ]);
        expect([r1.status, r2.status].sort()).toEqual(['CREATED', 'DUPLICATE']);
        expect(r1.project_id).toBe(r2.project_id);
        expect(await count(db, `select count(*) v from projects where quote_id = (select id from quotes where quote_number = 'Q-2026-0050')`)).toBe(1);
        expect(await count(db, `select count(*) v from tasks where project_id = '${r1.project_id as string}'`)).toBe(1);
      } finally { await a.close(); await b.close(); }
    });

    it('the same event_id delivered concurrently: one success, one redelivery, original event untouched', async () => {
      const [a, b] = [await openPostgres(db.url!), await openPostgres(db.url!)];
      try {
        const ev = quoteAccepted('EVT-RACE-SAME', 'Q-2026-0052', 1);
        const rs = await Promise.all([call(a, 'wf_quote_accepted', ev), call(b, 'wf_quote_accepted', ev)]);
        expect(rs.map((r) => r.status).sort()).toEqual(['CREATED', 'DUPLICATE']);
        expect(await col(db, `select status v from automation_events where event_key = 'EVT-RACE-SAME'`)).toEqual(['SUCCEEDED']);
        expect(await col(db, `select status v from automation_events where event_key = 'EVT-RACE-SAME:redelivery:1'`)).toEqual(['DUPLICATE_IGNORED']);
      } finally { await a.close(); await b.close(); }
    });

    it('two workers racing to claim the Drive side effect: exactly one wins', async () => {
      const [pid] = await col(db, `select id v from projects where quote_id = (select id from quotes where quote_number = 'Q-2026-0050')`);
      const [a, b] = [await openPostgres(db.url!), await openPostgres(db.url!)];
      try {
        const rs = await Promise.all([a, b].map((c, i) => call(c, 'wf_claim_side_effect', `drive:project-folder:${pid!}`, `w${i}`, 120)));
        expect(rs.map((r) => r.claimed).sort()).toEqual([false, true]);
      } finally { await a.close(); await b.close(); }
    });
  });
});
