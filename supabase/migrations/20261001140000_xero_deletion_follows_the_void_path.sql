-- AC-14C Part A (docs/defect-ledger.md): AC-14 (20261001120000) follows a void made in Xero, but a draft that was
-- created in Xero and then DELETED in Xero was a dead end. 07's repair run recorded VERIFIED / DELETED, opened the
-- EXTERNAL_MISSING exception the external reader has always opened for a missing Xero object, and then did nothing:
-- the invoice stayed APPROVED / SYNCED for ever, so the customer owed nothing but the RoofOps invoice still could not
-- be settled, and the project could never close. A verified deletion with no money movement anywhere on the invoice is
-- the same business state as a void, and RoofOps must follow it the same way.
--
-- The rule (no new trust): only a VERIFIED observation - the linked InvoiceID, read in the tenant the write is bound to
-- (which is also the pinned one), ACCREC, the expected number and total - applies. The verdict already carries exactly
-- the tenant and linked-InvoiceID conditions AC-14B's exemption uses, so the apply path needs no second copy of them.
--
-- Apply (repair runs only; an observe run still records and changes nothing):
--   a VERIFIED settlement DELETED for the invoice's current link applies APPROVED | ISSUED -> VOIDED, with
--   voided_reason 'Deleted in Xero (verified by reconciliation <run_key>)' (p_run_key is the run identifier the void
--   path already stamps into the same column).
-- Guard, because a deletion that moved money is not the same business state:
--   the observation's amount_paid is present and 0, coalesce(amount_credited, 0) = 0, and the invoice has no local
--   payment row. If any of those fails nothing about the invoice changes: a REQUIRES_HUMAN finding is recorded and (in
--   a repair run) a RECONCILIATION_MISMATCH exception is opened, exactly as the existing cannot-follow path does. The
--   EXTERNAL_MISSING exception the external reader opens for a missing Xero object is untouched and still opens.
-- Ambiguity is never applied: a LOOKUP_FAILED / WRONG_TENANT / MISMATCH / INCONSISTENT read applies nothing, and - as
-- the ordering clause below states - a later failed read never undoes an applied deletion.
--
-- What changes here, in four functions and no applied migration:
--   xero_settlement_status   DELETED maps to VOIDED (the same conceptual settled-settled state as the void path).
--   xero_record_settlement   the DELETED guard, the deletion reason, and the apply through the existing void path.
--   invoice_financial_state  a DELETED observation whose invoice is VOIDED is reported settled, with the deletion
--                            reason; a DELETED observation that did NOT apply still says 'a person decides'.
--   invoice_void_guard       the verified-void exemption accepts settlement VOIDED or DELETED (same tenant, same link).
--   integrity_check          AC-05's exemption accepts VOIDED or DELETED, keeping AC-14B's ordering clause: the
--                            exemption holds only while no later VERIFIED observation of that linked invoice says the
--                            invoice is something other than voided or deleted.

