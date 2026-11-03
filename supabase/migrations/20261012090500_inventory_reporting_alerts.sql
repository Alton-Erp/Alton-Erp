-- =============================================================================
-- Phase 4: read views, reporting functions, reconciliation and alerts
--
-- Reporting timezone: the company's timezone (companies.timezone).
-- Transaction-date policy: inventory_transactions.transaction_date is the
-- effective time. Direct postings use the posting time; approved documents use
-- the start of their effective date (company timezone) when backdated.
-- "Stock as of D" = sum of posted ledger entries with transaction_date before
-- the start of D+1 (company timezone). Reversals are ledger entries and are
-- included at their own date. Unapproved/rejected documents are never in the
-- ledger, so they are excluded by construction.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Views (security_invoker: RLS of the underlying tables applies to the caller)
-- -----------------------------------------------------------------------------
create or replace view public.inventory_stock_detail
with (security_invoker = true) as
select
  b.id as balance_id, b.company_id, b.product_id, p.sku, p.product_name, p.barcode, p.category_id, c.name as category_name,
  p.product_type, p.default_source_type, p.base_unit, p.reorder_level, p.status as product_status,
  (p.archived_at is not null) as product_archived,
  b.batch_id, bt.batch_number, bt.is_system_lot, b.source_type, bt.manufacturing_date, bt.expiry_date,
  b.warehouse_id, w.warehouse_code, w.warehouse_name, w.status as warehouse_status,
  b.location_id, l.location_code, l.location_name, l.status as location_status,
  b.on_hand, b.reserved, (b.on_hand - b.reserved) as available, b.last_movement_at
from public.inventory_balances b
join public.products p on p.id = b.product_id
join public.inventory_batches bt on bt.id = b.batch_id
join public.warehouses w on w.id = b.warehouse_id
join public.inventory_locations l on l.id = b.location_id
left join public.product_categories c on c.id = p.category_id
where b.on_hand <> 0 or b.reserved <> 0;

create or replace view public.inventory_product_stock
with (security_invoker = true) as
select
  p.id as product_id, p.company_id, p.sku, p.product_name, p.barcode, p.brand, p.model_number, p.category_id,
  c.name as category_name, p.product_type, p.default_source_type, p.base_unit, p.reorder_level,
  p.status as product_status, p.archived_at, p.track_batches,
  coalesce(s.on_hand, 0) as on_hand,
  coalesce(s.reserved, 0) as reserved,
  coalesce(s.on_hand, 0) - coalesce(s.reserved, 0) as available,
  coalesce(s.in_house, 0) as in_house_on_hand,
  coalesce(s.outsourced, 0) as outsourced_on_hand,
  coalesce(s.unknown, 0) as unknown_source_on_hand,
  s.last_movement_at,
  exists (select 1 from public.inventory_transactions t where t.company_id = p.company_id and t.product_id = p.id) as has_history,
  case
    when coalesce(s.on_hand, 0) = 0 then 'OUT_OF_STOCK'
    when coalesce(s.on_hand, 0) - coalesce(s.reserved, 0) = 0 then 'FULLY_RESERVED'
    when p.reorder_level is null then 'NO_THRESHOLD'
    when coalesce(s.on_hand, 0) - coalesce(s.reserved, 0) <= p.reorder_level then 'LOW_STOCK'
    else 'HEALTHY'
  end as stock_status
from public.products p
left join public.product_categories c on c.id = p.category_id
left join (
  select product_id,
    sum(on_hand) as on_hand, sum(reserved) as reserved,
    sum(on_hand) filter (where source_type = 'IN_HOUSE') as in_house,
    sum(on_hand) filter (where source_type = 'OUTSOURCED') as outsourced,
    sum(on_hand) filter (where source_type = 'UNKNOWN') as unknown,
    max(last_movement_at) as last_movement_at
  from public.inventory_balances
  group by product_id
) s on s.product_id = p.id;

