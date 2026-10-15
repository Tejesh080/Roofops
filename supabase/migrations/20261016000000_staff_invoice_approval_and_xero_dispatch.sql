-- STAFF-OPS-01: final invoices and Xero drafts are run by named staff in the dashboard, with the existing safeguards.
--
-- Before: a final invoice was approved only through Airtable's one shared account (Prepare/Approve on the row), so the
-- approval named the shared identity (EMP-900) and nobody individually; Copilot previews recorded no requester; and a
-- replacement (reissue) draft reached Xero only through the owner's CLI dispatch with a short-lived token.
--
-- Now, for a signed-in employee (the session token is checked here, never a claimed code):
--  * web_invoice_prepare: the existing preview (wf_invoice_prepare, unchanged), recording that employee as requester.
--  * web_invoice_decide: approve or reject that exact preview (its payload hash), by an approver role, never the
--    requester; it runs the existing decision core, unchanged except that it may be given the proven employee instead
--    of an Airtable identity (p_employee; only this function passes it, no app role can call the core).
--  * web_xero_dispatch_request: ask for one queued Xero draft write (exact invoice number + generation + the payload
--    the person saw) to be sent. An approval in the dashboard queues its own request. Nothing calls Xero here: the new
--    n8n poller (09) takes requests with wf_xero_dispatch_next and runs the unchanged 05, whose claim re-proves the
--    write. No secret is ever needed by the browser or the web server.
--  * web_invoice_overview: what the Finance page shows (pending previews with their figures, writes and progress).
-- Fail closed: an uncertain write (invoice UNKNOWN), a dead letter, a write in progress or not yet due, a changed
-- payload, a superseded generation or an unproven reissue is never requested or handed to n8n.

-- 1. The decision core may be given a proven employee (identical body otherwise; see the migration notes).
drop function wf_invoice_decide_core(jsonb, text);
create function wf_invoice_decide_core(p_event jsonb, p_worker text default 'n8n', p_employee uuid default null)
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

  -- Authorisation: the approver is an active employee in an approving role: the one a dashboard session proved
  -- (p_employee, passed only by web_invoice_decide; no app role can call this core), else the Airtable user's mapping.
  if p_employee is not null then
    select emp.* into v_emp from employees emp where emp.id = p_employee and emp.is_active;
  else
    select emp.* into v_emp from employee_external_identities ei join employees emp on emp.id = ei.employee_id
     where ei.provider = 'AIRTABLE' and ei.external_id = p_event ->> 'actor_id' and emp.is_active;
  end if;
  if v_emp.id is null or not (v_emp.role = any (string_to_array((select value from app_settings where key = 'invoice.approver_roles'), ','))) then
    v_class := 'PERMISSION_DENIED';
    v_msg := case when p_employee is not null then format('%s is not an authorised invoice approver (%s)', p_event ->> 'actor_id', coalesce(v_emp.role, 'not active'))
             else format('Airtable user %s is not an authorised invoice approver (%s)', p_event ->> 'actor_id', coalesce(v_emp.role, 'not mapped to an employee')) end;
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
           decision_reason = coalesce(nullif(p_event -> 'payload' ->> 'reason', ''), case when p_employee is not null then 'Rejected in the RoofOps dashboard' else 'Rejected in Airtable' end) where id = v_ap.id;
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

insert into app_settings (key, value) values
  ('invoice.prepare_roles', 'FINANCE,ADMIN,OPERATIONS_MANAGER,PROJECT_MANAGER'),
  ('xero.dispatch_roles', 'FINANCE,ADMIN'),
  ('xero.dispatch_claim_stale_minutes', '15')
on conflict (key) do nothing;

