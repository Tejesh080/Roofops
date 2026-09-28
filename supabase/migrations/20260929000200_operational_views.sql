-- =============================================================================
-- Operational read models. Derived facts are computed here from the underlying
-- records, as of app_today(); nothing below is stored. The planted demo
-- scenarios must be reproduced by these rules from facts alone (tested).
-- =============================================================================

insert into app_settings (key, value) values ('supplier_ack_sla_business_days', '2')
on conflict (key) do nothing;

-- Weekdays in (p_from, p_to]. Negative if p_to < p_from.
create or replace function business_days_between(p_from date, p_to date) returns integer
language sql immutable as $$
  select case when p_to >= p_from then
    (select count(*)::int from generate_series(p_from + 1, p_to, interval '1 day') d where extract(isodow from d) < 6)
  else
    -(select count(*)::int from generate_series(p_to + 1, p_from, interval '1 day') d where extract(isodow from d) < 6)
  end
$$;

create or replace view v_invoice_balances as
select i.id, i.invoice_number, i.project_id, p.project_number, i.customer_id, c.display_name as customer_name,
       i.status, i.sync_status, i.issue_date, i.due_date, i.total_inc_gst,
       coalesce(pay.paid, 0) as amount_paid,
       i.total_inc_gst - coalesce(pay.paid, 0) as outstanding,
       (i.status in ('ISSUED','PARTIALLY_PAID') and i.due_date < app_today()
        and i.total_inc_gst - coalesce(pay.paid, 0) > 0) as is_overdue,
       greatest(app_today() - i.due_date, 0) as days_past_due
from invoices i
join projects p on p.id = i.project_id
join customers c on c.id = i.customer_id
left join (select invoice_id, sum(amount) paid from payments group by invoice_id) pay on pay.invoice_id = i.id;

create or replace view v_purchase_order_status as
select po.id, po.po_number, po.project_id, p.project_number, po.supplier_id, s.name as supplier_name, po.status,
       po.po_date, po.expected_delivery_date, po.subtotal_ex_gst, po.total_inc_gst,
       (po.status in ('ACKNOWLEDGED','PARTIALLY_DELIVERED','DELIVERED')) as supplier_acknowledged,
       (po.status in ('APPROVED','SENT','ACKNOWLEDGED','PARTIALLY_DELIVERED')) as is_open_commitment,
       (po.status = 'SENT' and business_days_between(coalesce(po.sent_at::date, po.po_date), app_today())
          > (select value::int from app_settings where key = 'supplier_ack_sla_business_days')) as ack_overdue
from purchase_orders po
join suppliers s on s.id = po.supplier_id
left join projects p on p.id = po.project_id;

-- One row per project with every risk signal named, so "why" is always answerable.
create or replace view v_project_risk as
with base as (
  select p.*, (p.status not in ('COMPLETED','CLOSED','CANCELLED')) as is_active, app_today() as today
  from projects p
), signals as (
  select b.id,
    b.is_active and b.actual_start_date is null and b.planned_start_date < b.today              as start_missed,
    b.is_active and b.planned_completion_date < b.today                                        as completion_overdue,
    b.is_active and b.actual_start_date is null and exists (
      select 1 from purchase_orders po where po.project_id = b.id
        and po.status in ('DRAFT','PENDING_APPROVAL','APPROVED','SENT')
        and po.expected_delivery_date > b.planned_start_date)                                  as materials_after_start,
    b.is_active and b.actual_start_date is null and exists (
      select 1 from purchase_orders po where po.project_id = b.id
        and po.status = 'ACKNOWLEDGED' and po.expected_delivery_date > b.planned_start_date)   as supplier_delivery_late,
    b.is_active and exists (
      select 1 from v_purchase_order_status v where v.project_id = b.id and v.ack_overdue)     as supplier_ack_overdue,
    b.is_active and b.pm_risk_flag = 'HIGH'                                                    as pm_flagged
  from base b
)
select p.id, p.project_number, p.status, p.project_manager_id, e.full_name as project_manager,
       c.display_name as customer_name, pr.address_line1 || ', ' || pr.suburb as site_address,
       p.planned_start_date, p.planned_completion_date, p.actual_start_date,
       (p.status not in ('COMPLETED','CLOSED','CANCELLED')) as is_active,
       s.start_missed or s.completion_overdue as is_delayed,
       s.start_missed, s.completion_overdue, s.materials_after_start, s.supplier_delivery_late,
       s.supplier_ack_overdue, s.pm_flagged, p.delay_reason,
       array_remove(array[
         case when s.start_missed then 'START_DATE_PASSED' end,
         case when s.completion_overdue then 'PAST_PLANNED_COMPLETION' end,
         case when s.materials_after_start then 'MATERIALS_DUE_AFTER_START' end,
         case when s.supplier_delivery_late then 'SUPPLIER_DELIVERY_AFTER_START' end,
         case when s.supplier_ack_overdue then 'SUPPLIER_ACK_OVERDUE' end,
         case when s.pm_flagged then 'PM_FLAGGED' end], null) as risk_reasons,
       case when s.start_missed or s.completion_overdue or s.materials_after_start
                 or s.supplier_delivery_late or s.supplier_ack_overdue or s.pm_flagged then 'HIGH' else 'LOW' end as risk_level,
       (p.planned_start_date between app_today() and app_today() + 7) as starts_within_7_days,
       -- "next week" = the next Monday-Sunday calendar week (how staff say it)
       (p.planned_start_date between (date_trunc('week', app_today()) + interval '7 days')::date
                                 and (date_trunc('week', app_today()) + interval '13 days')::date) as starts_next_week
