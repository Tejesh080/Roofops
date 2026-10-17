-- Release blockers found by the independent-verification review (2026-10-17). Narrow fixes to shared, already-live
-- objects; nothing here rewrites a stored date, amount or accounting record.
--
-- 1. Business date. app_today() honoured business_date_override whenever it was set, so a demo date silently
--    became "today" for invoices (issue and due dates sent to Xero), quotes, tasks and every overdue rule. Now the
--    mode is explicit: business_date_mode = REAL (the real date in Brisbane, where the jobs are; the override is
--    ignored and flagged) or SYNTHETIC (the override, which must be a valid date). This migration keeps today's
--    behaviour: SYNTHETIC where an override is set, REAL elsewhere. Switching hosted to REAL is a separate, approved
--    configuration change. Stored dates are never touched; only "today" and what is derived from it changes.
-- 2. GST on multi-line final invoices (FIN-GST-01). RoofOps rounds an invoice's GST once on its total; Xero
--    calculates tax per line, so an invoice with variation lines could come back a cent different and stall after
--    the draft exists. Each Xero line now carries its tax amount, allocated (largest remainder) so the lines add up to
--    RoofOps's GST exactly; n8n 05 sends them as TaxAmount. Until that 05 is deployed (xero.line_tax_amounts = on),
--    a multi-line final is refused at preview, before any approval or Xero call. Single-line finals (every real one
--    so far) are unchanged: their one line carries exactly the GST Xero would calculate.
-- 3. integrity_check: done_has_proof failed open for any topic it did not know (now: unknown topics FAIL and quote
--    hand-offs need their three Airtable links); a side effect a worker claimed and abandoned was invisible (now a
--    WARNING); a synthetic or ignored business date is reported.

-- 1. Business date ------------------------------------------------------------------------------------------------
insert into app_settings (key, value)
select 'business_date_mode',
       case when coalesce(btrim((select value from app_settings where key = 'business_date_override')), '') <> '' then 'SYNTHETIC' else 'REAL' end
on conflict (key) do nothing;

-- The calendar date at an instant, in the business's timezone (Brisbane: no daylight saving). Pure, so it is testable
-- at exact instants (midnight, the Adelaide daylight-saving changes) without touching the clock.
create or replace function app_date_at(p_at timestamptz)
returns date language sql immutable as $$ select (p_at at time zone 'Australia/Brisbane')::date $$;

