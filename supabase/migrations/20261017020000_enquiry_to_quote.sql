-- SALES-01: enquiry -> customer and site -> inspection -> quote, run by signed-in staff in the dashboard.
--
-- Until now an enquiry, its inspection and its quote existed only as imported data: leads was empty, and quotes,
-- customers and properties were created in Airtable by hand. Their CONTENT is RoofOps-owned (field_contract: POSTGRES,
-- projected to Airtable by reconciliation); only a quote's Status and Lost Reason are edited in Airtable, where marking a
-- quote Accepted starts n8n 01 -> wf_quote_accepted -> the project. This migration lets staff create that content here and
-- hands each sent quote to Airtable ONCE (outbox topic airtable.quote_publish, run by n8n 10, unpublished): the customer,
-- property and quote records are created or found by their RoofOps numbers, linked, read back and recorded. From then on
-- the existing paths apply unchanged (reconciliation keeps the fields canonical; acceptance stays in Airtable).
--
-- Every write is a web_* SECURITY DEFINER function taking the staff session token: session, role (app_settings), the
-- lead's state, the record version (stale screens refused) and a request key (a repeated submit returns the first result).

insert into app_settings (key, value) values
  ('sales.roles', 'ADMIN,OPERATIONS_MANAGER,PROJECT_MANAGER,ESTIMATOR'),
  ('sales.inspector_roles', 'ADMIN,OPERATIONS_MANAGER,PROJECT_MANAGER,ESTIMATOR'),
  ('quote.validity_days', '30')
on conflict (key) do nothing;

alter table leads add column if not exists notes text check (notes is null or length(notes) <= 4000);
alter table leads add column if not exists lost_reason text check (lost_reason is null or length(lost_reason) <= 2000);
alter table leads add column if not exists request_key text unique;
alter table leads add column if not exists created_by uuid references employees (id);
alter table leads add column if not exists property_id uuid references properties (id);
alter table leads add column if not exists contacted_at timestamptz;
alter table leads add constraint leads_lost_needs_reason check (status not in ('LOST', 'DISQUALIFIED') or lost_reason is not null);
alter table inspections add column if not exists request_key text unique;
alter table quotes add column if not exists request_key text unique;

-- Existing customers that look like this person (same phone digits, same email, or same name), for the duplicate warning.
create or replace function customer_lookalikes(p_name text, p_email text, p_phone text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('customer_number', c.customer_number, 'display_name', c.display_name,
           'reasons', to_jsonb(array_remove(array[
             case when nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '') = c.phone_normalised then 'same phone' end,
             case when lower(btrim(coalesce(p_email, ''))) <> '' and lower(btrim(p_email)) = lower(c.email) then 'same email' end,
             case when lower(btrim(coalesce(p_name, ''))) = lower(c.display_name) then 'same name' end], null)))
           order by c.customer_number), '[]'::jsonb)
    from customers c
   where c.status = 'ACTIVE'
     and (nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '') = c.phone_normalised
          or (lower(btrim(coalesce(p_email, ''))) <> '' and lower(btrim(p_email)) = lower(c.email))
          or lower(btrim(coalesce(p_name, ''))) = lower(c.display_name))
$$;

