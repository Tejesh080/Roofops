-- =============================================================================
-- RoofOps core schema
-- Phase 0 draft: designed and syntax/constraint-checked against PGlite (Postgres 17).
-- Applied to Supabase and exercised by seed + tests in Phase 1.
--
-- Conventions
--   * UUID primary keys internally; human-friendly business numbers (Q-2026-0042)
--     are separate UNIQUE columns issued by next_friendly_id().
--   * Status columns are text + CHECK (easier to evolve than Postgres enums).
--   * Money is numeric(12,2) AUD. GST rate stored per document (default 0.10).
--     Line totals are GENERATED columns so arithmetic lives in the database,
--     never in an LLM response.
--   * record_version supports optimistic concurrency (UPDATE ... WHERE record_version = $n).
--   * Derived facts (schedule risk, overdue, outstanding balance) are NOT stored;
--     they are computed in views (Phase 1) so they cannot drift from the facts.
--   * RLS is enabled on every table with no policies: browsers never talk to the
--     database directly. All access goes through server code.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------

create table id_counters (
  counter_key text    not null,
  year        integer not null default 0,          -- 0 = not year-scoped (CUST-0001)
  last_value  integer not null default 0 check (last_value >= 0),
  primary key (counter_key, year)
);

-- Concurrency-safe friendly ID issue. The upsert takes a row lock, so two
-- transactions can never receive the same number. Gaps are possible if a
-- transaction rolls back; that is acceptable and documented.
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

-- -----------------------------------------------------------------------------
-- People
-- -----------------------------------------------------------------------------

