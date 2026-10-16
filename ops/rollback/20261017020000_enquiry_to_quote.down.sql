-- Rollback of 20261017020000_enquiry_to_quote.sql (owner only; one transaction).
-- Stop n8n 10 first. Refuses while a quote hand-off to Airtable is queued, running or due a retry (a stopped one is fine).
-- Restores wf_complete_side_effect_core exactly as hosted had it (copied verbatim: the Drive, Airtable write-back and Xero
-- paths are unchanged by the migration) and removes the enquiry, inspection and quote functions, their views, the
-- "accepted quote wins its enquiry" trigger and the settings. Records already made stay: enquiries, customers, sites,
-- inspections, quotes and their versions, finished hand-offs, Airtable links and audit history; the added columns stay
-- (nullable). The dashboard then shows Sales as unavailable; quote acceptance through Airtable and n8n 01 is unaffected.
-- Run: npx tsx scripts/sql.ts -f ops/rollback/20261017020000_enquiry_to_quote.down.sql
begin;
do $$ begin
  if exists (select 1 from outbox where topic = 'airtable.quote_publish'
               and (status in ('PENDING', 'DISPATCHING') or (status = 'FAILED' and next_attempt_at <> 'infinity'))) then
    raise exception 'quote hand-offs to Airtable are queued, running or due a retry: stop n8n 10 and let them finish or stop before rolling back';
  end if;
end $$;
drop trigger if exists quotes_win_lead on quotes;
drop function if exists lead_won_on_quote_accepted();
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
  v_ref := coalesce(o.payload ->> 'invoice_number', o.payload ->> 'project_number');

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
  else
    raise exception 'unknown side-effect topic %', o.topic;
  end if;

  update outbox set status = 'DONE', dispatched_at = now(), locked_until = null, result = p_result where idempotency_key = p_key;
  perform wf_log_event(p_key || ':done:' || o.attempts, o.correlation_id, null, replace(o.topic, 'ensure_', '') || '.verified',
    'project', o.aggregate_id, v_ref, 'INTEGRATION', o.topic, 'n8n', 'SUCCEEDED', null,
    jsonb_build_object('attempt', o.attempts, 'external_id', coalesce(p_result ->> 'folder_id', p_result ->> 'project_record_id', p_result ->> 'invoice_id')), null);

  select id into v_run from workflow_runs where entity_id = o.aggregate_id order by started_at desc limit 1;
  insert into workflow_run_steps (run_id, attempt, seq, step_key, status, finished_at, detail)
  values (v_run, o.attempts, (select coalesce(max(seq), 0) + 1 from workflow_run_steps where run_id = v_run), o.topic, 'SUCCEEDED', now(),
          jsonb_build_object('attempt', o.attempts, 'external_id', coalesce(p_result ->> 'folder_id', p_result ->> 'project_record_id', p_result ->> 'invoice_id')));
  select count(*) into v_left from outbox where aggregate_id = o.aggregate_id and status <> 'DONE';
  if v_left = 0 then
    update workflow_runs set status = 'SUCCEEDED', finished_at = now() where id = v_run;
    update workflow_exceptions set resolution_status = 'RESOLVED', resolved_at = now(), resolved_by_system = 'workflow:' || (select workflow_key from workflow_runs where id = v_run),
           resolution_note = 'Auto-resolved: side effect succeeded on retry'
     where workflow_run_id = v_run and resolution_status in ('OPEN','RETRY_QUEUED');
  end if;
  return jsonb_build_object('status', 'RECORDED', 'key', p_key, 'remaining_side_effects', v_left);
end $function$;

drop view if exists v_dashboard_sales_roles;
drop view if exists v_dashboard_customer_directory;
drop view if exists v_dashboard_products;
drop view if exists v_dashboard_quotes;
drop view if exists v_dashboard_leads;
drop function if exists wf_quote_publish_fail(text, text, text, integer, integer);
drop function if exists wf_quote_publish_next(text);
drop function if exists web_quote_send(text, text, integer);
drop function if exists web_quote_save(text, text, text, integer, text, text, text, jsonb, text);
drop function if exists quote_publish_payload(uuid);
drop function if exists quote_insert_version(uuid, integer, text, text, jsonb, uuid);
drop function if exists quote_lines_problem(jsonb);
drop function if exists web_inspection_record(text, text, integer, text, jsonb);
drop function if exists web_inspection_book(text, text, text, timestamptz, text);
drop function if exists web_lead_convert(text, text, integer, text, jsonb, jsonb, boolean);
drop function if exists web_lead_update(text, text, text, integer, text);
drop function if exists web_lead_create(text, text, text, text, text, text, text, text);
drop function if exists customer_lookalikes(text, text, text);
alter table leads drop constraint if exists leads_lost_needs_reason;
delete from app_settings where key in ('sales.roles', 'sales.inspector_roles', 'quote.validity_days');
delete from schema_migrations where version = '20261017020000_enquiry_to_quote.sql';
commit;
