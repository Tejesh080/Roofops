-- Exception resolution follow-up (docs/defect-ledger.md, AC-03 §15): an open exception (e.g. EXC-0018, a refused
-- Airtable Approve that was later withdrawn) could only be closed by editing workflow_exceptions with SQL. There was no
-- supported path, no check of who may close it, and no audit of why.
--
-- Rule: an operator resolves an OPEN exception with `npm run exception:resolve`, which calls ops_resolve_exception. It
-- records who (an active employee in an allowed role), when, and why (a real note), moves OPEN -> RESOLVED through the
-- existing state machine, and writes one audit row with the before and after state. The exception row is kept as it
-- was (its failure, attempts and history); nothing is deleted. Neither application role can call it.

insert into app_settings (key, value) values ('exception.resolver_roles', 'FINANCE,ADMIN,OPERATIONS_MANAGER,PROJECT_MANAGER')
on conflict (key) do nothing;

create or replace function ops_resolve_exception(p_exception text, p_employee_code text, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare x workflow_exceptions; v_emp employees; v_note text := btrim(coalesce(p_note, ''));
begin
  if length(v_note) < 10 then
    return jsonb_build_object('resolved', false, 'reason', 'a resolution needs a note saying why (at least 10 characters)');
  end if;
  select * into v_emp from employees where employee_code = p_employee_code;
  if v_emp.id is null then
    return jsonb_build_object('resolved', false, 'reason', coalesce(p_employee_code, 'no employee') || ' is not a RoofOps employee');
  end if;
  if not v_emp.is_active then
    return jsonb_build_object('resolved', false, 'reason', v_emp.employee_code || ' is not active');
  end if;
  if not (v_emp.role = any (string_to_array((select value from app_settings where key = 'exception.resolver_roles'), ','))) then
    return jsonb_build_object('resolved', false, 'reason', format('%s (%s) may not resolve exceptions', v_emp.employee_code, v_emp.role));
  end if;
  select * into x from workflow_exceptions where exception_number = p_exception for update;
  if x.id is null then
    return jsonb_build_object('resolved', false, 'reason', coalesce(p_exception, 'no exception number') || ' does not exist');
  end if;
  if x.resolution_status <> 'OPEN' then
    return jsonb_build_object('resolved', false, 'already_resolved', x.resolution_status in ('RESOLVED', 'IGNORED'),
      'reason', format('%s is already %s%s', x.exception_number, x.resolution_status,
                       case when x.resolved_by is not null then ' by ' || (select employee_code from employees where id = x.resolved_by)
                            when x.resolved_by_system is not null then ' by ' || x.resolved_by_system else '' end));
  end if;
  update workflow_exceptions set resolution_status = 'RESOLVED', resolved_by = v_emp.id, resolved_at = now(), resolution_note = v_note
   where id = x.id;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
  values ('USER', v_emp.employee_code, 'exception.resolved', 'workflow_exception', x.id, x.exception_number,
          jsonb_build_object('resolution_status', x.resolution_status, 'error_class', x.error_class, 'reference', x.business_reference),
          jsonb_build_object('resolution_status', 'RESOLVED', 'resolved_by', v_emp.employee_code), v_note);
  return jsonb_build_object('resolved', true, 'exception_number', x.exception_number, 'resolved_by', v_emp.employee_code,
                            'resolved_at', now(), 'reference', x.business_reference);
end $$;

update field_contract set editable_in = 'npm run exception:resolve (ops_resolve_exception: OPEN -> RESOLVED, audited) / ops SQL re-queue / automatic resolve'
 where entity = 'workflow_exception' and field_key = 'resolution_status';

revoke execute on all functions in schema public from public;
revoke execute on function ops_resolve_exception(text, text, text) from roofops_workflow, roofops_dashboard;
