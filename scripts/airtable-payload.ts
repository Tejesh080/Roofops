/**
 * Builds Airtable create payloads (field IDs -> values) from the HOSTED Postgres data.
 *   npx tsx scripts/airtable-payload.ts <table> [batch] [linksFile]
 * linksFile: JSON { "CUST-0001": "recXXXX", ... } of already-created linked records.
 * Output is compact JSON on stdout (no secrets involved).
 */
import { existsSync, readFileSync } from 'node:fs';
import { openPostgres } from '../src/db/db.js';
import { hostedDbConfig } from '../src/config/env.js';
import { AT } from '../src/integrations/airtable/schema.js';

const [table = '', batchArg = '0', linksFile] = process.argv.slice(2);
const BATCH = 50;
const links: Record<string, string> = linksFile && existsSync(linksFile) ? JSON.parse(readFileSync(linksFile, 'utf8')) as Record<string, string> : {};
const link = (k: string | null | undefined) => {
  if (!k) return undefined;
  const r = links[k];
  if (!r) throw new Error(`no Airtable record id for ${k} in ${linksFile ?? '(none)'}`);
  return [r];
};
const title = (s: string | null | undefined) => s?.toLowerCase().split('_').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ') ?? null;
const JOB: Record<string, string> = { FULL_REROOF: 'Full Re-roof' };
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));

