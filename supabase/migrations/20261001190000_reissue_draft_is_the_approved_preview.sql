-- AC-14C hardening, audit P2-H2 (docs/defect-ledger.md): generation 2's Xero draft payload was copied from the previous
-- generation's outbox payload; the approved reissue preview contributed only a hash. A canonical change after generation 1
-- (a corrected line, a customer's contact details) was then either refused for an unrelated reason or, if it was not on
-- the invoice row (the contact), not detected at all - and the stale copied values would have been written to Xero.
--
-- One deterministic builder, xero_draft_payload(invoice, tenant), generates every Xero-facing value from canonical
-- truth (invoice, lines, customer, project, settings, the bound tenant). Generation 1 uses it (and refuses if it ever
-- disagrees with the approved preview); the reissue preview embeds it as 'draft' (covered by the approval's hash); and
-- ops_reissue_decide queues exactly that approved draft plus generation metadata. The H1 guard and integrity check also
-- require the queued generation-2 payload to contain the approved draft under the approval's hash.

-- 1. The one canonical draft builder (owner-only, like the rest of the Xero surface).
create or replace function xero_draft_payload(p_invoice uuid, p_tenant text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'invoice_id', i.id, 'invoice_number', i.invoice_number,
    'project_id', p.id, 'project_number', p.project_number, 'reference', p.project_number,
    'project_airtable_record_id', (select l.external_id from external_links l where l.provider = 'AIRTABLE' and l.entity_type = 'project'
                                     and l.entity_id = p.id and l.verified_at is not null),
    'customer_id', c.id, 'customer_number', c.customer_number, 'customer_name', btrim(c.display_name), 'customer_email', c.email,
    'xero_contact_number', (select value from app_settings where key = 'xero.contact_number_prefix') || c.customer_number,
    'xero_contact_name', btrim(c.display_name) || ' [' || c.customer_number || ']',
    'xero_invoice_number_prefix', (select value from app_settings where key = 'xero.invoice_number_prefix'),
    'xero_invoice_number', (select value from app_settings where key = 'xero.invoice_number_prefix') || i.invoice_number,
    'invoice_date', i.issue_date, 'due_date', i.due_date,
    'currency', 'AUD', 'line_amount_type', i.line_amount_type,
    'amount_inc_gst', i.total_inc_gst, 'gst_amount', i.gst_amount, 'amount_ex_gst', i.subtotal_ex_gst,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'description', l.description, 'quantity', trim_scale(l.quantity),
                                                           'unit_amount', l.unit_price, 'variation_id', l.variation_id) order by l.line_no)
                         from invoice_lines l where l.invoice_id = i.id), '[]'::jsonb),
    'xero_account_code', coalesce((select min(l.account_code) from invoice_lines l where l.invoice_id = i.id),
                                  (select value from app_settings where key = 'xero.sales_account_code')),
    'xero_tax_type', (select value from app_settings where key = 'xero.sales_tax_type'),
    'xero_tenant_id', p_tenant, 'xero_tenant_name', (select value from app_settings where key = 'xero.demo_tenant_name'))
  from invoices i join projects p on p.id = i.project_id join customers c on c.id = i.customer_id
  where i.id = p_invoice
$$;

-- 2. create or replace function wf_invoice_decide_core(p_event jsonb, p_worker text default 'n8n')
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

