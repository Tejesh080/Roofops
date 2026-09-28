-- Phase 4 fixes found in the first dashboard review (same columns, so dependants are unaffected):
--  * needs_attention was NULL (not false) for projects without a final invoice, so "on track" projects sorted first;
--  * outstanding counted an approved-but-unsent draft invoice as money owed; only invoices sent to the customer count.

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
       case when rd.x is not null and not (rd.x ->> 'ok')::boolean and rd.x ->> 'error_class' <> 'ARITHMETIC_MISMATCH' and fi.invoice_id is null
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
         or pa.approval_number is not null or fi.sync_status in ('UNKNOWN', 'FAILED'), false) as needs_attention
from projects p
join v_project_risk r on r.id = p.id
join customers c on c.id = p.customer_id
join quotes q on q.id = p.quote_id
left join quote_versions qv on qv.id = p.accepted_quote_version_id
left join po on po.project_id = p.id
left join final_inv fi on fi.project_id = p.id
left join pending_approval pa on pa.project_id = p.id
left join readiness rd on rd.project_id = p.id
left join bal on bal.project_id = p.id
left join exc on exc.project_id = p.id
left join external_links xi on xi.provider = 'XERO' and xi.entity_type = 'invoice' and xi.external_type = 'Invoice'
                           and xi.entity_id = fi.invoice_id and xi.verified_at is not null
left join external_links drive on drive.provider = 'GOOGLE_DRIVE' and drive.entity_type = 'project' and drive.external_type = 'Folder'
                              and drive.entity_id = p.id and drive.verified_at is not null
left join external_links at on at.provider = 'AIRTABLE' and at.entity_type = 'project' and at.external_type = 'Record' and at.entity_id = p.id;
