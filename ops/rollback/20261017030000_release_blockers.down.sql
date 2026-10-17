-- Rollback of 20261017030000_release_blockers.sql (owner only; one transaction). Roll this back FIRST (before 20261017020000).
-- Restores app_today(), invoice_final_preview() and xero_draft_payload() exactly as hosted had them (copied verbatim from the
-- restored hosted dump) and the previous integrity_check (renamed back). Removes the per-line GST helper, the business
-- date and correction functions and their settings. Stored invoices, dates and corrected customer details are kept
-- (corrections stay as made; their audit entries remain). After this, business_date_override alone decides the date again.
-- Run: npx tsx scripts/sql.ts -f ops/rollback/20261017030000_release_blockers.down.sql
begin;
CREATE OR REPLACE FUNCTION public.app_today()
 RETURNS date
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v text; d date;
begin
  select value into v from app_settings where key = 'business_date_override';
  if v is null or btrim(v) = '' then
    return (now() at time zone 'Australia/Brisbane')::date;
  end if;
  if btrim(v) !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'app_settings business_date_override "%" is not a date (YYYY-MM-DD): refusing to guess the business date', v
      using errcode = 'invalid_datetime_format';
  end if;
  begin
    d := btrim(v)::date;
  exception when others then
    raise exception 'app_settings business_date_override "%" is not a date (YYYY-MM-DD): refusing to guess the business date', v
      using errcode = 'invalid_datetime_format';
  end;
  return d;
end $function$;

CREATE OR REPLACE FUNCTION public.invoice_final_preview(p_project uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- AC-13A: the completion gate, satisfied only through Airtable (Completion Photos / Compliance Certificate).
  if exists (select 1 from v_projects_missing_completion_docs v where v.id = p.id) then
    return jsonb_build_object('ok', false, 'error_class', 'MISSING_DOCUMENT',
      'message', format('%s is missing completion documents (%s); set them to Done in Airtable (Completion Photos / Compliance Certificate), or Waived / Not applicable with a reason in the Note, then invoice', p.project_number,
        (select string_agg(label, ', ' order by label) from v_projects_missing_completion_docs v where v.id = p.id)));
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
end $function$;

CREATE OR REPLACE FUNCTION public.xero_draft_payload(p_invoice uuid, p_tenant text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

drop function if exists integrity_check();
alter function integrity_check_before_release_blockers() rename to integrity_check;
grant execute on function integrity_check() to roofops_dashboard;
drop function if exists web_customer_correct_contact(text, text, integer, text, text, text);
drop function if exists app_business_date();
drop function if exists app_date_at(timestamptz);
drop function if exists gst_line_tax(jsonb, numeric, numeric);
delete from app_settings where key in ('business_date_mode', 'xero.line_tax_amounts', 'customer.correction_roles');
delete from schema_migrations where version = '20261017030000_release_blockers.sql';
commit;
