-- AC-14 (docs/defect-ledger.md): a RoofOps final invoice could be authorised and paid in Xero, but RoofOps never read
-- that back. 05 creates the draft and proves it; 07 re-read every linked invoice but compared only existence, total and
-- reference. So the invoice stayed APPROVED forever: money owed never counted it, and Completed -> Closed ("every invoice
-- PAID") was unreachable. Hosted: PRJ-2026-0004 (INV-2026-0039, a DRAFT in the Demo Company) is refused with
-- "not every invoice is paid yet: INV-2026-0039 (approved)".
--
-- Canonical mapping, applied only from a VERIFIED Xero read (the linked InvoiceID, read in the write's bound tenant, which
-- is also the pinned one; ACCREC; the expected invoice number and total; AmountPaid + AmountCredited + AmountDue = Total):
--   DRAFT / SUBMITTED, nothing paid       NOT_ISSUED      RoofOps APPROVED
--   AUTHORISED, nothing paid or credited  UNPAID          RoofOps ISSUED
--   AUTHORISED, 0 < AmountDue < Total     PARTIALLY_PAID  RoofOps PARTIALLY_PAID
--   PAID, AmountDue = 0                   PAID            RoofOps PAID
--   VOIDED                                VOIDED          RoofOps VOIDED (the only void allowed past AC-05's guard)
--   DELETED                               DELETED         nothing changes; a person decides (EXTERNAL_MISSING, as before)
--   lookup failed, wrong tenant, identity mismatch, amounts that do not add up: recorded, never inferred, nothing changes.
-- 07 records every read; a repair run (the daily one) applies the verified state through the invoice state machine
-- (a reversed payment regresses it and tells a person); a dry run only records. Closing a project trusts only verified
-- state: a Xero-linked invoice must be verified PAID or VOIDED within xero.settlement_max_age_hours; an imported invoice
-- must be PAID with the import's payments covering it; a local PAID flag alone is never enough.
-- AC-04 (UNKNOWN never settled here), AC-05 (no local void of a Xero invoice) and AC-06 (tenant binding) are unchanged.

-- 1. Every Xero read of a linked invoice, append-only (one per invoice per reconciliation run).
create table xero_invoice_observations (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid not null references invoices(id),
  run_id           uuid not null references reconciliation_runs(id),
  observed_at      timestamptz not null default now(),
  tenant_id        text,                    -- the tenant the read was made in
  bound_tenant_id  text,                    -- the tenant the invoice's write is bound to (AC-06)
  xero_invoice_id  text,
  http_status      int,
  verdict          text not null check (verdict in ('VERIFIED', 'LOOKUP_FAILED', 'WRONG_TENANT', 'MISMATCH', 'INCONSISTENT')),
  xero_status      text,
  total            numeric(12,2),
  amount_due       numeric(12,2),
  amount_paid      numeric(12,2),
  amount_credited  numeric(12,2),
  fully_paid_on    date,
  xero_updated     text,
  payments         jsonb,
  settlement       text check (settlement in ('NOT_ISSUED', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'VOIDED', 'DELETED')),
  detail           text,
  unique (invoice_id, run_id),
  check ((verdict = 'VERIFIED') = (settlement is not null))
);
create index xero_invoice_observations_latest on xero_invoice_observations (invoice_id, observed_at desc);
alter table xero_invoice_observations enable row level security;
revoke all on xero_invoice_observations from public;

insert into app_settings (key, value) values ('xero.settlement_max_age_hours', '36') on conflict (key) do nothing;

-- 2. A reversed payment (Xero PAID -> AUTHORISED) may move a RoofOps invoice back; only reconciliation does it.
insert into state_transitions (machine, from_state, to_state, guard, note) values
  ('invoice', 'PAID', 'PARTIALLY_PAID', null, 'Xero verified a payment was reversed (AC-14)'),
  ('invoice', 'PAID', 'ISSUED', null, 'Xero verified a payment was reversed (AC-14)'),
  ('invoice', 'PARTIALLY_PAID', 'ISSUED', null, 'Xero verified a payment was reversed (AC-14)')
on conflict do nothing;
-- Paid is therefore no longer final: Xero lets a payment be removed, and RoofOps follows what Xero verifies.
update state_machine_states set is_terminal = false where machine = 'invoice' and state = 'PAID';

-- 3. The canonical mapping (null = the amounts do not add up: never inferred).
create or replace function xero_settlement(p_status text, p_total numeric, p_due numeric, p_paid numeric, p_credited numeric)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_status = 'VOIDED' then 'VOIDED'
    when p_status = 'DELETED' then 'DELETED'
    when p_total is null or p_due is null or p_paid is null or p_due < 0 or p_paid < 0 or coalesce(p_credited, 0) < 0
      or p_paid + coalesce(p_credited, 0) + p_due <> p_total then null
    when p_status in ('DRAFT', 'SUBMITTED') and p_paid = 0 and coalesce(p_credited, 0) = 0 then 'NOT_ISSUED'
    when p_status = 'AUTHORISED' and p_due = p_total then 'UNPAID'
    when p_status = 'AUTHORISED' and p_due > 0 and p_due < p_total then 'PARTIALLY_PAID'
    when p_status = 'PAID' and p_due = 0 then 'PAID'
  end
$$;

-- The RoofOps invoice status a verified settlement means (DELETED: none; a person decides).
create or replace function xero_settlement_status(p_settlement text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case p_settlement when 'NOT_ISSUED' then 'APPROVED' when 'UNPAID' then 'ISSUED' when 'PARTIALLY_PAID' then 'PARTIALLY_PAID'
                           when 'PAID' then 'PAID' when 'VOIDED' then 'VOIDED' end
$$;

-- 4. Record 07's reads of linked invoices; in a repair run apply what Xero verified. Each item: { invoice_number,
--    invoice_id (the linked Xero InvoiceID), xero_invoice_number, tenant_id (the tenant read), http,
--    error, xero: the invoice as GET /Invoices/{InvoiceID} returns it }.
create or replace function xero_record_settlement(p_run_key text, p_results jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run reconciliation_runs; x jsonb; d jsonb; i invoices; v_link text; v_bound text; v_pin text := (select nullif(value, '') from app_settings where key = 'xero.demo_tenant_id');
  v_verdict text; v_settle text; v_target text; v_path text[]; v_step text; v_detail text; v_obs uuid; v_repair boolean; v_rank jsonb := '{"APPROVED":0,"ISSUED":1,"PARTIALLY_PAID":2,"PAID":3}';
  v_counts jsonb := '{}'::jsonb; v_applied int := 0; v_regressed int := 0; v_from text;
begin
  select * into v_run from reconciliation_runs where run_key = p_run_key and status = 'RUNNING';
  if v_run.id is null then return jsonb_build_object('ok', false); end if;
  v_repair := v_run.mode = 'repair';
  for x in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    select inv.* into i from invoices inv join external_links l on l.entity_id = inv.id and l.provider = 'XERO' and l.external_type = 'Invoice'
     where l.external_id = x ->> 'invoice_id' for update of inv;
    continue when i.id is null;
    v_link := x ->> 'invoice_id';
    v_bound := (select payload ->> 'xero_tenant_id' from outbox where topic = 'xero.create_draft_invoice' and aggregate_id = i.id);
    d := coalesce(x -> 'xero', '{}'::jsonb);
    v_settle := null; v_detail := null;
    if x ->> 'tenant_id' is null or v_bound is null or x ->> 'tenant_id' <> v_bound or v_bound is distinct from v_pin then
      v_verdict := 'WRONG_TENANT';
      v_detail := format('%s was read in Xero tenant %s, but its write is bound to %s and the pinned tenant is %s; that read is not trusted',
        i.invoice_number, coalesce(left(x ->> 'tenant_id', 8) || '…', 'none'), coalesce(left(v_bound, 8) || '…', 'none'), coalesce(left(v_pin, 8) || '…', 'none'));
    elsif coalesce((x ->> 'http')::int, 0) <> 200 then
      v_verdict := 'LOOKUP_FAILED';
      v_detail := format('%s could not be read from Xero (%s); nothing is assumed', i.invoice_number, coalesce('HTTP ' || (x ->> 'http'), x ->> 'error', 'no answer'));
    elsif d ->> 'InvoiceID' is distinct from v_link or d ->> 'Type' is distinct from 'ACCREC'
          or d ->> 'InvoiceNumber' is distinct from x ->> 'xero_invoice_number' or (d ->> 'Total')::numeric is distinct from i.total_inc_gst then
      v_verdict := 'MISMATCH';
      v_detail := format('%s: Xero returned %s %s %s total %s, not the linked invoice %s %s total %s', i.invoice_number,
        coalesce(d ->> 'Type', '?'), coalesce(d ->> 'InvoiceNumber', '?'), coalesce(d ->> 'InvoiceID', '?'), coalesce(d ->> 'Total', '?'),
        x ->> 'xero_invoice_number', v_link, i.total_inc_gst);
    else
      v_settle := xero_settlement(d ->> 'Status', (d ->> 'Total')::numeric, (d ->> 'AmountDue')::numeric, (d ->> 'AmountPaid')::numeric, (d ->> 'AmountCredited')::numeric);
      v_verdict := case when v_settle is null then 'INCONSISTENT' else 'VERIFIED' end;
      if v_settle is null then
        v_detail := format('%s: Xero says %s with total %s, paid %s, credited %s, due %s; that does not add up, so nothing is assumed', i.invoice_number,
          d ->> 'Status', d ->> 'Total', d ->> 'AmountPaid', coalesce(d ->> 'AmountCredited', '0'), d ->> 'AmountDue');
      end if;
    end if;
    insert into xero_invoice_observations (invoice_id, run_id, tenant_id, bound_tenant_id, xero_invoice_id, http_status, verdict, xero_status, total,
      amount_due, amount_paid, amount_credited, fully_paid_on, xero_updated, payments, settlement, detail)
    values (i.id, v_run.id, x ->> 'tenant_id', v_bound, v_link, (x ->> 'http')::int, v_verdict, d ->> 'Status', (d ->> 'Total')::numeric,
      (d ->> 'AmountDue')::numeric, (d ->> 'AmountPaid')::numeric, coalesce((d ->> 'AmountCredited')::numeric, case when v_verdict = 'VERIFIED' then 0 end),
      case when d ->> 'FullyPaidOnDate' ~ '^\d{4}-\d{2}-\d{2}' then left(d ->> 'FullyPaidOnDate', 10)::date end, d ->> 'UpdatedDateUTC',
      (select jsonb_agg(jsonb_build_object('payment_id', y ->> 'PaymentID', 'amount', y -> 'Amount', 'date', y ->> 'Date', 'status', y ->> 'Status'))
         from jsonb_array_elements(coalesce(d -> 'Payments', '[]'::jsonb)) y), v_settle, v_detail)
    on conflict (invoice_id, run_id) do nothing
    returning id into v_obs;
    continue when v_obs is null;                         -- this run already recorded this invoice
    v_counts := jsonb_set(v_counts, array[lower(v_verdict)], to_jsonb(coalesce((v_counts ->> lower(v_verdict))::int, 0) + 1));
    if v_verdict = 'WRONG_TENANT' then
      insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
      values (v_run.id, 'XERO', 'invoice', i.invoice_number, v_link, 'UNAUTHORIZED_STATE', case when v_repair then 'EXCEPTION_OPENED' else 'NONE_OBSERVE_ONLY' end, v_detail);
      if v_repair then perform wf_open_sync_exception('reconciliation', 'invoice', i.id, i.invoice_number, 'PERMISSION_DENIED', v_detail); end if;
    elsif v_verdict in ('MISMATCH', 'INCONSISTENT') then
      insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
      values (v_run.id, 'XERO', 'invoice', i.invoice_number, v_link, 'REQUIRES_HUMAN', case when v_repair then 'EXCEPTION_OPENED' else 'NONE_OBSERVE_ONLY' end, v_detail);
      if v_repair then perform wf_open_sync_exception('reconciliation', 'invoice', i.id, i.invoice_number, 'RECONCILIATION_MISMATCH', v_detail); end if;
    end if;
    -- Apply: verified, a settled write (AC-04: never UNKNOWN/PENDING), and a state RoofOps can follow.
    continue when v_verdict <> 'VERIFIED' or i.sync_status <> 'SYNCED';
    v_target := xero_settlement_status(v_settle);
    continue when v_target is null or v_target = i.status;
    v_path := case
      when v_target = 'VOIDED' and i.status in ('APPROVED', 'ISSUED') then array['VOIDED']
      when i.status = 'VOIDED' or v_target = 'VOIDED' then null
      when state_transition_allowed('invoice', i.status, v_target) then array[v_target]
      when i.status = 'APPROVED' and v_target in ('PARTIALLY_PAID', 'PAID') then array['ISSUED', v_target]
    end;
    if v_path is null then
      v_detail := format('%s is %s in RoofOps but Xero verified %s (%s); RoofOps cannot follow that change, a person must check',
        i.invoice_number, i.status, d ->> 'Status', lower(replace(v_settle, '_', ' ')));
      insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
      values (v_run.id, 'XERO', 'invoice', i.invoice_number, v_link, 'REQUIRES_HUMAN', case when v_repair then 'EXCEPTION_OPENED' else 'NONE_OBSERVE_ONLY' end, v_detail);
      if v_repair then perform wf_open_sync_exception('reconciliation', 'invoice', i.id, i.invoice_number, 'RECONCILIATION_MISMATCH', v_detail); end if;
      continue;
    end if;
    v_detail := format('%s: Xero verified %s (due %s); RoofOps shows %s', i.invoice_number, lower(replace(v_settle, '_', ' ')), coalesce(d ->> 'AmountDue', '?'), i.status);
    if not v_repair then
      insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
      values (v_run.id, 'XERO', 'invoice', i.invoice_number, v_link, 'SAFE_AUTO_REPAIR', 'NONE_OBSERVE_ONLY', v_detail || '; a repair run applies it');
      continue;
    end if;
    v_from := i.status;
    foreach v_step in array v_path loop
      update invoices set status = v_step,
        issue_date = case when v_step in ('ISSUED', 'PARTIALLY_PAID', 'PAID') then coalesce(issue_date, case when d ->> 'Date' ~ '^\d{4}-\d{2}-\d{2}' then left(d ->> 'Date', 10)::date end, app_today()) else issue_date end,
        due_date = case when v_step in ('ISSUED', 'PARTIALLY_PAID', 'PAID') then coalesce(due_date, case when d ->> 'DueDate' ~ '^\d{4}-\d{2}-\d{2}' then left(d ->> 'DueDate', 10)::date end,
                     coalesce(issue_date, app_today()) + (select value::int from app_settings where key = 'invoice.payment_terms_days')) else due_date end,
        voided_reason = case when v_step = 'VOIDED' then format('Voided in Xero (verified by reconciliation %s)', p_run_key) else voided_reason end
      where id = i.id;
      insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, external_reference, reason)
      values ('SYSTEM', 'workflow:reconciliation', 'invoice.xero_settlement_applied', 'invoice', i.id, i.invoice_number,
              jsonb_build_object('status', i.status), jsonb_build_object('status', v_step, 'xero_status', d ->> 'Status', 'amount_due', d -> 'AmountDue',
                'amount_paid', d -> 'AmountPaid', 'observation', v_obs), v_link,
              format('Reconciliation %s: Xero verified %s in tenant %s', p_run_key, lower(replace(v_settle, '_', ' ')), left(x ->> 'tenant_id', 8) || '…'));
      i.status := v_step;
    end loop;
    v_applied := v_applied + 1;
    insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
    values (v_run.id, 'XERO', 'invoice', i.invoice_number, v_link, 'SAFE_AUTO_REPAIR', 'APPLIED_TO_POSTGRES', v_detail || '; applied');
    if v_target <> 'VOIDED' and (v_rank ->> v_target)::int < (v_rank ->> v_from)::int then   -- a payment reversed in Xero
      v_regressed := v_regressed + 1;
      perform wf_open_sync_exception('reconciliation', 'invoice', i.id, i.invoice_number, 'RECONCILIATION_MISMATCH',
        format('%s went back to %s: Xero now shows %s (due %s), so a payment was reversed or removed in Xero. A person must check with the customer%s',
          i.invoice_number, v_target, d ->> 'Status', d ->> 'AmountDue',
          case when (select status from projects where id = i.project_id) = 'CLOSED' then '; the project is already Closed' else '' end));
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'verdicts', v_counts, 'applied', v_applied, 'regressed', v_regressed);
end $$;

-- 5. Is an invoice financially settled, on verified state only? { settled, state, reason }. p_fresh: require the Xero
--    verification to be younger than xero.settlement_max_age_hours (closing does; integrity of a closed project does not).
create or replace function invoice_financial_state(p_invoice uuid, p_fresh boolean default true)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare i invoices; v_linked text; o xero_invoice_observations; v xero_invoice_observations; v_paid numeric;
  v_age interval := make_interval(hours => coalesce((select value::int from app_settings where key = 'xero.settlement_max_age_hours'), 36));
begin
  select * into i from invoices where id = p_invoice;
  if i.id is null then return jsonb_build_object('settled', false, 'state', 'UNKNOWN', 'reason', 'no such invoice'); end if;
  if i.sync_status in ('PENDING', 'UNKNOWN') then
    return jsonb_build_object('settled', false, 'state', 'XERO_WRITE_OPEN', 'reason', 'its Xero write is still in flight or uncertain');
  end if;
  select external_id into v_linked from external_links where provider = 'XERO' and external_type = 'Invoice' and entity_id = i.id and verified_at is not null;
  if v_linked is null then
    if i.status = 'VOIDED' then return jsonb_build_object('settled', true, 'state', 'VOIDED', 'reason', 'voided'); end if;
    if i.status = 'PAID' and i.record_origin = 'IMPORT' then
      select coalesce(sum(amount), 0) into v_paid from payments where invoice_id = i.id and source = 'IMPORT';
      if v_paid >= i.total_inc_gst then return jsonb_build_object('settled', true, 'state', 'PAID', 'reason', 'paid (imported payments)'); end if;
      return jsonb_build_object('settled', false, 'state', 'UNVERIFIED', 'reason', format('marked paid but its imported payments cover only %s of %s', v_paid, i.total_inc_gst));
    end if;
    if i.status = 'PAID' then
      return jsonb_build_object('settled', false, 'state', 'UNVERIFIED', 'reason', 'marked paid locally but not verified in Xero');
    end if;
    return jsonb_build_object('settled', false, 'state', i.status, 'reason', lower(replace(i.status, '_', ' ')));
  end if;
  select * into o from xero_invoice_observations where invoice_id = i.id and xero_invoice_id = v_linked order by observed_at desc, id desc limit 1;
  if o.id is null then
    return jsonb_build_object('settled', false, 'state', 'UNVERIFIED', 'reason', 'not verified in Xero yet; reconciliation reads it');
  end if;
  if o.verdict <> 'VERIFIED' then
    return jsonb_build_object('settled', false, 'state', 'AMBIGUOUS', 'reason',
      format('the last Xero check failed (%s, %s); RoofOps does not assume it is paid', lower(replace(o.verdict, '_', ' ')), to_char(o.observed_at, 'YYYY-MM-DD HH24:MI')));
  end if;
  if o.settlement in ('PAID', 'VOIDED') and i.status = xero_settlement_status(o.settlement) then
    if p_fresh and o.observed_at < now() - v_age then
      return jsonb_build_object('settled', false, 'state', 'STALE', 'reason',
        format('Xero verified it %s at %s, older than %s hours; run reconciliation to verify it again', lower(o.settlement), to_char(o.observed_at, 'YYYY-MM-DD HH24:MI'),
               extract(epoch from v_age)::int / 3600));
    end if;
    return jsonb_build_object('settled', true, 'state', o.settlement, 'reason', lower(o.settlement) || ' (verified in Xero)', 'verified_at', o.observed_at);
  end if;
  return jsonb_build_object('settled', false, 'state', o.settlement, 'reason',
    case o.settlement when 'NOT_ISSUED' then 'not issued in Xero yet'
                      when 'UNPAID' then 'unpaid in Xero'
                      when 'PARTIALLY_PAID' then format('partially paid in Xero, %s still due', o.amount_due)
                      when 'DELETED' then 'deleted in Xero; a person decides'
                      else format('Xero verified %s but RoofOps still shows %s; a repair run applies it', lower(o.settlement), lower(i.status)) end
    || format(' (verified %s)', to_char(o.observed_at, 'YYYY-MM-DD HH24:MI')));
end $$;

-- 6. wf_reconcile_external (wrapper): Xero results also record the settlement
create or replace function wf_reconcile_external(p_run_key text, p_system text, p_results jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_limited jsonb; v_res jsonb; x record;
begin
  if p_system = 'XERO' then
    -- Existence, total and reference as before; then AC-14: the verified financial state of every linked invoice.
    v_res := wf_reconcile_external_core(p_run_key, p_system, p_results);
    if not coalesce((v_res ->> 'ok')::boolean, false) then return v_res; end if;
    return v_res || jsonb_build_object('settlement', xero_record_settlement(p_run_key, p_results));
  end if;
  if p_system <> 'DRIVE' then return wf_reconcile_external_core(p_run_key, p_system, p_results); end if;
  select coalesce(jsonb_agg(r), '[]'::jsonb) into v_limited from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) r
   where coalesce((r ->> 'http')::int, 0) = 429 or ((r ->> 'http')::int = 403 and r ->> 'reason' in ('rateLimitExceeded', 'userRateLimitExceeded'));
  v_res := wf_reconcile_external_core(p_run_key, p_system,
             (select coalesce(jsonb_agg(r), '[]'::jsonb) from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) r where not (v_limited @> jsonb_build_array(r))));
  if not coalesce((v_res ->> 'ok')::boolean, false) then return v_res; end if;
  if jsonb_array_length(v_limited) > 0 then
    perform wf_reconcile_drive_unavailable(p_run_key, jsonb_build_object('error_class', 'RATE_LIMITED', 'attempts', 1, 'http', v_limited -> 0 -> 'http',
      'reason', format('Google Drive rate-limited %s of the folder reads; those folders were not verified this run and are checked again at the next run', jsonb_array_length(v_limited))));
    return v_res || jsonb_build_object('unavailable', true, 'not_verified', jsonb_array_length(v_limited));
  end if;
  insert into integration_health (service, ok, detail)
  values ('google_drive', true, jsonb_build_object('check', 'reconciliation ' || p_run_key, 'verified', v_res -> 'verified', 'drift', v_res -> 'drift'));
  for x in select id, exception_number from workflow_exceptions
            where workflow_key = 'reconciliation' and business_reference = 'GOOGLE_DRIVE' and resolution_status in ('OPEN', 'RETRY_QUEUED') for update loop
    update workflow_exceptions set resolution_status = 'RESOLVED', resolved_at = now(), resolved_by_system = 'workflow:reconciliation',
           resolution_note = 'Google Drive checked successfully in ' || p_run_key where id = x.id;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
    values ('SYSTEM', 'workflow:reconciliation', 'exception.resolved', 'workflow_exception', x.id, x.exception_number,
            '{"resolution_status":"OPEN"}', '{"resolution_status":"RESOLVED"}', 'Google Drive checked successfully in ' || p_run_key);
  end loop;
  return v_res;
