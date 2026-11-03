-- =============================================================================
-- Amazon Sales & Profit Intelligence: core model, permissions, ingestion
--
-- Reuses: products (mapping, standard cost, GST rate), inventory_balances (ERP
-- stock), roles/permissions, audit_logs, notifications, error_events.
-- No ERP product, stock, order, invoice or payment table is duplicated, and no
-- Amazon figure is written into ERP financial or stock tables.
--
-- Data provenance: every Amazon fact row carries data_source (API / CSV /
-- MANUAL / DEMO), is_demo and the sync job that wrote it. Demo rows are never
-- read by live analytics (every analytics function filters on is_demo).
--
-- Secrets: none in the database. Amazon client ids, client secrets and refresh
-- tokens live in Supabase Edge Function secrets; the tables below hold only
-- connection status and diagnostics.
--
-- Writes: only through SECURITY DEFINER functions (permission checked) or the
-- service-role functions used by the Edge Functions. Clients cannot write the
-- tables directly.
-- =============================================================================

insert into public.permissions (resource, action, description) values
  ('amazon', 'read', 'View Amazon sales, advertising, profitability and inventory analytics'),
  ('amazon', 'manage', 'Map Amazon listings to products, maintain costs, import reports, manage demo data, budget plans and recommendations'),
  ('amazon_ads', 'request', 'Propose Amazon advertising changes (budgets, bids, targets) for approval'),
  ('amazon_ads', 'approve', 'Approve or reject Amazon advertising changes; set spending limits and the kill switch'),
  ('amazon_integration', 'manage', 'Configure Amazon API connections and run synchronisations')
on conflict (code) do nothing;

