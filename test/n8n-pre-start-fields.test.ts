/**
 * AC-13B, the n8n side: the REAL node code of [RoofOps] 06 (Airtable changes) and 03 (project write-back), loaded through
 * the recorder. 06 must hand a SWMS Signed / Materials Reviewed edit (with its Note) to Postgres, which applies it through
 * the checklist rules; 03 must create a new project's record with both pre-start items "To do" and prove it on read-back.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { importBundle } from '../src/import/importer.js';
import { TARGETS, migratedDb } from './helpers/db.js';
import { recorded } from './helpers/n8n-sdk-shim.js';
import { N8nRun, type Item } from './helpers/n8n-runner.js';

type R = Record<string, unknown>;
const T_PROJECTS = 'tblvUPIoebC3zoacv';
const F = { swms: 'fldM6kgPz6QZagPAC', swmsNote: 'fldNcsIgH6TfQFfaU', materials: 'fldozWSCU877wEZHq', materialsNote: 'fldEtAmAokIvtzJdn',
  photos: 'fldbbksVL3dT6cqyS', cert: 'fldf7iJiyHFxOQgUy',
  number: 'fldhhnQXlbuFaveK3', status: 'fldi2Qwz1dAh2tcTE', roofopsId: 'fldc4T0AgU3zCmANC', driveFolder: 'fldgVDT29UOOOtlqO', quote: 'fld08eKCeuDCsJLjz' };
const APPROVER = 'usr7uCnNO15fCefbH';
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;
const select = (name: string) => ({ id: `sel${name.replace(/\W/g, '').padEnd(14, 'x').slice(0, 14)}`, name, color: 'grayLight2' });
const loaded = new Map<string, Promise<{ nodes: typeof recorded.nodes; edges: typeof recorded.edges }>>();
const load = (file: string) => {
  if (!loaded.has(file)) loaded.set(file, (async () => {
    recorded.nodes.clear(); recorded.edges.length = 0;
    await import(/* @vite-ignore */ file);                                           // a variable: typecheck does not follow it into n8n's SDK
    return { nodes: new Map(recorded.nodes), edges: [...recorded.edges] };
  })());
  return loaded.get(file)!;
};