-- 1. Record an enquiry (phone, web form, referral ...).
-- An open enquiry for the same person (phone digits, email or name) is shown first and recorded only when the person
-- confirms it is a separate one (p_confirm); a match with an existing customer is only a note (repeat customers are
-- normal). Two people recording the same caller at once are serialised on the phone and email, so both see the other.
create or replace function web_lead_create(p_token text, p_contact_name text, p_phone text, p_email text, p_address text,
                                           p_source text, p_notes text, p_request_key text, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare
  v_emp employees := staff_session_employee(p_token); l leads;
  v_name text := btrim(regexp_replace(coalesce(p_contact_name, ''), '\s+', ' ', 'g'));
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), ''); v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_digits text; v_similar jsonb;
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT'); end if;
  if not staff_role_allowed(v_emp, 'sales.roles') then
    return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED', 'detail', format('%s (%s) may not record enquiries', v_emp.employee_code, v_emp.role));
  end if;
  if length(coalesce(p_request_key, '')) not between 8 and 100 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'missing request key'); end if;
  select * into l from leads where request_key = p_request_key;
  if l.id is not null then return jsonb_build_object('ok', true, 'duplicate', true, 'lead_number', l.lead_number); end if;
  if length(v_name) not between 2 and 120 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'enter the person''s name'); end if;
  if v_phone is null and v_email is null then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'enter a phone number or an email address'); end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'the email address does not look right'); end if;
  if v_phone is not null and length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 8 and 15 then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'the phone number needs 8 to 15 digits');
  end if;
  if coalesce(p_source, '') not in ('GOOGLE_ADS', 'ORGANIC_SEARCH', 'REFERRAL', 'FACEBOOK', 'REPEAT_CUSTOMER', 'BUILDER_REFERRAL', 'LOCAL_SIGNAGE', 'WEBSITE_FORM', 'PHONE', 'OTHER') then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'choose where the enquiry came from');
  end if;
  if length(coalesce(p_notes, '')) > 4000 or length(coalesce(p_address, '')) > 300 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'too long'); end if;
  v_digits := nullif(regexp_replace(coalesce(v_phone, ''), '[^0-9]', '', 'g'), '');
  if v_digits is not null then perform pg_advisory_xact_lock(hashtext('lead:phone:' || v_digits)); end if;   -- always phone, then email
  if v_email is not null then perform pg_advisory_xact_lock(hashtext('lead:email:' || v_email)); end if;
  select jsonb_agg(jsonb_build_object('lead_number', o.lead_number, 'contact_name', o.contact_name, 'status', o.status,
           'received', to_char(o.received_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD'),
           'reasons', to_jsonb(array_remove(array[
             case when v_digits is not null and regexp_replace(coalesce(o.phone, ''), '[^0-9]', '', 'g') = v_digits then 'same phone' end,
             case when v_email is not null and lower(o.email) = v_email then 'same email' end,
             case when lower(o.contact_name) = lower(v_name) then 'same name' end], null))) order by o.received_at desc)
    into v_similar from leads o
   where o.status not in ('LOST', 'DISQUALIFIED', 'WON')
     and ((v_digits is not null and regexp_replace(coalesce(o.phone, ''), '[^0-9]', '', 'g') = v_digits)
          or (v_email is not null and lower(o.email) = v_email) or lower(o.contact_name) = lower(v_name));
  if v_similar is not null and not coalesce(p_confirm, false) then
    return jsonb_build_object('ok', false, 'code', 'POSSIBLE_DUPLICATE_ENQUIRY', 'similar_enquiries', v_similar,
      'lookalikes', customer_lookalikes(v_name, v_email, v_phone),
      'detail', format('%s open enquir%s for this person already (%s); open it instead, or confirm this is a separate job',
                       jsonb_array_length(v_similar), case when jsonb_array_length(v_similar) = 1 then 'y' else 'ies' end,
                       (select string_agg(e ->> 'lead_number', ', ') from jsonb_array_elements(v_similar) e)));
  end if;
  insert into leads (lead_number, source, status, contact_name, email, phone, property_address_text, notes, request_key, created_by, received_at)
  values (next_friendly_id('LEAD', extract(year from app_today())::int), p_source, 'NEW', v_name, v_email, v_phone,
          nullif(btrim(coalesce(p_address, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''), p_request_key, v_emp.id, now())
  returning * into l;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
  values ('USER', v_emp.employee_code, 'lead.created', 'lead', l.id, l.lead_number, jsonb_build_object('source', p_source, 'confirmed_separate_from', case when coalesce(p_confirm, false) then v_similar end),
          format('Enquiry from %s', v_name) || case when coalesce(p_confirm, false) and v_similar is not null then ' (confirmed as separate from an open enquiry)' else '' end);
  return jsonb_build_object('ok', true, 'lead_number', l.lead_number, 'record_version', l.record_version,
                            'lookalikes', customer_lookalikes(v_name, v_email, v_phone),
                            'confirmed_separate', coalesce(p_confirm, false) and v_similar is not null);
end $$;

-- 2. Move an enquiry on: contacted; lost or disqualified (with a reason).
create or replace function web_lead_update(p_token text, p_lead text, p_action text, p_expected_version int, p_reason text)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare v_emp employees := staff_session_employee(p_token); l leads; v_to text; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_from text;
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT'); end if;
  if not staff_role_allowed(v_emp, 'sales.roles') then return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED', 'detail', format('%s (%s) may not update enquiries', v_emp.employee_code, v_emp.role)); end if;
  select * into l from leads where lead_number = upper(btrim(coalesce(p_lead, ''))) for update;
  if l.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', coalesce(p_lead, 'no enquiry')); end if;
  if p_expected_version is distinct from l.record_version then
    return jsonb_build_object('ok', false, 'code', 'STALE', 'detail', format('%s changed since you opened it; reload and check it again', l.lead_number));
  end if;
  v_from := l.status;
  v_to := case
    when p_action = 'contacted' and l.status = 'NEW' then 'CONTACTED'
    when p_action = 'lost' and l.status in ('NEW', 'CONTACTED', 'INSPECTION_BOOKED') then 'LOST'
    when p_action = 'disqualify' and l.status in ('NEW', 'CONTACTED', 'INSPECTION_BOOKED') then 'DISQUALIFIED' end;
  if v_to is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TRANSITION', 'detail', format('%s is %s', l.lead_number, lower(replace(l.status, '_', ' '))));
  end if;
  if v_to in ('LOST', 'DISQUALIFIED') and length(coalesce(v_reason, '')) < 5 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'detail', 'say why (a few words)');
  end if;
  if v_to in ('LOST', 'DISQUALIFIED') then
    update inspections set status = 'CANCELLED', updated_at = now(), record_version = record_version + 1 where lead_id = l.id and status = 'SCHEDULED';
  end if;
  update leads set status = v_to, lost_reason = case when v_to in ('LOST', 'DISQUALIFIED') then v_reason else lost_reason end,
                   contacted_at = case when v_to = 'CONTACTED' then now() else contacted_at end,
                   record_version = record_version + 1, updated_at = now() where id = l.id returning * into l;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
  values ('USER', v_emp.employee_code, 'lead.' || p_action, 'lead', l.id, l.lead_number, jsonb_build_object('status', v_from), jsonb_build_object('status', l.status),
          coalesce(v_reason, format('%s %s', l.lead_number, lower(l.status))));
  return jsonb_build_object('ok', true, 'lead_number', l.lead_number, 'status', l.status, 'record_version', l.record_version);
end $$;

-- 3. Turn an enquiry into a customer and a site: an existing customer (by number) or a new one (refused while it looks
--    like an existing customer, unless the person confirms it is someone else; the pair is then queued for review),
--    and the property found by its address or created. Idempotent per enquiry: converting twice keeps the first.
create or replace function web_lead_convert(p_token text, p_lead text, p_expected_version int, p_customer_number text, p_customer jsonb,
                                            p_property jsonb, p_confirm_new boolean default false)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
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
end $$;

-- 4. Book the inspection (who and when) for a converted enquiry.
create or replace function web_inspection_book(p_token text, p_lead text, p_inspector text, p_when timestamptz, p_request_key text)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare v_emp employees := staff_session_employee(p_token); l leads; i inspections; a employees;
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT'); end if;
  if not staff_role_allowed(v_emp, 'sales.roles') then return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED', 'detail', format('%s (%s) may not book inspections', v_emp.employee_code, v_emp.role)); end if;
  if length(coalesce(p_request_key, '')) not between 8 and 100 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'missing request key'); end if;
  select * into i from inspections where request_key = p_request_key;
  if i.id is not null then return jsonb_build_object('ok', true, 'duplicate', true, 'inspection_number', i.inspection_number); end if;
  select * into l from leads where lead_number = upper(btrim(coalesce(p_lead, ''))) for update;
  if l.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', coalesce(p_lead, 'no enquiry')); end if;
  if l.property_id is null then return jsonb_build_object('ok', false, 'code', 'NOT_CONVERTED', 'detail', 'record the customer and the site first'); end if;
  if l.status not in ('CONTACTED', 'INSPECTION_BOOKED', 'NEW') then return jsonb_build_object('ok', false, 'code', 'INVALID_TRANSITION', 'detail', format('%s is %s', l.lead_number, lower(replace(l.status, '_', ' ')))); end if;
  if exists (select 1 from inspections x where x.lead_id = l.id and x.status = 'SCHEDULED') then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_BOOKED', 'detail', 'an inspection is already booked for this enquiry; record or cancel it first');
  end if;
  select * into a from employees where employee_code = upper(btrim(coalesce(p_inspector, ''))) and is_active;
  if a.id is null or not staff_role_allowed(a, 'sales.inspector_roles') then
    return jsonb_build_object('ok', false, 'code', 'INSPECTOR_UNKNOWN', 'detail', format('%s cannot inspect (an estimator or a manager inspects)', coalesce(nullif(p_inspector, ''), 'nobody')));
  end if;
  if p_when is null or (p_when at time zone 'Australia/Brisbane')::date < app_today() then
    return jsonb_build_object('ok', false, 'code', 'IN_PAST', 'detail', format('pick a time from today (%s)', to_char(app_today(), 'DD Mon YYYY')));
  end if;
  if exists (select 1 from inspections x where x.inspector_id = a.id and x.status = 'SCHEDULED' and abs(extract(epoch from x.scheduled_for - p_when)) < 3600) then
    return jsonb_build_object('ok', false, 'code', 'INSPECTOR_BUSY', 'detail', format('%s already has an inspection within an hour of that time', a.full_name));
  end if;
  insert into inspections (inspection_number, property_id, lead_id, inspector_id, status, scheduled_for, request_key)
  values (next_friendly_id('INS', extract(year from app_today())::int), l.property_id, l.id, a.id, 'SCHEDULED', p_when, p_request_key) returning * into i;
  update leads set status = 'INSPECTION_BOOKED', record_version = record_version + 1, updated_at = now() where id = l.id;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
  values ('USER', v_emp.employee_code, 'inspection.booked', 'inspection', i.id, l.lead_number,
          jsonb_build_object('inspection', i.inspection_number, 'inspector', a.employee_code, 'when', p_when), format('Inspection %s booked with %s', i.inspection_number, a.full_name));
  return jsonb_build_object('ok', true, 'inspection_number', i.inspection_number, 'record_version', i.record_version);
end $$;

-- 5. Record what the inspection found (roof, measurement), or cancel it.
create or replace function web_inspection_record(p_token text, p_inspection text, p_expected_version int, p_action text, p_findings jsonb)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare
  v_emp employees := staff_session_employee(p_token); i inspections; v_area numeric; v_pitch numeric; l leads;
  v_roof text := nullif(p_findings ->> 'roof_type', ''); v_method text := nullif(p_findings ->> 'measurement_method', '');
  v_notes text := nullif(btrim(coalesce(p_findings ->> 'findings', '')), '');
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT'); end if;
  if not staff_role_allowed(v_emp, 'sales.roles') then return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED', 'detail', format('%s (%s) may not record inspections', v_emp.employee_code, v_emp.role)); end if;
  select * into i from inspections where inspection_number = upper(btrim(coalesce(p_inspection, ''))) for update;
  if i.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', coalesce(p_inspection, 'no inspection')); end if;
  if p_expected_version is distinct from i.record_version then return jsonb_build_object('ok', false, 'code', 'STALE', 'detail', format('%s changed since you opened it; reload and check it again', i.inspection_number)); end if;
  if i.status <> 'SCHEDULED' then return jsonb_build_object('ok', false, 'code', 'INVALID_TRANSITION', 'detail', format('%s is %s', i.inspection_number, lower(i.status))); end if;
  select * into l from leads where id = i.lead_id for update;
  if p_action = 'cancel' then
    if length(coalesce(v_notes, '')) < 5 then return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'detail', 'say why (a few words)'); end if;
    update inspections set status = 'CANCELLED', findings = v_notes, record_version = record_version + 1, updated_at = now() where id = i.id returning * into i;
    update leads set status = 'CONTACTED', record_version = record_version + 1, updated_at = now() where id = l.id and status = 'INSPECTION_BOOKED';
  elsif p_action = 'complete' then
    if v_roof is null or v_roof not in ('TILE', 'TERRACOTTA_TILE', 'METAL', 'COLORBOND', 'ZINCALUME', 'OTHER') then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'choose the roof type'); end if;
    begin v_area := nullif(p_findings ->> 'roof_area_sqm', '')::numeric; v_pitch := nullif(p_findings ->> 'pitch_degrees', '')::numeric;
    exception when others then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'area and pitch are numbers'); end;
    if v_area is not null and (v_area <= 0 or v_area > 100000) then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'the roof area must be more than 0 m²'); end if;
    if v_pitch is not null and (v_pitch < 0 or v_pitch > 75) then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'the pitch is 0 to 75 degrees'); end if;
    if v_area is not null and (v_method is null or v_method not in ('TAPE', 'DRONE', 'AERIAL_IMAGERY', 'PLAN_TAKEOFF')) then
      return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'say how the area was measured');
    end if;
    if length(coalesce(v_notes, '')) < 5 then return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'write what you found (a few words at least)'); end if;
    update inspections set status = 'COMPLETED', inspected_on = app_today(), roof_type = v_roof, roof_area_sqm = round(v_area, 1), pitch_degrees = round(v_pitch, 1),
                           measurement_method = case when v_area is null then null else v_method end, findings = v_notes, inspector_id = coalesce(inspector_id, v_emp.id),
                           record_version = record_version + 1, updated_at = now() where id = i.id returning * into i;
    update properties set roof_type = v_roof, updated_at = now() where id = i.property_id and roof_type is distinct from v_roof;
  else
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'unknown action');
  end if;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, after_state, reason)
  values ('USER', v_emp.employee_code, 'inspection.' || case when p_action = 'cancel' then 'cancelled' else 'completed' end, 'inspection', i.id, coalesce(l.lead_number, i.inspection_number),
          jsonb_build_object('inspection', i.inspection_number, 'roof_type', i.roof_type, 'roof_area_sqm', i.roof_area_sqm), v_notes);
  return jsonb_build_object('ok', true, 'inspection_number', i.inspection_number, 'status', i.status, 'record_version', i.record_version);