-- 2. Staff requests to send one queued Xero draft write (at most one open request per write).
create table xero_dispatch_requests (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices (id),
  generation int not null check (generation >= 1),
  xero_key text not null,
  payload_sha256 text not null,
  requested_by uuid not null references employees (id),
  requested_at timestamptz not null default now(),
  reason text not null,
  status text not null default 'QUEUED' check (status in ('QUEUED', 'CLAIMED', 'HANDED_OVER', 'REFUSED', 'EXPIRED')),
  attempts_at_claim int,
  claimed_by text,
  claimed_at timestamptz,
  closed_reason text
);
create unique index xero_dispatch_requests_one_open on xero_dispatch_requests (xero_key) where status in ('QUEUED', 'CLAIMED');
create index xero_dispatch_requests_invoice on xero_dispatch_requests (invoice_id, requested_at desc);
alter table xero_dispatch_requests enable row level security;
comment on table xero_dispatch_requests is 'Staff requests to send one queued xero.create_draft_invoice write; taken by n8n 09 (wf_xero_dispatch_next), which runs 05';

create or replace function xero_payload_sha256(p jsonb)
returns text language sql immutable set search_path = public, pg_temp as $$ select encode(sha256(convert_to(p::text, 'UTF8')), 'hex') $$;

-- A claimed request is settled once 05 has tried the write (attempts moved on) or it is done; one never picked up expires.
create or replace function xero_dispatch_settle_claims()
returns void language sql security definer set search_path = public, pg_temp as $$
  update xero_dispatch_requests r set status = 'HANDED_OVER', closed_reason = 'taken by 05'
    from outbox o where r.status = 'CLAIMED' and o.idempotency_key = r.xero_key and (o.status = 'DONE' or o.attempts > coalesce(r.attempts_at_claim, 0));
  update xero_dispatch_requests r set status = 'EXPIRED', closed_reason = 'not taken by 05 in time; request it again'
   where r.status = 'CLAIMED' and r.claimed_at < now() - make_interval(mins => coalesce((select value::int from app_settings where key = 'xero.dispatch_claim_stale_minutes'), 15));
$$;

