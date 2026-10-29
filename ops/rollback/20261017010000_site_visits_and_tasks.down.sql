-- Rollback of 20261017010000_site_visits_and_tasks.sql (owner only; one transaction).
-- Removes the dashboard visit and task functions and their views, and restores v_dashboard_project_checklist exactly as
-- hosted had it (copied verbatim). Records already made stay: visits (jobs, job_assignments), tasks and their numbers,
-- site notes and audit history; the added columns stay (nullable, harmless) so nothing is lost and a re-apply is a no-op
-- for them. The dashboard then shows site visits and tasks as unavailable. Roll back 20261017020000 first if applied.
-- Run: npx tsx scripts/sql.ts -f ops/rollback/20261017010000_site_visits_and_tasks.down.sql
begin;
create or replace view public.v_dashboard_project_checklist as
 SELECT p.project_number,
    'CHECKLIST'::text AS kind,
    ci.stage,
    ci.label AS title,
    ci.status,
    ci.is_required,
    ci.completed_on AS done_on,
    NULL::date AS due_on,
    NULL::text AS assignee,
    ci.sort_order
   FROM project_checklist_items ci
     JOIN projects p ON p.id = ci.project_id
UNION ALL
 SELECT p.project_number,
    'TASK'::text AS kind,
    t.task_type AS stage,
    t.title,
    t.status,
    true AS is_required,
    NULL::date AS done_on,
    t.due_on,
    e.full_name AS assignee,
    0 AS sort_order
   FROM tasks t
     JOIN projects p ON p.id = t.project_id
     LEFT JOIN employees e ON e.id = t.assignee_id;

drop view if exists v_dashboard_ops_roles;
drop view if exists v_dashboard_tasks;
drop view if exists v_dashboard_site_visits;
drop view if exists v_dashboard_staff;
drop function if exists web_task_update(text, text, text, integer, text, date, text);
drop function if exists web_task_create(text, text, text, text, text, date, text, text);
drop function if exists web_visit_update(text, text, text, integer, text, timestamptz, timestamptz);
drop function if exists web_visit_schedule(text, text, text, timestamptz, timestamptz, text[], text, text, text);
drop function if exists visit_times_problem(timestamptz, timestamptz);
drop function if exists visit_crew_conflict(uuid[], timestamptz, timestamptz, uuid);
drop function if exists staff_role_allowed(employees, text);
alter table tasks alter column task_number drop default;
update field_contract set editable_in = 'none (no staff UI; NOT SUPPORTED)', change_path = 'created by wf_quote_accepted'
 where entity = 'task' and field_key = 'material_review';
delete from app_settings where key in ('schedule.planner_roles', 'task.manager_roles', 'schedule.max_visit_days');
delete from schema_migrations where version = '20261017010000_site_visits_and_tasks.sql';
commit;
