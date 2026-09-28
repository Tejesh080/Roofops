-- =============================================================================
-- Phase 4: read models for the Operations Dashboard and the DeepSeek Copilot.
-- Everything is derived from existing records as of app_today(); nothing new is stored.
-- The web server connects as a login role in roofops_dashboard, which can read ONLY
-- these views (never the tables) and can ask for an invoice preview through the same
-- wf_invoice_prepare entry point n8n uses. It cannot approve, and cannot write.
-- =============================================================================

-- One row per project: everything the project table and the copilot need, with the
-- business state named (codes; the UI translates them into plain English).
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
  select project_id, count(*) as invoices, bool_or(is_overdue) as has_overdue, coalesce(sum(outstanding), 0) as outstanding
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
       (r.is_active and r.risk_level = 'HIGH') or coalesce(exc.open_exceptions, 0) > 0 or coalesce(bal.has_overdue, false)
         or pa.approval_number is not null or fi.sync_status in ('UNKNOWN', 'FAILED') as needs_attention
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

-- The five headline numbers (same rules as the table, so they always agree).
create or replace view v_dashboard_kpis as
select app_today() as as_of,
       count(*) filter (where is_active)                                            as active_projects,
       count(*) filter (where is_active and risk_level = 'HIGH')                    as projects_at_risk,
       count(*) filter (where waiting_on_materials)                                 as awaiting_materials,
       count(*) filter (where invoice_status = 'READY_TO_INVOICE')                  as ready_to_invoice,
       count(*) filter (where invoice_status = 'AWAITING_APPROVAL')                 as awaiting_invoice_approval,
       (select count(*) from workflow_exceptions where resolution_status in ('OPEN', 'RETRY_QUEUED')) as open_exceptions
from v_dashboard_projects;

-- Open (and recently handled) automation exceptions, linked to a project where there is one.
create or replace view v_dashboard_exceptions as
select w.exception_number, w.workflow_key, w.error_class, w.error_message, w.retryable, w.attempt_count,
       w.resolution_status, w.first_failed_at, w.last_attempt_at, w.resolved_at, w.resolution_note, w.business_reference,
       coalesce(p.project_number, pq.project_number) as project_number
from workflow_exceptions w
left join projects p on p.id = w.entity_id or p.project_number = w.business_reference
left join quotes q on q.quote_number = w.business_reference
left join projects pq on pq.quote_id = q.id;

-- Checklist items and tasks (material review etc.) per project.
create or replace view v_dashboard_project_checklist as
select p.project_number, 'CHECKLIST' as kind, ci.stage, ci.label as title, ci.status, ci.is_required, ci.completed_on as done_on,
       null::date as due_on, null::text as assignee, ci.sort_order
from project_checklist_items ci join projects p on p.id = ci.project_id
union all
select p.project_number, 'TASK', t.task_type, t.title, t.status, true, null, t.due_on, e.full_name, 0
from tasks t join projects p on p.id = t.project_id left join employees e on e.id = t.assignee_id;

-- Automation + audit history per project (the "what happened" timeline). References cover the
-- project, its quote, invoices and approvals, so a quote-acceptance event shows on its project.
create or replace view v_dashboard_project_timeline as
with refs as (
  select p.project_number, q.quote_number,
         array[p.id, p.quote_id]
           || coalesce((select array_agg(i.id) from invoices i where i.project_id = p.id), '{}')
           || coalesce((select array_agg(a.id) from approvals a where a.entity_id = p.id), '{}')
           || coalesce((select array_agg(t.id) from tasks t where t.project_id = p.id), '{}') as ids,
         array[p.project_number, q.quote_number]
           || coalesce((select array_agg(i.invoice_number) from invoices i where i.project_id = p.id), '{}')
           || coalesce((select array_agg(a.approval_number) from approvals a where a.entity_id = p.id), '{}') as numbers
  from projects p join quotes q on q.id = p.quote_id
)
select r.project_number, 'EVENT' as source, ae.occurred_at, ae.event_type as kind, ae.status, ae.error_class,
       coalesce(emp.full_name, eemp.full_name, ae.actor_id) as actor, ae.business_reference as reference,
       ae.metadata ->> 'reason' as reason, ae.external_reference, ae.source as channel
from refs r
join automation_events ae on ae.entity_id = any (r.ids) or ae.business_reference = any (r.numbers)
left join employees emp on emp.employee_code = ae.actor_id
left join employee_external_identities ei on ei.external_id = ae.actor_id
left join employees eemp on eemp.id = ei.employee_id
union all
select r.project_number, 'AUDIT', au.occurred_at, au.action, null, null,
       coalesce(emp.full_name, eemp.full_name, au.actor_display, au.actor_id), au.business_reference,
       au.reason, au.external_reference, au.actor_type
from refs r
join audit_events au on au.entity_id = any (r.ids) or au.business_reference = any (r.numbers)
left join employees emp on emp.employee_code = au.actor_id
left join employee_external_identities ei on ei.external_id = au.actor_id
left join employees eemp on eemp.id = ei.employee_id;

-- ---------------------------------------------------------------------------
-- Least privilege for the web server (login role provisioned by scripts/provision-dashboard-role.ts).
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'roofops_dashboard') then create role roofops_dashboard nologin; end if;
end $$;
revoke all on all tables in schema public from roofops_dashboard;
grant usage on schema public to roofops_dashboard;
grant select on v_dashboard_projects, v_dashboard_kpis, v_dashboard_exceptions, v_dashboard_project_checklist,
                v_dashboard_project_timeline, v_purchase_order_status, v_invoice_balances
  to roofops_dashboard;
-- Called inside the views (a function in a view needs the caller's EXECUTE right). All read-only.
grant execute on function invoice_final_preview(uuid), app_today(), business_days_between(date, date) to roofops_dashboard;
-- app_today() is a plain SQL function that reads the demo business date as the caller. Settings hold no secrets.
grant select (key, value) on app_settings to roofops_dashboard;
-- "Prepare invoice" from the copilot: the same preview-only entry point n8n uses. Approval stays in the n8n/Airtable flow.
grant execute on function wf_invoice_prepare(jsonb, text) to roofops_dashboard;