create or replace view public.inventory_transaction_list
with (security_invoker = true) as
select
  t.*, p.sku, p.product_name, bt.batch_number,
  w.warehouse_code, w.warehouse_name, l.location_code, l.location_name,
  case when t.direction = 1 then t.quantity end as quantity_in,
  case when t.direction = -1 then t.quantity end as quantity_out,
  pair.location_id as counterpart_location_id, pl.location_code as counterpart_location_code, pw.warehouse_code as counterpart_warehouse_code,
  r.id as reversed_by_transaction_id, r.transaction_number as reversed_by_number,
  orig.transaction_number as reversal_of_number
from public.inventory_transactions t
join public.products p on p.id = t.product_id
join public.inventory_batches bt on bt.id = t.batch_id
join public.warehouses w on w.id = t.warehouse_id
join public.inventory_locations l on l.id = t.location_id
left join public.inventory_transactions pair
  on t.transaction_type in ('TRANSFER_OUT', 'TRANSFER_IN') and pair.transfer_group_id = t.transfer_group_id
  and pair.id <> t.id and pair.transaction_type in ('TRANSFER_OUT', 'TRANSFER_IN')
left join public.inventory_locations pl on pl.id = pair.location_id
left join public.warehouses pw on pw.id = pair.warehouse_id
left join public.inventory_transactions r on r.reversal_of_transaction_id = t.id
left join public.inventory_transactions orig on orig.id = t.reversal_of_transaction_id;

revoke all on public.inventory_stock_detail, public.inventory_product_stock, public.inventory_transaction_list from anon, authenticated;
grant select on public.inventory_stock_detail, public.inventory_product_stock, public.inventory_transaction_list to authenticated;

