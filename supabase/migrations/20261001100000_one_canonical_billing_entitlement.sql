-- AC-09 (docs/defect-ledger.md): the final invoice under-billed once a billed variation was marked INVOICED.
-- invoice_final_preview added only APPROVED variations but subtracted every billed invoice, including the variation's own
-- VARIATION invoice: PRJ-2026-0004 with a 1,100.00 variation billed then marked INVOICED gave 13,564.49 instead of
-- 14,664.49. AC-08's project_over_billing used a different entitlement (APPROVED + INVOICED). No project in the data
-- (local or hosted) has a variation, so nothing real was short; the defect was latent.
--
-- One canonical calculation, project_billing(project), reused by invoice_final_preview (so Prepare, the dashboard, the
-- close guard, the Copilot and the integrity checks that read it), project_over_billing, and integrity:
--   total_entitlement  = accepted quote total (inc GST) + variations APPROVED or INVOICED (customer-approved);
--                        PROPOSED and REJECTED never count
--   valid_billed       = invoices APPROVED, ISSUED, PARTIALLY_PAID or PAID, at their GST-inclusive totals (derived from
--                        their lines by gst_split for any line-amount type); VOIDED never counts; DRAFT and
--                        PENDING_APPROVAL block the final invoice instead
--   remaining_billable = total_entitlement - valid_billed   (> 0 ready; = 0 fully invoiced; < 0 over-billed, AC-08)
-- All amounts are GST-inclusive cents, so no rounding enters the remaining amount; the final invoice's GST is
-- round(amount / 11, 2), and its lines (line 1 + the not-yet-invoiced approved variations) add up to it exactly.

-- 1. The one calculation (null when the project has no accepted quote version).
create or replace function project_billing(p_project uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with x as (
    select p.project_number, qv.total_inc_gst as quote,
           coalesce((select sum(v.amount_inc_gst) from variations v where v.project_id = p.id and v.status = 'APPROVED'), 0)::numeric(12,2) as approved_variations,
           coalesce((select sum(v.amount_inc_gst) from variations v where v.project_id = p.id and v.status = 'INVOICED'), 0)::numeric(12,2) as invoiced_variations,
           coalesce((select sum(i.total_inc_gst) from invoices i where i.project_id = p.id and i.status in ('APPROVED', 'ISSUED', 'PARTIALLY_PAID', 'PAID')), 0)::numeric(12,2) as billed,
           (select string_agg(i.invoice_number, ', ' order by i.invoice_number) from invoices i
             where i.project_id = p.id and i.status in ('APPROVED', 'ISSUED', 'PARTIALLY_PAID', 'PAID')) as invoices,
           coalesce((select jsonb_agg(jsonb_build_object('invoice', i.invoice_number, 'status', i.status, 'total', i.total_inc_gst) order by i.invoice_number)
                       from invoices i where i.project_id = p.id and i.status in ('APPROVED', 'ISSUED', 'PARTIALLY_PAID', 'PAID')), '[]'::jsonb) as billed_invoices
      from projects p join quote_versions qv on qv.id = p.accepted_quote_version_id
     where p.id = p_project)
  select jsonb_build_object('project_number', project_number, 'quote', quote,
           'approved_variations', approved_variations, 'invoiced_variations', invoiced_variations,
           'variations', approved_variations + invoiced_variations, 'entitlement', quote + approved_variations + invoiced_variations,
           'billed', billed, 'invoices', invoices, 'billed_invoices', billed_invoices,
           'remaining', quote + approved_variations + invoiced_variations - billed)
    from x
$$;

-- 2. AC-08's over-billing reads it.
create or replace function project_over_billing(p_project uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('billed', b -> 'billed', 'quote', b -> 'quote', 'variations', b -> 'variations', 'entitled', b -> 'entitlement',
           'excess', -(b ->> 'remaining')::numeric, 'invoices', b ->> 'invoices',
           'message', format('%s is over-billed: billed %s (%s) against quote %s + approved variations %s = %s; over by %s. Correct the billing before it can be closed (for example void the unpaid duplicate invoice)',
                             b ->> 'project_number', b ->> 'billed', b ->> 'invoices', b ->> 'quote', b ->> 'variations', b ->> 'entitlement', -(b ->> 'remaining')::numeric))
    from (select project_billing(p_project) b) x
   where (b ->> 'remaining')::numeric < 0
$$;

-- 3. create or replace function invoice_final_preview(p_project uuid)
create or replace function invoice_final_preview(p_project uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  p projects; c customers; pr properties; qv quote_versions; q quotes;
  v_billed numeric(12,2); v_var numeric(12,2); v_amount numeric(12,2); v_gst numeric(12,2);
  v_blocking text; v_billed_list jsonb; v_lines jsonb; v_rate numeric := 0.1; v_over jsonb; v_bill jsonb; v_unbilled numeric(12,2); v_invoiced numeric(12,2);
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

  -- AC-09: the one billing calculation (entitlement = quote + APPROVED/INVOICED variations; billed = valid invoices).
  v_bill := project_billing(p.id);
  v_billed := (v_bill ->> 'billed')::numeric; v_billed_list := v_bill -> 'billed_invoices';
  v_var := (v_bill ->> 'variations')::numeric; v_unbilled := (v_bill ->> 'approved_variations')::numeric; v_invoiced := (v_bill ->> 'invoiced_variations')::numeric;
  -- AC-08: billed more than quote + approved/invoiced variations is over-billing, never "nothing left to invoice".
  v_over := project_over_billing(p.id);
  if v_over is not null then
    return jsonb_build_object('ok', false, 'error_class', 'ARITHMETIC_MISMATCH', 'over_billed', true, 'over_billed_by', v_over -> 'excess',
      'billed_inc_gst', v_over -> 'billed', 'entitled_inc_gst', v_over -> 'entitled', 'message', v_over ->> 'message');
  end if;
  v_amount := (v_bill ->> 'remaining')::numeric;
  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'error_class', 'ARITHMETIC_MISMATCH',
      'message', format('%s: quote %s + variations %s - billed %s = %s; nothing left to invoice', p.project_number,
        qv.total_inc_gst, v_var, v_billed, v_amount));
  end if;
  v_gst := round(v_amount * v_rate / (1 + v_rate), 2);

  v_lines := jsonb_build_array(jsonb_build_object('line_no', 1,
      'description', format('Final invoice %s: %s roofing works at %s, %s (quote %s v%s, total %s inc GST, %sless %s already invoiced)',
                            p.project_number, initcap(replace(q.job_type, '_', ' ')), pr.address_line1, pr.suburb, q.quote_number, qv.version_number,
                            qv.total_inc_gst, case when v_invoiced <> 0 then format('plus variations already invoiced %s, ', v_invoiced) else '' end, v_billed),
      -- Line 1 + the not-yet-invoiced approved variations = remaining, exactly.
      'quantity', 1, 'unit_amount', v_amount - v_unbilled, 'variation_id', null))
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

-- 4. create or replace function integrity_check()
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
end $$;

revoke execute on all functions in schema public from public;
revoke execute on function project_billing(uuid) from roofops_workflow, roofops_dashboard;
grant execute on function integrity_check() to roofops_dashboard;
