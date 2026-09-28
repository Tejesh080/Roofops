-- =============================================================================
-- Phase 3: Approved project -> ONE real DRAFT invoice in the Xero Demo Company.
--
--   wf_invoice_prepare(event)   eligibility + deterministic amount + preview, stored as a PENDING
--                               approval with a payload hash. Never touches Xero.
--   wf_invoice_decide(event)    approve / reject by an authorised, mapped employee. Approve re-computes
--                               the preview (must hash-match), creates the RoofOps invoice (one FINAL
--                               per project, ever: UNIQUE idempotency_key) and queues ONE Xero side effect.
--   wf_complete_side_effect     + xero.create_draft_invoice: accepts only read-back proof from the pinned
--                               DEMO tenant (DRAFT, ACCREC, number, reference, contact, total, GST, one match).
--   wf_fail_side_effect         + invoice sync state (UNKNOWN while an ambiguous write is being reconciled).
--   wf_open_exception           workflow_key now follows the run (was hard-coded to quote_to_project).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Who may approve. Airtable users are mapped to employees; only these roles approve invoices.
-- ---------------------------------------------------------------------------
create table if not exists employee_external_identities (
  employee_id uuid not null references employees(id),
  provider    text not null check (provider in ('AIRTABLE')),
  external_id text not null,
  created_at  timestamptz not null default now(),
  primary key (provider, external_id)
);
alter table employee_external_identities enable row level security;
revoke all on employee_external_identities from public;

-- A demo approver identity (synthetic, clearly labelled) for the person operating the demo Airtable base.
insert into employees (employee_code, full_name, email, role)
select 'EMP-900', 'Demo Finance Approver', 'finance.approver@roofops.example.com', 'FINANCE'
where not exists (select 1 from employees where email = 'finance.approver@roofops.example.com');
insert into employee_external_identities (employee_id, provider, external_id)
select id, 'AIRTABLE', 'usr7uCnNO15fCefbH' from employees where email = 'finance.approver@roofops.example.com'
on conflict do nothing;

insert into app_settings (key, value) values
  ('wf.project_to_invoice.version', '1.0.0'),
  ('invoice.approver_roles', 'FINANCE,ADMIN,OPERATIONS_MANAGER'),
  ('invoice.approval_ttl_hours', '168'),
  ('invoice.payment_terms_days', '14'),
  ('xero.sales_account_code', '200'),
  ('xero.sales_tax_type', 'OUTPUT'),
  ('xero.invoice_number_prefix', 'RO-'),
  ('xero.contact_number_prefix', 'RO-'),
  ('xero.demo_tenant_id', ''),          -- pinned by ops AFTER the tenant is proven Class=DEMO; empty = no Xero writes
  ('xero.demo_tenant_name', '')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- wf_open_exception: workflow_key follows the run.
-- ---------------------------------------------------------------------------
create or replace function wf_open_exception(
  p_run uuid, p_event uuid, p_entity_type text, p_entity_id uuid, p_ref text, p_class text, p_message text, p_attempts int)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_num text;
begin
  select exception_number into v_num from workflow_exceptions
   where (p_run is not null and workflow_run_id = p_run and resolution_status in ('OPEN','RETRY_QUEUED'))
      or (p_run is null and event_id = p_event and resolution_status in ('OPEN','RETRY_QUEUED'))
   limit 1;
  if v_num is not null then
    update workflow_exceptions set attempt_count = greatest(attempt_count, p_attempts), last_attempt_at = now(),
           error_class = p_class, error_message = p_message
     where exception_number = v_num;
    return v_num;
  end if;
  v_num := next_friendly_id('EXC');
  insert into workflow_exceptions (exception_number, workflow_run_id, event_id, workflow_key, entity_type, entity_id,
    business_reference, error_class, error_message, retryable, attempt_count, first_failed_at, last_attempt_at)
  select v_num, p_run, p_event,
         coalesce((select workflow_key from workflow_runs where id = p_run),
                  case when p_entity_type in ('invoice', 'project_invoice') then 'project_to_invoice' else 'quote_to_project' end),
         p_entity_type, p_entity_id, p_ref, p_class, p_message, ec.retryable, p_attempts, now(), now()
  from error_classes ec where ec.code = p_class;
  return v_num;
end $$;

