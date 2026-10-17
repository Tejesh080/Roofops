-- Rollback of 20261017040000_sales_reliability.sql (owner only; one transaction). Roll this back FIRST (before 20261017030000).
-- Stop n8n 10 first. Restores web_quote_save, web_lead_convert and wf_complete_side_effect_core exactly as they were before
-- it (copied verbatim from a database migrated to 20261017030000) and drops the one-active-owner index. Kept on purpose:
-- v_dashboard_quotes (its "latest hand-off" form also reads a quote that was published twice, which the earlier form
-- cannot) and every record: quotes, versions, hand-offs (including the ":vN" ones) and ownership rows.
-- Run: npx tsx scripts/sql.ts -f ops/rollback/20261017040000_sales_reliability.down.sql
begin;
CREATE OR REPLACE FUNCTION public.web_quote_save(p_token text, p_lead text, p_quote text, p_expected_version integer, p_job_type text, p_amount_type text, p_scope text, p_lines jsonb, p_request_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'extensions', 'public', 'pg_temp'
AS $function$
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
  else   -- a revision: a new version of a draft or sent quote
    select * into q from quotes where quote_number = upper(btrim(p_quote)) for update;
    if q.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', p_quote); end if;
    if exists (select 1 from audit_events a where a.action = 'quote.revised' and a.entity_id = q.id and a.after_state ->> 'request_key' = p_request_key) then
      return jsonb_build_object('ok', true, 'duplicate', true, 'quote_number', q.quote_number);
    end if;
    if p_expected_version is distinct from q.record_version then return jsonb_build_object('ok', false, 'code', 'STALE', 'detail', format('%s changed since you opened it; reload and check it again', q.quote_number)); end if;
    if q.status not in ('DRAFT', 'SENT') then return jsonb_build_object('ok', false, 'code', 'INVALID_TRANSITION', 'detail', format('%s is %s: it cannot change', q.quote_number, lower(q.status))); end if;
    select coalesce(max(version_number), 0) + 1 into v_next from quote_versions where quote_id = q.id;
    v := quote_insert_version(q.id, v_next, p_amount_type, v_scope, p_lines, v_emp.id);
    update quotes set job_type = p_job_type, record_version = record_version + 1, updated_at = now() where id = q.id returning * into q;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
    values ('USER', v_emp.employee_code, 'quote.revised', 'quote', q.id, q.quote_number,
            jsonb_build_object('version', v_next, 'total_inc_gst', v.total_inc_gst, 'request_key', p_request_key), format('Quote %s version %s', q.quote_number, v_next));
  end if;
  return jsonb_build_object('ok', true, 'quote_number', q.quote_number, 'version', v.version_number, 'status', q.status,
                            'total_inc_gst', v.total_inc_gst, 'gst_amount', v.gst_amount, 'record_version', q.record_version);
end $function$;

CREATE OR REPLACE FUNCTION public.web_lead_convert(p_token text, p_lead text, p_expected_version integer, p_customer_number text, p_customer jsonb, p_property jsonb, p_confirm_new boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'extensions', 'public', 'pg_temp'
AS $function$
declare
  v_emp employees := staff_session_employee(p_token); l leads; c customers; pr properties; v_look jsonb; v_new boolean := false;
  v_line1 text := btrim(regexp_replace(coalesce(p_property ->> 'address_line1', ''), '\s+', ' ', 'g'));
  v_suburb text := initcap(btrim(regexp_replace(coalesce(p_property ->> 'suburb', ''), '\s+', ' ', 'g'))); v_state text := upper(btrim(coalesce(p_property ->> 'state', '')));
  v_post text := btrim(coalesce(p_property ->> 'postcode', '')); v_ptype text := coalesce(p_property ->> 'property_type', 'DETACHED_HOUSE');
  v_storeys int; v_ctype text := coalesce(p_customer ->> 'customer_type', 'RESIDENTIAL');
  v_cname text := btrim(regexp_replace(coalesce(p_customer ->> 'display_name', ''), '\s+', ' ', 'g'));
  v_cemail text := nullif(lower(btrim(coalesce(p_customer ->> 'email', ''))), ''); v_cphone text := nullif(btrim(coalesce(p_customer ->> 'phone', '')), '');
  v_other customers;
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT'); end if;
  if not staff_role_allowed(v_emp, 'sales.roles') then return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED', 'detail', format('%s (%s) may not create customers', v_emp.employee_code, v_emp.role)); end if;
  select * into l from leads where lead_number = upper(btrim(coalesce(p_lead, ''))) for update;
  if l.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', coalesce(p_lead, 'no enquiry')); end if;
  if l.customer_id is not null and l.property_id is not null then
    return jsonb_build_object('ok', true, 'duplicate', true, 'lead_number', l.lead_number,
      'customer_number', (select customer_number from customers where id = l.customer_id), 'property_number', (select property_number from properties where id = l.property_id));
  end if;
  if p_expected_version is distinct from l.record_version then return jsonb_build_object('ok', false, 'code', 'STALE', 'detail', format('%s changed since you opened it; reload and check it again', l.lead_number)); end if;
  if l.status in ('LOST', 'DISQUALIFIED', 'WON') then return jsonb_build_object('ok', false, 'code', 'INVALID_TRANSITION', 'detail', format('%s is %s', l.lead_number, lower(l.status))); end if;

  -- The site first (validation before anything is written).
  if length(v_line1) not between 3 and 200 or length(v_suburb) not between 2 and 80 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'enter the street address and suburb'); end if;
  if v_state not in ('QLD', 'NSW', 'VIC', 'TAS', 'SA', 'WA', 'NT', 'ACT') then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'choose the state'); end if;
  if v_post !~ '^[0-9]{4}$' then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'the postcode has 4 digits'); end if;
  if v_ptype not in ('DETACHED_HOUSE', 'TOWNHOUSE', 'SMALL_COMMERCIAL', 'INDUSTRIAL', 'STRATA_COMPLEX') then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'choose the kind of building'); end if;
  begin v_storeys := coalesce(nullif(p_property ->> 'storeys', '')::int, 1); exception when others then v_storeys := 0; end;
  if v_storeys not between 1 and 6 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'storeys: 1 to 6'); end if;

  if nullif(btrim(coalesce(p_customer_number, '')), '') is not null then
    select * into c from customers where customer_number = upper(btrim(p_customer_number)) and status = 'ACTIVE';
    if c.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', format('%s is not an active customer', p_customer_number)); end if;
  else
    if length(v_cname) not between 2 and 120 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'enter the customer''s name'); end if;
    if v_ctype not in ('RESIDENTIAL', 'COMMERCIAL', 'BUILDER', 'STRATA') then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'choose the kind of customer'); end if;
    if v_cemail is null and v_cphone is null then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'enter a phone number or an email address'); end if;
    if v_cemail is not null and v_cemail !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'the email address does not look right'); end if;
    v_look := customer_lookalikes(v_cname, v_cemail, v_cphone);
    if jsonb_array_length(v_look) > 0 and not coalesce(p_confirm_new, false) then
      return jsonb_build_object('ok', false, 'code', 'POSSIBLE_DUPLICATE', 'lookalikes', v_look,
        'detail', format('%s already looks like %s; pick that customer, or confirm this is someone else', v_cname,
                         (select string_agg((x ->> 'display_name') || ' (' || (x ->> 'customer_number') || ')', ', ') from jsonb_array_elements(v_look) x)));
    end if;
    insert into customers (customer_number, customer_type, display_name, email, phone, preferred_contact, customer_since)
    values (next_friendly_id('CUST'), v_ctype, v_cname, v_cemail, v_cphone, case when v_cphone is not null then 'PHONE' else 'EMAIL' end, app_today())
    returning * into c;
    v_new := true;
    for v_other in select x.* from customers x join jsonb_array_elements(v_look) j on j ->> 'customer_number' = x.customer_number loop
      insert into customer_match_candidates (customer_id, candidate_customer_id, match_score, match_reasons)
      values (least(c.id, v_other.id), greatest(c.id, v_other.id), 0.700,
              (select j -> 'reasons' from jsonb_array_elements(v_look) j where j ->> 'customer_number' = v_other.customer_number))
      on conflict do nothing;
    end loop;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
    values ('USER', v_emp.employee_code, 'customer.created', 'customer', c.id, c.customer_number,
            jsonb_build_object('from_lead', l.lead_number, 'confirmed_not_duplicate_of', v_look), format('Customer %s from enquiry %s', v_cname, l.lead_number));
  end if;

  select * into pr from properties where lower(address_line1) = lower(v_line1) and upper(suburb) = upper(v_suburb) and state = v_state and postcode = v_post for update;
  if pr.id is null then
    insert into properties (property_number, address_line1, address_line2, suburb, state, postcode, property_type, storeys, access_notes)
    values (next_friendly_id('PROP'), v_line1, nullif(btrim(coalesce(p_property ->> 'address_line2', '')), ''), v_suburb, v_state, v_post, v_ptype, v_storeys,
            nullif(btrim(coalesce(p_property ->> 'access_notes', '')), ''))
    returning * into pr;
  end if;
  insert into customer_properties (customer_id, property_id, relationship, valid_from) values (c.id, pr.id, 'OWNER', app_today()) on conflict do nothing;
  update leads set customer_id = c.id, property_id = pr.id, status = case when status = 'NEW' then 'CONTACTED' else status end,
                   contacted_at = coalesce(contacted_at, now()), record_version = record_version + 1, updated_at = now() where id = l.id returning * into l;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
  values ('USER', v_emp.employee_code, 'lead.converted', 'lead', l.id, l.lead_number,
          jsonb_build_object('customer', c.customer_number, 'new_customer', v_new, 'property', pr.property_number),
          format('%s is %s at %s', l.lead_number, c.display_name, pr.property_number));
  return jsonb_build_object('ok', true, 'lead_number', l.lead_number, 'customer_number', c.customer_number, 'new_customer', v_new,
                            'property_number', pr.property_number, 'record_version', l.record_version);
