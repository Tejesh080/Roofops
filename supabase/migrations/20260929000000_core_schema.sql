-- =============================================================================
-- RoofOps core schema
-- Phase 0 design, amended in Phase 1 (before first apply) to load the canonical
-- synthetic data bundle losslessly. Target: Postgres 17 (Supabase) and PGlite.
--
-- Conventions
--   * UUID primary keys internally. Business IDs (Q-2026-0042) are separate UNIQUE
--     columns. Imported records keep their source IDs verbatim; their UUIDs are
--     deterministic (stable_uuid) so a re-import reproduces identical keys.
--   * Business dates (quote accepted, PO date, due date) are `date` columns.
--     `created_at` / `recorded_at` always mean "row inserted in this database".
--   * Status columns are text + CHECK (easier to evolve than Postgres enums).
--   * Money is numeric(12,2) AUD. Each document records its line_amount_type
--     (EXCLUSIVE | INCLUSIVE | NO_TAX, as Xero does) and the database derives
--     subtotal/GST/total from GENERATED line amounts. Callers cannot set totals.
--   * record_origin = 'IMPORT' marks legacy records loaded from the bundle. They
--     are exempt from approval-metadata checks they could never satisfy (who
--     approved a PO before RoofOps existed is unknown); every record created by
--     RoofOps itself ('ROOFOPS') is held to the full rule.
--   * record_version supports optimistic concurrency.
--   * Derived facts (risk, overdue, outstanding, conversion) live in views.
--   * RLS enabled on every table with no policies: all access is server-side.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------

-- Deterministic UUID (RFC 9562 version 8, "custom") from an entity kind + business key.
create or replace function stable_uuid(p_kind text, p_key text) returns uuid
language sql immutable strict as $$
  select (substr(h, 1, 12) || '8' || substr(h, 14, 3) ||
          substr('89ab', (get_byte(decode(substr(h, 17, 2), 'hex'), 0) % 4) + 1, 1) ||
          substr(h, 18, 15))::uuid
    from (select md5('roofops:' || p_kind || ':' || p_key) as h) s
$$;

create table app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- The business "today". Pinned to the demo date for the synthetic dataset so every
-- "overdue"/"next week" statement stays true whenever the demo is presented;
-- falls back to the real date in Brisbane when no override is set.
create or replace function app_today() returns date language sql stable as $$
  select coalesce(
    (select value::date from app_settings where key = 'business_date_override'),
    (now() at time zone 'Australia/Brisbane')::date)
$$;

create table id_counters (
  counter_key text    not null,
  year        integer not null default 0,          -- 0 = not year-scoped (CUST-0001)
  last_value  integer not null default 0 check (last_value >= 0),
  primary key (counter_key, year)
);

-- Concurrency-safe friendly ID issue (row-locked upsert). Gaps possible on rollback.
create or replace function next_friendly_id(p_prefix text, p_year integer default null, p_width integer default 4)
returns text language plpgsql as $$
declare v integer;
begin
  insert into id_counters (counter_key, year, last_value)
  values (p_prefix, coalesce(p_year, 0), 1)
  on conflict (counter_key, year) do update set last_value = id_counters.last_value + 1
  returning last_value into v;
  if p_year is null then
    return p_prefix || '-' || lpad(v::text, p_width, '0');
  end if;
  return p_prefix || '-' || p_year || '-' || lpad(v::text, p_width, '0');
end $$;

create or replace function touch_row() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.record_version := old.record_version + 1;
  end if;
  return new;
end $$;

-- GST split for a document whose lines sum to p_lines under p_type.
create or replace function gst_split(p_lines numeric, p_type text, p_rate numeric,
  out subtotal_ex_gst numeric, out gst_amount numeric, out total_inc_gst numeric)
language sql immutable as $$
  select case p_type when 'INCLUSIVE' then p_lines - round(p_lines * p_rate / (1 + p_rate), 2) else p_lines end,
         case p_type when 'EXCLUSIVE' then round(p_lines * p_rate, 2)
                     when 'INCLUSIVE' then round(p_lines * p_rate / (1 + p_rate), 2) else 0 end,
         case p_type when 'EXCLUSIVE' then p_lines + round(p_lines * p_rate, 2) else p_lines end
$$;

-- Reference: error classes and whether the platform may retry them automatically.
create table error_classes (
  code        text primary key,
  retryable   boolean not null,
  description text not null
);
insert into error_classes (code, retryable, description) values
  ('VALIDATION_ERROR',        false, 'Input failed schema or business validation'),
  ('SCHEMA_MISMATCH',         false, 'Payload shape differs from the expected contract'),
  ('NOT_FOUND',               false, 'Referenced record does not exist'),
  ('INVALID_STATE',           false, 'Action not allowed in the record''s current state'),
  ('PERMISSION_DENIED',       false, 'Actor lacks the permission, or approval is missing'),
  ('AUTH_FAILURE',            false, 'Integration credentials invalid or expired; needs a human to reconnect'),
  ('DUPLICATE_EVENT',         false, 'Event already processed (idempotency)'),
  ('CONFLICT',                true,  'Optimistic-lock conflict; re-read then retry once'),
  ('RATE_LIMITED',            true,  'HTTP 429; retry after Retry-After or backoff'),
  ('UPSTREAM_5XX',            true,  'Transient upstream server error'),
  ('TIMEOUT',                 true,  'Call timed out (idempotent operation)'),
  ('NETWORK',                 true,  'Connection failure'),
  ('SERVICE_UNAVAILABLE',     true,  'Provider down or circuit open'),
  ('AMBIGUOUS_WRITE',         false, 'Write may or may not have committed; reconcile before any retry'),
  ('ARITHMETIC_MISMATCH',     false, 'Stated totals disagree with recalculation'),
  ('MISSING_DOCUMENT',        false, 'Required document not present'),
  ('RECONCILIATION_MISMATCH', false, 'External state differs from internal state'),
  ('UNKNOWN',                 false, 'Unclassified; requires investigation');

-- -----------------------------------------------------------------------------
-- People
-- -----------------------------------------------------------------------------

create table employees (
  id             uuid primary key default gen_random_uuid(),
  employee_code  text not null unique,                       -- EMP-001
  full_name      text not null unique,
  email          text not null unique check (email ~* '^[^@]+@[^@]+\.[^@]+$'),
  role           text not null check (role in (
                   'ADMIN','OPERATIONS_MANAGER','PROJECT_MANAGER','ESTIMATOR',
                   'PURCHASING','FINANCE','FIELD_CREW','VIEWER')),
  auth_user_id   uuid unique,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  record_version integer not null default 1
);

