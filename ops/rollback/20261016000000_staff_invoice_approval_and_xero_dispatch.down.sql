-- Rollback of 20261016000000_staff_invoice_approval_and_xero_dispatch.sql (owner only; one transaction).
-- Restores wf_invoice_decide_core exactly as 20261001190000 defined it (copied verbatim) and removes the dashboard invoice
-- functions, the staff dispatch poller and its request table. Decisions already made stay (approvals, invoices, outbox);
-- an open staff request is dropped with its table, so its write is simply not sent until 04/08 or a person sends it.
-- Disable n8n 09 first. Run: npx tsx scripts/sql.ts -f ops/rollback/20261016000000_staff_invoice_approval_and_xero_dispatch.down.sql
begin;
drop function if exists wf_xero_dispatch_next(text);
drop function if exists web_xero_dispatch_request(text, text, int, text);
drop function if exists web_invoice_decide(text, text, text, text, text);
drop function if exists web_invoice_prepare(text, text);
drop function if exists web_invoice_overview(text);
drop function if exists xero_draft_progress(uuid);
drop function if exists xero_dispatch_problem(text, int, text);
drop function if exists xero_dispatch_settle_claims();
drop function if exists xero_payload_sha256(jsonb);
drop view if exists v_dashboard_exception_sources;
drop table if exists xero_dispatch_requests;
drop function wf_invoice_decide_core(jsonb, text, uuid);
create or replace function wf_invoice_decide_core(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_draft jsonb; v_diff text;
  e record; v_type text := p_event ->> 'event_type'; v_prj text := p_event -> 'payload' ->> 'project_number';
  p projects; v_ap approvals; v_key text; v_claimed boolean; v_pe processed_events; v_emp employees;
  v_prev jsonb; v_hash text; v_inv invoices; v_run uuid; v_res jsonb; v_exc text; v_class text; v_msg text;
  v_tenant text := (select value from app_settings where key = 'xero.demo_tenant_id');
  v_line jsonb; v_gen int;
begin
  select * into e from wf_invoice_log_event(p_event, coalesce(nullif(v_type, ''), 'invoice.approved'), p_worker);
  if v_type not in ('invoice.approved', 'invoice.rejected') then
    e.issues := array_append(e.issues, 'event_type: must be invoice.approved or invoice.rejected'::text);
  end if;
  if array_length(e.issues, 1) > 0 then
    v_exc := wf_open_invoice_rejection(e.event_id, null, coalesce(v_prj, 'unknown'), 'VALIDATION_ERROR',
               'Invalid invoice decision event: ' || array_to_string(e.issues, '; '));
    update automation_events set status = 'REJECTED', error_class = 'VALIDATION_ERROR' where event_id = e.event_id;
    return jsonb_build_object('outcome', 'INVALID_EVENT', 'error_class', 'VALIDATION_ERROR', 'issues', to_jsonb(e.issues), 'exception_number', v_exc);
  end if;

  select * into p from projects where project_number = v_prj;
  if p.id is not null then
    select * into v_ap from approvals a where a.action_type = 'CREATE_INVOICE' and a.entity_id = p.id
       and (coalesce(p_event -> 'payload' ->> 'approval_number', '') = '' or a.approval_number = p_event -> 'payload' ->> 'approval_number')
     order by (a.status = 'PENDING') desc, a.created_at desc limit 1;
  end if;
  if p.id is null or v_ap.id is null then
    v_class := case when p.id is null then 'NOT_FOUND' else 'INVALID_STATE' end;
    v_msg := case when p.id is null then v_prj || ' does not exist' else 'No invoice preview to decide for ' || v_prj || '; prepare one first' end;
    v_exc := wf_open_invoice_rejection(e.event_id, p.id, v_prj, v_class, v_msg);
    update automation_events set status = 'REJECTED', error_class = v_class, metadata = metadata || jsonb_build_object('reason', v_msg) where event_id = e.event_id;
    return jsonb_build_object('outcome', 'INVALID_STATE', 'error_class', v_class, 'message', v_msg, 'exception_number', v_exc, 'project_number', v_prj);
  end if;

  -- One decision per approval, however many times (or ways) it is delivered.
  v_key := 'invoice.decision:' || v_ap.approval_number;
  insert into processed_events (consumer, idempotency_key, first_event_id, request_hash, status, locked_by, lease_expires_at)
  values ('invoice_decision@1', v_key, e.event_id, md5(v_ap.approval_number), 'PROCESSING', p_worker, now() + interval '5 minutes')
  on conflict do nothing returning true into v_claimed;
  if v_claimed is null then
    select * into v_pe from processed_events where consumer = 'invoice_decision@1' and idempotency_key = v_key for update;
    update processed_events set delivery_count = delivery_count + 1, last_seen_at = now() where consumer = v_pe.consumer and idempotency_key = v_key;
    update automation_events set status = 'DUPLICATE_IGNORED', error_class = 'DUPLICATE_EVENT', causation_id = v_pe.first_event_id,
           metadata = metadata || jsonb_build_object(
             'reason', case when e.redelivery then 'transport redelivery of the same event_id' else 'semantic duplicate: ' || v_ap.approval_number || ' was already decided' end,
             'delivery_count', v_pe.delivery_count + 1)
     where event_id = e.event_id;
    return coalesce(v_pe.result, '{}'::jsonb) || jsonb_build_object('outcome', 'ALREADY_PROCESSED', 'first_outcome', v_pe.result ->> 'outcome',
      'duplicate', true, 'delivery_count', v_pe.delivery_count + 1,
      'pending_side_effects', (select coalesce(jsonb_agg(jsonb_build_object('topic', topic, 'key', idempotency_key, 'status', status)), '[]')
                                 from outbox where aggregate_id = (v_pe.result ->> 'invoice_id')::uuid and status <> 'DONE'));
  end if;

  -- Authorisation: the Airtable user must map to an active employee in an approving role.
  select emp.* into v_emp from employee_external_identities ei join employees emp on emp.id = ei.employee_id
   where ei.provider = 'AIRTABLE' and ei.external_id = p_event ->> 'actor_id' and emp.is_active;
  if v_emp.id is null or not (v_emp.role = any (string_to_array((select value from app_settings where key = 'invoice.approver_roles'), ','))) then
    v_class := 'PERMISSION_DENIED';
    v_msg := format('Airtable user %s is not an authorised invoice approver (%s)', p_event ->> 'actor_id', coalesce(v_emp.role, 'not mapped to an employee'));
  elsif v_ap.status <> 'PENDING' then
    v_class := 'INVALID_STATE'; v_msg := format('%s is %s; only a PENDING preview can be decided', v_ap.approval_number, v_ap.status);
  elsif v_ap.expires_at <= now() then
    update approvals set status = 'EXPIRED' where id = v_ap.id;
    v_class := 'INVALID_STATE'; v_msg := format('%s expired at %s; prepare a new preview', v_ap.approval_number, v_ap.expires_at);
  elsif v_type = 'invoice.approved' then
    v_prev := invoice_final_preview(p.id);
    v_hash := case when (v_prev ->> 'ok')::boolean then invoice_preview_hash(v_prev -> 'preview') end;
    if v_hash is distinct from v_ap.payload_hash then
      update approvals set status = 'CANCELLED', decision_reason = 'Stale: the invoice would differ from the approved preview' where id = v_ap.id;
      v_class := 'INVALID_STATE';
      v_msg := format('%s is stale: %s. Prepare a new preview', v_ap.approval_number, coalesce(v_prev ->> 'message', 'the amount or details changed since it was prepared'));
    elsif coalesce(v_tenant, '') = '' then
      v_class := 'INVALID_STATE'; v_msg := 'No Xero Demo Company tenant is pinned (app_settings xero.demo_tenant_id); refusing to queue a Xero write';
    end if;
  end if;

  if v_class is not null then
    delete from processed_events where consumer = 'invoice_decision@1' and idempotency_key = v_key;   -- a corrected retry may decide later
    v_exc := wf_open_invoice_rejection(e.event_id, p.id, v_prj, v_class, v_msg);
    update automation_events set status = 'REJECTED', error_class = v_class, metadata = metadata || jsonb_build_object('reason', v_msg) where event_id = e.event_id;
    return jsonb_build_object('outcome', case when v_class = 'PERMISSION_DENIED' then 'PERMISSION_DENIED' else 'INVALID_STATE' end,
      'error_class', v_class, 'message', v_msg, 'exception_number', v_exc, 'approval_number', v_ap.approval_number, 'project_number', v_prj);
  end if;

  if v_type = 'invoice.rejected' then
    update approvals set status = 'REJECTED', decided_by = v_emp.id, decided_at = now(),
           decision_reason = coalesce(nullif(p_event -> 'payload' ->> 'reason', ''), 'Rejected in Airtable') where id = v_ap.id;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason, correlation_id)
    values ('USER', v_emp.employee_code, 'approval.reject', 'approval', v_ap.id, v_ap.approval_number,
            jsonb_build_object('status', 'PENDING'), jsonb_build_object('status', 'REJECTED'), 'Invoice preview rejected', e.correlation_id);
    v_res := jsonb_build_object('outcome', 'REJECTED_BY_APPROVER', 'approval_number', v_ap.approval_number, 'decided_by', v_emp.full_name);
  else
    -- Approve: the RoofOps invoice (one FINAL per project, ever) + ONE queued Xero side effect.
    update approvals set status = 'EXECUTING', decided_by = v_emp.id, decided_at = now() where id = v_ap.id;
    insert into invoices (invoice_number, project_id, customer_id, invoice_type, status, sync_status, line_amount_type,
                          issue_date, due_date, approval_id, approved_by, approved_at, idempotency_key)
    values (next_friendly_id('INV', extract(year from app_today())::int), p.id, p.customer_id, 'FINAL', 'APPROVED', 'PENDING', 'INCLUSIVE',
            (v_ap.action_payload ->> 'invoice_date')::date, (v_ap.action_payload ->> 'due_date')::date, v_ap.id, v_emp.id, now(),
            'invoice:final:' || p.id)
    returning * into v_inv;
    for v_line in select * from jsonb_array_elements(v_ap.action_payload -> 'lines') loop
      insert into invoice_lines (invoice_id, line_no, description, quantity, unit_price, variation_id, account_code)
      values (v_inv.id, (v_line ->> 'line_no')::int, v_line ->> 'description', (v_line ->> 'quantity')::numeric, (v_line ->> 'unit_amount')::numeric,
              nullif(v_line ->> 'variation_id', '')::uuid, v_ap.action_payload ->> 'xero_account_code');
    end loop;
    select * into v_inv from invoices where id = v_inv.id;   -- totals are derived by trigger from the lines
    if v_inv.total_inc_gst <> (v_ap.action_payload ->> 'amount_inc_gst')::numeric or v_inv.gst_amount <> (v_ap.action_payload ->> 'gst_amount')::numeric then
      raise exception 'invoice % totals % / GST % disagree with the approved preview % / %', v_inv.invoice_number, v_inv.total_inc_gst, v_inv.gst_amount,
        v_ap.action_payload ->> 'amount_inc_gst', v_ap.action_payload ->> 'gst_amount' using errcode = 'check_violation';
    end if;

    insert into workflow_runs (workflow_key, workflow_version, runner, trigger_event_id, correlation_id, idempotency_key,
                               entity_type, entity_id, business_reference, status, attempt_count, started_at)
    values ('project_to_invoice', (select value from app_settings where key = 'wf.project_to_invoice.version'), 'N8N', e.event_id, e.correlation_id,
            v_key, 'invoice', v_inv.id, v_inv.invoice_number, 'RUNNING', 1, now())
    returning id into v_run;
    -- AC-14C B1: this approval queues a generation, and the generation owns the keys. A first-time invoice gets
    -- generation 1 - the historic key formats, byte for byte - and the reissue facility (Part B2) queues the next one.
    v_gen := coalesce((select max(o.generation) from outbox o where o.topic = 'xero.create_draft_invoice' and o.aggregate_id = v_inv.id), 0) + 1;
    -- P2-H2: the Xero-facing payload is generated from the canonical invoice just created, by the same builder the
    -- reissue uses; it must agree with every value the approver saw in the preview.
    v_draft := xero_draft_payload(v_inv.id, v_tenant);
    select string_agg(d.key, ', ' order by d.key) into v_diff from jsonb_each(v_draft) d
     where v_ap.action_payload ? d.key and v_ap.action_payload -> d.key is distinct from d.value;
    if v_diff is not null then
      raise exception 'invoice % draft disagrees with the approved preview % on: %', v_inv.invoice_number, v_ap.approval_number, v_diff using errcode = 'check_violation';
    end if;
    insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, generation)
    values ('xero.create_draft_invoice', 'invoice', v_inv.id, e.correlation_id, xero_draft_outbox_key(v_inv.id, v_gen),
      v_ap.action_payload || v_draft || jsonb_build_object(
        'approval_number', v_ap.approval_number, 'approved_by', v_emp.full_name,
        'xero_idempotency_key', xero_draft_provider_key(v_inv.id, v_gen)), v_gen);
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason, correlation_id, workflow_run_id)
    values ('USER', v_emp.employee_code, 'approval.approve', 'approval', v_ap.id, v_ap.approval_number,
            jsonb_build_object('status', 'PENDING'), jsonb_build_object('status', 'EXECUTING', 'payload_hash', v_ap.payload_hash),
            'Final invoice approved by ' || v_emp.full_name, e.correlation_id, v_run),
           ('WORKFLOW', 'project_to_invoice@1', 'invoice.create', 'invoice', v_inv.id, v_inv.invoice_number, null,
            jsonb_build_object('project', v_prj, 'type', 'FINAL', 'status', 'APPROVED', 'total_inc_gst', v_inv.total_inc_gst, 'gst', v_inv.gst_amount),
            'Created from approved preview ' || v_ap.approval_number, e.correlation_id, v_run);
    insert into workflow_run_steps (run_id, attempt, seq, step_key, status, finished_at, detail) values
      (v_run, 1, 1, 'validate_event', 'SUCCEEDED', now(), '{}'),
      (v_run, 1, 2, 'authorise_approver', 'SUCCEEDED', now(), jsonb_build_object('employee', v_emp.employee_code, 'role', v_emp.role)),
      (v_run, 1, 3, 'recheck_preview_hash', 'SUCCEEDED', now(), jsonb_build_object('payload_hash', v_ap.payload_hash)),
      (v_run, 1, 4, 'create_invoice', 'SUCCEEDED', now(), jsonb_build_object('invoice_number', v_inv.invoice_number, 'total_inc_gst', v_inv.total_inc_gst)),
      (v_run, 1, 5, 'queue_xero_draft', 'SUCCEEDED', now(), jsonb_build_object('key', xero_draft_outbox_key(v_inv.id, v_gen), 'generation', v_gen));
    perform wf_log_event(e.event_key || ':invoice.approved', e.correlation_id, e.event_id, 'invoice.created', 'invoice', v_inv.id,
      v_inv.invoice_number, 'WORKFLOW', 'project_to_invoice@1', 'postgres', 'SUCCEEDED', null,
      jsonb_build_object('approval', v_ap.approval_number, 'total_inc_gst', v_inv.total_inc_gst), null);
    v_res := jsonb_build_object('outcome', 'APPROVED', 'approval_number', v_ap.approval_number, 'decided_by', v_emp.full_name,
      'invoice_id', v_inv.id, 'invoice_number', v_inv.invoice_number, 'amount_inc_gst', v_inv.total_inc_gst, 'workflow_run_id', v_run,
      'xero_key', xero_draft_outbox_key(v_inv.id, v_gen), 'generation', v_gen, 'preview', v_ap.action_payload);
  end if;

  update automation_events set status = 'SUCCEEDED', metadata = metadata || jsonb_build_object('outcome', v_res ->> 'outcome') where event_id = e.event_id;
  v_res := v_res || jsonb_build_object('project_number', v_prj, 'project_id', p.id, 'event_key', e.event_key, 'duplicate', false);
  update processed_events set status = 'COMPLETED', completed_at = now(), result = v_res, lease_expires_at = null
   where consumer = 'invoice_decision@1' and idempotency_key = v_key;
  return v_res;
end $$;
revoke execute on all functions in schema public from public;
revoke execute on function wf_invoice_decide_core(jsonb, text) from roofops_workflow, roofops_dashboard;
delete from app_settings where key in ('invoice.prepare_roles', 'xero.dispatch_roles', 'xero.dispatch_claim_stale_minutes');
delete from schema_migrations where version = '20261016000000_staff_invoice_approval_and_xero_dispatch.sql';
commit;