-- 3. create or replace function invoice_reissue_preview(p_invoice uuid, p_reason text default null)
create or replace function invoice_reissue_preview(p_invoice uuid, p_reason text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  i invoices; p projects; v_link text; v_bound text; v_obs xero_invoice_observations; v_gen int;
begin
  select * into i from invoices where id = p_invoice;
  if i.id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', coalesce(p_invoice::text, 'no invoice') || ' does not exist');
  end if;
  select * into p from projects where id = i.project_id;
  v_link := (select l.external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice'
               and l.entity_type = 'invoice' and l.entity_id = i.id);
  v_bound := (select o.payload ->> 'xero_tenant_id' from outbox_current('xero.create_draft_invoice', i.id) o);
  select * into v_obs from xero_invoice_observations x
   where x.invoice_id = i.id and x.xero_invoice_id is not distinct from v_link and x.verdict = 'VERIFIED'
     and x.settlement in ('VOIDED', 'DELETED')
   order by x.observed_at desc, x.id desc limit 1;
  v_gen := invoice_reissue_generation(i.id);
  return jsonb_build_object('ok', true, 'preview', jsonb_build_object(
    'invoice_id', i.id, 'invoice_number', i.invoice_number,
    'xero_invoice_number', coalesce((select o.payload ->> 'xero_invoice_number' from outbox_current('xero.create_draft_invoice', i.id) o), ''),
    'invoice_type', i.invoice_type, 'record_origin', i.record_origin,
    'invoice_status', i.status, 'invoice_sync_status', i.sync_status, 'voided_reason', i.voided_reason,
    'invoice_record_version', i.record_version,
    'project_id', i.project_id, 'project_number', p.project_number, 'project_status', p.status,
    'total_inc_gst', i.total_inc_gst, 'gst_amount', i.gst_amount,
    'line_count', (select count(*) from invoice_lines l where l.invoice_id = i.id),
    'lines_hash', (select md5(coalesce(string_agg(l.line_no::text || '|' || l.description || '|' || l.quantity::text || '|' || l.unit_price::text,
                                                E'\n' order by l.line_no), '')) from invoice_lines l where l.invoice_id = i.id),
    'linked_xero_invoice_id', v_link,
    'void_evidence', case when v_obs.id is null then null else jsonb_build_object(
      'observation_id', v_obs.id, 'settlement', v_obs.settlement, 'tenant_id', v_obs.tenant_id,
      'observed_at', to_char(v_obs.observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'run_id', v_obs.run_id) end,
    'current_generation', v_gen, 'target_generation', v_gen + 1,
    'tenant', jsonb_build_object('tenant_id', v_bound, 'tenant_name', (select value from app_settings where key = 'xero.demo_tenant_name')),
    'requested_reason', btrim(coalesce(p_reason, '')),
    -- P2-H2: the exact Xero draft the reissue will queue, generated from canonical truth now (not copied from the
    -- previous generation); the approval's hash covers it, so what is approved is what is written.
    'draft', xero_draft_payload(i.id, v_bound)));
end $$;

-- 4. create or replace function ops_reissue_decide(p_approval_number text, p_employee_code text, p_note text default null)
create or replace function ops_reissue_decide(p_approval_number text, p_employee_code text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_emp employees; v_ap approvals; i invoices; v_check jsonb; v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_key text; v_claimed boolean; v_pe processed_events; v_event uuid; v_preview jsonb; v_hash text;
  v_gen int; v_draft jsonb; v_corr uuid; v_okey text; v_code text; v_detail text; v_res jsonb; v_reason text;
begin
  select * into v_emp from employees where employee_code = p_employee_code;
  if v_emp.id is null or not v_emp.is_active
     or not (v_emp.role = any (string_to_array((select value from app_settings where key = 'invoice.reissue_roles'), ','))) then
    return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED',
      'detail', format('%s is not an active RoofOps employee in a role that may reissue a final invoice (%s)',
        coalesce(nullif(p_employee_code, ''), 'no employee code'), coalesce((select value from app_settings where key = 'invoice.reissue_roles'), 'no roles configured')));
  end if;
  -- Row lock: concurrent decisions on one approval serialise here, and the loser sees the committed status below.
  select * into v_ap from approvals where approval_number = p_approval_number for update;
  if v_ap.id is null or v_ap.action_type <> 'REISSUE_INVOICE' then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND',
      'detail', coalesce(nullif(p_approval_number, ''), 'no approval number') || ' is not a reissue request');
  end if;
  -- Consumption guard: one decision per approval, however many times it is delivered.
  v_key := v_ap.approval_number;
  v_event := wf_log_event('invoice.reissue:' || v_ap.approval_number, stable_uuid('correlation', 'invoice.reissue:' || v_ap.approval_number), null,
    'invoice.reissue_decided', 'invoice', v_ap.entity_id, v_ap.approval_number, 'USER', v_emp.employee_code, 'ops', 'INFO', null,
    jsonb_build_object('approval_number', v_ap.approval_number, 'note', v_note), null);
  insert into processed_events (consumer, idempotency_key, first_event_id, request_hash, status, locked_by, lease_expires_at)
  values ('invoice.reissue:' || v_ap.approval_number, v_key, v_event, md5(v_ap.payload_hash), 'PROCESSING', 'ops_reissue_decide', now() + interval '5 minutes')
  on conflict do nothing returning true into v_claimed;
  if v_claimed is null then
    select * into v_pe from processed_events where consumer = 'invoice.reissue:' || v_ap.approval_number and idempotency_key = v_key for update;
    update processed_events set delivery_count = delivery_count + 1, last_seen_at = now() where consumer = v_pe.consumer and idempotency_key = v_key;
    return coalesce(v_pe.result, '{}'::jsonb) || jsonb_build_object('ok', false, 'code', 'ALREADY_PROCESSED', 'duplicate', true,
      'delivery_count', v_pe.delivery_count + 1,
      'detail', format('%s was already decided; nothing was created', v_ap.approval_number));
  end if;
  -- The full battery again (state, money, void proof, write state) - the request's evidence is re-verified, not trusted.
  v_check := invoice_reissue_check(v_ap.entity_id);
  if not (v_check ->> 'ok')::boolean then
    delete from processed_events where consumer = 'invoice.reissue:' || v_ap.approval_number and idempotency_key = v_key;
    return v_check || jsonb_build_object('approval_number', v_ap.approval_number);
  end if;
  if v_ap.status <> 'PENDING' then
    delete from processed_events where consumer = 'invoice.reissue:' || v_ap.approval_number and idempotency_key = v_key;
    return jsonb_build_object('ok', false, 'code', 'APPROVAL_NOT_PENDING', 'approval_number', v_ap.approval_number,
      'detail', format('%s is %s; only a PENDING request can be decided', v_ap.approval_number, v_ap.status));
  end if;
  if v_ap.expires_at <= now() then
    update approvals set status = 'EXPIRED' where id = v_ap.id;
    delete from processed_events where consumer = 'invoice.reissue:' || v_ap.approval_number and idempotency_key = v_key;
    return jsonb_build_object('ok', false, 'code', 'APPROVAL_EXPIRED', 'approval_number', v_ap.approval_number,
      'detail', format('%s expired at %s; request a fresh reissue', v_ap.approval_number, v_ap.expires_at));
  end if;
  -- Drift: generation, then record version, then preview hash (the hash covers the generation).
  select * into i from invoices where id = v_ap.entity_id;
  v_gen := (v_check ->> 'current_generation')::int;
  v_preview := invoice_reissue_preview(i.id, v_ap.action_payload ->> 'requested_reason') -> 'preview';
  v_hash := invoice_reissue_preview_hash(v_preview);
  if v_ap.action_payload ->> 'target_generation' is distinct from (v_gen + 1)::text then
    v_code := 'GENERATION_CHANGED';
    v_detail := format('%s was requested for generation %s but the current generation of %s is %s', v_ap.approval_number, v_ap.action_payload ->> 'target_generation', i.invoice_number, v_gen);
  elsif v_ap.expected_record_version is distinct from i.record_version then
    v_code := 'RECORD_VERSION_CHANGED';
    v_detail := format('%s was bound to %s record version %s but it is now %s; request a fresh reissue', v_ap.approval_number, i.invoice_number, v_ap.expected_record_version, i.record_version);
  elsif v_hash is distinct from v_ap.payload_hash then
    v_code := 'PREVIEW_CHANGED';
    v_detail := format('%s is stale: %s changed since the request (hash %s, now %s); request a fresh reissue', v_ap.approval_number, i.invoice_number, v_ap.payload_hash, v_hash);
  end if;
  -- P2-H2: the replacement keeps the Xero document's identity (same invoice number) - the draft must agree with it.
  v_draft := v_preview -> 'draft';
  if v_code is null and (v_draft is null or v_draft ->> 'xero_invoice_number' is distinct from v_preview ->> 'xero_invoice_number') then
    v_code := 'INVOICE_NUMBER_CHANGED';
    v_detail := format('%s: the canonical Xero invoice number %s differs from the generation being replaced (%s); a person must decide', v_ap.approval_number,
      coalesce(v_draft ->> 'xero_invoice_number', 'none'), coalesce(v_preview ->> 'xero_invoice_number', 'none'));
  end if;
  if v_code is not null then
    update approvals set status = 'CANCELLED', decision_reason = v_detail where id = v_ap.id;
    delete from processed_events where consumer = 'invoice.reissue:' || v_ap.approval_number and idempotency_key = v_key;
    return jsonb_build_object('ok', false, 'code', v_code, 'approval_number', v_ap.approval_number, 'detail', v_detail);
  end if;
  -- From here the act is committed as one transaction. The approval moves to EXECUTING first (the guard accepts it),
  -- then to EXECUTED at the end with the generation it queued.
  update approvals set status = 'EXECUTING', decided_by = v_emp.id, decided_at = now(), decision_reason = v_note where id = v_ap.id;
  v_reason := v_ap.action_payload ->> 'requested_reason';
  v_okey := xero_draft_outbox_key(i.id, v_gen + 1);
  select o.correlation_id into v_corr from outbox_current('xero.create_draft_invoice', i.id) o;
  -- a. supersede the current generation (history: the row, its Xero InvoiceID and its keys stay).
  update invoice_xero_draft_generations
     set status = 'SUPERSEDED', superseded_at = now(), updated_at = now(),
         superseded_reason = coalesce(v_note || ' | ', '') || 'Reissue ' || v_ap.approval_number || ' by ' || v_emp.employee_code || ': ' || v_reason
   where invoice_id = i.id and superseded_at is null;
  -- b. open the new generation row (before its write, so the ledger never lags the outbox).
  insert into invoice_xero_draft_generations (invoice_id, generation, status, outbox_idempotency_key, xero_invoice_number, tenant_id, approval_id, opened_by)
  values (i.id, v_gen + 1, 'PENDING', v_okey, v_draft ->> 'xero_invoice_number',
          v_check ->> 'bound_tenant_id', v_ap.id, 'operator:' || v_emp.employee_code);
  -- c. queue exactly one new draft write, with new keys (generation >= 2) and the same bound tenant.
  insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, generation)
  values ('xero.create_draft_invoice', 'invoice', i.id, v_corr, v_okey,
          v_draft || jsonb_build_object(
            'generation', v_gen + 1, 'xero_idempotency_key', xero_draft_provider_key(i.id, v_gen + 1),
            'approval_number', v_ap.approval_number, 'approved_by', v_emp.full_name, 'opened_by', 'operator:' || v_emp.employee_code,
            'reissued_from_generation', v_gen, 'reissued_by', v_emp.employee_code, 'reissue_reason', v_reason,
            'reissue_preview_hash', v_hash), v_gen + 1);
  -- d. the invoice, in a single statement: VOIDED -> APPROVED and SYNCED -> PENDING, bound to the reissue approval.
  update invoices set status = 'APPROVED', sync_status = 'PENDING', approval_id = v_ap.id where id = i.id;
  -- e. the approval executed, with the generation it queued.
  update approvals set status = 'EXECUTED', executed_at = now(),
         execution_result = jsonb_build_object('outcome', 'REISSUE_QUEUED', 'invoice_id', i.id, 'invoice_number', i.invoice_number,
           'generation', v_gen + 1, 'superseded_generation', v_gen, 'outbox_idempotency_key', v_okey, 'decided_by', v_emp.employee_code)
   where id = v_ap.id;
  -- f. one audit event for the whole act.
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
  values ('USER', v_emp.employee_code, 'invoice.reissued', 'invoice', i.id, i.invoice_number,
          jsonb_build_object('status', 'VOIDED', 'sync_status', i.sync_status, 'generation', v_gen,
            'superseded_xero_invoice_id', (select g.xero_invoice_id from invoice_xero_draft_generations g where g.invoice_id = i.id and g.generation = v_gen),
            'void_observation_id', v_check ->> 'void_observation_id', 'void_settlement', v_check ->> 'void_settlement'),
          jsonb_build_object('status', 'APPROVED', 'sync_status', 'PENDING', 'generation', v_gen + 1, 'approval_number', v_ap.approval_number,
            'outbox_idempotency_key', v_okey, 'payload_hash', v_ap.payload_hash, 'bound_tenant_id', v_check ->> 'bound_tenant_id'),
          coalesce(v_note || ' | ', '') || v_reason);
  v_res := jsonb_build_object('ok', true, 'code', 'REISSUE_QUEUED', 'approval_number', v_ap.approval_number,
    'invoice_id', i.id, 'invoice_number', i.invoice_number, 'generation', v_gen + 1, 'superseded_generation', v_gen,
    'outbox_idempotency_key', v_okey, 'xero_idempotency_key', xero_draft_provider_key(i.id, v_gen + 1),
    'detail', format('%s: %s queued generation %s for %s (superseded generation %s, Xero invoice %s)',
      v_ap.approval_number, v_okey, v_gen + 1, i.invoice_number, v_gen, coalesce(v_check ->> 'linked_xero_invoice_id', 'none')));
  update processed_events set status = 'COMPLETED', completed_at = now(), result = v_res, lease_expires_at = null
   where consumer = 'invoice.reissue:' || v_ap.approval_number and idempotency_key = v_key;
  return v_res;
