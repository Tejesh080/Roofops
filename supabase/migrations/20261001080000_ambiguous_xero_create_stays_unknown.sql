-- AC-04 (docs/defect-ledger.md): a Xero draft that really exists was recorded as never created. After a lost create
-- answer (TIMEOUT -> sync UNKNOWN), a later failure of another class (429) reset the invoice to PENDING, and the final
-- failure dead-lettered it to FAILED ("failed safely"); failures after the create (read-back, verify, record) and a
-- conflicting pre-create search also dead-lettered to FAILED although the draft exists. Reconciliation only read invoices
-- with a verified Xero link, so an unlinked draft was never found. AC-05 then allowed a void, and a re-queue could bill twice.
--
-- Rule: a timeout or transport failure after the create request is never proof that no draft exists.
--  * wf_fail_side_effect judges each 05 failure by its step (05 prefixes every message with it) and class:
--      before the create request (connections, tenant, organisation, contact, the two searches): no new evidence;
--      the create explicitly refused by Xero (its own answer carries HTTP 4xx, including 429): absent;
--      anything else at the create (timeout, network, 5xx, an answer RoofOps could not read as a refusal), anything
--      after it, a conflicting search ("reconcile"), or an unrecognised step: may exist.
--    The invoice is UNKNOWN while it may exist; nothing but proof of absence leaves UNKNOWN. An uncertain dead letter
--    stays UNKNOWN (approval still executing) with one AMBIGUOUS_WRITE exception; it is never FAILED.
--  * Reconciliation (n8n 07) also targets uncertain writes bound to the pinned tenant and looks each up in that tenant
--    by its deterministic Xero invoice number and, independently, by reference. wf_reconcile_xero_uncertain settles it
--    only when both lookups answered HTTP 200, in repair
--    mode only: exactly one matching live draft -> linked, SYNCED; nothing at all -> proven absent (a dead letter
--    becomes FAILED, safe to re-queue; a scheduled retry may go ahead); anything else -> one exception, a person decides.
--    A failed lookup proves nothing; a lookup from another tenant proves nothing and opens an exception; a write 05 is
--    working on (claimed) is not a target and is never touched.
-- 05's own search-before-create (by number and reference) and its Idempotency-Key are unchanged.

-- 1. Reconciliation may record a draft it proved exists on a job that is not claimed (explicit, nothing else).
insert into state_transitions (machine, from_state, to_state, guard, note) values
  ('outbox', 'FAILED', 'DONE', null, 'reconciliation proved the Xero draft exists (AC-04)'),
  ('outbox', 'PENDING', 'DONE', null, 'reconciliation proved the Xero draft exists (AC-04)')
on conflict (machine, from_state, to_state) do nothing;

-- 2. What a 05 failure proves about the draft: NONE (no new evidence), ABSENT, or MAY_EXIST.
create or replace function xero_failure_evidence(p_class text, p_message text, p_http_status int)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case
    when lower(btrim(split_part(coalesce(p_message, ''), ':', 1))) in ('list connections', 'check tenant', 'read organisation', 'check organisation',
                                                                     'find contact', 'create contact', 'search by invoice number', 'search by reference') then 'NONE'
    when lower(btrim(split_part(coalesce(p_message, ''), ':', 1))) = 'create draft invoice' then
      -- Absent only on Xero's explicit refusal of the create request itself; nothing else proves it was not created.
      case when p_http_status between 400 and 499 and p_class not in ('TIMEOUT', 'NETWORK', 'UPSTREAM_5XX', 'SERVICE_UNAVAILABLE', 'UNKNOWN', 'AMBIGUOUS_WRITE')
           then 'ABSENT' else 'MAY_EXIST' end
    else 'MAY_EXIST'   -- reconcile, read back invoice, recount invoices, verify read-back, record xero draft, or unrecognised
  end
$$;

-- 3. wf_fail_side_effect v1.2: an uncertain Xero write stays UNKNOWN, through retries and the dead letter.
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
  v_xero boolean;
  v_uncertain boolean := false;
  v_sync text;