end $$;

-- 7. invoice_void_guard (AC-05): + a void verified in Xero
create or replace function invoice_void_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare o outbox;
begin
  select * into o from outbox where topic = 'xero.create_draft_invoice' and aggregate_id = new.id;
  if o.id is null then return new; end if;
  -- AC-14: voided in Xero, verified by reconciliation (the linked invoice, in its bound tenant): RoofOps follows Xero.
  if exists (select 1 from xero_invoice_observations x
              where x.id = (select id from xero_invoice_observations where invoice_id = new.id order by observed_at desc, id desc limit 1)
                and x.verdict = 'VERIFIED' and x.settlement = 'VOIDED' and x.tenant_id = o.payload ->> 'xero_tenant_id'
                and x.xero_invoice_id = (select external_id from external_links where provider = 'XERO' and external_type = 'Invoice' and entity_id = new.id)) then
    return new;
  end if;
  if o.status = 'DISPATCHING' then
    raise exception '% cannot be voided: its Xero draft is being created right now. Try again when that has finished', old.invoice_number using errcode = 'check_violation';
  end if;
  if old.sync_status = 'SYNCED' or o.status = 'DONE'
     or exists (select 1 from external_links where provider = 'XERO' and external_type = 'Invoice' and entity_id = new.id) then
    raise exception '% cannot be voided: its Xero draft exists (%). Void or delete it in Xero first', old.invoice_number,
      coalesce(o.payload ->> 'xero_invoice_number', 'see the Xero link') using errcode = 'check_violation';
  end if;
  if old.sync_status = 'UNKNOWN' then
    raise exception '% cannot be voided: an earlier attempt may already exist in Xero. Run reconciliation (npm run reconcile) to settle it first', old.invoice_number
      using errcode = 'check_violation';
  end if;
  if o.status = 'PENDING' or (o.status = 'FAILED' and o.next_attempt_at <> 'infinity') then
    raise exception '% cannot be voided: its Xero draft is queued (%). Void it after the draft exists in Xero (then void it there first) or after the write has failed',
      old.invoice_number, case when o.status = 'PENDING' then 'not started yet' else 'retry scheduled' end using errcode = 'check_violation';
  end if;
  return new;   -- dead-lettered: nothing was created in Xero
