-- REISSUE-UI-02: the dashboard shows which Xero document is CURRENT and which ones a reissue REPLACED.
--
-- Found in the pilot rehearsal: between a reissue's approval and the supervised dispatch, the final invoice keeps its
-- verified Xero link to the superseded document (by design: history, accepted by integrity_check). v_dashboard_projects
-- read that link as the project's Xero invoice, so the Finance card said "Draft in Xero" and "Open in Xero" opened the
-- VOIDED or DELETED document. Read models only: no table, function, grant to n8n, Xero or Airtable write changes.
--
-- 1. v_dashboard_projects: identical to 20261001110000 except one join condition. xero_invoice_id (and the number derived
--    from it) is shown only when it is the current generation's CREATED document. A queued reissue shows no Xero ID: its
--    invoice_status is already CREATING_IN_XERO. Every hosted link matched its current generation when this was written.
-- 2. v_dashboard_invoice_xero_history (new, dashboard read-only): every draft generation of every invoice with its Xero
--    identity, whether it is current, Xero's last verified status for that document (VOIDED / DELETED / DRAFT …), and the
--    approval behind it (who asked and who approved, by name).

create or replace view v_dashboard_projects as
with final_inv as (
  select distinct on (i.project_id) i.project_id, i.id as invoice_id, i.invoice_number, i.status, i.sync_status, i.total_inc_gst
  from invoices i where i.invoice_type = 'FINAL' and i.status <> 'VOIDED'
  order by i.project_id, i.created_at desc
), pending_approval as (
  select distinct on (a.entity_id) a.entity_id as project_id, a.approval_number,
         (a.action_payload ->> 'amount_inc_gst')::numeric(12,2) as amount_inc_gst, a.expires_at
  from approvals a where a.action_type = 'CREATE_INVOICE' and a.status = 'PENDING' and a.expires_at > now()
  order by a.entity_id, a.created_at desc
), readiness as (
  select p.id as project_id, invoice_final_preview(p.id) as x from projects p where p.status = 'COMPLETED'
), po as (
  select v.project_id, count(*) as n,
         count(*) filter (where v.status = 'DELIVERED') as delivered,
         count(*) filter (where v.status = 'PARTIALLY_DELIVERED') as part_delivered,
         count(*) filter (where v.status = 'ACKNOWLEDGED') as confirmed,
         count(*) filter (where v.status = 'SENT') as sent,
         count(*) filter (where v.status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED')) as in_preparation,
         bool_or(v.ack_overdue) as ack_overdue,
         max(v.expected_delivery_date) filter (where v.status not in ('DELIVERED', 'CANCELLED')) as latest_open_eta
  from v_purchase_order_status v where v.project_id is not null and v.status <> 'CANCELLED'
  group by v.project_id
), bal as (
  select project_id, count(*) as invoices, bool_or(is_overdue) as has_overdue,
         coalesce(sum(outstanding) filter (where status in ('ISSUED', 'PARTIALLY_PAID')), 0) as outstanding
  from v_invoice_balances group by project_id
), exc as (
  select p.id as project_id, count(*) as open_exceptions
  from projects p join quotes q on q.id = p.quote_id
  join workflow_exceptions w on w.resolution_status in ('OPEN', 'RETRY_QUEUED')
   and (w.entity_id = p.id or w.business_reference in (p.project_number, q.quote_number))
  group by p.id
), overbill as (
  select p.id as project_id, project_over_billing(p.id) as x from projects p
), left_after_final as (
  select p.id as project_id, project_left_to_bill_after_final(p.id) as x from projects p
)
select p.id, p.project_number, p.status, r.is_active,
       c.customer_number, btrim(c.display_name) as customer_name, c.customer_type,
       r.site_address, r.project_manager,
       q.quote_number, qv.version_number as quote_version, qv.total_inc_gst as quote_total_inc_gst, q.job_type, q.accepted_on,
       p.planned_start_date, p.planned_completion_date, p.actual_start_date, p.actual_completion_date,
       r.risk_level, r.risk_reasons, p.delay_reason,
       case
         when not r.is_active then 'JOB_COMPLETE'
         when po.n is null then case when exists (select 1 from tasks t where t.project_id = p.id and t.task_type = 'MATERIAL_REVIEW' and t.status = 'OPEN')
                                     then 'REVIEW_PENDING' else 'NOT_ORDERED' end
         when po.ack_overdue then 'CONFIRMATION_OVERDUE'
         when po.delivered = po.n then 'DELIVERED'
         when po.part_delivered > 0 then 'PART_DELIVERED'
         when po.sent > 0 then 'AWAITING_CONFIRMATION'
         when po.in_preparation > 0 then 'ORDER_IN_PREPARATION'
         else 'CONFIRMED'
       end as material_status,
       exists (select 1 from v_projects_waiting_on_materials w where w.project_number = p.project_number) as waiting_on_materials,
       po.latest_open_eta as material_eta, coalesce(po.n, 0) as purchase_orders,
       case
         when ob.x is not null then 'OVER_BILLED'
         when fi.invoice_id is not null then case fi.sync_status
                                               when 'SYNCED' then 'XERO_DRAFT_CREATED' when 'PENDING' then 'CREATING_IN_XERO'
                                               when 'UNKNOWN' then 'CHECKING_WITH_XERO' when 'FAILED' then 'XERO_FAILED_SAFELY'
                                               else 'FINAL_INVOICED' end
         when pa.approval_number is not null then 'AWAITING_APPROVAL'
         when (rd.x ->> 'ok')::boolean then 'READY_TO_INVOICE'
         when rd.x ->> 'error_class' = 'ARITHMETIC_MISMATCH' then 'FULLY_INVOICED'
         when rd.x is not null then 'NOT_READY'
         when bal.has_overdue then 'PAYMENT_OVERDUE'
         when bal.invoices > 0 then 'PROGRESS_INVOICED'
         else 'NOT_YET_DUE'
       end as invoice_status,
       case when ob.x is not null then ob.x ->> 'message'
            when lf.x is not null then lf.x ->> 'message'
            when rd.x is not null and not (rd.x ->> 'ok')::boolean and rd.x ->> 'error_class' <> 'ARITHMETIC_MISMATCH' and fi.invoice_id is null
            then rd.x ->> 'message' end as invoice_blocker,
       coalesce(fi.total_inc_gst, pa.amount_inc_gst, (rd.x -> 'preview' ->> 'amount_inc_gst')::numeric(12,2)) as invoice_amount_inc_gst,
       fi.invoice_number as final_invoice_number, fi.sync_status as final_invoice_sync,
       xi.external_id as xero_invoice_id,
       case when xi.external_id is not null then (select value from app_settings where key = 'xero.invoice_number_prefix') || fi.invoice_number end as xero_invoice_number,
       pa.approval_number as pending_approval_number,
       coalesce(bal.outstanding, 0) as outstanding_inc_gst, coalesce(bal.has_overdue, false) as has_overdue_invoice,
       coalesce(exc.open_exceptions, 0) as open_exceptions,
       drive.external_url as drive_folder_url,
       at.external_id as airtable_record_id,
       coalesce((r.is_active and r.risk_level = 'HIGH') or coalesce(exc.open_exceptions, 0) > 0 or coalesce(bal.has_overdue, false)
         or pa.approval_number is not null or fi.sync_status in ('UNKNOWN', 'FAILED') or ob.x is not null or lf.x is not null, false) as needs_attention
       ,
       coalesce((select x.last_source_at from external_field_versions x where x.entity_type = 'project' and x.entity_id = p.id and x.field_key = 'status'),
                p.updated_at) as status_changed_at,
       ao.value as airtable_status_seen, ao.observed_at as airtable_status_seen_at,
       (select count(*) from v_state_drift s where s.entity_type = 'project' and s.entity_id = p.id)::int as drift_fields,
       (select max(finished_at) from reconciliation_runs where status = 'COMPLETED') as last_reconciled_at
from projects p
join v_project_risk r on r.id = p.id
join customers c on c.id = p.customer_id
join quotes q on q.id = p.quote_id
left join quote_versions qv on qv.id = p.accepted_quote_version_id
left join po on po.project_id = p.id
left join final_inv fi on fi.project_id = p.id
left join pending_approval pa on pa.project_id = p.id
left join readiness rd on rd.project_id = p.id
left join overbill ob on ob.project_id = p.id
left join left_after_final lf on lf.project_id = p.id
left join bal on bal.project_id = p.id
left join exc on exc.project_id = p.id
left join external_links xi on xi.provider = 'XERO' and xi.entity_type = 'invoice' and xi.external_type = 'Invoice'
                           and xi.entity_id = fi.invoice_id and xi.verified_at is not null
                           -- REISSUE-UI-02: only the CURRENT draft generation's created document is the project's Xero invoice. While
                           -- a reissue is queued, the kept link names the superseded (voided or deleted) document: history, not current.
                           and not exists (select 1 from invoice_xero_draft_generations g
                                            where g.invoice_id = fi.invoice_id and g.superseded_at is null
                                              and (g.status <> 'CREATED' or g.xero_invoice_id is distinct from xi.external_id))
left join external_links drive on drive.provider = 'GOOGLE_DRIVE' and drive.entity_type = 'project' and drive.external_type = 'Folder'
                              and drive.entity_id = p.id and drive.verified_at is not null
left join external_links at on at.provider = 'AIRTABLE' and at.entity_type = 'project' and at.external_type = 'Record' and at.entity_id = p.id
left join airtable_observations ao on ao.table_id = 'tblvUPIoebC3zoacv' and ao.record_id = at.external_id and ao.field_id = 'fldi2Qwz1dAh2tcTE';

create or replace view v_dashboard_invoice_xero_history as
select p.project_number,
       i.invoice_number,
       g.generation,
       g.status,
       (g.superseded_at is null) as is_current,
       g.xero_invoice_id,
       g.xero_invoice_number,
       g.created_at,
       g.superseded_at,
       -- Xero's own last verified read of THIS document (by InvoiceID), e.g. VOIDED or DELETED for a replaced one.
       (select o.xero_status from xero_invoice_observations o
         where o.xero_invoice_id = g.xero_invoice_id and o.verdict = 'VERIFIED'
         order by o.observed_at desc limit 1) as xero_status_verified,
       ap.approval_number,
       ap.action_type as approval_kind,
       nullif(btrim(re.full_name), '') as requested_by,
       nullif(btrim(de.full_name), '') as approved_by,
       ap.decided_at as approved_at
from invoice_xero_draft_generations g
join invoices i on i.id = g.invoice_id
join projects p on p.id = i.project_id
left join approvals ap on ap.id = g.approval_id
left join employees re on re.id = ap.requested_by_employee_id
left join employees de on de.id = ap.decided_by;

grant select on v_dashboard_invoice_xero_history to roofops_dashboard;