begin
  select * into o from outbox where idempotency_key = p_key for update;
  if not found then raise exception 'unknown side effect %', p_key using errcode = 'no_data_found'; end if;
  if o.status <> 'DISPATCHING' then raise exception 'side effect % is %, not claimed', p_key, o.status using errcode = 'check_violation'; end if;
  select retryable into v_retryable from error_classes where code = p_error_class;
  if v_retryable is null then raise exception 'unknown error class %', p_error_class using errcode = 'foreign_key_violation'; end if;
  v_xero := o.topic = 'xero.create_draft_invoice';
  if v_xero then
    select sync_status into v_sync from invoices where id = o.aggregate_id;
    v_uncertain := case xero_failure_evidence(p_error_class, p_message, p_http_status)
                     when 'MAY_EXIST' then true when 'ABSENT' then false else v_sync = 'UNKNOWN' end;
  end if;

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
    if v_xero then
      update invoices set sync_status = case when v_uncertain then 'UNKNOWN' else 'PENDING' end
       where id = o.aggregate_id and sync_status is distinct from case when v_uncertain then 'UNKNOWN' else 'PENDING' end;
    end if;
    return jsonb_build_object('retry', true, 'retry_in_seconds', v_delay, 'attempt', o.attempts, 'max_attempts', v_max);
  end if;

  update outbox set status = 'FAILED', locked_until = null, next_attempt_at = 'infinity', last_error = left(p_message, 1000) where idempotency_key = p_key;
  update workflow_runs set status = 'DEAD_LETTERED', finished_at = now(), last_error_class = p_error_class, last_error_message = left(p_message, 500) where id = v_run;
  perform wf_log_event(p_key || ':failed:' || o.attempts, o.correlation_id, null, 'automation.failed', 'project', o.aggregate_id,
    coalesce(o.payload ->> 'invoice_number', o.payload ->> 'project_number'), 'WORKFLOW', o.topic, 'n8n', 'FAILED', p_error_class,
    jsonb_build_object('attempt', o.attempts, 'http_status', p_http_status, 'message', left(p_message, 500), 'may_exist_in_xero', v_uncertain), null);
  if v_xero and v_uncertain then
    -- Not "failed safely": the draft may exist. The approval stays executing until reconciliation settles it.
    update invoices set sync_status = 'UNKNOWN' where id = o.aggregate_id and sync_status is distinct from 'UNKNOWN';
    v_exc := wf_open_exception(v_run, null, o.aggregate_type, o.aggregate_id, coalesce(o.payload ->> 'invoice_number', o.payload ->> 'project_number'), 'AMBIGUOUS_WRITE',
      format('%s: %s: %s may already exist in Xero (the attempts could not prove it either way). It is not retried automatically: reconciliation looks it up by number and settles it, or a person decides. Last error: %s',
             o.topic, o.payload ->> 'invoice_number', o.payload ->> 'xero_invoice_number', left(p_message, 400)), o.attempts);
    return jsonb_build_object('retry', false, 'exception_number', v_exc, 'attempt', o.attempts, 'may_exist_in_xero', true,
      'reason', 'the Xero draft may exist: left UNKNOWN for reconciliation');
  end if;
  if v_xero then
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

-- 4. Reconciliation targets: + uncertain Xero writes bound to the pinned tenant (redefined in place).
create or replace function wf_reconcile_targets(p_run_key text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from reconciliation_runs where run_key = p_run_key and scope is not null) then
    return jsonb_build_object('drive', '[]'::jsonb, 'xero', '[]'::jsonb, 'xero_uncertain', '[]'::jsonb);
  end if;
  return coalesce(wf_reconcile_targets_core(p_run_key), '{}'::jsonb) || jsonb_build_object('xero_uncertain', coalesce((
    select jsonb_agg(jsonb_build_object('key', o.idempotency_key, 'invoice_number', i.invoice_number, 'project_number', p.project_number,
             'xero_invoice_number', o.payload ->> 'xero_invoice_number', 'reference', o.payload ->> 'reference', 'tenant_id', o.payload ->> 'xero_tenant_id')
             order by i.invoice_number)
      from invoices i join outbox o on o.aggregate_id = i.id and o.topic = 'xero.create_draft_invoice' join projects p on p.id = i.project_id
     where i.sync_status = 'UNKNOWN' and o.status not in ('DONE', 'DISPATCHING')   -- a write 05 holds is left to 05
       and o.payload ->> 'xero_tenant_id' = (select nullif(value, '') from app_settings where key = 'xero.demo_tenant_id')
       and exists (select 1 from reconciliation_runs where run_key = p_run_key and status = 'RUNNING')), '[]'::jsonb));
end $$;

