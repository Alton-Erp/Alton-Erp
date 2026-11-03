-- =============================================================================
-- ALTON ERP V2 — Product Master, BOM and Purchase enhancements
--
-- Non-destructive: only new columns, one new table, new functions and
-- replacements of existing functions / views with the same signatures and
-- column lists. No existing data is changed or converted.
--
--   products
--     * lead_time_days, reorder_level_days   (day-based inventory planning)
--     * mrp                                   (maximum retail price, INR; kept
--                                              separate from the selling price)
--     * length_cm, width_cm, height_cm        (optional dimensions)
--     * supplier_model_number, supplier_product_name (optional)
--     The earlier quantity columns (reorder_level, minimum_level) are kept as
--     they are. Day values are never read as quantities and quantities are
--     never converted to days.
--   Day-based planning
--     * private.product_consumption(): stock issued (issues, production issues,
--       subcontract consumption, net of their reversals) over a history window
--       and the number of days observed (no division by zero).
--     * Low stock = quantity rule (unchanged) OR days of cover (available /
--       average daily consumption) at or below the reorder level in days.
--       Used by inventory_product_stock.stock_status, inventory_overview and
--       inventory_refresh_alerts.
--     * public.inventory_reorder_plan(): per product available, reserved,
--       incoming (open purchase orders), consumption, cover, lead time and a
--       reorder recommendation.
--   Supplier invoice / challan references (purchase_document_refs)
--     * One row per purchase order (order level) and one per goods receipt, so
--       every GRN keeps its own invoice and challan numbers. Posted receipts
--       stay immutable; the references can be added or corrected later.
--     * Duplicate supplier invoice numbers are refused per company + supplier
--       across different orders / direct receipts (reversed receipts and
--       cancelled orders do not count).
--     * Wrappers save the references in the same transaction as the order /
--       receipt: purchase_order_save_refs, purchase_receipt_post_refs,
--       goods_receipt_direct_post_refs, goods_receipt_correct_refs.
--     * New views purchase_order_list_v2 / goods_receipt_list_v2 = the existing
--       lists plus the references (the existing views are unchanged).
--   Reports: public.erp_report_v2 = erp_report + the new fields, plus the
--   REORDER_PLANNING report.
--   ERP reset: purchase_document_refs is purged with the purchase records.
--
-- Rollback: supabase/rollback/20261109090000_product_purchase_enhancements_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. products: new optional columns
-- -----------------------------------------------------------------------------
alter table public.products add column if not exists lead_time_days numeric(7,2);
alter table public.products add column if not exists reorder_level_days numeric(7,2);
alter table public.products add column if not exists mrp numeric(14,2);
alter table public.products add column if not exists length_cm numeric(10,2);
alter table public.products add column if not exists width_cm numeric(10,2);
alter table public.products add column if not exists height_cm numeric(10,2);
alter table public.products add column if not exists supplier_model_number text;
alter table public.products add column if not exists supplier_product_name text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_lead_time_days_check') then
    alter table public.products add constraint products_lead_time_days_check
      check (lead_time_days is null or (lead_time_days >= 0 and lead_time_days <= 3650));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_reorder_level_days_check') then
    alter table public.products add constraint products_reorder_level_days_check
      check (reorder_level_days is null or (reorder_level_days >= 0 and reorder_level_days <= 3650));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_mrp_check') then
    alter table public.products add constraint products_mrp_check check (mrp is null or mrp >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_dimensions_check') then
    alter table public.products add constraint products_dimensions_check check (
      (length_cm is null or (length_cm > 0 and length_cm <= 100000))
      and (width_cm is null or (width_cm > 0 and width_cm <= 100000))
      and (height_cm is null or (height_cm > 0 and height_cm <= 100000)));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_supplier_refs_check') then
    alter table public.products add constraint products_supplier_refs_check check (
      (supplier_model_number is null or length(btrim(supplier_model_number)) between 1 and 100)
      and (supplier_product_name is null or length(btrim(supplier_product_name)) between 1 and 200));
  end if;
end;
$$;

comment on column public.products.lead_time_days is 'Days needed to procure or manufacture the product (planning).';
comment on column public.products.reorder_level_days is 'Reorder when the days of stock cover (available / average daily consumption) fall to this many days or fewer.';
comment on column public.products.mrp is 'Maximum retail price in INR (incl. all taxes). Never used as the invoice selling price.';
comment on column public.products.length_cm is 'Optional length in centimetres.';
comment on column public.products.width_cm is 'Optional width in centimetres.';
comment on column public.products.height_cm is 'Optional height in centimetres.';
comment on column public.products.supplier_model_number is 'The supplier''s model number for this product (optional, searchable).';
comment on column public.products.supplier_product_name is 'The supplier''s name for this product (optional, searchable). The Alton SKU and product name are unchanged.';
comment on column public.products.reorder_level is 'Earlier quantity-based reorder level (in the product unit). Kept as entered; not converted to days.';
comment on column public.products.minimum_level is 'Earlier minimum stock quantity (in the product unit). Kept as entered; no longer edited on the product form.';

grant insert (lead_time_days, reorder_level_days, mrp, length_cm, width_cm, height_cm, supplier_model_number, supplier_product_name)
  on public.products to authenticated;
grant update (lead_time_days, reorder_level_days, mrp, length_cm, width_cm, height_cm, supplier_model_number, supplier_product_name)
  on public.products to authenticated;

-- Blank supplier texts become NULL (runs with the other "a" defaults trigger).
create or replace function private.product_normalise_supplier_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.supplier_model_number := nullif(btrim(coalesce(new.supplier_model_number, '')), '');
  new.supplier_product_name := nullif(btrim(coalesce(new.supplier_product_name, '')), '');
  return new;
end;
$$;

revoke all on function private.product_normalise_supplier_refs() from public, anon, authenticated;

drop trigger if exists products_a_supplier_refs on public.products;
create trigger products_a_supplier_refs
  before insert or update on public.products
  for each row execute function private.product_normalise_supplier_refs();

create index if not exists products_supplier_model_idx on public.products (company_id, lower(supplier_model_number))
  where supplier_model_number is not null;
create index if not exists products_supplier_name_idx on public.products (company_id, lower(supplier_product_name))
  where supplier_product_name is not null;

-- -----------------------------------------------------------------------------
-- 2. Consumption history and the days-of-cover rule
-- -----------------------------------------------------------------------------
create index if not exists inventory_tx_product_date_idx on public.inventory_transactions (product_id, transaction_date);

-- Stock consumed in the last p_days days: issues, production issues and
-- subcontract consumption, less any reversal of those movements.
-- observed_days = the days the product has had stock movements, capped at
-- p_days and never below 1 (a product added 10 days ago is averaged over 10
-- days, not 90). Runs with the caller's row-level security.
create or replace function private.product_consumption(p_product uuid, p_days int default 90)
returns table (consumed numeric, observed_days int)
language sql
stable
security invoker
set search_path = ''
as $$
  with c as (
    select coalesce(sum(t.quantity), 0) - coalesce(sum(r.quantity), 0) as consumed
    from public.inventory_transactions t
    left join public.inventory_transactions r on r.reversal_of_transaction_id = t.id
    where t.product_id = p_product
      and t.transaction_type in ('ISSUE', 'PRODUCTION_ISSUE', 'SUBCONTRACT_CONSUMPTION')
      and t.transaction_date >= now() - make_interval(days => greatest(coalesce(p_days, 90), 1))
  ),
  f as (select min(transaction_date) as first_at from public.inventory_transactions where product_id = p_product)
  select greatest(c.consumed, 0),
    greatest(1, least(greatest(coalesce(p_days, 90), 1), ceil(extract(epoch from (now() - coalesce(f.first_at, now()))) / 86400.0)::int))
  from c, f;
$$;

-- True when the days of cover are at or below the reorder level in days.
-- No consumption = no evidence of demand = never low by days.
create or replace function private.reorder_by_days(p_product uuid, p_available numeric, p_reorder_days numeric)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select p_reorder_days is not null and c.consumed > 0
      and coalesce(p_available, 0) / (c.consumed / c.observed_days) <= p_reorder_days
    from private.product_consumption(p_product, 90) c), false);
