-- Quote publishing lifecycle (Factory review of 920e274). No earlier migration file is edited; redefined objects are
-- copied verbatim from their latest definitions and changed only where marked "Quote publishing lifecycle".
--
-- The Airtable Web API has no conditional write: an update or upsert cannot say "only if the record is still as I read
-- it". A worker that is already sending a request cannot be stopped by anything Postgres does later. So the rules are
-- made true by what is written, not by timing:
--  L1. A quote is published once, as sent. A SENT quote is final (web_quote_save refuses QUOTE_SENT_FINAL); a different
--      price is a new quote with its own number and Airtable record. One hand-off per quote; the database allows at most
--      one open (20261017050000).
--  L2. n8n 10 never changes an existing Airtable quote record. It looks the quote up by RoofOps ID and number: none, it
--      creates the record with every field and Status Sent; one, it writes nothing; more, it stops for a person
--      (AMBIGUOUS_WRITE). So no write, early or late, can replace a newer version or put Sent over Accepted; a late
--      worker can at worst add a duplicate record, which every later look-up sees and reports.
--  L3. DONE only on what Airtable holds, read back after the write: exactly one quote record, its RoofOps ID, number,
--      version, amount, links and a valid Status (Sent, Accepted, Lost or Expired), and the customer and property records.
--  L4. A report counts only from the attempt that holds the hand-off (fencing by attempt number, which only ever grows):
--      a late worker cannot mark it DONE, schedule a retry or stop it. A duplicate it saw still reaches a person.
--  L5. Re-queue (ops/requeue-quote-publish.sql): only the quote's latest hand-off, stopped, for the quote's current version,
--      while the quote is SENT and nothing else of it is open.