from projects p
join signals s on s.id = p.id
join customers c on c.id = p.customer_id
join properties pr on pr.id = p.property_id
left join employees e on e.id = p.project_manager_id;

create or replace view v_projects_waiting_on_materials as
select r.project_number, r.status, r.planned_start_date, po.po_number, po.status as po_status,
       po.expected_delivery_date, po.supplier_name
from v_project_risk r
join v_purchase_order_status po on po.project_id = r.id
where r.is_active and r.actual_start_date is null
  and po.status in ('DRAFT','PENDING_APPROVAL','APPROVED','SENT','ACKNOWLEDGED','PARTIALLY_DELIVERED');

create or replace view v_projects_missing_completion_docs as
select p.id, p.project_number, p.actual_completion_date, ci.item_code, ci.label
from projects p
join project_checklist_items ci on ci.project_id = p.id
where p.status in ('COMPLETED','CLOSED') and ci.stage = 'COMPLETION' and ci.is_required
  and ci.status not in ('DONE','WAIVED','NOT_APPLICABLE');

-- Automation gap: accepted quote with no project (e.g. the creation workflow failed).
create or replace view v_accepted_quotes_without_project as
select q.id, q.quote_number, q.accepted_on, c.display_name as customer_name, app_today() - q.accepted_on as days_since_accepted
from quotes q
join customers c on c.id = q.customer_id
where q.status = 'ACCEPTED' and not exists (select 1 from projects p where p.quote_id = q.id);

create or replace view v_quotes_missing_measurement as
select q.quote_number, q.status, i.inspection_number, i.inspected_on
from quotes q join inspections i on i.id = q.inspection_id
where i.status = 'COMPLETED' and i.roof_area_sqm is null;

create or replace view v_open_duplicate_customers as
select m.id, a.customer_number as customer_a, b.customer_number as customer_b, m.match_score, m.match_reasons
from customer_match_candidates m
join customers a on a.id = m.customer_id
join customers b on b.id = m.candidate_customer_id
where m.status = 'OPEN';

-- Conversion over decided quotes only (accepted / (accepted + lost + expired)).
create or replace view v_quote_conversion as
select coalesce(q.lead_source, 'ALL') as lead_source,
       count(*) filter (where q.status = 'ACCEPTED') as accepted,
       count(*) filter (where q.status = 'LOST') as lost,
       count(*) filter (where q.status = 'EXPIRED') as expired,
       count(*) filter (where q.status in ('DRAFT','SENT')) as open,
       round(count(*) filter (where q.status = 'ACCEPTED')::numeric
             / nullif(count(*) filter (where q.status in ('ACCEPTED','LOST','EXPIRED')), 0), 4) as conversion_rate
from quotes q
group by grouping sets ((q.lead_source), ());

create or replace view v_executive_kpis as
select
  app_today() as as_of,
  (select count(*) from projects where status not in ('COMPLETED','CLOSED','CANCELLED'))        as active_projects,
  (select count(*) from quotes where status = 'SENT')                                           as quotes_awaiting_decision,
  (select conversion_rate from v_quote_conversion where lead_source = 'ALL')                   as quote_conversion_rate,
  (select count(*) from v_project_risk where is_active and risk_level = 'HIGH')                 as projects_at_risk,
  (select count(*) from v_project_risk where is_delayed)                                        as projects_delayed,
  (select count(distinct project_number) from v_projects_waiting_on_materials)                  as projects_waiting_on_materials,
  (select coalesce(sum(total_inc_gst), 0) from purchase_orders
     where status in ('APPROVED','SENT','ACKNOWLEDGED','PARTIALLY_DELIVERED'))                  as open_po_value_inc_gst,
  (select count(*) from v_invoice_balances where is_overdue)                                    as overdue_invoices,
  (select coalesce(sum(outstanding), 0) from v_invoice_balances where is_overdue)               as overdue_amount,
  (select count(*) from workflow_exceptions where resolution_status in ('OPEN','RETRY_QUEUED')) as open_automation_exceptions,
  (select count(*) from v_accepted_quotes_without_project)                                      as accepted_quotes_without_project;
