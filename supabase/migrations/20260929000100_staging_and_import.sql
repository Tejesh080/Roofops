-- =============================================================================
-- Staging layer + import batch ledger
--
-- staging.* holds the normalised bundle verbatim (every column as text), so
-- nothing in the source is lost even where the core model derives a value
-- instead of storing it (e.g. materials_status, schedule_risk, edge_case_tags).
-- The transform (src/import/transform.sql) moves staging -> core in one
-- transaction; import_batches makes the whole load idempotent.
-- =============================================================================

create schema if not exists staging;

create table import_batches (
  id              uuid primary key default gen_random_uuid(),
  dataset_sha256  text not null unique,             -- same dataset can only be imported once
  demo_date       date not null,
  source          text not null,
  row_counts      jsonb not null,
  status          text not null check (status in ('COMPLETED')),
  imported_at     timestamptz not null default now()
);
alter table import_batches enable row level security;

create table staging.customers (customer_id text primary key, customer_name text, email text, phone text, customer_type text, created_date text, preferred_contact text, duplicate_candidate_of text);
create table staging.properties (property_id text primary key, customer_id text, street_address text, suburb text, state text, postcode text, property_type text, storeys text, access_notes text);
create table staging.quotes (quote_id text primary key, quote_version text, customer_id text, property_id text, estimator text, lead_source text, job_type text, roof_type text, roof_area_sqm text, inspection_date text, quote_created_date text, quote_sent_date text, quote_status text, quote_accepted_date text, quote_amount_aud text, lost_reason text, edge_case_tags text);
create table staging.projects (project_id text primary key, quote_id text, customer_id text, property_id text, project_status text, project_manager text, planned_start_date text, actual_start_date text, planned_completion_date text, actual_completion_date text, schedule_risk text, delay_reason text, materials_status text, compliance_photos_status text, drive_folder_status text, edge_case_tags text);
create table staging.suppliers (supplier_id text primary key, supplier_name text, email text, phone text, default_lead_time_days text, active text);
create table staging.products (product_id text primary key, supplier_id text, supplier_sku text, product_name text, unit text, unit_price_aud text, active text);
create table staging.purchase_orders (po_id text primary key, project_id text, supplier_id text, po_status text, po_date text, po_value_aud text, expected_delivery_date text, supplier_acknowledged text, external_reference text, edge_case_tags text);
create table staging.invoices (invoice_id text primary key, project_id text, invoice_status text, invoice_date text, due_date text, paid_date text, invoice_amount_aud text, xero_invoice_id text, edge_case_tags text);
create table staging.project_events (event_id text primary key, correlation_id text, event_type text, entity_type text, entity_id text, actor_type text, actor_id text, source text, workflow_version text, occurred_at text, status text, external_reference text, error_class text, metadata_json text);
create table staging.site_notes (site_note_id text primary key, project_id text, created_at text, author text, note_text text, ai_structured_status text);
create table staging.documents (document_id text primary key, project_id text, document_type text, file_name text, storage_provider text, storage_path text, uploaded_at text, review_status text);
create table staging.workflow_exceptions (exception_id text primary key, workflow_name text, project_id text, event_id text, error_class text, error_message text, attempt_count text, created_at text, last_attempt_at text, resolution_status text, resolution_note text);
create table staging.processed_events (event_key text primary key, event_type text, processed_at text, status text, result_reference text);
create table staging.date_changes ("table" text, record_id text, field text, "from" text, "to" text, rule text, reason text);
