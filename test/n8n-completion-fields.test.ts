/**
 * AC-13A, the n8n side: the REAL node code of [RoofOps] 06 (Airtable changes) and 03 (project write-back), loaded through
 * the recorder. 06 must hand a Completion Photos / Compliance Certificate edit (with its Note) to Postgres, which applies
 * it through the checklist rules; 03 must create a new project's record with both items "To do" and prove it on read-back.
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
const F = { photos: 'fldbbksVL3dT6cqyS', photosNote: 'fldA77ad94yUmvnu3', cert: 'fldf7iJiyHFxOQgUy', certNote: 'fldLi9FkGDFAbf0QB',
  number: 'fldhhnQXlbuFaveK3', status: 'fldi2Qwz1dAh2tcTE', roofopsId: 'fldc4T0AgU3zCmANC', driveFolder: 'fldgVDT29UOOOtlqO', quote: 'fld08eKCeuDCsJLjz' };
const APPROVER = 'usr7uCnNO15fCefbH';
const recFor = (project: string) => `rec${createHash('md5').update(project).digest('hex').slice(0, 14)}`;
const select = (name: string) => ({ id: `sel${name.replace(/\W/g, '').padEnd(14, 'x').slice(0, 14)}`, name, color: 'grayLight2' });
const loaded = new Map<string, Promise<{ nodes: typeof recorded.nodes; edges: typeof recorded.edges }>>();
/** A workflow's recorded nodes and connections; each SDK file is imported once per test file (the import is cached). */
const load = (file: string) => {
  if (!loaded.has(file)) loaded.set(file, (async () => {
    recorded.nodes.clear(); recorded.edges.length = 0;
    await import(/* @vite-ignore */ file);                                           // a variable: typecheck does not follow it into n8n's SDK
    return { nodes: new Map(recorded.nodes), edges: [...recorded.edges] };
  })());
  return loaded.get(file)!;
};