-- One open exception per rejected invoice request (same project, class, reason), as for quotes (ADR-026).
create or replace function wf_open_invoice_rejection(p_event uuid, p_project uuid, p_ref text, p_class text, p_message text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_num text;
begin
  perform pg_advisory_xact_lock(hashtext('invoice-rejection:' || coalesce(p_project::text, p_ref) || ':' || p_class));
  select exception_number into v_num from workflow_exceptions
   where workflow_key = 'project_to_invoice' and entity_type = 'project_invoice'
     and entity_id is not distinct from p_project and business_reference is not distinct from p_ref
     and error_class = p_class and error_message = p_message and resolution_status in ('OPEN', 'RETRY_QUEUED')
   order by first_failed_at limit 1;
  if v_num is not null then
    update workflow_exceptions set attempt_count = attempt_count + 1, last_attempt_at = now() where exception_number = v_num;
    return v_num;
  end if;
  return wf_open_exception(null, p_event, 'project_invoice', p_project, p_ref, p_class, p_message, 1);
end $$;

-- ---------------------------------------------------------------------------
-- invoice_final_preview: the deterministic final-invoice calculation. Pure read; no side effects.
--   amount = accepted quote total (inc GST) + APPROVED variations - everything already billed
--   billed = invoices in APPROVED / ISSUED / PARTIALLY_PAID / PAID (never DRAFT / VOIDED)
-- ---------------------------------------------------------------------------
create or replace function invoice_final_preview(p_project uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  p projects; c customers; pr properties; qv quote_versions; q quotes;
  v_billed numeric(12,2); v_var numeric(12,2); v_amount numeric(12,2); v_gst numeric(12,2);
  v_blocking text; v_billed_list jsonb; v_lines jsonb; v_rate numeric := 0.1;
  v_today date := app_today(); v_terms int := (select value::int from app_settings where key = 'invoice.payment_terms_days');
  v_inv_prefix text := (select value from app_settings where key = 'xero.invoice_number_prefix');
  v_con_prefix text := (select value from app_settings where key = 'xero.contact_number_prefix');
begin
  select * into p from projects where id = p_project;
  if not found then return jsonb_build_object('ok', false, 'error_class', 'NOT_FOUND', 'message', 'Project does not exist'); end if;
  if p.status <> 'COMPLETED' then
    return jsonb_build_object('ok', false, 'error_class', 'INVALID_STATE',
      'message', format('%s is %s; only a COMPLETED project can be final-invoiced', p.project_number, p.status));
  end if;
  if exists (select 1 from v_projects_missing_completion_docs v where v.id = p.id) then
    return jsonb_build_object('ok', false, 'error_class', 'MISSING_DOCUMENT',
      'message', format('%s is missing completion documents (%s); invoice after they are uploaded', p.project_number,
        (select string_agg(label, ', ' order by label) from v_projects_missing_completion_docs v where v.id = p.id)));
  end if;
  if exists (select 1 from invoices where project_id = p.id and invoice_type = 'FINAL' and status <> 'VOIDED') then
    return jsonb_build_object('ok', false, 'error_class', 'INVALID_STATE', 'already_invoiced', true,
      'message', format('%s already has a final invoice (%s)', p.project_number,
        (select string_agg(invoice_number, ', ') from invoices where project_id = p.id and invoice_type = 'FINAL' and status <> 'VOIDED')));
  end if;
  select string_agg(invoice_number || ' (' || status || ')', ', ' order by invoice_number) into v_blocking
    from invoices where project_id = p.id and status in ('DRAFT', 'PENDING_APPROVAL');
  if v_blocking is not null then
    return jsonb_build_object('ok', false, 'error_class', 'INVALID_STATE',
      'message', format('%s has unapproved invoices %s; resolve them before the final invoice', p.project_number, v_blocking));
  end if;

  select * into qv from quote_versions where id = p.accepted_quote_version_id;
  select * into q from quotes where id = qv.quote_id;
  if qv.line_amount_type <> 'INCLUSIVE' then
    return jsonb_build_object('ok', false, 'error_class', 'SCHEMA_MISMATCH', 'message', 'accepted quote is not GST-inclusive; not supported yet');
  end if;
  select * into c from customers where id = p.customer_id;
  select * into pr from properties where id = p.property_id;

  select coalesce(sum(total_inc_gst), 0), coalesce(jsonb_agg(jsonb_build_object('invoice', invoice_number, 'status', status, 'total', total_inc_gst) order by invoice_number), '[]')
    into v_billed, v_billed_list
    from invoices where project_id = p.id and status in ('APPROVED', 'ISSUED', 'PARTIALLY_PAID', 'PAID');
  select coalesce(sum(amount_inc_gst), 0) into v_var from variations where project_id = p.id and status = 'APPROVED';
  v_amount := qv.total_inc_gst + v_var - v_billed;
  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'error_class', 'ARITHMETIC_MISMATCH',
      'message', format('%s: quote %s + variations %s - billed %s = %s; nothing left to invoice', p.project_number,
        qv.total_inc_gst, v_var, v_billed, v_amount));
  end if;
  v_gst := round(v_amount * v_rate / (1 + v_rate), 2);

  v_lines := jsonb_build_array(jsonb_build_object('line_no', 1,
      'description', format('Final invoice %s: %s roofing works at %s, %s (quote %s v%s, total %s inc GST, less %s already invoiced)',
                            p.project_number, initcap(replace(q.job_type, '_', ' ')), pr.address_line1, pr.suburb, q.quote_number, qv.version_number,
                            qv.total_inc_gst, v_billed),
      'quantity', 1, 'unit_amount', qv.total_inc_gst - v_billed, 'variation_id', null))
    || coalesce((select jsonb_agg(jsonb_build_object('line_no', 1 + v.rn, 'description', 'Variation ' || v.variation_number || ': ' || v.description,
                                         'quantity', 1, 'unit_amount', v.amount_inc_gst, 'variation_id', v.id) order by v.rn)
       from (select *, row_number() over (order by variation_number) rn from variations where project_id = p.id and status = 'APPROVED') v), '[]'::jsonb);

  return jsonb_build_object('ok', true, 'preview', jsonb_build_object(
    'project_id', p.id, 'project_number', p.project_number, 'project_record_version', p.record_version,
    'customer_id', c.id, 'customer_number', c.customer_number, 'customer_name', btrim(c.display_name), 'customer_email', c.email,
    'quote_number', q.quote_number, 'quote_version', qv.version_number, 'quote_total_inc_gst', qv.total_inc_gst,
    'approved_variations_inc_gst', v_var, 'billed_to_date_inc_gst', v_billed, 'billed_invoices', v_billed_list,
    'amount_inc_gst', v_amount, 'gst_amount', v_gst, 'amount_ex_gst', v_amount - v_gst, 'currency', 'AUD', 'line_amount_type', 'INCLUSIVE',
    'lines', v_lines, 'invoice_date', v_today, 'due_date', v_today + v_terms,
    'reference', p.project_number,
    'xero_contact_number', v_con_prefix || c.customer_number,
    'xero_contact_name', btrim(c.display_name) || ' [' || c.customer_number || ']',
    'xero_account_code', (select value from app_settings where key = 'xero.sales_account_code'),
    'xero_tax_type', (select value from app_settings where key = 'xero.sales_tax_type'),
    'xero_invoice_number_prefix', v_inv_prefix,
    'xero_tenant_name', (select value from app_settings where key = 'xero.demo_tenant_name')));
end $$;
revoke execute on function invoice_final_preview(uuid) from public;

-- Stable hash of what a human approves (jsonb::text is canonical: keys sorted, whitespace normalised).
create or replace function invoice_preview_hash(p_preview jsonb)
returns text language sql immutable set search_path = public, pg_temp as $$
  select encode(sha256(convert_to((p_preview - 'project_record_version')::text, 'UTF8')), 'hex')
$$;
revoke execute on function invoice_preview_hash(jsonb) from public;

-- ---------------------------------------------------------------------------
-- Shared: validate an invoice event envelope and log its delivery (redelivery-safe, like wf_quote_accepted).
-- ---------------------------------------------------------------------------
create or replace function wf_invoice_log_event(p_event jsonb, p_type text, p_worker text,
  out event_id uuid, out event_key text, out correlation_id uuid, out redelivery boolean, out first_event uuid, out issues text[])
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_payload jsonb := p_event -> 'payload'; v_base text; v_n int; v_prj text := p_event -> 'payload' ->> 'project_number';
begin
  issues := '{}'; redelivery := false;
  event_key := p_event ->> 'event_id';
  if coalesce(event_key, '') = '' or length(event_key) > 200 then issues := array_append(issues, 'event_id: required, <=200 chars'::text); end if;
  if coalesce(p_event ->> 'event_type', '') <> p_type then issues := array_append(issues, ('event_type: must be ' || p_type)::text); end if;
  if coalesce(p_event ->> 'source', '') = '' then issues := array_append(issues, 'source: required'::text); end if;
  if coalesce(p_event ->> 'actor_id', '') = '' then issues := array_append(issues, 'actor_id: required (who asked)'::text); end if;
  if jsonb_typeof(v_payload) is distinct from 'object' then issues := array_append(issues, 'payload: required object'::text); end if;
  if coalesce(v_prj, '') !~ '^PRJ-[0-9]{4}-[0-9]{4}$' then issues := array_append(issues, 'payload.project_number: required, format PRJ-YYYY-NNNN'::text); end if;
  if v_payload ? 'project_uuid' and coalesce(v_payload ->> 'project_uuid', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    issues := array_append(issues, 'payload.project_uuid: must be a UUID when present'::text);
  end if;
  begin
    perform (p_event ->> 'occurred_at')::timestamptz;
    if p_event ->> 'occurred_at' is null then issues := array_append(issues, 'occurred_at: required'::text); end if;
  exception when others then issues := array_append(issues, 'occurred_at: must be an ISO-8601 timestamp'::text);
  end;
  event_key := coalesce(nullif(event_key, ''), 'invalid:' || md5(p_event::text));
  correlation_id := stable_uuid('correlation', coalesce(nullif(p_event ->> 'correlation_id', ''), event_key));
  v_base := event_key;
  loop
    insert into automation_events (event_id, event_key, correlation_id, causation_id, event_type, entity_type, entity_id,
      business_reference, actor_type, actor_id, source, workflow_version, occurred_at, status, metadata, payload)
    values (stable_uuid('event', event_key), event_key, correlation_id, first_event, p_type, 'project',
      (select id from projects where project_number = v_prj), v_prj, 'USER', p_event ->> 'actor_id',
      coalesce(p_event ->> 'source', 'unknown'), (select value from app_settings where key = 'wf.project_to_invoice.version'), now(),
      case when array_length(issues, 1) > 0 then 'REJECTED' else 'RECEIVED' end,
      jsonb_build_object('worker', p_worker, 'airtable_record_id', v_payload ->> 'airtable_record_id', 'transport_redelivery', redelivery,
                         'issues', to_jsonb(issues)), p_event)
    on conflict do nothing
    returning automation_events.event_id into event_id;
    exit when event_id is not null;
    redelivery := true;
    first_event := stable_uuid('event', v_base);
    select count(*) + 1 into v_n from automation_events where automation_events.event_key like v_base || ':redelivery:%';
    event_key := v_base || ':redelivery:' || v_n;
  end loop;
end $$;
revoke execute on function wf_invoice_log_event(jsonb, text, text) from public;

-- ---------------------------------------------------------------------------
-- wf_invoice_prepare: preview only. Outcomes:
--   PREVIEW_READY | ALREADY_PENDING | ALREADY_INVOICED | INVALID_EVENT | INVALID_STATE
-- ---------------------------------------------------------------------------
create or replace function wf_invoice_prepare(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e record; v_key text; v_claimed boolean; v_pe processed_events; p projects; v_prev jsonb; v_prj text;
  v_ap approvals; v_num text; v_exc text; v_res jsonb; v_requester uuid;
begin
  select * into e from wf_invoice_log_event(p_event, 'invoice.prepare_requested', p_worker);
  v_prj := p_event -> 'payload' ->> 'project_number';
  if array_length(e.issues, 1) > 0 then
    v_exc := wf_open_invoice_rejection(e.event_id, null, coalesce(v_prj, 'unknown'), 'VALIDATION_ERROR',
               'Invalid invoice.prepare_requested event: ' || array_to_string(e.issues, '; '));
    return jsonb_build_object('outcome', 'INVALID_EVENT', 'error_class', 'VALIDATION_ERROR', 'issues', to_jsonb(e.issues), 'exception_number', v_exc);
  end if;

  -- Transport idempotency: the same delivery always gets the same answer.
  v_key := 'invoice.prepare:' || coalesce(e.first_event::text, e.event_id::text);
  insert into processed_events (consumer, idempotency_key, first_event_id, request_hash, status, locked_by, lease_expires_at)
  values ('invoice_prepare@1', v_key, coalesce(e.first_event, e.event_id), md5(p_event::text), 'PROCESSING', p_worker, now() + interval '5 minutes')
  on conflict do nothing returning true into v_claimed;
  if v_claimed is null then
    select * into v_pe from processed_events where consumer = 'invoice_prepare@1' and idempotency_key = v_key for update;
    update processed_events set delivery_count = delivery_count + 1, last_seen_at = now() where consumer = v_pe.consumer and idempotency_key = v_key;
    update automation_events set status = 'DUPLICATE_IGNORED', error_class = 'DUPLICATE_EVENT', causation_id = v_pe.first_event_id,
           metadata = metadata || jsonb_build_object('reason', 'transport redelivery of the same event_id') where event_id = e.event_id;
    return coalesce(v_pe.result, '{}'::jsonb) || jsonb_build_object('duplicate', true, 'delivery_count', v_pe.delivery_count + 1);
  end if;

  select * into p from projects where project_number = v_prj for update;
  if not found or (p_event -> 'payload' ? 'project_uuid' and (p_event -> 'payload' ->> 'project_uuid')::uuid <> p.id) then
    v_res := jsonb_build_object('outcome', 'INVALID_STATE', 'error_class', case when p.id is null then 'NOT_FOUND' else 'RECONCILIATION_MISMATCH' end,
      'message', case when p.id is null then v_prj || ' does not exist' else 'Airtable RoofOps ID does not match ' || v_prj end);
  else
    -- An open or completed request for this project wins over a new one: one invoice per project.
    select * into v_ap from approvals where action_type = 'CREATE_INVOICE' and entity_id = p.id
       and status in ('PENDING', 'APPROVED', 'EXECUTING', 'EXECUTED') order by created_at desc limit 1;
    if v_ap.id is not null and v_ap.status = 'PENDING' and v_ap.expires_at > now() then
      v_res := jsonb_build_object('outcome', 'ALREADY_PENDING', 'approval_number', v_ap.approval_number, 'preview', v_ap.action_payload,
                                  'message', 'Preview ' || v_ap.approval_number || ' is already waiting for approval');
    elsif v_ap.id is not null and v_ap.status in ('APPROVED', 'EXECUTING', 'EXECUTED') then
      v_res := jsonb_build_object('outcome', 'ALREADY_INVOICED', 'approval_number', v_ap.approval_number, 'preview', v_ap.action_payload,
                                  'invoice_number', (select invoice_number from invoices where approval_id = v_ap.id),
                                  'message', v_prj || ' was already approved for invoicing under ' || v_ap.approval_number);
    else
      if v_ap.id is not null then   -- a stale PENDING request past its expiry
        update approvals set status = 'EXPIRED' where id = v_ap.id;
      end if;
      v_prev := invoice_final_preview(p.id);
      if not (v_prev ->> 'ok')::boolean then
        v_res := jsonb_build_object('outcome', case when (v_prev ->> 'already_invoiced')::boolean then 'ALREADY_INVOICED' else 'INVALID_STATE' end,
                                    'error_class', v_prev ->> 'error_class', 'message', v_prev ->> 'message');
      else
        select ei.employee_id into v_requester from employee_external_identities ei where ei.provider = 'AIRTABLE' and ei.external_id = p_event ->> 'actor_id';
        v_num := next_friendly_id('APR', extract(year from app_today())::int);
        insert into approvals (approval_number, action_type, entity_type, entity_id, business_reference, requested_by_actor_type,
          requested_by_employee_id, required_permission, action_payload, payload_hash, expected_record_version, idempotency_key, expires_at)
        values (v_num, 'CREATE_INVOICE', 'project', p.id, p.project_number, 'USER', v_requester, 'invoice.approve',
          v_prev -> 'preview', invoice_preview_hash(v_prev -> 'preview'), p.record_version, 'approval:' || e.event_key,
          now() + make_interval(hours => (select value::int from app_settings where key = 'invoice.approval_ttl_hours')))
        returning * into v_ap;
        insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason, correlation_id)
        values ('USER', p_event ->> 'actor_id', 'invoice.preview_prepared', 'project', p.id, p.project_number,
                jsonb_build_object('approval', v_num, 'amount_inc_gst', v_prev -> 'preview' -> 'amount_inc_gst', 'payload_hash', v_ap.payload_hash),
                'Final invoice preview awaiting approval', e.correlation_id);
        perform wf_log_event(e.event_key || ':invoice.preview_prepared', e.correlation_id, e.event_id, 'invoice.preview_prepared', 'project', p.id,
          p.project_number, 'WORKFLOW', 'project_to_invoice@1', 'postgres', 'SUCCEEDED', null, jsonb_build_object('approval', v_num), null);
        v_res := jsonb_build_object('outcome', 'PREVIEW_READY', 'approval_number', v_num, 'preview', v_ap.action_payload,
                                    'payload_hash', v_ap.payload_hash, 'expires_at', v_ap.expires_at);
      end if;
    end if;
  end if;

  if v_res ->> 'outcome' = 'INVALID_STATE' then
    v_exc := wf_open_invoice_rejection(e.event_id, p.id, v_prj, v_res ->> 'error_class', v_res ->> 'message');
    v_res := v_res || jsonb_build_object('exception_number', v_exc);
    update automation_events set status = 'REJECTED', error_class = v_res ->> 'error_class', metadata = metadata || jsonb_build_object('reason', v_res ->> 'message')
     where event_id = e.event_id;
  else
    update automation_events set status = 'SUCCEEDED', metadata = metadata || jsonb_build_object('outcome', v_res ->> 'outcome') where event_id = e.event_id;
  end if;
  v_res := v_res || jsonb_build_object('project_number', v_prj, 'project_id', p.id, 'event_key', e.event_key, 'duplicate', false);
  update processed_events set status = 'COMPLETED', completed_at = now(), result = v_res, lease_expires_at = null
   where consumer = 'invoice_prepare@1' and idempotency_key = v_key;
  return v_res;
end $$;

-- ---------------------------------------------------------------------------
-- wf_invoice_decide: approve or reject a prepared preview. Outcomes:
--   APPROVED | REJECTED_BY_APPROVER | ALREADY_PROCESSED | INVALID_EVENT | INVALID_STATE | PERMISSION_DENIED
-- Business idempotency: one decision per approval (processed_events key invoice.decision:APR-…).
-- ---------------------------------------------------------------------------
create or replace function wf_invoice_decide(p_event jsonb, p_worker text default 'n8n')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e record; v_type text := p_event ->> 'event_type'; v_prj text := p_event -> 'payload' ->> 'project_number';
  p projects; v_ap approvals; v_key text; v_claimed boolean; v_pe processed_events; v_emp employees;
  v_prev jsonb; v_hash text; v_inv invoices; v_run uuid; v_res jsonb; v_exc text; v_class text; v_msg text;
  v_tenant text := (select value from app_settings where key = 'xero.demo_tenant_id');
  v_line jsonb;
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
    insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload)
    values ('xero.create_draft_invoice', 'invoice', v_inv.id, e.correlation_id, 'xero:invoice:' || v_inv.id,
      v_ap.action_payload || jsonb_build_object(
        'invoice_id', v_inv.id, 'invoice_number', v_inv.invoice_number,
        'xero_invoice_number', (v_ap.action_payload ->> 'xero_invoice_number_prefix') || v_inv.invoice_number,
        'xero_tenant_id', v_tenant, 'approval_number', v_ap.approval_number, 'approved_by', v_emp.full_name,
        'project_airtable_record_id', (select external_id from external_links where provider = 'AIRTABLE' and entity_type = 'project'
                                         and entity_id = p.id and verified_at is not null),
        'xero_idempotency_key', 'roofops-' || v_inv.id));
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
      (v_run, 1, 5, 'queue_xero_draft', 'SUCCEEDED', now(), jsonb_build_object('key', 'xero:invoice:' || v_inv.id));
    perform wf_log_event(e.event_key || ':invoice.approved', e.correlation_id, e.event_id, 'invoice.created', 'invoice', v_inv.id,
      v_inv.invoice_number, 'WORKFLOW', 'project_to_invoice@1', 'postgres', 'SUCCEEDED', null,
      jsonb_build_object('approval', v_ap.approval_number, 'total_inc_gst', v_inv.total_inc_gst), null);
    v_res := jsonb_build_object('outcome', 'APPROVED', 'approval_number', v_ap.approval_number, 'decided_by', v_emp.full_name,
      'invoice_id', v_inv.id, 'invoice_number', v_inv.invoice_number, 'amount_inc_gst', v_inv.total_inc_gst, 'workflow_run_id', v_run,
      'xero_key', 'xero:invoice:' || v_inv.id, 'preview', v_ap.action_payload);
  end if;

  update automation_events set status = 'SUCCEEDED', metadata = metadata || jsonb_build_object('outcome', v_res ->> 'outcome') where event_id = e.event_id;
  v_res := v_res || jsonb_build_object('project_number', v_prj, 'project_id', p.id, 'event_key', e.event_key, 'duplicate', false);
  update processed_events set status = 'COMPLETED', completed_at = now(), result = v_res, lease_expires_at = null
   where consumer = 'invoice_decision@1' and idempotency_key = v_key;
  return v_res;
end $$;

revoke execute on function wf_open_invoice_rejection(uuid, uuid, text, text, text) from public;
grant execute on function wf_invoice_prepare(jsonb, text), wf_invoice_decide(jsonb, text) to roofops_workflow;

-- ---------------------------------------------------------------------------
-- wf_complete_side_effect v1.3: + xero.create_draft_invoice; run lookup no longer quote-specific.
-- ---------------------------------------------------------------------------
create or replace function wf_complete_side_effect(p_key text, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o outbox;
  v_existing text;
  v_run uuid;
  v_left int;
  v_ref text;
  v_expected jsonb;
  v_got jsonb;
  v_sub jsonb;
  v_drive_url text;
begin
  select * into o from outbox where idempotency_key = p_key for update;
  if not found then raise exception 'unknown side effect %', p_key using errcode = 'no_data_found'; end if;
  if o.status = 'DONE' then
    return jsonb_build_object('status', 'ALREADY_DONE', 'result', o.result);
  end if;
  if o.status <> 'DISPATCHING' then
    raise exception 'side effect % is %, not claimed', p_key, o.status using errcode = 'check_violation';
  end if;
  if coalesce((p_result ->> 'verified')::boolean, false) is not true then
    raise exception 'refusing to record % without read-back verification (verified=true)', p_key using errcode = 'check_violation';
  end if;
  v_ref := coalesce(o.payload ->> 'invoice_number', o.payload ->> 'project_number');

  if o.topic = 'drive.ensure_project_folder' then
    if coalesce(p_result ->> 'folder_id', '') = '' or coalesce(p_result ->> 'mime_type', '') <> 'application/vnd.google-apps.folder' then
      raise exception 'drive result needs folder_id and mime_type=application/vnd.google-apps.folder' using errcode = 'check_violation';
    end if;
    if coalesce(p_result ->> 'parent_id', '') = '' or coalesce((p_result ->> 'trashed')::boolean, true) then
      raise exception 'drive result needs parent_id and trashed=false from the read-back' using errcode = 'check_violation';
    end if;
    if p_result ->> 'name' is distinct from o.payload ->> 'folder_name' then
      raise exception 'drive folder name % does not match %', p_result ->> 'name', o.payload ->> 'folder_name' using errcode = 'check_violation';
    end if;
    if p_result -> 'app_properties' ->> 'roofops_project_id' is distinct from o.aggregate_id::text then
      raise exception 'drive folder is not tagged with project %', o.aggregate_id using errcode = 'check_violation';
    end if;
    -- Every requested subfolder, exactly once, each read back as a live folder inside the project folder.
    v_expected := coalesce(o.payload -> 'subfolders', '[]'::jsonb);
    select coalesce(jsonb_agg(s ->> 'name' order by s ->> 'name'), '[]') into v_got
      from jsonb_array_elements(coalesce(p_result -> 'subfolders', '[]'::jsonb)) s
     where coalesce(s ->> 'id', '') <> '' and s ->> 'parent_id' = p_result ->> 'folder_id'
       and s ->> 'mime_type' = 'application/vnd.google-apps.folder' and not coalesce((s ->> 'trashed')::boolean, true);
    if v_got <> (select coalesce(jsonb_agg(e order by e), '[]') from jsonb_array_elements_text(v_expected) e) then
      raise exception 'drive subfolders read back % do not match the required %', v_got, v_expected using errcode = 'check_violation';
    end if;

    select external_id into v_existing from external_links
     where provider = 'GOOGLE_DRIVE' and entity_type = 'project' and entity_id = o.aggregate_id and external_type = 'Folder';
    if v_existing is not null and v_existing <> p_result ->> 'folder_id' then
      raise exception 'project % already linked to Drive folder %, refusing a second folder %', v_ref, v_existing, p_result ->> 'folder_id'
        using errcode = 'unique_violation';
    end if;
    insert into external_links (provider, entity_type, entity_id, external_type, external_id, external_url, last_synced_at, verified_at)
    values ('GOOGLE_DRIVE', 'project', o.aggregate_id, 'Folder', p_result ->> 'folder_id', p_result ->> 'web_view_link', now(), now())
    on conflict (provider, entity_type, entity_id, external_type) do update set verified_at = now(), last_synced_at = now();
    for v_sub in select * from jsonb_array_elements(p_result -> 'subfolders') loop
      insert into external_links (provider, entity_type, entity_id, external_type, external_id, external_url, last_synced_at, verified_at)
      values ('GOOGLE_DRIVE', 'project', o.aggregate_id, 'Folder:' || (v_sub ->> 'name'), v_sub ->> 'id', v_sub ->> 'web_view_link', now(), now())
      on conflict (provider, entity_type, entity_id, external_type) do update set verified_at = now(), last_synced_at = now();
    end loop;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, external_reference, reason, correlation_id)
    values ('INTEGRATION', 'google-drive', 'drive.folder.link', 'project', o.aggregate_id, v_ref,
            p_result - 'verified', p_result ->> 'folder_id', 'Project folder and subfolders created and read back from Google Drive', o.correlation_id);

  elsif o.topic = 'airtable.project_writeback' then
    if coalesce(p_result ->> 'project_record_id', '') !~ '^rec[A-Za-z0-9]{14}$' then
      raise exception 'airtable result needs project_record_id (recXXXXXXXXXXXXXX)' using errcode = 'check_violation';
    end if;
    if p_result ->> 'roofops_id' is distinct from o.aggregate_id::text or p_result ->> 'project_number' is distinct from v_ref then
      raise exception 'airtable record read back does not carry project % / %', v_ref, o.aggregate_id using errcode = 'check_violation';
    end if;
    if o.payload ->> 'quote_airtable_record_id' is not null
       and not coalesce(p_result -> 'linked_quote_record_ids' ? (o.payload ->> 'quote_airtable_record_id'), false) then
      raise exception 'airtable project is not linked to quote record %', o.payload ->> 'quote_airtable_record_id' using errcode = 'check_violation';
    end if;
    select external_url into v_drive_url from external_links
     where provider = 'GOOGLE_DRIVE' and entity_type = 'project' and entity_id = o.aggregate_id and external_type = 'Folder';
    if v_drive_url is not null and p_result ->> 'drive_folder_url' is distinct from v_drive_url then
      raise exception 'airtable Drive Folder % does not match the verified folder %', p_result ->> 'drive_folder_url', v_drive_url using errcode = 'check_violation';
    end if;
    select external_id into v_existing from external_links
     where provider = 'AIRTABLE' and entity_type = 'project' and entity_id = o.aggregate_id and external_type = 'Record';
    if v_existing is not null and v_existing <> p_result ->> 'project_record_id' then
      raise exception 'project % already linked to Airtable record %, refusing a second record %', v_ref, v_existing, p_result ->> 'project_record_id'
        using errcode = 'unique_violation';
    end if;
    insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
    values ('AIRTABLE', 'project', o.aggregate_id, 'Record', p_result ->> 'project_record_id', now(), now())
    on conflict (provider, entity_type, entity_id, external_type) do update set verified_at = now(), last_synced_at = now();
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, external_reference, reason, correlation_id)
    values ('INTEGRATION', 'airtable', 'airtable.project.writeback', 'project', o.aggregate_id, v_ref,
            p_result - 'verified', p_result ->> 'project_record_id', 'Project record written to Airtable, linked to its quote and read back', o.correlation_id);
  elsif o.topic = 'xero.create_draft_invoice' then
    -- Only proof read back from the pinned Xero DEMO tenant is accepted, and it must describe exactly the approved draft.
    if coalesce(o.payload ->> 'xero_tenant_id', '') = '' or p_result ->> 'tenant_id' is distinct from o.payload ->> 'xero_tenant_id' then
      raise exception 'xero proof is from tenant %, not the pinned Demo Company tenant', p_result ->> 'tenant_id' using errcode = 'check_violation';
    end if;
    if p_result ->> 'organisation_class' is distinct from 'DEMO' then
      raise exception 'refusing: the Xero organisation is not a Demo Company (Class=%)', p_result ->> 'organisation_class' using errcode = 'check_violation';
    end if;
    if coalesce(p_result ->> 'invoice_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or coalesce(p_result ->> 'contact_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'xero proof needs InvoiceID and ContactID' using errcode = 'check_violation';
    end if;
    if p_result ->> 'invoice_number' is distinct from o.payload ->> 'xero_invoice_number' or p_result ->> 'reference' is distinct from o.payload ->> 'reference' then
      raise exception 'xero invoice %/% does not carry number % and reference %', p_result ->> 'invoice_number', p_result ->> 'reference',
        o.payload ->> 'xero_invoice_number', o.payload ->> 'reference' using errcode = 'check_violation';
    end if;
    if p_result ->> 'status' is distinct from 'DRAFT' or p_result ->> 'type' is distinct from 'ACCREC' then
      raise exception 'xero invoice must be an ACCREC DRAFT, read back %/%', p_result ->> 'type', p_result ->> 'status' using errcode = 'check_violation';
    end if;
    if coalesce((p_result ->> 'amount_paid')::numeric, -1) <> 0 or coalesce((p_result ->> 'sent_to_contact')::boolean, true) then
      raise exception 'xero invoice must be unpaid and unsent' using errcode = 'check_violation';
    end if;
    if p_result ->> 'contact_number' is distinct from o.payload ->> 'xero_contact_number' then
      raise exception 'xero invoice contact % is not %', p_result ->> 'contact_number', o.payload ->> 'xero_contact_number' using errcode = 'check_violation';
    end if;
    if (p_result ->> 'total')::numeric is distinct from (o.payload ->> 'amount_inc_gst')::numeric
       or (p_result ->> 'total_tax')::numeric is distinct from (o.payload ->> 'gst_amount')::numeric then
      raise exception 'xero total %/GST % does not match the approved % / %', p_result ->> 'total', p_result ->> 'total_tax',
        o.payload ->> 'amount_inc_gst', o.payload ->> 'gst_amount' using errcode = 'check_violation';
    end if;
    if p_result ->> 'currency' is distinct from 'AUD' or p_result ->> 'line_amount_types' is distinct from 'Inclusive' then
      raise exception 'xero invoice must be AUD, GST inclusive' using errcode = 'check_violation';
    end if;
    if coalesce((p_result ->> 'matching_invoices')::int, 0) <> 1 then
      raise exception 'expected exactly one Xero invoice numbered %, found %', o.payload ->> 'xero_invoice_number', p_result ->> 'matching_invoices'
        using errcode = 'unique_violation';
    end if;
    select external_id into v_existing from external_links
     where provider = 'XERO' and entity_type = 'invoice' and entity_id = o.aggregate_id and external_type = 'Invoice';
    if v_existing is not null and v_existing <> p_result ->> 'invoice_id' then
      raise exception 'invoice % already linked to Xero invoice %, refusing a second %', v_ref, v_existing, p_result ->> 'invoice_id'
        using errcode = 'unique_violation';
    end if;
    select external_id into v_existing from external_links
     where provider = 'XERO' and entity_type = 'customer' and entity_id = (o.payload ->> 'customer_id')::uuid and external_type = 'Contact';
    if v_existing is not null and v_existing <> p_result ->> 'contact_id' then
      raise exception 'customer % is linked to Xero contact %, not %', o.payload ->> 'customer_number', v_existing, p_result ->> 'contact_id'
        using errcode = 'unique_violation';
    end if;
    insert into external_links (provider, entity_type, entity_id, external_type, external_id, external_url, last_synced_at, verified_at)
    values ('XERO', 'invoice', o.aggregate_id, 'Invoice', p_result ->> 'invoice_id',
            'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=' || (p_result ->> 'invoice_id'), now(), now()),
           ('XERO', 'customer', (o.payload ->> 'customer_id')::uuid, 'Contact', p_result ->> 'contact_id',
            'https://go.xero.com/Contacts/View/' || (p_result ->> 'contact_id'), now(), now())
    on conflict (provider, entity_type, entity_id, external_type) do update set verified_at = now(), last_synced_at = now();
    update invoices set sync_status = 'SYNCED' where id = o.aggregate_id;
    update approvals set status = 'EXECUTED', executed_at = now(), execution_result = p_result - 'verified'
     where id = (select approval_id from invoices where id = o.aggregate_id);
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, external_reference, reason, correlation_id)
    values ('INTEGRATION', 'xero', 'xero.invoice.draft_created', 'invoice', o.aggregate_id, v_ref,
            p_result - 'verified', p_result ->> 'invoice_id',
            'DRAFT invoice ' || (p_result ->> 'invoice_number') || ' created in the Xero Demo Company and read back', o.correlation_id);
  else
    raise exception 'unknown side-effect topic %', o.topic;
  end if;

  update outbox set status = 'DONE', dispatched_at = now(), locked_until = null, result = p_result where idempotency_key = p_key;
  perform wf_log_event(p_key || ':done:' || o.attempts, o.correlation_id, null, replace(o.topic, 'ensure_', '') || '.verified',
    'project', o.aggregate_id, v_ref, 'INTEGRATION', o.topic, 'n8n', 'SUCCEEDED', null,
    jsonb_build_object('attempt', o.attempts, 'external_id', coalesce(p_result ->> 'folder_id', p_result ->> 'project_record_id', p_result ->> 'invoice_id')), null);

  select id into v_run from workflow_runs where entity_id = o.aggregate_id order by started_at desc limit 1;
  insert into workflow_run_steps (run_id, attempt, seq, step_key, status, finished_at, detail)
  values (v_run, o.attempts, (select coalesce(max(seq), 0) + 1 from workflow_run_steps where run_id = v_run), o.topic, 'SUCCEEDED', now(),
          jsonb_build_object('attempt', o.attempts, 'external_id', coalesce(p_result ->> 'folder_id', p_result ->> 'project_record_id', p_result ->> 'invoice_id')));
  select count(*) into v_left from outbox where aggregate_id = o.aggregate_id and status <> 'DONE';
  if v_left = 0 then
    update workflow_runs set status = 'SUCCEEDED', finished_at = now() where id = v_run;
    update workflow_exceptions set resolution_status = 'RESOLVED', resolved_at = now(), resolved_by_system = 'workflow:' || (select workflow_key from workflow_runs where id = v_run),
           resolution_note = 'Auto-resolved: side effect succeeded on retry'
     where workflow_run_id = v_run and resolution_status in ('OPEN','RETRY_QUEUED');
  end if;
  return jsonb_build_object('status', 'RECORDED', 'key', p_key, 'remaining_side_effects', v_left);
