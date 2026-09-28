-- =============================================================================
-- staging.* (normalised bundle, all text) -> core tables.
-- Runs inside the importer's transaction. Source IDs are preserved verbatim as
-- business IDs; UUIDs come from stable_uuid(kind, source_id).
-- Value mappings are 1:1 vocabulary translations (e.g. 'Materials Pending' ->
-- 'MATERIALS_PENDING'); an unmapped value raises (via CHECK / NOT NULL) and
-- aborts the whole import.
-- =============================================================================

-- ---- employees: every person named in the bundle (PMs, estimators) ----
insert into employees (id, employee_code, full_name, email, role)
select stable_uuid('employee', name),
       'EMP-' || lpad(row_number() over (order by name)::text, 3, '0'),
       name,
       lower(replace(name, ' ', '.')) || '@roofops.example.com',
       role
from (
  select project_manager as name, 'PROJECT_MANAGER' as role from staging.projects
  union
  select estimator, 'ESTIMATOR' from staging.quotes
) people;

-- ---- customers ----
insert into customers (id, customer_number, customer_type, display_name, email, phone, preferred_contact, customer_since)
select stable_uuid('customer', customer_id), customer_id, upper(customer_type), customer_name, email, phone,
       upper(preferred_contact), created_date::date
from staging.customers;

-- Duplicate candidate: canonical uuid order; reasons/score computed from the facts.
-- Names are compared trimmed + case-folded (the source keeps "Chloe Bennett " with a
-- trailing space verbatim; matching must not depend on such noise).
insert into customer_match_candidates (customer_id, candidate_customer_id, match_score, match_reasons)
select least(a.id, b.id), greatest(a.id, b.id),
       case when lower(btrim(a.display_name)) = lower(btrim(b.display_name)) and a.phone_normalised = b.phone_normalised
            then 0.950 else 0.700 end,
       to_jsonb(array_remove(array[
         case when a.phone_normalised = b.phone_normalised then 'PHONE_EXACT' end,
         case when a.display_name = b.display_name then 'NAME_EXACT'
              when lower(btrim(a.display_name)) = lower(btrim(b.display_name)) then 'NAME_MATCH_AFTER_NORMALISATION' end,
         case when lower(a.email) <> lower(b.email) then 'EMAIL_DIFFERS' end,
         case when a.customer_type <> b.customer_type then 'CUSTOMER_TYPE_DIFFERS' end], null))
from staging.customers s
join customers a on a.customer_number = s.customer_id
join customers b on b.customer_number = s.duplicate_candidate_of
where s.duplicate_candidate_of <> '';

-- ---- properties + ownership ----
insert into properties (id, property_number, address_line1, suburb, state, postcode, property_type, storeys, access_notes)
select stable_uuid('property', property_id), property_id, street_address, suburb, state, postcode,
       upper(replace(property_type, ' ', '_')), storeys::smallint, nullif(access_notes, '')
from staging.properties;

insert into customer_properties (customer_id, property_id, relationship)
select stable_uuid('customer', customer_id), stable_uuid('property', property_id), 'OWNER'
from staging.properties;

-- ---- suppliers / products ----
insert into suppliers (id, supplier_code, name, orders_email, phone, default_lead_time_days, is_active)
select stable_uuid('supplier', supplier_id), supplier_id, supplier_name, email, phone,
       default_lead_time_days::int, active::boolean
from staging.suppliers;

insert into products (id, product_code, name, category, unit, is_active)
select stable_uuid('product', product_id), product_id, product_name,
       case
         when product_name like 'Roof Sheet%'                              then 'ROOF_SHEETING'
         when product_name like 'Tile Clip%' or product_name like 'Roof Screw%' then 'FASTENERS'
         when product_name like 'Tile%'                                    then 'TILES'
         when product_name ~ '^(Ridge Capping|Valley Tray|Barge Capping|Flashing)' then 'FLASHINGS'
         when product_name ~ '^(Gutter|Downpipe)'                          then 'GUTTERS_DOWNPIPES'
         when product_name ~ '^(Sarking|Insulation|Underlay)'              then 'SARKING_INSULATION'
         when product_name like 'Vent%'                                    then 'VENTILATION'
         when product_name like 'Sealant%'                                 then 'SEALANTS_COATINGS'
       end,
       unit, active::boolean
from staging.products;