$$;

revoke all on function private.product_consumption(uuid, int) from public, anon;
revoke all on function private.reorder_by_days(uuid, numeric, numeric) from public, anon;
-- Invoker functions: they only see rows the caller can already read.
grant execute on function private.product_consumption(uuid, int) to authenticated;
grant execute on function private.reorder_by_days(uuid, numeric, numeric) to authenticated;

-- Same columns as 20261013090100; stock_status also applies the days rule.
create or replace view public.inventory_product_stock
with (security_invoker = true) as
select
  p.id as product_id, p.company_id, p.sku, p.product_name, p.barcode, p.brand, p.model_number, p.category_id,
  c.name as category_name, p.product_type, p.default_source_type, p.base_unit, p.reorder_level,
  p.status as product_status, p.archived_at, p.track_batches,
  coalesce(s.on_hand, 0) as on_hand,
  coalesce(s.reserved, 0) as reserved,
  coalesce(s.available, 0) as available,
  coalesce(s.in_house, 0) as in_house_on_hand,
  coalesce(s.outsourced, 0) as outsourced_on_hand,
  coalesce(s.unknown, 0) as unknown_source_on_hand,
  s.last_movement_at,
  exists (select 1 from public.inventory_transactions t where t.company_id = p.company_id and t.product_id = p.id) as has_history,
  case
    when coalesce(s.storage_on_hand, 0) = 0 then 'OUT_OF_STOCK'
    when coalesce(s.available, 0) = 0 then 'FULLY_RESERVED'
    when p.reorder_level is null and p.reorder_level_days is null then 'NO_THRESHOLD'
    when p.reorder_level is not null and coalesce(s.available, 0) <= p.reorder_level then 'LOW_STOCK'
    when p.reorder_level_days is not null and private.reorder_by_days(p.id, coalesce(s.available, 0), p.reorder_level_days) then 'LOW_STOCK'
    else 'HEALTHY'
  end as stock_status
from public.products p
left join public.product_categories c on c.id = p.category_id
left join (
  select b.product_id,
    sum(b.on_hand) as on_hand, sum(b.reserved) as reserved,
    sum(b.on_hand) filter (where l.stock_usage = 'STORAGE') as storage_on_hand,
    sum(b.on_hand - b.reserved) filter (where l.stock_usage = 'STORAGE') as available,
    sum(b.on_hand) filter (where b.source_type = 'IN_HOUSE') as in_house,
    sum(b.on_hand) filter (where b.source_type = 'OUTSOURCED') as outsourced,
    sum(b.on_hand) filter (where b.source_type = 'UNKNOWN') as unknown,
    max(b.last_movement_at) as last_movement_at
  from public.inventory_balances b
  join public.inventory_locations l on l.id = b.location_id
  group by b.product_id
) s on s.product_id = p.id;

revoke all on public.inventory_product_stock from anon, authenticated;
grant select on public.inventory_product_stock to authenticated;

-- Same as 20261013090100 except low / healthy / no-threshold also use days.
create or replace function public.inventory_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory.read');
  v_result  jsonb;
begin
  with ps as (
    select p.id, p.base_unit, p.reorder_level, p.reorder_level_days, p.status, p.category_id,
      coalesce(s.on_hand, 0) as on_hand, coalesce(s.storage_on_hand, 0) as storage_on_hand,
      coalesce(s.available, 0) as available,
      exists (select 1 from public.inventory_transactions t where t.company_id = v_company and t.product_id = p.id) as has_history
    from public.products p
    left join (select b.product_id, sum(b.on_hand) on_hand,
                 sum(b.on_hand) filter (where l.stock_usage = 'STORAGE') storage_on_hand,
                 sum(b.on_hand - b.reserved) filter (where l.stock_usage = 'STORAGE') available
               from public.inventory_balances b join public.inventory_locations l on l.id = b.location_id
               where b.company_id = v_company group by b.product_id) s on s.product_id = p.id
    where p.company_id = v_company and p.archived_at is null
  ),
  active as (
    select ps.*, (ps.reorder_level is not null or ps.reorder_level_days is not null) as has_threshold,
      (ps.available > 0 and ((ps.reorder_level is not null and ps.available <= ps.reorder_level)
        or (ps.reorder_level_days is not null and private.reorder_by_days(ps.id, ps.available, ps.reorder_level_days)))) as is_low
    from ps where status = 'ACTIVE'
  ),
  bal as (
    select b.*, p.base_unit, p.category_id, l.stock_usage from public.inventory_balances b
    join public.products p on p.id = b.product_id
    join public.inventory_locations l on l.id = b.location_id
    where b.company_id = v_company and p.archived_at is null and (b.on_hand <> 0 or b.reserved <> 0)
  )
  select jsonb_build_object(
    'active_products', (select count(*) from active),
    'products_with_stock', (select count(*) from active where on_hand > 0),
    'never_stocked', (select count(*) from active where on_hand = 0 and not has_history),
    'out_of_stock', (select count(*) from active where storage_on_hand = 0 and has_history),
    'fully_reserved', (select count(*) from active where storage_on_hand > 0 and available = 0),
    'low_stock', (select count(*) from active where available > 0 and is_low),
    'healthy', (select count(*) from active where available > 0 and has_threshold and not is_low),
    'no_threshold', (select count(*) from active where available > 0 and not has_threshold),
    'units', coalesce((
      select jsonb_agg(u order by u ->> 'unit') from (
        select jsonb_build_object('unit', base_unit,
          'on_hand', sum(on_hand), 'reserved', sum(reserved),
          'available', coalesce(sum(on_hand - reserved) filter (where stock_usage = 'STORAGE'), 0),
          'in_house', coalesce(sum(on_hand) filter (where source_type = 'IN_HOUSE'), 0),
          'outsourced', coalesce(sum(on_hand) filter (where source_type = 'OUTSOURCED'), 0),
          'unknown', coalesce(sum(on_hand) filter (where source_type = 'UNKNOWN'), 0),
          'rejected', coalesce(sum(on_hand) filter (where stock_usage = 'REJECTED'), 0),
          'external', coalesce(sum(on_hand) filter (where stock_usage = 'EXTERNAL_PROCESSING'), 0)) as u
        from bal group by base_unit) x), '[]'::jsonb),
    'by_category', coalesce((
      select jsonb_agg(jsonb_build_object('category', coalesce(c.name, 'Uncategorised'), 'unit', b.base_unit, 'on_hand', sum_on_hand)
                       order by sum_on_hand desc)
      from (select category_id, base_unit, sum(on_hand) sum_on_hand from bal group by category_id, base_unit) b
      left join public.product_categories c on c.id = b.category_id), '[]'::jsonb),
    'by_warehouse', coalesce((
      select jsonb_agg(jsonb_build_object('warehouse_code', w.warehouse_code, 'warehouse_name', w.warehouse_name,
                                          'unit', b.base_unit, 'on_hand', sum_on_hand) order by sum_on_hand desc)
      from (select warehouse_id, base_unit, sum(on_hand) sum_on_hand from bal group by warehouse_id, base_unit) b
      join public.warehouses w on w.id = b.warehouse_id), '[]'::jsonb),
    'first_transaction_at', (select min(transaction_date) from public.inventory_transactions where company_id = v_company),
    'last_transaction_at', (select max(transaction_date) from public.inventory_transactions where company_id = v_company),
    'warehouses', (select count(*) from public.warehouses where company_id = v_company and status = 'ACTIVE'),
    'pending_opening', (select count(*) from public.inventory_opening_batches where company_id = v_company and status = 'PENDING_APPROVAL'),
    'pending_adjustments', (select count(*) from public.inventory_adjustments where company_id = v_company and status = 'PENDING_APPROVAL'),
    'pending_counts', (select count(*) from public.inventory_counts where company_id = v_company and status = 'SUBMITTED'),
    'timezone', private.company_tz(v_company),
    'as_of', now()
  ) into v_result;
  return v_result;