end $$;

-- ---------------------------------------------------------------------------
-- wf_fail_side_effect v1.1: invoice sync state; run lookup no longer quote-specific.
-- ---------------------------------------------------------------------------
create or replace function wf_fail_side_effect(p_key text, p_error_class text, p_message text,
                                               p_http_status int default null, p_retry_after_seconds int default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o outbox;
  v_retryable boolean;
  v_max int := (select value::int from app_settings where key = 'wf.side_effect.max_attempts');
  v_delay int;
  v_run uuid;
  v_exc text;
begin
  select * into o from outbox where idempotency_key = p_key for update;
  if not found then raise exception 'unknown side effect %', p_key using errcode = 'no_data_found'; end if;
  if o.status <> 'DISPATCHING' then raise exception 'side effect % is %, not claimed', p_key, o.status using errcode = 'check_violation'; end if;
  select retryable into v_retryable from error_classes where code = p_error_class;
  if v_retryable is null then raise exception 'unknown error class %', p_error_class using errcode = 'foreign_key_violation'; end if;

  select id into v_run from workflow_runs where entity_id = o.aggregate_id order by started_at desc limit 1;
  if v_retryable and o.attempts < v_max then
    v_delay := coalesce(p_retry_after_seconds, least(60, (2 ^ (o.attempts - 1))::int));   -- 1, 2, 4, 8 s … capped
    update outbox set status = 'FAILED', locked_until = null, next_attempt_at = now() + make_interval(secs => v_delay),
           last_error = left(p_message, 1000) where idempotency_key = p_key;
    insert into workflow_run_steps (run_id, attempt, seq, step_key, status, finished_at, http_status, error_class, retry_delay_ms, detail)
    values (v_run, o.attempts, (select coalesce(max(seq), 0) + 1 from workflow_run_steps where run_id = v_run), o.topic, 'FAILED', now(),
            p_http_status, p_error_class, v_delay * 1000, jsonb_build_object('message', left(p_message, 500)));
    update workflow_runs set status = 'RETRY_SCHEDULED', next_attempt_at = now() + make_interval(secs => v_delay),
           last_error_class = p_error_class, last_error_message = left(p_message, 500) where id = v_run;
    perform wf_log_event(p_key || ':retry:' || o.attempts, o.correlation_id, null, 'automation.retry_scheduled', 'project', o.aggregate_id,
      coalesce(o.payload ->> 'invoice_number', o.payload ->> 'project_number'), 'WORKFLOW', o.topic, 'n8n', 'FAILED', p_error_class,
      jsonb_build_object('attempt', o.attempts, 'retry_in_seconds', v_delay, 'http_status', p_http_status, 'message', left(p_message, 500)), null);
    if o.topic = 'xero.create_draft_invoice' then
      -- A timeout or 5xx on a create may have succeeded in Xero: UNKNOWN until the next attempt reconciles by searching first.
      update invoices set sync_status = case when p_error_class in ('TIMEOUT', 'NETWORK', 'UPSTREAM_5XX', 'SERVICE_UNAVAILABLE') then 'UNKNOWN' else 'PENDING' end
       where id = o.aggregate_id;
    end if;
    return jsonb_build_object('retry', true, 'retry_in_seconds', v_delay, 'attempt', o.attempts, 'max_attempts', v_max);
  end if;

  update outbox set status = 'FAILED', locked_until = null, next_attempt_at = 'infinity', last_error = left(p_message, 1000) where idempotency_key = p_key;
  update workflow_runs set status = 'DEAD_LETTERED', finished_at = now(), last_error_class = p_error_class, last_error_message = left(p_message, 500) where id = v_run;
  perform wf_log_event(p_key || ':failed:' || o.attempts, o.correlation_id, null, 'automation.failed', 'project', o.aggregate_id,
    coalesce(o.payload ->> 'invoice_number', o.payload ->> 'project_number'), 'WORKFLOW', o.topic, 'n8n', 'FAILED', p_error_class,
    jsonb_build_object('attempt', o.attempts, 'http_status', p_http_status, 'message', left(p_message, 500)), null);
  if o.topic = 'xero.create_draft_invoice' then
    update invoices set sync_status = 'FAILED' where id = o.aggregate_id;
    update approvals set status = 'EXECUTION_FAILED', executed_at = now(),
           execution_result = jsonb_build_object('error_class', p_error_class, 'message', left(p_message, 500), 'attempts', o.attempts)
     where id = (select approval_id from invoices where id = o.aggregate_id);
  end if;
  v_exc := wf_open_exception(v_run, null, o.aggregate_type, o.aggregate_id, coalesce(o.payload ->> 'invoice_number', o.payload ->> 'project_number'), p_error_class,
    o.topic || ': ' || left(p_message, 500), o.attempts);
  return jsonb_build_object('retry', false, 'exception_number', v_exc, 'attempt', o.attempts,
    'reason', case when v_retryable then 'max attempts reached' else 'non-retryable error class' end);
end $$;