-- -----------------------------------------------------------------------------
-- Overview (current position) — inventory.read
-- Quantities are always grouped by unit: different units are never summed.
-- Archived products are excluded from current-position figures.
-- -----------------------------------------------------------------------------
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
    select p.id, p.base_unit, p.reorder_level, p.status, p.category_id,
      coalesce(s.on_hand, 0) as on_hand, coalesce(s.reserved, 0) as reserved,
      exists (select 1 from public.inventory_transactions t where t.company_id = v_company and t.product_id = p.id) as has_history
    from public.products p
    left join (select product_id, sum(on_hand) on_hand, sum(reserved) reserved
               from public.inventory_balances where company_id = v_company group by product_id) s on s.product_id = p.id
    where p.company_id = v_company and p.archived_at is null
  ),
  active as (select * from ps where status = 'ACTIVE'),
  bal as (
    select b.*, p.base_unit, p.category_id from public.inventory_balances b
    join public.products p on p.id = b.product_id
    where b.company_id = v_company and p.archived_at is null and (b.on_hand <> 0 or b.reserved <> 0)
  )
  select jsonb_build_object(
    'active_products', (select count(*) from active),
    'products_with_stock', (select count(*) from active where on_hand > 0),
    'never_stocked', (select count(*) from active where on_hand = 0 and not has_history),
    'out_of_stock', (select count(*) from active where on_hand = 0 and has_history),
    'fully_reserved', (select count(*) from active where on_hand > 0 and on_hand - reserved = 0),
    'low_stock', (select count(*) from active where on_hand > 0 and on_hand - reserved > 0 and reorder_level is not null and on_hand - reserved <= reorder_level),
    'healthy', (select count(*) from active where on_hand > 0 and reorder_level is not null and on_hand - reserved > reorder_level),
    'no_threshold', (select count(*) from active where on_hand > 0 and on_hand - reserved > 0 and reorder_level is null),
    'units', coalesce((
      select jsonb_agg(u order by u ->> 'unit') from (
        select jsonb_build_object('unit', base_unit,
          'on_hand', sum(on_hand), 'reserved', sum(reserved), 'available', sum(on_hand - reserved),
          'in_house', coalesce(sum(on_hand) filter (where source_type = 'IN_HOUSE'), 0),
          'outsourced', coalesce(sum(on_hand) filter (where source_type = 'OUTSOURCED'), 0),
          'unknown', coalesce(sum(on_hand) filter (where source_type = 'UNKNOWN'), 0)) as u
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

-- Movements within a period (excludes internal transfers), by bucket and unit.
create or replace function public.inventory_movement_trend(p_from date, p_to date, p_bucket text default 'day')
returns table (bucket date, unit text, quantity_in numeric, quantity_out numeric, transactions bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory.read');
  v_tz      text := private.company_tz(v_company);
begin
  if p_bucket not in ('day', 'week', 'month', 'year') then
    raise exception 'Bucket must be day, week, month or year.' using errcode = 'P0001';
  end if;
  if p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Choose a valid date range (at most about 10 years).' using errcode = 'P0001';
  end if;
  return query
  select date_trunc(p_bucket, t.transaction_date at time zone v_tz)::date,
    t.unit,
    coalesce(sum(t.quantity) filter (where t.direction = 1), 0),
    coalesce(sum(t.quantity) filter (where t.direction = -1), 0),
    count(*)
  from public.inventory_transactions t
  where t.company_id = v_company
    and t.transaction_type not in ('TRANSFER_OUT', 'TRANSFER_IN')
    and not (t.transaction_type = 'REVERSAL' and t.transfer_group_id is not null)
    and t.transaction_date >= private.company_day_start(v_company, p_from)
    and t.transaction_date < private.company_day_start(v_company, p_to + 1)
  group by 1, 2
  order by 1, 2;
end;
$$;

-- Stock as of the end of a date (company timezone), from the ledger only.
create or replace function public.inventory_stock_as_of(p_cutoff date)
returns table (
  product_id uuid, sku text, product_name text, unit text, category_name text,
  warehouse_code text, warehouse_name text, location_code text, batch_number text, source_type text, quantity numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory_reports.read');
begin
  if p_cutoff is null or p_cutoff > private.company_today(v_company) then
    raise exception 'Choose a cutoff date that is not in the future.' using errcode = 'P0001';
  end if;
  return query
  select t.product_id, p.sku, p.product_name, p.base_unit, c.name, w.warehouse_code, w.warehouse_name, l.location_code,
    bt.batch_number, bt.source_type, sum(t.quantity * t.direction)
  from public.inventory_transactions t
  join public.products p on p.id = t.product_id
  left join public.product_categories c on c.id = p.category_id
  join public.warehouses w on w.id = t.warehouse_id
  join public.inventory_locations l on l.id = t.location_id
  join public.inventory_batches bt on bt.id = t.batch_id
  where t.company_id = v_company
    and t.transaction_date < private.company_day_start(v_company, p_cutoff + 1)
  group by t.product_id, p.sku, p.product_name, p.base_unit, c.name, w.warehouse_code, w.warehouse_name, l.location_code,
    bt.batch_number, bt.source_type
  having sum(t.quantity * t.direction) <> 0
  order by p.sku, w.warehouse_code, l.location_code;
end;
$$;

-- Valuation: lot-level weighted average cost of costed inflows. Lots with any
-- uncosted inflow have unknown cost (never valued at zero).
create or replace function public.inventory_valuation()
returns table (
  product_id uuid, sku text, product_name text, unit text, category_name text, source_type text,
  warehouse_code text, location_code text, batch_number text, on_hand numeric, unit_cost numeric, value numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory_reports.read');
begin
  return query
  select b.product_id, p.sku, p.product_name, p.base_unit, c.name, b.source_type, w.warehouse_code, l.location_code,
    bt.batch_number, b.on_hand, x.cost, round(b.on_hand * x.cost, 2)
  from public.inventory_balances b
  join public.products p on p.id = b.product_id
  left join public.product_categories c on c.id = p.category_id
  join public.inventory_batches bt on bt.id = b.batch_id
  join public.warehouses w on w.id = b.warehouse_id
  join public.inventory_locations l on l.id = b.location_id
  cross join lateral (select private.lot_average_cost(b.batch_id) as cost) x
  where b.company_id = v_company and b.on_hand > 0
  order by p.sku;
end;
$$;

-- Ledger vs derived balances (and reservations vs reserved).
create or replace function public.inventory_reconcile()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory_reconciliation.run');
  v_result  jsonb;
begin
  with ledger as (
    select batch_id, location_id, sum(quantity * direction) as qty
    from public.inventory_transactions where company_id = v_company group by batch_id, location_id
  ),
  res as (
    select batch_id, location_id, sum(quantity - fulfilled_quantity - released_quantity) as qty
    from public.stock_reservations
    where company_id = v_company and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
    group by batch_id, location_id
  ),
  combined as (
    select coalesce(b.batch_id, l.batch_id) as batch_id, coalesce(b.location_id, l.location_id) as location_id,
      coalesce(b.on_hand, 0) as balance_on_hand, coalesce(l.qty, 0) as ledger_on_hand,
      coalesce(b.reserved, 0) as balance_reserved, coalesce(r.qty, 0) as reservations_open
    from (select * from public.inventory_balances where company_id = v_company) b
    full join ledger l on l.batch_id = b.batch_id and l.location_id = b.location_id
    left join res r on r.batch_id = coalesce(b.batch_id, l.batch_id) and r.location_id = coalesce(b.location_id, l.location_id)
  )
  select jsonb_build_object(
    'checked', (select count(*) from combined),
    'checked_at', now(),
    'mismatches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku', p.sku, 'batch_number', bt.batch_number, 'source_type', bt.source_type, 'location_code', loc.location_code,
        'balance_on_hand', m.balance_on_hand, 'ledger_on_hand', m.ledger_on_hand,
        'balance_reserved', m.balance_reserved, 'reservations_open', m.reservations_open))
      from combined m
      join public.inventory_batches bt on bt.id = m.batch_id
      join public.products p on p.id = bt.product_id
      join public.inventory_locations loc on loc.id = m.location_id
      where m.balance_on_hand <> m.ledger_on_hand or m.balance_reserved <> m.reservations_open), '[]'::jsonb)
  ) into v_result;
  perform 1;
  return v_result;
end;
$$;

create or replace function public.inventory_policy_info()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory.read');
begin
  return private.inventory_policy(v_company) || jsonb_build_object(
    'timezone', private.company_tz(v_company),
    'today', private.company_today(v_company),
    'negative_stock_allowed', false);
end;
$$;

-- Barcode / SKU lookup for scanners (keyboard wedge). RLS applies (invoker).
create or replace function public.inventory_find_product_by_code(p_code text)
returns table (product_id uuid, sku text, product_name text, base_unit text, track_batches boolean, track_expiry boolean,
               product_status text, matched_on text)
language sql
stable
security invoker
set search_path = ''
as $$
  select p.id, p.sku, p.product_name, p.base_unit, p.track_batches, p.track_expiry, p.status,
    case when p.barcode = btrim(p_code) then 'BARCODE' else 'SKU' end
  from public.products p
  where p.company_id = private.current_company_id()
    and p.archived_at is null
    and length(btrim(coalesce(p_code, ''))) > 0
    and (p.barcode = btrim(p_code) or lower(p.sku) = lower(btrim(p_code)))
  limit 5;
$$;

-- -----------------------------------------------------------------------------
-- Alerts
-- -----------------------------------------------------------------------------
create table if not exists public.inventory_alerts (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete restrict,
  alert_key         text not null,
  alert_type        text not null check (alert_type in ('LOW_STOCK', 'OUT_OF_STOCK', 'FULLY_RESERVED', 'EXPIRED', 'EXPIRING', 'INVALID_LOCATION', 'UNKNOWN_SOURCE')),
  severity          text not null check (severity in ('CRITICAL', 'WARNING', 'INFO')),
  product_id        uuid,
  batch_id          uuid,
  warehouse_id      uuid,
  location_id       uuid,
  details           jsonb not null default '{}'::jsonb,
  status            text not null default 'OPEN' check (status in ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  first_detected_at timestamptz not null default now(),
  last_detected_at  timestamptz not null default now(),
  acknowledged_by   uuid,
  acknowledged_at   timestamptz,
  acknowledgement_note text check (acknowledgement_note is null or length(acknowledgement_note) <= 500),
  resolved_at       timestamptz,
  -- Integration point for a future notification service (email/WhatsApp):
  -- deliver OPEN alerts with notified_at IS NULL, then set notified_at.
  notified_at       timestamptz
);

-- At most one active alert per condition; resolved alerts are kept as history.
create unique index if not exists inventory_alerts_active_unique
  on public.inventory_alerts (company_id, alert_key) where status in ('OPEN', 'ACKNOWLEDGED');
create index if not exists inventory_alerts_company_idx on public.inventory_alerts (company_id, status, severity);

alter table public.inventory_alerts enable row level security;
revoke all on table public.inventory_alerts from anon, authenticated;
grant select on public.inventory_alerts to authenticated;
grant all on table public.inventory_alerts to service_role;
drop policy if exists inventory_alerts_select on public.inventory_alerts;
create policy inventory_alerts_select on public.inventory_alerts for select to authenticated
  using (private.has_permission(company_id, 'inventory.read'));

-- Re-evaluates alert conditions from real balances. Idempotent: refreshing
-- never duplicates an active alert; conditions that cleared are RESOLVED.
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

  -- Product-level stock conditions (active products only).
  insert into pg_temp.current_alerts
  select
    case when s.on_hand = 0 then 'OUT_OF_STOCK:' when s.on_hand - s.reserved = 0 then 'FULLY_RESERVED:' else 'LOW_STOCK:' end || p.id,
    case when s.on_hand = 0 then 'OUT_OF_STOCK' when s.on_hand - s.reserved = 0 then 'FULLY_RESERVED' else 'LOW_STOCK' end,
    case when s.on_hand - s.reserved = 0 then 'CRITICAL' else 'WARNING' end,
    p.id, null, null, null,
    jsonb_build_object('sku', p.sku, 'product_name', p.product_name, 'unit', p.base_unit, 'on_hand', s.on_hand,
      'reserved', s.reserved, 'available', s.on_hand - s.reserved, 'reorder_level', p.reorder_level)
  from public.products p
  join lateral (
    select coalesce(sum(b.on_hand), 0) as on_hand, coalesce(sum(b.reserved), 0) as reserved
    from public.inventory_balances b where b.product_id = p.id
  ) s on true
  where p.company_id = v_company and p.status = 'ACTIVE' and p.archived_at is null
    and (
      (s.on_hand - s.reserved = 0 and (p.reorder_level is not null
        or exists (select 1 from public.inventory_transactions t where t.company_id = v_company and t.product_id = p.id)))
      or (s.on_hand - s.reserved > 0 and p.reorder_level is not null and s.on_hand - s.reserved <= p.reorder_level)
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

create or replace function public.inventory_acknowledge_alert(p_alert_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory_alerts.acknowledge');
  v_alert   public.inventory_alerts;
begin
  select * into v_alert from public.inventory_alerts where id = p_alert_id and company_id = v_company for update;
  if not found then raise exception 'Alert not found in your company.' using errcode = 'P0001'; end if;
  if v_alert.status <> 'OPEN' then raise exception 'Only open alerts can be acknowledged.' using errcode = 'P0001'; end if;
  update public.inventory_alerts
  set status = 'ACKNOWLEDGED', acknowledged_by = auth.uid(), acknowledged_at = now(),
      acknowledgement_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = v_alert.id;
  perform private.write_audit_log(v_company, 'inventory.alert_acknowledged', 'inventory_alert', v_alert.id::text,
    jsonb_build_object('alert_type', v_alert.alert_type, 'alert_key', v_alert.alert_key));
  return jsonb_build_object('status', 'ACKNOWLEDGED');
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.inventory_overview()',
    'public.inventory_movement_trend(date, date, text)',
    'public.inventory_stock_as_of(date)',
    'public.inventory_valuation()',
    'public.inventory_reconcile()',
    'public.inventory_policy_info()',
    'public.inventory_find_product_by_code(text)',
    'public.inventory_refresh_alerts()',
    'public.inventory_acknowledge_alert(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
