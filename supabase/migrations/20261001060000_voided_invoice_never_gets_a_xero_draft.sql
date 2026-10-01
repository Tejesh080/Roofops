-- AC-05 (docs/defect-ledger.md): voiding an invoice did not stop its queued Xero write. APPROVED -> VOIDED is legal and
-- nothing tied the outbox row to the invoice's business status: n8n 05 still claimed the job, created the draft, and
-- wf_complete_side_effect recorded it SYNCED on the VOIDED invoice (outbox DONE, Xero link), while the dashboard offered
-- the project as READY_TO_INVOICE (needs_attention false, integrity 0 FAIL). Approving again then failed.
--
-- Rule (owner decision 2026-10-01): no Xero draft is ever created or linked for a VOIDED invoice.
--  * A FINAL invoice cannot be voided while its Xero write is queued, being made, ambiguous (UNKNOWN) or done (a draft
--    exists): each refusal says why and what to do. It can be voided once the write failed safely (dead-lettered,
--    nothing created in Xero).
--  * Safety net: 05's claim gets no job for a voided invoice, and a completion for one is refused (and reported).
--  * After a void the project is blocked for a person (one FINAL invoice per project, ever): its preview says so, the
--    dashboard shows NOT_READY with that reason, and an exception is opened (needs attention). Never READY_TO_INVOICE.
--  * integrity_check reports a voided invoice whose Xero draft exists or may exist.

-- 1. Voiding is refused while the Xero write can still happen or has happened.
create or replace function invoice_void_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare o outbox;
begin
  select * into o from outbox where topic = 'xero.create_draft_invoice' and aggregate_id = new.id;
  if o.id is null then return new; end if;
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
create trigger invoices_void_guard before update of status on invoices
  for each row when (new.status = 'VOIDED' and old.status is distinct from 'VOIDED') execute function invoice_void_guard();

-- 2. A voided FINAL invoice leaves the project blocked for a person: one exception (needs attention on the dashboard).
create or replace function invoice_voided_needs_person()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform wf_open_sync_exception('project_to_invoice', 'project', new.project_id, (select project_number from projects where id = new.project_id), 'INVALID_STATE',
    format('Final invoice %s was voided (%s): a replacement final invoice needs a person, because RoofOps allows one final invoice per project',
           new.invoice_number, coalesce(new.voided_reason, 'no reason given')));
  return new;
end $$;
create trigger invoices_voided_needs_person after update of status on invoices
  for each row when (new.status = 'VOIDED' and old.status is distinct from 'VOIDED' and new.invoice_type = 'FINAL') execute function invoice_voided_needs_person();

-- 3. Safety net in the side-effect path.
alter function wf_claim_side_effect(text, text, int) rename to wf_claim_side_effect_core;
create or replace function wf_claim_side_effect(p_key text, p_worker text, p_lease_seconds int default 120)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare o outbox; v_inv invoices;
begin
  select * into o from outbox where idempotency_key = p_key;
  if o.topic = 'xero.create_draft_invoice' then
    select * into v_inv from invoices where id = o.aggregate_id;
    if v_inv.status = 'VOIDED' then
      return jsonb_build_object('claimed', false, 'key', o.idempotency_key, 'topic', o.topic, 'status', 'INVOICE_VOIDED',
        'message', format('%s was voided: no Xero draft is created for it', v_inv.invoice_number));
    end if;
  end if;
  return wf_claim_side_effect_core(p_key, p_worker, p_lease_seconds);
end $$;

alter function wf_complete_side_effect(text, jsonb) rename to wf_complete_side_effect_core;
create or replace function wf_complete_side_effect(p_key text, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare o outbox; v_inv invoices;
begin
  select * into o from outbox where idempotency_key = p_key;
  if o.topic = 'xero.create_draft_invoice' then
    select * into v_inv from invoices where id = o.aggregate_id;
    if v_inv.status = 'VOIDED' then
      -- Refused like any bad proof: 05 records the failure (dead letter + exception) and tells Airtable nothing was linked.
      raise exception '% is voided: the Xero draft % was not linked. Void or delete it in Xero', v_inv.invoice_number,
        coalesce(p_result ->> 'invoice_number', o.payload ->> 'xero_invoice_number') using errcode = 'check_violation';
    end if;
  end if;
  return wf_complete_side_effect_core(p_key, p_result);
end $$;

-- 4. The preview (and so the dashboard and Prepare) says the project is blocked after a void.
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
  -- AC-05: one FINAL invoice per project, ever. After a void a person decides how to replace it: never "ready" again.
  if exists (select 1 from invoices where project_id = p.id and invoice_type = 'FINAL' and status = 'VOIDED') then
    return jsonb_build_object('ok', false, 'error_class', 'INVALID_STATE', 'final_voided', true,
      'message', format('%s: final invoice %s was voided (%s); a replacement final invoice needs a person (one final invoice per project)', p.project_number,
        (select string_agg(invoice_number, ', ' order by invoice_number) from invoices where project_id = p.id and invoice_type = 'FINAL' and status = 'VOIDED'),
        (select string_agg(coalesce(voided_reason, 'no reason given'), '; ') from invoices where project_id = p.id and invoice_type = 'FINAL' and status = 'VOIDED')));
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

-- 5. Integrity: a voided invoice whose Xero draft exists or may exist.
alter function integrity_check() rename to integrity_check_core;
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
end $$;

revoke execute on all functions in schema public from public;
revoke execute on function wf_claim_side_effect_core(text, text, int), wf_complete_side_effect_core(text, jsonb), integrity_check_core(),
  invoice_voided_needs_person() from roofops_workflow, roofops_dashboard;
grant execute on function wf_claim_side_effect(text, text, int), wf_complete_side_effect(text, jsonb) to roofops_workflow;
grant execute on function integrity_check() to roofops_dashboard;
