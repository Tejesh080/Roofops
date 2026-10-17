-- Rollback of 20261017050000_quote_handoff_versions.sql (owner only; one transaction). Roll this back FIRST (before 20261017040000).
-- Stop n8n 10 first. Restores web_quote_save, wf_quote_publish_fail and v_dashboard_quotes exactly as they were before it
-- (copied verbatim from a database migrated to 20261017040000) and drops quote_publish_may_write_status and the one-open-
-- hand-off index. Every record stays: hand-offs (including stopped, superseded ones), exceptions and quotes.
-- Run: npx tsx scripts/sql.ts -f ops/rollback/20261017050000_quote_handoff_versions.down.sql
begin;
CREATE OR REPLACE FUNCTION public.web_quote_save(p_token text, p_lead text, p_quote text, p_expected_version integer, p_job_type text, p_amount_type text, p_scope text, p_lines jsonb, p_request_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'extensions', 'public', 'pg_temp'
AS $function$
declare
  v_emp employees := staff_session_employee(p_token); l leads; q quotes; v quote_versions; v_problem jsonb; v_next int; ins inspections; v_ho outbox;
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
  else   -- a revision: a new version of a draft or sent quote
    select * into q from quotes where quote_number = upper(btrim(p_quote)) for update;
    if q.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', p_quote); end if;
    if exists (select 1 from audit_events a where a.action = 'quote.revised' and a.entity_id = q.id and a.after_state ->> 'request_key' = p_request_key) then
      return jsonb_build_object('ok', true, 'duplicate', true, 'quote_number', q.quote_number);
    end if;
    if p_expected_version is distinct from q.record_version then return jsonb_build_object('ok', false, 'code', 'STALE', 'detail', format('%s changed since you opened it; reload and check it again', q.quote_number)); end if;
    if q.status not in ('DRAFT', 'SENT') then return jsonb_build_object('ok', false, 'code', 'INVALID_TRANSITION', 'detail', format('%s is %s: it cannot change', q.quote_number, lower(q.status))); end if;
    -- Sales reliability: a SENT quote is in Airtable (or on its way). Not while n8n 10 is writing it: that run would
    -- finish with the previous version. A run that died (lease over) does not block.
    if q.status = 'SENT' and exists (select 1 from outbox o where o.topic = 'airtable.quote_publish' and o.aggregate_id = q.id
                                       and o.status = 'DISPATCHING' and o.locked_until > now()) then
      return jsonb_build_object('ok', false, 'code', 'HANDOFF_IN_PROGRESS', 'detail', format('%s is being added to Airtable right now; try again in a minute', q.quote_number));
    end if;
    select coalesce(max(version_number), 0) + 1 into v_next from quote_versions where quote_id = q.id;
    v := quote_insert_version(q.id, v_next, p_amount_type, v_scope, p_lines, v_emp.id);
    update quotes set job_type = p_job_type, record_version = record_version + 1, updated_at = now() where id = q.id returning * into q;
    -- The revision goes to Airtable as the new version and amount (the same rows, found by RoofOps ID). Acceptance takes
    -- the version Airtable shows, and accepts only the current one, so until this lands the old version is refused.
    -- A hand-off not finished yet carries the new payload; a finished one (DONE is final) is followed by a new hand-off
    -- for this version, whose first attempt writes Status Sent with it (Airtable then shows the true state: this version
    -- sent). Retries of either never write Status (n8n 10), so an Accepted made in Airtable is not put back to Sent.
    if q.status = 'SENT' then
      select * into v_ho from outbox o where o.topic = 'airtable.quote_publish' and o.aggregate_id = q.id order by o.created_at desc limit 1 for update;
      if v_ho.id is not null and v_ho.status <> 'DONE' then
        update outbox set payload = quote_publish_payload(q.id), status = 'PENDING', next_attempt_at = now(), locked_until = null, last_error = null where id = v_ho.id;
      else
        insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload)
        values ('airtable.quote_publish', 'quote', q.id, gen_random_uuid(), 'airtable:quote-publish:' || q.id || ':v' || v_next, quote_publish_payload(q.id));
      end if;
    end if;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
    values ('USER', v_emp.employee_code, 'quote.revised', 'quote', q.id, q.quote_number,
            jsonb_build_object('version', v_next, 'total_inc_gst', v.total_inc_gst, 'request_key', p_request_key, 'republished', q.status = 'SENT'),
            format('Quote %s version %s', q.quote_number, v_next) || case when q.status = 'SENT' then ' (sent again to Airtable)' else '' end);
  end if;
  return jsonb_build_object('ok', true, 'quote_number', q.quote_number, 'version', v.version_number, 'status', q.status,
                            'total_inc_gst', v.total_inc_gst, 'gst_amount', v.gst_amount, 'record_version', q.record_version);
end $function$;

