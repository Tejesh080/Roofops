-- Which jobs are held by the pre-start gate (AC-13B)? Nothing showed it (audit finding CP-03): the Copilot and the dashboard
-- could list jobs at risk or waiting for materials, but not the jobs that cannot start because SWMS Signed or Materials
-- Reviewed is still open. Read model only: one new view for the dashboard role; nothing existing is redefined.
--
-- A job is held when it has not started (no Actual Start; Planning, Materials Pending, Scheduled or On Hold) and at least one
-- required PRE_START item is not Done, Waived or Not applicable. Imported jobs have no pre-start items and never appear.
create or replace view v_dashboard_pre_start_blocked as
select p.project_number, c.display_name as customer_name, p.status, p.planned_start_date, e.full_name as project_manager,
       array_agg(ci.label order by ci.sort_order) as open_items
  from projects p
  join customers c on c.id = p.customer_id
  join project_checklist_items ci on ci.project_id = p.id and ci.stage = 'PRE_START' and ci.is_required
                                 and ci.status not in ('DONE', 'WAIVED', 'NOT_APPLICABLE')
  left join employees e on e.id = p.project_manager_id
 where p.actual_start_date is null and p.status in ('PLANNING', 'MATERIALS_PENDING', 'SCHEDULED', 'ON_HOLD')
 group by p.project_number, c.display_name, p.status, p.planned_start_date, e.full_name;

grant select on v_dashboard_pre_start_blocked to roofops_dashboard;