describe.each(TARGETS)('AC-13A: n8n 06 and 03 carry the completion fields [%s]', (target) => {
  let db: Db;
  beforeAll(async () => {
    db = await migratedDb(target);
    await importBundle(db);
    await db.exec(`insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
                   select 'AIRTABLE', 'project', id, 'Record', 'rec' || substr(md5(project_number), 1, 14), now(), now() from projects`);
  }, 120_000);
  afterAll(async () => { await db.close(); });

  describe('06: a Completion Photos edit (with its Note) reaches Postgres and is applied there', () => {
    let wf: Awaited<ReturnType<typeof load>>;
    beforeAll(async () => { wf = await load('../n8n/06-airtable-changes.sdk.ts'); });

    const page = (rec: string, cur: R, prev: R, unchanged: R, txn: number) => ({ json: { cursor: 9, mightHaveMore: false, payloads: [{
      timestamp: new Date(Date.UTC(2026, 9, 3, 0, 0, txn)).toISOString(), baseTransactionNumber: txn,
      actionMetadata: { source: 'client', sourceMetadata: { user: { id: APPROVER } } },
      changedTablesById: { [T_PROJECTS]: { changedRecordsById: { [rec]: {
        current: { cellValuesByFieldId: cur }, previous: { cellValuesByFieldId: prev }, unchanged: { cellValuesByFieldId: unchanged } } } } } }] } });

    const run = async (pages: Item[]) => {
      const r = new N8nRun(wf.nodes, wf.edges, { db, http: () => { throw new Error('no HTTP expected'); } });
      r.seed('Validate Ping', [{ json: { webhook_id: 'achTESTCOMPLET001' } }]);
      r.seed('Load Payload Cursor', [{ json: { cursor: 1 } }]);
      await r.run('Extract Record Changes', pages, ['Plan Airtable Corrections']);
      return r;
    };

    it('Done on an in-progress project: one event, applied, attributed', async () => {
      const P = 'PRJ-2026-0016';
      const r = await run([page(recFor(P), { [F.photos]: select('Done') }, { [F.photos]: select('To do') }, { [F.status]: select('In Progress') }, 101)]);
      const events = r.out.get('Extract Record Changes')!;
      expect(events).toHaveLength(1);
      expect(events[0]!.json).toMatchObject({ event: { record_id: recFor(P), actor_id: APPROVER, changes: { [F.photos]: { current: select('Done') } } } });
      expect((r.out.get('Apply Change In Postgres')![0]!.json.r as R).outcome).toBe('APPLIED');
      expect(await db.query(`select ci.status from project_checklist_items ci join projects p on p.id = ci.project_id
                              where p.project_number = $1 and ci.item_code = 'COMPLETION_PHOTOS'`, [P])).toEqual([{ status: 'DONE' }]);
    });

    it('Waived: the Note is carried in "current" and becomes the recorded reason', async () => {
      const P = 'PRJ-2026-0020';
      const r = await run([page(recFor(P), { [F.photos]: select('Waived') }, { [F.photos]: select('To do') },
                                { [F.photosNote]: 'Customer refused access for photos', [F.status]: select('In Progress') }, 102)]);
      expect((r.out.get('Apply Change In Postgres')![0]!.json.r as R).outcome).toBe('APPLIED');
      expect(await db.query(`select ci.status, ci.waived_reason from project_checklist_items ci join projects p on p.id = ci.project_id
                              where p.project_number = $1 and ci.item_code = 'COMPLETION_PHOTOS'`, [P]))
        .toEqual([{ status: 'WAIVED', waived_reason: 'Customer refused access for photos' }]);
    });

    it('a Note-only edit is not a checklist change (nothing is sent)', async () => {
      const r = await run([page(recFor('PRJ-2026-0024'), { [F.photosNote]: 'typing…' }, {}, {}, 103)]);
      expect(r.out.get('Extract Record Changes')![0]!.json).toMatchObject({ no_events: true });
    });
  });

  describe('03: a new project record is created with both completion items "To do" and read back', () => {
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

    it('Build Project Record writes Completion Photos and Compliance Certificate = "To do"', async () => {
      const r = seeded();
      await r.run('Build Project Record', [{ json: {} }], ['Record Built?']);
      const fields = ((r.out.get('Build Project Record')![0]!.json.request as R).records as R[])[0]!.fields as R;
      expect(fields).toMatchObject({ [F.photos]: 'To do', [F.cert]: 'To do' });
    });

    it('Verify Airtable Read-Back refuses a record whose completion fields did not stick', async () => {
      const verify = async (readBack: R) => {
        const r = seeded();
        r.seed('Check Upsert', [{ json: { record_id: 'recPROJPROJ00031', created: true } }]);
        r.seed('Read Back Project Record', [{ json: { statusCode: 200, body: { id: 'recPROJPROJ00031', fields: readBack } } }]);
        r.seed('Read Back Quote Link', [{ json: { statusCode: 200, body: { fields: { flduJm0iR7pBb157b: ['recPROJPROJ00031'] } } } }]);
        await r.run('Verify Airtable Read-Back', [{ json: { statusCode: 200, body: { records: [{ id: 'recPROJPROJ00031' }] } } }], ['Read-Back Verified?']);
        return r.out.get('Verify Airtable Read-Back')![0]!.json;
      };
      const good = { [F.number]: job.project_number, [F.roofopsId]: job.project_id, [F.status]: 'Planning', [F.driveFolder]: job.drive_folder.web_view_link,
                     [F.quote]: [job.quote_airtable_record_id], [F.photos]: 'To do', [F.cert]: 'To do' };
      expect(await verify(good)).toMatchObject({ ok: true });
      const missing = Object.fromEntries(Object.entries(good).filter(([k]) => k !== F.cert));
      expect(await verify(missing)).toMatchObject({ ok: false, failure: { error_class: 'RECONCILIATION_MISMATCH', message: expect.stringMatching(/Compliance Certificate/) as unknown } });
    });
  });
});