with matrix (role_code, permission_code) as (
  values
    ('ADMIN', 'amazon.read'), ('ADMIN', 'amazon.manage'), ('ADMIN', 'amazon_ads.request'), ('ADMIN', 'amazon_ads.approve'), ('ADMIN', 'amazon_integration.manage'),
    ('SALES_MANAGER', 'amazon.read'), ('SALES_MANAGER', 'amazon.manage'), ('SALES_MANAGER', 'amazon_ads.request'),
    ('ACCOUNTS_MANAGER', 'amazon.read'), ('INVENTORY_MANAGER', 'amazon.read'), ('MANAGEMENT_VIEWER', 'amazon.read')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from matrix m join public.roles r on r.code = m.role_code join public.permissions p on p.code = m.permission_code
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p where r.code = 'SUPER_ADMIN'
on conflict do nothing;

-- Fast RLS helper: true when the caller's (single) active company is p_company and holds p_perm.
create or replace function private.amazon_can(p_company uuid, p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_company = private.current_company_id() and private.has_permission(p_company, p_perm)
$$;
revoke all on function private.amazon_can(uuid, text) from public, anon;
grant execute on function private.amazon_can(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Settings (one row per company) and connections (one row per company and API)
-- -----------------------------------------------------------------------------
create table if not exists public.amazon_settings (
  company_id                 uuid primary key references public.companies (id) on delete restrict,
  prices_include_gst         boolean not null default true,
  attribution_window_days    integer not null default 7 check (attribution_window_days in (1, 7, 14, 30)),
  min_clicks_for_decision    integer not null default 20 check (min_clicks_for_decision between 1 and 10000),
  min_orders_for_scaling     integer not null default 3 check (min_orders_for_scaling between 1 and 1000),
  wasted_spend_threshold     numeric(12,2) not null default 500 check (wasted_spend_threshold >= 0),
  low_stock_cover_days       integer not null default 14 check (low_stock_cover_days between 1 and 365),
  overstock_cover_days       integer not null default 120 check (overstock_cover_days between 7 and 1000),
  target_contribution_pct    numeric(5,2) not null default 10 check (target_contribution_pct between 0 and 90),
  overhead_allocation_pct    numeric(5,2) not null default 0 check (overhead_allocation_pct between 0 and 90),
  automation_mode            text not null default 'READ_ONLY' check (automation_mode in ('READ_ONLY', 'APPROVAL_REQUIRED')),
  kill_switch                boolean not null default true,
  max_daily_budget           numeric(12,2) check (max_daily_budget is null or max_daily_budget > 0),
  max_monthly_budget         numeric(14,2) check (max_monthly_budget is null or max_monthly_budget > 0),
  max_bid                    numeric(10,2) check (max_bid is null or max_bid > 0),
  max_bid_change_pct         numeric(5,2) not null default 30 check (max_bid_change_pct between 1 and 300),
  max_budget_change_pct      numeric(5,2) not null default 30 check (max_budget_change_pct between 1 and 300),
  updated_by                 uuid,
  updated_at                 timestamptz not null default now()
);

create table if not exists public.amazon_connections (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies (id) on delete restrict,
  api                      text not null check (api in ('SP_API', 'ADS_API')),
  status                   text not null default 'NOT_CONFIGURED'
                           check (status in ('NOT_CONFIGURED', 'CONFIGURED', 'CONNECTED', 'ERROR', 'DISCONNECTED')),
  account_identifier       text check (account_identifier is null or length(account_identifier) <= 100),
  account_name             text check (account_name is null or length(account_name) <= 200),
  region                   text check (region is null or region in ('NA', 'EU', 'FE')),
  marketplace_ids          text[] not null default '{}',
  profile_id               text check (profile_id is null or length(profile_id) <= 40),
  permissions              jsonb not null default '[]'::jsonb,
  last_test_at             timestamptz,
  last_test_ok             boolean,
  last_test_message        text check (last_test_message is null or length(last_test_message) <= 1000),
  last_successful_sync_at  timestamptz,
  last_error_at            timestamptz,
  last_error_message       text check (last_error_message is null or length(last_error_message) <= 1000),
  updated_at               timestamptz not null default now(),
  constraint amazon_connections_unique unique (company_id, api)
);

create or replace function private.amazon_company_defaults() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.amazon_settings (company_id) values (new.id) on conflict do nothing;
  insert into public.amazon_connections (company_id, api) values (new.id, 'SP_API'), (new.id, 'ADS_API') on conflict do nothing;
  return new;
end $$;
drop trigger if exists companies_amazon_defaults on public.companies;
create trigger companies_amazon_defaults after insert on public.companies for each row execute function private.amazon_company_defaults();
insert into public.amazon_settings (company_id) select id from public.companies on conflict do nothing;
insert into public.amazon_connections (company_id, api) select c.id, a.api from public.companies c cross join (values ('SP_API'), ('ADS_API')) a(api) on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Listings = product mapping (Amazon seller SKU / ASIN <-> ERP product) and the
-- per-unit economics used for estimates when actual fees are not yet synced.
-- -----------------------------------------------------------------------------
create table if not exists public.amazon_listings (
  id                             uuid primary key default gen_random_uuid(),
  company_id                     uuid not null references public.companies (id) on delete restrict,
  marketplace_id                 text not null default 'A21TJRUUN4KGV' check (marketplace_id ~ '^[A-Z0-9]{8,20}$'),
  seller_sku                     text not null check (length(btrim(seller_sku)) between 1 and 80),
  asin                           text check (asin is null or asin ~ '^[A-Z0-9]{10}$'),
  title                          text check (title is null or length(title) <= 500),
  product_id                     uuid,
  listing_status                 text check (listing_status is null or length(listing_status) <= 40),
  item_price                     numeric(12,2) check (item_price is null or item_price >= 0),
  currency                       text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  fulfillment_channel            text check (fulfillment_channel is null or fulfillment_channel in ('FBA', 'MFN')),
  referral_fee_pct               numeric(5,2) check (referral_fee_pct is null or referral_fee_pct between 0 and 100),
  closing_fee_per_unit           numeric(10,2) check (closing_fee_per_unit is null or closing_fee_per_unit >= 0),
  fulfilment_fee_per_unit        numeric(10,2) check (fulfilment_fee_per_unit is null or fulfilment_fee_per_unit >= 0),
  shipping_cost_per_unit         numeric(10,2) check (shipping_cost_per_unit is null or shipping_cost_per_unit >= 0),
  other_variable_cost_per_unit   numeric(10,2) check (other_variable_cost_per_unit is null or other_variable_cost_per_unit >= 0),
  gst_rate                       numeric(5,2) check (gst_rate is null or gst_rate between 0 and 40),
  unit_cost_override             numeric(12,2) check (unit_cost_override is null or unit_cost_override >= 0),
  cost_note                      text check (cost_note is null or length(cost_note) <= 500),
  costs_updated_at               timestamptz,
  desired_contribution_per_unit  numeric(12,2) check (desired_contribution_per_unit is null or desired_contribution_per_unit >= 0),
  target_acos_pct                numeric(5,2) check (target_acos_pct is null or target_acos_pct between 0 and 100),
  min_stock                      numeric(12,3) check (min_stock is null or min_stock >= 0),
  lead_time_days                 integer check (lead_time_days is null or lead_time_days between 0 and 365),
  advertising_status             text not null default 'UNKNOWN' check (advertising_status in ('ADVERTISED', 'NOT_ADVERTISED', 'PAUSED', 'UNKNOWN')),
  data_source                    text not null default 'MANUAL' check (data_source in ('API', 'CSV', 'MANUAL', 'DEMO')),
  is_demo                        boolean not null default false,
  last_synced_at                 timestamptz,
  created_by                     uuid,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  constraint amazon_listings_sku_unique unique (company_id, marketplace_id, seller_sku),
  constraint amazon_listings_id_company_unique unique (id, company_id),
  constraint amazon_listings_product_fk foreign key (product_id, company_id) references public.products (id, company_id) on delete restrict,
  constraint amazon_listings_demo_source check (is_demo = (data_source = 'DEMO')),
  constraint amazon_listings_demo_unmapped check (not is_demo or product_id is null)
);
create index if not exists amazon_listings_product_idx on public.amazon_listings (company_id, product_id);
create index if not exists amazon_listings_asin_idx on public.amazon_listings (company_id, marketplace_id, asin);

-- One ASIN in one marketplace is one product: several seller SKUs (e.g. FBA and
-- merchant-fulfilled) may share an ASIN, but never map it to different products.
create or replace function private.amazon_listings_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.asin is not null and new.product_id is not null and exists (
    select 1 from public.amazon_listings l where l.company_id = new.company_id and l.marketplace_id = new.marketplace_id and l.asin = new.asin
      and l.id <> new.id and l.product_id is not null and l.product_id <> new.product_id) then
    raise exception 'ASIN % is already mapped to a different ERP product in this marketplace.', new.asin using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists amazon_listings_guard on public.amazon_listings;
create trigger amazon_listings_guard before insert or update on public.amazon_listings for each row execute function private.amazon_listings_guard();

-- -----------------------------------------------------------------------------
-- Facts (one row per natural key; re-imports update in place = idempotent)
-- -----------------------------------------------------------------------------
create table if not exists public.amazon_sync_jobs (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete restrict,
  api              text not null check (api in ('SP_API', 'ADS_API', 'CSV', 'DEMO')),
  job_type         text not null check (length(job_type) between 2 and 60),
  status           text not null default 'RUNNING' check (status in ('RUNNING', 'WAITING_REPORT', 'SUCCEEDED', 'PARTIAL', 'FAILED')),
  idempotency_key  uuid,
  file_name        text check (file_name is null or length(file_name) <= 255),
  date_from        date,
  date_to          date,
  rows_received    integer not null default 0,
  rows_inserted    integer not null default 0,
  rows_updated     integer not null default 0,
  rows_skipped     integer not null default 0,
  state            jsonb not null default '{}'::jsonb,
  error_code       text check (error_code is null or length(error_code) <= 100),
  error_message    text check (error_message is null or length(error_message) <= 2000),
  requested_by     uuid,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  constraint amazon_sync_jobs_key_unique unique (company_id, idempotency_key)
);
create index if not exists amazon_sync_jobs_company_idx on public.amazon_sync_jobs (company_id, started_at desc);

create table if not exists public.amazon_sync_errors (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete restrict,
  job_id       uuid references public.amazon_sync_jobs (id) on delete cascade,
  api          text not null,
  operation    text not null check (length(operation) <= 120),
  http_status  integer,
  error_code   text check (error_code is null or length(error_code) <= 100),
  message      text not null check (length(message) <= 2000),
  retryable    boolean not null default false,
  attempt      integer not null default 1,
  occurred_at  timestamptz not null default now()
);
create index if not exists amazon_sync_errors_company_idx on public.amazon_sync_errors (company_id, occurred_at desc);

create table if not exists public.amazon_sku_daily (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  marketplace_id       text not null,
  seller_sku           text not null,
  asin                 text,
  metric_date          date not null,
  ordered_sales        numeric(14,2),
  units_ordered        integer check (units_ordered is null or units_ordered >= 0),
  total_order_items    integer check (total_order_items is null or total_order_items >= 0),
  sessions             integer check (sessions is null or sessions >= 0),
  page_views           integer check (page_views is null or page_views >= 0),
  refund_amount        numeric(14,2) check (refund_amount is null or refund_amount >= 0),
  refunded_units       integer check (refunded_units is null or refunded_units >= 0),
  promotion_discounts  numeric(14,2) check (promotion_discounts is null or promotion_discounts >= 0),
  referral_fees        numeric(14,2) check (referral_fees is null or referral_fees >= 0),
  fulfilment_fees      numeric(14,2) check (fulfilment_fees is null or fulfilment_fees >= 0),
  other_fees           numeric(14,2) check (other_fees is null or other_fees >= 0),
  data_source          text not null check (data_source in ('API', 'CSV', 'MANUAL', 'DEMO')),
  fees_source          text check (fees_source is null or fees_source in ('API', 'CSV', 'DEMO')),
  is_demo              boolean not null default false,
  sync_job_id          uuid references public.amazon_sync_jobs (id) on delete set null,
  updated_at           timestamptz not null default now(),
  constraint amazon_sku_daily_unique unique (company_id, marketplace_id, seller_sku, metric_date, is_demo)
);
create index if not exists amazon_sku_daily_date_idx on public.amazon_sku_daily (company_id, is_demo, metric_date);

create table if not exists public.amazon_inventory_snapshots (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id) on delete restrict,
  marketplace_id     text not null,
  seller_sku         text not null,
  asin               text,
  snapshot_at        timestamptz not null,
  fulfillable_qty    integer not null check (fulfillable_qty >= 0),
  inbound_qty        integer check (inbound_qty is null or inbound_qty >= 0),
  reserved_qty       integer check (reserved_qty is null or reserved_qty >= 0),
  unfulfillable_qty  integer check (unfulfillable_qty is null or unfulfillable_qty >= 0),
  data_source        text not null check (data_source in ('API', 'CSV', 'DEMO')),
  is_demo            boolean not null default false,
  sync_job_id        uuid references public.amazon_sync_jobs (id) on delete set null,
  constraint amazon_inventory_snapshots_unique unique (company_id, marketplace_id, seller_sku, snapshot_at, is_demo)
);
create index if not exists amazon_inventory_latest_idx on public.amazon_inventory_snapshots (company_id, is_demo, seller_sku, snapshot_at desc);

create table if not exists public.amazon_campaigns (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete restrict,
  profile_id      text not null,
  campaign_id     text not null check (length(campaign_id) between 1 and 40),
  name            text not null check (length(name) between 1 and 300),
  ad_product      text not null default 'SPONSORED_PRODUCTS' check (ad_product in ('SPONSORED_PRODUCTS', 'SPONSORED_BRANDS', 'SPONSORED_DISPLAY')),
  targeting_type  text check (targeting_type is null or targeting_type in ('AUTO', 'MANUAL')),
  state           text not null default 'ENABLED' check (state in ('ENABLED', 'PAUSED', 'ARCHIVED')),
  daily_budget    numeric(12,2) check (daily_budget is null or daily_budget >= 0),
  portfolio_id    text,
  start_date      date,
  end_date        date,
  data_source     text not null check (data_source in ('API', 'CSV', 'DEMO')),
  is_demo         boolean not null default false,
  last_synced_at  timestamptz,
  updated_at      timestamptz not null default now(),
  constraint amazon_campaigns_unique unique (company_id, profile_id, campaign_id)
);

create table if not exists public.amazon_ad_groups (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete restrict,
  profile_id      text not null,
  campaign_id     text not null,
  ad_group_id     text not null,
  name            text not null,
  state           text not null default 'ENABLED',
  default_bid     numeric(10,2),
  data_source     text not null check (data_source in ('API', 'CSV', 'DEMO')),
  is_demo         boolean not null default false,
  last_synced_at  timestamptz,
  constraint amazon_ad_groups_unique unique (company_id, profile_id, ad_group_id)
);

create table if not exists public.amazon_targets (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete restrict,
  profile_id      text not null,
  campaign_id     text not null,
  ad_group_id     text,
  target_id       text not null,
  target_type     text not null check (target_type in ('KEYWORD', 'PRODUCT', 'AUTO', 'NEGATIVE_KEYWORD', 'NEGATIVE_PRODUCT')),
  expression      text not null check (length(expression) between 1 and 500),
  match_type      text check (match_type is null or match_type in ('EXACT', 'PHRASE', 'BROAD', 'NEGATIVE_EXACT', 'NEGATIVE_PHRASE', 'TARGETING_EXPRESSION')),
  state           text not null default 'ENABLED',
  bid             numeric(10,2),
  data_source     text not null check (data_source in ('API', 'CSV', 'DEMO')),
  is_demo         boolean not null default false,
  last_synced_at  timestamptz,
  constraint amazon_targets_unique unique (company_id, profile_id, target_id)
);

create table if not exists public.amazon_campaign_daily (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete restrict,
  profile_id   text not null,
  campaign_id  text not null,
  metric_date  date not null,
  impressions  bigint not null default 0 check (impressions >= 0),
  clicks       bigint not null default 0 check (clicks >= 0),
  spend        numeric(14,2) not null default 0 check (spend >= 0),
  sales        numeric(14,2) not null default 0 check (sales >= 0),
  orders       integer not null default 0 check (orders >= 0),
  units        integer not null default 0 check (units >= 0),
  budget       numeric(12,2) check (budget is null or budget >= 0),
  data_source  text not null check (data_source in ('API', 'CSV', 'DEMO')),
  is_demo      boolean not null default false,
  sync_job_id  uuid references public.amazon_sync_jobs (id) on delete set null,
  constraint amazon_campaign_daily_unique unique (company_id, profile_id, campaign_id, metric_date)
);
create index if not exists amazon_campaign_daily_date_idx on public.amazon_campaign_daily (company_id, is_demo, metric_date);

create table if not exists public.amazon_ad_product_daily (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete restrict,
  profile_id   text not null,
  campaign_id  text not null,
  ad_group_id  text not null,
  seller_sku   text not null,
  asin         text,
  metric_date  date not null,
  impressions  bigint not null default 0 check (impressions >= 0),
  clicks       bigint not null default 0 check (clicks >= 0),
  spend        numeric(14,2) not null default 0 check (spend >= 0),
  sales        numeric(14,2) not null default 0 check (sales >= 0),
  orders       integer not null default 0 check (orders >= 0),
  units        integer not null default 0 check (units >= 0),
  data_source  text not null check (data_source in ('API', 'CSV', 'DEMO')),
  is_demo      boolean not null default false,
  sync_job_id  uuid references public.amazon_sync_jobs (id) on delete set null,
  constraint amazon_ad_product_daily_unique unique (company_id, profile_id, campaign_id, ad_group_id, seller_sku, metric_date)
);
create index if not exists amazon_ad_product_daily_sku_idx on public.amazon_ad_product_daily (company_id, is_demo, seller_sku, metric_date);

create table if not exists public.amazon_search_term_daily (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete restrict,
  profile_id   text not null,
  campaign_id  text not null,
  ad_group_id  text not null,
  target_id    text,
  targeting    text not null check (length(targeting) between 1 and 500),
  match_type   text,
  search_term  text not null check (length(search_term) between 1 and 500),
  metric_date  date not null,
  impressions  bigint not null default 0 check (impressions >= 0),
  clicks       bigint not null default 0 check (clicks >= 0),
  spend        numeric(14,2) not null default 0 check (spend >= 0),
  sales        numeric(14,2) not null default 0 check (sales >= 0),
  orders       integer not null default 0 check (orders >= 0),
  units        integer not null default 0 check (units >= 0),
  row_key      text not null,
  data_source  text not null check (data_source in ('API', 'CSV', 'DEMO')),
  is_demo      boolean not null default false,
  sync_job_id  uuid references public.amazon_sync_jobs (id) on delete set null,
  constraint amazon_search_term_daily_unique unique (company_id, row_key)
);
create index if not exists amazon_search_term_daily_date_idx on public.amazon_search_term_daily (company_id, is_demo, metric_date);

-- -----------------------------------------------------------------------------
-- RLS: read with amazon.read; no direct client writes.
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['amazon_settings', 'amazon_connections', 'amazon_listings', 'amazon_sync_jobs', 'amazon_sync_errors', 'amazon_sku_daily',
    'amazon_inventory_snapshots', 'amazon_campaigns', 'amazon_ad_groups', 'amazon_targets', 'amazon_campaign_daily', 'amazon_ad_product_daily', 'amazon_search_term_daily'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (company_id = (select private.current_company_id()) and (select private.amazon_can(private.current_company_id(), ''amazon.read'')))', t || '_select', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Ingestion (shared by CSV imports and the Edge Functions). Validates every row,
-- de-duplicates within the payload, upserts on the natural key and reports
-- received / inserted / updated / skipped counts. Re-running the same data
-- updates rows in place; it never creates duplicates.
-- -----------------------------------------------------------------------------
create or replace function private.amazon_num(p jsonb, k text) returns numeric language sql immutable set search_path = '' as $$
  select case when p ? k and jsonb_typeof(p -> k) in ('number', 'string') and nullif(btrim(p ->> k), '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (p ->> k)::numeric end
$$;
create or replace function private.amazon_date(p jsonb, k text) returns date language plpgsql immutable set search_path = '' as $$
begin
  if not (p ? k) or nullif(btrim(p ->> k), '') is null then return null; end if;
  return (p ->> k)::date;
exception when others then return null;
end $$;

create or replace function private.amazon_ingest(p_company uuid, p_kind text, p_rows jsonb, p_source text, p_job uuid, p_demo boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_received int := coalesce(jsonb_array_length(p_rows), 0);
  v_valid jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_row jsonb;
  v_idx int := 0;
  v_problem text;
  v_ins int := 0;
  v_upd int := 0;
  v_mp text;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Rows must be a JSON array.' using errcode = 'P0001';
  end if;
  if v_received > 20000 then
    raise exception 'At most 20,000 rows per import (received %).', v_received using errcode = 'P0001';
  end if;
  if p_source not in ('API', 'CSV', 'DEMO') then
    raise exception 'Unknown data source %.', p_source using errcode = 'P0001';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_idx := v_idx + 1;
    v_problem := null;
    if jsonb_typeof(v_row) <> 'object' then v_problem := 'not an object';
    elsif p_kind in ('SKU_SALES', 'SKU_FEES', 'INVENTORY', 'LISTINGS', 'AD_PRODUCT_DAILY') and nullif(btrim(v_row ->> 'seller_sku'), '') is null then v_problem := 'seller_sku is required';
    elsif p_kind in ('SKU_SALES', 'SKU_FEES', 'CAMPAIGN_DAILY', 'AD_PRODUCT_DAILY', 'SEARCH_TERM_DAILY') and private.amazon_date(v_row, 'metric_date') is null then v_problem := 'metric_date is missing or invalid';
    elsif p_kind in ('SKU_SALES', 'SKU_FEES', 'CAMPAIGN_DAILY', 'AD_PRODUCT_DAILY', 'SEARCH_TERM_DAILY') and private.amazon_date(v_row, 'metric_date') > current_date + 1 then v_problem := 'metric_date is in the future';
    elsif p_kind in ('CAMPAIGNS', 'AD_GROUPS', 'TARGETS', 'CAMPAIGN_DAILY', 'AD_PRODUCT_DAILY', 'SEARCH_TERM_DAILY') and nullif(btrim(v_row ->> 'campaign_id'), '') is null then v_problem := 'campaign_id is required';
    elsif p_kind = 'CAMPAIGNS' and nullif(btrim(v_row ->> 'name'), '') is null then v_problem := 'campaign name is required';
    elsif p_kind in ('AD_GROUPS', 'AD_PRODUCT_DAILY', 'SEARCH_TERM_DAILY') and nullif(btrim(v_row ->> 'ad_group_id'), '') is null then v_problem := 'ad_group_id is required';
    elsif p_kind = 'TARGETS' and (nullif(btrim(v_row ->> 'target_id'), '') is null or nullif(btrim(v_row ->> 'expression'), '') is null) then v_problem := 'target_id and expression are required';
    elsif p_kind = 'SEARCH_TERM_DAILY' and (nullif(btrim(v_row ->> 'search_term'), '') is null or nullif(btrim(v_row ->> 'targeting'), '') is null) then v_problem := 'search_term and targeting are required';
    elsif p_kind = 'INVENTORY' and (private.amazon_num(v_row, 'fulfillable_qty') is null or private.amazon_num(v_row, 'fulfillable_qty') < 0) then v_problem := 'fulfillable_qty must be a number >= 0';
    elsif p_kind = 'LISTINGS' and nullif(v_row ->> 'asin', '') is not null and (v_row ->> 'asin') !~ '^[A-Z0-9]{10}$' then v_problem := 'ASIN must be 10 letters/digits';
    elsif exists (select 1 from jsonb_each(v_row) e where e.key in ('ordered_sales', 'spend', 'sales', 'impressions', 'clicks', 'orders', 'units', 'units_ordered', 'refund_amount',
                 'referral_fees', 'fulfilment_fees', 'other_fees', 'promotion_discounts', 'sessions', 'page_views', 'daily_budget', 'bid')
                 and jsonb_typeof(e.value) <> 'null' and (private.amazon_num(v_row, e.key) is null or (private.amazon_num(v_row, e.key) < 0 and e.key <> 'ordered_sales'))) then
      v_problem := 'a numeric field is not a valid non-negative number';
    end if;
    if v_problem is null then
      v_valid := v_valid || v_row;
    elsif jsonb_array_length(v_errors) < 50 then
      v_errors := v_errors || jsonb_build_object('row', v_idx, 'message', v_problem);
    end if;
  end loop;

  v_mp := 'A21TJRUUN4KGV';
  if p_kind = 'LISTINGS' then
    with src as (
      select distinct on (coalesce(r ->> 'marketplace_id', v_mp), btrim(r ->> 'seller_sku')) r from jsonb_array_elements(v_valid) r
      order by coalesce(r ->> 'marketplace_id', v_mp), btrim(r ->> 'seller_sku')),
    up as (
      insert into public.amazon_listings as l (company_id, marketplace_id, seller_sku, asin, title, listing_status, item_price, currency, fulfillment_channel, data_source, is_demo, last_synced_at)
      select p_company, coalesce(r ->> 'marketplace_id', v_mp), btrim(r ->> 'seller_sku'), nullif(r ->> 'asin', ''), left(r ->> 'title', 500), left(r ->> 'listing_status', 40),
        private.amazon_num(r, 'item_price'), coalesce(nullif(r ->> 'currency', ''), 'INR'),
        case when upper(r ->> 'fulfillment_channel') in ('FBA', 'AFN', 'AMAZON_IN', 'AMAZON_NA', 'AMAZON_EU') then 'FBA' when nullif(r ->> 'fulfillment_channel', '') is not null then 'MFN' end,
        case when p_demo then 'DEMO' else p_source end, p_demo, now()
      from src
      on conflict (company_id, marketplace_id, seller_sku) do update set
        asin = coalesce(excluded.asin, l.asin), title = coalesce(excluded.title, l.title), listing_status = coalesce(excluded.listing_status, l.listing_status),
        item_price = coalesce(excluded.item_price, l.item_price), fulfillment_channel = coalesce(excluded.fulfillment_channel, l.fulfillment_channel),
        last_synced_at = now()
      where l.is_demo = excluded.is_demo
      returning (xmax = 0) as inserted)
    select count(*) filter (where inserted), count(*) filter (where not inserted) into v_ins, v_upd from up;

  elsif p_kind in ('SKU_SALES', 'SKU_FEES') then
    with src as (
      select distinct on (coalesce(r ->> 'marketplace_id', v_mp), btrim(r ->> 'seller_sku'), private.amazon_date(r, 'metric_date')) r from jsonb_array_elements(v_valid) r
      order by coalesce(r ->> 'marketplace_id', v_mp), btrim(r ->> 'seller_sku'), private.amazon_date(r, 'metric_date')),
    up as (
      insert into public.amazon_sku_daily as d (company_id, marketplace_id, seller_sku, asin, metric_date, ordered_sales, units_ordered, total_order_items, sessions, page_views,
        refund_amount, refunded_units, promotion_discounts, referral_fees, fulfilment_fees, other_fees, data_source, fees_source, is_demo, sync_job_id)
      select p_company, coalesce(r ->> 'marketplace_id', v_mp), btrim(r ->> 'seller_sku'), nullif(r ->> 'asin', ''), private.amazon_date(r, 'metric_date'),
        case when p_kind = 'SKU_SALES' then private.amazon_num(r, 'ordered_sales') end,
        case when p_kind = 'SKU_SALES' then private.amazon_num(r, 'units_ordered')::int end,
        case when p_kind = 'SKU_SALES' then private.amazon_num(r, 'total_order_items')::int end,
        case when p_kind = 'SKU_SALES' then private.amazon_num(r, 'sessions')::int end,
        case when p_kind = 'SKU_SALES' then private.amazon_num(r, 'page_views')::int end,
        case when p_kind = 'SKU_FEES' then private.amazon_num(r, 'refund_amount') end,
        case when p_kind = 'SKU_FEES' then private.amazon_num(r, 'refunded_units')::int end,
        case when p_kind = 'SKU_FEES' then private.amazon_num(r, 'promotion_discounts') end,
        case when p_kind = 'SKU_FEES' then private.amazon_num(r, 'referral_fees') end,
        case when p_kind = 'SKU_FEES' then private.amazon_num(r, 'fulfilment_fees') end,
        case when p_kind = 'SKU_FEES' then private.amazon_num(r, 'other_fees') end,
        case when p_demo then 'DEMO' else p_source end, case when p_kind = 'SKU_FEES' then (case when p_demo then 'DEMO' else p_source end) end, p_demo, p_job
      from src
      on conflict (company_id, marketplace_id, seller_sku, metric_date, is_demo) do update set
        asin = coalesce(excluded.asin, d.asin),
        ordered_sales = case when p_kind = 'SKU_SALES' then excluded.ordered_sales else d.ordered_sales end,
        units_ordered = case when p_kind = 'SKU_SALES' then excluded.units_ordered else d.units_ordered end,
        total_order_items = case when p_kind = 'SKU_SALES' then excluded.total_order_items else d.total_order_items end,
        sessions = case when p_kind = 'SKU_SALES' then excluded.sessions else d.sessions end,
        page_views = case when p_kind = 'SKU_SALES' then excluded.page_views else d.page_views end,
        refund_amount = case when p_kind = 'SKU_FEES' then excluded.refund_amount else d.refund_amount end,
        refunded_units = case when p_kind = 'SKU_FEES' then excluded.refunded_units else d.refunded_units end,
        promotion_discounts = case when p_kind = 'SKU_FEES' then excluded.promotion_discounts else d.promotion_discounts end,
        referral_fees = case when p_kind = 'SKU_FEES' then excluded.referral_fees else d.referral_fees end,
        fulfilment_fees = case when p_kind = 'SKU_FEES' then excluded.fulfilment_fees else d.fulfilment_fees end,
        other_fees = case when p_kind = 'SKU_FEES' then excluded.other_fees else d.other_fees end,
        fees_source = case when p_kind = 'SKU_FEES' then excluded.fees_source else d.fees_source end,
        sync_job_id = excluded.sync_job_id, updated_at = now()
      returning (xmax = 0) as inserted)
    select count(*) filter (where inserted), count(*) filter (where not inserted) into v_ins, v_upd from up;

  elsif p_kind = 'INVENTORY' then
    with src as (
      select distinct on (coalesce(r ->> 'marketplace_id', v_mp), btrim(r ->> 'seller_sku'), coalesce(nullif(r ->> 'snapshot_at', '')::timestamptz, date_trunc('hour', now()))) r
      from jsonb_array_elements(v_valid) r),
    up as (
      insert into public.amazon_inventory_snapshots as s (company_id, marketplace_id, seller_sku, asin, snapshot_at, fulfillable_qty, inbound_qty, reserved_qty, unfulfillable_qty, data_source, is_demo, sync_job_id)
      select p_company, coalesce(r ->> 'marketplace_id', v_mp), btrim(r ->> 'seller_sku'), nullif(r ->> 'asin', ''), coalesce(nullif(r ->> 'snapshot_at', '')::timestamptz, date_trunc('hour', now())),
        private.amazon_num(r, 'fulfillable_qty')::int, private.amazon_num(r, 'inbound_qty')::int, private.amazon_num(r, 'reserved_qty')::int, private.amazon_num(r, 'unfulfillable_qty')::int,
        case when p_demo then 'DEMO' else p_source end, p_demo, p_job
      from src
      on conflict (company_id, marketplace_id, seller_sku, snapshot_at, is_demo) do update set
        fulfillable_qty = excluded.fulfillable_qty, inbound_qty = excluded.inbound_qty, reserved_qty = excluded.reserved_qty, unfulfillable_qty = excluded.unfulfillable_qty, sync_job_id = excluded.sync_job_id
      returning (xmax = 0) as inserted)
    select count(*) filter (where inserted), count(*) filter (where not inserted) into v_ins, v_upd from up;

  elsif p_kind = 'CAMPAIGNS' then
    with src as (select distinct on (coalesce(r ->> 'profile_id', ''), r ->> 'campaign_id') r from jsonb_array_elements(v_valid) r),
    up as (
      insert into public.amazon_campaigns as c (company_id, profile_id, campaign_id, name, ad_product, targeting_type, state, daily_budget, portfolio_id, start_date, end_date, data_source, is_demo, last_synced_at)
      select p_company, coalesce(nullif(r ->> 'profile_id', ''), 'UNKNOWN'), r ->> 'campaign_id', left(r ->> 'name', 300),
        coalesce(nullif(upper(r ->> 'ad_product'), ''), 'SPONSORED_PRODUCTS'), nullif(upper(r ->> 'targeting_type'), ''),
        case upper(coalesce(r ->> 'state', 'ENABLED')) when 'PAUSED' then 'PAUSED' when 'ARCHIVED' then 'ARCHIVED' else 'ENABLED' end,
        private.amazon_num(r, 'daily_budget'), nullif(r ->> 'portfolio_id', ''), private.amazon_date(r, 'start_date'), private.amazon_date(r, 'end_date'),
        case when p_demo then 'DEMO' else p_source end, p_demo, now()
      from src
      on conflict (company_id, profile_id, campaign_id) do update set
        name = excluded.name, ad_product = excluded.ad_product, targeting_type = coalesce(excluded.targeting_type, c.targeting_type), state = excluded.state,
        daily_budget = coalesce(excluded.daily_budget, c.daily_budget), portfolio_id = coalesce(excluded.portfolio_id, c.portfolio_id),
        start_date = coalesce(excluded.start_date, c.start_date), end_date = excluded.end_date, last_synced_at = now(), updated_at = now()
      where c.is_demo = excluded.is_demo
      returning (xmax = 0) as inserted)
    select count(*) filter (where inserted), count(*) filter (where not inserted) into v_ins, v_upd from up;

  elsif p_kind = 'AD_GROUPS' then
    with src as (select distinct on (coalesce(r ->> 'profile_id', ''), r ->> 'ad_group_id') r from jsonb_array_elements(v_valid) r),
    up as (
      insert into public.amazon_ad_groups as g (company_id, profile_id, campaign_id, ad_group_id, name, state, default_bid, data_source, is_demo, last_synced_at)
      select p_company, coalesce(nullif(r ->> 'profile_id', ''), 'UNKNOWN'), r ->> 'campaign_id', r ->> 'ad_group_id', coalesce(left(r ->> 'name', 300), r ->> 'ad_group_id'),
        upper(coalesce(r ->> 'state', 'ENABLED')), private.amazon_num(r, 'default_bid'), case when p_demo then 'DEMO' else p_source end, p_demo, now()
      from src
      on conflict (company_id, profile_id, ad_group_id) do update set name = excluded.name, state = excluded.state, default_bid = coalesce(excluded.default_bid, g.default_bid),
        campaign_id = excluded.campaign_id, last_synced_at = now()
      where g.is_demo = excluded.is_demo
      returning (xmax = 0) as inserted)
    select count(*) filter (where inserted), count(*) filter (where not inserted) into v_ins, v_upd from up;

  elsif p_kind = 'TARGETS' then
    with src as (select distinct on (coalesce(r ->> 'profile_id', ''), r ->> 'target_id') r from jsonb_array_elements(v_valid) r),
    up as (
      insert into public.amazon_targets as t (company_id, profile_id, campaign_id, ad_group_id, target_id, target_type, expression, match_type, state, bid, data_source, is_demo, last_synced_at)
      select p_company, coalesce(nullif(r ->> 'profile_id', ''), 'UNKNOWN'), r ->> 'campaign_id', nullif(r ->> 'ad_group_id', ''), r ->> 'target_id',
        coalesce(nullif(upper(r ->> 'target_type'), ''), 'KEYWORD'), left(r ->> 'expression', 500), nullif(upper(r ->> 'match_type'), ''),
        upper(coalesce(r ->> 'state', 'ENABLED')), private.amazon_num(r, 'bid'), case when p_demo then 'DEMO' else p_source end, p_demo, now()
      from src
      on conflict (company_id, profile_id, target_id) do update set expression = excluded.expression, match_type = excluded.match_type, state = excluded.state,
        bid = coalesce(excluded.bid, t.bid), ad_group_id = coalesce(excluded.ad_group_id, t.ad_group_id), last_synced_at = now()
      where t.is_demo = excluded.is_demo
      returning (xmax = 0) as inserted)
    select count(*) filter (where inserted), count(*) filter (where not inserted) into v_ins, v_upd from up;

  elsif p_kind = 'CAMPAIGN_DAILY' then
    with src as (select distinct on (coalesce(r ->> 'profile_id', ''), r ->> 'campaign_id', private.amazon_date(r, 'metric_date')) r from jsonb_array_elements(v_valid) r),
    up as (
      insert into public.amazon_campaign_daily as d (company_id, profile_id, campaign_id, metric_date, impressions, clicks, spend, sales, orders, units, budget, data_source, is_demo, sync_job_id)
      select p_company, coalesce(nullif(r ->> 'profile_id', ''), 'UNKNOWN'), r ->> 'campaign_id', private.amazon_date(r, 'metric_date'),
        coalesce(private.amazon_num(r, 'impressions'), 0), coalesce(private.amazon_num(r, 'clicks'), 0), coalesce(private.amazon_num(r, 'spend'), 0), coalesce(private.amazon_num(r, 'sales'), 0),
        coalesce(private.amazon_num(r, 'orders'), 0), coalesce(private.amazon_num(r, 'units'), 0), private.amazon_num(r, 'budget'), case when p_demo then 'DEMO' else p_source end, p_demo, p_job
      from src
      on conflict (company_id, profile_id, campaign_id, metric_date) do update set impressions = excluded.impressions, clicks = excluded.clicks, spend = excluded.spend,
        sales = excluded.sales, orders = excluded.orders, units = excluded.units, budget = coalesce(excluded.budget, d.budget), sync_job_id = excluded.sync_job_id
      where d.is_demo = excluded.is_demo
      returning (xmax = 0) as inserted)
    select count(*) filter (where inserted), count(*) filter (where not inserted) into v_ins, v_upd from up;

  elsif p_kind = 'AD_PRODUCT_DAILY' then
    with src as (select distinct on (coalesce(r ->> 'profile_id', ''), r ->> 'campaign_id', r ->> 'ad_group_id', btrim(r ->> 'seller_sku'), private.amazon_date(r, 'metric_date')) r
                 from jsonb_array_elements(v_valid) r),
    up as (
      insert into public.amazon_ad_product_daily as d (company_id, profile_id, campaign_id, ad_group_id, seller_sku, asin, metric_date, impressions, clicks, spend, sales, orders, units, data_source, is_demo, sync_job_id)
      select p_company, coalesce(nullif(r ->> 'profile_id', ''), 'UNKNOWN'), r ->> 'campaign_id', r ->> 'ad_group_id', btrim(r ->> 'seller_sku'), nullif(r ->> 'asin', ''), private.amazon_date(r, 'metric_date'),
        coalesce(private.amazon_num(r, 'impressions'), 0), coalesce(private.amazon_num(r, 'clicks'), 0), coalesce(private.amazon_num(r, 'spend'), 0), coalesce(private.amazon_num(r, 'sales'), 0),
        coalesce(private.amazon_num(r, 'orders'), 0), coalesce(private.amazon_num(r, 'units'), 0), case when p_demo then 'DEMO' else p_source end, p_demo, p_job
      from src
      on conflict (company_id, profile_id, campaign_id, ad_group_id, seller_sku, metric_date) do update set asin = coalesce(excluded.asin, d.asin), impressions = excluded.impressions,
        clicks = excluded.clicks, spend = excluded.spend, sales = excluded.sales, orders = excluded.orders, units = excluded.units, sync_job_id = excluded.sync_job_id
      where d.is_demo = excluded.is_demo
      returning (xmax = 0) as inserted)
    select count(*) filter (where inserted), count(*) filter (where not inserted) into v_ins, v_upd from up;

  elsif p_kind = 'SEARCH_TERM_DAILY' then
    with src as (
      select r, md5(concat_ws('|', coalesce(nullif(r ->> 'profile_id', ''), 'UNKNOWN'), r ->> 'campaign_id', r ->> 'ad_group_id', lower(btrim(r ->> 'targeting')),
        coalesce(upper(r ->> 'match_type'), ''), lower(btrim(r ->> 'search_term')), private.amazon_date(r, 'metric_date')::text, p_demo::text)) as k
      from jsonb_array_elements(v_valid) r),
    dedup as (select distinct on (k) r, k from src),
    up as (
      insert into public.amazon_search_term_daily as d (company_id, profile_id, campaign_id, ad_group_id, target_id, targeting, match_type, search_term, metric_date,
        impressions, clicks, spend, sales, orders, units, row_key, data_source, is_demo, sync_job_id)
      select p_company, coalesce(nullif(r ->> 'profile_id', ''), 'UNKNOWN'), r ->> 'campaign_id', r ->> 'ad_group_id', nullif(r ->> 'target_id', ''), left(btrim(r ->> 'targeting'), 500),
        nullif(upper(r ->> 'match_type'), ''), left(lower(btrim(r ->> 'search_term')), 500), private.amazon_date(r, 'metric_date'),
        coalesce(private.amazon_num(r, 'impressions'), 0), coalesce(private.amazon_num(r, 'clicks'), 0), coalesce(private.amazon_num(r, 'spend'), 0), coalesce(private.amazon_num(r, 'sales'), 0),
        coalesce(private.amazon_num(r, 'orders'), 0), coalesce(private.amazon_num(r, 'units'), 0), k, case when p_demo then 'DEMO' else p_source end, p_demo, p_job
      from dedup
      on conflict (company_id, row_key) do update set impressions = excluded.impressions, clicks = excluded.clicks, spend = excluded.spend, sales = excluded.sales,
        orders = excluded.orders, units = excluded.units, target_id = coalesce(excluded.target_id, d.target_id), sync_job_id = excluded.sync_job_id
      returning (xmax = 0) as inserted)
    select count(*) filter (where inserted), count(*) filter (where not inserted) into v_ins, v_upd from up;
  else
    raise exception 'Unknown import kind %.', p_kind using errcode = 'P0001';
  end if;

  return jsonb_build_object('kind', p_kind, 'received', v_received, 'inserted', v_ins, 'updated', v_upd,
    'skipped', v_received - jsonb_array_length(v_valid) + (jsonb_array_length(v_valid) - v_ins - v_upd), 'errors', v_errors);
end $$;
revoke all on function private.amazon_ingest(uuid, text, jsonb, text, uuid, boolean) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- CSV / file import (amazon.manage). Idempotent by request key: retrying the
-- same import returns the first result and writes nothing twice.
-- -----------------------------------------------------------------------------
create or replace function public.amazon_import_rows(p_kind text, p_rows jsonb, p_file_name text, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := private.require_permission('amazon.manage');
  v_job public.amazon_sync_jobs;
  v_result jsonb;
  v_status text;
begin
  if p_idempotency_key is null then raise exception 'A request id (idempotency key) is required.' using errcode = 'P0001'; end if;
  select * into v_job from public.amazon_sync_jobs where company_id = v_company and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('job_id', v_job.id, 'duplicate', true, 'status', v_job.status, 'received', v_job.rows_received, 'inserted', v_job.rows_inserted,
      'updated', v_job.rows_updated, 'skipped', v_job.rows_skipped, 'errors', coalesce(v_job.state -> 'errors', '[]'::jsonb));
  end if;
  insert into public.amazon_sync_jobs (company_id, api, job_type, status, idempotency_key, file_name, requested_by)
  values (v_company, 'CSV', 'CSV_' || p_kind, 'RUNNING', p_idempotency_key, left(p_file_name, 255), auth.uid()) returning * into v_job;
  v_result := private.amazon_ingest(v_company, p_kind, p_rows, 'CSV', v_job.id, false);
  v_status := case when (v_result ->> 'skipped')::int = 0 then 'SUCCEEDED' when (v_result ->> 'inserted')::int + (v_result ->> 'updated')::int > 0 then 'PARTIAL' else 'FAILED' end;
  update public.amazon_sync_jobs set status = v_status, rows_received = (v_result ->> 'received')::int, rows_inserted = (v_result ->> 'inserted')::int,
    rows_updated = (v_result ->> 'updated')::int, rows_skipped = (v_result ->> 'skipped')::int, state = jsonb_build_object('errors', v_result -> 'errors'), finished_at = now(),
    date_from = (select min(private.amazon_date(r, 'metric_date')) from jsonb_array_elements(p_rows) r where jsonb_typeof(r) = 'object'),
    date_to = (select max(private.amazon_date(r, 'metric_date')) from jsonb_array_elements(p_rows) r where jsonb_typeof(r) = 'object')
  where id = v_job.id;
  perform private.write_audit_log(v_company, 'amazon.import', 'amazon_sync_job', v_job.id::text,
    jsonb_build_object('module', 'amazon', 'result', case when v_status = 'FAILED' then 'failure' else 'success' end, 'kind', p_kind, 'file', left(p_file_name, 255),
      'received', v_result -> 'received', 'inserted', v_result -> 'inserted', 'updated', v_result -> 'updated', 'skipped', v_result -> 'skipped'));
  return v_result || jsonb_build_object('job_id', v_job.id, 'duplicate', false, 'status', v_status);
end $$;
revoke all on function public.amazon_import_rows(text, jsonb, text, uuid) from public, anon;
grant execute on function public.amazon_import_rows(text, jsonb, text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Service-role API for the Edge Functions (never callable by browsers). The
-- Edge Function authenticates the caller and passes the caller's company.
-- -----------------------------------------------------------------------------
create or replace function public.amazon_service_job_start(p_company uuid, p_api text, p_job_type text, p_requested_by uuid, p_from date, p_to date, p_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.amazon_sync_jobs;
begin
  insert into public.amazon_sync_jobs (company_id, api, job_type, status, idempotency_key, date_from, date_to, requested_by)
  values (p_company, p_api, p_job_type, 'RUNNING', p_key, p_from, p_to, p_requested_by)
  on conflict (company_id, idempotency_key) do nothing
  returning * into v_job;
  if not found then
    select * into v_job from public.amazon_sync_jobs where company_id = p_company and idempotency_key = p_key;
    return to_jsonb(v_job) || jsonb_build_object('duplicate', true);
  end if;
  return to_jsonb(v_job) || jsonb_build_object('duplicate', false);
end $$;

create or replace function public.amazon_service_ingest(p_company uuid, p_job uuid, p_kind text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if not exists (select 1 from public.amazon_sync_jobs where id = p_job and company_id = p_company) then
    raise exception 'Sync job not found for this company.' using errcode = 'P0001';
  end if;
  v_result := private.amazon_ingest(p_company, p_kind, p_rows, 'API', p_job, false);
  update public.amazon_sync_jobs set rows_received = rows_received + (v_result ->> 'received')::int, rows_inserted = rows_inserted + (v_result ->> 'inserted')::int,
    rows_updated = rows_updated + (v_result ->> 'updated')::int, rows_skipped = rows_skipped + (v_result ->> 'skipped')::int
  where id = p_job;
  return v_result;
end $$;

create or replace function public.amazon_service_job_update(p_company uuid, p_job uuid, p_status text, p_state jsonb default null, p_error_code text default null, p_error_message text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_api text;
begin
  update public.amazon_sync_jobs set status = p_status, state = coalesce(p_state, state), error_code = left(p_error_code, 100), error_message = left(private.redact(p_error_message), 2000),
    finished_at = case when p_status in ('SUCCEEDED', 'PARTIAL', 'FAILED') then now() end
  where id = p_job and company_id = p_company returning api into v_api;
  if p_status in ('SUCCEEDED', 'PARTIAL') then
    update public.amazon_connections set last_successful_sync_at = now(), updated_at = now() where company_id = p_company and api = v_api;
  elsif p_status = 'FAILED' then
    update public.amazon_connections set last_error_at = now(), last_error_message = left(private.redact(p_error_message), 1000), updated_at = now() where company_id = p_company and api = v_api;
  end if;
end $$;

create or replace function public.amazon_service_log_error(p_company uuid, p_job uuid, p_api text, p_operation text, p_http_status integer, p_error_code text, p_message text, p_retryable boolean, p_attempt integer)
returns void language sql security definer set search_path = '' as $$
  insert into public.amazon_sync_errors (company_id, job_id, api, operation, http_status, error_code, message, retryable, attempt)
  values (p_company, p_job, p_api, left(p_operation, 120), p_http_status, left(p_error_code, 100), left(coalesce(private.redact(p_message), 'Unknown error'), 2000), p_retryable, greatest(p_attempt, 1));
$$;

create or replace function public.amazon_service_connection_update(p_company uuid, p_api text, p_patch jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.amazon_connections set
    status = coalesce(p_patch ->> 'status', status),
    account_identifier = case when p_patch ? 'account_identifier' then left(p_patch ->> 'account_identifier', 100) else account_identifier end,
    account_name = case when p_patch ? 'account_name' then left(p_patch ->> 'account_name', 200) else account_name end,
    region = case when p_patch ? 'region' then p_patch ->> 'region' else region end,
    marketplace_ids = case when p_patch ? 'marketplace_ids' then array(select jsonb_array_elements_text(p_patch -> 'marketplace_ids')) else marketplace_ids end,
    profile_id = case when p_patch ? 'profile_id' then left(p_patch ->> 'profile_id', 40) else profile_id end,
    permissions = case when p_patch ? 'permissions' then p_patch -> 'permissions' else permissions end,
    last_test_at = case when p_patch ? 'last_test_ok' then now() else last_test_at end,
    last_test_ok = case when p_patch ? 'last_test_ok' then (p_patch ->> 'last_test_ok')::boolean else last_test_ok end,
    last_test_message = case when p_patch ? 'last_test_message' then left(private.redact(p_patch ->> 'last_test_message'), 1000) else last_test_message end,
    updated_at = now()
  where company_id = p_company and api = p_api;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.amazon_service_job_start(uuid, text, text, uuid, date, date, uuid)', 'public.amazon_service_ingest(uuid, uuid, text, jsonb)',
    'public.amazon_service_job_update(uuid, uuid, text, jsonb, text, text)', 'public.amazon_service_log_error(uuid, uuid, text, text, integer, text, text, boolean, integer)',
    'public.amazon_service_connection_update(uuid, text, jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Product mapping and unit economics (amazon.manage)
-- -----------------------------------------------------------------------------
create or replace function public.amazon_listing_save(p_listing jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := private.require_permission('amazon.manage');
  v_id uuid := nullif(p_listing ->> 'id', '')::uuid;
  v_old public.amazon_listings;
  v_new public.amazon_listings;
  v_product uuid := nullif(p_listing ->> 'product_id', '')::uuid;
  v_costs_changed boolean;
begin
  if v_product is not null and not exists (select 1 from public.products where id = v_product and company_id = v_company and archived_at is null) then
    raise exception 'ERP product not found in your company (or archived).' using errcode = 'P0001';
  end if;
  if v_id is null then
    if nullif(btrim(p_listing ->> 'seller_sku'), '') is null then raise exception 'Seller SKU is required.' using errcode = 'P0001'; end if;
    insert into public.amazon_listings (company_id, marketplace_id, seller_sku, asin, title, product_id, item_price, fulfillment_channel, data_source, created_by)
    values (v_company, coalesce(nullif(p_listing ->> 'marketplace_id', ''), 'A21TJRUUN4KGV'), btrim(p_listing ->> 'seller_sku'), nullif(upper(btrim(p_listing ->> 'asin')), ''),
      nullif(btrim(p_listing ->> 'title'), ''), v_product, private.amazon_num(p_listing, 'item_price'), nullif(p_listing ->> 'fulfillment_channel', ''), 'MANUAL', auth.uid())
    returning * into v_new;
    v_old := null;
  else
    select * into v_old from public.amazon_listings where id = v_id and company_id = v_company for update;
    if not found then raise exception 'Listing not found in your company.' using errcode = 'P0001'; end if;
    if v_old.is_demo and v_product is not null then raise exception 'Demo listings cannot be mapped to real ERP products.' using errcode = 'P0001'; end if;
    update public.amazon_listings set
      product_id = case when p_listing ? 'product_id' then v_product else product_id end,
      asin = case when p_listing ? 'asin' and data_source = 'MANUAL' then nullif(upper(btrim(p_listing ->> 'asin')), '') else asin end,
      title = case when p_listing ? 'title' and data_source = 'MANUAL' then nullif(btrim(p_listing ->> 'title'), '') else title end,
      item_price = case when p_listing ? 'item_price' and data_source = 'MANUAL' then private.amazon_num(p_listing, 'item_price') else item_price end
    where id = v_id returning * into v_new;
  end if;
  -- Economics (any listing): numbers or null to clear.
  update public.amazon_listings set
    referral_fee_pct = case when p_listing ? 'referral_fee_pct' then private.amazon_num(p_listing, 'referral_fee_pct') else referral_fee_pct end,
    closing_fee_per_unit = case when p_listing ? 'closing_fee_per_unit' then private.amazon_num(p_listing, 'closing_fee_per_unit') else closing_fee_per_unit end,
    fulfilment_fee_per_unit = case when p_listing ? 'fulfilment_fee_per_unit' then private.amazon_num(p_listing, 'fulfilment_fee_per_unit') else fulfilment_fee_per_unit end,
    shipping_cost_per_unit = case when p_listing ? 'shipping_cost_per_unit' then private.amazon_num(p_listing, 'shipping_cost_per_unit') else shipping_cost_per_unit end,
    other_variable_cost_per_unit = case when p_listing ? 'other_variable_cost_per_unit' then private.amazon_num(p_listing, 'other_variable_cost_per_unit') else other_variable_cost_per_unit end,
    unit_cost_override = case when p_listing ? 'unit_cost_override' then private.amazon_num(p_listing, 'unit_cost_override') else unit_cost_override end,
    gst_rate = case when p_listing ? 'gst_rate' then private.amazon_num(p_listing, 'gst_rate') else gst_rate end,
    cost_note = case when p_listing ? 'cost_note' then nullif(btrim(p_listing ->> 'cost_note'), '') else cost_note end,
    desired_contribution_per_unit = case when p_listing ? 'desired_contribution_per_unit' then private.amazon_num(p_listing, 'desired_contribution_per_unit') else desired_contribution_per_unit end,
    target_acos_pct = case when p_listing ? 'target_acos_pct' then private.amazon_num(p_listing, 'target_acos_pct') else target_acos_pct end,
    min_stock = case when p_listing ? 'min_stock' then private.amazon_num(p_listing, 'min_stock') else min_stock end,
    lead_time_days = case when p_listing ? 'lead_time_days' then private.amazon_num(p_listing, 'lead_time_days')::int else lead_time_days end
  where id = v_new.id returning * into v_new;
  v_costs_changed := v_old.id is null or row(v_old.referral_fee_pct, v_old.closing_fee_per_unit, v_old.fulfilment_fee_per_unit, v_old.shipping_cost_per_unit,
    v_old.other_variable_cost_per_unit, v_old.unit_cost_override, v_old.gst_rate) is distinct from row(v_new.referral_fee_pct, v_new.closing_fee_per_unit, v_new.fulfilment_fee_per_unit,
    v_new.shipping_cost_per_unit, v_new.other_variable_cost_per_unit, v_new.unit_cost_override, v_new.gst_rate);
  if v_costs_changed then update public.amazon_listings set costs_updated_at = now() where id = v_new.id; end if;
  perform private.write_audit_log(v_company, case when v_old.id is null then 'amazon.listing_created' else 'amazon.listing_updated' end, 'amazon_listing', v_new.id::text,
    jsonb_build_object('module', 'amazon', 'result', 'success', 'seller_sku', v_new.seller_sku, 'product_id', v_new.product_id, 'previous_product_id', v_old.product_id,
      'costs_changed', v_costs_changed));
  return jsonb_build_object('id', v_new.id, 'seller_sku', v_new.seller_sku);
end $$;

-- Maps unmapped listings whose seller SKU equals an ERP SKU exactly (case-insensitive). Never overwrites a mapping.
create or replace function public.amazon_listing_auto_map()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_company uuid := private.require_permission('amazon.manage'); v_n int := 0; v_conflicts int := 0; r record;
begin
  for r in select l.id, p.id as product_id from public.amazon_listings l
           join public.products p on p.company_id = l.company_id and lower(p.sku) = lower(l.seller_sku) and p.archived_at is null
           where l.company_id = v_company and l.product_id is null and not l.is_demo loop
    begin
      update public.amazon_listings set product_id = r.product_id where id = r.id;
      v_n := v_n + 1;
    exception when others then v_conflicts := v_conflicts + 1;
    end;
  end loop;
  perform private.write_audit_log(v_company, 'amazon.listing_auto_mapped', 'amazon_listing', null, jsonb_build_object('module', 'amazon', 'result', 'success', 'mapped', v_n, 'conflicts', v_conflicts));
  return jsonb_build_object('mapped', v_n, 'conflicts', v_conflicts);
end $$;

-- -----------------------------------------------------------------------------
-- Settings. Analysis thresholds: amazon.manage. Automation mode, spending limits
-- and the kill switch: amazon_ads.approve. Every change is audited.
-- -----------------------------------------------------------------------------
create or replace function public.amazon_settings_update(p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := private.require_any_permission(array['amazon.manage', 'amazon_ads.approve']);
  v_old public.amazon_settings;
  v_new public.amazon_settings;
  v_key text;
  v_control text[] := array['automation_mode', 'kill_switch', 'max_daily_budget', 'max_monthly_budget', 'max_bid', 'max_bid_change_pct', 'max_budget_change_pct'];
  v_analysis text[] := array['prices_include_gst', 'attribution_window_days', 'min_clicks_for_decision', 'min_orders_for_scaling', 'wasted_spend_threshold',
    'low_stock_cover_days', 'overstock_cover_days', 'target_contribution_pct', 'overhead_allocation_pct'];
begin
  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key = any(v_control) then
      if not private.has_permission(v_company, 'amazon_ads.approve') then
        raise exception 'Changing % requires the amazon_ads.approve permission.', v_key using errcode = '42501';
      end if;
    elsif v_key = any(v_analysis) then
      if not private.has_permission(v_company, 'amazon.manage') then
        raise exception 'Changing % requires the amazon.manage permission.', v_key using errcode = '42501';
      end if;
    else
      raise exception 'Unknown setting %.', v_key using errcode = 'P0001';
    end if;
  end loop;
  select * into v_old from public.amazon_settings where company_id = v_company for update;
  update public.amazon_settings s set
    prices_include_gst = coalesce((p_changes ->> 'prices_include_gst')::boolean, s.prices_include_gst),
    attribution_window_days = coalesce((p_changes ->> 'attribution_window_days')::int, s.attribution_window_days),
    min_clicks_for_decision = coalesce((p_changes ->> 'min_clicks_for_decision')::int, s.min_clicks_for_decision),
    min_orders_for_scaling = coalesce((p_changes ->> 'min_orders_for_scaling')::int, s.min_orders_for_scaling),
    wasted_spend_threshold = coalesce((p_changes ->> 'wasted_spend_threshold')::numeric, s.wasted_spend_threshold),
    low_stock_cover_days = coalesce((p_changes ->> 'low_stock_cover_days')::int, s.low_stock_cover_days),
    overstock_cover_days = coalesce((p_changes ->> 'overstock_cover_days')::int, s.overstock_cover_days),
    target_contribution_pct = coalesce((p_changes ->> 'target_contribution_pct')::numeric, s.target_contribution_pct),
    overhead_allocation_pct = coalesce((p_changes ->> 'overhead_allocation_pct')::numeric, s.overhead_allocation_pct),
    automation_mode = coalesce(p_changes ->> 'automation_mode', s.automation_mode),
    kill_switch = coalesce((p_changes ->> 'kill_switch')::boolean, s.kill_switch),
    max_daily_budget = case when p_changes ? 'max_daily_budget' then (p_changes ->> 'max_daily_budget')::numeric else s.max_daily_budget end,
    max_monthly_budget = case when p_changes ? 'max_monthly_budget' then (p_changes ->> 'max_monthly_budget')::numeric else s.max_monthly_budget end,
    max_bid = case when p_changes ? 'max_bid' then (p_changes ->> 'max_bid')::numeric else s.max_bid end,
    max_bid_change_pct = coalesce((p_changes ->> 'max_bid_change_pct')::numeric, s.max_bid_change_pct),
    max_budget_change_pct = coalesce((p_changes ->> 'max_budget_change_pct')::numeric, s.max_budget_change_pct),
    updated_by = auth.uid(), updated_at = now()
  where company_id = v_company returning * into v_new;
  perform private.write_audit_log(v_company, case when p_changes ? 'kill_switch' then 'amazon.kill_switch_' || case when v_new.kill_switch then 'on' else 'off' end else 'amazon.settings_updated' end,
    'amazon_settings', v_company::text, jsonb_build_object('module', 'amazon', 'result', 'success', 'changes', p_changes,
      'previous', (select jsonb_object_agg(k, to_jsonb(v_old) -> k) from jsonb_object_keys(p_changes) k)));
  return to_jsonb(v_new);
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.amazon_listing_save(jsonb)', 'public.amazon_listing_auto_map()', 'public.amazon_settings_update(jsonb)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