end $$;

-- 8. project_transition_guard (AC-13A): every invoice settled on verified state
create or replace function project_transition_guard(p projects, p_to text)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_final text; v_over jsonb; v_bill jsonb; v_open text;
begin
  -- AC-08: an over-billed job is never closed; a person corrects the billing first (no credit-note model).
  if p_to = 'CLOSED' then
    v_over := project_over_billing(p.id);
    if v_over is not null then
      return format('%s cannot be closed: it is over-billed by %s (billed %s against %s: %s). Correct the billing first, for example void the unpaid duplicate invoice',
        p.project_number, v_over ->> 'excess', v_over ->> 'billed', v_over ->> 'entitled', v_over ->> 'invoices');
    end if;
  end if;
  if p_to = 'IN_PROGRESS' and p.status = 'SCHEDULED' and p.planned_start_date is null then
    return 'set a Planned Start before marking the job In Progress';
  end if;
  if p_to = 'IN_PROGRESS' and p.status = 'ON_HOLD' and p.actual_start_date is null then
    return 'this job never started; move it back to Scheduled instead of In Progress';
  end if;
  if p.status = 'COMPLETED' and p_to = 'CANCELLED' then
    select string_agg(invoice_number, ', ') into v_final from invoices where project_id = p.id and invoice_type = 'FINAL' and status <> 'VOIDED';
    if v_final is not null then
      return format('a final invoice (%s) already exists; void it first, then cancel', v_final);
    end if;
    if exists (select 1 from approvals where entity_id = p.id and action_type = 'CREATE_INVOICE' and status in ('EXECUTING', 'APPROVED')) then
      return 'a final invoice is being created in Xero right now; wait for it to finish';
    end if;
  end if;
  if p.status = 'COMPLETED' and p_to = 'CLOSED' then
    -- AC-14: settled only on verified state (Xero for a Xero-linked invoice; the import's payments for an imported one).
    select string_agg(i.invoice_number || ' (' || (f ->> 'reason') || ')', ', ' order by i.invoice_number) into v_final
      from invoices i cross join lateral (select invoice_financial_state(i.id) f) s
     where i.project_id = p.id and not (f ->> 'settled')::boolean;
    if v_final is not null then return format('not every invoice is paid yet: %s', v_final); end if;
    -- AC-13A: closed means settled: everything entitled is billed (AC-09 project_billing; over-billing is refused above).
    v_bill := project_billing(p.id);
    if (v_bill ->> 'remaining')::numeric > 0 then
      select string_agg(invoice_number, ', ') into v_final from invoices where project_id = p.id and invoice_type = 'FINAL' and status <> 'VOIDED';
      return case when v_final is null then format('%s left to bill: the final invoice has not been raised yet', v_bill ->> 'remaining')
                  else format('%s left to bill after final invoice %s (for example a variation approved later); invoice it before closing', v_bill ->> 'remaining', v_final) end;
    end if;
    select string_agg(label, ', ' order by label) into v_open from v_projects_missing_completion_docs v where v.id = p.id;
    if v_open is not null then
      return format('completion items are still open (%s); set them in Airtable (Completion Photos / Compliance Certificate) before closing', v_open);
    end if;
    if exists (select 1 from approvals where entity_id = p.id and action_type = 'CREATE_INVOICE' and status = 'PENDING') then
      return 'a final invoice preview is awaiting approval; approve or withdraw it first';
    end if;
    -- AC-04 semantics: never close while a Xero write is in flight or uncertain.
    select string_agg(invoice_number || ' (' || lower(sync_status) || ')', ', ' order by invoice_number) into v_final
      from invoices where project_id = p.id and sync_status in ('PENDING', 'UNKNOWN');
    if v_final is not null or exists (select 1 from approvals where entity_id = p.id and action_type = 'CREATE_INVOICE' and status in ('APPROVED', 'EXECUTING')) then
      return format('a Xero write is still in flight or uncertain%s; wait until Xero confirms it', coalesce(': ' || v_final, ''));
    end if;
  end if;
  return null;
end $$;

-- 9. integrity_check (AC-13A wrapper): closed = settled on verified state; linked invoices agree with Xero
create or replace function integrity_check()
returns table (entity text, check_key text, status text, failing int, detail text, refs text[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_refs text[];
begin
  return query select * from integrity_check_core();
  select array_agg(i.invoice_number order by i.invoice_number) into v_refs from invoices i
    left join outbox o on o.topic = 'xero.create_draft_invoice' and o.aggregate_id = i.id
   where i.status = 'VOIDED' and i.record_origin = 'ROOFOPS'
     and (i.sync_status in ('PENDING', 'UNKNOWN', 'SYNCED') or o.status in ('DISPATCHING', 'DONE')
          or exists (select 1 from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id));
  entity := 'invoice'; check_key := 'voided_invoice_has_no_xero_write';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'No Xero draft is created, pending, ambiguous or linked for a voided invoice'; return next;
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
    left join lateral (select * from xero_invoice_observations o where o.invoice_id = i.id order by o.observed_at desc, o.id desc limit 1) x on true
   where i.sync_status = 'SYNCED' and (x.id is null or x.verdict <> 'VERIFIED' or i.status is distinct from xero_settlement_status(x.settlement));
  entity := 'invoice'; check_key := 'xero_invoice_state_verified';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every Xero-linked invoice was last read from its own Xero tenant and RoofOps shows the state Xero verified (a repair run applies it)'; return next;
end $$;

-- 10. v_invoice_balances: paid and owed as Xero last verified them
create or replace view v_invoice_balances as
select i.id, i.invoice_number, i.project_id, p.project_number, i.customer_id, c.display_name as customer_name,
       i.status, i.sync_status, i.issue_date, i.due_date, i.total_inc_gst,
       coalesce(xv.paid, pay.paid, 0)::numeric as amount_paid,
       coalesce(xv.due, i.total_inc_gst - coalesce(pay.paid, 0))::numeric as outstanding,
       (i.status in ('ISSUED','PARTIALLY_PAID') and i.due_date < app_today()
        and coalesce(xv.due, i.total_inc_gst - coalesce(pay.paid, 0)) > 0) as is_overdue,
       greatest(app_today() - i.due_date, 0) as days_past_due
from invoices i
join projects p on p.id = i.project_id
join customers c on c.id = i.customer_id
left join (select invoice_id, sum(amount) paid from payments group by invoice_id) pay on pay.invoice_id = i.id
-- AC-14: the latest verified Xero read of a linked invoice (amounts as Xero holds them).
left join lateral (select o.amount_paid + o.amount_credited as paid, o.amount_due as due from xero_invoice_observations o
                    where o.invoice_id = i.id and o.verdict = 'VERIFIED' and o.settlement <> 'DELETED'
                      and o.xero_invoice_id = (select l.external_id from external_links l where l.provider = 'XERO' and l.external_type = 'Invoice' and l.entity_id = i.id)
                    order by o.observed_at desc, o.id desc limit 1) xv on true;

revoke execute on all functions in schema public from public;
revoke execute on function xero_record_settlement(text, jsonb) from roofops_workflow, roofops_dashboard;
revoke execute on function invoice_financial_state(uuid, boolean) from roofops_workflow, roofops_dashboard;
grant execute on function xero_settlement(text, numeric, numeric, numeric, numeric) to roofops_dashboard;
grant execute on function xero_settlement_status(text) to roofops_dashboard;
grant execute on function integrity_check() to roofops_dashboard;