CREATE OR REPLACE FUNCTION public.wf_quote_publish_fail(p_key text, p_error_class text, p_message text, p_http_status integer DEFAULT NULL::integer, p_retry_after_seconds integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  o outbox; v_retryable boolean; v_delay int; v_exc text; v_ref text;
  v_max int := coalesce((select value::int from app_settings where key = 'wf.side_effect.max_attempts'), 5);
begin
  select * into o from outbox where idempotency_key = p_key for update;
  if not found or o.topic <> 'airtable.quote_publish' then raise exception 'unknown quote hand-off %', p_key using errcode = 'no_data_found'; end if;
  if o.status <> 'DISPATCHING' then raise exception 'quote hand-off % is %, not claimed', p_key, o.status using errcode = 'check_violation'; end if;
  select retryable into v_retryable from error_classes where code = p_error_class;
  if v_retryable is null then raise exception 'unknown error class %', p_error_class using errcode = 'foreign_key_violation'; end if;
  v_ref := o.payload ->> 'quote_number';
  if v_retryable and o.attempts < v_max then
    v_delay := coalesce(p_retry_after_seconds, least(900, 60 * (2 ^ (o.attempts - 1))::int));   -- 1, 2, 4, 8 minutes … capped at 15
    update outbox set status = 'FAILED', locked_until = null, next_attempt_at = now() + make_interval(secs => v_delay),
           last_error = left(p_message, 1000) where id = o.id;
    perform wf_log_event(p_key || ':retry:' || o.attempts, o.correlation_id, null, 'automation.retry_scheduled', 'quote', o.aggregate_id, v_ref,
      'WORKFLOW', o.topic, 'n8n', 'FAILED', p_error_class,
      jsonb_build_object('attempt', o.attempts, 'retry_in_seconds', v_delay, 'http_status', p_http_status, 'message', left(p_message, 500)), null);
    return jsonb_build_object('retry', true, 'retry_in_seconds', v_delay, 'attempt', o.attempts, 'max_attempts', v_max);
  end if;
  update outbox set status = 'FAILED', locked_until = null, next_attempt_at = 'infinity', last_error = left(p_message, 1000) where id = o.id;
  perform wf_log_event(p_key || ':failed:' || o.attempts, o.correlation_id, null, 'automation.failed', 'quote', o.aggregate_id, v_ref,
    'WORKFLOW', o.topic, 'n8n', 'FAILED', p_error_class,
    jsonb_build_object('attempt', o.attempts, 'http_status', p_http_status, 'message', left(p_message, 500)), null);
  v_exc := wf_open_exception(null, null, 'quote', o.aggregate_id, v_ref, p_error_class,
    format('%s: %s was not added to Airtable after %s attempt(s) and is not retried; nothing was marked done. Fix the cause, then re-queue it (ops/requeue-quote-publish.sql). Last error: %s',
           o.topic, v_ref, o.attempts, left(p_message, 400)), o.attempts);
  return jsonb_build_object('retry', false, 'exception_number', v_exc, 'attempt', o.attempts,
    'reason', case when v_retryable then 'max attempts reached' else 'non-retryable error class' end);
end $function$;

create or replace view public.v_dashboard_quotes as
 SELECT q.quote_number,
    q.status,
    q.job_type,
    q.created_on,
    q.sent_on,
    q.valid_until,
    q.accepted_on,
    q.lost_reason,
    q.record_version,
    l.lead_number,
    c.customer_number,
    c.display_name AS customer_name,
    pr.property_number,
    concat_ws(', '::text, pr.address_line1, pr.suburb, (pr.state || ' '::text) || pr.postcode) AS site,
    e.full_name AS estimator,
    qv.version_number,
    qv.line_amount_type,
    qv.subtotal_ex_gst,
    qv.gst_amount,
    qv.total_inc_gst,
    qv.scope_summary,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('line_no', ln.line_no, 'line_kind', ln.line_kind, 'product_code', pd.product_code, 'description', ln.description, 'quantity', ln.quantity, 'unit', ln.unit, 'unit_price', ln.unit_price, 'line_amount', ln.line_amount) ORDER BY ln.line_no) AS jsonb_agg
           FROM quote_version_lines ln
             LEFT JOIN products pd ON pd.id = ln.product_id
          WHERE ln.quote_version_id = qv.id), '[]'::jsonb) AS lines,
    ( SELECT
                CASE
                    WHEN o.status = 'FAILED'::text AND o.next_attempt_at = 'infinity'::timestamp with time zone THEN 'STOPPED'::text
                    WHEN o.status = 'FAILED'::text THEN 'RETRYING'::text
                    ELSE o.status
                END AS status
           FROM outbox o
          WHERE o.topic = 'airtable.quote_publish'::text AND o.aggregate_id = q.id
          ORDER BY o.created_at DESC
         LIMIT 1) AS airtable_handoff,
    ( SELECT o.last_error
           FROM outbox o
          WHERE o.topic = 'airtable.quote_publish'::text AND o.aggregate_id = q.id
          ORDER BY o.created_at DESC
         LIMIT 1) AS airtable_handoff_error,
    (EXISTS ( SELECT 1
           FROM external_links x
          WHERE x.provider = 'AIRTABLE'::text AND x.entity_type = 'quote'::text AND x.entity_id = q.id AND x.verified_at IS NOT NULL)) AND COALESCE(( SELECT o.status
           FROM outbox o
          WHERE o.topic = 'airtable.quote_publish'::text AND o.aggregate_id = q.id
          ORDER BY o.created_at DESC
         LIMIT 1), 'DONE'::text) = 'DONE'::text AS in_airtable,
    ( SELECT p.project_number
           FROM projects p
          WHERE p.quote_id = q.id) AS project_number
   FROM quotes q
     JOIN customers c ON c.id = q.customer_id
     JOIN properties pr ON pr.id = q.property_id
     JOIN LATERAL ( SELECT v.id,
            v.quote_id,
            v.version_number,
            v.line_amount_type,
            v.gst_rate,
            v.subtotal_ex_gst,
            v.gst_amount,
            v.total_inc_gst,
            v.scope_summary,
            v.created_by,
            v.created_at
           FROM quote_versions v
          WHERE v.quote_id = q.id
          ORDER BY v.version_number DESC
         LIMIT 1) qv ON true
     LEFT JOIN leads l ON l.id = q.lead_id
     LEFT JOIN employees e ON e.id = q.estimator_id;
drop index if exists outbox_one_open_quote_publish;
drop function if exists quote_publish_may_write_status(uuid);
delete from schema_migrations where version = '20261017050000_quote_handoff_versions.sql';
commit;