insert into supplier_products (supplier_id, product_id, supplier_sku, list_price_ex_gst, is_active)
select stable_uuid('supplier', supplier_id), stable_uuid('product', product_id), supplier_sku,
       unit_price_aud::numeric, active::boolean
from staging.products;

-- ---- inspections (one per quote: the bundle records inspection facts on the quote) ----
insert into inspections (id, inspection_number, property_id, status, inspected_on, roof_type, roof_area_sqm)
select stable_uuid('inspection', quote_id),
       'INS-2026-' || lpad(row_number() over (order by quote_id)::text, 4, '0'),
       stable_uuid('property', property_id), 'COMPLETED', inspection_date::date,
       upper(replace(roof_type, ' ', '_')), nullif(roof_area_sqm, '')::numeric
from staging.quotes;

-- ---- quotes: inserted pre-acceptance, versions + lines added, then accepted ----
insert into quotes (id, quote_number, customer_id, property_id, inspection_id, lead_source, estimator_id, job_type,
                    status, created_on, sent_on, lost_reason)
select stable_uuid('quote', quote_id), quote_id, stable_uuid('customer', customer_id), stable_uuid('property', property_id),
       stable_uuid('inspection', quote_id), upper(replace(lead_source, ' ', '_')), stable_uuid('employee', estimator),
       upper(replace(replace(job_type, '-', ''), ' ', '_')),
       case quote_status when 'Accepted' then 'SENT' else upper(quote_status) end,
       quote_created_date::date, nullif(quote_sent_date, '')::date, nullif(lost_reason, '')
from staging.quotes;

-- Only the current version is in the source (earlier versions' contents are unknown,
-- so they are not invented). The quoted amount is carried as one SUMMARY line.
insert into quote_versions (id, quote_id, version_number, line_amount_type)
select stable_uuid('quote_version', quote_id), stable_uuid('quote', quote_id), quote_version::int, 'INCLUSIVE'
from staging.quotes;

insert into quote_version_lines (quote_version_id, line_no, line_kind, description, quantity, unit, unit_price)
select stable_uuid('quote_version', quote_id), 1, 'SUMMARY',
       job_type || ' - ' || roof_type || ' roof (quoted total; line detail not in source)', 1, 'LOT', quote_amount_aud::numeric
from staging.quotes;

update quotes q
   set status = 'ACCEPTED', accepted_version_id = stable_uuid('quote_version', s.quote_id), accepted_on = s.quote_accepted_date::date
  from staging.quotes s
 where q.quote_number = s.quote_id and s.quote_status = 'Accepted';

-- ---- projects ----
insert into projects (id, project_number, quote_id, accepted_quote_version_id, customer_id, property_id, project_manager_id,
                      status, planned_start_date, planned_completion_date, actual_start_date, actual_completion_date,
                      pm_risk_flag, delay_reason)
select stable_uuid('project', project_id), project_id, stable_uuid('quote', quote_id), stable_uuid('quote_version', quote_id),
       stable_uuid('customer', customer_id), stable_uuid('property', property_id), stable_uuid('employee', project_manager),
       upper(replace(project_status, ' ', '_')),
       planned_start_date::date, planned_completion_date::date,
       nullif(actual_start_date, '')::date, nullif(actual_completion_date, '')::date,
       upper(schedule_risk), nullif(delay_reason, '')
from staging.projects;

-- compliance_photos_status -> the COMPLETION_PHOTOS checklist item
insert into project_checklist_items (project_id, item_code, label, stage, status, completed_on, sort_order)
select stable_uuid('project', project_id), 'COMPLETION_PHOTOS', 'Completion / compliance photos uploaded', 'COMPLETION',
       case compliance_photos_status when 'Complete' then 'DONE' else 'OPEN' end,
       case compliance_photos_status when 'Complete' then actual_completion_date::date end, 10
from staging.projects;

