-- =============================================================================
-- ROLLBACK of 20261109090000_product_purchase_enhancements.sql
--
-- Restores the previous definitions (copied from 20261013090100 and
-- 20261103090000) and removes everything the migration added: the new product
-- columns, the supplier invoice / challan references table, the day-based
-- planning functions, the wrappers, the v2 list views and erp_report_v2.
--
-- SAFETY: the new columns and the references table may hold data entered
-- after the migration. The rollback refuses to run while any such data exists
-- unless you first run, in the same session:
--     select set_config('app.rollback_discard_new_data', 'yes', false);
-- Export the data first (products export / GRN register) if it must be kept.
-- Nothing else is changed: products, orders, receipts and stock are untouched.
-- =============================================================================

do $$
begin
  if coalesce(current_setting('app.rollback_discard_new_data', true), '') <> 'yes' and (
       exists (select 1 from public.products where lead_time_days is not null or reorder_level_days is not null or mrp is not null
               or length_cm is not null or width_cm is not null or height_cm is not null
               or supplier_model_number is not null or supplier_product_name is not null)
       or exists (select 1 from public.purchase_document_refs)) then
    raise exception 'Rollback stopped: products or purchase references hold values entered after the migration. Export them, then set app.rollback_discard_new_data = yes to continue.';
  end if;
end;
$$;

-- 1. Previous definitions
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
    when p.reorder_level is null then 'NO_THRESHOLD'
    when coalesce(s.available, 0) <= p.reorder_level then 'LOW_STOCK'
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
  active as (select * from ps where status = 'ACTIVE'),
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
    'low_stock', (select count(*) from active where available > 0 and reorder_level is not null and available <= reorder_level),
    'healthy', (select count(*) from active where available > 0 and reorder_level is not null and available > reorder_level),
    'no_threshold', (select count(*) from active where available > 0 and reorder_level is null),
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
      'reserved', s.reserved, 'available', s.on_hand - s.reserved, 'reorder_level', p.reorder_level)
  from public.products p
  join lateral (
    select coalesce(sum(b.on_hand), 0) as on_hand, coalesce(sum(b.reserved), 0) as reserved
    from public.inventory_balances b
    join public.inventory_locations l on l.id = b.location_id and l.stock_usage = 'STORAGE'
    where b.product_id = p.id
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

-- 2. Added objects
drop function if exists public.erp_report_v2(text, jsonb);
drop view if exists public.purchase_order_list_v2;
drop view if exists public.goods_receipt_list_v2;
drop function if exists public.goods_receipt_correct_refs(uuid, text, jsonb, jsonb, uuid);
drop function if exists public.goods_receipt_direct_post_refs(jsonb, jsonb, uuid);
drop function if exists public.purchase_receipt_post_refs(uuid, jsonb, jsonb, uuid);
drop function if exists public.purchase_order_save_refs(uuid, jsonb, jsonb, timestamptz, uuid, jsonb);
drop function if exists public.purchase_document_refs_set(uuid, uuid, jsonb);
drop function if exists private.save_purchase_refs(uuid, uuid, uuid, jsonb);
drop table if exists public.purchase_document_refs;
drop function if exists public.inventory_reorder_plan(int);
drop function if exists private.reorder_by_days(uuid, numeric, numeric);
drop function if exists private.product_consumption(uuid, int);
drop index if exists public.inventory_tx_product_date_idx;

drop trigger if exists products_a_supplier_refs on public.products;
drop function if exists private.product_normalise_supplier_refs();
drop index if exists public.products_supplier_model_idx;
drop index if exists public.products_supplier_name_idx;
alter table public.products drop constraint if exists products_lead_time_days_check;
alter table public.products drop constraint if exists products_reorder_level_days_check;
alter table public.products drop constraint if exists products_mrp_check;
alter table public.products drop constraint if exists products_dimensions_check;
alter table public.products drop constraint if exists products_supplier_refs_check;
alter table public.products drop column if exists lead_time_days;
alter table public.products drop column if exists reorder_level_days;
alter table public.products drop column if exists mrp;
alter table public.products drop column if exists length_cm;
alter table public.products drop column if exists width_cm;
alter table public.products drop column if exists height_cm;
alter table public.products drop column if exists supplier_model_number;
alter table public.products drop column if exists supplier_product_name;

comment on column public.products.reorder_level is null;
comment on column public.products.minimum_level is 'Minimum stock to keep (optional). Reorder level is the point at which to buy or make more.';