end $$;

-- 5. create or replace function invoice_reissue_guard()
create or replace function invoice_reissue_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a approvals; v_bound text; v_link text; v_obs xero_invoice_observations; v_target int; v_bound_ok boolean;
begin
  select * into a from approvals where id = new.approval_id;
  -- First the evidence (unchanged): a matching reissue approval that is live, the void proof, no money moved, no live
  -- write of an older generation. Then (audit P2-H1) the binding: only the ops_reissue_decide transaction itself.
  if a.id is null or a.action_type <> 'REISSUE_INVOICE' or a.entity_type <> 'invoice' or a.entity_id <> new.id
     or not (a.status in ('APPROVED', 'EXECUTING') or (a.status = 'PENDING' and a.expires_at > now())) then
    raise exception 'invoice % cannot go back to APPROVED without a matching REISSUE_INVOICE approval attached (a supervised reissue decides that, not raw SQL; only ops_reissue_decide may make this transition)',
      new.invoice_number using errcode = 'check_violation';
  end if;
  v_bound := (select o.payload ->> 'xero_tenant_id' from outbox_current('xero.create_draft_invoice', new.id) o);
  v_link := (select l.external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice'
               and l.entity_type = 'invoice' and l.entity_id = new.id);
  select * into v_obs from xero_invoice_observations x
   where x.invoice_id = new.id and x.xero_invoice_id is not distinct from v_link and x.verdict = 'VERIFIED'
   order by x.observed_at desc, x.id desc limit 1;
  if v_obs.id is null or v_obs.settlement not in ('VOIDED', 'DELETED') or v_obs.tenant_id is distinct from v_bound then
    raise exception 'invoice % cannot go back to APPROVED without a verified void or deletion of its linked Xero invoice % in the bound tenant % (the last verified read is %); raw SQL is not a recovery path',
      new.invoice_number, coalesce(v_link, '(none)'), coalesce(v_bound, '(none)'), coalesce(v_obs.settlement || ' in ' || v_obs.tenant_id, 'none')
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from payments where invoice_id = new.id)
     or exists (select 1 from xero_invoice_observations x where x.invoice_id = new.id and x.verdict = 'VERIFIED'
                  and (coalesce(x.amount_paid, 0) > 0 or coalesce(x.amount_credited, 0) > 0)) then
    raise exception 'invoice % cannot go back to APPROVED: money moved on it (a payment or a credit exists); a person must check the customer account',
      new.invoice_number using errcode = 'check_violation';
  end if;
  -- The reissue opens exactly one new generation in this transaction; that write is the guard's own target (the newest
  -- generation row). A live write of an older generation is still a refusal.
  v_target := (select max(g.generation) from invoice_xero_draft_generations g where g.invoice_id = new.id);
  if exists (select 1 from outbox o where o.topic = 'xero.create_draft_invoice' and o.aggregate_id = new.id
               and (o.status in ('PENDING', 'DISPATCHING') or (o.status = 'FAILED' and o.next_attempt_at <> 'infinity'))
               and o.generation is distinct from v_target) then
    raise exception 'invoice % cannot go back to APPROVED while an older generation''s Xero draft write is still live (target generation %); let it finish or fail first',
      new.invoice_number, coalesce(v_target::text, 'none') using errcode = 'check_violation';
  end if;
  -- P2-H1: a valid request (even a fresh PENDING one) is evidence, not the act. The act is ops_reissue_decide's own
  -- transaction, and only it leaves this exact state behind before its invoice update: the approval EXECUTING and its
  -- one-time consumption claim still PROCESSING, the previous generation SUPERSEDED, and the next generation's ledger
  -- row PENDING with its draft write PENDING, both bound to this approval. Anything else (raw SQL with a pending,
  -- approved, executed or forged approval) is refused, so the transition cannot happen without the replacement.
  v_bound_ok := a.status = 'EXECUTING' and v_target >= 2
    and exists (select 1 from processed_events pe where pe.consumer = 'invoice.reissue:' || a.approval_number
                   and pe.idempotency_key = a.approval_number and pe.status = 'PROCESSING')
    and exists (select 1 from invoice_xero_draft_generations g where g.invoice_id = new.id and g.generation = v_target
                   and g.approval_id = a.id and g.superseded_at is null and g.status = 'PENDING'
                   and g.outbox_idempotency_key = xero_draft_outbox_key(new.id, v_target))
    and exists (select 1 from invoice_xero_draft_generations g where g.invoice_id = new.id and g.generation = v_target - 1 and g.superseded_at is not null)
    and exists (select 1 from outbox o where o.topic = 'xero.create_draft_invoice' and o.aggregate_id = new.id and o.generation = v_target
                   and o.idempotency_key = xero_draft_outbox_key(new.id, v_target) and o.status = 'PENDING'
                   and o.payload ->> 'approval_number' = a.approval_number
                   and o.payload @> (a.action_payload -> 'draft') and o.payload ->> 'reissue_preview_hash' = a.payload_hash);
  if not coalesce(v_bound_ok, false) then
    raise exception 'invoice % cannot go back to APPROVED here: only ops_reissue_decide may make this transition (approval % is %, and generation % must be queued and bound to it in the same decision)',
      new.invoice_number, a.approval_number, a.status, coalesce((v_target + case when a.status = 'EXECUTING' then 0 else 1 end)::text, '2')
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- 6. create or replace function integrity_check()
create or replace function integrity_check()
returns table (entity text, check_key text, status text, failing int, detail text, refs text[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_refs text[];
begin
  return query select c.* from integrity_check_core() c where c.check_key not in ('done_has_proof', 'xero_link_only_when_synced');
  -- P2-H1: an invoice brought back from VOIDED on a reissue approval carries the generation that approval queued.
  select array_agg(i.invoice_number || ' (' || a.approval_number || ' ' || lower(a.status) || ')' order by i.invoice_number) into v_refs
    from invoices i join approvals a on a.id = i.approval_id and a.action_type = 'REISSUE_INVOICE'
   where i.status <> 'VOIDED'
     and not (a.status = 'EXECUTED'
              and exists (select 1 from invoice_xero_draft_generations g join outbox o on o.idempotency_key = g.outbox_idempotency_key
                           where g.invoice_id = i.id and g.approval_id = a.id and g.generation >= 2
                             and o.topic = 'xero.create_draft_invoice' and o.aggregate_id = i.id and o.generation = g.generation
                             and o.payload ->> 'approval_number' = a.approval_number
                             and o.payload @> (a.action_payload -> 'draft') and o.payload ->> 'reissue_preview_hash' = a.payload_hash));
  entity := 'invoice'; check_key := 'reissue_transition_bound';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'An invoice reissued from VOIDED is bound to an executed reissue approval and the generation it queued, whose payload is exactly the approved draft (only ops_reissue_decide reissues)'; return next;
  select array_agg(i.invoice_number order by i.invoice_number) into v_refs from invoices i
    left join outbox o on o.topic = 'xero.create_draft_invoice' and o.aggregate_id = i.id
   where i.status = 'VOIDED' and i.record_origin = 'ROOFOPS'
     and (i.sync_status in ('PENDING', 'UNKNOWN', 'SYNCED') or o.status in ('DISPATCHING', 'DONE')
          or exists (select 1 from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id))
     and not exists (select 1 from xero_invoice_observations x
                      where x.invoice_id = i.id and x.verdict = 'VERIFIED' and x.settlement in ('VOIDED', 'DELETED')
                        and x.tenant_id = o.payload ->> 'xero_tenant_id'
                        and x.xero_invoice_id = (select l.external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id)
                        and not exists (select 1 from xero_invoice_observations y
                                         where y.invoice_id = x.invoice_id and y.verdict = 'VERIFIED' and y.xero_invoice_id = x.xero_invoice_id
                                           and y.settlement not in ('VOIDED', 'DELETED') and (y.observed_at, y.id) > (x.observed_at, x.id)));
  entity := 'invoice'; check_key := 'voided_invoice_has_no_xero_write';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'No Xero draft is created, pending, ambiguous or linked for a voided invoice, unless the exact linked Xero invoice was verified VOIDED or DELETED in the tenant its write is bound to'; return next;
  -- AC-09: once a final invoice exists, everything validly billed equals the entitlement (short = under-billed).
  select array_agg(x.project_number || ' (' || (x.b ->> 'remaining') || ' left)' order by x.project_number) into v_refs
    from (select p.project_number, project_billing(p.id) b from projects p
           where exists (select 1 from invoices i where i.project_id = p.id and i.invoice_type = 'FINAL' and i.status not in ('VOIDED', 'DRAFT', 'PENDING_APPROVAL'))) x
   where (x.b ->> 'remaining')::numeric > 0;
  entity := 'invoice'; check_key := 'final_invoice_settles_entitlement';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'After the final invoice, quote + approved/invoiced variations - everything billed = 0 (left over means under-billed; a variation approved later needs its own invoice)'; return next;
  -- AC-13A: a CLOSED project is settled: nothing left to bill, nothing over-billed, everything paid, completion gate satisfied.
  select array_agg(p.project_number order by p.project_number) into v_refs from projects p
   where p.status = 'CLOSED' and ((project_billing(p.id) ->> 'remaining')::numeric <> 0
      or exists (select 1 from invoices i where i.project_id = p.id and not (invoice_financial_state(i.id, false) ->> 'settled')::boolean)
      or exists (select 1 from v_projects_missing_completion_docs v where v.id = p.id));
  entity := 'project'; check_key := 'closed_project_settled';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Closed projects have nothing left to bill, nothing over-billed, every invoice paid or voided, and their completion items done or waived'; return next;
  -- AC-13A: completed jobs held only by open completion items (staff set them in Airtable: Completion Photos / Compliance Certificate).
  select array_agg(x.project_number || ' (' || x.items || ')' order by x.project_number) into v_refs
    from (select v.project_number, string_agg(v.label, ', ' order by v.label) items from v_projects_missing_completion_docs v join projects p on p.id = v.id
           where p.status = 'COMPLETED' group by v.project_number) x;
  entity := 'project'; check_key := 'completed_awaiting_completion_items';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Completed jobs whose completion items are still To do in Airtable (Completion Photos / Compliance Certificate); no final invoice until they are Done, Waived or Not applicable'; return next;
  -- AC-14: every Xero-linked invoice was last read successfully, and RoofOps shows the state Xero verified.
  select array_agg(i.invoice_number || ' (' || case when x.id is null then 'never read from Xero'
                                                   when x.verdict <> 'VERIFIED' then 'last Xero check: ' || lower(replace(x.verdict, '_', ' '))
                                                   else 'Xero ' || lower(replace(x.settlement, '_', ' ')) || ', RoofOps ' || lower(i.status) end || ')' order by i.invoice_number) into v_refs
    from invoices i join external_links l on l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id and l.verified_at is not null
    left join lateral (select * from xero_invoice_observations o where o.invoice_id = i.id and o.xero_invoice_id = l.external_id
                        order by o.observed_at desc, o.id desc limit 1) x on true
   where i.sync_status = 'SYNCED' and (x.id is null or x.verdict <> 'VERIFIED' or i.status is distinct from xero_settlement_status(x.settlement));
  entity := 'invoice'; check_key := 'xero_invoice_state_verified';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every Xero-linked invoice was last read from its own Xero tenant and RoofOps shows the state Xero verified (a repair run applies it)'; return next;
  -- AC-04, generation-aware (see above): the link must match the invoice's sync state, except that a superseded
  -- generation's document may stay linked while its replacement is queued - that link is history.
  select array_agg(i.invoice_number order by i.invoice_number) into v_refs
    from invoices i join external_links l on l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id
   where i.sync_status <> 'SYNCED'
     and not exists (select 1 from invoice_xero_draft_generations g
                      where g.invoice_id = i.id and g.superseded_at is not null and g.xero_invoice_id = l.external_id);
  entity := 'invoice'; check_key := 'xero_link_only_when_synced';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'No Xero link on an invoice RoofOps does not consider synced (the document of a superseded generation is history, not the current link)'; return next;
  -- done_has_proof, generation-aware (see above): the same rule for every topic, except that only the CURRENT draft
  -- write of an invoice must match its sync_status; an earlier DONE generation is history.
  select array_agg(o.topic || ':' || o.aggregate_id) into v_refs from outbox o
   where o.status = 'DONE' and not case o.topic
     when 'drive.ensure_project_folder' then exists (select 1 from external_links l where l.provider = 'GOOGLE_DRIVE' and l.entity_type = 'project'
                                                       and l.external_type = 'Folder' and l.entity_id = o.aggregate_id and l.verified_at is not null)
     when 'airtable.project_writeback' then exists (select 1 from external_links l where l.provider = 'AIRTABLE' and l.entity_type = 'project'
                                                      and l.external_type = 'Record' and l.entity_id = o.aggregate_id and l.verified_at is not null)
     when 'xero.create_draft_invoice' then o.id <> (select c.id from outbox_current('xero.create_draft_invoice', o.aggregate_id) c)
                                          or exists (select 1 from invoices i where i.id = o.aggregate_id and i.sync_status = 'SYNCED')
     else true end;
  entity := 'side_effect'; check_key := 'done_has_proof';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every DONE side effect (Drive folder, Airtable write-back, Xero draft) has verified proof; for a Xero draft that means its CURRENT generation is the one that is DONE'; return next;
end $$;

revoke execute on all functions in schema public from public;
revoke execute on function xero_draft_payload(uuid, text) from roofops_workflow, roofops_dashboard;
revoke execute on function invoice_reissue_preview(uuid, text), ops_reissue_decide(text, text, text), invoice_reissue_guard() from roofops_workflow, roofops_dashboard;
grant execute on function integrity_check() to roofops_dashboard;