const cfg = hostedDbConfig();
const db = await openPostgres(cfg.url, cfg.caPem ? { caPem: cfg.caPem } : undefined);
let records: Record<string, unknown>[];
try {
  switch (table) {
    case 'customers': {
      const f = AT.customers.f;
      const rows = await db.query<Record<string, string | null>>(`select c.id, c.customer_number, c.display_name, c.email, c.phone, c.customer_type, c.preferred_contact,
        c.customer_since::text since, (select b.customer_number from customer_match_candidates m join customers b on b.id = case when m.customer_id = c.id then m.candidate_customer_id else m.customer_id end
          where c.id in (m.customer_id, m.candidate_customer_id) and c.customer_number > b.customer_number) dup
        from customers c order by c.customer_number`);
      records = rows.map((r) => clean({ [f.id]: r.customer_number, [f.name]: r.display_name, [f.email]: r.email, [f.phone]: r.phone,
        [f.type]: title(r.customer_type), [f.preferred]: r.preferred_contact === 'SMS' ? 'SMS' : title(r.preferred_contact), [f.since]: r.since,
        [f.duplicateOf]: r.dup, [f.roofopsId]: r.id }));
      break;
    }
    case 'suppliers': {
      const f = AT.suppliers.f;
      const rows = await db.query<Record<string, string | number | null>>(`select id, supplier_code, name, orders_email, phone, default_lead_time_days from suppliers order by supplier_code`);
      records = rows.map((r) => clean({ [f.id]: r.supplier_code, [f.name]: r.name, [f.email]: r.orders_email, [f.phone]: r.phone,
        [f.leadTime]: r.default_lead_time_days, [f.roofopsId]: r.id }));
      break;
    }
    case 'properties': {
      const f = AT.properties.f;
      const rows = await db.query<Record<string, string | number | null>>(`select p.id, p.property_number, p.address_line1, p.suburb, p.state, p.postcode, p.property_type, p.storeys, p.access_notes, c.customer_number owner
        from properties p left join customer_properties cp on cp.property_id = p.id and cp.relationship = 'OWNER' left join customers c on c.id = cp.customer_id order by p.property_number`);
      records = rows.map((r) => clean({ [f.id]: r.property_number, [f.address]: r.address_line1, [f.suburb]: r.suburb, [f.state]: r.state, [f.postcode]: r.postcode,
        [f.type]: title(r.property_type as string), [f.storeys]: r.storeys, [f.access]: r.access_notes, [f.owner]: link(r.owner as string), [f.roofopsId]: r.id }));
      break;
    }
    case 'quotes': {
      const f = AT.quotes.f;
      const rows = await db.query<Record<string, string | number | null>>(`select q.id, q.quote_number, c.customer_number, p.property_number, q.status, qv.version_number, qv.total_inc_gst::float8 amount,
        q.job_type, i.roof_type, i.roof_area_sqm::float8 roof_area, e.full_name estimator, q.lead_source, q.created_on::text created_on, q.sent_on::text sent_on,
        q.accepted_on::text accepted_on, q.lost_reason
        from quotes q join customers c on c.id = q.customer_id join properties p on p.id = q.property_id
        join lateral (select * from quote_versions v where v.quote_id = q.id order by version_number desc limit 1) qv on true
        left join inspections i on i.id = q.inspection_id left join employees e on e.id = q.estimator_id order by q.quote_number`);
      records = rows.map((r) => clean({ [f.number]: r.quote_number, [f.customer]: link(r.customer_number as string), [f.property]: link(r.property_number as string),
        [f.status]: title(r.status as string), [f.version]: r.version_number, [f.amount]: r.amount,
        [f.jobType]: JOB[r.job_type as string] ?? title(r.job_type as string), [f.roofType]: title(r.roof_type as string), [f.roofArea]: r.roof_area,
        [f.estimator]: r.estimator, [f.leadSource]: title(r.lead_source as string), [f.createdOn]: r.created_on, [f.sentOn]: r.sent_on,
        [f.acceptedOn]: r.accepted_on, [f.lostReason]: r.lost_reason, [f.automationStatus]: 'Not triggered', [f.roofopsId]: r.id }));
      break;
    }
    case 'projects': {
      const f = AT.projects.f;
      const rows = await db.query<Record<string, string | null>>(`select p.id, p.project_number, q.quote_number, c.customer_number, p.status, e.full_name pm,
        p.planned_start_date::text ps, p.planned_completion_date::text pc, p.actual_start_date::text as_, p.actual_completion_date::text ac,
        (select case ci.status when 'OPEN' then 'To do' when 'DONE' then 'Done' when 'WAIVED' then 'Waived' when 'NOT_APPLICABLE' then 'Not applicable' end
           from project_checklist_items ci where ci.project_id = p.id and ci.item_code = 'COMPLETION_PHOTOS') photos,
        (select case ci.status when 'OPEN' then 'To do' when 'DONE' then 'Done' when 'WAIVED' then 'Waived' when 'NOT_APPLICABLE' then 'Not applicable' end
           from project_checklist_items ci where ci.project_id = p.id and ci.item_code = 'COMPLIANCE_CERTIFICATE') cert,
        (select case ci.status when 'OPEN' then 'To do' when 'DONE' then 'Done' when 'WAIVED' then 'Waived' when 'NOT_APPLICABLE' then 'Not applicable' end
           from project_checklist_items ci where ci.project_id = p.id and ci.item_code = 'SWMS_SIGNED') swms,
        (select case ci.status when 'OPEN' then 'To do' when 'DONE' then 'Done' when 'WAIVED' then 'Waived' when 'NOT_APPLICABLE' then 'Not applicable' end
           from project_checklist_items ci where ci.project_id = p.id and ci.item_code = 'MATERIALS_REVIEWED') materials
        from projects p join quotes q on q.id = p.quote_id join customers c on c.id = p.customer_id left join employees e on e.id = p.project_manager_id order by p.project_number`);
      records = rows.map((r) => clean({ [f.number]: r.project_number, [f.quote]: link(r.quote_number), [f.customer]: link(r.customer_number),
        [f.status]: title(r.status), [f.pm]: r.pm, [f.plannedStart]: r.ps, [f.plannedCompletion]: r.pc, [f.actualStart]: r.as_, [f.actualCompletion]: r.ac,
        [f.roofopsId]: r.id, [f.completionPhotos]: r.photos, [f.complianceCertificate]: r.cert,
        [f.swmsSigned]: r.swms, [f.materialsReviewed]: r.materials }));
      break;
    }
    case 'purchase_orders': {
      const f = AT.purchaseOrders.f;
      const rows = await db.query<Record<string, string | number | null>>(`select po.id, po.po_number, p.project_number, s.supplier_code, po.status, po.po_date::text po_date,
        po.expected_delivery_date::text eta, po.subtotal_ex_gst::float8 subtotal, po.supplier_reference
        from purchase_orders po join projects p on p.id = po.project_id join suppliers s on s.id = po.supplier_id order by po.po_number`);
      records = rows.map((r) => clean({ [f.number]: r.po_number, [f.project]: link(r.project_number as string), [f.supplier]: link(r.supplier_code as string),
        [f.status]: title(r.status as string), [f.poDate]: r.po_date, [f.expected]: r.eta, [f.subtotal]: r.subtotal, [f.supplierRef]: r.supplier_reference,
        [f.roofopsId]: r.id }));
      break;
    }
    default:
      throw new Error(`unknown table ${table}`);
  }
} finally {
  await db.close();
}
const b = Number(batchArg);
console.log(JSON.stringify(records.slice(b * BATCH, (b + 1) * BATCH).map((fields) => ({ fields }))));
console.error(`${table}: ${records.length} records total; batch ${b} = ${Math.min(BATCH, Math.max(0, records.length - b * BATCH))}`);