-- drive_folder_status = Created -> a MOCK Google Drive folder link (the bundle's storage is "Mock Drive")
insert into external_links (provider, is_mock, entity_type, entity_id, external_type, external_id)
select 'GOOGLE_DRIVE', true, 'project', stable_uuid('project', project_id), 'Folder', 'mock-drive:/RoofOps Demo/' || project_id || '/'
from staging.projects where drive_folder_status = 'Created';

-- ---- purchase orders (value carried as one SUMMARY line, ex-GST) ----
insert into purchase_orders (id, po_number, supplier_id, project_id, record_origin, origin, status, line_amount_type,
                             po_date, expected_delivery_date, supplier_reference)
select stable_uuid('purchase_order', po_id), po_id, stable_uuid('supplier', supplier_id), stable_uuid('project', project_id),
       'IMPORT', 'LEGACY', upper(replace(po_status, ' ', '_')), 'EXCLUSIVE',
       po_date::date, nullif(expected_delivery_date, '')::date, nullif(external_reference, '')
from staging.purchase_orders;

insert into purchase_order_lines (purchase_order_id, line_no, line_kind, description, quantity, unit, unit_price)
select stable_uuid('purchase_order', po_id), 1, 'SUMMARY', 'Materials per ' || po_id || ' (PO value; line detail not in source)',
       1, 'LOT', po_value_aud::numeric
from staging.purchase_orders;

-- ---- invoices (amount carried as one SUMMARY line, GST-inclusive) ----
insert into invoices (id, invoice_number, project_id, customer_id, record_origin, status, sync_status, line_amount_type,
                      issue_date, due_date)
select stable_uuid('invoice', i.invoice_id), i.invoice_id, stable_uuid('project', i.project_id), stable_uuid('customer', p.customer_id),
       'IMPORT',
       case i.invoice_status when 'Draft' then 'DRAFT' when 'Sent' then 'ISSUED' when 'Paid' then 'PAID' end,
       case when i.xero_invoice_id <> '' then 'SYNCED' else 'NOT_SYNCED' end,
       'INCLUSIVE', i.invoice_date::date, i.due_date::date
from staging.invoices i join staging.projects p on p.project_id = i.project_id;

insert into invoice_lines (invoice_id, line_no, line_kind, description, quantity, unit_price)
select stable_uuid('invoice', invoice_id), 1, 'SUMMARY', 'Invoice ' || invoice_id || ' (amount; line detail not in source)',
       1, invoice_amount_aud::numeric
from staging.invoices;

-- Paid invoices: one payment for the full amount on the paid date (method not in source).
insert into payments (invoice_id, amount, received_on, method, source)
select i.id, i.total_inc_gst, s.paid_date::date, 'UNKNOWN', 'IMPORT'
from staging.invoices s join invoices i on i.invoice_number = s.invoice_id
where s.invoice_status = 'Paid';

-- Xero IDs in the bundle are demo placeholders (DEMO-XERO-nnnn), so the links are MOCK.
insert into external_links (provider, is_mock, entity_type, entity_id, external_type, external_id)
select 'XERO', true, 'invoice', stable_uuid('invoice', invoice_id), 'Invoice', xero_invoice_id
from staging.invoices where xero_invoice_id <> '';

-- ---- documents / site notes ----
insert into documents (id, document_number, document_type, title, file_name, mime_type, storage_provider, storage_ref,
                       review_status, uploaded_at, project_id)
select stable_uuid('document', document_id), document_id, upper(replace(document_type, ' ', '_')), document_type,
       file_name,
       case when file_name like '%.pdf' then 'application/pdf' end,   -- unknown extension -> NOT NULL violation -> import aborts
       case storage_provider when 'Mock Drive' then 'MOCK_DRIVE' end,
       storage_path || file_name,
       upper(replace(review_status, ' ', '_')), uploaded_at::timestamptz, stable_uuid('project', project_id)
from staging.documents;

insert into site_notes (id, note_number, project_id, author_id, body, noted_at, ai_extraction_status)
select stable_uuid('site_note', site_note_id), site_note_id, stable_uuid('project', project_id), stable_uuid('employee', author),
       note_text, created_at::timestamptz, upper(ai_structured_status)
from staging.site_notes;

-- ---- automation event log ----
insert into automation_events (event_id, event_key, correlation_id, correlation_key, event_type, entity_type, entity_id,
                               business_reference, actor_type, actor_id, source, workflow_version, occurred_at, status,
                               external_reference, error_class, metadata)
select stable_uuid('event', e.event_id), e.event_id, stable_uuid('correlation', e.correlation_id), e.correlation_id,
       e.event_type, e.entity_type, stable_uuid(e.entity_type, e.entity_id), e.entity_id,
       upper(e.actor_type), e.actor_id, e.source, e.workflow_version, e.occurred_at::timestamptz,
       case e.status when 'success' then 'SUCCEEDED' when 'failed' then 'FAILED' when 'duplicate_blocked' then 'DUPLICATE_IGNORED' end,
       nullif(e.external_reference, ''),
       -- unmapped classes pass through unchanged and fail the error_classes FK
       case e.error_class when '' then null when 'IdempotencyConflict' then 'DUPLICATE_EVENT'
                          when 'ExternalServiceTimeout' then 'TIMEOUT' else e.error_class end,
       e.metadata_json::jsonb || jsonb_build_object('source_error_class', nullif(e.error_class, ''))
from staging.project_events e;

-- Causation for the duplicate delivery: metadata.duplicate_of -> original event
update automation_events a set causation_id = o.event_id
  from automation_events o
 where a.metadata ? 'duplicate_of' and o.event_key = a.metadata ->> 'duplicate_of';

-- ---- idempotency ledger ----
insert into processed_events (consumer, idempotency_key, record_origin, first_event_id, status, result,
                              first_seen_at, last_seen_at, completed_at)
select 'legacy:' || p.event_type, p.event_key, 'IMPORT', ev.event_id, 'COMPLETED',
       jsonb_build_object('result_reference', p.result_reference),
       p.processed_at::timestamptz, p.processed_at::timestamptz, p.processed_at::timestamptz
from staging.processed_events p
left join automation_events ev on ev.event_key = p.event_key
where p.status = 'processed';

-- ---- workflow exceptions ----
insert into workflow_exceptions (id, exception_number, record_origin, event_id, workflow_key, entity_type, entity_id,
                                 business_reference, error_class, error_message, retryable, attempt_count,
                                 first_failed_at, last_attempt_at, resolution_status, resolution_note)
select stable_uuid('exception', x.exception_id), x.exception_id, 'IMPORT', stable_uuid('event', x.event_id), x.workflow_name,
       'project', stable_uuid('project', x.project_id), x.project_id, c.code, x.error_message, ec.retryable,
       x.attempt_count::int, x.created_at::timestamptz, x.last_attempt_at::timestamptz,
       upper(x.resolution_status), nullif(x.resolution_note, '')
from staging.workflow_exceptions x
join (values ('DuplicateEvent','DUPLICATE_EVENT'), ('RateLimit','RATE_LIMITED'), ('ExternalServiceTimeout','TIMEOUT'),
             ('ValidationError','VALIDATION_ERROR'), ('AuthFailure','AUTH_FAILURE'), ('SchemaMismatch','SCHEMA_MISMATCH'),
             ('AmbiguousWrite','AMBIGUOUS_WRITE'), ('InvalidStateTransition','INVALID_STATE'),
             ('PermissionDenied','PERMISSION_DENIED'), ('ArithmeticMismatch','ARITHMETIC_MISMATCH'),
             ('MissingDocument','MISSING_DOCUMENT'), ('ReconciliationMismatch','RECONCILIATION_MISMATCH')) c(src, code)
  on c.src = x.error_class
join error_classes ec on ec.code = c.code;

-- ---- friendly-ID counters continue after the imported IDs ----
insert into id_counters (counter_key, year, last_value)
select prefix, yr, max(n) from (
  select 'Q' prefix, 2026 yr, split_part(quote_number, '-', 3)::int n from quotes
  union all select 'PRJ', 2026, split_part(project_number, '-', 3)::int from projects
  union all select 'PO', 2026, split_part(po_number, '-', 3)::int from purchase_orders
  union all select 'INV', 2026, split_part(invoice_number, '-', 3)::int from invoices
  union all select 'INS', 2026, split_part(inspection_number, '-', 3)::int from inspections
  union all select 'CUST', 0, split_part(customer_number, '-', 2)::int from customers
  union all select 'PROP', 0, split_part(property_number, '-', 2)::int from properties
  union all select 'SUP', 0, split_part(supplier_code, '-', 2)::int from suppliers
  union all select 'PROD', 0, split_part(product_code, '-', 2)::int from products
  union all select 'DOC', 0, split_part(document_number, '-', 2)::int from documents
  union all select 'NOTE', 0, split_part(note_number, '-', 2)::int from site_notes
  union all select 'EXC', 0, split_part(exception_number, '-', 2)::int from workflow_exceptions
  union all select 'EMP', 0, split_part(employee_code, '-', 2)::int from employees
) ids group by prefix, yr
on conflict (counter_key, year) do update set last_value = greatest(id_counters.last_value, excluded.last_value);