end $$;

-- Validated quote lines -> rows (shared by draft and revise). Null = fine; else the refusal.
create or replace function quote_lines_problem(p_lines jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare x jsonb; n int := 0; v_qty numeric; v_price numeric;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then return jsonb_build_object('code', 'INVALID', 'detail', 'add at least one line'); end if;
  if jsonb_array_length(p_lines) > 50 then return jsonb_build_object('code', 'INVALID', 'detail', 'at most 50 lines'); end if;
  for x in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    if coalesce(x ->> 'line_kind', '') not in ('MATERIAL', 'LABOUR', 'EQUIPMENT', 'OTHER') then return jsonb_build_object('code', 'INVALID', 'detail', format('line %s: choose material, labour, equipment or other', n)); end if;
    if length(btrim(coalesce(x ->> 'description', ''))) not between 2 and 500 then return jsonb_build_object('code', 'INVALID', 'detail', format('line %s: describe it', n)); end if;
    if length(btrim(coalesce(x ->> 'unit', ''))) not between 1 and 20 then return jsonb_build_object('code', 'INVALID', 'detail', format('line %s: give the unit (e.g. m², LM, EA, hrs)', n)); end if;
    begin v_qty := (x ->> 'quantity')::numeric; v_price := (x ->> 'unit_price')::numeric;
    exception when others then return jsonb_build_object('code', 'INVALID', 'detail', format('line %s: quantity and price are numbers', n)); end;
    if v_qty is null or v_qty <= 0 or v_qty > 100000 then return jsonb_build_object('code', 'INVALID', 'detail', format('line %s: the quantity must be more than 0', n)); end if;
    if v_price is null or v_price < 0 or v_price > 1000000 then return jsonb_build_object('code', 'INVALID', 'detail', format('line %s: the price cannot be negative', n)); end if;
    if x ->> 'line_kind' = 'MATERIAL' and not exists (select 1 from products p where p.product_code = upper(btrim(coalesce(x ->> 'product_code', ''))) and p.is_active) then
      return jsonb_build_object('code', 'INVALID', 'detail', format('line %s: pick the product for a material line', n));
    end if;
  end loop;
  return null;
end $$;

create or replace function quote_insert_version(p_quote uuid, p_version int, p_amount_type text, p_scope text, p_lines jsonb, p_by uuid)
returns quote_versions language plpgsql security definer set search_path = public, pg_temp as $$
declare v quote_versions; x jsonb; n int := 0;
begin
  insert into quote_versions (quote_id, version_number, line_amount_type, gst_rate, scope_summary, created_by)
  values (p_quote, p_version, p_amount_type, 0.1000, p_scope, p_by) returning * into v;
  for x in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    insert into quote_version_lines (quote_version_id, line_no, line_kind, product_id, description, quantity, unit, unit_price)
    values (v.id, n, x ->> 'line_kind', (select p.id from products p where p.product_code = upper(btrim(coalesce(x ->> 'product_code', '')))),
            btrim(x ->> 'description'), (x ->> 'quantity')::numeric, btrim(x ->> 'unit'), round((x ->> 'unit_price')::numeric, 2));
  end loop;
  select * into v from quote_versions where id = v.id;   -- totals re-derived by the line trigger
  return v;
end $$;

-- 6. Draft a quote for a converted enquiry (version 1), or revise a draft/sent quote (a new version).
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
end $$;

-- What Airtable gets for a sent quote: the customer, property and quote rows by their RoofOps numbers (the same values
-- v_airtable_expected projects; links are set by n8n 10 from the record ids it finds or creates).
create or replace function quote_publish_payload(p_quote uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('quote_number', q.quote_number, 'quote_id', q.id, 'customer_number', c.customer_number, 'customer_id', c.id,
    'property_number', pr.property_number, 'property_id', pr.id,
    'customer_fields', jsonb_strip_nulls(jsonb_build_object('fldzmWSHtLVZ4OTmZ', c.customer_number, 'fldI46VewtlNRnwui', c.display_name, 'fldNcSkEiFnb8m4XP', c.email,
      'fldvBKPgd3UeIDYO4', c.phone, 'fldisVgB2WysksjwW', at_title(c.customer_type),
      'fldfNc5n8m2kjiRcB', case when c.preferred_contact = 'SMS' then 'SMS' else at_title(c.preferred_contact) end, 'fldNu4bbDXjMbwmZ8', c.customer_since::text, 'fldDClu1e0ffwnojn', c.id::text)),
    'property_fields', jsonb_strip_nulls(jsonb_build_object('fldIy8ab7Ky67jL31', pr.property_number, 'fldu0CsGG5uPOVbRN', pr.address_line1, 'fldl6gKbKuZSF9MJG', pr.suburb,
      'fldYjfr3STs04XDZr', pr.state, 'flduw5J4VyRoOqEE2', pr.postcode, 'fldMH8wYXmkAYXCxe', at_title(pr.property_type), 'fldhsHUPCZ0pMbXeV', pr.storeys,
      'fldP4PWGxdLZrA5ge', pr.access_notes, 'fldm6rtleyV6yp8ZS', pr.id::text)),
    'quote_fields', jsonb_strip_nulls(jsonb_build_object('fldyP20HNafS614d5', q.quote_number, 'fldQpTa5tvrzlNg1h', sm_label('quote', q.status),
      'fldEjEqlzE8Y0M1nf', qv.version_number, 'fldbfUE8DVh1Dwjfs', qv.total_inc_gst,
      'fldOaXGsOgYHuWFYg', case q.job_type when 'FULL_REROOF' then 'Full Re-roof' else at_title(q.job_type) end,
      'fldhY6d0ikMnsc7D3', at_title(i.roof_type), 'fldLjvBaV1EFB5RMG', i.roof_area_sqm, 'fld5Bz9FDhJSPibPk', est.full_name, 'flduF4QFGUWbkuR2d', at_title(q.lead_source),
      'fldHSFkvwuVLfAS7J', q.created_on::text, 'fldMnoHiondm5jBWv', q.sent_on::text, 'fldVUpqZkVKid3Fyy', q.id::text)))
  from quotes q join customers c on c.id = q.customer_id join properties pr on pr.id = q.property_id
  join lateral (select * from quote_versions v where v.quote_id = q.id order by version_number desc limit 1) qv on true
  left join inspections i on i.id = q.inspection_id left join employees est on est.id = q.estimator_id
  where q.id = p_quote
$$;

-- 7. Send a drafted quote: Sent (the business date), valid for quote.validity_days, and handed to Airtable once.
create or replace function web_quote_send(p_token text, p_quote text, p_expected_version int)
returns jsonb language plpgsql security definer set search_path = extensions, public, pg_temp as $$
declare v_emp employees := staff_session_employee(p_token); q quotes; v_key text;
begin
  if v_emp.id is null then return jsonb_build_object('ok', false, 'code', 'SIGNED_OUT'); end if;
  if not staff_role_allowed(v_emp, 'sales.roles') then return jsonb_build_object('ok', false, 'code', 'ACTOR_UNAUTHORIZED', 'detail', format('%s (%s) may not send quotes', v_emp.employee_code, v_emp.role)); end if;
  select * into q from quotes where quote_number = upper(btrim(coalesce(p_quote, ''))) for update;
  if q.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', coalesce(p_quote, 'no quote')); end if;
  if q.status = 'SENT' then return jsonb_build_object('ok', true, 'duplicate', true, 'quote_number', q.quote_number, 'status', q.status); end if;
  if p_expected_version is distinct from q.record_version then return jsonb_build_object('ok', false, 'code', 'STALE', 'detail', format('%s changed since you opened it; reload and check it again', q.quote_number)); end if;
  if q.status <> 'DRAFT' then return jsonb_build_object('ok', false, 'code', 'INVALID_TRANSITION', 'detail', format('%s is %s', q.quote_number, lower(q.status))); end if;
  if (select total_inc_gst from quote_versions where quote_id = q.id order by version_number desc limit 1) <= 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'detail', 'a quote of $0 cannot be sent');
  end if;
  update quotes set status = 'SENT', sent_on = coalesce(sent_on, app_today()),
                    valid_until = coalesce(valid_until, app_today() + coalesce((select value::int from app_settings where key = 'quote.validity_days'), 30)),
                    record_version = record_version + 1, updated_at = now() where id = q.id returning * into q;
  update leads set status = 'QUOTED', record_version = record_version + 1, updated_at = now() where id = q.lead_id and status in ('NEW', 'CONTACTED', 'INSPECTION_BOOKED');
  v_key := 'airtable:quote-publish:' || q.id;
  if not exists (select 1 from external_links l where l.provider = 'AIRTABLE' and l.entity_type = 'quote' and l.entity_id = q.id and l.verified_at is not null) then
    insert into outbox (topic, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload)
    values ('airtable.quote_publish', 'quote', q.id, gen_random_uuid(), v_key, quote_publish_payload(q.id))
    on conflict (idempotency_key) do nothing;
  end if;
  insert into audit_events (actor_type, actor_id, action, entity_type, entity_id, business_reference, before_state, after_state, reason)
  values ('USER', v_emp.employee_code, 'quote.sent', 'quote', q.id, q.quote_number, jsonb_build_object('status', 'DRAFT'),
          jsonb_build_object('status', 'SENT', 'sent_on', q.sent_on, 'valid_until', q.valid_until), format('Quote %s sent to the customer', q.quote_number));
  return jsonb_build_object('ok', true, 'quote_number', q.quote_number, 'status', q.status, 'valid_until', q.valid_until, 'record_version', q.record_version,
                            'airtable_key', v_key);
end $$;

-- n8n 10 (unpublished): the next quote waiting to be handed to Airtable (due now; never one that is being sent).
create or replace function wf_quote_publish_next(p_worker text default 'n8n:10')
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('worker', p_worker, 'writes', coalesce(jsonb_agg(jsonb_build_object('key', o.idempotency_key, 'quote_number', o.payload ->> 'quote_number')), '[]'::jsonb))
    from (select * from outbox o where o.topic = 'airtable.quote_publish'
             and ((o.status in ('PENDING', 'FAILED') and o.next_attempt_at <= now())
                  or (o.status = 'DISPATCHING' and o.locked_until < now()))   -- a run that died holding it: its lease ran out
           order by o.created_at limit 1) o
$$;

-- The side-effect completion core (copied from 20261001170000 unchanged) with one more topic, airtable.quote_publish, and two
-- generalisations a quote needs: its number as the business reference, and no workflow-run step when it has no run.
create or replace function wf_complete_side_effect_core(p_key text, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
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
end $$;

-- Read models for the dashboard (contact details are staff data; the views are readable by the dashboard role only).
create or replace view v_dashboard_leads as
select l.lead_number, l.status, l.source, l.contact_name, l.phone, l.email, l.property_address_text, l.notes, l.lost_reason, l.received_at, l.contacted_at,
       l.record_version, c.customer_number, c.display_name as customer_name, pr.property_number,
       concat_ws(', ', pr.address_line1, pr.suburb, pr.state || ' ' || pr.postcode) as site, cb.full_name as created_by_name,
       coalesce((select jsonb_agg(jsonb_build_object('inspection_number', i.inspection_number, 'status', i.status, 'inspector', ie.full_name,
               'scheduled_for', to_char(i.scheduled_for at time zone 'Australia/Brisbane', 'YYYY-MM-DD"T"HH24:MI'), 'inspected_on', i.inspected_on,
               'roof_type', i.roof_type, 'roof_area_sqm', i.roof_area_sqm, 'pitch_degrees', i.pitch_degrees, 'measurement_method', i.measurement_method,
               'findings', i.findings, 'record_version', i.record_version) order by i.created_at)
          from inspections i left join employees ie on ie.id = i.inspector_id where i.lead_id = l.id), '[]'::jsonb) as inspections,
       coalesce((select jsonb_agg(jsonb_build_object('quote_number', q.quote_number, 'status', q.status, 'record_version', q.record_version) order by q.created_at)
          from quotes q where q.lead_id = l.id), '[]'::jsonb) as quotes,
       (select p.project_number from quotes q join projects p on p.quote_id = q.id where q.lead_id = l.id limit 1) as project_number
from leads l left join customers c on c.id = l.customer_id left join properties pr on pr.id = l.property_id left join employees cb on cb.id = l.created_by;

create or replace view v_dashboard_quotes as
select q.quote_number, q.status, q.job_type, q.created_on, q.sent_on, q.valid_until, q.accepted_on, q.lost_reason, q.record_version,
       l.lead_number, c.customer_number, c.display_name as customer_name, pr.property_number,
       concat_ws(', ', pr.address_line1, pr.suburb, pr.state || ' ' || pr.postcode) as site, e.full_name as estimator,
       qv.version_number, qv.line_amount_type, qv.subtotal_ex_gst, qv.gst_amount, qv.total_inc_gst, qv.scope_summary,
       coalesce((select jsonb_agg(jsonb_build_object('line_no', ln.line_no, 'line_kind', ln.line_kind, 'product_code', pd.product_code, 'description', ln.description,
               'quantity', ln.quantity, 'unit', ln.unit, 'unit_price', ln.unit_price, 'line_amount', ln.line_amount) order by ln.line_no)
          from quote_version_lines ln left join products pd on pd.id = ln.product_id where ln.quote_version_id = qv.id), '[]'::jsonb) as lines,
       (select case when o.status = 'FAILED' and o.next_attempt_at = 'infinity' then 'STOPPED' when o.status = 'FAILED' then 'RETRYING' else o.status end
          from outbox o where o.topic = 'airtable.quote_publish' and o.aggregate_id = q.id) as airtable_handoff,   -- PENDING, DISPATCHING, RETRYING, STOPPED, DONE
       (select o.last_error from outbox o where o.topic = 'airtable.quote_publish' and o.aggregate_id = q.id) as airtable_handoff_error,
       exists (select 1 from external_links x where x.provider = 'AIRTABLE' and x.entity_type = 'quote' and x.entity_id = q.id and x.verified_at is not null) as in_airtable,
       (select p.project_number from projects p where p.quote_id = q.id) as project_number
from quotes q join customers c on c.id = q.customer_id join properties pr on pr.id = q.property_id
join lateral (select * from quote_versions v where v.quote_id = q.id order by version_number desc limit 1) qv on true
left join leads l on l.id = q.lead_id left join employees e on e.id = q.estimator_id;

create or replace view v_dashboard_products as
select product_code, name, category, unit from products where is_active;

create or replace view v_dashboard_customer_directory as
select customer_number, display_name, customer_type, email, phone, record_version from customers where status = 'ACTIVE';

revoke execute on all functions in schema public from public;
revoke execute on function customer_lookalikes(text, text, text), quote_lines_problem(jsonb), quote_insert_version(uuid, int, text, text, jsonb, uuid),
  quote_publish_payload(uuid), wf_complete_side_effect_core(text, jsonb) from roofops_workflow, roofops_dashboard;
grant execute on function web_lead_create(text, text, text, text, text, text, text, text, boolean), web_lead_update(text, text, text, int, text),
  web_lead_convert(text, text, int, text, jsonb, jsonb, boolean), web_inspection_book(text, text, text, timestamptz, text),
  web_inspection_record(text, text, int, text, jsonb), web_quote_save(text, text, text, int, text, text, text, jsonb, text),
  web_quote_send(text, text, int) to roofops_dashboard;
grant execute on function wf_quote_publish_next(text) to roofops_workflow;
grant select on v_dashboard_leads, v_dashboard_quotes, v_dashboard_products, v_dashboard_customer_directory to roofops_dashboard;

-- Which roles may run sales (so the dashboard offers the forms to exactly the people the database allows).
create or replace view v_dashboard_sales_roles as
select (select value from app_settings where key = 'sales.roles') as sales_roles,
       (select value from app_settings where key = 'customer.correction_roles') as correction_roles;   -- set by 20261017030000
grant select on v_dashboard_sales_roles to roofops_dashboard;

-- An accepted quote wins its enquiry (whichever path accepted it: Airtable via n8n 01, or a test), so the pipeline never
-- shows a job that became a project as still "Quoted".
create or replace function lead_won_on_quote_accepted() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'ACCEPTED' and old.status is distinct from 'ACCEPTED' and new.lead_id is not null then
    update leads set status = 'WON', lost_reason = null where id = new.lead_id and status <> 'WON';
  -- Its last open quote marked Lost or Expired in Airtable (n8n 06): the enquiry is lost too, for the same reason, so the
  -- pipeline never keeps it "Quoted". (Also how a quote sent to the wrong customer is closed before re-entering it.)
  elsif new.status in ('LOST', 'EXPIRED') and old.status is distinct from new.status and new.lead_id is not null
        and not exists (select 1 from quotes o where o.lead_id = new.lead_id and o.id <> new.id and o.status in ('DRAFT', 'SENT', 'ACCEPTED')) then
    update leads set status = 'LOST', record_version = record_version + 1, updated_at = now(),
           lost_reason = coalesce(nullif(btrim(new.lost_reason), ''), format('Quote %s %s', new.quote_number, lower(new.status)))
     where id = new.lead_id and status = 'QUOTED';
  end if;
  return new;
end $$;
revoke all on function lead_won_on_quote_accepted() from public;
drop trigger if exists quotes_win_lead on quotes;
create trigger quotes_win_lead after update of status on quotes for each row execute function lead_won_on_quote_accepted();

-- n8n 10 records a failed quote hand-off here. wf_fail_side_effect logs into the project's workflow run, and a quote
-- hand-off has none (recording a failure there is refused), so it gets its own: a bounded retry with backoff, then the
-- write stops (never marked done) and ONE exception carries the quote number. ops/requeue-quote-publish.sql re-queues it.
create or replace function wf_quote_publish_fail(p_key text, p_error_class text, p_message text,
                                                 p_http_status int default null, p_retry_after_seconds int default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
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
end $$;
revoke all on function wf_quote_publish_fail(text, text, text, int, int) from public;
grant execute on function wf_quote_publish_fail(text, text, text, int, int) to roofops_workflow;