create or replace function app_today()
returns date language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_mode text; v text; d date;
begin
  select value into v_mode from app_settings where key = 'business_date_mode';
  v_mode := upper(btrim(coalesce(v_mode, 'REAL')));
  if v_mode = 'REAL' then
    return app_date_at(now());
  end if;
  if v_mode <> 'SYNTHETIC' then
    raise exception 'app_settings business_date_mode "%" is neither REAL nor SYNTHETIC: refusing to guess the business date', v_mode
      using errcode = 'invalid_parameter_value';
  end if;
  select value into v from app_settings where key = 'business_date_override';
  if coalesce(btrim(v), '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'app_settings business_date_override "%" is not a date (YYYY-MM-DD) and business_date_mode is SYNTHETIC: refusing to guess the business date', coalesce(v, '')
      using errcode = 'invalid_datetime_format';
  end if;
  begin
    d := btrim(v)::date;
  exception when others then
    raise exception 'app_settings business_date_override "%" is not a date (YYYY-MM-DD) and business_date_mode is SYNTHETIC: refusing to guess the business date', v
      using errcode = 'invalid_datetime_format';
  end;
  return d;
end $$;

-- What the dashboard shows people: which "today" is in force, and whether it is real.
create or replace function app_business_date()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('date', app_today(), 'real_date', app_date_at(now()),
    'mode', upper(btrim(coalesce((select value from app_settings where key = 'business_date_mode'), 'REAL'))),
    'synthetic', upper(btrim(coalesce((select value from app_settings where key = 'business_date_mode'), 'REAL'))) = 'SYNTHETIC')
$$;

-- 2. GST per Xero line -----------------------------------------------------------------------------------------------
insert into app_settings (key, value) values ('xero.line_tax_amounts', 'off') on conflict (key) do nothing;

-- Each line's share of an invoice's GST: exact share = amount x rate / (1 + rate) (prices include GST), rounded down
-- to the cent, then the remaining cents go one each to the lines with the largest remainders (ties: earlier line), so
-- the lines add up to p_gst exactly and no line is more than a cent from its exact share. A single line gets p_gst.
create or replace function gst_line_tax(p_lines jsonb, p_gst numeric, p_rate numeric default 0.1)
returns jsonb language plpgsql immutable as $$
declare v_count int := jsonb_array_length(coalesce(p_lines, '[]'::jsonb)); v_cents int; v_out jsonb;
begin
  if v_count = 0 then return '[]'::jsonb; end if;
  with l as (
    select e.value v, e.ordinality n,
           round((e.value ->> 'quantity')::numeric * (e.value ->> 'unit_amount')::numeric, 2) * p_rate / (1 + p_rate) exact
      from jsonb_array_elements(p_lines) with ordinality e
  ), b as (select v, n, exact, floor(exact * 100) / 100 base from l)
  select round((p_gst - sum(base)) * 100)::int into v_cents from b;
  if v_cents < 0 or v_cents > v_count then
    raise exception 'GST % cannot be split over % line(s) within a cent each (% cents left over)', p_gst, v_count, v_cents using errcode = 'check_violation';
  end if;
  with l as (
    select e.value v, e.ordinality n,
           round((e.value ->> 'quantity')::numeric * (e.value ->> 'unit_amount')::numeric, 2) * p_rate / (1 + p_rate) exact
      from jsonb_array_elements(p_lines) with ordinality e
  ), b as (select v, n, exact, floor(exact * 100) / 100 base from l),
  r as (select v, n, base, row_number() over (order by exact - base desc, n) rk from b)
  select jsonb_agg(v || jsonb_build_object('tax_amount', round(base + case when rk <= v_cents then 0.01 else 0 end, 2)) order by n) into v_out from r;
  return v_out;
end $$;

-- The final-invoice preview: copied verbatim from 20261001110000 (its latest definition) with one insertion only:
-- the multi-line gate and the per-line GST shares (gst_line_tax), just before the successful return.
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

  -- FIN-GST-01: Xero calculates tax per line. Until n8n 05 sends each line's tax amount (xero.line_tax_amounts = on), a
  -- final with variation lines is stopped here, before any approval or Xero call, instead of failing after the draft exists.
  if jsonb_array_length(v_lines) > 1 and coalesce((select value from app_settings where key = 'xero.line_tax_amounts'), 'off') <> 'on' then
    return jsonb_build_object('ok', false, 'error_class', 'SCHEMA_MISMATCH', 'multi_line', true,
      'message', format('%s: a final invoice with variation lines (%s lines) cannot go to Xero yet (Xero rounds GST per line and the draft could differ by a cent). Create it by hand in Xero, or wait until per-line GST is enabled', p.project_number, jsonb_array_length(v_lines)));
  end if;
  v_lines := gst_line_tax(v_lines, v_gst, v_rate);   -- each line carries its share of the GST; the shares add up to v_gst exactly

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

-- The Xero payload built from the canonical invoice (unchanged except that each line carries its tax amount). The
-- approval compares it with the approved preview key by key, so both use gst_line_tax on the same amounts and GST.
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
    'lines', gst_line_tax(coalesce((select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'description', l.description, 'quantity', trim_scale(l.quantity),
                                                           'unit_amount', l.unit_price, 'variation_id', l.variation_id) order by l.line_no)
                         from invoice_lines l where l.invoice_id = i.id), '[]'::jsonb), i.gst_amount, i.gst_rate),
    'xero_account_code', coalesce((select min(l.account_code) from invoice_lines l where l.invoice_id = i.id),
                                  (select value from app_settings where key = 'xero.sales_account_code')),
    'xero_tax_type', (select value from app_settings where key = 'xero.sales_tax_type'),
    'xero_tenant_id', p_tenant, 'xero_tenant_name', (select value from app_settings where key = 'xero.demo_tenant_name'))
  from invoices i join projects p on p.id = i.project_id join customers c on c.id = i.customer_id
  where i.id = p_invoice