create table customers (
  id                      uuid primary key default gen_random_uuid(),
  customer_number         text not null unique,              -- CUST-0001
  customer_type           text not null check (customer_type in ('RESIDENTIAL','COMMERCIAL','BUILDER','STRATA')),
  display_name            text not null,
  legal_name              text,
  abn                     text check (abn ~ '^[0-9]{11}$'),
  email                   text check (email ~* '^[^@]+@[^@]+\.[^@]+$'),
  phone                   text,
  phone_normalised        text generated always as (nullif(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), '')) stored,
  preferred_contact       text check (preferred_contact in ('PHONE','EMAIL','SMS')),
  customer_since          date,
  status                  text not null default 'ACTIVE' check (status in ('ACTIVE','MERGED','ARCHIVED')),
  merged_into_customer_id uuid references customers(id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  record_version          integer not null default 1,
  check ((status = 'MERGED') = (merged_into_customer_id is not null)),
  check (merged_into_customer_id is distinct from id)
);
create index customers_phone_idx on customers (phone_normalised);
create index customers_email_idx on customers (lower(email));

create table contacts (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  first_name  text not null,
  last_name   text not null,
  role_title  text,
  email       text check (email ~* '^[^@]+@[^@]+\.[^@]+$'),
  phone       text,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  record_version integer not null default 1
);
create unique index contacts_one_primary_per_customer on contacts (customer_id) where is_primary;

-- Duplicate-customer review queue; pair stored in canonical (uuid) order.
create table customer_match_candidates (
  id                    uuid primary key default gen_random_uuid(),
  customer_id           uuid not null references customers(id),
  candidate_customer_id uuid not null references customers(id),
  match_score           numeric(4,3) not null check (match_score between 0 and 1),
  match_reasons         jsonb not null default '[]'::jsonb,
  status                text not null default 'OPEN' check (status in ('OPEN','CONFIRMED_DUPLICATE','NOT_DUPLICATE')),
  reviewed_by           uuid references employees(id),
  reviewed_at           timestamptz,
  created_at            timestamptz not null default now(),
  check (customer_id < candidate_customer_id),
  check ((status = 'OPEN') = (reviewed_at is null)),
  unique (customer_id, candidate_customer_id)
);

-- -----------------------------------------------------------------------------
-- Lead -> Property -> Inspection
-- -----------------------------------------------------------------------------

create table leads (
  id                    uuid primary key default gen_random_uuid(),
  lead_number           text not null unique,
  source                text not null check (source in (
                          'GOOGLE_ADS','ORGANIC_SEARCH','REFERRAL','FACEBOOK','REPEAT_CUSTOMER',
                          'BUILDER_REFERRAL','LOCAL_SIGNAGE','WEBSITE_FORM','PHONE','OTHER')),
  status                text not null default 'NEW' check (status in (
                          'NEW','CONTACTED','INSPECTION_BOOKED','QUOTED','WON','LOST','DISQUALIFIED')),
  contact_name          text not null,
  email                 text,
  phone                 text,
  property_address_text text,
  customer_id           uuid references customers(id),
  received_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  record_version        integer not null default 1,
  check (status not in ('QUOTED','WON') or customer_id is not null)
);

create table properties (
  id              uuid primary key default gen_random_uuid(),
  property_number text not null unique,                      -- PROP-0001
  address_line1   text not null,
  address_line2   text,
  suburb          text not null,
  state           text not null check (state in ('QLD','NSW','VIC','TAS','SA','WA','NT','ACT')),
  postcode        text not null check (postcode ~ '^[0-9]{4}$'),
  property_type   text not null check (property_type in ('DETACHED_HOUSE','TOWNHOUSE','SMALL_COMMERCIAL','INDUSTRIAL','STRATA_COMPLEX')),
  storeys         smallint not null default 1 check (storeys between 1 and 6),
  roof_type       text check (roof_type in ('TILE','TERRACOTTA_TILE','METAL','COLORBOND','ZINCALUME','OTHER')),
  access_notes    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  record_version  integer not null default 1,
  unique (address_line1, suburb, state, postcode)
);