end;
$$;

-- Same as 20261013090100 except the product-level condition also applies the
-- days rule, and the alert details carry the day-based figures.
create or replace function public.inventory_refresh_alerts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('inventory.read');
  v_today    date := private.company_today(v_company);
  v_warn     int := (private.inventory_policy(v_company) ->> 'expiry_warning_days')::int;
  v_opened   int;
  v_resolved int;
begin
  create temporary table if not exists pg_temp.current_alerts (
    alert_key text primary key, alert_type text, severity text, product_id uuid, batch_id uuid,
    warehouse_id uuid, location_id uuid, details jsonb
  ) on commit drop;
  truncate pg_temp.current_alerts;

  -- Product-level stock conditions (active products, usable storage stock only).
  insert into pg_temp.current_alerts
  select
    case when s.on_hand = 0 then 'OUT_OF_STOCK:' when s.on_hand - s.reserved = 0 then 'FULLY_RESERVED:' else 'LOW_STOCK:' end || p.id,
    case when s.on_hand = 0 then 'OUT_OF_STOCK' when s.on_hand - s.reserved = 0 then 'FULLY_RESERVED' else 'LOW_STOCK' end,
    case when s.on_hand - s.reserved = 0 then 'CRITICAL' else 'WARNING' end,
    p.id, null, null, null,
    jsonb_build_object('sku', p.sku, 'product_name', p.product_name, 'unit', p.base_unit, 'on_hand', s.on_hand,
      'reserved', s.reserved, 'available', s.on_hand - s.reserved, 'reorder_level', p.reorder_level,
      'reorder_level_days', p.reorder_level_days, 'lead_time_days', p.lead_time_days,
      'avg_daily', case when c.consumed > 0 then round(c.consumed / c.observed_days, 3) end,
      'coverage_days', case when c.consumed > 0 then round((s.on_hand - s.reserved) / (c.consumed / c.observed_days), 1) end)
  from public.products p
  join lateral (
    select coalesce(sum(b.on_hand), 0) as on_hand, coalesce(sum(b.reserved), 0) as reserved
    from public.inventory_balances b
    join public.inventory_locations l on l.id = b.location_id and l.stock_usage = 'STORAGE'
    where b.product_id = p.id
  ) s on true
  left join lateral (
    select x.consumed, x.observed_days from private.product_consumption(p.id, 90) x where p.reorder_level_days is not null
  ) c on true
  where p.company_id = v_company and p.status = 'ACTIVE' and p.archived_at is null
    and (
      (s.on_hand - s.reserved = 0 and (p.reorder_level is not null or p.reorder_level_days is not null
        or exists (select 1 from public.inventory_transactions t where t.company_id = v_company and t.product_id = p.id)))
      or (s.on_hand - s.reserved > 0 and (
        (p.reorder_level is not null and s.on_hand - s.reserved <= p.reorder_level)
        or (p.reorder_level_days is not null and c.consumed > 0
            and (s.on_hand - s.reserved) / (c.consumed / c.observed_days) <= p.reorder_level_days)))
    );

  -- Lot-level conditions.
  insert into pg_temp.current_alerts
  select
    case when bt.expiry_date < v_today then 'EXPIRED:' else 'EXPIRING:' end || b.id,
    case when bt.expiry_date < v_today then 'EXPIRED' else 'EXPIRING' end,
    case when bt.expiry_date < v_today then 'CRITICAL' else 'WARNING' end,
    b.product_id, b.batch_id, b.warehouse_id, b.location_id,
    jsonb_build_object('sku', p.sku, 'product_name', p.product_name, 'batch_number', bt.batch_number,
      'expiry_date', bt.expiry_date, 'on_hand', b.on_hand, 'unit', p.base_unit, 'location_code', l.location_code)
  from public.inventory_balances b
  join public.inventory_batches bt on bt.id = b.batch_id
  join public.products p on p.id = b.product_id
  join public.inventory_locations l on l.id = b.location_id
  where b.company_id = v_company and b.on_hand > 0 and bt.expiry_date is not null and bt.expiry_date <= v_today + v_warn
  on conflict do nothing;

  insert into pg_temp.current_alerts
  select 'INVALID_LOCATION:' || b.id, 'INVALID_LOCATION', 'CRITICAL', b.product_id, b.batch_id, b.warehouse_id, b.location_id,
    jsonb_build_object('sku', p.sku, 'product_name', p.product_name, 'on_hand', b.on_hand, 'unit', p.base_unit,
      'location_code', l.location_code, 'warehouse_code', w.warehouse_code)
  from public.inventory_balances b
  join public.products p on p.id = b.product_id
  join public.inventory_locations l on l.id = b.location_id
  join public.warehouses w on w.id = b.warehouse_id
  where b.company_id = v_company and b.on_hand > 0 and (l.status <> 'ACTIVE' or w.status <> 'ACTIVE')
  on conflict do nothing;

  insert into pg_temp.current_alerts
  select 'UNKNOWN_SOURCE:' || b.id, 'UNKNOWN_SOURCE', 'WARNING', b.product_id, b.batch_id, b.warehouse_id, b.location_id,
    jsonb_build_object('sku', p.sku, 'product_name', p.product_name, 'on_hand', b.on_hand, 'unit', p.base_unit,
      'location_code', l.location_code, 'batch_number', bt.batch_number)
  from public.inventory_balances b
  join public.inventory_batches bt on bt.id = b.batch_id
  join public.products p on p.id = b.product_id
  join public.inventory_locations l on l.id = b.location_id
  where b.company_id = v_company and b.on_hand > 0 and b.source_type = 'UNKNOWN'
  on conflict do nothing;

  -- Open new / refresh existing active alerts.
  with upserted as (
    insert into public.inventory_alerts (company_id, alert_key, alert_type, severity, product_id, batch_id, warehouse_id, location_id, details)
    select v_company, alert_key, alert_type, severity, product_id, batch_id, warehouse_id, location_id, details from pg_temp.current_alerts
    on conflict (company_id, alert_key) where status in ('OPEN', 'ACKNOWLEDGED')
    do update set last_detected_at = now(), details = excluded.details, severity = excluded.severity
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into v_opened from upserted;

  -- Resolve conditions that no longer hold.
  update public.inventory_alerts a
  set status = 'RESOLVED', resolved_at = now()
  where a.company_id = v_company and a.status in ('OPEN', 'ACKNOWLEDGED')
    and not exists (select 1 from pg_temp.current_alerts c where c.alert_key = a.alert_key);
  get diagnostics v_resolved = row_count;

  return jsonb_build_object('opened', v_opened, 'resolved', v_resolved,
    'active', (select count(*) from public.inventory_alerts where company_id = v_company and status in ('OPEN', 'ACKNOWLEDGED')));
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Reorder planning (days of cover)
-- status: NOT_CONFIGURED (no reorder level in days), NO_CONSUMPTION (nothing
-- issued in the window: cover cannot be calculated), REORDER (cover at or
-- below the reorder level), OK. suggested_quantity brings the cover, after
-- what is already on order, up to lead time + reorder level (whole pieces are
-- rounded up); 0 means the open orders already cover it.
-- -----------------------------------------------------------------------------
create or replace function public.inventory_reorder_plan(p_history_days int default 90)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory.read');
  v_days    int := coalesce(p_history_days, 90);
  v_rows    jsonb;
begin
  if v_days < 7 or v_days > 365 then
    raise exception 'The consumption history must be between 7 and 365 days.' using errcode = 'P0001';
  end if;

  with prod as (
    select p.id, p.sku, p.product_name, p.base_unit, p.product_type, p.lead_time_days, p.reorder_level_days, p.reorder_level,
      coalesce(s.on_hand, 0) as on_hand, coalesce(s.reserved, 0) as reserved, coalesce(s.available, 0) as available
    from public.products p
    left join (
      select b.product_id,
        sum(b.on_hand) filter (where l.stock_usage = 'STORAGE') as on_hand,
        sum(b.reserved) filter (where l.stock_usage = 'STORAGE') as reserved,
        sum(b.on_hand - b.reserved) filter (where l.stock_usage = 'STORAGE') as available
      from public.inventory_balances b join public.inventory_locations l on l.id = b.location_id
      where b.company_id = v_company group by b.product_id
    ) s on s.product_id = p.id
    where p.company_id = v_company and p.status = 'ACTIVE' and p.archived_at is null
  ),
  inc as (
    select v.product_id, sum(v.pending_quantity) as incoming, count(distinct v.purchase_order_id) as open_orders
    from public.purchase_order_line_list v
    join public.purchase_orders o on o.id = v.purchase_order_id
    where o.company_id = v_company and o.status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED')
      and v.line_type = 'GOODS' and v.product_id is not null and v.pending_quantity > 0
    group by v.product_id
  ),
  calc as (
    select prod.*, coalesce(inc.incoming, 0) as incoming, coalesce(inc.open_orders, 0) as open_orders,
      c.consumed, c.observed_days,
      case when c.consumed > 0 then c.consumed / c.observed_days end as avg_daily
    from prod
    left join inc on inc.product_id = prod.id
    cross join lateral private.product_consumption(prod.id, v_days) c
  ),
  graded as (
    select calc.*,
      case when avg_daily is not null then available / avg_daily end as cover,
      case when avg_daily is not null then (available + incoming) / avg_daily end as cover_incoming,
      case
        when reorder_level_days is null then 'NOT_CONFIGURED'
        when avg_daily is null then 'NO_CONSUMPTION'
        when available / avg_daily <= reorder_level_days then 'REORDER'
        else 'OK' end as status
    from calc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', id, 'sku', sku, 'product_name', product_name, 'unit', base_unit, 'product_type', product_type,
      'on_hand', on_hand, 'reserved', reserved, 'available', available, 'incoming', incoming, 'open_orders', open_orders,
      'consumed', consumed, 'observed_days', observed_days, 'limited_history', observed_days < least(v_days, 14),
      'avg_daily', round(avg_daily, 3),
      'coverage_days', round(cover, 1), 'coverage_with_incoming_days', round(cover_incoming, 1),
      'lead_time_days', lead_time_days, 'reorder_level_days', reorder_level_days, 'legacy_reorder_quantity', reorder_level,
      'runs_out_within_lead_time', lead_time_days is not null and cover is not null and cover < lead_time_days,
      'status', status,
      'suggested_quantity', case when status = 'REORDER' then
        private.plan_qty(greatest(avg_daily * (coalesce(lead_time_days, 0) + reorder_level_days) - (available + incoming), 0), base_unit) end)
    order by case status when 'REORDER' then 0 when 'OK' then 1 when 'NO_CONSUMPTION' then 2 else 3 end, cover nulls last, sku), '[]'::jsonb)
  into v_rows
  from graded;

  return jsonb_build_object('history_days', v_days, 'as_of', now(), 'rows', v_rows,
    'summary', jsonb_build_object(
      'reorder', (select count(*) from jsonb_array_elements(v_rows) r where r ->> 'status' = 'REORDER'),
      'ok', (select count(*) from jsonb_array_elements(v_rows) r where r ->> 'status' = 'OK'),
      'no_consumption', (select count(*) from jsonb_array_elements(v_rows) r where r ->> 'status' = 'NO_CONSUMPTION'),
      'not_configured', (select count(*) from jsonb_array_elements(v_rows) r where r ->> 'status' = 'NOT_CONFIGURED')));