-- Why one write cannot be sent now (null = it may be sent). Same rules as the operator dispatch, for any generation.
create or replace function xero_dispatch_problem(p_invoice_number text, p_generation int, p_payload_sha256 text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare i invoices; g invoice_xero_draft_generations; o outbox; v_ap approvals; v_p text;
begin
  select * into i from invoices where invoice_number = p_invoice_number;
  if i.id is null then return jsonb_build_object('code', 'NOT_FOUND', 'detail', format('no invoice %s', p_invoice_number)); end if;
  select * into g from invoice_xero_draft_generations where invoice_id = i.id and superseded_at is null;
  if g.generation is distinct from p_generation then
    return jsonb_build_object('code', 'NOT_CURRENT_GENERATION', 'detail', format('the current Xero draft of %s is generation %s', i.invoice_number, coalesce(g.generation::text, 'none')));
  end if;
  select * into o from outbox where idempotency_key = xero_draft_outbox_key(i.id, p_generation) and topic = 'xero.create_draft_invoice';
  if o.id is null then return jsonb_build_object('code', 'NO_WRITE', 'detail', 'no Xero draft is queued for it'); end if;
  if o.status = 'DONE' then return jsonb_build_object('code', 'ALREADY_CREATED', 'detail', 'its Xero draft already exists'); end if;
  if i.sync_status = 'UNKNOWN' then
    return jsonb_build_object('code', 'UNCERTAIN', 'detail', 'Xero may already have created it; the next reconciliation checks Xero and records the answer. Do not send it again');
  end if;
  if o.status = 'DISPATCHING' then return jsonb_build_object('code', 'IN_PROGRESS', 'detail', 'it is being created in Xero right now'); end if;
  if o.status = 'FAILED' and o.next_attempt_at = 'infinity' then
    return jsonb_build_object('code', 'STOPPED', 'detail', 'it stopped after repeated failures; see the open issue on Automation');
  end if;
  if o.next_attempt_at > now() then
    return jsonb_build_object('code', 'NOT_DUE', 'detail', format('it can be retried after %s', to_char(o.next_attempt_at at time zone 'Australia/Brisbane', 'DD Mon HH24:MI')));
  end if;
  if o.generation >= 2 then
    v_p := xero_reissue_proof(o);
    if v_p is not null then return jsonb_build_object('code', 'NOT_PROVEN', 'detail', v_p); end if;
    select a.* into v_ap from approvals a where a.id = g.approval_id;
  else
    select a.* into v_ap from approvals a where a.id = i.approval_id;
  end if;
  if v_ap.id is null or v_ap.status not in ('EXECUTING', 'EXECUTED') or v_ap.decided_by is null then
    return jsonb_build_object('code', 'NOT_APPROVED', 'detail', 'no approved decision is behind this draft');
  end if;
  if p_payload_sha256 is not null and p_payload_sha256 is distinct from xero_payload_sha256(o.payload) then
    return jsonb_build_object('code', 'PAYLOAD_CHANGED', 'detail', 'the draft changed since you looked at it; reload and check it again');
  end if;
  return null;
end $$;

-- What a Xero draft write looks like to staff right now (authoritative: outbox, invoice sync state, open request).
create or replace function xero_draft_progress(p_invoice uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare i invoices; o outbox; r xero_dispatch_requests; v_state text; v_req text; p projects; c customers;
begin
  select * into i from invoices where id = p_invoice;
  select * into o from outbox_current('xero.create_draft_invoice', p_invoice);
  if o.id is null then return null; end if;
  select * into p from projects where id = i.project_id;
  select * into c from customers where id = i.customer_id;
  select * into r from xero_dispatch_requests where xero_key = o.idempotency_key order by requested_at desc limit 1;
  v_state := case
    when o.status = 'DONE' then 'CREATED'
    when i.sync_status = 'UNKNOWN' then 'UNCERTAIN'
    when o.status = 'DISPATCHING' then 'SENDING'
    when o.status = 'FAILED' and o.next_attempt_at = 'infinity' then 'STOPPED'
    when r.status = 'QUEUED' then 'QUEUED'
    when r.status = 'CLAIMED' and o.attempts <= coalesce(r.attempts_at_claim, 0) then 'STARTING'   -- not yet taken by 05
    when o.status = 'FAILED' and o.next_attempt_at > now() then 'RETRY_LATER'
    when o.status = 'FAILED' then 'FAILED'
    else 'READY_TO_SEND' end;
  select e.full_name into v_req from employees e where e.id = r.requested_by;
  return jsonb_build_object('invoice_number', i.invoice_number, 'project_number', p.project_number, 'customer', c.display_name,
    'amount_inc_gst', o.payload ->> 'amount_inc_gst', 'xero_invoice_number', o.payload ->> 'xero_invoice_number', 'generation', o.generation,
    'state', v_state, 'attempts', o.attempts, 'next_attempt_at', nullif(o.next_attempt_at, 'infinity'),
    'last_error', left(regexp_replace(coalesce(o.last_error, ''), '\s+', ' ', 'g'), 240), 'payload_sha256', xero_payload_sha256(o.payload),
    'xero_invoice_id', (select g.xero_invoice_id from invoice_xero_draft_generations g where g.invoice_id = i.id and g.superseded_at is null),
    'request', case when r.id is null then null else jsonb_build_object('status', r.status, 'requested_by', v_req, 'requested_at', r.requested_at,
      'reason', r.reason, 'closed_reason', r.closed_reason) end,
    'problem', xero_dispatch_problem(i.invoice_number, o.generation, null));
end $$;

-- 3. The Finance page, for a signed-in employee: pending previews (full figures) and Xero draft writes not yet settled.
create or replace function web_invoice_overview(p_token text)
returns jsonb language plpgsql stable security definer set search_path = extensions, public, pg_temp as $$
declare v_emp employees := staff_session_employee(p_token);
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT'); end if;
  return jsonb_build_object('ok', true,
    'me', jsonb_build_object('employee_code', v_emp.employee_code, 'name', v_emp.full_name, 'role', v_emp.role,
      'may_prepare', v_emp.role = any (string_to_array((select value from app_settings where key = 'invoice.prepare_roles'), ',')),
      'may_approve', v_emp.role = any (string_to_array((select value from app_settings where key = 'invoice.approver_roles'), ',')),
      'may_dispatch', v_emp.role = any (string_to_array((select value from app_settings where key = 'xero.dispatch_roles'), ','))),
    'pending', coalesce((
      select jsonb_agg(jsonb_build_object('approval_number', a.approval_number, 'project_number', a.business_reference,
               'payload_hash', a.payload_hash, 'preview', a.action_payload, 'requested_at', a.created_at, 'expires_at', a.expires_at,
               'requested_by', re.full_name, 'i_requested_it', a.requested_by_employee_id = v_emp.id,
               'requested_via', case when a.idempotency_key like 'approval:dashboard:prepare:%' then 'dashboard'
                                     when a.idempotency_key like 'approval:dashboard:%' then 'copilot' else 'airtable' end)
             order by a.created_at)
        from approvals a left join employees re on re.id = a.requested_by_employee_id
       where a.action_type = 'CREATE_INVOICE' and a.status = 'PENDING' and a.expires_at > now()), '[]'::jsonb),
    'drafts', coalesce((
      select jsonb_agg(x.d order by x.d ->> 'invoice_number')
        from (select xero_draft_progress(i.id) d from invoices i
               where i.invoice_type = 'FINAL' and exists (select 1 from outbox o where o.topic = 'xero.create_draft_invoice' and o.aggregate_id = i.id)) x
       where x.d is not null and (x.d ->> 'state' <> 'CREATED' or exists (select 1 from outbox o where o.idempotency_key = xero_draft_outbox_key(
               (select id from invoices where invoice_number = x.d ->> 'invoice_number'), (x.d ->> 'generation')::int) and o.dispatched_at > now() - interval '2 days'))), '[]'::jsonb));
end $$;

-- 4. Prepare (preview only) as the signed-in employee, who is recorded as the requester.
create or replace function web_invoice_prepare(p_token text, p_project text)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare v_emp employees := staff_session_employee(p_token); v_event text; v_res jsonb;
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT'); end if;
  if not (v_emp.role = any (string_to_array((select value from app_settings where key = 'invoice.prepare_roles'), ','))) then
    return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED', 'detail', format('%s (%s) may not prepare invoices', v_emp.employee_code, v_emp.role));
  end if;
  v_event := 'dashboard:prepare:' || coalesce(p_project, '') || ':' || gen_random_uuid();
  v_res := wf_invoice_prepare(jsonb_build_object('event_id', v_event, 'correlation_id', v_event, 'event_type', 'invoice.prepare_requested',
             'source', 'roofops-dashboard', 'actor_id', v_emp.employee_code, 'actor_name', v_emp.full_name, 'occurred_at', now(),
             'payload', jsonb_build_object('project_number', p_project)), 'dashboard:' || v_emp.employee_code);
  if v_res ->> 'outcome' = 'PREVIEW_READY' then
    update approvals set requested_by_employee_id = v_emp.id, requested_by_actor_type = 'USER'
     where approval_number = v_res ->> 'approval_number' and status = 'PENDING' and requested_by_employee_id is null;
  end if;
  return v_res || jsonb_build_object('ok', v_res ->> 'outcome' in ('PREVIEW_READY', 'ALREADY_PENDING'));
end $$;

-- 5. Approve or reject the exact preview shown, as an approver who is not the requester; an approval queues its draft.
create or replace function web_invoice_decide(p_token text, p_approval text, p_payload_hash text, p_decision text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare
  v_emp employees := staff_session_employee(p_token); v_ap approvals; p projects; v_event text; v_res jsonb; o outbox; i invoices;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT'); end if;
  if p_decision not in ('approve', 'reject') then return jsonb_build_object('ok', false, 'code', 'INVALID_DECISION'); end if;
  if not (v_emp.role = any (string_to_array((select value from app_settings where key = 'invoice.approver_roles'), ','))) then
    return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED', 'detail', format('%s (%s) may not approve invoices', v_emp.employee_code, v_emp.role));
  end if;
  select * into v_ap from approvals where approval_number = p_approval and action_type = 'CREATE_INVOICE';
  if v_ap.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  select * into p from projects where id = v_ap.entity_id for update;          -- the same lock the Airtable path takes
  select * into v_ap from approvals where id = v_ap.id for update;
  if v_ap.status <> 'PENDING' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_PROCESSED', 'detail', format('%s is %s', v_ap.approval_number, v_ap.status));
  end if;
  if p_payload_hash is distinct from v_ap.payload_hash then
    return jsonb_build_object('ok', false, 'code', 'PREVIEW_CHANGED', 'detail', 'the preview changed since you opened it; reload and check it again');
  end if;
  if p_decision = 'approve' then
    -- Two people, both proven: the requester must be a signed-in employee too (prepared in the dashboard). A preview from
    -- Airtable names the shared account's identity (or nobody), which proves no individual.
    if v_ap.requested_by_employee_id is null or v_ap.idempotency_key not like 'approval:dashboard:%' then
      return jsonb_build_object('ok', false, 'code', 'REQUESTER_UNKNOWN',
        'detail', 'it was not prepared by a signed-in person (it came from the shared Airtable account), so two people cannot be proven. Reject it here and prepare it again from the dashboard (or approve it in Airtable)');
    end if;
    if v_ap.requested_by_employee_id = v_emp.id then
      return jsonb_build_object('ok', false, 'code', 'SAME_PERSON', 'detail', 'you prepared it, so someone else must approve it');
    end if;
  end if;
  v_event := 'dashboard:decide:' || v_ap.approval_number || ':' || gen_random_uuid();
  v_res := wf_invoice_decide_core(jsonb_build_object('event_id', v_event, 'correlation_id', v_event,
             'event_type', case p_decision when 'approve' then 'invoice.approved' else 'invoice.rejected' end,
             'source', 'roofops-dashboard', 'actor_id', v_emp.employee_code, 'actor_name', v_emp.full_name, 'occurred_at', now(),
             'payload', jsonb_build_object('project_number', p.project_number, 'approval_number', v_ap.approval_number,
                                           'payload_hash', v_ap.payload_hash, 'reason', v_note)),
           'dashboard:' || v_emp.employee_code, v_emp.id);
  if v_res ->> 'outcome' = 'APPROVED' then
    select * into o from outbox where idempotency_key = v_res ->> 'xero_key';
    select * into i from invoices where id = o.aggregate_id;
    insert into xero_dispatch_requests (invoice_id, generation, xero_key, payload_sha256, requested_by, reason)
    values (i.id, o.generation, o.idempotency_key, xero_payload_sha256(o.payload), v_emp.id, 'approved in the dashboard by ' || v_emp.employee_code)
    on conflict do nothing;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
    values ('USER', v_emp.employee_code, 'xero.dispatch_requested', 'invoice', i.id, i.invoice_number,
            jsonb_build_object('generation', o.generation, 'xero_key', o.idempotency_key), 'Approved in the dashboard: create the Xero draft');
  end if;
  return v_res || jsonb_build_object('ok', v_res ->> 'outcome' in ('APPROVED', 'REJECTED_BY_APPROVER'),
    'invoice_number', (select invoice_number from invoices where approval_id = v_ap.id));
end $$;

-- 6. Ask for one exact write to be sent (a retry, or a reissue's replacement), as Finance/Admin.
create or replace function web_xero_dispatch_request(p_token text, p_invoice text, p_generation int, p_payload_sha256 text)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare v_emp employees := staff_session_employee(p_token); v_problem jsonb; i invoices; o outbox; r xero_dispatch_requests;
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT'); end if;
  if not (v_emp.role = any (string_to_array((select value from app_settings where key = 'xero.dispatch_roles'), ','))) then
    return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED', 'detail', format('%s (%s) may not send invoices to Xero', v_emp.employee_code, v_emp.role));
  end if;
  if coalesce(p_payload_sha256, '') = '' then return jsonb_build_object('ok', false, 'code', 'CHECK_REQUIRED', 'detail', 'open the draft and check it first'); end if;
  perform xero_dispatch_settle_claims();
  select * into i from invoices where invoice_number = p_invoice for update;
  v_problem := xero_dispatch_problem(p_invoice, p_generation, p_payload_sha256);
  if v_problem is not null then return jsonb_build_object('ok', false) || v_problem; end if;
  select * into o from outbox where idempotency_key = xero_draft_outbox_key(i.id, p_generation);
  insert into xero_dispatch_requests (invoice_id, generation, xero_key, payload_sha256, requested_by, reason)
  values (i.id, p_generation, o.idempotency_key, p_payload_sha256, v_emp.id,
          case when o.attempts > 0 then 'retry requested by ' else 'requested by ' end || v_emp.employee_code)
  on conflict do nothing returning * into r;
  if r.id is null then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_QUEUED', 'detail', 'it is already waiting to be sent');
  end if;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
  values ('USER', v_emp.employee_code, 'xero.dispatch_requested', 'invoice', i.id, i.invoice_number,
          jsonb_build_object('generation', p_generation, 'xero_key', o.idempotency_key), r.reason);
  return jsonb_build_object('ok', true, 'code', 'QUEUED', 'invoice_number', i.invoice_number, 'generation', p_generation);
end $$;

-- 7. n8n 09 (every minute): the next request, re-checked now; at most one write, which 05 then claims and re-proves.
create or replace function wf_xero_dispatch_next(p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r xero_dispatch_requests; i invoices; o outbox; v_problem jsonb; v_refused jsonb := '[]'::jsonb;
begin
  perform xero_dispatch_settle_claims();
  for n in 1..5 loop
    select * into r from xero_dispatch_requests where status = 'QUEUED' order by requested_at for update skip locked limit 1;
    if r.id is null then exit; end if;
    select * into i from invoices where id = r.invoice_id;
    v_problem := xero_dispatch_problem(i.invoice_number, r.generation, r.payload_sha256);
    if v_problem is not null then
      update xero_dispatch_requests set status = 'REFUSED', closed_reason = v_problem ->> 'detail' where id = r.id;
      v_refused := v_refused || jsonb_build_array(jsonb_build_object('invoice_number', i.invoice_number, 'code', v_problem ->> 'code'));
      r := null;
      continue;
    end if;
    select * into o from outbox where idempotency_key = r.xero_key;
    update xero_dispatch_requests set status = 'CLAIMED', claimed_by = p_worker, claimed_at = now(), attempts_at_claim = o.attempts where id = r.id;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
    values ('SYSTEM', p_worker, 'xero.dispatch_started', 'invoice', i.id, i.invoice_number,
            jsonb_build_object('generation', r.generation, 'xero_key', r.xero_key), 'Staff request handed to 05');
    return jsonb_build_object('ok', true, 'refused', v_refused,
      'writes', jsonb_build_array(jsonb_build_object('xero_key', r.xero_key, 'invoice_number', i.invoice_number, 'generation', r.generation, 'request_id', r.id)));
  end loop;
  return jsonb_build_object('ok', true, 'refused', v_refused, 'writes', '[]'::jsonb);
end $$;

revoke execute on all functions in schema public from public;
revoke execute on function wf_invoice_decide_core(jsonb, text, uuid), xero_dispatch_problem(text, int, text), xero_draft_progress(uuid),
  xero_dispatch_settle_claims(), xero_payload_sha256(jsonb) from roofops_workflow, roofops_dashboard;
grant execute on function web_invoice_overview(text), web_invoice_prepare(text, text), web_invoice_decide(text, text, text, text, text),
  web_xero_dispatch_request(text, text, int, text) to roofops_dashboard;
grant execute on function wf_xero_dispatch_next(text) to roofops_workflow;

-- 8. Where an exception came from, for staff (no payload): the event's source and type, and the Airtable record and the
--    quote or project it named, when the event carried them. Lets a person find the record to fix without SQL.
create view v_dashboard_exception_sources as
select x.exception_number, e.source, e.event_type, e.occurred_at,
       nullif(coalesce(e.payload -> 'payload' ->> 'airtable_record_id', e.payload ->> 'airtable_record_id'), '') as airtable_record_id,
       nullif(coalesce(e.payload -> 'payload' ->> 'quote_id', e.payload -> 'payload' ->> 'project_number'), '') as named_record
  from workflow_exceptions x join automation_events e on e.event_id = x.event_id;
grant select on v_dashboard_exception_sources to roofops_dashboard;