create table employees (
  id             uuid primary key default gen_random_uuid(),
  employee_code  text not null unique,                       -- EMP-001
  full_name      text not null,
  email          text not null unique check (email ~* '^[^@]+@[^@]+\.[^@]+$'),
  role           text not null check (role in (
                   'ADMIN','OPERATIONS_MANAGER','PROJECT_MANAGER','ESTIMATOR',
                   'PURCHASING','FINANCE','FIELD_CREW','VIEWER')),
  auth_user_id   uuid unique,                                -- Supabase auth.users id (real auth mode)
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
  phone_normalised        text,                              -- digits only, used for duplicate detection
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

-- Duplicate-customer review queue. Pair is stored in canonical order so (A,B) and (B,A)
-- cannot both exist.
create table customer_match_candidates (
  id                    uuid primary key default gen_random_uuid(),
  customer_id           uuid not null references customers(id),
  candidate_customer_id uuid not null references customers(id),
  match_score           numeric(4,3) not null check (match_score between 0 and 1),
  match_reasons         jsonb not null default '[]'::jsonb,  -- e.g. ["PHONE_EXACT","NAME_EXACT"]
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
  lead_number           text not null unique,                -- LEAD-2026-0001
  source                text not null check (source in (
                          'GOOGLE_ADS','ORGANIC_SEARCH','REFERRAL','FACEBOOK','REPEAT_CUSTOMER',
                          'BUILDER_REFERRAL','LOCAL_SIGNAGE','WEBSITE_FORM','PHONE','OTHER')),
  status                text not null default 'NEW' check (status in (
                          'NEW','CONTACTED','INSPECTION_BOOKED','QUOTED','WON','LOST','DISQUALIFIED')),
  contact_name          text not null,
  email                 text,
  phone                 text,
  property_address_text text,
  customer_id           uuid references customers(id),       -- set on conversion
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

-- Many-to-many: an owner, a tenant and a property manager can all relate to one
-- property, and a builder customer relates to many properties.
create table customer_properties (
  customer_id  uuid not null references customers(id),
  property_id  uuid not null references properties(id),
  relationship text not null check (relationship in ('OWNER','TENANT','PROPERTY_MANAGER','BUILDER','STRATA_MANAGER')),
  valid_from   date not null default current_date,
  valid_to     date,
  primary key (customer_id, property_id, relationship),
  check (valid_to is null or valid_to >= valid_from)
);

create table inspections (
  id                 uuid primary key default gen_random_uuid(),
  inspection_number  text not null unique,                   -- INS-2026-0001
  property_id        uuid not null references properties(id),
  lead_id            uuid references leads(id),
  inspector_id       uuid references employees(id),
  status             text not null default 'SCHEDULED' check (status in ('SCHEDULED','COMPLETED','CANCELLED')),
  scheduled_for      timestamptz,
  completed_at       timestamptz,
  roof_type          text check (roof_type in ('TILE','TERRACOTTA_TILE','METAL','COLORBOND','ZINCALUME','OTHER')),
  roof_area_sqm      numeric(8,1) check (roof_area_sqm > 0),   -- nullable: "missing measurement" is a real state
  pitch_degrees      numeric(4,1) check (pitch_degrees between 0 and 75),
  measurement_method text check (measurement_method in ('TAPE','DRONE','AERIAL_IMAGERY','PLAN_TAKEOFF')),
  findings           text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  record_version     integer not null default 1,
  check ((status = 'COMPLETED') = (completed_at is not null)),
  check (roof_area_sqm is null or measurement_method is not null)
);

-- -----------------------------------------------------------------------------
-- Estimate -> Quote -> Quote version
-- -----------------------------------------------------------------------------

create table products (
  id                uuid primary key default gen_random_uuid(),
  sku               text not null unique,                    -- RO-SHT-CB-0.42
  name              text not null,
  category          text not null check (category in (
                      'ROOF_SHEETING','TILES','FLASHINGS','GUTTERS_DOWNPIPES','FASTENERS',
                      'SARKING_INSULATION','VENTILATION','SEALANTS_COATINGS','SAFETY','ACCESSORIES')),
  unit              text not null check (unit in ('EA','LM','M2','SHEET','BOX','ROLL','PACK','L','KG','LOT')),
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  record_version    integer not null default 1
);

-- Alternative descriptions seen on supplier paperwork; used by deterministic
-- product matching before any fuzzy/AI-assisted suggestion.
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
  estimator_id        uuid references employees(id),
  job_type            text not null check (job_type in (
                        'LEAK_REPAIR','ROOF_RESTORATION','ROOF_REPLACEMENT','FULL_REROOF',
                        'EXTENSION_ROOF','STORM_DAMAGE_REPAIR')),
  status              text not null default 'DRAFT' check (status in ('DRAFT','SENT','ACCEPTED','LOST','EXPIRED')),
  accepted_version_id uuid,                                  -- composite FK added below
  sent_at             timestamptz,
  accepted_at         timestamptz,
  valid_until         date,
  lost_reason         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  record_version      integer not null default 1,
  unique (id, customer_id, property_id),                     -- target for projects composite FK
  check ((status = 'ACCEPTED') = (accepted_version_id is not null and accepted_at is not null)),
  check (status <> 'LOST' or lost_reason is not null),
  check (status = 'DRAFT' or sent_at is not null)
);
create index quotes_status_idx on quotes (status);

create table quote_versions (
  id               uuid primary key default gen_random_uuid(),
  quote_id         uuid not null references quotes(id) on delete cascade,
  version_number   integer not null check (version_number >= 1),
  gst_rate         numeric(5,4) not null default 0.1000 check (gst_rate between 0 and 1),
  subtotal_ex_gst  numeric(12,2) not null default 0 check (subtotal_ex_gst >= 0),
  gst_amount       numeric(12,2) not null default 0,
  total_inc_gst    numeric(12,2) not null default 0,
  roof_area_basis_sqm numeric(8,1),
  scope_summary    text,
  created_by       uuid references employees(id),
  created_at       timestamptz not null default now(),
  unique (quote_id, version_number),
  unique (id, quote_id),                                     -- target for composite FKs
  check (gst_amount = round(subtotal_ex_gst * gst_rate, 2)),
  check (total_inc_gst = subtotal_ex_gst + gst_amount)
);

alter table quotes
  add constraint quotes_accepted_version_belongs_to_quote
  foreign key (accepted_version_id, id) references quote_versions (id, quote_id);

create table quote_version_lines (
  id                uuid primary key default gen_random_uuid(),
  quote_version_id  uuid not null references quote_versions(id) on delete cascade,
  line_no           integer not null check (line_no >= 1),
  line_kind         text not null check (line_kind in ('MATERIAL','LABOUR','EQUIPMENT','OTHER')),
  product_id        uuid references products(id),
  description       text not null,
  quantity          numeric(12,3) not null check (quantity > 0),
  unit              text not null,
  unit_price_ex_gst numeric(12,2) not null check (unit_price_ex_gst >= 0),
  line_total_ex_gst numeric(12,2) generated always as (round(quantity * unit_price_ex_gst, 2)) stored,
  unique (quote_version_id, line_no),
  check (line_kind <> 'MATERIAL' or product_id is not null)
);

-- -----------------------------------------------------------------------------
-- Project -> Checklist / Tasks / Variations / Jobs
-- -----------------------------------------------------------------------------

create table projects (
  id                        uuid primary key default gen_random_uuid(),
  project_number            text not null unique,            -- PRJ-2026-0018
  quote_id                  uuid not null unique,            -- ONE project per quote: last line of idempotency defence
  accepted_quote_version_id uuid not null,
  customer_id               uuid not null,
  property_id               uuid not null,
  project_manager_id        uuid references employees(id),
  status                    text not null default 'PLANNING' check (status in (
                              'PLANNING','MATERIALS_PENDING','SCHEDULED','IN_PROGRESS','ON_HOLD',
                              'COMPLETED','CLOSED','CANCELLED')),
  contract_value_ex_gst     numeric(12,2) not null check (contract_value_ex_gst >= 0),
  planned_start_date        date,
  planned_completion_date   date,
  actual_start_date         date,
  actual_completion_date    date,
  on_hold_reason            text,
  cancellation_reason       text,
  created_by_event_id       uuid,                            -- automation_events.event_id that created it
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  record_version            integer not null default 1,
  -- project must reference the same customer/property as its quote, and the accepted version of THAT quote
  foreign key (quote_id, customer_id, property_id) references quotes (id, customer_id, property_id),
  foreign key (accepted_quote_version_id, quote_id) references quote_versions (id, quote_id),
  foreign key (customer_id) references customers(id),
  foreign key (property_id) references properties(id),
  check (planned_completion_date is null or planned_start_date is null or planned_completion_date >= planned_start_date),
  check (actual_completion_date is null or actual_start_date is null or actual_completion_date >= actual_start_date),
  check (status not in ('COMPLETED','CLOSED') or actual_completion_date is not null),
  check (status <> 'ON_HOLD' or on_hold_reason is not null),
  check (status <> 'CANCELLED' or cancellation_reason is not null)
);
create index projects_status_idx on projects (status);

create table project_checklist_items (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references projects(id) on delete cascade,
  item_code            text not null,                         -- e.g. SWMS_SIGNED, COMPLETION_PHOTOS
  label                text not null,
  stage                text not null check (stage in ('PRE_START','COMPLETION','INVOICING')),
  is_required          boolean not null default true,
  status               text not null default 'OPEN' check (status in ('OPEN','DONE','WAIVED','NOT_APPLICABLE')),
  completed_by         uuid references employees(id),
  completed_at         timestamptz,
  evidence_document_id uuid,                                   -- FK added after documents
  waived_reason        text,
  sort_order           integer not null default 0,
  unique (project_id, item_code),
  check ((status = 'DONE') = (completed_at is not null)),
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
  dedupe_key             text unique,                         -- e.g. 'material_review:<project_id>'
  created_by_workflow_run_id uuid,                            -- FK added after workflow_runs
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  record_version         integer not null default 1
);

create table variations (
  id                   uuid primary key default gen_random_uuid(),
  variation_number     text not null unique,                  -- VAR-2026-0001
  project_id           uuid not null references projects(id),
  description          text not null,
  amount_ex_gst        numeric(12,2) not null,                -- may be negative (credit)
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
  job_number      text not null unique,                       -- JOB-2026-0001
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
  id                  uuid primary key default gen_random_uuid(),
  supplier_code       text not null unique,                   -- SUP-001
  name                text not null unique,
  abn                 text check (abn ~ '^[0-9]{11}$'),
  orders_email        text check (orders_email ~* '^[^@]+@[^@]+\.[^@]+$'),
  phone               text,
  payment_terms_days  integer not null default 30 check (payment_terms_days between 0 and 120),
  default_lead_time_days integer check (default_lead_time_days >= 0),
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  record_version      integer not null default 1
);

alter table product_aliases add foreign key (supplier_id) references suppliers(id);

create table supplier_products (
  id                uuid primary key default gen_random_uuid(),
  supplier_id       uuid not null references suppliers(id),
  product_id        uuid not null references products(id),
  supplier_sku      text not null,
  supplier_description text,
  pack_size         numeric(12,3) not null default 1 check (pack_size > 0),
  list_price_ex_gst numeric(12,2) not null check (list_price_ex_gst >= 0),
  lead_time_days    integer check (lead_time_days >= 0),
  price_valid_until date,
  unique (supplier_id, supplier_sku),
  unique (supplier_id, product_id)
);

create table material_requirements (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references projects(id),
  product_id          uuid not null references products(id),
  quantity            numeric(12,3) not null check (quantity > 0),
  unit                text not null,
  required_by         date,
  source              text not null check (source in ('QUOTE','TAKEOFF','MANUAL')),
  source_quote_line_id uuid references quote_version_lines(id),
  takeoff_reference   text,                                   -- measurement provenance (Module 6)
  status              text not null default 'DRAFT' check (status in ('DRAFT','APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  approved_by         uuid references employees(id),
  approved_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  record_version      integer not null default 1,
  check ((status in ('DRAFT','CANCELLED')) or (approved_by is not null and approved_at is not null))
);
create unique index material_requirements_one_active_per_product
  on material_requirements (project_id, product_id) where status <> 'CANCELLED';

create table supplier_quotes (
  id                    uuid primary key default gen_random_uuid(),
  supplier_id           uuid references suppliers(id),         -- null until the supplier is identified
  project_id            uuid references projects(id),
  supplier_reference    text,                                  -- the supplier's own quote number
  received_at           timestamptz not null default now(),
  source_document_id    uuid,                                  -- FK added after documents
  raw_text              text,
  status                text not null default 'RECEIVED' check (status in (
                          'RECEIVED','EXTRACTED','EXTRACTION_FAILED','NEEDS_REVIEW','REVIEWED','REJECTED','CONVERTED')),
  extraction            jsonb,                                 -- raw structured output from the model, kept verbatim
  extraction_model      text,
  extraction_prompt_version text,
  prices_include_gst    boolean,
  freight_ex_gst        numeric(12,2) check (freight_ex_gst >= 0),
  stated_total          numeric(12,2),                         -- what the supplier wrote
  lead_time_days        integer check (lead_time_days >= 0),
  delivery_date         date,
  valid_until           date,
  validation_issues     jsonb not null default '[]'::jsonb,    -- [{code, field, message}]
  reviewed_by           uuid references employees(id),
  reviewed_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  record_version        integer not null default 1,
  check (status not in ('REVIEWED','CONVERTED') or (reviewed_by is not null and supplier_id is not null))
);

create table supplier_quote_lines (
  id                   uuid primary key default gen_random_uuid(),
  supplier_quote_id    uuid not null references supplier_quotes(id) on delete cascade,
  line_no              integer not null check (line_no >= 1),
  raw_description      text not null,
  supplier_sku         text,
  quantity             numeric(12,3),                          -- nullable: "missing field" fixture
  unit                 text,
  unit_price_as_stated numeric(12,2),
  unit_price_ex_gst    numeric(12,2),                          -- normalised by code, not by the model
  stated_line_total    numeric(12,2),
  computed_line_total_ex_gst numeric(12,2) generated always as (round(quantity * unit_price_ex_gst, 2)) stored,
  matched_product_id   uuid references products(id),
  match_method         text check (match_method in ('SUPPLIER_SKU','ALIAS_EXACT','FUZZY_SUGGESTED','MANUAL')),
  match_confidence     numeric(4,3) check (match_confidence between 0 and 1),
  unique (supplier_quote_id, line_no)
);

create table purchase_orders (
  id                     uuid primary key default gen_random_uuid(),
  po_number              text not null unique,                 -- PO-2026-0031
  supplier_id            uuid not null references suppliers(id),
  project_id             uuid references projects(id),         -- null = stock order
  origin                 text not null default 'MANUAL' check (origin in ('MANUAL','AI_DRAFT','SUPPLIER_QUOTE')),
  source_supplier_quote_id uuid references supplier_quotes(id),
  status                 text not null default 'DRAFT' check (status in (
                           'DRAFT','PENDING_APPROVAL','APPROVED','SENT','ACKNOWLEDGED',
                           'PARTIALLY_DELIVERED','DELIVERED','CANCELLED')),
  gst_rate               numeric(5,4) not null default 0.1000,
  subtotal_ex_gst        numeric(12,2) not null default 0,     -- maintained by trigger from lines
  freight_ex_gst         numeric(12,2) not null default 0 check (freight_ex_gst >= 0),
  gst_amount             numeric(12,2) not null default 0,
  total_inc_gst          numeric(12,2) not null default 0,
  required_by            date,
  expected_delivery_date date,
  supplier_reference     text,
  approval_id            uuid,                                 -- FK added after approvals
  approved_by            uuid references employees(id),
  approved_at            timestamptz,
  sent_at                timestamptz,
  acknowledged_at        timestamptz,
  cancelled_reason       text,
  idempotency_key        text unique,                          -- guards duplicate "send PO" / "create PO"
  created_by             uuid references employees(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  record_version         integer not null default 1,
  check (gst_amount = round((subtotal_ex_gst + freight_ex_gst) * gst_rate, 2)),
  check (total_inc_gst = subtotal_ex_gst + freight_ex_gst + gst_amount),
  check (status in ('DRAFT','PENDING_APPROVAL','CANCELLED') or (approved_by is not null and approved_at is not null)),
  check (status not in ('SENT','ACKNOWLEDGED','PARTIALLY_DELIVERED','DELIVERED') or sent_at is not null),
  check (status not in ('ACKNOWLEDGED') or acknowledged_at is not null),
  check (status <> 'CANCELLED' or cancelled_reason is not null)
);
create index purchase_orders_status_idx on purchase_orders (status);

create table purchase_order_lines (
  id                  uuid primary key default gen_random_uuid(),
  purchase_order_id   uuid not null references purchase_orders(id) on delete cascade,
  line_no             integer not null check (line_no >= 1),
  product_id          uuid not null references products(id),
  supplier_product_id uuid references supplier_products(id),
  description         text not null,
  quantity            numeric(12,3) not null check (quantity > 0),
  unit                text not null,
  unit_price_ex_gst   numeric(12,2) not null check (unit_price_ex_gst >= 0),
  line_total_ex_gst   numeric(12,2) generated always as (round(quantity * unit_price_ex_gst, 2)) stored,
  quantity_received   numeric(12,3) not null default 0 check (quantity_received >= 0),
  unique (purchase_order_id, line_no)
);

-- Junction: one PO line can satisfy several requirements (consolidated order),
-- and one requirement can be split across several PO lines/suppliers.
create table po_line_allocations (
  purchase_order_line_id  uuid not null references purchase_order_lines(id) on delete cascade,
  material_requirement_id uuid not null references material_requirements(id),
  quantity                numeric(12,3) not null check (quantity > 0),
  primary key (purchase_order_line_id, material_requirement_id)
);

-- PO header totals are fully derived: subtotal from lines, then GST and total.
-- Any value supplied by a caller (or an LLM) for these columns is overwritten.
-- Arithmetic lives here, never in input.
create or replace function derive_purchase_order_totals() returns trigger language plpgsql as $$
begin
  select coalesce(sum(line_total_ex_gst), 0) into new.subtotal_ex_gst
    from purchase_order_lines where purchase_order_id = new.id;
  new.gst_amount    := round((new.subtotal_ex_gst + new.freight_ex_gst) * new.gst_rate, 2);
  new.total_inc_gst := new.subtotal_ex_gst + new.freight_ex_gst + new.gst_amount;
  return new;
end $$;
create trigger purchase_orders_derive_totals
  before insert or update on purchase_orders
  for each row execute function derive_purchase_order_totals();

-- A line change "touches" its header so the header re-derives (and bumps record_version,
-- which invalidates any approval granted against the old contents).
create or replace function touch_purchase_order_from_line() returns trigger language plpgsql as $$
begin
  update purchase_orders set freight_ex_gst = freight_ex_gst
   where id = coalesce(new.purchase_order_id, old.purchase_order_id);
  return null;
end $$;
create trigger purchase_order_lines_touch_header
  after insert or update or delete on purchase_order_lines
  for each row execute function touch_purchase_order_from_line();

-- -----------------------------------------------------------------------------
-- Invoices and payments
-- -----------------------------------------------------------------------------

create table invoices (
  id              uuid primary key default gen_random_uuid(),
  invoice_number  text not null unique,                       -- INV-2026-0012
  project_id      uuid not null references projects(id),
  customer_id     uuid not null references customers(id),
  invoice_type    text not null check (invoice_type in ('DEPOSIT','PROGRESS','FINAL','VARIATION')),
  status          text not null default 'DRAFT' check (status in (
                    'DRAFT','PENDING_APPROVAL','APPROVED','ISSUED','PARTIALLY_PAID','PAID','VOIDED')),
  -- Accounting sync state is separate from business state. UNKNOWN = ambiguous
  -- write (timeout after POST) and MUST be reconciled before any retry.
  sync_status     text not null default 'NOT_SYNCED' check (sync_status in ('NOT_SYNCED','PENDING','SYNCED','FAILED','UNKNOWN')),
  gst_rate        numeric(5,4) not null default 0.1000,
  subtotal_ex_gst numeric(12,2) not null default 0,
  gst_amount      numeric(12,2) not null default 0,
  total_inc_gst   numeric(12,2) not null default 0,
  issue_date      date,
  due_date        date,
  approval_id     uuid,                                       -- FK added after approvals
  approved_by     uuid references employees(id),
  approved_at     timestamptz,
  idempotency_key text unique,                                -- guards duplicate create/sync
  voided_reason   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  record_version  integer not null default 1,
  check (gst_amount = round(subtotal_ex_gst * gst_rate, 2)),
  check (total_inc_gst = subtotal_ex_gst + gst_amount),
  check (due_date is null or issue_date is null or due_date >= issue_date),
  check (status in ('DRAFT','PENDING_APPROVAL','VOIDED') or (approved_by is not null and approved_at is not null)),
  check (status not in ('ISSUED','PARTIALLY_PAID','PAID') or (issue_date is not null and due_date is not null)),
  check (status <> 'VOIDED' or voided_reason is not null)
);
create index invoices_status_due_idx on invoices (status, due_date);

create table invoice_lines (
  id                uuid primary key default gen_random_uuid(),
  invoice_id        uuid not null references invoices(id) on delete cascade,
  line_no           integer not null check (line_no >= 1),
  description       text not null,
  quantity          numeric(12,3) not null check (quantity > 0),
  unit_price_ex_gst numeric(12,2) not null,
  line_total_ex_gst numeric(12,2) generated always as (round(quantity * unit_price_ex_gst, 2)) stored,
  variation_id      uuid references variations(id),
  account_code      text,                                     -- Xero account code, e.g. '200'
  unique (invoice_id, line_no)
);

create or replace function derive_invoice_totals() returns trigger language plpgsql as $$
begin
  select coalesce(sum(line_total_ex_gst), 0) into new.subtotal_ex_gst
    from invoice_lines where invoice_id = new.id;
  new.gst_amount    := round(new.subtotal_ex_gst * new.gst_rate, 2);
  new.total_inc_gst := new.subtotal_ex_gst + new.gst_amount;
  return new;
end $$;
create trigger invoices_derive_totals
  before insert or update on invoices
  for each row execute function derive_invoice_totals();

create or replace function touch_invoice_from_line() returns trigger language plpgsql as $$
begin
  update invoices set gst_rate = gst_rate where id = coalesce(new.invoice_id, old.invoice_id);
  return null;
end $$;
create trigger invoice_lines_touch_header
  after insert or update or delete on invoice_lines
  for each row execute function touch_invoice_from_line();

create table payments (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references invoices(id),
  amount      numeric(12,2) not null check (amount > 0),
  received_on date not null,
  method      text not null check (method in ('BANK_TRANSFER','CARD','CASH','CHEQUE','OTHER')),
  source      text not null default 'MANUAL' check (source in ('MANUAL','XERO')),
  reference   text,
  created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Field records: documents, photos, site notes
-- -----------------------------------------------------------------------------

create table documents (
  id                uuid primary key default gen_random_uuid(),
  document_type     text not null check (document_type in (
                      'PHOTO_BEFORE','PHOTO_DURING','PHOTO_AFTER','COMPLIANCE_CERTIFICATE','SWMS',
                      'QUOTE_PDF','SUPPLIER_QUOTE','PO_PDF','INVOICE_PDF','PLAN','OTHER')),
  title             text not null,
  file_name         text not null,
  mime_type         text not null,
  size_bytes        bigint check (size_bytes >= 0),
  sha256            text check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_provider  text not null check (storage_provider in ('GOOGLE_DRIVE','SUPABASE_STORAGE','MOCK')),
  storage_ref       text not null,                            -- Drive file id / storage path
  captured_at       timestamptz,
  uploaded_by       uuid references employees(id),
  project_id        uuid references projects(id),
  job_id            uuid references jobs(id),
  quote_id          uuid references quotes(id),
  purchase_order_id uuid references purchase_orders(id),
  supplier_quote_id uuid references supplier_quotes(id),
  invoice_id        uuid references invoices(id),
  created_at        timestamptz not null default now(),
  -- explicit nullable FKs instead of a polymorphic (entity_type, entity_id) pair,
  -- so every attachment is referentially checked
  check (num_nonnulls(project_id, job_id, quote_id, purchase_order_id, supplier_quote_id, invoice_id) >= 1)
);
create index documents_project_idx on documents (project_id, document_type);

alter table project_checklist_items add foreign key (evidence_document_id) references documents(id);
alter table supplier_quotes add foreign key (source_document_id) references documents(id);

create table site_notes (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  job_id     uuid,
  author_id  uuid references employees(id),
  note_type  text not null default 'GENERAL' check (note_type in ('GENERAL','SAFETY','WEATHER','ACCESS','DEFECT','VARIATION','MATERIALS')),
  body       text not null check (length(body) between 1 and 5000),
  created_at timestamptz not null default now(),
  foreign key (job_id, project_id) references jobs (id, project_id)   -- note's job must belong to the note's project
);

-- -----------------------------------------------------------------------------
-- Integration identity. External systems are keyed by their own IDs, never by names.
-- -----------------------------------------------------------------------------

create table external_links (
  id             uuid primary key default gen_random_uuid(),
  provider       text not null check (provider in ('XERO','GOOGLE_DRIVE','AIRTABLE','GMAIL','N8N')),
  is_mock        boolean not null,                            -- every link says whether it came from a mock provider
  entity_type    text not null,                               -- 'invoice','customer','project',...
  entity_id      uuid not null,
  external_type  text not null,                               -- 'Invoice','Contact','Folder','Record'
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

-- Operational/debug event log. One row per event_id; a duplicate *delivery* is
-- recorded as its own event (webhook.duplicate_ignored) with causation_id -> original.
create table automation_events (
  event_id           uuid primary key,
  correlation_id     uuid not null,
  causation_id       uuid,
  event_type         text not null check (event_type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  entity_type        text,
  entity_id          uuid,
  business_reference text,                                   -- Q-2026-0042 etc., for humans
  actor_type         text not null check (actor_type in ('USER','SYSTEM','AI','INTEGRATION','WORKFLOW')),
  actor_id           text,
  source             text not null,                          -- 'roofops-web','n8n','xero-webhook','seed'
  workflow_version   text,
  occurred_at        timestamptz not null,
  recorded_at        timestamptz not null default now(),
  status             text not null check (status in ('RECEIVED','SUCCEEDED','FAILED','DUPLICATE_IGNORED','REJECTED','INFO')),
  external_reference text,
  error_class        text,
  metadata           jsonb not null default '{}'::jsonb,
  payload            jsonb,
  check (status <> 'FAILED' or error_class is not null)
);
create index automation_events_correlation_idx on automation_events (correlation_id, occurred_at);
create index automation_events_entity_idx on automation_events (entity_type, entity_id, occurred_at);
create index automation_events_type_idx on automation_events (event_type, occurred_at desc);

-- Idempotency ledger. Claimed with INSERT ... ON CONFLICT DO NOTHING; the
-- winner holds a lease, losers read the stored outcome. request_hash detects
-- "same key, different payload" (rejected, like Xero does).
create table processed_events (
  consumer         text not null,                            -- 'quote_to_project@v1'
  idempotency_key  text not null,                            -- 'quote.accepted:<quote_id>:v<version>'
  first_event_id   uuid not null,
  request_hash     text not null,
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
  check (status <> 'PROCESSING' or lease_expires_at is not null)
);

create table workflow_runs (
  id                 uuid primary key default gen_random_uuid(),
  workflow_key       text not null,                          -- 'quote_to_project'
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
  last_error_class   text,
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
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references workflow_runs(id) on delete cascade,
  attempt       integer not null check (attempt >= 1),
  seq           integer not null,
  step_key      text not null,                               -- 'validate_schema','create_project',...
  status        text not null check (status in ('STARTED','SUCCEEDED','FAILED','SKIPPED')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  http_status   integer,
  error_class   text,
  retry_delay_ms integer,                                    -- what the backoff policy decided
  detail        jsonb not null default '{}'::jsonb,
  unique (run_id, attempt, seq)
);

create table workflow_exceptions (
  id                 uuid primary key default gen_random_uuid(),
  exception_number   text not null unique,                   -- EXC-2026-0001
  workflow_run_id    uuid references workflow_runs(id),
  event_id           uuid references automation_events(event_id),
  workflow_key       text not null,
  entity_type        text,
  entity_id          uuid,
  business_reference text,
  error_class        text not null check (error_class in (
                       'VALIDATION_ERROR','NOT_FOUND','INVALID_STATE','PERMISSION_DENIED','CONFLICT',
                       'RATE_LIMITED','UPSTREAM_5XX','TIMEOUT','NETWORK','SERVICE_UNAVAILABLE',
                       'AMBIGUOUS_WRITE','UNKNOWN')),
  error_message      text not null,
  retryable          boolean not null,
  attempt_count      integer not null check (attempt_count >= 0),
  first_failed_at    timestamptz not null default now(),
  last_attempt_at    timestamptz not null default now(),
  resolution_status  text not null default 'OPEN' check (resolution_status in ('OPEN','RETRY_QUEUED','RESOLVED','IGNORED')),
  resolved_by        uuid references employees(id),
  resolved_at        timestamptz,
  resolution_note    text,
  created_at         timestamptz not null default now(),
  check ((resolution_status in ('RESOLVED','IGNORED')) = (resolved_by is not null and resolved_at is not null)),
  check (resolution_status <> 'IGNORED' or resolution_note is not null)
);
-- At most one live exception per run: pressing RETRY twice cannot fork the queue.
create unique index workflow_exceptions_one_open_per_run
  on workflow_exceptions (workflow_run_id) where resolution_status in ('OPEN','RETRY_QUEUED');

-- Transactional outbox: side effects (Drive folder, PM notification, Xero push)
-- are written in the same transaction as the business change and dispatched
-- afterwards, each with its own idempotency key.
create table outbox (
  id               uuid primary key default gen_random_uuid(),
  topic            text not null,                            -- 'drive.create_project_folder'
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
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null,
  employee_id       uuid not null references employees(id),   -- the human the AI is acting for
  provider          text not null,                            -- 'anthropic','openai','mock'
  model             text,
  tool_name         text not null,
  tier              text not null check (tier in ('GREEN','AMBER','RED')),
  input             jsonb not null,
  decision          text not null check (decision in (
                      'EXECUTED','DRAFT_CREATED','APPROVAL_REQUESTED','DENIED_PERMISSION',
                      'INVALID_INPUT','UNKNOWN_TOOL','ERROR')),
  result_summary    jsonb,
  approval_id       uuid,
  latency_ms        integer,
  created_at        timestamptz not null default now()
);
create index ai_tool_invocations_conversation_idx on ai_tool_invocations (conversation_id, created_at);

create table ai_drafts (
  id                  uuid primary key default gen_random_uuid(),
  draft_type          text not null check (draft_type in ('SUPPLIER_EMAIL','CUSTOMER_MESSAGE','PROJECT_SUMMARY','PURCHASE_ORDER')),
  project_id          uuid references projects(id),
  purchase_order_id   uuid references purchase_orders(id),
  content             jsonb not null,
  status              text not null default 'DRAFT' check (status in ('DRAFT','DISCARDED','PROMOTED')),
  invocation_id       uuid references ai_tool_invocations(id),
  created_for         uuid not null references employees(id),
  created_at          timestamptz not null default now()
);

create table approvals (
  id                       uuid primary key default gen_random_uuid(),
  approval_number          text not null unique,              -- APR-2026-0001
  action_type              text not null check (action_type in (
                             'SEND_PURCHASE_ORDER','APPROVE_PURCHASE_ORDER','CREATE_INVOICE',
                             'SYNC_INVOICE_TO_XERO','CANCEL_PROJECT','CHANGE_APPROVED_MATERIALS')),
  entity_type              text not null,
  entity_id                uuid not null,
  business_reference       text,
  requested_by_actor_type  text not null check (requested_by_actor_type in ('USER','AI','WORKFLOW')),
  requested_by_employee_id uuid references employees(id),     -- for AI: the user the AI was acting for
  requested_via_invocation_id uuid references ai_tool_invocations(id),
  required_permission      text not null,
  action_payload           jsonb not null,                    -- validated, structured - never free text
  payload_hash             text not null,                     -- approver approves THIS exact payload
  expected_record_version  integer not null,                  -- stale if the target changed since request
  idempotency_key          text not null unique,
  status                   text not null default 'PENDING' check (status in (
                             'PENDING','APPROVED','REJECTED','EXPIRED','EXECUTING','EXECUTED','EXECUTION_FAILED','CANCELLED')),
  decided_by               uuid references employees(id),
  decided_at               timestamptz,
  decision_reason          text,
  expires_at               timestamptz not null,
  executed_at              timestamptz,
  execution_result         jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  record_version           integer not null default 1,
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
  on_behalf_of       uuid references employees(id),           -- AI/workflow acting for a person
  action             text not null,                           -- 'project.create','po.approve','invoice.sync'
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

-- Hash chain: each row commits to the previous row. The advisory lock serialises
-- audit inserts so concurrent writers cannot fork the chain (fine at SMB volume;
-- revisit if audit write rate becomes a bottleneck).
create or replace function audit_events_chain() returns trigger language plpgsql as $$
declare v_prev text;
begin
  perform pg_advisory_xact_lock(hashtext('audit_events_chain'));
  select row_hash into v_prev from audit_events order by seq desc limit 1;
  new.prev_hash := v_prev;
  new.row_hash := encode(sha256(convert_to(
    coalesce(v_prev,'') || '|' || new.audit_id || '|' || new.occurred_at || '|' || new.actor_type || '|' ||
    new.actor_id || '|' || new.action || '|' || new.entity_type || '|' || new.entity_id || '|' ||
    coalesce(new.before_state::text,'') || '|' || coalesce(new.after_state::text,'') || '|' ||
    coalesce(new.approval_id::text,'') || '|' || coalesce(new.external_reference,''), 'UTF8')), 'hex');
  return new;
end $$;
create trigger audit_events_chain before insert on audit_events
  for each row execute function audit_events_chain();

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
  -- Supabase-specific roles only exist on Supabase; skip cleanly elsewhere (PGlite/CI).
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;