end;
$$;

revoke all on function public.inventory_reorder_plan(int) from public, anon;
grant execute on function public.inventory_reorder_plan(int) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Supplier invoice and challan references
-- -----------------------------------------------------------------------------
create table if not exists public.purchase_document_refs (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references public.companies (id) on delete restrict,
  supplier_id             uuid,
  purchase_order_id       uuid,
  goods_receipt_id        uuid,
  supplier_invoice_number text check (supplier_invoice_number is null or length(btrim(supplier_invoice_number)) between 1 and 100),
  supplier_challan_number text check (supplier_challan_number is null or length(btrim(supplier_challan_number)) between 1 and 100),
  created_by              uuid,
  updated_by              uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint purchase_document_refs_target check (purchase_order_id is not null or goods_receipt_id is not null),
  constraint purchase_document_refs_supplier_fk foreign key (supplier_id, company_id) references public.suppliers (id, company_id) on delete restrict,
  constraint purchase_document_refs_po_fk foreign key (purchase_order_id, company_id) references public.purchase_orders (id, company_id) on delete restrict,
  constraint purchase_document_refs_grn_fk foreign key (goods_receipt_id, company_id) references public.goods_receipts (id, company_id) on delete restrict
);

comment on table public.purchase_document_refs is
  'Supplier invoice and challan numbers. One row per purchase order (order level, goods_receipt_id null) and one per goods receipt. Written only by purchase functions.';

