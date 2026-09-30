/**
 * Interview demo scenarios: status and a narrow, audited, idempotent reset.
 *
 * Only designated synthetic demo records are ever touched, and only where the change is fully reversible inside
 * RoofOps. Anything that exists in an external system (Airtable records, Google Drive folders, Xero drafts) is never
 * deleted: those scenarios are reported as ALREADY RUN with the reason, instead of being "reset" ambiguously.
 */
import type { Db } from '../db/db.js';

export type DemoStatus = 'READY' | 'ALREADY RUN' | 'NEEDS RESET' | 'BLOCKED';
export interface ScenarioReport { id: string; name: string; status: DemoStatus; detail: string; resettable: boolean }

/** Sent quotes set aside for live "Quote → Project" rehearsals (synthetic; see docs/phase2-status.md). */
export const QUOTE_CANDIDATES = ['Q-2026-0050', 'Q-2026-0051', 'Q-2026-0052', 'Q-2026-0054', 'Q-2026-0058', 'Q-2026-0064', 'Q-2026-0032', 'Q-2026-0034', 'Q-2026-0036'];
export const INVOICE_DEMO_PROJECT = 'PRJ-2026-0005';
export const INVOICE_BACKUP_PROJECTS = ['PRJ-2026-0001', 'PRJ-2026-0002'];

const one = async <T>(db: Db, sql: string, p: unknown[] = []) => (await db.query<T>(sql, p))[0];

export async function demoStatus(db: Db): Promise<ScenarioReport[]> {
  // 01 Quote -> Project: every rehearsal consumes one unused Sent quote; nothing is deleted afterwards.
  const unused = (await db.query<{ quote_number: string }>(
    `select q.quote_number from quotes q where q.quote_number = any($1) and q.status = 'SENT'
       and not exists (select 1 from projects p where p.quote_id = q.id) order by array_position($1, q.quote_number)`, [QUOTE_CANDIDATES])).map((r) => r.quote_number);
  const lastLive = await one<{ project_number: string; quote_number: string }>(
    db, `select p.project_number, q.quote_number from projects p join quotes q on q.id = p.quote_id where p.created_by_event_id is not null order by p.created_at desc limit 1`);
  const quote: ScenarioReport = unused.length
    ? { id: '01', name: 'Quote → Project', status: 'READY', resettable: false,
        detail: `Next quote to accept in Airtable: ${unused[0]} (${unused.length} unused)${lastLive ? `; last live run ${lastLive.quote_number} → ${lastLive.project_number}` : ''}` }
    : { id: '01', name: 'Quote → Project', status: 'BLOCKED', resettable: false, detail: 'No unused Sent demo quotes left; show the recorded run (PRJ-2026-0031) instead' };

  // 02 Project at risk: read-only.
  const r11 = await one<{ risk_level: string; n: number }>(db, `select risk_level, cardinality(risk_reasons) n from v_project_risk where project_number = 'PRJ-2026-0011'`);
  const risk: ScenarioReport = r11?.risk_level === 'HIGH'
    ? { id: '02', name: 'Project at risk', status: 'READY', resettable: false, detail: `PRJ-2026-0011 is at risk with ${r11.n} reasons` }
    : { id: '02', name: 'Project at risk', status: 'BLOCKED', resettable: false, detail: 'PRJ-2026-0011 is no longer at risk (data changed)' };

  // 03 Failure -> Recovery: a recorded, replayable history. Re-running it live needs a real Drive outage, so it is not reset.
  const f = await one<{ retries: string; resolved: string; drive: string }>(db, `select
      (select count(*) from automation_events where business_reference = 'PRJ-2026-0033' and event_type in ('automation.retry_scheduled', 'automation.failed'))::text retries,
      (select count(*) from workflow_exceptions where exception_number = 'EXC-0015' and resolution_status = 'RESOLVED')::text resolved,
      (select count(*) from external_links l join projects p on p.id = l.entity_id where p.project_number = 'PRJ-2026-0033'
         and l.provider = 'GOOGLE_DRIVE' and l.external_type = 'Folder' and l.verified_at is not null)::text drive`);
  const failure: ScenarioReport = f && Number(f.retries) >= 5 && f.resolved === '1' && f.drive === '1'
    ? { id: '03', name: 'Failure → Recovery', status: 'READY', resettable: false, detail: `PRJ-2026-0033 history intact: ${f.retries} attempts, stopped safely, staff retry, recovered (replay only)` }
    : { id: '03', name: 'Failure → Recovery', status: 'BLOCKED', resettable: false, detail: 'PRJ-2026-0033 recovery history is incomplete' };

  // 04 Finance + human approval: PRJ-2026-0004 shows the finished result; PRJ-2026-0005 is prepared live.
  const tenant = await one<{ v: string }>(db, `select value v from app_settings where key = 'xero.demo_tenant_id'`);
  const p5 = await one<{ status: string; approval: string | null; final: string | null }>(db, `select
      (select status from projects where project_number = $1) status,
      (select a.approval_number from approvals a join projects p on p.id = a.entity_id where p.project_number = $1
         and a.action_type = 'CREATE_INVOICE' and a.status = 'PENDING' order by a.created_at desc limit 1) approval,
      (select i.invoice_number from invoices i join projects p on p.id = i.project_id where p.project_number = $1
         and i.invoice_type = 'FINAL' and i.status <> 'VOIDED' limit 1) final`, [INVOICE_DEMO_PROJECT]);
  const showcase = await one<{ n: string }>(db, `select count(*)::text n from external_links l join invoices i on i.id = l.entity_id join projects p on p.id = i.project_id
      where p.project_number = 'PRJ-2026-0004' and l.provider = 'XERO' and l.external_type = 'Invoice' and l.verified_at is not null`);
  let finance: ScenarioReport;
  if (!tenant?.v) finance = { id: '04', name: 'Finance + human approval', status: 'BLOCKED', resettable: false, detail: 'No Xero Demo Company tenant is pinned' };
  else if (p5?.final) finance = { id: '04', name: 'Finance + human approval', status: 'ALREADY RUN', resettable: false,
    detail: `${INVOICE_DEMO_PROJECT} was approved (${p5.final}) and a real Xero draft exists; it is not deleted. Prepare ${INVOICE_BACKUP_PROJECTS.join(' or ')} instead` };
  else if (p5?.approval) finance = { id: '04', name: 'Finance + human approval', status: 'NEEDS RESET', resettable: true,
    detail: `${INVOICE_DEMO_PROJECT} already has preview ${p5.approval} awaiting approval; demo:reset withdraws it` };
  else finance = { id: '04', name: 'Finance + human approval', status: showcase?.n === '1' ? 'READY' : 'BLOCKED', resettable: true,
    detail: showcase?.n === '1' ? `Ask the Copilot to prepare ${INVOICE_DEMO_PROJECT}; PRJ-2026-0004 shows the approved Xero draft` : 'PRJ-2026-0004 has no verified Xero draft to show' };
  return [quote, risk, failure, finance];
}