create or replace function web_quote_save(p_token text, p_lead text, p_quote text, p_expected_version int, p_job_type text, p_amount_type text,
                                          p_scope text, p_lines jsonb, p_request_key text)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare
  v_emp employees := staff_session_employee(p_token); l leads; q quotes; v quote_versions; v_problem jsonb; v_next int; ins inspections;
  v_scope text := nullif(btrim(coalesce(p_scope, '')), '');
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT'); end if;
  if not staff_role_allowed(v_emp, 'sales.roles') then return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED', 'detail', format('%s (%s) may not prepare quotes', v_emp.employee_code, v_emp.role)); end if;
  if length(coalesce(p_request_key, '')) not between 8 and 100 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'missing request key'); end if;
  if coalesce(p_job_type, '') not in ('LEAK_REPAIR', 'ROOF_RESTORATION', 'ROOF_REPLACEMENT', 'FULL_REROOF', 'EXTENSION_ROOF', 'STORM_DAMAGE_REPAIR') then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'choose the kind of job');
  end if;
  -- Only prices that include GST: the invoice and Xero path is GST-inclusive end to end (invoice_final_preview refuses
  -- anything else, but only at invoicing, after the job is done). Refusing here keeps an unsupported quote out of the
  -- financial process entirely.
  if coalesce(p_amount_type, '') <> 'INCLUSIVE' then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'prices must include GST (GST-exclusive and GST-free quotes cannot be invoiced yet)'); end if;
  if length(coalesce(v_scope, '')) > 4000 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'the scope is too long'); end if;
  v_problem := quote_lines_problem(p_lines);
  if v_problem is not null then return jsonb_build_object('ok', false) || v_problem; end if;

  if nullif(btrim(coalesce(p_quote, '')), '') is null then   -- a new quote from an enquiry
    select * into q from quotes where request_key = p_request_key;
    if q.id is not null then return jsonb_build_object('ok', true, 'duplicate', true, 'quote_number', q.quote_number); end if;
    select * into l from leads where lead_number = upper(btrim(coalesce(p_lead, ''))) for update;
    if l.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', coalesce(p_lead, 'no enquiry')); end if;
    if l.customer_id is null or l.property_id is null then return jsonb_build_object('ok', false, 'code', 'NOT_CONVERTED', 'detail', 'record the customer and the site first'); end if;
    if l.status in ('LOST', 'DISQUALIFIED', 'WON') then return jsonb_build_object('ok', false, 'code', 'INVALID_TRANSITION', 'detail', format('%s is %s', l.lead_number, lower(l.status))); end if;
    if exists (select 1 from quotes x where x.lead_id = l.id and x.status in ('DRAFT', 'SENT')) then
      return jsonb_build_object('ok', false, 'code', 'ALREADY_QUOTED', 'detail', 'this enquiry already has an open quote; revise that one');
    end if;
    select * into ins from inspections where lead_id = l.id and status = 'COMPLETED' order by inspected_on desc, created_at desc limit 1;
    insert into quotes (quote_number, customer_id, property_id, inspection_id, lead_id, lead_source, estimator_id, job_type, status, created_on, request_key)
    values (next_friendly_id('Q', extract(year from app_today())::int), l.customer_id, l.property_id, ins.id, l.id, l.source, v_emp.id, p_job_type, 'DRAFT', app_today(), p_request_key)
    returning * into q;
    v := quote_insert_version(q.id, 1, p_amount_type, v_scope, p_lines, v_emp.id);
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
    values ('USER', v_emp.employee_code, 'quote.drafted', 'quote', q.id, q.quote_number,
            jsonb_build_object('lead', l.lead_number, 'version', 1, 'total_inc_gst', v.total_inc_gst), format('Quote %s drafted for %s', q.quote_number, l.lead_number));
  else   -- a revision: a new version of a draft quote
    select * into q from quotes where quote_number = upper(btrim(p_quote)) for update;
    if q.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', p_quote); end if;
    if exists (select 1 from audit_events a where a.action = 'quote.revised' and a.entity_id = q.id and a.after_state ->> 'request_key' = p_request_key) then
      return jsonb_build_object('ok', true, 'duplicate', true, 'quote_number', q.quote_number);
    end if;
    if p_expected_version is distinct from q.record_version then return jsonb_build_object('ok', false, 'code', 'STALE', 'detail', format('%s changed since you opened it; reload and check it again', q.quote_number)); end if;
    if q.status not in ('DRAFT', 'SENT') then return jsonb_build_object('ok', false, 'code', 'INVALID_TRANSITION', 'detail', format('%s is %s: it cannot change', q.quote_number, lower(q.status))); end if;
    -- Quote publishing lifecycle (20261017060000): a SENT quote is final. It went to the customer and to Airtable as one
    -- version; Airtable cannot refuse a stale write, so a second version of the same Airtable record could be overwritten
    -- by (or overwrite) the first. A different price is a new quote (new number, new Airtable record).
    if q.status = 'SENT' then
      return jsonb_build_object('ok', false, 'code', 'QUOTE_SENT_FINAL', 'detail', format('%s was sent and cannot change. For a different price, mark it Lost in Airtable and record a new enquiry for the customer', q.quote_number));
    end if;
    select coalesce(max(version_number), 0) + 1 into v_next from quote_versions where quote_id = q.id;
    v := quote_insert_version(q.id, v_next, p_amount_type, v_scope, p_lines, v_emp.id);
    update quotes set job_type = p_job_type, record_version = record_version + 1, updated_at = now() where id = q.id returning * into q;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
    values ('USER', v_emp.employee_code, 'quote.revised', 'quote', q.id, q.quote_number,
            jsonb_build_object('version', v_next, 'total_inc_gst', v.total_inc_gst, 'request_key', p_request_key, 'republished', q.status = 'SENT'),
            format('Quote %s version %s', q.quote_number, v_next) || case when q.status = 'SENT' then ' (sent again to Airtable)' else '' end);
  end if;
  return jsonb_build_object('ok', true, 'quote_number', q.quote_number, 'version', v.version_number, 'status', q.status,
                            'total_inc_gst', v.total_inc_gst, 'gst_amount', v.gst_amount, 'record_version', q.record_version);
end $$;

-- web_quote_save no longer writes write_status; nothing else used this.
drop function if exists quote_publish_may_write_status(uuid);