$$;

-- 3. integrity_check ---------------------------------------------------------------------------------------------
alter function integrity_check() rename to integrity_check_before_release_blockers;
create or replace function integrity_check()
returns table (entity text, check_key text, status text, failing int, detail text, refs text[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_refs text[]; v_mode text; v_override text;
begin
  return query select c.* from integrity_check_before_release_blockers() c where c.check_key <> 'done_has_proof';

  -- done_has_proof, now failing closed: a DONE side effect whose topic has no rule here is a FAIL, not a pass.
  select array_agg(o.topic || ':' || coalesce(o.payload ->> 'invoice_number', o.payload ->> 'quote_number', o.payload ->> 'project_number', o.aggregate_id::text))
    into v_refs from outbox o
   where o.status = 'DONE' and not case o.topic
     when 'drive.ensure_project_folder' then exists (select 1 from external_links l where l.provider = 'GOOGLE_DRIVE' and l.entity_type = 'project'
                                                       and l.external_type = 'Folder' and l.entity_id = o.aggregate_id and l.verified_at is not null)
     when 'airtable.project_writeback' then exists (select 1 from external_links l where l.provider = 'AIRTABLE' and l.entity_type = 'project'
                                                      and l.external_type = 'Record' and l.entity_id = o.aggregate_id and l.verified_at is not null)
     when 'xero.create_draft_invoice' then o.id <> (select c.id from outbox_current('xero.create_draft_invoice', o.aggregate_id) c)
                                          or exists (select 1 from invoices i where i.id = o.aggregate_id and i.sync_status = 'SYNCED')
     when 'airtable.quote_publish' then (select count(*) from external_links l
                                          where l.provider = 'AIRTABLE' and l.external_type = 'Record' and l.verified_at is not null
                                            and ((l.entity_type = 'quote' and l.entity_id = o.aggregate_id)
                                              or (l.entity_type = 'customer' and l.entity_id::text = o.payload ->> 'customer_id')
                                              or (l.entity_type = 'property' and l.entity_id::text = o.payload ->> 'property_id'))) = 3
     else false end;
  entity := 'side_effect'; check_key := 'done_has_proof';
  status := case when v_refs is null then 'PASS' else 'FAIL' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Every DONE side effect has verified proof (Drive folder, Airtable project or quote/customer/property records, Xero draft for its current generation); a topic without a rule fails'; return next;

  -- A worker claimed it and never reported back (crashed or cut off): nothing else re-drives Drive/Airtable writes.
  select array_agg(o.topic || ':' || coalesce(o.payload ->> 'invoice_number', o.payload ->> 'quote_number', o.payload ->> 'project_number', o.aggregate_id::text) order by o.locked_until)
    into v_refs from outbox o where o.status = 'DISPATCHING' and o.locked_until < now() - interval '15 minutes';
  entity := 'side_effect'; check_key := 'claimed_and_abandoned';
  status := case when v_refs is null then 'PASS' else 'WARNING' end; failing := coalesce(cardinality(v_refs), 0); refs := v_refs;
  detail := 'Side effects claimed by a worker whose lease ran out more than 15 minutes ago without a result; re-drive or investigate them'; return next;

  select upper(btrim(coalesce(value, 'REAL'))) into v_mode from app_settings where key = 'business_date_mode';
  v_mode := coalesce(v_mode, 'REAL');
  select btrim(coalesce(value, '')) into v_override from app_settings where key = 'business_date_override';
  entity := 'settings'; check_key := 'business_date';
  if v_mode = 'SYNTHETIC' then
    status := 'WARNING'; failing := 1; refs := array['synthetic ' || coalesce(v_override, '?'), 'real ' || app_date_at(now())::text];
    detail := 'The business date is SYNTHETIC: invoices, quotes, tasks and overdue rules use the configured demo date, not today';
  elsif coalesce(v_override, '') <> '' then
    status := 'WARNING'; failing := 1; refs := array['ignored override ' || v_override];
    detail := 'business_date_override is set but business_date_mode is REAL, so it is ignored; clear it to avoid confusion';
  else
    status := 'PASS'; failing := 0; refs := null;
    detail := 'The business date is the real date in Brisbane';
  end if;
  return next;
end $$;

revoke execute on all functions in schema public from public;
revoke execute on function gst_line_tax(jsonb, numeric, numeric), app_date_at(timestamptz), integrity_check_before_release_blockers() from roofops_dashboard, roofops_workflow;
grant execute on function integrity_check(), app_business_date() to roofops_dashboard;

-- 4. Correcting a customer's phone or email ------------------------------------------------------------------------
-- Customer details are owned by RoofOps (Airtable edits are reverted), but nothing let staff correct a typo. This changes
-- only the phone and email of one customer, with the screen's record version, a reason and a before/after audit entry.
-- Invoices, approvals and the payloads already sent keep the details they were made with; reconciliation then shows the
-- new values in Airtable. The Xero contact is not changed by RoofOps (the accountant updates it in Xero). The name, the
-- type and which customer an enquiry, quote or project belongs to are deliberately not editable here.
insert into app_settings (key, value) values ('customer.correction_roles', 'ADMIN,OPERATIONS_MANAGER,PROJECT_MANAGER') on conflict (key) do nothing;

create or replace function web_customer_correct_contact(p_token text, p_customer text, p_expected_version int, p_phone text, p_email text, p_reason text)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare
  v_emp employees := staff_session_employee(p_token); c customers; v_before jsonb;
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), ''); v_phone text := nullif(btrim(regexp_replace(coalesce(p_phone, ''), '\s+', ' ', 'g')), '');
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT'); end if;
  if not staff_role_allowed(v_emp, 'customer.correction_roles') then
    return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED', 'detail', format('%s (%s) may not correct customer details', v_emp.employee_code, v_emp.role));
  end if;
  select * into c from customers where customer_number = upper(btrim(coalesce(p_customer, ''))) for update;
  if c.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', coalesce(p_customer, 'no customer')); end if;
  if p_expected_version is distinct from c.record_version then
    return jsonb_build_object('ok', false, 'code', 'STALE', 'detail', format('%s changed since you opened it; reload and check it again', c.customer_number));
  end if;
  if v_phone is null and v_email is null then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'keep a phone number or an email address'); end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'the email address does not look right'); end if;
  if v_phone is not null and length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 8 and 15 then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'the phone number needs 8 to 15 digits');
  end if;
  if length(v_reason) not between 5 and 500 then return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'detail', 'say why (a few words)'); end if;
  if c.phone is not distinct from v_phone and c.email is not distinct from v_email then
    return jsonb_build_object('ok', true, 'unchanged', true, 'customer_number', c.customer_number, 'record_version', c.record_version);
  end if;
  v_before := jsonb_build_object('phone', c.phone, 'email', c.email);
  update customers set phone = v_phone, email = v_email where id = c.id returning * into c;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
  values ('USER', v_emp.employee_code, 'customer.contact_corrected', 'customer', c.id, c.customer_number, v_before,
          jsonb_build_object('phone', c.phone, 'email', c.email), v_reason);
  return jsonb_build_object('ok', true, 'customer_number', c.customer_number, 'record_version', c.record_version, 'phone', c.phone, 'email', c.email);
end $$;
revoke all on function web_customer_correct_contact(text, text, int, text, text, text) from public;
grant execute on function web_customer_correct_contact(text, text, int, text, text, text) to roofops_dashboard;