end $function$;

CREATE OR REPLACE FUNCTION public.wf_complete_side_effect_core(p_key text, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_ref := coalesce(o.payload ->> 'invoice_number', o.payload ->> 'project_number', o.payload ->> 'quote_number');

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
      -- AC-14C B2: a supervised replacement (generation >= 2) whose predecessor generation is superseded may move the
      -- one current link to the new InvoiceID; anything else still refuses a second link.
      if o.generation >= 2 and exists (select 1 from invoice_xero_draft_generations g
             where g.invoice_id = o.aggregate_id and g.generation = o.generation - 1 and g.superseded_at is not null) then
        update external_links set external_id = p_result ->> 'invoice_id',
               external_url = 'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=' || (p_result ->> 'invoice_id'),
               last_synced_at = now(), verified_at = now()
         where provider = 'XERO' and entity_type = 'invoice' and entity_id = o.aggregate_id and external_type = 'Invoice';
      else
        raise exception 'invoice % already linked to Xero invoice %, refusing a second %', v_ref, v_existing, p_result ->> 'invoice_id'
          using errcode = 'unique_violation';
      end if;
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
  elsif o.topic = 'airtable.quote_publish' then
    -- SALES-01: the customer, property and quote rows exist in Airtable (found or created by their RoofOps numbers), the
    -- quote row links to that customer and property, and each was read back carrying its number.
    if coalesce(p_result ->> 'quote_record_id', '') !~ '^rec[A-Za-z0-9]{14}$' or coalesce(p_result ->> 'customer_record_id', '') !~ '^rec[A-Za-z0-9]{14}$'
       or coalesce(p_result ->> 'property_record_id', '') !~ '^rec[A-Za-z0-9]{14}$' then
      raise exception 'airtable quote publish result needs quote_record_id, customer_record_id and property_record_id (recXXXXXXXXXXXXXX)' using errcode = 'check_violation';
    end if;
    if p_result ->> 'quote_number' is distinct from o.payload ->> 'quote_number' or p_result ->> 'customer_number' is distinct from o.payload ->> 'customer_number'
       or p_result ->> 'property_number' is distinct from o.payload ->> 'property_number' then
      raise exception 'airtable records read back do not carry quote % / customer % / property %', o.payload ->> 'quote_number',
        o.payload ->> 'customer_number', o.payload ->> 'property_number' using errcode = 'check_violation';
    end if;
    if not coalesce(p_result -> 'quote_customer_link_ids' ? (p_result ->> 'customer_record_id'), false)
       or not coalesce(p_result -> 'quote_property_link_ids' ? (p_result ->> 'property_record_id'), false) then
      raise exception 'airtable quote % is not linked to its customer and property records', o.payload ->> 'quote_number' using errcode = 'check_violation';
    end if;
    for v_sub in select * from jsonb_array_elements(jsonb_build_array(
        jsonb_build_object('entity', 'quote', 'id', o.payload ->> 'quote_id', 'rec', p_result ->> 'quote_record_id'),
        jsonb_build_object('entity', 'customer', 'id', o.payload ->> 'customer_id', 'rec', p_result ->> 'customer_record_id'),
        jsonb_build_object('entity', 'property', 'id', o.payload ->> 'property_id', 'rec', p_result ->> 'property_record_id'))) loop
      select external_id into v_existing from external_links
       where provider = 'AIRTABLE' and entity_type = v_sub ->> 'entity' and entity_id = (v_sub ->> 'id')::uuid and external_type = 'Record';
      if v_existing is not null and v_existing <> v_sub ->> 'rec' then
        raise exception '% % already linked to Airtable record %, refusing a second record %', v_sub ->> 'entity', v_sub ->> 'id', v_existing, v_sub ->> 'rec'
          using errcode = 'unique_violation';
      end if;
      insert into external_links (provider, entity_type, entity_id, external_type, external_id, last_synced_at, verified_at)
      values ('AIRTABLE', v_sub ->> 'entity', (v_sub ->> 'id')::uuid, 'Record', v_sub ->> 'rec', now(), now())
      on conflict (provider, entity_type, entity_id, external_type) do update set verified_at = now(), last_synced_at = now();
    end loop;
    insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, external_reference, reason, correlation_id)
    values ('INTEGRATION', 'airtable', 'airtable.quote.published', 'quote', o.aggregate_id, v_ref,
            p_result - 'verified', p_result ->> 'quote_record_id', 'Quote, customer and property records in Airtable, linked and read back', o.correlation_id);
    -- A hand-off that failed earlier and was re-queued: its exception is answered (it has no workflow run to do it below).
    update workflow_exceptions set resolution_status = 'RESOLVED', resolved_at = now(), resolved_by_system = 'workflow:airtable.quote_publish',
           resolution_note = 'The quote, customer and property were added to Airtable and read back'
     where entity_type = 'quote' and entity_id = o.aggregate_id and resolution_status in ('OPEN', 'RETRY_QUEUED')
       and error_message like 'airtable.quote_publish:%';
  else
    raise exception 'unknown side-effect topic %', o.topic;
  end if;

  update outbox set status = 'DONE', dispatched_at = now(), locked_until = null, result = p_result where idempotency_key = p_key;
  perform wf_log_event(p_key || ':done:' || o.attempts, o.correlation_id, null, replace(o.topic, 'ensure_', '') || '.verified',
    case when o.topic = 'airtable.quote_publish' then 'quote' else 'project' end, o.aggregate_id, v_ref, 'INTEGRATION', o.topic, 'n8n', 'SUCCEEDED', null,
    jsonb_build_object('attempt', o.attempts, 'external_id', coalesce(p_result ->> 'folder_id', p_result ->> 'project_record_id', p_result ->> 'invoice_id', p_result ->> 'quote_record_id')), null);

  select id into v_run from workflow_runs where entity_id = o.aggregate_id order by started_at desc limit 1;
  if v_run is not null or o.topic <> 'airtable.quote_publish' then   -- only a quote hand-off has no workflow run; other topics keep the not-null guard
  insert into workflow_run_steps (run_id, attempt, seq, step_key, status, finished_at, detail)
  values (v_run, o.attempts, (select coalesce(max(seq), 0) + 1 from workflow_run_steps where run_id = v_run), o.topic, 'SUCCEEDED', now(),
          jsonb_build_object('attempt', o.attempts, 'external_id', coalesce(p_result ->> 'folder_id', p_result ->> 'project_record_id', p_result ->> 'invoice_id')));
  end if;
  select count(*) into v_left from outbox where aggregate_id = o.aggregate_id and status <> 'DONE';
  if v_left = 0 then
    update workflow_runs set status = 'SUCCEEDED', finished_at = now() where id = v_run;
    update workflow_exceptions set resolution_status = 'RESOLVED', resolved_at = now(), resolved_by_system = 'workflow:' || (select workflow_key from workflow_runs where id = v_run),
           resolution_note = 'Auto-resolved: side effect succeeded on retry'
     where workflow_run_id = v_run and resolution_status in ('OPEN','RETRY_QUEUED');
  end if;
  return jsonb_build_object('status', 'RECORDED', 'key', p_key, 'remaining_side_effects', v_left);
end $function$;

drop index if exists customer_properties_one_active_owner;
delete from schema_migrations where version = '20261017040000_sales_reliability.sql';
commit;