create unique index if not exists purchase_document_refs_grn_unique on public.purchase_document_refs (goods_receipt_id) where goods_receipt_id is not null;
create unique index if not exists purchase_document_refs_po_unique on public.purchase_document_refs (purchase_order_id) where goods_receipt_id is null;
create index if not exists purchase_document_refs_po_idx on public.purchase_document_refs (purchase_order_id) where purchase_order_id is not null;
create index if not exists purchase_document_refs_invoice_idx on public.purchase_document_refs (company_id, lower(supplier_invoice_number))
  where supplier_invoice_number is not null;
create index if not exists purchase_document_refs_challan_idx on public.purchase_document_refs (company_id, lower(supplier_challan_number))
  where supplier_challan_number is not null;

alter table public.purchase_document_refs enable row level security;
revoke all on public.purchase_document_refs from anon, authenticated;
grant select on public.purchase_document_refs to authenticated;
grant all on public.purchase_document_refs to service_role;

drop policy if exists purchase_document_refs_select on public.purchase_document_refs;
create policy purchase_document_refs_select on public.purchase_document_refs for select to authenticated
  using (private.has_permission(company_id, 'purchases.read'));

drop trigger if exists purchase_document_refs_set_updated_at on public.purchase_document_refs;
create trigger purchase_document_refs_set_updated_at before update on public.purchase_document_refs
  for each row execute function private.set_updated_at();