-- 1. The RoofOps invoice status a verified settlement means: a deletion is a void in business terms.
create or replace function xero_settlement_status(p_settlement text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case p_settlement when 'NOT_ISSUED' then 'APPROVED' when 'UNPAID' then 'ISSUED' when 'PARTIALLY_PAID' then 'PARTIALLY_PAID'
                           when 'PAID' then 'PAID' when 'VOIDED' then 'VOIDED' when 'DELETED' then 'VOIDED' end
$$;

-- 2. Record 07's reads and, in a repair run, apply what Xero verified - now including a verified deletion.
create or replace function xero_record_settlement(p_run_key text, p_results jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run reconciliation_runs; x jsonb; d jsonb; i invoices; v_link text; v_bound text; v_pin text := (select nullif(value, '') from app_settings where key = 'xero.demo_tenant_id');
  v_verdict text; v_settle text; v_target text; v_path text[]; v_step text; v_detail text; v_obs uuid; v_repair boolean; v_rank jsonb := '{"APPROVED":0,"ISSUED":1,"PARTIALLY_PAID":2,"PAID":3}';
  v_counts jsonb := '{}'::jsonb; v_applied int := 0; v_regressed int := 0; v_from text; v_observed xero_invoice_observations;
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
    -- AC-14C: a deletion is a void only when no money ever moved on the invoice, here or in Xero. Otherwise a person
    -- decides: RoofOps must not write the invoice off while a payment or a credit exists somewhere.
    if v_settle = 'DELETED' then
      select * into v_observed from xero_invoice_observations where id = v_obs;
      if v_observed.amount_paid is null or v_observed.amount_paid <> 0 or coalesce(v_observed.amount_credited, 0) <> 0
         or exists (select 1 from payments where invoice_id = i.id) then
        v_detail := format('%s was deleted in Xero, but money moved on it (Xero paid %s, credited %s; %s local payment row(s)); it is not voided without a person: check the customer account first',
          i.invoice_number, coalesce(v_observed.amount_paid::text, 'unknown'), coalesce(v_observed.amount_credited::text, '0'),
          (select count(*) from payments where invoice_id = i.id));
        insert into reconciliation_findings (run_id, system, entity_type, entity_ref, external_id, classification, action, detail)
        values (v_run.id, 'XERO', 'invoice', i.invoice_number, v_link, 'REQUIRES_HUMAN', case when v_repair then 'EXCEPTION_OPENED' else 'NONE_OBSERVE_ONLY' end, v_detail);
        if v_repair then perform wf_open_sync_exception('reconciliation', 'invoice', i.id, i.invoice_number, 'RECONCILIATION_MISMATCH', v_detail); end if;
        continue;
      end if;
    end if;
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
        voided_reason = case when v_step <> 'VOIDED' then voided_reason
                             when v_settle = 'DELETED' then format('Deleted in Xero (verified by reconciliation %s)', p_run_key)
                             else format('Voided in Xero (verified by reconciliation %s)', p_run_key) end
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

-- 3. Is an invoice financially settled, on verified state only? { settled, state, reason }. p_fresh: require the Xero
--    verification to be younger than xero.settlement_max_age_hours (closing does; integrity of a closed project does not).
--    AC-14C: a deletion that was applied (the invoice is VOIDED) is settled, with the deletion named; a deletion that was
--    not applied (money moved, or the invoice is not voided) keeps the old 'a person decides'.
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
  if o.settlement in ('PAID', 'VOIDED', 'DELETED') and i.status = xero_settlement_status(o.settlement) then
    if p_fresh and o.observed_at < now() - v_age then
      return jsonb_build_object('settled', false, 'state', 'STALE', 'reason',
        format('Xero verified it %s at %s, older than %s hours; run reconciliation to verify it again', lower(o.settlement), to_char(o.observed_at, 'YYYY-MM-DD HH24:MI'),
               extract(epoch from v_age)::int / 3600));
    end if;
    return jsonb_build_object('settled', true, 'state', o.settlement, 'reason',
      case when o.settlement = 'DELETED' then format('deleted in Xero and voided in RoofOps (verified %s); a replacement invoice has not been raised', to_char(o.observed_at, 'YYYY-MM-DD HH24:MI'))
           else lower(o.settlement) || ' (verified in Xero)' end, 'verified_at', o.observed_at);
  end if;
  return jsonb_build_object('settled', false, 'state', o.settlement, 'reason',
    case o.settlement when 'NOT_ISSUED' then 'not issued in Xero yet'
                      when 'UNPAID' then 'unpaid in Xero'
                      when 'PARTIALLY_PAID' then format('partially paid in Xero, %s still due', o.amount_due)
                      when 'DELETED' then 'deleted in Xero; a person decides'
                      else format('Xero verified %s but RoofOps still shows %s; a repair run applies it', lower(o.settlement), lower(i.status)) end
    || format(' (verified %s)', to_char(o.observed_at, 'YYYY-MM-DD HH24:MI')));
end $$;

-- 4. invoice_void_guard (AC-05): a void verified in Xero, or a deletion verified in Xero, is followed, not refused.
create or replace function invoice_void_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare o outbox;
begin
  select * into o from outbox where topic = 'xero.create_draft_invoice' and aggregate_id = new.id;
  if o.id is null then return new; end if;
  -- AC-14 / AC-14C: voided or deleted in Xero, verified by reconciliation (the linked invoice, in its bound tenant):
  -- RoofOps follows Xero. A deletion with no money movement is the same business state as a void.
  if exists (select 1 from xero_invoice_observations x
              where x.id = (select id from xero_invoice_observations where invoice_id = new.id order by observed_at desc, id desc limit 1)
                and x.verdict = 'VERIFIED' and x.settlement in ('VOIDED', 'DELETED') and x.tenant_id = o.payload ->> 'xero_tenant_id'
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

-- 5. integrity_check (AC-05 exemption, AC-14B extended by AC-14C): only the void predicate and its detail change.
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
    left join lateral (select * from xero_invoice_observations o where o.invoice_id = i.id order by o.observed_at desc, o.id desc limit 1) x on true
   where i.sync_status = 'SYNCED' and (x.id is null or x.verdict <> 'VERIFIED' or i.status is distinct from xero_settlement_status(x.settlement));
  entity := 'invoice'; check_key := 'xero_invoice_state_verified';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every Xero-linked invoice was last read from its own Xero tenant and RoofOps shows the state Xero verified (a repair run applies it)'; return next;
end $$;

-- The grant tail, as in 20261001130000: create or replace keeps each function's existing privileges, so only the
-- dashboard's integrity_check() grant is restated (xero_settlement and xero_settlement_status keep theirs from AC-14).
revoke execute on all functions in schema public from public;
grant execute on function integrity_check() to roofops_dashboard;
