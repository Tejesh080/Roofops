-- Separation of duties for reissues (autonomous sprint, FOUR-EYES-01): ops_reissue_decide let the employee who requested
-- a reissue also approve it, so one person could replace a final invoice in Xero alone (AC-14C Stage 3C did exactly
-- that as the owner-supervised demo identity EMP-900).
--
-- Rule: when app_settings invoice.reissue_requires_second_person is on, a reissue request is decided by a second
-- person: the employee who requested it may not approve it; any other active employee in invoice.reissue_roles may.
-- A repeat delivery of an approval that is no longer PENDING is passed through unchanged (the decision's own
-- idempotent answer). ops_reissue_decide keeps its signature and grants; the original body is ops_reissue_decide_core.
--
-- Rollout: the setting is created OFF ('false'), so existing deployments and the existing reissue test suite keep
-- their current one-person behaviour; the owner switches it on (set it to 'true') when a second reissue-role person
-- exists. A missing setting counts as ON (fail closed).

insert into app_settings (key, value) values ('invoice.reissue_requires_second_person', 'false') on conflict (key) do nothing;

alter function ops_reissue_decide(text, text, text) rename to ops_reissue_decide_core;

create or replace function ops_reissue_decide(p_approval_number text, p_employee_code text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ap approvals; v_emp employees;
begin
  if coalesce((select value from app_settings where key = 'invoice.reissue_requires_second_person'), 'true') <> 'false' then
    select * into v_ap from approvals where approval_number = p_approval_number and action_type = 'REISSUE_INVOICE';
    select * into v_emp from employees where employee_code = p_employee_code;
    if v_ap.status = 'PENDING' and v_emp.id is not null and v_ap.requested_by_employee_id = v_emp.id then
      return jsonb_build_object('ok', false, 'code', 'SAME_PERSON',
        'detail', format('%s was requested by %s; a second person in a reissue role (%s) must approve it, so no one replaces a final invoice alone. Nothing was changed',
                         v_ap.approval_number, v_emp.employee_code,
                         coalesce((select value from app_settings where key = 'invoice.reissue_roles'), 'none configured')));
    end if;
  end if;
  return ops_reissue_decide_core(p_approval_number, p_employee_code, p_note);
end $$;

comment on function ops_reissue_decide(text, text, text) is
  'Decide a REISSUE_INVOICE approval: a second person (not the requester) unless invoice.reissue_requires_second_person = false';

-- Privileges: as before, owner-only (neither application role may decide a reissue); the core is never called directly.
revoke execute on all functions in schema public from public;
revoke execute on function ops_reissue_decide(text, text, text), ops_reissue_decide_core(text, text, text) from roofops_workflow, roofops_dashboard;