-- Many-to-many: owner, tenant, property manager, builder...
create table customer_properties (
  customer_id  uuid not null references customers(id),
  property_id  uuid not null references properties(id),
  relationship text not null check (relationship in ('OWNER','TENANT','PROPERTY_MANAGER','BUILDER','STRATA_MANAGER')),
  valid_from   date,
  valid_to     date,
  primary key (customer_id, property_id, relationship),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create table inspections (
  id                 uuid primary key default gen_random_uuid(),
  inspection_number  text not null unique,                   -- INS-2026-0001
  property_id        uuid not null references properties(id),
  lead_id            uuid references leads(id),
  inspector_id       uuid references employees(id),
  status             text not null default 'SCHEDULED' check (status in ('SCHEDULED','COMPLETED','CANCELLED')),
  scheduled_for      timestamptz,
  inspected_on       date,
  roof_type          text check (roof_type in ('TILE','TERRACOTTA_TILE','METAL','COLORBOND','ZINCALUME','OTHER')),
  roof_area_sqm      numeric(8,1) check (roof_area_sqm > 0),   -- nullable: "missing measurement" is a real state
  pitch_degrees      numeric(4,1) check (pitch_degrees between 0 and 75),
  measurement_method text check (measurement_method in ('TAPE','DRONE','AERIAL_IMAGERY','PLAN_TAKEOFF')),
  findings           text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  record_version     integer not null default 1,
  check ((status = 'COMPLETED') = (inspected_on is not null))
);

-- -----------------------------------------------------------------------------
-- Estimate -> Quote -> Quote version
-- -----------------------------------------------------------------------------

create table products (
  id             uuid primary key default gen_random_uuid(),
  product_code   text not null unique,                       -- PROD-0001
  name           text not null,
  category       text check (category in (
                   'ROOF_SHEETING','TILES','FLASHINGS','GUTTERS_DOWNPIPES','FASTENERS',
                   'SARKING_INSULATION','VENTILATION','SEALANTS_COATINGS','SAFETY','ACCESSORIES')),
  unit           text not null check (unit in ('EA','LM','SQM','SHEET','BOX','ROLL','PACK','L','KG','LOT')),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  record_version integer not null default 1
);

create table product_aliases (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  alias       text not null,
  supplier_id uuid,                                          -- FK added after suppliers
  unique (product_id, alias)
);

create table quotes (
  id                  uuid primary key default gen_random_uuid(),
  quote_number        text not null unique,                  -- Q-2026-0042
  customer_id         uuid not null references customers(id),
  property_id         uuid not null references properties(id),
  inspection_id       uuid references inspections(id),
  lead_id             uuid references leads(id),
  lead_source         text check (lead_source in (
                        'GOOGLE_ADS','ORGANIC_SEARCH','REFERRAL','FACEBOOK','REPEAT_CUSTOMER',
                        'BUILDER_REFERRAL','LOCAL_SIGNAGE','WEBSITE_FORM','PHONE','OTHER')),
  estimator_id        uuid references employees(id),
  job_type            text not null check (job_type in (
                        'LEAK_REPAIR','ROOF_RESTORATION','ROOF_REPLACEMENT','FULL_REROOF',
                        'EXTENSION_ROOF','STORM_DAMAGE_REPAIR')),
  status              text not null default 'DRAFT' check (status in ('DRAFT','SENT','ACCEPTED','LOST','EXPIRED')),
  accepted_version_id uuid,                                  -- composite FK added below
  created_on          date not null default current_date,
  sent_on             date,
  accepted_on         date,
  valid_until         date,
  lost_reason         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  record_version      integer not null default 1,
  unique (id, customer_id, property_id),
  check ((status = 'ACCEPTED') = (accepted_version_id is not null and accepted_on is not null)),
  check (status <> 'LOST' or lost_reason is not null),
  check (status = 'DRAFT' or sent_on is not null),
  check (sent_on is null or sent_on >= created_on),
  check (accepted_on is null or (sent_on is not null and accepted_on >= sent_on))
);
create index quotes_status_idx on quotes (status);

create table quote_versions (
  id                  uuid primary key default gen_random_uuid(),
  quote_id            uuid not null references quotes(id) on delete cascade,
  version_number      integer not null check (version_number >= 1),
  line_amount_type    text not null default 'INCLUSIVE' check (line_amount_type in ('EXCLUSIVE','INCLUSIVE','NO_TAX')),
  gst_rate            numeric(5,4) not null default 0.1000 check (gst_rate between 0 and 1),
  subtotal_ex_gst     numeric(12,2) not null default 0,       -- derived from lines
  gst_amount          numeric(12,2) not null default 0,       -- derived
  total_inc_gst       numeric(12,2) not null default 0,       -- derived
  scope_summary       text,
  created_by          uuid references employees(id),
  created_at          timestamptz not null default now(),
  unique (quote_id, version_number),
  unique (id, quote_id),
  check (case line_amount_type
    when 'EXCLUSIVE' then gst_amount = round(subtotal_ex_gst * gst_rate, 2) and total_inc_gst = subtotal_ex_gst + gst_amount
    when 'INCLUSIVE' then gst_amount = round(total_inc_gst * gst_rate / (1 + gst_rate), 2) and subtotal_ex_gst = total_inc_gst - gst_amount
    else gst_amount = 0 and total_inc_gst = subtotal_ex_gst end)
);

alter table quotes
  add constraint quotes_accepted_version_belongs_to_quote
  foreign key (accepted_version_id, id) references quote_versions (id, quote_id);

create table quote_version_lines (
  id                uuid primary key default gen_random_uuid(),
  quote_version_id  uuid not null references quote_versions(id) on delete cascade,
  line_no           integer not null check (line_no >= 1),
  line_kind         text not null check (line_kind in ('MATERIAL','LABOUR','EQUIPMENT','OTHER','SUMMARY')),
  product_id        uuid references products(id),
  description       text not null,
  quantity          numeric(12,3) not null check (quantity > 0),
  unit              text not null,
  unit_price        numeric(12,2) not null check (unit_price >= 0),   -- per the version's line_amount_type
  line_amount       numeric(12,2) generated always as (round(quantity * unit_price, 2)) stored,
  unique (quote_version_id, line_no),
  check (line_kind <> 'MATERIAL' or product_id is not null)
);

create or replace function derive_quote_version_totals() returns trigger language plpgsql as $$
declare v numeric; s record;
begin
  select coalesce(sum(line_amount), 0) into v from quote_version_lines where quote_version_id = new.id;
  s := gst_split(v, new.line_amount_type, new.gst_rate);
  new.subtotal_ex_gst := s.subtotal_ex_gst; new.gst_amount := s.gst_amount; new.total_inc_gst := s.total_inc_gst;
  return new;
end $$;
create trigger quote_versions_derive_totals before insert or update on quote_versions
  for each row execute function derive_quote_version_totals();

-- An accepted quote version is a contract: its lines are frozen. Changes become variations.
create or replace function quote_version_lines_guard() returns trigger language plpgsql as $$
declare v_version uuid := coalesce(new.quote_version_id, old.quote_version_id);
begin
  if exists (select 1 from quotes where accepted_version_id = v_version) then
    raise exception 'quote version % is accepted and immutable; record a variation instead', v_version
      using errcode = 'check_violation';
  end if;
  update quote_versions set gst_rate = gst_rate where id = v_version;   -- re-derive header
  return null;
end $$;
create trigger quote_version_lines_guard after insert or update or delete on quote_version_lines
  for each row execute function quote_version_lines_guard();

-- -----------------------------------------------------------------------------
-- Project -> Checklist / Tasks / Variations / Jobs
-- -----------------------------------------------------------------------------

create table projects (
  id                        uuid primary key default gen_random_uuid(),
  project_number            text not null unique,            -- PRJ-2026-0018
  quote_id                  uuid not null unique,            -- ONE project per quote
  accepted_quote_version_id uuid not null,
  customer_id               uuid not null,
  property_id               uuid not null,
  project_manager_id        uuid references employees(id),
  status                    text not null default 'PLANNING' check (status in (
                              'PLANNING','MATERIALS_PENDING','SCHEDULED','IN_PROGRESS','ON_HOLD',
                              'COMPLETED','CLOSED','CANCELLED')),
  planned_start_date        date,
  planned_completion_date   date,
  actual_start_date         date,
  actual_completion_date    date,
  pm_risk_flag              text not null default 'LOW' check (pm_risk_flag in ('LOW','HIGH')),  -- PM's own assessment
  delay_reason              text,
  on_hold_reason            text,
  cancellation_reason       text,
  created_by_event_id       uuid,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  record_version            integer not null default 1,
  foreign key (quote_id, customer_id, property_id) references quotes (id, customer_id, property_id),
  foreign key (accepted_quote_version_id, quote_id) references quote_versions (id, quote_id),
  foreign key (customer_id) references customers(id),
  foreign key (property_id) references properties(id),
  check (planned_completion_date is null or planned_start_date is null or planned_completion_date >= planned_start_date),
  check (actual_completion_date is null or actual_start_date is null or actual_completion_date >= actual_start_date),
  check (status not in ('COMPLETED','CLOSED') or actual_completion_date is not null),
  check (status not in ('IN_PROGRESS','COMPLETED','CLOSED') or actual_start_date is not null),
  check (pm_risk_flag = 'LOW' or delay_reason is not null),
  check (status <> 'ON_HOLD' or on_hold_reason is not null),
  check (status <> 'CANCELLED' or cancellation_reason is not null)
);
create index projects_status_idx on projects (status);

create table project_checklist_items (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references projects(id) on delete cascade,
  item_code            text not null,
  label                text not null,
  stage                text not null check (stage in ('PRE_START','COMPLETION','INVOICING')),
  is_required          boolean not null default true,
  status               text not null default 'OPEN' check (status in ('OPEN','DONE','WAIVED','NOT_APPLICABLE')),
  completed_by         uuid references employees(id),
  completed_on         date,
  evidence_document_id uuid,                                   -- FK added after documents
  waived_reason        text,
  sort_order           integer not null default 0,
  unique (project_id, item_code),
  check ((status = 'DONE') = (completed_on is not null)),
  check (status <> 'WAIVED' or waived_reason is not null)
);

create table tasks (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid references projects(id) on delete cascade,
  task_type              text not null check (task_type in (
                           'MATERIAL_REVIEW','SCHEDULE_JOB','SUPPLIER_FOLLOW_UP','COMPLIANCE_DOCS',
                           'CUSTOMER_FOLLOW_UP','INVOICE_REVIEW','EXCEPTION_REVIEW','GENERAL')),
  title                  text not null,
  description            text,
  assignee_id            uuid references employees(id),
  status                 text not null default 'OPEN' check (status in ('OPEN','IN_PROGRESS','DONE','CANCELLED')),
  due_on                 date,
  dedupe_key             text unique,
  created_by_workflow_run_id uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  record_version         integer not null default 1
);

create table variations (
  id                   uuid primary key default gen_random_uuid(),
  variation_number     text not null unique,
  project_id           uuid not null references projects(id),
  description          text not null,
  amount_inc_gst       numeric(12,2) not null,
  status               text not null default 'PROPOSED' check (status in ('PROPOSED','APPROVED','REJECTED','INVOICED')),
  customer_approved_at timestamptz,
  approved_by          uuid references employees(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  record_version       integer not null default 1,
  check (status not in ('APPROVED','INVOICED') or (customer_approved_at is not null and approved_by is not null))
);

create table jobs (
  id              uuid primary key default gen_random_uuid(),
  job_number      text not null unique,
  project_id      uuid not null references projects(id),
  job_type        text not null check (job_type in ('INSTALL','STRIP_AND_REPLACE','RESTORATION','REPAIR','MAKE_SAFE','RETURN_VISIT')),
  status          text not null default 'SCHEDULED' check (status in ('SCHEDULED','IN_PROGRESS','COMPLETED','WEATHER_DELAYED','CANCELLED')),
  scheduled_start timestamptz not null,
  scheduled_end   timestamptz not null,
  actual_start    timestamptz,
  actual_end      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  record_version  integer not null default 1,
  unique (id, project_id),
  check (scheduled_end > scheduled_start),
  check (actual_end is null or (actual_start is not null and actual_end >= actual_start)),
  check (status <> 'COMPLETED' or actual_end is not null)
);

create table job_assignments (
  job_id      uuid not null references jobs(id) on delete cascade,
  employee_id uuid not null references employees(id),
  crew_role   text not null default 'CREW' check (crew_role in ('LEADING_HAND','CREW','APPRENTICE','SUBCONTRACTOR')),
  primary key (job_id, employee_id)
);

-- -----------------------------------------------------------------------------
-- Suppliers, catalogue, material requirements, supplier quotes, purchase orders
-- -----------------------------------------------------------------------------

create table suppliers (
  id                     uuid primary key default gen_random_uuid(),
  supplier_code          text not null unique,               -- SUP-001
  name                   text not null unique,
  abn                    text check (abn ~ '^[0-9]{11}$'),
  orders_email           text check (orders_email ~* '^[^@]+@[^@]+\.[^@]+$'),
  phone                  text,
  payment_terms_days     integer check (payment_terms_days between 0 and 120),
  default_lead_time_days integer check (default_lead_time_days >= 0),
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  record_version         integer not null default 1
);

alter table product_aliases add foreign key (supplier_id) references suppliers(id);

create table supplier_products (
  id                   uuid primary key default gen_random_uuid(),
  supplier_id          uuid not null references suppliers(id),
  product_id           uuid not null references products(id),
  supplier_sku         text not null,
  supplier_description text,
  pack_size            numeric(12,3) not null default 1 check (pack_size > 0),
  list_price_ex_gst    numeric(12,2) not null check (list_price_ex_gst >= 0),
  lead_time_days       integer check (lead_time_days >= 0),
  price_valid_until    date,
  is_active            boolean not null default true,
  unique (supplier_id, supplier_sku),
  unique (supplier_id, product_id)
);

create table material_requirements (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references projects(id),
  product_id           uuid not null references products(id),
  quantity             numeric(12,3) not null check (quantity > 0),
  unit                 text not null,
  required_by          date,
  source               text not null check (source in ('QUOTE','TAKEOFF','MANUAL')),
  source_quote_line_id uuid references quote_version_lines(id),
  takeoff_reference    text,
  status               text not null default 'DRAFT' check (status in ('DRAFT','APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  approved_by          uuid references employees(id),
  approved_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  record_version       integer not null default 1,
  check ((status in ('DRAFT','CANCELLED')) or (approved_by is not null and approved_at is not null))
);
create unique index material_requirements_one_active_per_product
  on material_requirements (project_id, product_id) where status <> 'CANCELLED';

create table supplier_quotes (
  id                        uuid primary key default gen_random_uuid(),
  supplier_id               uuid references suppliers(id),
  project_id                uuid references projects(id),
  supplier_reference        text,
  received_at               timestamptz not null default now(),
  source_document_id        uuid,                            -- FK added after documents
  raw_text                  text,
  status                    text not null default 'RECEIVED' check (status in (
                              'RECEIVED','EXTRACTED','EXTRACTION_FAILED','NEEDS_REVIEW','REVIEWED','REJECTED','CONVERTED')),
  extraction                jsonb,
  extraction_model          text,
  extraction_prompt_version text,
  prices_include_gst        boolean,
  stated_total              numeric(12,2),
  lead_time_days            integer check (lead_time_days >= 0),
  delivery_date             date,
  valid_until               date,
  validation_issues         jsonb not null default '[]'::jsonb,
  reviewed_by               uuid references employees(id),
  reviewed_at               timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  record_version            integer not null default 1,
  check (status not in ('REVIEWED','CONVERTED') or (reviewed_by is not null and supplier_id is not null))
);

create table supplier_quote_lines (
  id                   uuid primary key default gen_random_uuid(),
  supplier_quote_id    uuid not null references supplier_quotes(id) on delete cascade,
  line_no              integer not null check (line_no >= 1),
  line_kind            text not null default 'ITEM' check (line_kind in ('ITEM','FREIGHT')),
  raw_description      text not null,
  supplier_sku         text,
  quantity             numeric(12,3),
  unit                 text,
  unit_price_as_stated numeric(12,2),
  unit_price_ex_gst    numeric(12,2),
  stated_line_total    numeric(12,2),
  computed_line_total_ex_gst numeric(12,2) generated always as (round(quantity * unit_price_ex_gst, 2)) stored,
  matched_product_id   uuid references products(id),
  match_method         text check (match_method in ('SUPPLIER_SKU','ALIAS_EXACT','FUZZY_SUGGESTED','MANUAL')),
  match_confidence     numeric(4,3) check (match_confidence between 0 and 1),
  unique (supplier_quote_id, line_no)
);

create table purchase_orders (
  id                       uuid primary key default gen_random_uuid(),
  po_number                text not null unique,             -- PO-2026-0031
  supplier_id              uuid not null references suppliers(id),
  project_id               uuid references projects(id),     -- null = stock order
  record_origin            text not null default 'ROOFOPS' check (record_origin in ('ROOFOPS','IMPORT')),
  origin                   text not null default 'MANUAL' check (origin in ('MANUAL','AI_DRAFT','SUPPLIER_QUOTE','LEGACY')),
  source_supplier_quote_id uuid references supplier_quotes(id),
  status                   text not null default 'DRAFT' check (status in (
                             'DRAFT','PENDING_APPROVAL','APPROVED','SENT','ACKNOWLEDGED',
                             'PARTIALLY_DELIVERED','DELIVERED','CANCELLED')),
  line_amount_type         text not null default 'EXCLUSIVE' check (line_amount_type in ('EXCLUSIVE','INCLUSIVE','NO_TAX')),
  gst_rate                 numeric(5,4) not null default 0.1000,
  subtotal_ex_gst          numeric(12,2) not null default 0,  -- derived
  gst_amount               numeric(12,2) not null default 0,  -- derived
  total_inc_gst            numeric(12,2) not null default 0,  -- derived
  po_date                  date not null default current_date,
  required_by              date,
  expected_delivery_date   date,
  supplier_reference       text,
  approval_id              uuid,                              -- FK added after approvals
  approved_by              uuid references employees(id),
  approved_at              timestamptz,
  sent_at                  timestamptz,
  acknowledged_at          timestamptz,
  cancelled_reason         text,
  idempotency_key          text unique,
  created_by               uuid references employees(id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  record_version           integer not null default 1,
  check (case line_amount_type
    when 'EXCLUSIVE' then gst_amount = round(subtotal_ex_gst * gst_rate, 2) and total_inc_gst = subtotal_ex_gst + gst_amount
    when 'INCLUSIVE' then gst_amount = round(total_inc_gst * gst_rate / (1 + gst_rate), 2) and subtotal_ex_gst = total_inc_gst - gst_amount
    else gst_amount = 0 and total_inc_gst = subtotal_ex_gst end),
  check (expected_delivery_date is null or expected_delivery_date >= po_date),
  check (record_origin = 'IMPORT' or status in ('DRAFT','PENDING_APPROVAL','CANCELLED') or (approved_by is not null and approved_at is not null)),
  check (record_origin = 'IMPORT' or status not in ('SENT','ACKNOWLEDGED','PARTIALLY_DELIVERED','DELIVERED') or sent_at is not null),
  check (record_origin = 'IMPORT' or status <> 'ACKNOWLEDGED' or acknowledged_at is not null),
  check (status <> 'CANCELLED' or cancelled_reason is not null)
);
create index purchase_orders_status_idx on purchase_orders (status);

create table purchase_order_lines (
  id                  uuid primary key default gen_random_uuid(),
  purchase_order_id   uuid not null references purchase_orders(id) on delete cascade,
  line_no             integer not null check (line_no >= 1),
  line_kind           text not null default 'ITEM' check (line_kind in ('ITEM','FREIGHT','SUMMARY')),
  product_id          uuid references products(id),
  supplier_product_id uuid references supplier_products(id),
  description         text not null,
  quantity            numeric(12,3) not null check (quantity > 0),
  unit                text not null,
  unit_price          numeric(12,2) not null check (unit_price >= 0),
  line_amount         numeric(12,2) generated always as (round(quantity * unit_price, 2)) stored,
  quantity_received   numeric(12,3) not null default 0 check (quantity_received >= 0),
  unique (purchase_order_id, line_no),
  check (line_kind <> 'ITEM' or product_id is not null)
);

-- Junction: one PO line can serve several requirements; one requirement can be split.
create table po_line_allocations (
  purchase_order_line_id  uuid not null references purchase_order_lines(id) on delete cascade,
  material_requirement_id uuid not null references material_requirements(id),
  quantity                numeric(12,3) not null check (quantity > 0),
  primary key (purchase_order_line_id, material_requirement_id)
);

create or replace function derive_purchase_order_totals() returns trigger language plpgsql as $$
declare v numeric; s record;
begin
  select coalesce(sum(line_amount), 0) into v from purchase_order_lines where purchase_order_id = new.id;
  s := gst_split(v, new.line_amount_type, new.gst_rate);
  new.subtotal_ex_gst := s.subtotal_ex_gst; new.gst_amount := s.gst_amount; new.total_inc_gst := s.total_inc_gst;
  return new;
end $$;
create trigger purchase_orders_derive_totals before insert or update on purchase_orders
  for each row execute function derive_purchase_order_totals();

-- A line change touches its header: totals re-derive and record_version bumps,
-- which invalidates any approval granted against the old contents.
create or replace function touch_purchase_order_from_line() returns trigger language plpgsql as $$
begin
  update purchase_orders set gst_rate = gst_rate where id = coalesce(new.purchase_order_id, old.purchase_order_id);
  return null;
end $$;
create trigger purchase_order_lines_touch_header after insert or update or delete on purchase_order_lines
  for each row execute function touch_purchase_order_from_line();

-- -----------------------------------------------------------------------------
-- Invoices and payments
-- -----------------------------------------------------------------------------

create table invoices (
  id               uuid primary key default gen_random_uuid(),
  invoice_number   text not null unique,                      -- INV-2026-0012
  project_id       uuid not null references projects(id),
  customer_id      uuid not null references customers(id),
  record_origin    text not null default 'ROOFOPS' check (record_origin in ('ROOFOPS','IMPORT')),
  invoice_type     text check (invoice_type in ('DEPOSIT','PROGRESS','FINAL','VARIATION')),  -- null: not stated in source
  status           text not null default 'DRAFT' check (status in (
                     'DRAFT','PENDING_APPROVAL','APPROVED','ISSUED','PARTIALLY_PAID','PAID','VOIDED')),
  -- Accounting sync state is separate from business state. UNKNOWN = ambiguous write; reconcile before retry.
  sync_status      text not null default 'NOT_SYNCED' check (sync_status in ('NOT_SYNCED','PENDING','SYNCED','FAILED','UNKNOWN')),
  line_amount_type text not null default 'INCLUSIVE' check (line_amount_type in ('EXCLUSIVE','INCLUSIVE','NO_TAX')),
  gst_rate         numeric(5,4) not null default 0.1000,
  subtotal_ex_gst  numeric(12,2) not null default 0,         -- derived
  gst_amount       numeric(12,2) not null default 0,         -- derived
  total_inc_gst    numeric(12,2) not null default 0,         -- derived
  issue_date       date,
  due_date         date,
  approval_id      uuid,
  approved_by      uuid references employees(id),
  approved_at      timestamptz,
  idempotency_key  text unique,
  voided_reason    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  record_version   integer not null default 1,
  check (case line_amount_type
    when 'EXCLUSIVE' then gst_amount = round(subtotal_ex_gst * gst_rate, 2) and total_inc_gst = subtotal_ex_gst + gst_amount
    when 'INCLUSIVE' then gst_amount = round(total_inc_gst * gst_rate / (1 + gst_rate), 2) and subtotal_ex_gst = total_inc_gst - gst_amount
    else gst_amount = 0 and total_inc_gst = subtotal_ex_gst end),
  check (due_date is null or issue_date is null or due_date >= issue_date),
  check (record_origin = 'IMPORT' or status in ('DRAFT','PENDING_APPROVAL','VOIDED') or (approved_by is not null and approved_at is not null)),
  check (status not in ('ISSUED','PARTIALLY_PAID','PAID') or (issue_date is not null and due_date is not null)),
  check (status <> 'VOIDED' or voided_reason is not null)
);
create index invoices_status_due_idx on invoices (status, due_date);

create table invoice_lines (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references invoices(id) on delete cascade,
  line_no      integer not null check (line_no >= 1),
  line_kind    text not null default 'ITEM' check (line_kind in ('ITEM','SUMMARY')),
  description  text not null,
  quantity     numeric(12,3) not null check (quantity > 0),
  unit_price   numeric(12,2) not null,
  line_amount  numeric(12,2) generated always as (round(quantity * unit_price, 2)) stored,
  variation_id uuid references variations(id),
  account_code text,
  unique (invoice_id, line_no)
);

create or replace function derive_invoice_totals() returns trigger language plpgsql as $$
declare v numeric; s record;
begin
  select coalesce(sum(line_amount), 0) into v from invoice_lines where invoice_id = new.id;
  s := gst_split(v, new.line_amount_type, new.gst_rate);
  new.subtotal_ex_gst := s.subtotal_ex_gst; new.gst_amount := s.gst_amount; new.total_inc_gst := s.total_inc_gst;
  return new;
end $$;
create trigger invoices_derive_totals before insert or update on invoices
  for each row execute function derive_invoice_totals();

create or replace function touch_invoice_from_line() returns trigger language plpgsql as $$
begin
  update invoices set gst_rate = gst_rate where id = coalesce(new.invoice_id, old.invoice_id);
  return null;
end $$;
create trigger invoice_lines_touch_header after insert or update or delete on invoice_lines
  for each row execute function touch_invoice_from_line();

create table payments (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references invoices(id),
  amount      numeric(12,2) not null check (amount > 0),
  received_on date not null,
  method      text not null check (method in ('BANK_TRANSFER','CARD','CASH','CHEQUE','OTHER','UNKNOWN')),
  source      text not null default 'MANUAL' check (source in ('MANUAL','XERO','IMPORT')),
  reference   text,
  created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Field records: documents, photos, site notes
-- -----------------------------------------------------------------------------

create table documents (
  id                uuid primary key default gen_random_uuid(),
  document_number   text not null unique,                     -- DOC-0001
  document_type     text not null check (document_type in (
                      'INSPECTION_PHOTOS','ROOF_PLAN','CUSTOMER_QUOTE','SIGNED_ACCEPTANCE','SUPPLIER_QUOTE',
                      'PURCHASE_ORDER','PROGRESS_PHOTOS','COMPLETION_PHOTOS','WARRANTY_PACK','INVOICE_PDF',
                      'COMPLIANCE_CERTIFICATE','SWMS','OTHER')),
  title             text not null,
  file_name         text not null,
  mime_type         text not null,
  size_bytes        bigint check (size_bytes >= 0),
  sha256            text check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_provider  text not null check (storage_provider in ('GOOGLE_DRIVE','SUPABASE_STORAGE','MOCK_DRIVE')),
  storage_ref       text not null,
  review_status     text not null default 'NEEDS_REVIEW' check (review_status in ('NEEDS_REVIEW','APPROVED','REJECTED')),
  uploaded_at       timestamptz,
  uploaded_by       uuid references employees(id),
  project_id        uuid references projects(id),
  job_id            uuid references jobs(id),
  quote_id          uuid references quotes(id),
  purchase_order_id uuid references purchase_orders(id),
  supplier_quote_id uuid references supplier_quotes(id),
  invoice_id        uuid references invoices(id),
  created_at        timestamptz not null default now(),
  check (num_nonnulls(project_id, job_id, quote_id, purchase_order_id, supplier_quote_id, invoice_id) >= 1)
);
create index documents_project_idx on documents (project_id, document_type);

alter table project_checklist_items add foreign key (evidence_document_id) references documents(id);
alter table supplier_quotes add foreign key (source_document_id) references documents(id);

create table site_notes (
  id                   uuid primary key default gen_random_uuid(),
  note_number          text not null unique,                  -- NOTE-0001
  project_id           uuid not null references projects(id),
  job_id               uuid,
  author_id            uuid references employees(id),
  note_type            text not null default 'GENERAL' check (note_type in ('GENERAL','SAFETY','WEATHER','ACCESS','DEFECT','VARIATION','MATERIALS')),
  body                 text not null check (length(body) between 1 and 5000),
  noted_at             timestamptz not null,
  ai_extraction_status text not null default 'PENDING' check (ai_extraction_status in ('PENDING','PROCESSED','FAILED')),
  created_at           timestamptz not null default now(),
  foreign key (job_id, project_id) references jobs (id, project_id)
);

-- -----------------------------------------------------------------------------
-- Integration identity: external systems keyed by their own IDs, never by names.
-- -----------------------------------------------------------------------------

create table external_links (
  id             uuid primary key default gen_random_uuid(),
  provider       text not null check (provider in ('XERO','GOOGLE_DRIVE','AIRTABLE','GMAIL','N8N')),
  is_mock        boolean not null,
  entity_type    text not null,
  entity_id      uuid not null,
  external_type  text not null,
  external_id    text not null,
  external_url   text,
  last_synced_at timestamptz,
  created_at     timestamptz not null default now(),
  unique (provider, external_type, external_id),
  unique (provider, entity_type, entity_id, external_type)
);

-- -----------------------------------------------------------------------------
-- Automation: event log, idempotency ledger, runs, exceptions, outbox
-- -----------------------------------------------------------------------------

create table automation_events (
  event_id           uuid primary key,
  event_key          text unique,                           -- source/business key, e.g. EVT-00001
  correlation_id     uuid not null,
  correlation_key    text,                                  -- source key, e.g. CORR-0001
  causation_id       uuid,
  event_type         text not null check (event_type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  entity_type        text,
  entity_id          uuid,
  business_reference text,
  actor_type         text not null check (actor_type in ('USER','SYSTEM','AI','INTEGRATION','WORKFLOW')),
  actor_id           text,
  source             text not null,
  workflow_version   text,
  occurred_at        timestamptz not null,
  recorded_at        timestamptz not null default now(),
  status             text not null check (status in ('RECEIVED','SUCCEEDED','FAILED','DUPLICATE_IGNORED','REJECTED','INFO')),
  external_reference text,
  error_class        text references error_classes(code),
  metadata           jsonb not null default '{}'::jsonb,
  payload            jsonb,
  check (status not in ('FAILED','DUPLICATE_IGNORED') or error_class is not null)
);
create index automation_events_correlation_idx on automation_events (correlation_id, occurred_at);
create index automation_events_entity_idx on automation_events (entity_type, entity_id, occurred_at);
create index automation_events_type_idx on automation_events (event_type, occurred_at desc);

create table processed_events (
  consumer         text not null,
  idempotency_key  text not null,
  record_origin    text not null default 'ROOFOPS' check (record_origin in ('ROOFOPS','IMPORT')),
  first_event_id   uuid references automation_events(event_id),
  request_hash     text,
  status           text not null check (status in ('PROCESSING','COMPLETED','FAILED')),
  locked_by        text,
  lease_expires_at timestamptz,
  attempt_count    integer not null default 1 check (attempt_count >= 1),
  delivery_count   integer not null default 1 check (delivery_count >= 1),
  result           jsonb,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  completed_at     timestamptz,
  primary key (consumer, idempotency_key),
  check ((status = 'COMPLETED') = (completed_at is not null and result is not null)),
  check (status <> 'PROCESSING' or lease_expires_at is not null),
  check (record_origin = 'IMPORT' or (first_event_id is not null and request_hash is not null))
);

create table workflow_runs (
  id                 uuid primary key default gen_random_uuid(),
  workflow_key       text not null,
  workflow_version   text not null,
  runner             text not null check (runner in ('LOCAL','N8N')),
  trigger_event_id   uuid references automation_events(event_id),
  correlation_id     uuid not null,
  idempotency_key    text not null,
  entity_type        text,
  entity_id          uuid,
  business_reference text,
  status             text not null default 'QUEUED' check (status in (
                       'QUEUED','RUNNING','SUCCEEDED','RETRY_SCHEDULED','FAILED','DEAD_LETTERED','CANCELLED')),
  attempt_count      integer not null default 0 check (attempt_count >= 0),
  max_attempts       integer not null default 5 check (max_attempts >= 1),
  next_attempt_at    timestamptz,
  started_at         timestamptz,
  finished_at        timestamptz,
  last_error_class   text references error_classes(code),
  last_error_message text,
  output             jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  record_version     integer not null default 1,
  unique (workflow_key, idempotency_key),
  check (attempt_count <= max_attempts),
  check (status <> 'RETRY_SCHEDULED' or next_attempt_at is not null),
  check (finished_at is null or started_at is null or finished_at >= started_at)
);
create index workflow_runs_due_idx on workflow_runs (next_attempt_at) where status = 'RETRY_SCHEDULED';
create index workflow_runs_key_status_idx on workflow_runs (workflow_key, status, created_at desc);

alter table tasks add foreign key (created_by_workflow_run_id) references workflow_runs(id);

create table workflow_run_steps (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references workflow_runs(id) on delete cascade,
  attempt        integer not null check (attempt >= 1),
  seq            integer not null,
  step_key       text not null,
  status         text not null check (status in ('STARTED','SUCCEEDED','FAILED','SKIPPED')),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  http_status    integer,
  error_class    text references error_classes(code),
  retry_delay_ms integer,
  detail         jsonb not null default '{}'::jsonb,
  unique (run_id, attempt, seq)
);

create table workflow_exceptions (
  id                 uuid primary key default gen_random_uuid(),
  exception_number   text not null unique,                    -- EXC-0001
  record_origin      text not null default 'ROOFOPS' check (record_origin in ('ROOFOPS','IMPORT')),
  workflow_run_id    uuid references workflow_runs(id),
  event_id           uuid references automation_events(event_id),
  workflow_key       text not null,
  entity_type        text,
  entity_id          uuid,
  business_reference text,
  error_class        text not null references error_classes(code),
  error_message      text not null,
  retryable          boolean not null,
  attempt_count      integer not null check (attempt_count >= 0),
  first_failed_at    timestamptz not null,
  last_attempt_at    timestamptz not null,
  resolution_status  text not null default 'OPEN' check (resolution_status in ('OPEN','RETRY_QUEUED','RESOLVED','IGNORED')),
  resolved_by        uuid references employees(id),
  resolved_at        timestamptz,
  resolution_note    text,
  created_at         timestamptz not null default now(),
  check (last_attempt_at >= first_failed_at),
  check (record_origin = 'IMPORT' or (resolution_status in ('RESOLVED','IGNORED')) = (resolved_by is not null and resolved_at is not null)),
  check (resolution_status <> 'IGNORED' or resolution_note is not null)
);
create unique index workflow_exceptions_one_open_per_run
  on workflow_exceptions (workflow_run_id) where resolution_status in ('OPEN','RETRY_QUEUED');

create table outbox (
  id               uuid primary key default gen_random_uuid(),
  topic            text not null,
  aggregate_type   text not null,
  aggregate_id     uuid not null,
  correlation_id   uuid not null,
  idempotency_key  text not null unique,
  payload          jsonb not null,
  status           text not null default 'PENDING' check (status in ('PENDING','DISPATCHING','DONE','FAILED')),
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  locked_until     timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  dispatched_at    timestamptz
);
create index outbox_pending_idx on outbox (next_attempt_at) where status in ('PENDING','FAILED');

-- -----------------------------------------------------------------------------
-- Human approval (RED actions) and AI tool use
-- -----------------------------------------------------------------------------

create table ai_tool_invocations (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  employee_id     uuid not null references employees(id),
  provider        text not null,
  model           text,
  tool_name       text not null,
  tier            text not null check (tier in ('GREEN','AMBER','RED')),
  input           jsonb not null,
  decision        text not null check (decision in (
                    'EXECUTED','DRAFT_CREATED','APPROVAL_REQUESTED','DENIED_PERMISSION',
                    'INVALID_INPUT','UNKNOWN_TOOL','ERROR')),
  result_summary  jsonb,
  approval_id     uuid,
  latency_ms      integer,
  created_at      timestamptz not null default now()
);
create index ai_tool_invocations_conversation_idx on ai_tool_invocations (conversation_id, created_at);

create table ai_drafts (
  id                uuid primary key default gen_random_uuid(),
  draft_type        text not null check (draft_type in ('SUPPLIER_EMAIL','CUSTOMER_MESSAGE','PROJECT_SUMMARY','PURCHASE_ORDER')),
  project_id        uuid references projects(id),
  purchase_order_id uuid references purchase_orders(id),
  content           jsonb not null,
  status            text not null default 'DRAFT' check (status in ('DRAFT','DISCARDED','PROMOTED')),
  invocation_id     uuid references ai_tool_invocations(id),
  created_for       uuid not null references employees(id),
  created_at        timestamptz not null default now()
);

create table approvals (
  id                          uuid primary key default gen_random_uuid(),
  approval_number             text not null unique,
  action_type                 text not null check (action_type in (
                                'SEND_PURCHASE_ORDER','APPROVE_PURCHASE_ORDER','CREATE_INVOICE',
                                'SYNC_INVOICE_TO_XERO','CANCEL_PROJECT','CHANGE_APPROVED_MATERIALS')),
  entity_type                 text not null,
  entity_id                   uuid not null,
  business_reference          text,
  requested_by_actor_type     text not null check (requested_by_actor_type in ('USER','AI','WORKFLOW')),
  requested_by_employee_id    uuid references employees(id),
  requested_via_invocation_id uuid references ai_tool_invocations(id),
  required_permission         text not null,
  action_payload              jsonb not null,
  payload_hash                text not null,
  expected_record_version     integer not null,
  idempotency_key             text not null unique,
  status                      text not null default 'PENDING' check (status in (
                                'PENDING','APPROVED','REJECTED','EXPIRED','EXECUTING','EXECUTED','EXECUTION_FAILED','CANCELLED')),
  decided_by                  uuid references employees(id),
  decided_at                  timestamptz,
  decision_reason             text,
  expires_at                  timestamptz not null,
  executed_at                 timestamptz,
  execution_result            jsonb,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  record_version              integer not null default 1,
  check (status not in ('APPROVED','REJECTED','EXECUTING','EXECUTED','EXECUTION_FAILED') or (decided_by is not null and decided_at is not null)),
  check (status <> 'REJECTED' or decision_reason is not null),
  check (status not in ('EXECUTED','EXECUTION_FAILED') or (executed_at is not null and execution_result is not null)),
  check (requested_by_actor_type <> 'AI' or requested_via_invocation_id is not null)
);
create index approvals_pending_idx on approvals (status, created_at) where status = 'PENDING';

alter table ai_tool_invocations add foreign key (approval_id) references approvals(id);
alter table purchase_orders add foreign key (approval_id) references approvals(id);
alter table invoices add foreign key (approval_id) references approvals(id);

-- -----------------------------------------------------------------------------
-- Audit trail: append-only, hash-chained, separate from the debug event log
-- -----------------------------------------------------------------------------

create table audit_events (
  seq                bigint generated always as identity primary key,
  audit_id           uuid not null unique default gen_random_uuid(),
  occurred_at        timestamptz not null default now(),
  actor_type         text not null check (actor_type in ('USER','SYSTEM','AI','INTEGRATION','WORKFLOW')),
  actor_id           text not null,
  actor_display      text,
  on_behalf_of       uuid references employees(id),
  action             text not null,
  entity_type        text not null,
  entity_id          uuid not null,
  business_reference text,
  before_state       jsonb,
  after_state        jsonb,
  approval_id        uuid references approvals(id),
  external_reference text,
  reason             text,
  correlation_id     uuid,
  workflow_run_id    uuid references workflow_runs(id),
  prev_hash          text,
  row_hash           text not null default ''
);
create index audit_events_entity_idx on audit_events (entity_type, entity_id, seq);
create index audit_events_correlation_idx on audit_events (correlation_id);

create or replace function audit_row_hash(p_prev text, a audit_events) returns text language sql immutable as $$
  select encode(sha256(convert_to(
    -- occurred_at rendered in UTC so the hash does not depend on the session time zone
    coalesce(p_prev, '') || '|' || a.audit_id || '|' ||
    to_char(a.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '|' || a.actor_type || '|' ||
    a.actor_id || '|' || a.action || '|' || a.entity_type || '|' || a.entity_id || '|' ||
    coalesce(a.before_state::text, '') || '|' || coalesce(a.after_state::text, '') || '|' ||
    coalesce(a.approval_id::text, '') || '|' || coalesce(a.external_reference, '') || '|' ||
    coalesce(a.reason, ''), 'UTF8')), 'hex')
$$;

-- The advisory lock serialises audit inserts so concurrent writers cannot fork the chain.
create or replace function audit_events_chain() returns trigger language plpgsql as $$
declare v_prev text;
begin
  perform pg_advisory_xact_lock(hashtext('audit_events_chain'));
  select row_hash into v_prev from audit_events order by seq desc limit 1;
  new.prev_hash := v_prev;
  new.row_hash := audit_row_hash(v_prev, new);
  return new;
end $$;
create trigger audit_events_chain before insert on audit_events
  for each row execute function audit_events_chain();

-- Recompute the chain; returns the first broken seq, or null if intact.
create or replace function verify_audit_chain() returns bigint language plpgsql stable as $$
declare r audit_events; v_prev text := null;
begin
  for r in select * from audit_events order by seq loop
    if r.prev_hash is distinct from v_prev or r.row_hash <> audit_row_hash(v_prev, r) then
      return r.seq;
    end if;
    v_prev := r.row_hash;
  end loop;
  return null;
end $$;

create or replace function reject_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only (% rejected)', tg_table_name, tg_op using errcode = 'insufficient_privilege';
end $$;
create trigger audit_events_append_only before update or delete on audit_events
  for each row execute function reject_mutation();
create trigger audit_events_no_truncate before truncate on audit_events
  for each statement execute function reject_mutation();

-- -----------------------------------------------------------------------------
-- updated_at / record_version maintenance
-- -----------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'employees','customers','contacts','leads','properties','inspections','products','quotes',
    'projects','tasks','variations','jobs','suppliers','material_requirements','supplier_quotes',
    'purchase_orders','invoices','workflow_runs','approvals']
  loop
    execute format('create trigger %I_touch before update on %I for each row execute function touch_row()', t, t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Lock the front door: RLS on, no policies. Server code uses a server-only role.
-- -----------------------------------------------------------------------------

do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I enable row level security', r.tablename);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;