-- Saves the references of one order (p_grn null) or one goods receipt.
-- p_refs: {supplier_invoice_number?, supplier_challan_number?}; a key that is
-- missing keeps the stored value, an empty value clears it.
create or replace function private.save_purchase_refs(p_company uuid, p_po uuid, p_grn uuid, p_refs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r        jsonb := coalesce(p_refs, '{}'::jsonb);
  v_po       public.purchase_orders;
  v_grn      public.goods_receipts;
  v_old      public.purchase_document_refs;
  v_supplier uuid;
  v_po_id    uuid;
  v_inv      text;
  v_dc       text;
  v_clash    text;
begin
  if p_grn is not null then
    select * into v_grn from public.goods_receipts where id = p_grn and company_id = p_company;
    if not found then
      raise exception 'Goods receipt not found in your company.' using errcode = 'P0001';
    end if;
    v_supplier := v_grn.supplier_id;
    v_po_id := v_grn.purchase_order_id;
    select * into v_old from public.purchase_document_refs where goods_receipt_id = p_grn;
  else
    select * into v_po from public.purchase_orders where id = p_po and company_id = p_company;
    if not found then
      raise exception 'Purchase order not found in your company.' using errcode = 'P0001';
    end if;
    v_supplier := v_po.supplier_id;
    v_po_id := v_po.id;
    select * into v_old from public.purchase_document_refs where purchase_order_id = p_po and goods_receipt_id is null;
  end if;

  v_inv := case when v_r ? 'supplier_invoice_number' then nullif(btrim(coalesce(v_r ->> 'supplier_invoice_number', '')), '') else v_old.supplier_invoice_number end;
  v_dc := case when v_r ? 'supplier_challan_number' then nullif(btrim(coalesce(v_r ->> 'supplier_challan_number', '')), '') else v_old.supplier_challan_number end;
  if length(v_inv) > 100 or length(v_dc) > 100 then
    raise exception 'Supplier invoice and challan numbers are limited to 100 characters.' using errcode = 'P0001';
  end if;
  if v_inv ~ '[[:cntrl:]]' or v_dc ~ '[[:cntrl:]]' then
    raise exception 'Supplier invoice and challan numbers cannot contain line breaks or control characters.' using errcode = 'P0001';
  end if;

  -- Same supplier invoice number on another order / direct receipt of the same
  -- supplier (the order and its own receipts may share it).
  if v_inv is not null and v_supplier is not null then
    select coalesce(o.po_number, g.receipt_number) into v_clash
    from public.purchase_document_refs x
    left join public.purchase_orders o on o.id = x.purchase_order_id
    left join public.goods_receipts g on g.id = x.goods_receipt_id
    where x.company_id = p_company
      and lower(x.supplier_invoice_number) = lower(v_inv)
      and coalesce(g.supplier_id, o.supplier_id) = v_supplier
      and coalesce(x.purchase_order_id, x.goods_receipt_id) <> coalesce(v_po_id, p_grn)
      and (x.goods_receipt_id is null or g.status = 'POSTED')
      and (x.purchase_order_id is null or o.status <> 'CANCELLED')
    limit 1;
    if v_clash is not null then
      raise exception 'Supplier invoice % is already recorded for this supplier on %. Check the number; each supplier invoice can be recorded on one order or receipt.', v_inv, v_clash
        using errcode = 'P0001';
    end if;
  end if;

  if v_old.id is null then
    if v_inv is null and v_dc is null then
      return jsonb_build_object('supplier_invoice_number', null, 'supplier_challan_number', null, 'changed', false);
    end if;
    insert into public.purchase_document_refs (company_id, supplier_id, purchase_order_id, goods_receipt_id,
      supplier_invoice_number, supplier_challan_number, created_by, updated_by)
    values (p_company, v_supplier, v_po_id, p_grn, v_inv, v_dc, auth.uid(), auth.uid());
  elsif v_old.supplier_invoice_number is not distinct from v_inv and v_old.supplier_challan_number is not distinct from v_dc
        and v_old.supplier_id is not distinct from v_supplier then
    return jsonb_build_object('supplier_invoice_number', v_inv, 'supplier_challan_number', v_dc, 'changed', false);
  else
    update public.purchase_document_refs
    set supplier_invoice_number = v_inv, supplier_challan_number = v_dc, supplier_id = v_supplier, updated_by = auth.uid()
    where id = v_old.id;
  end if;

  perform private.write_audit_log(p_company, 'purchase.document_refs_saved',
    case when p_grn is null then 'purchase_order' else 'goods_receipt' end, coalesce(p_grn, p_po)::text,
    jsonb_build_object('supplier_invoice_number', v_inv, 'supplier_challan_number', v_dc,
      'previous_invoice_number', v_old.supplier_invoice_number, 'previous_challan_number', v_old.supplier_challan_number));
  if p_grn is null then
    perform private.log_purchase_event(p_company, v_po.id, 'DOCUMENT_REFS_UPDATED', v_po.status, v_po.status, null,
      jsonb_build_object('supplier_invoice_number', v_inv, 'supplier_challan_number', v_dc));
  end if;
  return jsonb_build_object('supplier_invoice_number', v_inv, 'supplier_challan_number', v_dc, 'changed', true);
end;
$$;

revoke all on function private.save_purchase_refs(uuid, uuid, uuid, jsonb) from public, anon, authenticated;

-- Add or correct the references later (e.g. when the invoice arrives).
-- Exactly one of p_purchase_order_id / p_goods_receipt_id.
create or replace function public.purchase_document_refs_set(p_purchase_order_id uuid, p_goods_receipt_id uuid, p_refs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_status  text;
begin
  if (p_purchase_order_id is null) = (p_goods_receipt_id is null) then
    raise exception 'Give either a purchase order or a goods receipt.' using errcode = 'P0001';
  end if;
  if p_goods_receipt_id is not null then
    v_company := private.require_any_permission(array['purchase_receipt.create', 'purchase_exception.approve']);
    select status into v_status from public.goods_receipts where id = p_goods_receipt_id and company_id = v_company;
    if v_status = 'REVERSED' then
      raise exception 'This goods receipt has been reversed; its references are kept as they were.' using errcode = 'P0001';
    end if;
  else
    v_company := private.require_any_permission(array['purchase_order.create', 'purchase_order.update', 'purchase_order.amend', 'purchase_receipt.create']);
  end if;
  return private.save_purchase_refs(v_company, p_purchase_order_id, p_goods_receipt_id, p_refs);
end;
$$;

-- Order save + order-level references in one transaction.
create or replace function public.purchase_order_save_refs(
  p_po_id               uuid,
  p_header              jsonb,
  p_lines               jsonb,
  p_expected_updated_at timestamptz default null,
  p_idempotency_key     uuid default null,
  p_refs                jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := public.purchase_order_save(p_po_id, p_header, p_lines, p_expected_updated_at, p_idempotency_key);
  if p_refs is not null then
    v_result := v_result || jsonb_build_object('refs',
      private.save_purchase_refs(private.current_company_id(), (v_result ->> 'po_id')::uuid, null, p_refs));
  end if;
  return v_result;
end;
$$;

-- Goods receipt against an order + its own references (header keys
-- supplier_invoice_number / supplier_challan_number).
create or replace function public.purchase_receipt_post_refs(p_po_id uuid, p_header jsonb, p_lines jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h      jsonb := coalesce(p_header, '{}'::jsonb);
  v_result jsonb;
begin
  v_result := public.purchase_receipt_post(p_po_id, v_h - 'supplier_invoice_number' - 'supplier_challan_number', p_lines, p_idempotency_key);
  if v_h ? 'supplier_invoice_number' or v_h ? 'supplier_challan_number' then
    v_result := v_result || jsonb_build_object('refs', private.save_purchase_refs(private.current_company_id(), null, (v_result ->> 'receipt_id')::uuid,
      jsonb_strip_nulls(jsonb_build_object('supplier_invoice_number', coalesce(v_h ->> 'supplier_invoice_number', ''),
        'supplier_challan_number', coalesce(v_h ->> 'supplier_challan_number', ''))) ));
  end if;
  return v_result;
end;
$$;

create or replace function public.goods_receipt_direct_post_refs(p_header jsonb, p_lines jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h      jsonb := coalesce(p_header, '{}'::jsonb);
  v_result jsonb;
begin
  v_result := public.goods_receipt_direct_post(v_h - 'supplier_invoice_number' - 'supplier_challan_number', p_lines, p_idempotency_key);
  if v_h ? 'supplier_invoice_number' or v_h ? 'supplier_challan_number' then
    v_result := v_result || jsonb_build_object('refs', private.save_purchase_refs(private.current_company_id(), null, (v_result ->> 'receipt_id')::uuid,
      jsonb_build_object('supplier_invoice_number', coalesce(v_h ->> 'supplier_invoice_number', ''),
        'supplier_challan_number', coalesce(v_h ->> 'supplier_challan_number', ''))));
  end if;
  return v_result;
end;
$$;

-- Correction: the corrected receipt gets the references given in the header,
-- or keeps those of the receipt it replaces.
create or replace function public.goods_receipt_correct_refs(p_receipt_id uuid, p_reason text, p_header jsonb, p_lines jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h      jsonb := coalesce(p_header, '{}'::jsonb);
  v_old    public.purchase_document_refs;
  v_result jsonb;
begin
  select * into v_old from public.purchase_document_refs
  where goods_receipt_id = p_receipt_id and company_id = private.current_company_id();
  v_result := public.goods_receipt_correct(p_receipt_id, p_reason, v_h - 'supplier_invoice_number' - 'supplier_challan_number', p_lines, p_idempotency_key);
  v_result := v_result || jsonb_build_object('refs', private.save_purchase_refs(private.current_company_id(), null, (v_result ->> 'receipt_id')::uuid,
    jsonb_build_object(
      'supplier_invoice_number', case when v_h ? 'supplier_invoice_number' then coalesce(v_h ->> 'supplier_invoice_number', '') else coalesce(v_old.supplier_invoice_number, '') end,
      'supplier_challan_number', case when v_h ? 'supplier_challan_number' then coalesce(v_h ->> 'supplier_challan_number', '') else coalesce(v_old.supplier_challan_number, '') end)));
  return v_result;
end;
$$;

revoke all on function public.purchase_document_refs_set(uuid, uuid, jsonb) from public, anon;
revoke all on function public.purchase_order_save_refs(uuid, jsonb, jsonb, timestamptz, uuid, jsonb) from public, anon;
revoke all on function public.purchase_receipt_post_refs(uuid, jsonb, jsonb, uuid) from public, anon;
revoke all on function public.goods_receipt_direct_post_refs(jsonb, jsonb, uuid) from public, anon;
revoke all on function public.goods_receipt_correct_refs(uuid, text, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.purchase_document_refs_set(uuid, uuid, jsonb) to authenticated;
grant execute on function public.purchase_order_save_refs(uuid, jsonb, jsonb, timestamptz, uuid, jsonb) to authenticated;
grant execute on function public.purchase_receipt_post_refs(uuid, jsonb, jsonb, uuid) to authenticated;
grant execute on function public.goods_receipt_direct_post_refs(jsonb, jsonb, uuid) to authenticated;
grant execute on function public.goods_receipt_correct_refs(uuid, text, jsonb, jsonb, uuid) to authenticated;

-- Lists with the references. New views, so the existing purchase_order_list
-- and goods_receipt_list (and the migrations that define them) stay exactly
-- as they are. goods_receipt_list_v2 does not depend on goods_receipt_list,
-- which 20261104090000 drops and recreates.
create or replace view public.purchase_order_list_v2
with (security_invoker = true) as
select l.*,
  pr.supplier_invoice_number,
  pr.supplier_challan_number,
  gr.invoice_numbers as receipt_invoice_numbers,
  gr.challan_numbers as receipt_challan_numbers
from public.purchase_order_list l
left join public.purchase_document_refs pr on pr.purchase_order_id = l.id and pr.goods_receipt_id is null
left join (
  select x.purchase_order_id,
    string_agg(distinct x.supplier_invoice_number, ', ') as invoice_numbers,
    string_agg(distinct x.supplier_challan_number, ', ') as challan_numbers
  from public.purchase_document_refs x join public.goods_receipts g on g.id = x.goods_receipt_id
  where g.status = 'POSTED'
  group by x.purchase_order_id
) gr on gr.purchase_order_id = l.id;

create or replace view public.goods_receipt_list_v2
with (security_invoker = true) as
select r.*, o.po_number, coalesce(o.supplier_name, s.legal_name) as supplier_name, coalesce(o.supplier_code, s.supplier_code) as supplier_code,
  coalesce(o.warehouse_code, w.warehouse_code) as warehouse_code,
  coalesce(x.lines, 0) as line_count, coalesce(x.received, 0) as total_received, coalesce(x.accepted, 0) as total_accepted, coalesce(x.rejected, 0) as total_rejected,
  dr.supplier_invoice_number,
  dr.supplier_challan_number
from public.goods_receipts r
left join public.purchase_orders o on o.id = r.purchase_order_id
left join public.suppliers s on s.id = r.supplier_id
left join public.warehouses w on w.id = r.warehouse_id
left join (
  select goods_receipt_id, count(*) as lines, sum(received_quantity) as received, sum(accepted_quantity) as accepted, sum(rejected_quantity) as rejected
  from public.goods_receipt_lines group by goods_receipt_id
) x on x.goods_receipt_id = r.id
left join public.purchase_document_refs dr on dr.goods_receipt_id = r.id;

revoke all on public.purchase_order_list_v2, public.goods_receipt_list_v2 from anon, authenticated;
grant select on public.purchase_order_list_v2, public.goods_receipt_list_v2 to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Reports: erp_report plus the new fields, and the reorder planning report
-- -----------------------------------------------------------------------------
create or replace function public.erp_report_v2(p_report text, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_r       text := upper(coalesce(p_report, ''));
  v_f       jsonb := coalesce(p_filters, '{}'::jsonb);
  v_search  text := nullif(btrim(coalesce(v_f ->> 'search', '')), '');
  v_company uuid;
  v_prod    uuid;
  v_out     jsonb;
  v_plan    jsonb;
  v_rows    jsonb;
begin
  if v_r = 'REORDER_PLANNING' then
    begin
      v_prod := nullif(v_f ->> 'product_id', '')::uuid;
    exception when others then
      raise exception 'Invalid report filters.' using errcode = 'P0001';
    end;
    v_plan := public.inventory_reorder_plan(coalesce(nullif(v_f ->> 'history_days', '')::int, 90));
    select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows from jsonb_array_elements(v_plan -> 'rows') r
    where v_prod is null or (r ->> 'product_id')::uuid = v_prod;
    v_out := jsonb_build_object('report', v_r, 'from', null, 'to', null, 'generated_at', now(), 'history_days', v_plan -> 'history_days');
  else
    v_out := public.erp_report(p_report, v_f - 'search');
    v_rows := coalesce(v_out -> 'rows', '[]'::jsonb);
    v_company := private.current_company_id();
    if v_r = 'PRODUCTS' then
      select coalesce(jsonb_agg(e.x || jsonb_build_object('mrp', p.mrp, 'lead_time_days', p.lead_time_days, 'reorder_level_days', p.reorder_level_days,
          'supplier_model_number', p.supplier_model_number, 'supplier_product_name', p.supplier_product_name,
          'length_cm', p.length_cm, 'width_cm', p.width_cm, 'height_cm', p.height_cm) order by e.n), '[]'::jsonb)
      into v_rows
      from jsonb_array_elements(v_rows) with ordinality e(x, n)
      left join public.products p on p.id = (e.x ->> 'id')::uuid and p.company_id = v_company;
    elsif v_r = 'LOW_STOCK' then
      select coalesce(jsonb_agg(e.x || jsonb_build_object('reorder_level_days', p.reorder_level_days, 'lead_time_days', p.lead_time_days) order by e.n), '[]'::jsonb)
      into v_rows
      from jsonb_array_elements(v_rows) with ordinality e(x, n)
      left join public.products p on p.id = (e.x ->> 'product_id')::uuid and p.company_id = v_company;
    elsif v_r = 'PURCHASE_REGISTER' then
      select coalesce(jsonb_agg(e.x || jsonb_build_object('supplier_invoice_number', l.supplier_invoice_number, 'supplier_challan_number', l.supplier_challan_number,
          'grn_invoice_numbers', l.receipt_invoice_numbers, 'grn_challan_numbers', l.receipt_challan_numbers) order by e.n), '[]'::jsonb)
      into v_rows
      from jsonb_array_elements(v_rows) with ordinality e(x, n)
      left join public.purchase_order_list_v2 l on l.id = (e.x ->> 'id')::uuid and l.company_id = v_company;
    elsif v_r = 'GRN_REGISTER' then
      select coalesce(jsonb_agg(e.x || jsonb_build_object('supplier_invoice_number', d.supplier_invoice_number, 'supplier_challan_number', d.supplier_challan_number,
          'supplier_document', g.supplier_document_number) order by e.n), '[]'::jsonb)
      into v_rows
      from jsonb_array_elements(v_rows) with ordinality e(x, n)
      left join public.goods_receipts g on g.id = (e.x ->> 'id')::uuid and g.company_id = v_company
      left join public.purchase_document_refs d on d.goods_receipt_id = g.id;
    end if;
  end if;

  if v_search is not null then
    select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows from jsonb_array_elements(v_rows) r
    where exists (select 1 from jsonb_each_text(r) e where e.key not in ('id', 'product_id', 'party_id', 'customer_id', 'supplier_id') and e.value ilike '%' || v_search || '%');
  end if;
  return v_out || jsonb_build_object('count', jsonb_array_length(v_rows), 'rows', v_rows);
end;
$$;

revoke all on function public.erp_report_v2(text, jsonb) from public, anon;
grant execute on function public.erp_report_v2(text, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. ERP reset: the references are purged before the orders and receipts
-- (same list as 20261103090000 plus purchase_document_refs).
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (0, 'amazon_ad_change_requests', 'Amazon', 'Amazon ad change requests'),
    (0, 'amazon_ad_groups', 'Amazon', 'Amazon ad groups'),
    (0, 'amazon_ad_product_daily', 'Amazon', 'Amazon advertised-product daily data'),
    (0, 'amazon_budget_plans', 'Amazon', 'Amazon budget plans'),
    (0, 'amazon_campaign_daily', 'Amazon', 'Amazon campaign daily data'),
    (0, 'amazon_campaigns', 'Amazon', 'Amazon campaigns'),
    (0, 'amazon_inventory_snapshots', 'Amazon', 'Amazon inventory snapshots'),
    (0, 'amazon_listings', 'Amazon', 'Amazon listings'),
    (0, 'amazon_search_term_daily', 'Amazon', 'Amazon search-term daily data'),
    (0, 'amazon_sku_daily', 'Amazon', 'Amazon SKU daily sales'),
    (0, 'amazon_sync_errors', 'Amazon', 'Amazon sync errors'),
    (0, 'amazon_targets', 'Amazon', 'Amazon targets'),
    (0, 'approval_decisions', 'Approvals, notifications & imports', 'Approval decisions'),
    (0, 'billing_events', 'Billing & receivables', 'Billing history'),
    (0, 'bom_items', 'Production & BOMs', 'BOM components'),
    (0, 'customer_po_allocation_runs', 'Customer purchase orders', 'Customer PO allocation runs'),
    (0, 'customer_po_analysis_snapshots', 'Customer purchase orders', 'Customer PO analysis snapshots'),
    (0, 'customer_po_events', 'Customer purchase orders', 'Customer PO history'),
    (0, 'customer_po_shortage_notes', 'Customer purchase orders', 'Customer PO shortage notes'),
    (0, 'customer_product_codes', 'Customers & suppliers', 'Customer product codes'),
    (0, 'customer_return_lines', 'Sales & fulfilment', 'Customer return lines'),
    (0, 'delivery_events', 'Sales & fulfilment', 'Delivery history'),
    (0, 'goods_receipt_lines', 'Supplier purchasing', 'Goods receipt lines'),
    (0, 'import_job_rows', 'Approvals, notifications & imports', 'Import rows'),
    (0, 'inventory_adjustments', 'Inventory', 'Stock adjustments'),
    (0, 'inventory_alerts', 'Inventory', 'Stock alerts'),
    (0, 'inventory_balances', 'Inventory', 'Stock balances'),
    (0, 'inventory_count_lines', 'Inventory', 'Stock count lines'),
    (0, 'inventory_opening_lines', 'Inventory', 'Opening stock lines'),
    (0, 'inventory_requests', 'Inventory', 'Stock operation requests'),
    (0, 'invoice_adjustment_note_lines', 'Billing & receivables', 'Credit / debit note lines'),
    (0, 'invoice_payment_allocations', 'Billing & receivables', 'Payment allocations'),
    (0, 'notifications', 'Approvals, notifications & imports', 'Notifications'),
    (0, 'outsourcing_material_movements', 'Outsourcing', 'Outsourcing material movements'),
    (0, 'outsourcing_order_events', 'Outsourcing', 'Outsourcing history'),
    (0, 'production_material_consumption', 'Production & BOMs', 'Material issues'),
    (0, 'production_order_events', 'Production & BOMs', 'Production history'),
    (0, 'production_output_receipts', 'Production & BOMs', 'Production output'),
    (0, 'purchase_document_refs', 'Supplier purchasing', 'Supplier invoice / challan references'),
    (0, 'purchase_order_amendments', 'Supplier purchasing', 'Purchase order amendments'),
    (0, 'purchase_order_events', 'Supplier purchasing', 'Purchase order history'),
    (0, 'purchase_order_import_refs', 'Supplier purchasing', 'Purchase order import references'),
    (0, 'sales_invoice_dispatch_allocations', 'Billing & receivables', 'Invoice dispatch allocations'),
    (0, 'sales_order_events', 'Sales & fulfilment', 'Sales order history'),
    (1, 'amazon_recommendations', 'Amazon', 'Amazon recommendations'),
    (1, 'amazon_sync_jobs', 'Amazon', 'Amazon sync jobs'),
    (1, 'approval_requests', 'Approvals, notifications & imports', 'Approval requests'),
    (1, 'customer_payments', 'Billing & receivables', 'Customer payments'),
    (1, 'supplier_payments', 'Customers & suppliers', 'Supplier payments'),
    (1, 'goods_receipts', 'Supplier purchasing', 'Goods receipts'),
    (1, 'import_jobs', 'Approvals, notifications & imports', 'Import jobs'),
    (1, 'inventory_counts', 'Inventory', 'Stock counts'),
    (1, 'inventory_opening_batches', 'Inventory', 'Opening stock documents'),
    (1, 'invoice_adjustment_notes', 'Billing & receivables', 'Credit / debit notes'),
    (1, 'outsourcing_order_materials', 'Outsourcing', 'Outsourcing material plans'),
    (1, 'outsourcing_receipts', 'Outsourcing', 'Outsourcing receipts'),
    (1, 'production_order_materials', 'Production & BOMs', 'Production material plans'),
    (1, 'purchase_order_lines', 'Supplier purchasing', 'Purchase order lines'),
    (1, 'sales_invoice_lines', 'Billing & receivables', 'Invoice lines'),
    (2, 'customer_returns', 'Sales & fulfilment', 'Customer returns'),
    (2, 'parties', 'Customers & suppliers', 'Ledger parties'),
    (2, 'fulfilment_lines', 'Sales & fulfilment', 'Fulfilment lines'),
    (2, 'outsourcing_orders', 'Outsourcing', 'Outsourcing orders'),
    (2, 'production_orders', 'Production & BOMs', 'Production orders'),
    (2, 'purchase_orders', 'Supplier purchasing', 'Supplier purchase orders'),
    (2, 'sales_invoices', 'Billing & receivables', 'Sales invoices'),
    (3, 'boms', 'Production & BOMs', 'Bills of materials'),
    (3, 'fulfilments', 'Sales & fulfilment', 'Fulfilments and dispatches'),
    (3, 'inventory_transactions', 'Inventory', 'Stock ledger'),
    (3, 'sales_order_lines', 'Sales & fulfilment', 'Sales order lines'),
    (3, 'stock_reservations', 'Inventory', 'Stock reservations'),
    (3, 'suppliers', 'Customers & suppliers', 'Suppliers'),
    (4, 'customer_purchase_order_lines', 'Customer purchase orders', 'Customer PO lines'),
    (4, 'inventory_batches', 'Inventory', 'Stock batches / lots'),
    (4, 'sales_orders', 'Sales & fulfilment', 'Sales orders'),
    (5, 'customer_purchase_orders', 'Customer purchase orders', 'Customer purchase orders'),
    (6, 'customer_po_import_batches', 'Customer purchase orders', 'Customer PO import batches'),
    (6, 'customers', 'Customers & suppliers', 'Customers')
  ) t (ord, table_name, category, label)
  union all
  select 0, 'demo_presentation_data', 'Demo data', 'Demo presentation data'
  where exists (select 1 from pg_catalog.pg_attribute a
                where a.attrelid = to_regclass('public.demo_presentation_data') and a.attname = 'company_id' and not a.attisdropped);
$$;

revoke all on function private.erp_reset_tables() from public, anon, authenticated;
