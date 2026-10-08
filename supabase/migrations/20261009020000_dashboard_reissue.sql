-- Reissue from the dashboard (autonomous sprint, REISSUE-UI-01): a supervised reissue (AC-14C) could only be requested
-- and decided with the owner's database CLI, under a typed employee code. Staff now do it in the dashboard as
-- themselves.
--
-- Rule: the dashboard calls only these web_* functions, each with the staff session token from sign-in
-- (20261009000000). The database resolves the token to the employee and applies the existing reissue rules unchanged
-- (ops_reissue_request / ops_reissue_decide: role invoice.reissue_roles, a real reason, verified void evidence, the
-- approved preview, one decision per approval, the generation ledger). On top of that, the dashboard path ALWAYS needs
-- a second person: whoever requested a reissue can never approve it here, whatever invoice.reissue_requires_second_person
-- says (that setting governs only the owner's CLI). The draft is still created in Xero only by the supervised dispatch
-- (08, operator token); the dashboard shows that step.

-- What a signed-in staff member sees: every final invoice that is voided (a reissue candidate, with why or why not) or
-- that has a reissue request, newest first, with the draft that would be created and what happened after approval.
create or replace function web_reissue_overview(p_token text)
returns jsonb language plpgsql stable security definer set search_path = extensions, public, pg_temp as $$
declare v_emp employees := staff_session_employee(p_token); v_roles text[];
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'reason', 'Sign in as yourself to see invoice reissues.'); end if;
  v_roles := string_to_array(coalesce((select value from app_settings where key = 'invoice.reissue_roles'), ''), ',');
  return jsonb_build_object('ok', true,
    'me', jsonb_build_object('employee_code', v_emp.employee_code, 'name', v_emp.full_name, 'role', v_emp.role, 'may_reissue', v_emp.role = any (v_roles)),
    'roles', array_to_string(v_roles, ', '),
    'items', coalesce((select jsonb_agg(x order by x ->> 'sort' desc) from (
      select jsonb_build_object(
        'sort', coalesce((select max(a.created_at) from approvals a where a.entity_id = i.id and a.action_type = 'REISSUE_INVOICE'), i.updated_at)::text,
        'invoice_number', i.invoice_number, 'project_number', p.project_number, 'customer', c.display_name,
        'status', i.status, 'total_inc_gst', i.total_inc_gst, 'gst_amount', i.gst_amount, 'voided_reason', i.voided_reason,
        'check', case when i.status = 'VOIDED' then invoice_reissue_check(i.id) end,
        'pending', (select jsonb_build_object('approval_number', a.approval_number, 'requested_at', a.created_at, 'expires_at', a.expires_at,
                      'requested_by', re.employee_code, 'requested_by_name', re.full_name, 'reason', a.action_payload ->> 'requested_reason',
                      'xero_invoice_number', a.action_payload -> 'draft' ->> 'xero_invoice_number',
                      'amount_inc_gst', a.action_payload -> 'draft' ->> 'amount_inc_gst', 'gst_amount', a.action_payload -> 'draft' ->> 'gst_amount',
                      'contact', a.action_payload -> 'draft' ->> 'xero_contact_name', 'tenant', a.action_payload -> 'draft' ->> 'xero_tenant_name',
                      'target_generation', a.action_payload ->> 'target_generation',
                      'i_requested_it', a.requested_by_employee_id = v_emp.id)
                    from approvals a left join employees re on re.id = a.requested_by_employee_id
                    where a.entity_id = i.id and a.action_type = 'REISSUE_INVOICE' and a.status = 'PENDING' and a.expires_at > now()
                    order by a.created_at desc limit 1),
        'latest_decided', (select jsonb_build_object('approval_number', a.approval_number, 'status', a.status, 'decided_at', a.decided_at,
                      'decided_by', de.full_name, 'requested_by', re.full_name, 'generation', g.generation, 'generation_status', g.status,
                      'xero_invoice_id', g.xero_invoice_id, 'write_status', o.status, 'write_attempts', o.attempts)
                    from approvals a
                    left join employees de on de.id = a.decided_by
                    left join employees re on re.id = a.requested_by_employee_id
                    left join invoice_xero_draft_generations g on g.approval_id = a.id
                    left join outbox o on o.idempotency_key = g.outbox_idempotency_key
                    where a.entity_id = i.id and a.action_type = 'REISSUE_INVOICE' and a.status in ('EXECUTED', 'EXECUTING', 'REJECTED', 'CANCELLED')
                    order by coalesce(a.decided_at, a.created_at) desc limit 1)
      ) x
      from invoices i join projects p on p.id = i.project_id join customers c on c.id = i.customer_id
      where i.invoice_type = 'FINAL'
        and (i.status = 'VOIDED' or exists (select 1 from approvals a where a.entity_id = i.id and a.action_type = 'REISSUE_INVOICE'))
    ) t), '[]'::jsonb));
end $$;

create or replace function web_reissue_request(p_token text, p_invoice_number text, p_reason text)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare v_emp employees := staff_session_employee(p_token); v_inv uuid;
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT', 'detail', 'Your sign-in has ended. Sign in again as yourself.'); end if;
  select id into v_inv from invoices where invoice_number = p_invoice_number;
  if v_inv is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', coalesce(p_invoice_number, 'no invoice') || ' is not an invoice'); end if;
  return ops_reissue_request(v_inv, v_emp.employee_code, p_reason);
end $$;

create or replace function web_reissue_decide(p_token text, p_approval_number text, p_note text)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare v_emp employees := staff_session_employee(p_token); v_ap approvals;
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT', 'detail', 'Your sign-in has ended. Sign in again as yourself.'); end if;
  select * into v_ap from approvals where approval_number = p_approval_number and action_type = 'REISSUE_INVOICE';
  if v_ap.id is not null and v_ap.requested_by_employee_id = v_emp.id and v_ap.status = 'PENDING' then
    return jsonb_build_object('ok', false, 'code', 'SAME_PERSON',
      'detail', format('You requested %s, so a second person must approve it: someone else in a reissue role (%s). Nothing was changed',
                       v_ap.approval_number, coalesce((select value from app_settings where key = 'invoice.reissue_roles'), 'none configured')));
  end if;
  return ops_reissue_decide(p_approval_number, v_emp.employee_code, p_note);
end $$;

comment on function web_reissue_decide(text, text, text) is
  'Dashboard reissue decision as the session employee; the requester can never approve (always a second person here)';

-- Privileges: only the dashboard role, and only these three (they resolve and check the session themselves).
revoke execute on all functions in schema public from public;
grant execute on function web_reissue_overview(text), web_reissue_request(text, text, text), web_reissue_decide(text, text, text) to roofops_dashboard;