export interface ResetResult { withdrawn: string[]; notes: string[] }

/**
 * Withdraws pending (never approved) invoice previews on the designated demo project so "Prepare invoice" can be
 * rehearsed again. Same transition as a stale preview (PENDING -> CANCELLED), one audit row each. Nothing else changes.
 */
export async function demoReset(db: Db): Promise<ResetResult> {
  await db.exec('begin');
  try {
    const rows = await db.query<{ id: string; approval_number: string; payload_hash: string }>(
      `update approvals a set status = 'CANCELLED', decision_reason = 'Demo reset: preview withdrawn so the scenario can be rehearsed again'
         from projects p
        where p.id = a.entity_id and p.project_number = $1 and a.action_type = 'CREATE_INVOICE' and a.status = 'PENDING'
          and not exists (select 1 from invoices i where i.approval_id = a.id)
       returning a.id, a.approval_number, a.payload_hash`, [INVOICE_DEMO_PROJECT]);
    for (const r of rows) {
      await db.query(`insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, approval_id, before_state, after_state, reason)
                      values ('SYSTEM', 'demo:reset', 'demo.reset.preview_withdrawn', 'approval', $1, $2, $1, $3, $4, $5)`,
        [r.id, r.approval_number, JSON.stringify({ status: 'PENDING', payload_hash: r.payload_hash }), JSON.stringify({ status: 'CANCELLED' }),
         `Interview rehearsal reset of ${INVOICE_DEMO_PROJECT}; no invoice or Xero record existed`]);
    }
    await db.exec('commit');
    // The Airtable row is put back by scripts/demo.ts (a repair run of [RoofOps] 07 scoped to its invoice fields).
    return { withdrawn: rows.map((r) => r.approval_number), notes: [] };
  } catch (e) {
    await db.exec('rollback');
    throw e;
  }
}