describe.each(TARGETS)('AC-13B: n8n 06 and 03 carry the pre-start fields [%s]', (target) => {
  let db: Db;
  let P = '';
  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    const [r] = await db.query<{ r: R }>(`select wf_quote_accepted($1::jsonb) r`, [JSON.stringify({ event_id: 'EVT-N8N-PRE', correlation_id: 'CORR-N8N-PRE', event_type: 'quote.accepted',
      source: 'airtable', actor_id: 'airtable-automation', occurred_at: '2026-09-29T09:00:00+10:00',
      payload: { quote_id: 'Q-2026-0041', accepted_version: 1, accepted_on: '2026-09-29', airtable_record_id: 'recTESTTESTTEST01' } })]);
    P = String(r!.r.project_number);
    await db.exec(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
  }, 120_000);
  afterAll(async () => { await db.close(); });
  const item = async (code: string) => (await db.query<R>(`select ci.status, ci.waived_reason from project_checklist_items ci join projects p on p.id = ci.project_id
      where p.project_number = $1 and ci.item_code = $2`, [P, code]))[0];

  describe('06: a SWMS Signed / Materials Reviewed edit reaches Postgres and is applied there', () => {
    let wf: Awaited<ReturnType<typeof load>>;
    beforeAll(async () => { wf = await load('../n8n/06-airtable-changes.sdk.ts'); });
    const page = (cur: R, prev: R, unchanged: R, txn: number) => ({ json: { cursor: 9, mightHaveMore: false, payloads: [{
      timestamp: new Date(Date.UTC(2026, 9, 3, 0, 0, txn)).toISOString(), baseTransactionNumber: txn,
      actionMetadata: { source: 'client', sourceMetadata: { user: { id: APPROVER } } },
      changedTablesById: { [T_PROJECTS]: { changedRecordsById: { [recFor(P)]: {
        current: { cellValuesByFieldId: cur }, previous: { cellValuesByFieldId: prev }, unchanged: { cellValuesByFieldId: unchanged } } } } } }] } });
    const run = async (pages: Item[]) => {
      const r = new N8nRun(wf.nodes, wf.edges, { db, http: () => { throw new Error('no HTTP expected'); } });
      r.seed('Validate Ping', [{ json: { webhook_id: 'achTESTPRESTAR001' } }]);
      r.seed('Load Payload Cursor', [{ json: { cursor: 1 } }]);
      await r.run('Extract Record Changes', pages, ['Plan Airtable Corrections']);
      return r;
    };

    it('SWMS Signed = Done: one event, applied, attributed', async () => {
      const r = await run([page({ [F.swms]: select('Done') }, { [F.swms]: select('To do') }, { [F.status]: select('Planning') }, 201)]);
      expect(r.out.get('Extract Record Changes')![0]!.json).toMatchObject({ event: { record_id: recFor(P), actor_id: APPROVER, changes: { [F.swms]: { current: select('Done') } } } });
      expect((r.out.get('Apply Change In Postgres')![0]!.json.r as R).outcome).toBe('APPLIED');
      expect(await item('SWMS_SIGNED')).toMatchObject({ status: 'DONE' });
    });

    it('Materials Reviewed = Waived: the Note travels in "current" and becomes the recorded reason', async () => {
      const r = await run([page({ [F.materials]: select('Waived') }, { [F.materials]: select('To do') }, { [F.materialsNote]: 'Customer supplies all materials' }, 202)]);
      expect((r.out.get('Apply Change In Postgres')![0]!.json.r as R).outcome).toBe('APPLIED');
      expect(await item('MATERIALS_REVIEWED')).toMatchObject({ status: 'WAIVED', waived_reason: 'Customer supplies all materials' });
    });
  });

  describe('03: a new project record is created with both pre-start items "To do" and read back', () => {
    let wf: Awaited<ReturnType<typeof load>>;
    beforeAll(async () => { wf = await load('../n8n/03-airtable-project-writeback.sdk.ts'); });
    const job = { project_id: '00000000-0000-0000-0000-000000000031', project_number: 'PRJ-2026-0031', quote_number: 'Q-2026-0041', status: 'Planning',
      project_manager: 'Lachlan Reed', material_task: 'Review materials', quote_airtable_record_id: 'recQUOTEQUOTE0041', drive_folder: { web_view_link: 'https://drive.google.com/drive/folders/1X' } };
    const seeded = () => {
      const r = new N8nRun(wf.nodes, wf.edges, { db, http: () => { throw new Error('no HTTP expected'); } });
      r.seed('When Called By Main Workflow', [{ json: { airtable_key: 'airtable:project-writeback:x', project_id: job.project_id } }]);
      r.seed('Claim Airtable Write-back', [{ json: { c: { claimed: true, attempt: 1, payload: job } } }]);
      return r;
    };

    it('Build Project Record writes SWMS Signed and Materials Reviewed = "To do"', async () => {
      const r = seeded();
      await r.run('Build Project Record', [{ json: {} }], ['Record Built?']);
      const fields = ((r.out.get('Build Project Record')![0]!.json.request as R).records as R[])[0]!.fields as R;
      expect(fields).toMatchObject({ [F.swms]: 'To do', [F.materials]: 'To do' });
    });

    it('Verify Airtable Read-Back refuses a record whose pre-start fields did not stick', async () => {
      const verify = async (readBack: R) => {
        const r = seeded();
        r.seed('Check Upsert', [{ json: { record_id: 'recPROJPROJ00031', created: true } }]);
        r.seed('Read Back Project Record', [{ json: { statusCode: 200, body: { id: 'recPROJPROJ00031', fields: readBack } } }]);
        r.seed('Read Back Quote Link', [{ json: { statusCode: 200, body: { fields: { flduJm0iR7pBb157b: ['recPROJPROJ00031'] } } } }]);
        await r.run('Verify Airtable Read-Back', [{ json: { statusCode: 200, body: { records: [{ id: 'recPROJPROJ00031' }] } } }], ['Read-Back Verified?']);
        return r.out.get('Verify Airtable Read-Back')![0]!.json;
      };
      const good = { [F.number]: job.project_number, [F.roofopsId]: job.project_id, [F.status]: 'Planning', [F.driveFolder]: job.drive_folder.web_view_link,
                     [F.quote]: [job.quote_airtable_record_id], [F.photos]: 'To do', [F.cert]: 'To do', [F.swms]: 'To do', [F.materials]: 'To do' };
      expect(await verify(good)).toMatchObject({ ok: true });
      for (const [field, name] of [[F.swms, 'SWMS Signed'], [F.materials, 'Materials Reviewed']] as const) {
        const missing = Object.fromEntries(Object.entries(good).filter(([k]) => k !== field));
        expect(await verify(missing)).toMatchObject({ ok: false, failure: { error_class: 'RECONCILIATION_MISMATCH', message: expect.stringMatching(new RegExp(name)) as unknown } });
      }
    });
  });
});
