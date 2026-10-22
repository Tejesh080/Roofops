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

const SUBFOLDERS = ['01 Quote', '02 Site', '03 Materials', '04 Supplier', '05 Completion'];
const FOLDER = 'application/vnd.google-apps.folder';
/** The shape n8n sends after reading the Drive folder and its children back. */
function driveProof(projectId: string, name: string, over: Record<string, unknown> = {}, folderId = '1TESTfolderIdFromDrive') {
  return {
    verified: true, folder_id: folderId, mime_type: FOLDER, name, parent_id: '1ROOT', trashed: false,
    web_view_link: `https://drive.google.com/drive/folders/${folderId}`, app_properties: { roofops_project_id: projectId },
    subfolders: SUBFOLDERS.map((n, i) => ({ id: `${folderId}-SUB${String(i)}`, name: n, parent_id: folderId, mime_type: FOLDER, trashed: false })),
    ...over,
  };
}

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
      expect(created).toMatchObject({ status: 'CREATED', outcome: 'CREATED', duplicate: false, project_number: 'PRJ-2026-0031', quote_number: 'Q-2026-0041',
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
      expect(again).toMatchObject({ status: 'DUPLICATE', outcome: 'ALREADY_PROCESSED', duplicate: true, project_id: created.project_id, delivery_count: 2 });
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
      expect(r).toMatchObject({ status: 'REJECTED', outcome: 'INVALID_EVENT', error_class: 'VALIDATION_ERROR', retryable: false });
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
      expect(await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-LOST', 'Q-2026-0035', 1))).toMatchObject({ status: 'REJECTED', outcome: 'INVALID_STATE', error_class: 'INVALID_STATE' });
      expect(await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-VER', 'Q-2026-0051', 1))).toMatchObject({ status: 'REJECTED', error_class: 'INVALID_STATE' });
      expect(await count(db, 'select count(*) v from projects')).toBe(projectsBefore);
      // the claim was released: the corrected event (current version v2) succeeds
      expect(await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-VER2', 'Q-2026-0051', 2))).toMatchObject({ status: 'CREATED' });
    });

    it('a rejected fact delivered again (redelivery or re-acceptance) reuses its one open exception (found live: EXC-0013/0014)', async () => {
      const first = await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-LOST', 'Q-2026-0035', 1));   // transport redelivery of the earlier event
      const again = await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-LOST-2', 'Q-2026-0035', 1)); // staff re-accept: new event, same fact
      expect(first).toMatchObject({ outcome: 'INVALID_STATE' });
      expect(again.exception_number).toBe(first.exception_number);
      expect(await col(db, `select exception_number || '|' || attempt_count::text v from workflow_exceptions
                              where business_reference = 'Q-2026-0035' and resolution_status = 'OPEN'`)).toEqual([`${first.exception_number as string}|3`]);
    });

    it('cross-checks the Airtable record\'s RoofOps ID against Postgres: a mismatch is never guessed at', async () => {
      const withUuid = (id: string, uuid: string) => {
        const e = quoteAccepted(id, 'Q-2026-0054', 1);
        (e.payload as Record<string, unknown>).quote_uuid = uuid;
        return e;
      };
      expect(await call(db, 'wf_quote_accepted', withUuid('EVT-T-UUID-BAD', 'not-a-uuid')))
        .toMatchObject({ status: 'REJECTED', outcome: 'INVALID_EVENT', issues: ['payload.quote_uuid: must be a UUID when present'] });
      const wrong = await col(db, `select id::text v from quotes where quote_number = 'Q-2026-0058'`);
      expect(await call(db, 'wf_quote_accepted', withUuid('EVT-T-UUID-WRONG', wrong[0]!)))
        .toMatchObject({ status: 'REJECTED', outcome: 'INVALID_STATE', error_class: 'RECONCILIATION_MISMATCH' });
      expect(await col(db, `select status v from quotes where quote_number = 'Q-2026-0054'`)).toEqual(['SENT']);
      const right = await col(db, `select id::text v from quotes where quote_number = 'Q-2026-0054'`);
      expect(await call(db, 'wf_quote_accepted', withUuid('EVT-T-UUID-OK', right[0]!))).toMatchObject({ status: 'CREATED' });
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

    it('the Airtable write-back cannot start before the Drive folder is verified (it needs the folder URL)', async () => {
      expect(await call(db, 'wf_claim_side_effect', airtable(), 'worker-a', 120))
        .toMatchObject({ claimed: false, status: 'WAITING_ON_DEPENDENCY', depends_on: drive(), dependency_status: 'DISPATCHING' });
      expect(await col(db, `select status || '|' || attempts::text v from outbox where idempotency_key = '${airtable()}'`)).toEqual(['PENDING|0']);
    });

    it('refuses Drive proof that does not match what was asked for', async () => {
      const pid = created.project_id as string;
      const name = 'PRJ-2026-0031 - Oliver Grant';
      const subs = driveProof(pid, name).subfolders;
      const cases: [Record<string, unknown>, RegExp][] = [
        [{ subfolders: subs.slice(0, 4) }, /subfolders read back/],
        [{ subfolders: subs.map((f, i) => (i === 0 ? { ...f, trashed: true } : f)) }, /subfolders read back/],
        [{ subfolders: subs.map((f, i) => (i === 0 ? { ...f, parent_id: 'elsewhere' } : f)) }, /subfolders read back/],
        [{ name: 'PRJ-2026-0031 - Someone Else' }, /does not match/],
        [{ app_properties: { roofops_project_id: '00000000-0000-0000-0000-000000000000' } }, /not tagged with project/],
        [{ trashed: true }, /trashed=false/],
      ];
      for (const [over, err] of cases) await expect(call(db, 'wf_complete_side_effect', drive(), driveProof(pid, name, over))).rejects.toThrow(err);
      expect(await count(db, `select count(*) v from external_links where provider = 'GOOGLE_DRIVE' and entity_id = '${pid}'`)).toBe(0);
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
      const ok = await call(db, 'wf_complete_side_effect', drive(), driveProof(created.project_id as string, 'PRJ-2026-0031 - Oliver Grant'));
      expect(ok).toMatchObject({ status: 'RECORDED', remaining_side_effects: 1 });
      expect(await col(db, `select external_id || '|' || (verified_at is not null)::text v from external_links where provider = 'GOOGLE_DRIVE' and entity_id = '${created.project_id as string}' and external_type = 'Folder'`))
        .toEqual(['1TESTfolderIdFromDrive|true']);
      expect(await col(db, `select external_type v from external_links where provider = 'GOOGLE_DRIVE' and entity_id = '${created.project_id as string}' and external_type like 'Folder:%' order by 1`))
        .toEqual(SUBFOLDERS.map((n) => `Folder:${n}`));
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
      const claim = await call(db, 'wf_claim_side_effect', airtable(), 'worker-a', 120);
      expect(claim).toMatchObject({ claimed: true, payload: { project_number: 'PRJ-2026-0031', status: 'Planning', quote_airtable_record_id: 'recTESTTESTTEST01',
        drive_folder: { folder_id: '1TESTfolderIdFromDrive' } } });
      const proof = { verified: true, project_record_id: 'recABCDEFGHIJKLMN', roofops_id: created.project_id, project_number: 'PRJ-2026-0031',
        linked_quote_record_ids: ['recTESTTESTTEST01'], drive_folder_url: 'https://drive.google.com/drive/folders/1TESTfolderIdFromDrive' };
      await expect(call(db, 'wf_complete_side_effect', airtable(), { ...proof, project_record_id: 'not-a-record' })).rejects.toThrow(/recXXXXXXXXXXXXXX/);
      await expect(call(db, 'wf_complete_side_effect', airtable(), { ...proof, linked_quote_record_ids: [] })).rejects.toThrow(/not linked to quote record/);
      await expect(call(db, 'wf_complete_side_effect', airtable(), { ...proof, drive_folder_url: 'https://example.com/x' })).rejects.toThrow(/does not match the verified folder/);
      await expect(call(db, 'wf_complete_side_effect', airtable(), { ...proof, roofops_id: 'someone-else' })).rejects.toThrow(/does not carry project/);
      expect(await call(db, 'wf_complete_side_effect', airtable(), proof)).toMatchObject({ status: 'RECORDED', remaining_side_effects: 0 });
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

    it('a dead-lettered side effect that later succeeds auto-resolves its exception, naming the system actor (latent CHECK bug)', async () => {
      const q = await call(db, 'wf_quote_accepted', quoteAccepted('EVT-T-HEAL', 'Q-2026-0036', 1));
      const key = `drive:project-folder:${q.project_id as string}`;
      await call(db, 'wf_claim_side_effect', key, 'w', 120);
      const f = await call(db, 'wf_fail_side_effect', key, 'PERMISSION_DENIED', 'Drive 403 on the root folder', 403, null);
      expect(f).toMatchObject({ retry: false });
      await db.exec(`update outbox set status = 'PENDING', next_attempt_at = now() where idempotency_key = '${key}'`);   // operator re-queues after fixing sharing
      await call(db, 'wf_claim_side_effect', key, 'w', 120);
      const [name] = await col(db, `select payload->>'folder_name' v from outbox where idempotency_key = '${key}'`);
      expect(await call(db, 'wf_complete_side_effect', key, driveProof(q.project_id as string, name!, {}, '1HEALfolderId'))).toMatchObject({ status: 'RECORDED', remaining_side_effects: 1 });
      expect(await col(db, `select resolution_status v from workflow_exceptions where exception_number = '${f.exception_number as string}'`)).toEqual(['OPEN']);   // run-level: still one step left
      const at = `airtable:project-writeback:${q.project_id as string}`;
      await call(db, 'wf_claim_side_effect', at, 'w', 120);
      expect(await call(db, 'wf_complete_side_effect', at, { verified: true, project_record_id: 'recHEALHEALHEAL01', roofops_id: q.project_id, project_number: q.project_number,
        linked_quote_record_ids: ['recTESTTESTTEST01'], drive_folder_url: 'https://drive.google.com/drive/folders/1HEALfolderId' })).toMatchObject({ remaining_side_effects: 0 });
      expect(await col(db, `select resolution_status || '|' || resolved_by_system v from workflow_exceptions where exception_number = '${f.exception_number as string}'`))
        .toEqual(['RESOLVED|workflow:quote_to_project']);
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

  describe('Airtable webhook cursor (n8n keeps no state)', () => {
    const hook = 'achTESTTESTTEST01';
    it('starts at 1, only moves forward, and rejects a malformed webhook id', async () => {
      expect(Number(await col(db, `select wf_airtable_cursor('${hook}') v`).then((r) => r[0]))).toBe(1);
      expect(Number((await col(db, `select wf_airtable_cursor_advance('${hook}', 7) v`))[0])).toBe(7);
      expect(Number((await col(db, `select wf_airtable_cursor_advance('${hook}', 3) v`))[0])).toBe(7);   // a slower, older execution
      expect(Number((await col(db, `select wf_airtable_cursor('${hook}') v`))[0])).toBe(7);
      await expect(db.query(`select wf_airtable_cursor_advance('not-a-hook', 9)`)).rejects.toThrow(/invalid Airtable webhook id/);
    });
  });

  describe('least privilege', () => {
    it('the workflow role can call the entry points but cannot read or write any table directly', async () => {
      await db.exec('begin; set local role roofops_workflow;');
      try {
        const r = await call(db, 'wf_claim_side_effect', 'no-such-key', 'w', 10);
        expect(r).toMatchObject({ claimed: false, status: 'UNKNOWN_KEY' });
        expect(Number((await col(db, `select wf_airtable_cursor('achTESTTESTTEST02') v`))[0])).toBe(1);
        await db.exec('savepoint c');
        await expect(db.query('select * from integration_cursors')).rejects.toThrow(/permission denied/);
        await db.exec('rollback to savepoint c');
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

  // M2: quote acceptance is deterministic. Each case was a failing test first (20261022030000).
  describe('acceptance is deterministic (AC-23, AC-25, AC-18)', () => {
    const withPayload = (id: string, quote: string, version: number, payload: Record<string, unknown>) => {
      const e = quoteAccepted(id, quote, version);
      Object.assign(e.payload, payload);
      return e;
    };
    const projectsOf = (quote: string) => count(db, `select count(*) v from projects where quote_id = (select id from quotes where quote_number = '${quote}')`);
    const exceptionsOf = (quote: string) => count(db, `select count(*) v from workflow_exceptions where business_reference = '${quote}'`);
    /** The quote's Airtable record, verified (as n8n 10's publish or the base load records it). */
    const linkQuote = (quote: string, rec: string) => db.exec(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
      select 'AIRTABLE', 'quote', id, 'Record', '${rec}', now(), now() from quotes where quote_number = '${quote}'`);
    /** Staff set Status = Sent on the quote's Airtable record; n8n 06 hands the change over (the production path). */
    const sentInAirtable = (rec: string, txn: number) => call(db, 'wf_airtable_change', {
      event_id: `airtable:achTESTTESTTEST01:txn${String(txn)}:${rec}`, source: 'airtable', actor_id: 'usrSTAFFMEMBER01', occurred_at: '2026-09-29T01:00:00Z',
      table_id: 'tblzenPRNVV5O7lZP', record_id: rec, changes: { fldQpTa5tvrzlNg1h: { current: 'Sent' } }, current: { fldQpTa5tvrzlNg1h: 'Sent' } }, 'test');

    it('AC-23: an Accepted On before Sent On is a handled rejection (one exception, no project, no raise), also delivered twice', async () => {
      // Q-2026-0032 was sent on 14 April; staff typed 13 April into Accepted On. This raised quotes_check4 before.
      expect(await col(db, `select status || '|' || sent_on::text v from quotes where quote_number = 'Q-2026-0032'`)).toEqual(['SENT|2026-04-14']);
      const bad = withPayload('EVT-T-AC23', 'Q-2026-0032', 1, { accepted_on: '2026-04-13' });
      const r = await call(db, 'wf_quote_accepted', bad);
      expect(r).toMatchObject({ status: 'REJECTED', outcome: 'INVALID_STATE', error_class: 'VALIDATION_ERROR', retryable: false,
        message: 'Accepted On is before Q-2026-0032 was sent (2026-04-14): an acceptance cannot predate its quote' });
      expect(r.exception_number).toMatch(/^EXC-\d{4}$/);
      // The same event_id again (redelivery), and a new event with the same mistake: still that one exception.
      expect(await call(db, 'wf_quote_accepted', bad)).toMatchObject({ ...r, duplicate: true, redelivery: true });
      expect(await call(db, 'wf_quote_accepted', withPayload('EVT-T-AC23-B', 'Q-2026-0032', 1, { accepted_on: '2026-01-02' })))
        .toMatchObject({ status: 'REJECTED', error_class: 'VALIDATION_ERROR', exception_number: r.exception_number });
      expect(await col(db, `select status || '|' || coalesce(accepted_on::text, '-') v from quotes where quote_number = 'Q-2026-0032'`)).toEqual(['SENT|-']);
      expect(await projectsOf('Q-2026-0032')).toBe(0);
      expect(await exceptionsOf('Q-2026-0032')).toBe(1);
      expect(await col(db, `select error_class || '|' || resolution_status || '|' || attempt_count::text v from workflow_exceptions where exception_number = '${r.exception_number as string}'`))
        .toEqual(['VALIDATION_ERROR|OPEN|3']);
      expect(await count(db, `select count(*) v from processed_events where idempotency_key = 'quote.accepted:Q-2026-0032:v1'`)).toBe(0);   // the fact stays unclaimed
    });

    it('AC-23: one bad Accepted On no longer stops the batch: the next acceptance in it is created', async () => {
      // n8n 01 accepts a batch's events one after another and advances its cursor after them: a raise stopped every later one.
      const batch = [withPayload('EVT-T-AC23-BATCH-1', 'Q-2026-0032', 1, { accepted_on: '2026-04-01' }), quoteAccepted('EVT-T-AC23-BATCH-2', 'Q-2026-0034', 2)];
      const out: string[] = [];
      for (const e of batch) out.push((await call(db, 'wf_quote_accepted', e)).status);
      expect(out).toEqual(['REJECTED', 'CREATED']);
      expect(await projectsOf('Q-2026-0034')).toBe(1);
      expect(await exceptionsOf('Q-2026-0032')).toBe(1);
    });

    it('AC-23: an Accepted On from Sent On to today is kept as given, and a future one is refused, as before (owner decision)', async () => {
      expect(await call(db, 'wf_quote_accepted', withPayload('EVT-T-AC23-OK', 'Q-2026-0032', 1, { accepted_on: '2026-04-14' }))).toMatchObject({ status: 'CREATED' });
      expect(await col(db, `select status || '|' || accepted_on::text v from quotes where quote_number = 'Q-2026-0032'`)).toEqual(['ACCEPTED|2026-04-14']);
      expect(await call(db, 'wf_quote_accepted', withPayload('EVT-T-AC23-FUTURE', 'Q-2026-0058', 1, { accepted_on: '2026-09-30' })))
        .toMatchObject({ status: 'REJECTED', outcome: 'INVALID_EVENT', error_class: 'VALIDATION_ERROR', issues: ['payload.accepted_on: cannot be in the future'] });
      expect(await projectsOf('Q-2026-0058')).toBe(0);
    });

    it('AC-25: an acceptance from an Airtable record that is not the quote\'s verified record (a duplicated row) is refused, naming both', async () => {
      await linkQuote('Q-2026-0064', 'recQ0064ORIGINAL1');
      const [id] = await col(db, `select id::text v from quotes where quote_number = 'Q-2026-0064'`);
      // Airtable's "Duplicate record" copies Quote Number and RoofOps ID onto a new record id.
      const dup = withPayload('EVT-T-AC25-DUP', 'Q-2026-0064', 1, { airtable_record_id: 'recQ0064DUPLICATE', quote_uuid: id });
      const r = await call(db, 'wf_quote_accepted', dup);
      expect(r).toMatchObject({ status: 'REJECTED', outcome: 'INVALID_STATE', error_class: 'RECONCILIATION_MISMATCH', retryable: false,
        message: 'Acceptance came from Airtable record recQ0064DUPLICATE, but Q-2026-0064 is Airtable record recQ0064ORIGINAL1: accept the quote on its own record' });
      expect(await call(db, 'wf_quote_accepted', dup)).toMatchObject({ ...r, duplicate: true });
      expect(await col(db, `select status v from quotes where quote_number = 'Q-2026-0064'`)).toEqual(['SENT']);
      expect(await projectsOf('Q-2026-0064')).toBe(0);
      expect(await exceptionsOf('Q-2026-0064')).toBe(1);
      // The quote's own record still accepts, and the project write-back links that record.
      const ok = await call(db, 'wf_quote_accepted', withPayload('EVT-T-AC25-OK', 'Q-2026-0064', 1, { airtable_record_id: 'recQ0064ORIGINAL1', quote_uuid: id }));
      expect(ok).toMatchObject({ status: 'CREATED' });
      expect(await col(db, `select payload ->> 'quote_airtable_record_id' v from outbox where topic = 'airtable.project_writeback' and aggregate_id = '${ok.project_id as string}'`))
        .toEqual(['recQ0064ORIGINAL1']);
    });

    it('AC-25: an event that names no Airtable record is judged as before, also for a quote with a verified record', async () => {
      await linkQuote('Q-2026-0058', 'recQ0058ORIGINAL1');
      const e = quoteAccepted('EVT-T-AC25-NOREC', 'Q-2026-0058', 1);
      delete (e.payload as Record<string, unknown>).airtable_record_id;
      expect(await call(db, 'wf_quote_accepted', e)).toMatchObject({ status: 'CREATED' });
      expect(await projectsOf('Q-2026-0058')).toBe(1);
    });

    it('AC-18: an event_id rejected while the quote was Draft stays rejected when delivered again after it is Sent; a new event_id is accepted', async () => {
      const REC = 'recQ0033RECORD001';
      await linkQuote('Q-2026-0033', REC);
      const ev = withPayload(`airtable:achTESTTESTTEST01:txn18:${REC}`, 'Q-2026-0033', 1, { airtable_record_id: REC });
      const first = await call(db, 'wf_quote_accepted', ev);
      expect(first).toMatchObject({ status: 'REJECTED', outcome: 'INVALID_STATE', error_class: 'INVALID_STATE', message: 'Quote Q-2026-0033 is DRAFT; only a SENT quote can be accepted' });
      // The outcome is kept on the event row (the existing event log), exactly as it was returned.
      expect((await db.query<{ r: unknown }>(`select metadata -> 'result' r from automation_events where event_key = $1`, [ev.event_id]))[0]!.r).toEqual(first);
      expect(await sentInAirtable(REC, 19)).toMatchObject({ outcome: 'APPLIED' });
      expect(await col(db, `select status v from quotes where quote_number = 'Q-2026-0033'`)).toEqual(['SENT']);
      // The same event_id again (a redelivery, a drain, a replay of the cursor): its first outcome, and nothing changes.
      expect(await call(db, 'wf_quote_accepted', ev)).toMatchObject({ ...first, duplicate: true, redelivery: true });
      expect(await col(db, `select status v from quotes where quote_number = 'Q-2026-0033'`)).toEqual(['SENT']);
      expect(await projectsOf('Q-2026-0033')).toBe(0);
      expect(await count(db, `select count(*) v from processed_events where idempotency_key = 'quote.accepted:Q-2026-0033:v1'`)).toBe(0);
      expect(await col(db, `select event_key || '|' || status || '|' || error_class v from automation_events where event_key like '${ev.event_id}%' order by event_key`))
        .toEqual([`${ev.event_id}|REJECTED|INVALID_STATE`, `${ev.event_id}:redelivery:1|DUPLICATE_IGNORED|DUPLICATE_EVENT`]);
      expect(await exceptionsOf('Q-2026-0033')).toBe(1);
      // A fresh Airtable change (a new event_id: staff accept again now that it is Sent) is judged as the quote is now.
      const fresh = await call(db, 'wf_quote_accepted', withPayload(`airtable:achTESTTESTTEST01:txn20:${REC}`, 'Q-2026-0033', 1, { airtable_record_id: REC }));
      expect(fresh).toMatchObject({ status: 'CREATED' });
      expect(await call(db, 'wf_quote_accepted', ev)).toMatchObject({ status: 'REJECTED', error_class: 'INVALID_STATE', duplicate: true });   // still its first outcome
      expect(await projectsOf('Q-2026-0033')).toBe(1);
      expect(await col(db, `select status v from integrity_check() where check_key = 'accepted_at_most_one_project'`)).toEqual(['PASS']);
    });

    it('AC-18: a delivery whose transaction failed was never recorded, so the same event_id is judged again', async () => {
      const REC = 'recQ0046RECORD001';
      await linkQuote('Q-2026-0046', REC);
      const ev = withPayload(`airtable:achTESTTESTTEST01:txn30:${REC}`, 'Q-2026-0046', 1, { airtable_record_id: REC });
      // Delivered while Draft, but the transaction fails before it commits (here: opening the exception raises).
      await db.exec('begin');
      try {
        await db.exec(`create function test_ac18_crash() returns trigger language plpgsql as $$ begin raise exception 'simulated failure before commit'; end $$;
                       create trigger test_ac18_crash before insert on workflow_exceptions for each row execute function test_ac18_crash();`);
        await expect(call(db, 'wf_quote_accepted', ev)).rejects.toThrow(/simulated failure before commit/);
      } finally {
        await db.exec('rollback');
      }
      expect(await count(db, `select count(*) v from automation_events where event_key like '${ev.event_id}%'`)).toBe(0);
      expect(await exceptionsOf('Q-2026-0046')).toBe(0);
      expect(await sentInAirtable(REC, 31)).toMatchObject({ outcome: 'APPLIED' });
      expect(await call(db, 'wf_quote_accepted', ev)).toMatchObject({ status: 'CREATED', duplicate: false });
      expect(await projectsOf('Q-2026-0046')).toBe(1);
    });

    it('AC-18: a rejection recorded before this rule (no stored outcome) is answered from its event row', async () => {
      const ev = quoteAccepted('EVT-T-AC18-OLD', 'Q-2026-0065', 1);
      const first = await call(db, 'wf_quote_accepted', ev);
      expect(first).toMatchObject({ status: 'REJECTED', error_class: 'INVALID_STATE' });
      await db.exec(`update automation_events set metadata = metadata - 'result' where event_key = 'EVT-T-AC18-OLD'`);   // as an older version left it
      await db.exec(`update quotes set status = 'SENT' where quote_number = 'Q-2026-0065'`);
      expect(await call(db, 'wf_quote_accepted', ev)).toMatchObject({ status: 'REJECTED', outcome: 'INVALID_STATE', error_class: 'INVALID_STATE',
        message: first.message, exception_number: first.exception_number, duplicate: true, redelivery: true });
      expect(await projectsOf('Q-2026-0065')).toBe(0);
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

    it('AC-18: the same rejected event_id delivered concurrently gets one outcome: the second is its redelivery', async () => {
      const [a, b] = [await openPostgres(db.url!), await openPostgres(db.url!)];
      try {
        const ev = quoteAccepted('EVT-RACE-DRAFT', 'Q-2026-0038', 1);   // Q-2026-0038 is Draft
        const rs = await Promise.all([call(a, 'wf_quote_accepted', ev), call(b, 'wf_quote_accepted', ev)]);
        expect(rs.map((r) => r.status)).toEqual(['REJECTED', 'REJECTED']);
        expect(rs.map((r) => r.duplicate === true).sort()).toEqual([false, true]);
        expect(rs[0].exception_number).toBe(rs[1].exception_number);
        expect(await col(db, `select status v from automation_events where event_key like 'EVT-RACE-DRAFT%' order by event_key`)).toEqual(['REJECTED', 'DUPLICATE_IGNORED']);
        expect(await count(db, `select count(*) v from workflow_exceptions where business_reference = 'Q-2026-0038'`)).toBe(1);
      } finally { await a.close(); await b.close(); }
    });
  });
});