create or replace function wf_complete_side_effect(p_key text, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare o outbox; v_inv invoices; v_pin text; v_bound text; v_draft text; v_from text;
begin
  select * into o from outbox where idempotency_key = p_key;
  if o.topic = 'xero.create_draft_invoice' then
    select * into v_inv from invoices where id = o.aggregate_id;
    if v_inv.status = 'VOIDED' then
      -- Refused like any bad proof: 05 records the failure (dead letter + exception) and tells Airtable nothing was linked.
      raise exception '% is voided: the Xero draft % was not linked. Void or delete it in Xero', v_inv.invoice_number,
        coalesce(p_result ->> 'invoice_number', o.payload ->> 'xero_invoice_number') using errcode = 'check_violation';
    end if;
    if o.status <> 'DONE' then
      select value into v_pin from app_settings where key = 'xero.demo_tenant_id';
      v_bound := nullif(o.payload ->> 'xero_tenant_id', '');
      v_draft := coalesce(p_result ->> 'invoice_number', o.payload ->> 'xero_invoice_number');
      v_from := coalesce(left(p_result ->> 'tenant_id', 8) || '…', 'an unnamed tenant');
      if v_bound is null then
        raise exception '% carries no Xero tenant: the Xero draft % read back from tenant % was not linked. A person must check it in that tenant',
          v_inv.invoice_number, v_draft, v_from using errcode = 'check_violation';
      elsif coalesce(v_pin, '') = '' then
        raise exception '%: no Xero tenant is pinned now (it was approved for tenant %…): the Xero draft % read back from tenant % was not linked. A person must check it in that tenant',
          v_inv.invoice_number, left(v_bound, 8), v_draft, v_from using errcode = 'check_violation';
      elsif v_pin <> v_bound then
        raise exception '%: the pinned Xero tenant changed from %… to %… while the draft was written: the Xero draft % read back from tenant % was not linked. A person must check it in that tenant',
          v_inv.invoice_number, left(v_bound, 8), left(v_pin, 8), v_draft, v_from using errcode = 'check_violation';
      end if;
      -- A proof from another tenant than the bound (and pinned) one is refused by the core check.
      -- AC-14C P2-D2: a generation >= 2 draft is linked only as the proven reissue, and never to a superseded InvoiceID.
      if o.generation >= 2 then
        v_from := xero_reissue_proof(o);
        if v_from is not null then
          raise exception '%: the generation % Xero draft % was not linked: %', v_inv.invoice_number, o.generation, v_draft, v_from using errcode = 'check_violation';
        end if;
        if exists (select 1 from invoice_xero_draft_generations g where g.invoice_id = o.aggregate_id and g.superseded_at is not null
                      and g.xero_invoice_id = p_result ->> 'invoice_id') then
          raise exception '%: % is a superseded Xero invoice (an earlier generation); it cannot be linked as generation %',
            v_inv.invoice_number, p_result ->> 'invoice_id', o.generation using errcode = 'check_violation';
        end if;
      end if;
    end if;
  end if;
  -- Quote publishing lifecycle (20261017060000): the report must come from the attempt that holds the hand-off now (a
  -- worker whose lease ran out and whose hand-off was claimed again is late: it records nothing), and Airtable must hold
  -- exactly one record for the quote, with a valid Status. The record checks themselves are in the core.
  if o.topic = 'airtable.quote_publish' and o.status = 'DISPATCHING' then
    if coalesce(p_result ->> 'attempt', '') !~ '^[0-9]{1,9}$' or (p_result ->> 'attempt')::int <> o.attempts then
      raise exception 'quote hand-off % is held by attempt %; a report from attempt % is late and records nothing', p_key, o.attempts,
        coalesce(p_result ->> 'attempt', '(none)') using errcode = 'check_violation';
    end if;
    if coalesce(p_result ->> 'quote_record_count', '') is distinct from '1' then
      raise exception 'Airtable holds % quote records for %; exactly one is required', coalesce(p_result ->> 'quote_record_count', 'an unknown number of'),
        o.payload ->> 'quote_number' using errcode = 'check_violation';
    end if;
    if jsonb_typeof(p_result -> 'quote_read_back') = 'object'   -- no read-back at all is refused by the core
       and coalesce(p_result -> 'quote_read_back' ->> 'status', '') not in (select label from state_machine_states where machine = 'quote' and state in ('SENT', 'ACCEPTED', 'LOST', 'EXPIRED')) then
      raise exception 'the Airtable quote record for % has Status "%", not a status of a sent quote', o.payload ->> 'quote_number',
        coalesce(p_result -> 'quote_read_back' ->> 'status', '') using errcode = 'check_violation';
    end if;
  end if;
  return wf_complete_side_effect_core(p_key, p_result);
end $$;

-- wf_quote_publish_fail gains the attempt that reports (L4): the earlier form had none, so it is replaced, not overloaded.
drop function if exists wf_quote_publish_fail(text, text, text, int, int);
create function wf_quote_publish_fail(p_key text, p_error_class text, p_message text, p_http_status int, p_retry_after_seconds int, p_attempt int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o outbox; v_retryable boolean; v_delay int; v_exc text; v_ref text; v_msg text; v_late boolean;
  v_max int := coalesce((select value::int from app_settings where key = 'wf.side_effect.max_attempts'), 5);
begin
  select * into o from outbox where idempotency_key = p_key for update;
  if not found or o.topic <> 'airtable.quote_publish' then raise exception 'unknown quote hand-off %', p_key using errcode = 'no_data_found'; end if;
  select retryable into v_retryable from error_classes where code = p_error_class;
  if v_retryable is null then raise exception 'unknown error class %', p_error_class using errcode = 'foreign_key_violation'; end if;
  v_ref := o.payload ->> 'quote_number';
  v_late := o.status <> 'DISPATCHING' or p_attempt is distinct from o.attempts;
  if v_late then
    -- A late worker (its hand-off finished, stopped or held by a newer attempt): the hand-off is not touched. What it saw
    -- is logged; a duplicate Airtable record (AMBIGUOUS_WRITE) still needs a person, so it reaches the quote's exception.
    perform wf_log_event(p_key || ':late:' || coalesce(p_attempt::text, 'none') || ':' || p_error_class, o.correlation_id, null, 'automation.late_report',
      'quote', o.aggregate_id, v_ref, 'WORKFLOW', o.topic, 'n8n', 'FAILED', p_error_class,
      jsonb_build_object('reported_attempt', p_attempt, 'holding_attempt', o.attempts, 'handoff_status', o.status, 'message', left(p_message, 500)), null);
    if p_error_class <> 'AMBIGUOUS_WRITE' then
      return jsonb_build_object('retry', false, 'late', true, 'attempt', p_attempt, 'holding_attempt', o.attempts, 'status', o.status);
    end if;
    v_msg := format('%s: a late attempt (%s) of %s found more than one Airtable quote record; nothing was changed in Postgres. A person must keep one record and delete the others. Last error: %s',
             o.topic, coalesce(p_attempt::text, 'unknown'), v_ref, left(p_message, 400));
  elsif v_retryable and o.attempts < v_max then
    v_delay := coalesce(p_retry_after_seconds, least(900, 60 * (2 ^ (o.attempts - 1))::int));   -- 1, 2, 4, 8 minutes … capped at 15
    update outbox set status = 'FAILED', locked_until = null, next_attempt_at = now() + make_interval(secs => v_delay),
           last_error = left(p_message, 1000) where id = o.id;
    perform wf_log_event(p_key || ':retry:' || o.attempts, o.correlation_id, null, 'automation.retry_scheduled', 'quote', o.aggregate_id, v_ref,
      'WORKFLOW', o.topic, 'n8n', 'FAILED', p_error_class,
      jsonb_build_object('attempt', o.attempts, 'retry_in_seconds', v_delay, 'http_status', p_http_status, 'message', left(p_message, 500)), null);
    return jsonb_build_object('retry', true, 'retry_in_seconds', v_delay, 'attempt', o.attempts, 'max_attempts', v_max);
  else
    update outbox set status = 'FAILED', locked_until = null, next_attempt_at = 'infinity', last_error = left(p_message, 1000) where id = o.id;
    perform wf_log_event(p_key || ':failed:' || o.attempts, o.correlation_id, null, 'automation.failed', 'quote', o.aggregate_id, v_ref,
      'WORKFLOW', o.topic, 'n8n', 'FAILED', p_error_class,
      jsonb_build_object('attempt', o.attempts, 'http_status', p_http_status, 'message', left(p_message, 500)), null);
    v_msg := format('%s: %s was not added to Airtable after %s attempt(s) and is not retried; nothing was marked done. Fix the cause, then re-queue it (ops/requeue-quote-publish.sql). Last error: %s',
             o.topic, v_ref, o.attempts, left(p_message, 400));
  end if;
  -- One open exception per quote (20261017050000): a later failure updates that one.
  select exception_number into v_exc from workflow_exceptions
   where entity_type = 'quote' and entity_id = o.aggregate_id and resolution_status in ('OPEN', 'RETRY_QUEUED') and error_message like 'airtable.quote_publish:%'
   order by first_failed_at, exception_number limit 1 for update;
  if v_exc is not null then
    update workflow_exceptions set error_class = p_error_class, error_message = v_msg, attempt_count = greatest(attempt_count, o.attempts),
           last_attempt_at = now(), resolution_status = 'OPEN' where exception_number = v_exc;
  else
    v_exc := wf_open_exception(null, null, 'quote', o.aggregate_id, v_ref, p_error_class, v_msg, o.attempts);
  end if;
  return jsonb_build_object('retry', false, 'exception_number', v_exc, 'attempt', o.attempts, 'late', v_late,
    'reason', case when v_late then 'duplicate Airtable records seen by a late attempt' when v_retryable then 'max attempts reached' else 'non-retryable error class' end);
end $$;
revoke all on function wf_quote_publish_fail(text, text, text, int, int, int) from public;
grant execute on function wf_quote_publish_fail(text, text, text, int, int, int) to roofops_workflow;