-- 5. Settle uncertain Xero writes from 07's lookups. Each item: { key, invoice_number, tenant_id, http_number,
--    http_reference, error, by_number: [...], by_reference: [...] } (Xero invoices as GET /Invoices returns them, from
--    the tenant named in tenant_id; http_* null when the request got no answer).
create or replace function wf_reconcile_xero_uncertain(p_run_key text, p_results jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run reconciliation_runs; x jsonb; o outbox; i invoices; v_pin text := (select nullif(value, '') from app_settings where key = 'xero.demo_tenant_id');
  v_num jsonb; v_live jsonb; v_other jsonb; d jsonb; v_outcome text; v_detail text; v_applied boolean; v_repair boolean;
  v_contact text; v_dead boolean; e record; v_items jsonb := '[]'; v_rec int := 0; v_abs int := 0; v_person int := 0; v_skip int := 0;
begin
  select * into v_run from reconciliation_runs where run_key = p_run_key and status = 'RUNNING';
  if v_run.id is null then return jsonb_build_object('ok', false, 'reason', 'no running reconciliation ' || coalesce(p_run_key, '')); end if;
  v_repair := v_run.mode = 'repair';
  for x in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    v_applied := false; v_detail := null;
    select * into o from outbox where idempotency_key = x ->> 'key' and topic = 'xero.create_draft_invoice' for update;
    select * into i from invoices where id = o.aggregate_id for update;
    if o.id is null or i.id is null then
      v_outcome := 'UNKNOWN_KEY';
    elsif i.sync_status <> 'UNKNOWN' or o.status in ('DONE', 'DISPATCHING') then
      v_outcome := 'SKIPPED';                              -- already settled, or 05 is working on it right now
    elsif x ->> 'tenant_id' is distinct from o.payload ->> 'xero_tenant_id' or o.payload ->> 'xero_tenant_id' is distinct from v_pin then
      v_outcome := 'WRONG_TENANT';                         -- only a lookup in the bound, pinned tenant can settle it (AC-06)
      v_detail := format('%s: Xero was asked about %s in tenant %s, but the write is bound to %s and the pinned tenant is %s. Not settled; it stays uncertain. A person must check why',
        i.invoice_number, o.payload ->> 'xero_invoice_number', coalesce(left(x ->> 'tenant_id', 8) || '…', 'no tenant'),
        coalesce(left(o.payload ->> 'xero_tenant_id', 8) || '…', 'no tenant'), coalesce(left(v_pin, 8) || '…', 'none'));
      if v_repair then
        perform wf_open_sync_exception('reconciliation', 'invoice', i.id, i.invoice_number, 'PERMISSION_DENIED', v_detail);
        v_applied := true;
      end if;
      insert into reconciliation_findings (run_id, system, entity_type, entity_ref, classification, action, detail)
      values (v_run.id, 'XERO', 'invoice', i.invoice_number, 'UNAUTHORIZED_STATE', case when v_repair then 'EXCEPTION_OPENED' else 'NONE_OBSERVE_ONLY' end, v_detail);
    elsif coalesce((x ->> 'http_number')::int, (x ->> 'http')::int, 0) <> 200 or coalesce((x ->> 'http_reference')::int, (x ->> 'http')::int, 0) <> 200 then
      v_outcome := 'LOOKUP_FAILED';
    else
      select coalesce(jsonb_agg(y), '[]') into v_num from jsonb_array_elements(coalesce(x -> 'by_number', '[]')) y
       where y ->> 'InvoiceNumber' = o.payload ->> 'xero_invoice_number';
      select coalesce(jsonb_agg(y), '[]') into v_live from jsonb_array_elements(v_num) y where coalesce(y ->> 'Status', '') not in ('DELETED', 'VOIDED');
      select coalesce(jsonb_agg(y), '[]') into v_other from jsonb_array_elements(coalesce(x -> 'by_reference', '[]')) y
       where y ->> 'Reference' = o.payload ->> 'reference' and y ->> 'InvoiceNumber' is distinct from o.payload ->> 'xero_invoice_number'
         and coalesce(y ->> 'Status', '') not in ('DELETED', 'VOIDED');
      select external_id into v_contact from external_links
       where provider = 'XERO' and entity_type = 'customer' and entity_id = (o.payload ->> 'customer_id')::uuid and external_type = 'Contact';
      d := v_live -> 0;
      if jsonb_array_length(v_num) = 0 and jsonb_array_length(v_other) = 0 then
        v_outcome := 'PROVEN_ABSENT';
      elsif jsonb_array_length(v_num) = 1 and jsonb_array_length(v_live) = 1 and jsonb_array_length(v_other) = 0 and i.status <> 'VOIDED'
            and d ->> 'Reference' = o.payload ->> 'reference' and d ->> 'Type' = 'ACCREC' and d ->> 'Status' = 'DRAFT'
            and (d ->> 'Total')::numeric = (o.payload ->> 'amount_inc_gst')::numeric and (d ->> 'TotalTax')::numeric = (o.payload ->> 'gst_amount')::numeric
            and coalesce((d ->> 'AmountPaid')::numeric, -1) = 0
            and not coalesce((d ->> 'SentToContact')::boolean, false)   -- GET /Invoices omits it unless true (seen live); a DRAFT cannot be sent
            and d ->> 'CurrencyCode' = 'AUD' and d ->> 'LineAmountTypes' = 'Inclusive'
            and coalesce(d ->> 'InvoiceID', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            and coalesce(d -> 'Contact' ->> 'ContactID', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            and (v_contact is null or v_contact = d -> 'Contact' ->> 'ContactID')
            and not exists (select 1 from external_links where provider = 'XERO' and external_type = 'Invoice' and external_id = d ->> 'InvoiceID') then
        v_outcome := 'RECOVERED';
      else
        v_outcome := 'NEEDS_PERSON';
        v_detail := format('%s: reconciliation cannot tell which Xero invoice is RoofOps''s %s, so nothing was linked: %s with its number (%s), %s other live invoice(s) with reference %s%s. A person must check Xero (tenant %s…) and decide',
          i.invoice_number, o.payload ->> 'xero_invoice_number', jsonb_array_length(v_num),
          coalesce((select string_agg(coalesce(y ->> 'Status', '?') || ' ' || coalesce(y ->> 'Total', '?'), ', ') from jsonb_array_elements(v_num) y), 'none'),
          jsonb_array_length(v_other), o.payload ->> 'reference',
          case when jsonb_array_length(v_num) = 1 and jsonb_array_length(v_live) = 1 and jsonb_array_length(v_other) = 0 then ' (it differs from the approved draft)' else '' end,
          left(v_pin, 8));
      end if;
      v_dead := o.status = 'FAILED' and o.next_attempt_at = 'infinity';
      if v_repair and v_outcome = 'RECOVERED' then
        insert into external_links (provider, entity_type, entity_id, external_type, external_id, external_url, last_synced_at, verified_at)
        values ('XERO', 'invoice', o.aggregate_id, 'Invoice', d ->> 'InvoiceID', 'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=' || (d ->> 'InvoiceID'), now(), now()),
               ('XERO', 'customer', (o.payload ->> 'customer_id')::uuid, 'Contact', d -> 'Contact' ->> 'ContactID',
                'https://go.xero.com/Contacts/View/' || (d -> 'Contact' ->> 'ContactID'), now(), now())
        on conflict (provider, entity_type, entity_id, external_type) do update set verified_at = now(), last_synced_at = now();
        update invoices set sync_status = 'SYNCED' where id = i.id;
        update outbox set status = 'DONE', dispatched_at = now(), locked_until = null,
               result = jsonb_build_object('recovered_by', p_run_key, 'tenant_id', x ->> 'tenant_id', 'invoice_id', d ->> 'InvoiceID', 'invoice_number', d ->> 'InvoiceNumber',
                 'reference', d ->> 'Reference', 'status', d ->> 'Status', 'total', d -> 'Total', 'total_tax', d -> 'TotalTax', 'contact_id', d -> 'Contact' ->> 'ContactID')
         where id = o.id;
        update approvals set status = 'EXECUTED', executed_at = now(), execution_result = jsonb_build_object('recovered_by', p_run_key, 'invoice_id', d ->> 'InvoiceID')
         where id = i.approval_id and status = 'EXECUTING';
        insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, external_reference, reason, correlation_id)
        values ('SYSTEM', 'workflow:reconciliation', 'xero.invoice.draft_recovered', 'invoice', i.id, i.invoice_number, jsonb_build_object('sync_status', 'UNKNOWN'),
                jsonb_build_object('sync_status', 'SYNCED', 'invoice_id', d ->> 'InvoiceID'), d ->> 'InvoiceID',
                format('Reconciliation %s found exactly one matching draft %s in the pinned Xero tenant and linked it', p_run_key, d ->> 'InvoiceNumber'), o.correlation_id);
        v_applied := true; v_rec := v_rec + 1;
      elsif v_repair and v_outcome = 'PROVEN_ABSENT' then
        if v_dead then
          update invoices set sync_status = 'FAILED' where id = i.id;
          update approvals set status = 'EXECUTION_FAILED', executed_at = now(),
                 execution_result = jsonb_build_object('proven_absent_by', p_run_key, 'message', 'no Xero draft exists; failed safely')
           where id = i.approval_id and status = 'EXECUTING';
          perform wf_open_sync_exception('project_to_invoice', 'invoice', i.id, i.invoice_number, 'INVALID_STATE',
            format('%s: failed safely. Reconciliation proved %s does not exist in Xero. It can be re-queued (ops/requeue-dead-lettered-side-effect.sql) or a person decides',
                   i.invoice_number, o.payload ->> 'xero_invoice_number'));
        else
          update invoices set sync_status = 'PENDING' where id = i.id;   -- the scheduled retry may go ahead (05 searches again first)
        end if;
        v_applied := true; v_abs := v_abs + 1;
      elsif v_repair and v_outcome = 'NEEDS_PERSON' then
        perform wf_open_sync_exception('reconciliation', 'invoice', i.id, i.invoice_number, 'RECONCILIATION_MISMATCH', v_detail);
        v_applied := true; v_person := v_person + 1;
      elsif v_outcome = 'NEEDS_PERSON' then
        v_person := v_person + 1;
      end if;
      if v_applied and v_outcome in ('RECOVERED', 'PROVEN_ABSENT') then
        -- The "may already exist" exception is answered either way.
        for e in select id, exception_number from workflow_exceptions
                  where (entity_id = i.id or business_reference = i.invoice_number) and error_class = 'AMBIGUOUS_WRITE' and resolution_status in ('OPEN', 'RETRY_QUEUED') for update loop
          update workflow_exceptions set resolution_status = 'RESOLVED', resolved_at = now(), resolved_by_system = 'workflow:reconciliation',
                 resolution_note = format('Reconciliation %s %s', p_run_key, case v_outcome when 'RECOVERED' then 'found and linked the draft' else 'proved the draft does not exist' end)
           where id = e.id;
          insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
          values ('SYSTEM', 'workflow:reconciliation', 'exception.resolved', 'workflow_exception', e.id, e.exception_number,
                  '{"resolution_status":"OPEN"}', '{"resolution_status":"RESOLVED"}',
                  format('Reconciliation %s settled uncertain Xero write %s: %s', p_run_key, i.invoice_number, lower(v_outcome)));
        end loop;
      end if;
      if not v_repair then
        v_outcome := case v_outcome when 'RECOVERED' then 'WOULD_RECOVER' when 'PROVEN_ABSENT' then 'WOULD_PROVE_ABSENT' else v_outcome end;
      end if;
      insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
      values (v_run.id, 'XERO', 'invoice', i.invoice_number, d ->> 'InvoiceID',
              case when v_outcome in ('NEEDS_PERSON') then 'REQUIRES_HUMAN' else 'SAFE_AUTO_REPAIR' end,
              case when not v_repair then 'NONE_OBSERVE_ONLY' when v_outcome = 'NEEDS_PERSON' then 'EXCEPTION_OPENED' else 'APPLIED_TO_POSTGRES' end,
              coalesce(v_detail, format('Uncertain Xero write %s: %s', i.invoice_number, lower(v_outcome))));
    end if;
    if v_outcome in ('SKIPPED', 'UNKNOWN_KEY') then v_skip := v_skip + 1; end if;
    v_items := v_items || jsonb_build_object('invoice_number', coalesce(i.invoice_number, x ->> 'invoice_number'), 'outcome', v_outcome, 'applied', v_applied);
  end loop;
  update reconciliation_runs set summary = summary || jsonb_build_object('xero_uncertain', jsonb_build_object('checked', jsonb_array_length(coalesce(p_results, '[]'::jsonb)),
         'recovered', v_rec, 'proven_absent', v_abs, 'needs_person', v_person, 'skipped', v_skip)) where id = v_run.id;
  return jsonb_build_object('ok', true, 'checked', jsonb_array_length(coalesce(p_results, '[]'::jsonb)), 'recovered', v_rec, 'proven_absent', v_abs,
    'needs_person', v_person, 'skipped', v_skip, 'items', v_items);
end $$;

revoke execute on all functions in schema public from public;
revoke execute on function xero_failure_evidence(text, text, int) from roofops_workflow, roofops_dashboard;
grant execute on function wf_reconcile_xero_uncertain(text, jsonb) to roofops_workflow;
