-- =============================================================================
-- Phase 9: executive dashboard & business analytics (read-only)
--
-- Every function below only READS the operational tables of Phases 3-8. No
-- analytics copy of orders, stock, invoices or payments is kept: the existing
-- tables, views and Phase 4-8 helper functions remain the single source of
-- truth, so a figure on the dashboard always matches the source module.
--
-- Security
--   * Each public function is SECURITY DEFINER, derives the caller's company
--     from the session (private.current_company_id via require_permission) and
--     filters every query by that company. No company id is accepted from the
--     client, so cross-company data cannot be requested.
--   * Each section is returned only when the caller holds the existing module
--     permission (no new roles or permissions are introduced):
--       sales            sales_orders.read
--       billing          billing_reports.read   (receipt lists: payments.read)
--       inventory        inventory.read         (valuation: inventory_reports.read)
--       production       manufacturing.read     (outsourcing: outsourcing.read)
--       purchase orders  customer_po.read       (shortage report: customer_po_shortages.read)
--       data quality     audit_logs.read        (administrators)
--     Without it the section is {"available": false, "reason": ...}.
--   * Private helpers are not executable by clients.
--
-- Definitions (also shown in the UI)
--   Order value       = (ordered - cancelled) x sales order line price snapshot,
--                       orders dated in the period, excluding DRAFT / CANCELLED.
--                       Lines without a price snapshot are counted, never valued.
--   Dispatched value  = dispatched quantity x the line's price snapshot, for
--                       consignments whose dispatch was posted in the period.
--   Invoiced value    = taxable value (before GST) of ISSUED invoices dated in the
--                       period; credit and debit notes are reported separately.
--   Collections       = receipts currently RECORDED (reversed ones excluded) by
--                       receipt date. Never derived from invoice or order value.
--   Outstanding       = Phase 8 invoice balance as of the reporting date
--                       (private.invoice_position_as_of): issued total - issued
--                       credit notes + issued debit notes - active allocations.
--   Available stock   = on hand - reserved in STORAGE locations only; quarantine,
--                       rejected and external-processing stock is never available.
--   Quantities are always grouped by unit of measure and never added across units.
--   Dates of timestamps are taken in the company time zone.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Correction: quarantined returns are not eligible for allocation.
-- Phase 7 states that only STORAGE stock is available and that returns stay
-- unavailable until inspected; the Phase 6 eligibility helper predates the
-- QUARANTINE usage and did not exclude it. Same columns, one extra reason.
-- -----------------------------------------------------------------------------
create or replace function private.po_eligible_stock(p_company uuid, p_product uuid, p_warehouse uuid)
returns table (
  balance_id uuid, batch_id uuid, batch_number text, source_type text, warehouse_id uuid, warehouse_code text,
  location_id uuid, location_code text, stock_usage text, expiry_date date, lot_created_at timestamptz,
  on_hand numeric, reserved numeric, available numeric, eligible boolean, ineligible_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.batch_id, bt.batch_number, b.source_type, b.warehouse_id, w.warehouse_code, b.location_id, l.location_code, l.stock_usage,
    bt.expiry_date, bt.created_at, b.on_hand, b.reserved, b.on_hand - b.reserved, r.reason is null, r.reason
  from public.inventory_balances b
  join public.inventory_batches bt on bt.id = b.batch_id
  join public.inventory_locations l on l.id = b.location_id
  join public.warehouses w on w.id = b.warehouse_id
  cross join lateral (select case
      when l.stock_usage = 'REJECTED' then 'Rejected goods (non-saleable)'
      when l.stock_usage = 'EXTERNAL_PROCESSING' then 'Held by an outside processor'
      when l.stock_usage = 'QUARANTINE' then 'Quarantine (returns awaiting inspection)'
      when l.status <> 'ACTIVE' or w.status <> 'ACTIVE' then 'Inactive location'
      when bt.status <> 'ACTIVE' then 'Lot closed'
      when bt.expiry_date is not null and bt.expiry_date < private.company_today(p_company) then 'Expired'
      when b.source_type = 'UNKNOWN' then 'Unverified source (review required)'
      when p_warehouse is not null and b.warehouse_id <> p_warehouse then 'Other warehouse'
    end as reason) r
  where b.company_id = p_company and b.product_id = p_product and b.on_hand > 0;
$$;

-- -----------------------------------------------------------------------------
-- Indexes for period queries (checked against existing indexes: allocations,
-- production due dates and PO receipt dates had none).
-- -----------------------------------------------------------------------------
create index if not exists invoice_payment_alloc_date_idx on public.invoice_payment_allocations (company_id, allocation_date);
create index if not exists production_orders_target_idx on public.production_orders (company_id, target_completion_date);
create index if not exists customer_pos_created_idx on public.customer_purchase_orders (company_id, created_at desc) where is_current;

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------
create or replace function private.analytics_check_period(p_from date, p_to date)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Choose a valid date range (at most about 10 years).' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function private.analytics_na(p_permission text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('available', false, 'reason', 'Your role does not include the ' || p_permission || ' permission.');
$$;

-- Open sales-order and (not yet converted) customer-PO demand per product that
-- is not covered by reservations. Used for shortage KPIs and alerts.
create or replace function private.analytics_open_demand(p_company uuid)
returns table (product_id uuid, unit text, so_need numeric, po_need numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with so as (
    select l.product_id, l.unit,
      sum(greatest(l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched - private.so_line_open_reserved(l.id), 0)) as need
    from public.sales_order_lines l
    join public.sales_orders s on s.id = l.sales_order_id
    where s.company_id = p_company and s.order_status not in ('DRAFT', 'CANCELLED', 'FULFILLED') and l.line_status in ('OPEN', 'PARTIALLY_FULFILLED')
    group by l.product_id, l.unit
  ),
  po as (
    select l.product_id, l.unit,
      sum(greatest(l.quantity_ordered - l.quantity_dispatched - private.po_line_converted(l.id)
        - coalesce((select sum(r.quantity - r.fulfilled_quantity - r.released_quantity) from public.stock_reservations r
                    where r.reference_type = 'CUSTOMER_PO' and r.reference_id = l.id and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')), 0), 0)) as need
    from public.customer_purchase_order_lines l
    join public.customer_purchase_orders o on o.id = l.purchase_order_id
    where o.company_id = p_company and o.is_current and o.status not in ('DRAFT', 'CANCELLED', 'FULFILLED', 'ON_HOLD')
      and l.line_status = 'MATCHED' and l.product_id is not null
    group by l.product_id, l.unit
  )
  select coalesce(so.product_id, po.product_id), coalesce(so.unit, po.unit), coalesce(so.need, 0), coalesce(po.need, 0)
  from so full join po on po.product_id = so.product_id and po.unit = so.unit;
$$;

-- Eligible (allocatable) stock of a product, optionally in one warehouse.
create or replace function private.analytics_eligible(p_company uuid, p_product uuid, p_warehouse uuid)
returns table (available numeric, in_house numeric, outsourced numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(s.available) filter (where s.eligible), 0),
    coalesce(sum(s.available) filter (where s.eligible and s.source_type = 'IN_HOUSE'), 0),
    coalesce(sum(s.available) filter (where s.eligible and s.source_type = 'OUTSOURCED'), 0)
  from private.po_eligible_stock(p_company, p_product, p_warehouse) s;
$$;

-- -----------------------------------------------------------------------------
-- KPI blocks (called only after the permission check of the public function)
-- -----------------------------------------------------------------------------
create or replace function private.analytics_sales_kpis(p_company uuid, p_from date, p_to date, p_warehouse uuid, p_category uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz  text := private.company_tz(p_company);
  v_cur text := (select currency_code from public.companies where id = p_company);
  v     jsonb;
begin
  with ol as (
    select l.*, so.order_status, (coalesce(l.currency, so.currency, v_cur) = v_cur) as same_cur
    from public.sales_order_lines l
    join public.sales_orders so on so.id = l.sales_order_id
    join public.products p on p.id = l.product_id
    where so.company_id = p_company and so.order_date between p_from and p_to and so.order_status not in ('DRAFT', 'CANCELLED')
      and (p_warehouse is null or so.warehouse_id = p_warehouse) and (p_category is null or p.category_id = p_category)
  ),
  dl as (
    select fl.quantity_dispatched as qty, sol.unit, sol.unit_price_snapshot as price, f.id as fulfilment_id,
      (coalesce(sol.currency, so.currency, v_cur) = v_cur) as same_cur
    from public.fulfilment_lines fl
    join public.fulfilments f on f.id = fl.fulfilment_id
    join public.sales_order_lines sol on sol.id = fl.sales_order_line_id
    join public.sales_orders so on so.id = f.sales_order_id
    join public.products p on p.id = fl.product_id
    where f.company_id = p_company and f.actual_dispatch_at is not null and fl.quantity_dispatched > 0
      and (f.actual_dispatch_at at time zone v_tz)::date between p_from and p_to
      and (p_warehouse is null or f.warehouse_id = p_warehouse) and (p_category is null or p.category_id = p_category)
  ),
  open_lines as (
    select l.id, l.sales_order_id, so.order_status, so.fulfilment_status,
      greatest(l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched, 0) as remaining,
      private.so_line_open_reserved(l.id) as reserved
    from public.sales_order_lines l
    join public.sales_orders so on so.id = l.sales_order_id
    join public.products p on p.id = l.product_id
    where so.company_id = p_company
      and so.order_status in ('CONFIRMED', 'PARTIALLY_ALLOCATED', 'READY_FOR_FULFILMENT', 'IN_FULFILMENT', 'PARTIALLY_FULFILLED')
      and l.line_status in ('OPEN', 'PARTIALLY_FULFILLED')
      and (p_warehouse is null or so.warehouse_id = p_warehouse) and (p_category is null or p.category_id = p_category)
  )
  select jsonb_build_object(
    'available', true,
    'has_records', exists (select 1 from public.sales_orders where company_id = p_company),
    'orders_created', (select count(distinct sales_order_id) from ol),
    'order_value', (select coalesce(sum((quantity_ordered - quantity_cancelled) * unit_price_snapshot), 0) from ol where unit_price_snapshot is not null and same_cur),
    'unpriced_order_lines', (select count(*) from ol where unit_price_snapshot is null),
    'other_currency_lines', (select count(*) from ol where not same_cur),
    'dispatched_value', (select coalesce(sum(qty * price), 0) from dl where price is not null and same_cur),
    'unpriced_dispatch_lines', (select count(*) from dl where price is null),
    'quantity_dispatched', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit)
      from (select unit, sum(qty) q from dl group by unit) x), '[]'::jsonb),
    'dispatches_completed', (select count(distinct fulfilment_id) from dl),
    'orders_awaiting_fulfilment', (select count(distinct sales_order_id) from open_lines where remaining > 0),
    'orders_with_shortages', (select count(distinct sales_order_id) from open_lines
      where remaining - reserved > 0 and remaining - reserved > private.so_line_available_now(id)),
    'partially_fulfilled', (select count(distinct sales_order_id) from open_lines
      where order_status = 'PARTIALLY_FULFILLED' or fulfilment_status = 'PARTIALLY_DISPATCHED')
  ) into v;
  return v;
end;
$$;

create or replace function private.analytics_billing_kpis(p_company uuid, p_from date, p_to date, p_as_of date, p_customer uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  with pos as (
    select * from private.invoice_position_as_of(p_company, p_as_of) p where p_customer is null or p.customer_id = p_customer
  ),
  inv as (
    select * from public.sales_invoices i
    where i.company_id = p_company and i.status = 'ISSUED' and i.invoice_date between p_from and p_to and (p_customer is null or i.customer_id = p_customer)
  ),
  notes as (
    select * from public.invoice_adjustment_notes n
    where n.company_id = p_company and n.status = 'ISSUED' and n.note_date between p_from and p_to and (p_customer is null or n.customer_id = p_customer)
  ),
  rec as (
    select p.*, p.amount_received - private.payment_allocated(p.id) as unallocated from public.customer_payments p
    where p.company_id = p_company and p.status = 'RECORDED' and (p_customer is null or p.customer_id = p_customer)
  )
  select jsonb_build_object(
    'available', true,
    'has_records', exists (select 1 from public.sales_invoices where company_id = p_company and status in ('ISSUED', 'CANCELLED')),
    'invoices_issued', (select count(*) from inv),
    'invoiced_total', (select coalesce(sum(grand_total), 0) from inv),
    'invoiced_taxable', (select coalesce(sum(taxable_subtotal), 0) from inv),
    'credit_notes_total', (select coalesce(sum(total_amount), 0) from notes where note_type = 'CREDIT'),
    'debit_notes_total', (select coalesce(sum(total_amount), 0) from notes where note_type = 'DEBIT'),
    'payments_received', (select coalesce(sum(amount_received), 0) from rec where receipt_date between p_from and p_to),
    'receipts_count', (select count(*) from rec where receipt_date between p_from and p_to),
    'outstanding', (select coalesce(sum(balance), 0) from pos where balance > 0),
    'customer_credits', (select coalesce(sum(-balance), 0) from pos where balance < 0),
    'overdue', (select coalesce(sum(balance), 0) from pos where balance > 0 and days_overdue > 0),
    'overdue_invoices', (select count(*) from pos where balance > 0 and days_overdue > 0),
    'partially_paid', (select count(*) from pos where balance > 0 and paid > 0),
    'open_invoices', (select count(*) from pos where balance > 0),
    'unallocated_receipts', (select coalesce(sum(unallocated), 0) from rec where unallocated > 0),
    'unallocated_receipts_count', (select count(*) from rec where unallocated > 0)
  ) into v;
  return v;
end;
$$;

create or replace function private.analytics_inventory_kpis(p_company uuid, p_warehouse uuid, p_category uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  with bal as (
    select b.*, p.base_unit as unit, p.category_id, l.stock_usage
    from public.inventory_balances b
    join public.products p on p.id = b.product_id
    join public.inventory_locations l on l.id = b.location_id
    where b.company_id = p_company and p.archived_at is null and (b.on_hand <> 0 or b.reserved <> 0)
      and (p_warehouse is null or b.warehouse_id = p_warehouse) and (p_category is null or p.category_id = p_category)
  ),
  prod as (
    select p.id, p.base_unit as unit, p.reorder_level,
      coalesce((select sum(b.on_hand) from bal b where b.product_id = p.id and b.stock_usage = 'STORAGE'), 0) as storage_on_hand,
      coalesce((select sum(b.on_hand - b.reserved) from bal b where b.product_id = p.id and b.stock_usage = 'STORAGE'), 0) as available,
      exists (select 1 from public.inventory_transactions t where t.company_id = p_company and t.product_id = p.id
              and (p_warehouse is null or t.warehouse_id = p_warehouse)) as has_history
    from public.products p
    where p.company_id = p_company and p.status = 'ACTIVE' and p.archived_at is null and (p_category is null or p.category_id = p_category)
  ),
  demand as (
    select d.product_id, d.unit, d.so_need + d.po_need as need from private.analytics_open_demand(p_company) d
    join public.products p on p.id = d.product_id and p.base_unit = d.unit
    where d.so_need + d.po_need > 0 and (p_category is null or p.category_id = p_category)
  ),
  short as (
    select d.product_id, d.unit, d.need - e.available as shortage
    from demand d cross join lateral private.analytics_eligible(p_company, d.product_id, p_warehouse) e
    where d.need > e.available
  )
  select jsonb_build_object(
    'available', true,
    'has_records', exists (select 1 from public.inventory_transactions where company_id = p_company),
    'active_products', (select count(*) from prod),
    'low_stock_products', (select count(*) from prod where available > 0 and reorder_level is not null and available <= reorder_level),
    'out_of_stock_products', (select count(*) from prod where storage_on_hand = 0 and has_history),
    'fully_reserved_products', (select count(*) from prod where storage_on_hand > 0 and available = 0),
    'never_stocked_products', (select count(*) from prod where not has_history),
    'shortage_products', (select count(*) from short),
    'shortage_units', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit)
      from (select unit, sum(shortage) q from short group by unit) x), '[]'::jsonb),
    'units', coalesce((select jsonb_agg(u order by u ->> 'unit') from (
        select jsonb_build_object('unit', unit,
          'on_hand', sum(on_hand), 'reserved', sum(reserved),
          'available', coalesce(sum(on_hand - reserved) filter (where stock_usage = 'STORAGE'), 0),
          'in_house', coalesce(sum(on_hand) filter (where source_type = 'IN_HOUSE'), 0),
          'outsourced', coalesce(sum(on_hand) filter (where source_type = 'OUTSOURCED'), 0),
          'unknown', coalesce(sum(on_hand) filter (where source_type = 'UNKNOWN'), 0),
          'quarantine', coalesce(sum(on_hand) filter (where stock_usage = 'QUARANTINE'), 0),
          'rejected', coalesce(sum(on_hand) filter (where stock_usage = 'REJECTED'), 0),
          'external', coalesce(sum(on_hand) filter (where stock_usage = 'EXTERNAL_PROCESSING'), 0)) as u
        from bal group by unit) x), '[]'::jsonb),
    'by_warehouse', coalesce((select jsonb_agg(jsonb_build_object('warehouse_id', w.id, 'warehouse_code', w.warehouse_code, 'warehouse_name', w.warehouse_name,
        'unit', x.unit, 'on_hand', x.on_hand, 'available', x.available) order by w.warehouse_code, x.unit)
      from (select warehouse_id, unit, sum(on_hand) on_hand, coalesce(sum(on_hand - reserved) filter (where stock_usage = 'STORAGE'), 0) available
            from bal group by warehouse_id, unit) x join public.warehouses w on w.id = x.warehouse_id), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;

create or replace function private.analytics_valuation(p_company uuid, p_warehouse uuid, p_category uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  with lots as (
    select b.on_hand, p.base_unit as unit, private.lot_average_cost(b.batch_id) as cost
    from public.inventory_balances b
    join public.products p on p.id = b.product_id
    where b.company_id = p_company and b.on_hand > 0 and p.archived_at is null
      and (p_warehouse is null or b.warehouse_id = p_warehouse) and (p_category is null or p.category_id = p_category)
  )
  select jsonb_build_object(
    'method', 'Weighted-average receipt cost of each lot (the Phase 4 inventory valuation method), applied to current on-hand quantity. Selling prices are never used.',
    'lots', count(*),
    'costed_lots', count(*) filter (where cost is not null),
    'uncosted', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit)
      from (select unit, sum(on_hand) q from lots where cost is null group by unit) x), '[]'::jsonb),
    'complete', count(*) > 0 and count(*) filter (where cost is null) = 0,
    'value', case when count(*) > 0 and count(*) filter (where cost is null) = 0 then sum(round(on_hand * cost, 2)) end,
    'costed_value', sum(round(on_hand * cost, 2)) filter (where cost is not null)
  ) into v
  from lots;
  return v || jsonb_build_object('available', (v ->> 'complete')::boolean,
    'reason', case when (v ->> 'lots')::int = 0 then 'No stock on hand.'
                   when not (v ->> 'complete')::boolean then 'Valuation unavailable — cost data required for '
                     || ((v ->> 'lots')::int - (v ->> 'costed_lots')::int) || ' of ' || (v ->> 'lots') || ' lots on hand.' end);
end;
$$;

create or replace function private.analytics_production_kpis(p_company uuid, p_from date, p_to date, p_warehouse uuid, p_as_of date, p_outsourcing boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text := private.company_tz(p_company);
  v    jsonb;
begin
  with ord as (
    select o.* from public.production_orders o
    where o.company_id = p_company and (p_warehouse is null or o.source_warehouse_id = p_warehouse or o.destination_warehouse_id = p_warehouse)
  ),
  due as (select * from ord where target_completion_date between p_from and p_to and status not in ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED')),
  outp as (
    select r.* from public.production_output_receipts r join ord o on o.id = r.production_order_id
    where r.status = 'POSTED' and r.production_date between p_from and p_to
  ),
  oo as (
    select o.* from public.outsourcing_orders o
    where o.company_id = p_company and p_outsourcing and (p_warehouse is null or o.destination_warehouse_id = p_warehouse)
  ),
  orec as (
    select r.* from public.outsourcing_receipts r join oo on oo.id = r.outsourcing_order_id
    where r.status = 'POSTED' and r.receipt_date between p_from and p_to
  )
  select jsonb_build_object(
    'available', true,
    'has_records', exists (select 1 from public.production_orders where company_id = p_company)
                   or exists (select 1 from public.outsourcing_orders where company_id = p_company),
    'orders_created', (select count(*) from ord where (created_at at time zone v_tz)::date between p_from and p_to),
    'orders_in_progress', (select count(*) from ord where status in ('IN_PROGRESS', 'PARTIALLY_COMPLETED')),
    'orders_completed', (select count(*) from ord where status = 'COMPLETED' and actual_completion_date between p_from and p_to),
    'orders_due', (select count(*) from due),
    'orders_due_completed', (select count(*) from due where status = 'COMPLETED'),
    'completion_rate', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where status = 'COMPLETED') / count(*), 1) end from due),
    'planned_vs_actual', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'planned', planned, 'good', good, 'rejected', rej, 'scrap', scrap) order by unit)
      from (select unit, sum(planned_quantity) planned, sum(completed_quantity) good, sum(rejected_quantity) rej, sum(scrap_quantity) scrap
            from due group by unit) x), '[]'::jsonb),
    'output_in_period', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'good', good, 'rejected', rej, 'scrap', scrap) order by unit)
      from (select unit, sum(good_quantity) good, sum(rejected_quantity) rej, sum(scrap_quantity) scrap from outp group by unit) x), '[]'::jsonb),
    'material_shortages', (select count(distinct component_product_id) from private.production_material_outlook(p_company, p_warehouse, null) where shortage > 0),
    'delayed_orders', (select count(*) from ord where status not in ('DRAFT', 'COMPLETED', 'CANCELLED') and target_completion_date < p_as_of),
    'outsourcing', case when not p_outsourcing then private.analytics_na('outsourcing.read') else jsonb_build_object(
      'available', true,
      'in_progress', (select count(*) from oo where status in ('APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED')),
      'awaiting_receipt', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit)
        from (select unit, sum(greatest(ordered_quantity - received_quantity, 0)) q from oo
              where status in ('APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED') group by unit having sum(greatest(ordered_quantity - received_quantity, 0)) > 0) x), '[]'::jsonb),
      'overdue', (select count(*) from oo where status in ('APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED') and expected_return_date < p_as_of),
      'received_in_period', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'accepted', acc, 'rejected', rej) order by unit)
        from (select unit, sum(accepted_quantity) acc, sum(rejected_quantity) rej from orec group by unit) x), '[]'::jsonb)) end
  ) into v;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Context for the dashboard header and filters
-- -----------------------------------------------------------------------------
create or replace function public.analytics_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('dashboard.read');
  v_c       public.companies;
  v_inv     boolean := private.has_permission(v_company, 'inventory.read');
begin
  select * into v_c from public.companies where id = v_company;
  return jsonb_build_object(
    'company', jsonb_build_object('legal_name', v_c.legal_name, 'display_name', v_c.display_name, 'currency_code', v_c.currency_code),
    'timezone', v_c.timezone,
    'today', private.company_today(v_company),
    'fy_start_month', coalesce((select fy_start_month from public.invoice_settings where company_id = v_company), 4),
    'access', jsonb_build_object(
      'sales', private.has_permission(v_company, 'sales_orders.read'),
      'fulfilment', private.has_permission(v_company, 'fulfilment.read'),
      'billing', private.has_permission(v_company, 'billing_reports.read'),
      'payments', private.has_permission(v_company, 'payments.read'),
      'inventory', v_inv,
      'valuation', private.has_permission(v_company, 'inventory_reports.read'),
      'production', private.has_permission(v_company, 'manufacturing.read'),
      'outsourcing', private.has_permission(v_company, 'outsourcing.read'),
      'purchase_orders', private.has_permission(v_company, 'customer_po.read'),
      'shortages', private.has_permission(v_company, 'customer_po_shortages.read'),
      'data_quality', private.has_permission(v_company, 'audit_logs.read')),
    'export', jsonb_build_object(
      'sales', private.has_permission(v_company, 'fulfilment_reports.export'),
      'billing', private.has_permission(v_company, 'billing_reports.export'),
      'inventory', private.has_permission(v_company, 'inventory.export'),
      'production', private.has_permission(v_company, 'production_reports.export'),
      'purchase_orders', private.has_permission(v_company, 'customer_po_reports.export'),
      'data_quality', private.has_permission(v_company, 'audit_logs.read')),
    'warehouses', case when v_inv or private.has_permission(v_company, 'sales_orders.read') or private.has_permission(v_company, 'manufacturing.read') then
      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'code', warehouse_code, 'name', warehouse_name) order by warehouse_code)
                from public.warehouses where company_id = v_company and status = 'ACTIVE'), '[]'::jsonb) else '[]'::jsonb end,
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
                from public.product_categories where company_id = v_company and is_active), '[]'::jsonb),
    'generated_at', now()
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Executive summary (one call for all KPI cards)
-- -----------------------------------------------------------------------------
create or replace function public.analytics_executive(
  p_from         date,
  p_to           date,
  p_as_of        date default null,
  p_warehouse_id uuid default null,
  p_category_id  uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('dashboard.read');
  v_today   date := private.company_today(v_company);
  v_as_of   date := coalesce(p_as_of, least(p_to, private.company_today(v_company)));
begin
  perform private.analytics_check_period(p_from, p_to);
  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'as_of', v_as_of, 'today', v_today,
    'timezone', private.company_tz(v_company),
    'currency', (select currency_code from public.companies where id = v_company),
    'sales', case when private.has_permission(v_company, 'sales_orders.read')
      then private.analytics_sales_kpis(v_company, p_from, p_to, p_warehouse_id, p_category_id) else private.analytics_na('sales_orders.read') end,
    'billing', case when private.has_permission(v_company, 'billing_reports.read')
      then private.analytics_billing_kpis(v_company, p_from, p_to, v_as_of, null) else private.analytics_na('billing_reports.read') end,
    'inventory', case when private.has_permission(v_company, 'inventory.read')
      then private.analytics_inventory_kpis(v_company, p_warehouse_id, p_category_id) else private.analytics_na('inventory.read') end,
    'valuation', case when private.has_permission(v_company, 'inventory_reports.read')
      then private.analytics_valuation(v_company, p_warehouse_id, p_category_id) else private.analytics_na('inventory_reports.read') end,
    'production', case when private.has_permission(v_company, 'manufacturing.read')
      then private.analytics_production_kpis(v_company, p_from, p_to, p_warehouse_id, v_as_of, private.has_permission(v_company, 'outsourcing.read'))
      else private.analytics_na('manufacturing.read') end,
    'generated_at', now()
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Sales analytics
-- -----------------------------------------------------------------------------
create or replace function public.analytics_sales(
  p_from         date,
  p_to           date,
  p_customer_id  uuid default null,
  p_category_id  uuid default null,
  p_product_id   uuid default null,
  p_warehouse_id uuid default null,
  p_order_status text default null,
  p_bucket       text default 'month'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('sales_orders.read');
  v_tz      text := private.company_tz(v_company);
  v_cur     text := (select currency_code from public.companies where id = v_company);
  v_billing boolean := private.has_permission(v_company, 'billing_reports.read');
  v         jsonb;
begin
  perform private.analytics_check_period(p_from, p_to);
  if p_bucket not in ('day', 'week', 'month') then
    raise exception 'Bucket must be day, week or month.' using errcode = 'P0001';
  end if;

  with ol as (
    select l.*, so.order_date, so.customer_id, so.customer_key, so.customer_name_snapshot, so.sales_order_number, so.order_status,
      p.category_id, case when l.unit_price_snapshot is not null and coalesce(l.currency, so.currency, v_cur) = v_cur
        then (l.quantity_ordered - l.quantity_cancelled) * l.unit_price_snapshot end as value
    from public.sales_order_lines l
    join public.sales_orders so on so.id = l.sales_order_id
    join public.products p on p.id = l.product_id
    where so.company_id = v_company and so.order_date between p_from and p_to
      and (case when p_order_status is null then so.order_status not in ('DRAFT', 'CANCELLED') else so.order_status = p_order_status end)
      and (p_customer_id is null or so.customer_id = p_customer_id) and (p_category_id is null or p.category_id = p_category_id)
      and (p_product_id is null or l.product_id = p_product_id) and (p_warehouse_id is null or so.warehouse_id = p_warehouse_id)
  ),
  dl as (
    select fl.quantity_dispatched as qty, sol.product_id, sol.unit, p.category_id, so.customer_id, so.customer_key, so.customer_name_snapshot,
      f.id as fulfilment_id, (f.actual_dispatch_at at time zone v_tz)::date as dispatch_date,
      case when sol.unit_price_snapshot is not null and coalesce(sol.currency, so.currency, v_cur) = v_cur
        then fl.quantity_dispatched * sol.unit_price_snapshot end as value
    from public.fulfilment_lines fl
    join public.fulfilments f on f.id = fl.fulfilment_id
    join public.sales_order_lines sol on sol.id = fl.sales_order_line_id
    join public.sales_orders so on so.id = f.sales_order_id
    join public.products p on p.id = fl.product_id
    where f.company_id = v_company and f.actual_dispatch_at is not null and fl.quantity_dispatched > 0
      and (f.actual_dispatch_at at time zone v_tz)::date between p_from and p_to
      and (p_order_status is null or so.order_status = p_order_status)
      and (p_customer_id is null or so.customer_id = p_customer_id) and (p_category_id is null or p.category_id = p_category_id)
      and (p_product_id is null or fl.product_id = p_product_id) and (p_warehouse_id is null or f.warehouse_id = p_warehouse_id)
  ),
  il as (
    select il.taxable_value as value, il.product_id, i.customer_id, i.customer_legal_name, i.invoice_date
    from public.sales_invoice_lines il
    join public.sales_invoices i on i.id = il.invoice_id
    left join public.products p on p.id = il.product_id
    left join public.fulfilment_lines fl on fl.id = il.fulfilment_line_id
    left join public.fulfilments f on f.id = fl.fulfilment_id
    where v_billing and i.company_id = v_company and i.status = 'ISSUED' and i.invoice_date between p_from and p_to
      and (p_customer_id is null or i.customer_id = p_customer_id) and (p_category_id is null or p.category_id = p_category_id)
      and (p_product_id is null or il.product_id = p_product_id) and (p_warehouse_id is null or f.warehouse_id = p_warehouse_id)
  ),
  nl as (
    select n.note_type, n.note_date, nl.taxable_amount as value
    from public.invoice_adjustment_note_lines nl
    join public.invoice_adjustment_notes n on n.id = nl.note_id
    join public.sales_invoice_lines il on il.id = nl.invoice_line_id
    left join public.products p on p.id = il.product_id
    left join public.fulfilment_lines fl on fl.id = il.fulfilment_line_id
    left join public.fulfilments f on f.id = fl.fulfilment_id
    where v_billing and n.company_id = v_company and n.status = 'ISSUED' and n.note_date between p_from and p_to
      and (p_customer_id is null or n.customer_id = p_customer_id) and (p_category_id is null or p.category_id = p_category_id)
      and (p_product_id is null or il.product_id = p_product_id) and (p_warehouse_id is null or f.warehouse_id = p_warehouse_id)
  ),
  months as (
    select m::date as month from generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') m
  ),
  open_lines as (
    select l.id, l.sales_order_id, so.sales_order_number, so.customer_name_snapshot, so.customer_po_number, so.order_status,
      l.sku_snapshot as sku, l.product_name_snapshot as product_name, l.unit,
      l.quantity_ordered - l.quantity_cancelled as ordered, l.quantity_dispatched as dispatched,
      greatest(l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched, 0) as remaining,
      private.so_line_open_reserved(l.id) as reserved
    from public.sales_order_lines l
    join public.sales_orders so on so.id = l.sales_order_id
    join public.products p on p.id = l.product_id
    where so.company_id = v_company
      and so.order_status in ('CONFIRMED', 'PARTIALLY_ALLOCATED', 'READY_FOR_FULFILMENT', 'IN_FULFILMENT', 'PARTIALLY_FULFILLED', 'ON_HOLD')
      and l.line_status in ('OPEN', 'PARTIALLY_FULFILLED')
      and (p_customer_id is null or so.customer_id = p_customer_id) and (p_category_id is null or p.category_id = p_category_id)
      and (p_product_id is null or l.product_id = p_product_id) and (p_warehouse_id is null or so.warehouse_id = p_warehouse_id)
  ),
  open_short as (
    select o.*, a.available_now, greatest(o.remaining - o.reserved - a.available_now, 0) as shortage
    from open_lines o cross join lateral (select private.so_line_available_now(o.id) as available_now) a
    where o.remaining > 0
  ),
  ord_status as (
    select sales_order_id,
      bool_and(quantity_ordered - quantity_cancelled - quantity_dispatched <= 0) as fully,
      bool_or(quantity_dispatched > 0) as started
    from ol group by sales_order_id
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'bucket', p_bucket, 'currency', v_cur,
    'has_records', exists (select 1 from public.sales_orders where company_id = v_company),
    'invoices_available', v_billing,
    'totals', jsonb_build_object(
      'orders', (select count(distinct sales_order_id) from ol),
      'order_value', (select coalesce(sum(value), 0) from ol),
      'unpriced_order_lines', (select count(*) from ol where value is null),
      'dispatched_value', (select coalesce(sum(value), 0) from dl),
      'unpriced_dispatch_lines', (select count(*) from dl where value is null),
      'dispatches', (select count(distinct fulfilment_id) from dl),
      'invoiced_value', case when v_billing then (select coalesce(sum(value), 0) from il) end,
      'credit_notes', case when v_billing then (select coalesce(sum(value), 0) from nl where note_type = 'CREDIT') end,
      'debit_notes', case when v_billing then (select coalesce(sum(value), 0) from nl where note_type = 'DEBIT') end),
    'monthly', (select jsonb_agg(jsonb_build_object('month', m.month,
        'order_value', coalesce((select sum(value) from ol where date_trunc('month', ol.order_date::timestamp)::date = m.month), 0),
        'orders', (select count(distinct sales_order_id) from ol where date_trunc('month', ol.order_date::timestamp)::date = m.month),
        'dispatched_value', coalesce((select sum(value) from dl where date_trunc('month', dl.dispatch_date::timestamp)::date = m.month), 0),
        'invoiced_value', case when v_billing then coalesce((select sum(value) from il where date_trunc('month', il.invoice_date::timestamp)::date = m.month), 0) end,
        'credit_notes', case when v_billing then coalesce((select sum(value) from nl where note_type = 'CREDIT' and date_trunc('month', nl.note_date::timestamp)::date = m.month), 0) end,
        'debit_notes', case when v_billing then coalesce((select sum(value) from nl where note_type = 'DEBIT' and date_trunc('month', nl.note_date::timestamp)::date = m.month), 0) end)
        order by m.month) from months m),
    'trend', coalesce((select jsonb_agg(jsonb_build_object('bucket', bucket, 'orders', n, 'order_value', val) order by bucket)
      from (select date_trunc(p_bucket, order_date::timestamp)::date bucket, count(distinct sales_order_id) n, coalesce(sum(value), 0) val
            from ol group by 1) x), '[]'::jsonb),
    'top_customers_ordered', coalesce((select jsonb_agg(x order by (x ->> 'value')::numeric desc) from (
        select jsonb_build_object('customer_id', max(customer_id::text), 'customer_key', customer_key, 'customer', max(customer_name_snapshot),
          'value', coalesce(sum(value), 0), 'orders', count(distinct sales_order_id)) x
        from ol group by customer_key order by coalesce(sum(value), 0) desc limit 10) y), '[]'::jsonb),
    'top_customers_dispatched', coalesce((select jsonb_agg(x order by (x ->> 'value')::numeric desc) from (
        select jsonb_build_object('customer_id', max(customer_id::text), 'customer_key', customer_key, 'customer', max(customer_name_snapshot),
          'value', coalesce(sum(value), 0), 'dispatches', count(distinct fulfilment_id)) x
        from dl group by customer_key order by coalesce(sum(value), 0) desc limit 10) y), '[]'::jsonb),
    'top_customers_invoiced', case when v_billing then coalesce((select jsonb_agg(x order by (x ->> 'value')::numeric desc) from (
        select jsonb_build_object('customer_id', customer_id, 'customer', max(customer_legal_name), 'value', sum(value)) x
        from il group by customer_id order by sum(value) desc limit 10) y), '[]'::jsonb) end,
    'by_product', coalesce((select jsonb_agg(x order by (x ->> 'order_value')::numeric desc, (x ->> 'ordered')::numeric desc) from (
        select jsonb_build_object('product_id', o.product_id, 'sku', max(o.sku_snapshot), 'product_name', max(o.product_name_snapshot), 'unit', o.unit,
          'ordered', sum(o.quantity_ordered - o.quantity_cancelled), 'order_value', coalesce(sum(o.value), 0),
          'dispatched', coalesce((select sum(d.qty) from dl d where d.product_id = o.product_id and d.unit = o.unit), 0),
          'dispatched_value', coalesce((select sum(d.value) from dl d where d.product_id = o.product_id and d.unit = o.unit), 0)) x
        from ol o group by o.product_id, o.unit order by coalesce(sum(o.value), 0) desc, sum(o.quantity_ordered - o.quantity_cancelled) desc limit 15) y), '[]'::jsonb),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('category_id', c.category_id, 'category', coalesce(pc.name, 'Uncategorised'),
        'order_value', c.ov, 'dispatched_value', c.dv) order by c.ov desc)
      from (select nullif(coalesce(a.k, b.k), '00000000-0000-0000-0000-000000000000'::uuid) category_id, coalesce(a.total, 0) ov, coalesce(b.total, 0) dv
            from (select coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid) k, coalesce(sum(value), 0) total from ol group by 1) a
            full join (select coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid) k, coalesce(sum(value), 0) total from dl group by 1) b on b.k = a.k) c
      left join public.product_categories pc on pc.id = c.category_id), '[]'::jsonb),
    'salesperson', jsonb_build_object('available', false,
      'reason', 'Sales orders do not record a salesperson. The user who created an order is not treated as its salesperson.'),
    'fulfilment', jsonb_build_object(
      'orders', (select count(*) from ord_status),
      'fully_dispatched', (select count(*) from ord_status where fully),
      'partially_dispatched', (select count(*) from ord_status where started and not fully),
      'not_dispatched', (select count(*) from ord_status where not started),
      'order_rate', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where fully) / count(*), 1) end from ord_status),
      'units', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'ordered', ordered, 'dispatched', dispatched,
          'rate', case when ordered = 0 then null else round(100.0 * dispatched / ordered, 1) end) order by unit)
        from (select unit, sum(quantity_ordered - quantity_cancelled) ordered, sum(quantity_dispatched) dispatched from ol group by unit) x), '[]'::jsonb)),
    'open_lines', jsonb_build_object(
      'lines', (select count(*) from open_short),
      'short_lines', (select count(*) from open_short where shortage > 0),
      'orders_short', (select count(distinct sales_order_id) from open_short where shortage > 0),
      'by_unit', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'remaining', r, 'reserved', res, 'shortage', s) order by unit)
        from (select unit, sum(remaining) r, sum(least(reserved, remaining)) res, sum(shortage) s from open_short group by unit) x), '[]'::jsonb),
      'rows', coalesce((select jsonb_agg(x) from (
          select jsonb_build_object('sales_order_id', sales_order_id, 'sales_order_number', sales_order_number, 'customer', customer_name_snapshot,
            'customer_po_number', customer_po_number, 'order_status', order_status, 'sku', sku, 'product_name', product_name, 'unit', unit,
            'ordered', ordered, 'dispatched', dispatched, 'remaining', remaining, 'reserved', reserved, 'available_now', available_now, 'shortage', shortage) x
          from open_short order by shortage desc, remaining desc, sales_order_number limit 25) y), '[]'::jsonb)),
    'generated_at', now()
  ) into v;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Inventory analytics
-- -----------------------------------------------------------------------------
create or replace function public.analytics_inventory(
  p_from         date,
  p_to           date,
  p_warehouse_id uuid default null,
  p_category_id  uuid default null,
  p_source_type  text default null,
  p_bucket       text default 'month'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory.read');
  v_tz      text := private.company_tz(v_company);
  v_today   date := private.company_today(v_company);
  v_start   timestamptz;
  v_end     timestamptz;
  v         jsonb;
begin
  perform private.analytics_check_period(p_from, p_to);
  if p_bucket not in ('day', 'week', 'month') then
    raise exception 'Bucket must be day, week or month.' using errcode = 'P0001';
  end if;
  if p_source_type is not null and p_source_type not in ('IN_HOUSE', 'OUTSOURCED', 'UNKNOWN') then
    raise exception 'Source type must be IN_HOUSE, OUTSOURCED or UNKNOWN.' using errcode = 'P0001';
  end if;
  v_start := private.company_day_start(v_company, p_from);
  v_end := private.company_day_start(v_company, p_to + 1);

  with bal as (
    select b.*, p.sku, p.product_name, p.base_unit as unit, p.category_id, p.reorder_level, p.track_expiry, l.stock_usage,
      bt.batch_number, bt.expiry_date
    from public.inventory_balances b
    join public.products p on p.id = b.product_id
    join public.inventory_locations l on l.id = b.location_id
    join public.inventory_batches bt on bt.id = b.batch_id
    where b.company_id = v_company and p.archived_at is null and (b.on_hand <> 0 or b.reserved <> 0)
      and (p_warehouse_id is null or b.warehouse_id = p_warehouse_id) and (p_category_id is null or p.category_id = p_category_id)
      and (p_source_type is null or b.source_type = p_source_type)
  ),
  prod as (
    select p.id, p.sku, p.product_name, p.base_unit as unit, p.reorder_level,
      coalesce((select sum(b.on_hand) from bal b where b.product_id = p.id and b.stock_usage = 'STORAGE'), 0) as storage_on_hand,
      coalesce((select sum(b.on_hand - b.reserved) from bal b where b.product_id = p.id and b.stock_usage = 'STORAGE'), 0) as available,
      coalesce((select sum(b.reserved) from bal b where b.product_id = p.id), 0) as reserved,
      exists (select 1 from public.inventory_transactions t where t.company_id = v_company and t.product_id = p.id
              and (p_warehouse_id is null or t.warehouse_id = p_warehouse_id)) as has_history
    from public.products p
    where p.company_id = v_company and p.status = 'ACTIVE' and p.archived_at is null and (p_category_id is null or p.category_id = p_category_id)
  ),
  tx as (
    select t.*, p.category_id from public.inventory_transactions t join public.products p on p.id = t.product_id
    where t.company_id = v_company and (p_warehouse_id is null or t.warehouse_id = p_warehouse_id)
      and (p_category_id is null or p.category_id = p_category_id) and (p_source_type is null or t.source_type = p_source_type)
  ),
  ptx as (select * from tx where transaction_date >= v_start and transaction_date < v_end),
  moves as (
    select * from ptx where transaction_type not in ('TRANSFER_OUT', 'TRANSFER_IN') and not (transaction_type = 'REVERSAL' and transfer_group_id is not null)
  ),
  transfers as (
    -- a transfer counts once (its OUT leg), in the selected warehouse when either leg is there
    select o.transfer_group_id, o.unit, o.quantity, o.warehouse_id as from_wh, i.warehouse_id as to_wh
    from public.inventory_transactions o
    join public.inventory_transactions i on i.transfer_group_id = o.transfer_group_id and i.transaction_type = 'TRANSFER_IN' and i.company_id = v_company
    join public.products p on p.id = o.product_id
    where o.company_id = v_company and o.transaction_type = 'TRANSFER_OUT' and o.transaction_date >= v_start and o.transaction_date < v_end
      and (p_warehouse_id is null or o.warehouse_id = p_warehouse_id or i.warehouse_id = p_warehouse_id)
      and (p_category_id is null or p.category_id = p_category_id) and (p_source_type is null or o.source_type = p_source_type)
      and not exists (select 1 from public.inventory_transactions r where r.reversal_of_transaction_id = o.id)
  ),
  res as (
    select r.reference_type, p.base_unit as unit, r.quantity - r.fulfilled_quantity - r.released_quantity as open_qty
    from public.stock_reservations r join public.products p on p.id = r.product_id
    join public.inventory_batches bt on bt.id = r.batch_id
    where r.company_id = v_company and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
      and (p_warehouse_id is null or r.warehouse_id = p_warehouse_id) and (p_category_id is null or p.category_id = p_category_id)
      and (p_source_type is null or bt.source_type = p_source_type)
  ),
  adj as (
    select a.*, p.base_unit as unit from public.inventory_adjustments a join public.products p on p.id = a.product_id
    where a.company_id = v_company and (p_warehouse_id is null or a.warehouse_id = p_warehouse_id) and (p_category_id is null or p.category_id = p_category_id)
  ),
  cnt as (
    select cl.*, c.count_number, c.posted_at, p.base_unit as unit from public.inventory_count_lines cl
    join public.inventory_counts c on c.id = cl.count_id join public.products p on p.id = cl.product_id
    where c.company_id = v_company and c.status = 'POSTED' and c.posted_at >= v_start and c.posted_at < v_end
      and (p_warehouse_id is null or c.warehouse_id = p_warehouse_id) and (p_category_id is null or p.category_id = p_category_id)
      and cl.counted_quantity is not null
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'bucket', p_bucket, 'today', v_today,
    'has_records', exists (select 1 from public.inventory_transactions where company_id = v_company),
    'current', jsonb_build_object(
      'by_warehouse', coalesce((select jsonb_agg(jsonb_build_object('warehouse_id', w.id, 'warehouse', w.warehouse_code, 'warehouse_name', w.warehouse_name, 'unit', x.unit,
          'on_hand', x.on_hand, 'reserved', x.reserved, 'available', x.available) order by w.warehouse_code, x.unit)
        from (select warehouse_id, unit, sum(on_hand) on_hand, sum(reserved) reserved,
                coalesce(sum(on_hand - reserved) filter (where stock_usage = 'STORAGE'), 0) available
              from bal group by warehouse_id, unit) x join public.warehouses w on w.id = x.warehouse_id), '[]'::jsonb),
      'by_category', coalesce((select jsonb_agg(jsonb_build_object('category_id', x.category_id, 'category', coalesce(c.name, 'Uncategorised'), 'unit', x.unit,
          'on_hand', x.on_hand, 'available', x.available) order by x.on_hand desc)
        from (select category_id, unit, sum(on_hand) on_hand, coalesce(sum(on_hand - reserved) filter (where stock_usage = 'STORAGE'), 0) available
              from bal group by category_id, unit) x left join public.product_categories c on c.id = x.category_id), '[]'::jsonb),
      'by_source', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'in_house', ih, 'outsourced', os, 'unknown', unk,
          'in_house_available', iha, 'outsourced_available', osa) order by unit)
        from (select unit, coalesce(sum(on_hand) filter (where source_type = 'IN_HOUSE'), 0) ih, coalesce(sum(on_hand) filter (where source_type = 'OUTSOURCED'), 0) os,
                coalesce(sum(on_hand) filter (where source_type = 'UNKNOWN'), 0) unk,
                coalesce(sum(on_hand - reserved) filter (where source_type = 'IN_HOUSE' and stock_usage = 'STORAGE'), 0) iha,
                coalesce(sum(on_hand - reserved) filter (where source_type = 'OUTSOURCED' and stock_usage = 'STORAGE'), 0) osa
              from bal group by unit) x), '[]'::jsonb),
      'by_usage', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'usage', stock_usage, 'on_hand', q) order by unit, stock_usage)
        from (select unit, stock_usage, sum(on_hand) q from bal group by unit, stock_usage having sum(on_hand) <> 0) x), '[]'::jsonb),
      'top_available', coalesce((select jsonb_agg(x) from (
          select jsonb_build_object('product_id', id, 'sku', sku, 'product_name', product_name, 'unit', unit, 'available', available, 'reserved', reserved) x
          from prod where available > 0 order by available desc, sku limit 20) y), '[]'::jsonb),
      'below_reorder_count', (select count(*) from prod where reorder_level is not null and available <= reorder_level),
      'below_reorder', coalesce((select jsonb_agg(x) from (
          select jsonb_build_object('product_id', id, 'sku', sku, 'product_name', product_name, 'unit', unit, 'available', available,
            'reorder_level', reorder_level, 'gap', reorder_level - available) x
          from prod where reorder_level is not null and available <= reorder_level order by reorder_level - available desc, sku limit 50) y), '[]'::jsonb),
      'zero_stock_count', (select count(*) from prod where available <= 0),
      'zero_stock', coalesce((select jsonb_agg(x) from (
          select jsonb_build_object('product_id', id, 'sku', sku, 'product_name', product_name, 'unit', unit, 'storage_on_hand', storage_on_hand,
            'reserved', reserved, 'has_history', has_history) x
          from prod where available <= 0 order by has_history desc, sku limit 50) y), '[]'::jsonb),
      'reservation_utilisation', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'storage_on_hand', soh, 'reserved', rsv,
          'percent', case when soh = 0 then null else round(100.0 * rsv / soh, 1) end) order by unit)
        from (select unit, coalesce(sum(on_hand) filter (where stock_usage = 'STORAGE'), 0) soh, coalesce(sum(reserved) filter (where stock_usage = 'STORAGE'), 0) rsv
              from bal group by unit) x where soh <> 0 or rsv <> 0), '[]'::jsonb),
      'reservations_by_type', coalesce((select jsonb_agg(jsonb_build_object('reference_type', reference_type, 'unit', unit, 'quantity', q, 'reservations', n)
          order by reference_type, unit)
        from (select reference_type, unit, sum(open_qty) q, count(*) n from res group by reference_type, unit) x), '[]'::jsonb),
      'expiry', jsonb_build_object(
        'expired', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q, 'lots', n) order by unit)
          from (select unit, sum(on_hand) q, count(distinct batch_id) n from bal where track_expiry and expiry_date is not null and expiry_date < v_today and on_hand > 0
                group by unit) x), '[]'::jsonb),
        'expiring_30', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q, 'lots', n) order by unit)
          from (select unit, sum(on_hand) q, count(distinct batch_id) n from bal where track_expiry and expiry_date between v_today and v_today + 30 and on_hand > 0
                group by unit) x), '[]'::jsonb),
        'lots', coalesce((select jsonb_agg(x) from (
            select jsonb_build_object('product_id', product_id, 'sku', sku, 'batch_number', batch_number, 'expiry_date', expiry_date, 'unit', unit,
              'on_hand', sum(on_hand), 'days_left', expiry_date - v_today) x
            from bal where track_expiry and expiry_date is not null and expiry_date <= v_today + 30 and on_hand > 0
            group by product_id, sku, batch_number, expiry_date, unit order by expiry_date, sku limit 30) y), '[]'::jsonb))),
    'period', jsonb_build_object(
      'balances', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'opening', o, 'closing', c, 'net_change', c - o) order by unit)
        from (select unit, coalesce(sum(direction * quantity) filter (where transaction_date < v_start), 0) o,
                coalesce(sum(direction * quantity) filter (where transaction_date < v_end), 0) c
              from tx group by unit) x), '[]'::jsonb),
      'trend', coalesce((select jsonb_agg(jsonb_build_object('bucket', bucket, 'unit', unit, 'in', qi, 'out', qo) order by bucket, unit)
        from (select date_trunc(p_bucket, transaction_date at time zone v_tz)::date bucket, unit,
                coalesce(sum(quantity) filter (where direction = 1), 0) qi, coalesce(sum(quantity) filter (where direction = -1), 0) qo
              from moves group by 1, 2) x), '[]'::jsonb),
      'by_type', coalesce((select jsonb_agg(jsonb_build_object('transaction_type', transaction_type, 'unit', unit, 'in', qi, 'out', qo, 'transactions', n)
          order by transaction_type, unit)
        from (select transaction_type, unit, coalesce(sum(quantity) filter (where direction = 1), 0) qi,
                coalesce(sum(quantity) filter (where direction = -1), 0) qo, count(*) n
              from moves group by 1, 2) x), '[]'::jsonb),
      'transfers', jsonb_build_object(
        'count', (select count(distinct transfer_group_id) from transfers),
        'between_warehouses', (select count(distinct transfer_group_id) from transfers where from_wh <> to_wh),
        'routes', coalesce((select jsonb_agg(jsonb_build_object('from', fw.warehouse_code, 'to', tw.warehouse_code, 'unit', x.unit, 'quantity', x.q, 'transfers', x.n)
            order by fw.warehouse_code, tw.warehouse_code, x.unit)
          from (select from_wh, to_wh, unit, sum(quantity) q, count(distinct transfer_group_id) n from transfers group by 1, 2, 3) x
          join public.warehouses fw on fw.id = x.from_wh join public.warehouses tw on tw.id = x.to_wh), '[]'::jsonb)),
      'adjustments', jsonb_build_object(
        'posted', (select count(*) from adj where status = 'POSTED' and effective_date between p_from and p_to),
        'pending_approval', (select count(*) from adj where status = 'PENDING_APPROVAL'),
        'by_reason', coalesce((select jsonb_agg(jsonb_build_object('reason_code', reason_code, 'unit', unit, 'adjustments', n, 'increase', inc, 'decrease', dec)
            order by reason_code, unit)
          from (select reason_code, unit, count(*) n,
                  coalesce(sum(difference) filter (where adjustment_type = 'QUANTITY' and difference > 0), 0) inc,
                  coalesce(sum(-difference) filter (where adjustment_type = 'QUANTITY' and difference < 0), 0) dec
                from adj where status = 'POSTED' and effective_date between p_from and p_to group by 1, 2) x), '[]'::jsonb)),
      'counts', jsonb_build_object(
        'posted_counts', (select count(distinct count_id) from cnt),
        'lines_counted', (select count(*) from cnt),
        'lines_with_variance', (select count(*) from cnt where variance <> 0),
        'pending_review', (select count(*) from public.inventory_counts where company_id = v_company and status = 'SUBMITTED'
                           and (p_warehouse_id is null or warehouse_id = p_warehouse_id)),
        'by_unit', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'surplus', s, 'shortfall', d) order by unit)
          from (select unit, coalesce(sum(variance) filter (where variance > 0), 0) s, coalesce(sum(-variance) filter (where variance < 0), 0) d
                from cnt group by unit having bool_or(variance <> 0)) x), '[]'::jsonb),
        'rows', coalesce((select jsonb_agg(x) from (
            select jsonb_build_object('count_id', c.count_id, 'count_number', c.count_number, 'sku', p.sku, 'unit', c.unit,
              'system_quantity', c.system_quantity, 'counted_quantity', c.counted_quantity, 'variance', c.variance) x
            from cnt c join public.products p on p.id = c.product_id where c.variance <> 0 order by abs(c.variance) desc limit 20) y), '[]'::jsonb))),
    'valuation', case when private.has_permission(v_company, 'inventory_reports.read')
      then private.analytics_valuation(v_company, p_warehouse_id, p_category_id) else private.analytics_na('inventory_reports.read') end,
    'generated_at', now()
  ) into v;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Production and outsourcing analytics
-- -----------------------------------------------------------------------------
create or replace function public.analytics_production(
  p_from         date,
  p_to           date,
  p_warehouse_id uuid default null,
  p_product_id   uuid default null,
  p_supplier     text default null,
  p_order_id     uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('manufacturing.read');
  v_today   date := private.company_today(v_company);
  v_out     boolean := private.has_permission(v_company, 'outsourcing.read');
  v_prod    jsonb;
  v_os      jsonb;
begin
  perform private.analytics_check_period(p_from, p_to);

  with ord as (
    select o.*, p.sku, p.product_name from public.production_orders o join public.products p on p.id = o.finished_product_id
    where o.company_id = v_company
      and (p_warehouse_id is null or o.source_warehouse_id = p_warehouse_id or o.destination_warehouse_id = p_warehouse_id)
      and (p_product_id is null or o.finished_product_id = p_product_id) and (p_order_id is null or o.id = p_order_id)
  ),
  due as (select * from ord where target_completion_date between p_from and p_to and status not in ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED')),
  outp as (
    select r.*, o.production_order_number from public.production_output_receipts r join ord o on o.id = r.production_order_id
    where r.status = 'POSTED' and r.production_date between p_from and p_to
  ),
  cons as (
    select c.*, o.production_order_number, o.sku as order_sku from public.production_material_consumption c join ord o on o.id = c.production_order_id
    where c.status = 'POSTED' and c.consumption_date between p_from and p_to
  ),
  outlook as (select * from private.production_material_outlook(v_company, p_warehouse_id, p_product_id))
  select jsonb_build_object(
    'by_status', coalesce((select jsonb_agg(jsonb_build_object('status', status, 'orders', n) order by status)
      from (select status, count(*) n from ord where status not in ('COMPLETED', 'CANCELLED') or target_completion_date between p_from and p_to
              or actual_completion_date between p_from and p_to group by status) x), '[]'::jsonb),
    'orders_due', (select count(*) from due),
    'orders_due_completed', (select count(*) from due where status = 'COMPLETED'),
    'completion_rate', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where status = 'COMPLETED') / count(*), 1) end from due),
    'planned_vs_actual', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'planned', planned, 'good', good, 'rejected', rej, 'scrap', scrap,
        'rate', case when planned = 0 then null else round(100.0 * good / planned, 1) end) order by unit)
      from (select unit, sum(planned_quantity) planned, sum(completed_quantity) good, sum(rejected_quantity) rej, sum(scrap_quantity) scrap
            from due group by unit) x), '[]'::jsonb),
    'due_orders', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('order_id', id, 'order_number', production_order_number, 'sku', sku, 'unit', unit, 'status', status,
          'target_date', target_completion_date, 'planned', planned_quantity, 'good', completed_quantity) x
        from due order by target_completion_date, production_order_number limit 30) y), '[]'::jsonb),
    'output', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'good', good, 'rejected', rej, 'scrap', scrap) order by unit)
      from (select unit, sum(good_quantity) good, sum(rejected_quantity) rej, sum(scrap_quantity) scrap from outp group by unit) x), '[]'::jsonb),
    'output_by_month', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'unit', unit, 'good', good, 'rejected', rej, 'scrap', scrap) order by m, unit)
      from (select date_trunc('month', production_date::timestamp)::date m, unit, sum(good_quantity) good, sum(rejected_quantity) rej, sum(scrap_quantity) scrap
            from outp group by 1, 2) x), '[]'::jsonb),
    'material_outlook', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('product_id', component_product_id, 'sku', sku, 'product_name', product_name, 'unit', unit, 'warehouse', warehouse_code,
          'orders', orders, 'outstanding', outstanding, 'reserved_for_orders', reserved_for_orders, 'available', available, 'shortage', shortage,
          'order_numbers', order_numbers) x
        from outlook order by shortage desc, outstanding desc limit 25) y), '[]'::jsonb),
    'shortage_materials', (select count(distinct component_product_id) from outlook where shortage > 0),
    'consumption_by_order', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('order_id', production_order_id, 'order_number', production_order_number, 'product_sku', order_sku,
          'unit', unit, 'quantity', sum(actual_quantity), 'planned', sum(planned_quantity), 'issues', count(*)) x
        from cons group by production_order_id, production_order_number, order_sku, unit order by sum(actual_quantity) desc limit 20) y), '[]'::jsonb),
    'overdue_orders', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('order_id', id, 'order_number', production_order_number, 'sku', sku, 'status', status, 'unit', unit,
          'target_date', target_completion_date, 'days_late', v_today - target_completion_date, 'planned', planned_quantity, 'good', completed_quantity) x
        from ord where status not in ('DRAFT', 'COMPLETED', 'CANCELLED') and target_completion_date < v_today
        order by target_completion_date, production_order_number limit 30) y), '[]'::jsonb),
    'overdue_count', (select count(*) from ord where status not in ('DRAFT', 'COMPLETED', 'CANCELLED') and target_completion_date < v_today)
  ) into v_prod;

  if not v_out then
    v_os := private.analytics_na('outsourcing.read');
  else
    with oo as (
      select o.*, p.sku from public.outsourcing_orders o join public.products p on p.id = o.product_id
      where o.company_id = v_company and (p_warehouse_id is null or o.destination_warehouse_id = p_warehouse_id)
        and (p_product_id is null or o.product_id = p_product_id) and (p_supplier is null or lower(o.supplier_name) = lower(btrim(p_supplier)))
    ),
    open_oo as (select * from oo where status in ('APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED', 'ON_HOLD')),
    mv as (
      select m.*, oo.supplier_name from public.outsourcing_material_movements m join oo on oo.id = m.outsourcing_order_id
      where m.status = 'POSTED' and m.movement_date between p_from and p_to
    ),
    rc as (
      select r.*, oo.supplier_name from public.outsourcing_receipts r join oo on oo.id = r.outsourcing_order_id
      where r.status = 'POSTED' and r.receipt_date between p_from and p_to
    ),
    done as (
      select oo.*, (oo.completed_at at time zone private.company_tz(v_company))::date as completed_date
      from oo where status = 'COMPLETED' and dispatch_date is not null and completed_at is not null
        and (completed_at at time zone private.company_tz(v_company))::date between p_from and p_to
    )
    select jsonb_build_object(
      'available', true,
      'by_status', coalesce((select jsonb_agg(jsonb_build_object('status', status, 'orders', n) order by status)
        from (select status, count(*) n from oo where status not in ('COMPLETED', 'CANCELLED')
                or (completed_at at time zone private.company_tz(v_company))::date between p_from and p_to group by status) x), '[]'::jsonb),
      'held_by_suppliers', coalesce((select jsonb_agg(jsonb_build_object('supplier', supplier_name, 'sku', sku, 'unit', unit, 'quantity', q) order by supplier_name, sku)
        from (select oo.supplier_name, p.sku, m.unit, sum(m.dispatched_quantity - m.returned_quantity - m.consumed_quantity) q
              from public.outsourcing_order_materials m join open_oo oo on oo.id = m.outsourcing_order_id join public.products p on p.id = m.component_product_id
              group by 1, 2, 3 having sum(m.dispatched_quantity - m.returned_quantity - m.consumed_quantity) > 0) x), '[]'::jsonb),
      'external_stock', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'on_hand', q) order by unit)
        from (select p.base_unit unit, sum(b.on_hand) q from public.inventory_balances b join public.inventory_locations l on l.id = b.location_id
              join public.products p on p.id = b.product_id
              where b.company_id = v_company and l.stock_usage = 'EXTERNAL_PROCESSING' and b.on_hand > 0
                and (p_product_id is null or b.product_id = p_product_id) group by 1) x), '[]'::jsonb),
      'flows', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'dispatched', d, 'returned', r) order by unit)
        from (select unit, coalesce(sum(quantity) filter (where movement_type = 'DISPATCH'), 0) d, coalesce(sum(quantity) filter (where movement_type = 'RETURN'), 0) r
              from mv where movement_type in ('DISPATCH', 'RETURN') group by unit) x), '[]'::jsonb),
      'received', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'received', rq, 'accepted', aq, 'rejected', jq) order by unit)
        from (select unit, sum(received_quantity) rq, sum(accepted_quantity) aq, sum(rejected_quantity) jq from rc group by unit) x), '[]'::jsonb),
      'awaiting_receipt', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit)
        from (select unit, sum(greatest(ordered_quantity - received_quantity, 0)) q from open_oo group by unit
              having sum(greatest(ordered_quantity - received_quantity, 0)) > 0) x), '[]'::jsonb),
      'lead_time', jsonb_build_object(
        'orders', (select count(*) from done),
        'average_days', (select round(avg(completed_date - dispatch_date), 1) from done),
        'definition', 'Days from material dispatch date to completion of the outsourcing order, for orders completed in the period that have both dates.'),
      'overdue', coalesce((select jsonb_agg(x) from (
          select jsonb_build_object('order_id', id, 'order_number', outsourcing_order_number, 'supplier', supplier_name, 'sku', sku, 'status', status,
            'expected_return_date', expected_return_date, 'days_late', v_today - expected_return_date, 'unit', unit,
            'outstanding', greatest(ordered_quantity - received_quantity, 0)) x
          from oo where status in ('APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED') and expected_return_date < v_today
          order by expected_return_date limit 30) y), '[]'::jsonb),
      'suppliers', coalesce((select jsonb_agg(distinct supplier_name order by supplier_name) from public.outsourcing_orders where company_id = v_company), '[]'::jsonb)
    ) into v_os;
  end if;

  return v_prod || jsonb_build_object('from', p_from, 'to', p_to, 'today', v_today,
    'has_records', exists (select 1 from public.production_orders where company_id = v_company)
                   or exists (select 1 from public.outsourcing_orders where company_id = v_company),
    'outsourcing', v_os, 'generated_at', now());
end;
$$;

-- -----------------------------------------------------------------------------
-- Customer PO and fulfilment pipeline
-- -----------------------------------------------------------------------------
create or replace function public.analytics_fulfilment(
  p_from         date,
  p_to           date,
  p_customer_key text default null,
  p_warehouse_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('dashboard.read');
  v_tz      text := private.company_tz(v_company);
  v_po      jsonb;
  v_so      jsonb;
begin
  perform private.analytics_check_period(p_from, p_to);

  if not private.has_permission(v_company, 'customer_po.read') then
    v_po := private.analytics_na('customer_po.read');
  else
    with pos as (
      select po.* from public.customer_purchase_orders po
      where po.company_id = v_company and po.is_current and (p_customer_key is null or po.customer_key = p_customer_key)
        and (p_warehouse_id is null or po.fulfilment_warehouse_id = p_warehouse_id)
    ),
    open_pos as (select * from pos where status not in ('DRAFT', 'CANCELLED', 'FULFILLED') and private.po_active_sales_orders(id) is null),
    short as (
      select distinct po.id from open_pos po cross join lateral private.po_line_analysis(v_company, po.id) a
      where a.line_status = 'MATCHED' and a.shortage_before > 0 and po.status not in ('UPLOADED', 'VALIDATION_REQUIRED')
    )
    select jsonb_build_object(
      'available', true,
      'has_records', exists (select 1 from public.customer_purchase_orders where company_id = v_company),
      'imported', (select count(*) from pos where created_at >= private.company_day_start(v_company, p_from) and created_at < private.company_day_start(v_company, p_to + 1)),
      'awaiting_validation', (select count(*) from pos where status in ('UPLOADED', 'VALIDATION_REQUIRED')),
      'unresolved_mappings', (select count(*) from pos p where p.status not in ('DRAFT', 'CANCELLED', 'FULFILLED')
        and (p.status = 'PRODUCT_MATCHING_REQUIRED' or exists (select 1 from public.customer_purchase_order_lines l where l.purchase_order_id = p.id
             and l.line_status in ('UNMATCHED', 'AMBIGUOUS', 'INVALID', 'DUPLICATE_REVIEW')))),
      'ready_for_fulfilment', (select count(*) from open_pos where status = 'READY_FOR_ALLOCATION'),
      'partially_allocated', (select count(*) from open_pos where status = 'PARTIALLY_ALLOCATED'),
      'fully_allocated', (select count(*) from open_pos where status = 'FULLY_ALLOCATED'),
      'with_shortages', (select count(*) from short),
      'converted_to_sales_orders', (select count(*) from pos where private.po_active_sales_orders(id) is not null),
      'by_status', coalesce((select jsonb_agg(jsonb_build_object('status', status, 'count', n) order by status)
        from (select status, count(*) n from pos group by status) x), '[]'::jsonb)
    ) into v_po;
  end if;

  if not private.has_permission(v_company, 'sales_orders.read') then
    v_so := private.analytics_na('sales_orders.read');
  else
    with so as (
      select s.*,
        exists (select 1 from public.fulfilments f where f.sales_order_id = s.id and f.fulfilment_status in ('PENDING', 'PICKING')) as picking,
        exists (select 1 from public.fulfilments f where f.sales_order_id = s.id and f.fulfilment_status in ('PICKED', 'PACKING', 'PACKED')) as packing,
        exists (select 1 from public.fulfilments f where f.sales_order_id = s.id and f.fulfilment_status = 'READY_FOR_DISPATCH') as ready,
        (select max(f.actual_dispatch_at) from public.fulfilments f where f.sales_order_id = s.id) as last_dispatch_at
      from public.sales_orders s
      where s.company_id = v_company and (p_customer_key is null or s.customer_key = p_customer_key)
        and (p_warehouse_id is null or s.warehouse_id = p_warehouse_id)
    ),
    open_so as (select * from so where order_status not in ('DRAFT', 'CANCELLED', 'FULFILLED')),
    period_so as (select * from so where order_date between p_from and p_to and order_status not in ('DRAFT', 'CANCELLED')),
    period_lines as (select l.* from public.sales_order_lines l join period_so s on s.id = l.sales_order_id)
    select jsonb_build_object(
      'available', true,
      'has_records', exists (select 1 from public.sales_orders where company_id = v_company),
      'awaiting_confirmation', (select count(*) from open_so where order_status = 'PENDING_CONFIRMATION'),
      'awaiting_allocation', (select count(*) from open_so where order_status in ('CONFIRMED', 'PARTIALLY_ALLOCATED')),
      'awaiting_picking', (select count(*) from open_so where picking),
      'awaiting_packing', (select count(*) from open_so where packing),
      'awaiting_dispatch', (select count(*) from open_so where ready),
      'partially_dispatched', (select count(*) from open_so where fulfilment_status = 'PARTIALLY_DISPATCHED' or order_status = 'PARTIALLY_FULFILLED'),
      'on_hold', (select count(*) from open_so where order_status = 'ON_HOLD'),
      'completed_in_period', (select count(*) from so where order_status = 'FULFILLED' and last_dispatch_at is not null
                               and (last_dispatch_at at time zone v_tz)::date between p_from and p_to),
      'orders_in_period', (select count(*) from period_so),
      'fully_dispatched_in_period', (select count(*) from period_so s where not exists (select 1 from public.sales_order_lines l where l.sales_order_id = s.id
                                     and l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched > 0)),
      'fulfilment_rate', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where not exists (
                            select 1 from public.sales_order_lines l where l.sales_order_id = s.id and l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched > 0)) / count(*), 1) end
                          from period_so s),
      'units', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'ordered', o, 'dispatched', d,
          'rate', case when o = 0 then null else round(100.0 * d / o, 1) end) order by unit)
        from (select unit, sum(quantity_ordered - quantity_cancelled) o, sum(quantity_dispatched) d from period_lines group by unit) x), '[]'::jsonb),
      'by_status', coalesce((select jsonb_agg(jsonb_build_object('status', order_status, 'count', n) order by order_status)
        from (select order_status, count(*) n from open_so group by order_status) x), '[]'::jsonb)
    ) into v_so;
  end if;

  return jsonb_build_object('from', p_from, 'to', p_to, 'purchase_orders', v_po, 'sales_orders', v_so, 'generated_at', now());
end;
$$;

-- -----------------------------------------------------------------------------
-- Shortage report (open sales-order lines and unconverted customer-PO lines)
-- -----------------------------------------------------------------------------
create or replace function public.analytics_shortages(
  p_customer_key text default null,
  p_warehouse_id uuid default null,
  p_product_id   uuid default null,
  p_only_short   boolean default true,
  p_limit        integer default 50,
  p_offset       integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('customer_po_shortages.read');
  v_so      boolean := private.has_permission(v_company, 'sales_orders.read');
  v_po      boolean := private.has_permission(v_company, 'customer_po.read');
  v         jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 or p_offset is null or p_offset < 0 then
    raise exception 'Page size must be 1-500.' using errcode = 'P0001';
  end if;

  with src as (
    select 'SALES_ORDER'::text as source, so.customer_po_number, so.sales_order_number, so.id as sales_order_id, so.customer_purchase_order_id as po_id,
      so.customer_name_snapshot as customer, l.product_id, l.unit, l.quantity_ordered - l.quantity_cancelled as ordered, l.quantity_dispatched as dispatched,
      private.so_line_open_reserved(l.id) as reserved, coalesce(p_warehouse_id, so.warehouse_id) as wh
    from public.sales_order_lines l join public.sales_orders so on so.id = l.sales_order_id
    where v_so and so.company_id = v_company and so.order_status not in ('DRAFT', 'CANCELLED', 'FULFILLED') and l.line_status in ('OPEN', 'PARTIALLY_FULFILLED')
      and (p_customer_key is null or so.customer_key = p_customer_key) and (p_product_id is null or l.product_id = p_product_id)
      and (p_warehouse_id is null or so.warehouse_id is null or so.warehouse_id = p_warehouse_id)
    union all
    select 'CUSTOMER_PO', po.customer_po_number, null, null, po.id, po.customer_name_snapshot, l.product_id, l.unit,
      l.quantity_ordered - private.po_line_converted(l.id), l.quantity_dispatched,
      coalesce((select sum(r.quantity - r.fulfilled_quantity - r.released_quantity) from public.stock_reservations r
                where r.reference_type = 'CUSTOMER_PO' and r.reference_id = l.id and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')), 0),
      coalesce(p_warehouse_id, po.fulfilment_warehouse_id)
    from public.customer_purchase_order_lines l join public.customer_purchase_orders po on po.id = l.purchase_order_id
    where v_po and po.company_id = v_company and po.is_current and po.status not in ('DRAFT', 'CANCELLED', 'FULFILLED', 'ON_HOLD')
      and l.line_status = 'MATCHED' and l.product_id is not null and l.quantity_ordered - private.po_line_converted(l.id) > 0
      and (p_customer_key is null or po.customer_key = p_customer_key) and (p_product_id is null or l.product_id = p_product_id)
      and (p_warehouse_id is null or po.fulfilment_warehouse_id is null or po.fulfilment_warehouse_id = p_warehouse_id)
  ),
  short_rows as (
    select s.*, p.sku, p.product_name, p.default_source_type, p.has_bom,
      greatest(s.ordered - s.dispatched, 0) as remaining,
      greatest(s.ordered - s.dispatched - s.reserved, 0) as required,
      e.available, e.in_house, e.outsourced,
      greatest(s.ordered - s.dispatched - s.reserved - e.available, 0) as shortage
    from src s join public.products p on p.id = s.product_id
    cross join lateral private.analytics_eligible(v_company, s.product_id, s.wh) e
    where s.ordered - s.dispatched > 0
  ),
  filtered as (select * from short_rows where not p_only_short or shortage > 0),
  product_totals as (
    select r.product_id, r.sku, r.product_name, r.unit, sum(r.required) as required, e.available,
      greatest(sum(r.required) - e.available, 0) as net_shortage, count(*) as lines
    from short_rows r cross join lateral private.analytics_eligible(v_company, r.product_id, p_warehouse_id) e
    group by r.product_id, r.sku, r.product_name, r.unit, e.available
  )
  select jsonb_build_object(
    'available', true,
    'sources', jsonb_build_object('sales_orders', v_so, 'purchase_orders', v_po),
    'total', (select count(*) from filtered),
    'rows', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('source', source, 'customer_po_number', customer_po_number, 'sales_order_number', sales_order_number,
          'sales_order_id', sales_order_id, 'purchase_order_id', po_id, 'customer', customer, 'product_id', product_id, 'sku', sku,
          'product_name', product_name, 'unit', unit, 'ordered', ordered, 'dispatched', dispatched, 'reserved', least(reserved, remaining),
          'available', available, 'remaining_required', required, 'shortage', shortage, 'in_house', in_house, 'outsourced', outsourced,
          'next_action', case
            when required <= 0 then 'Fully reserved — pick, pack and dispatch'
            when shortage = 0 then 'Allocate eligible stock that is available now'
            else (case when shortage < required then 'Allocate what is available, then ' else '' end)
              || case when default_source_type = 'OUTSOURCED' then 'raise an outsourcing order'
                      when has_bom then 'plan production'
                      when default_source_type = 'HYBRID' then 'plan production or outsourcing'
                      else 'review replenishment (no BOM)' end
          end) x
        from filtered order by shortage desc, required desc, sku, coalesce(sales_order_number, customer_po_number)
        limit p_limit offset p_offset) y), '[]'::jsonb),
    'product_totals', coalesce((select jsonb_agg(jsonb_build_object('product_id', product_id, 'sku', sku, 'product_name', product_name, 'unit', unit,
        'required', required, 'available', available, 'net_shortage', net_shortage, 'lines', lines) order by net_shortage desc, sku)
      from product_totals where net_shortage > 0), '[]'::jsonb),
    'definition', 'Remaining required = ordered - dispatched - reserved. Eligible available = unreserved stock in active storage locations (not expired, not quarantined, known source) that any open line could use; it is shared, so the product totals subtract it once.',
    'generated_at', now()
  ) into v;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Financial overview (operational billing and receivables only)
-- -----------------------------------------------------------------------------
create or replace function public.analytics_finance(
  p_from        date,
  p_to          date,
  p_as_of       date default null,
  p_customer_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('billing_reports.read');
  v_tz      text := private.company_tz(v_company);
  v_as_of   date := coalesce(p_as_of, least(p_to, private.company_today(v_company)));
  v_payments boolean := private.has_permission(v_company, 'payments.read');
  v         jsonb;
begin
  perform private.analytics_check_period(p_from, p_to);

  with pos as (select * from private.invoice_position_as_of(v_company, v_as_of) p where p_customer_id is null or p.customer_id = p_customer_id),
  pos_end as (select * from private.invoice_position_as_of(v_company, p_to) p where p_customer_id is null or p.customer_id = p_customer_id),
  inv as (
    select * from public.sales_invoices i
    where i.company_id = v_company and i.status = 'ISSUED' and i.invoice_date between p_from and p_to and (p_customer_id is null or i.customer_id = p_customer_id)
  ),
  rec as (
    select * from public.customer_payments p
    where p.company_id = v_company and p.receipt_date between p_from and p_to and (p_customer_id is null or p.customer_id = p_customer_id)
  ),
  alloc as (
    select a.* from public.invoice_payment_allocations a join public.sales_invoices i on i.id = a.invoice_id
    where a.company_id = v_company and a.allocation_date between p_from and p_to
      and (a.status = 'ACTIVE' or (a.reversed_at at time zone v_tz)::date > p_to)
      and (p_customer_id is null or i.customer_id = p_customer_id)
  ),
  settled as (
    select pe.invoice_id, pe.invoice_date,
      (select max(a.allocation_date) from public.invoice_payment_allocations a where a.invoice_id = pe.invoice_id
        and a.allocation_date <= p_to and (a.status = 'ACTIVE' or (a.reversed_at at time zone v_tz)::date > p_to)) as last_alloc
    from pos_end pe where pe.balance <= 0 and pe.paid > 0
  ),
  notes as (
    select * from public.invoice_adjustment_notes n
    where n.company_id = v_company and n.status = 'ISSUED' and n.note_date between p_from and p_to and (p_customer_id is null or n.customer_id = p_customer_id)
  ),
  months as (
    select m::date as month from generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') m
  ),
  unalloc as (
    select p.*, p.amount_received - private.payment_allocated(p.id) as unallocated, c.customer_code, coalesce(c.legal_name, c.customer_name) as customer_name
    from public.customer_payments p join public.customers c on c.id = p.customer_id
    where p.company_id = v_company and p.status = 'RECORDED' and (p_customer_id is null or p.customer_id = p_customer_id)
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'as_of', v_as_of,
    'currency', (select currency_code from public.companies where id = v_company),
    'has_records', exists (select 1 from public.sales_invoices where company_id = v_company and status in ('ISSUED', 'CANCELLED')),
    'totals', jsonb_build_object(
      'invoices', (select count(*) from inv),
      'invoiced', (select coalesce(sum(grand_total), 0) from inv),
      'invoiced_taxable', (select coalesce(sum(taxable_subtotal), 0) from inv),
      'collected', (select coalesce(sum(amount_received), 0) from rec where status = 'RECORDED'),
      'receipts', (select count(*) from rec where status = 'RECORDED'),
      'reversed_receipts', (select coalesce(sum(amount_received), 0) from rec where status = 'REVERSED'),
      'allocated_in_period', (select coalesce(sum(allocated_amount), 0) from alloc),
      'outstanding', (select coalesce(sum(balance), 0) from pos where balance > 0),
      'overdue', (select coalesce(sum(balance), 0) from pos where balance > 0 and days_overdue > 0),
      'customer_credits', (select coalesce(sum(-balance), 0) from pos where balance < 0),
      'credit_notes', (select coalesce(sum(total_amount), 0) from notes where note_type = 'CREDIT'),
      'debit_notes', (select coalesce(sum(total_amount), 0) from notes where note_type = 'DEBIT'),
      'unallocated', (select coalesce(sum(unallocated), 0) from unalloc where unallocated > 0)),
    'collection_rate', jsonb_build_object(
      'allocated', (select coalesce(sum(allocated_amount), 0) from alloc),
      'open_at_end', (select coalesce(sum(balance), 0) from pos_end where balance > 0),
      'percent', (select case when a + o = 0 then null else round(100.0 * a / (a + o), 1) end
                  from (select (select coalesce(sum(allocated_amount), 0) from alloc) a, (select coalesce(sum(balance), 0) from pos_end where balance > 0) o) x),
      'definition', 'Receipts allocated to invoices with an allocation date in the period ÷ (those allocations + invoice balances still open at the end of the period). Both sides are invoice money; order values are never used.'),
    'collection_time', jsonb_build_object(
      'invoices', (select count(*) from settled where last_alloc between p_from and p_to),
      'average_days', (select round(avg(last_alloc - invoice_date), 1) from settled where last_alloc between p_from and p_to),
      'definition', 'Average days from invoice date to the allocation that settled it, for invoices fully settled by allocations dated in the period (invoices settled only by credit notes are excluded).'),
    'monthly', (select jsonb_agg(jsonb_build_object('month', m.month,
        'invoiced', coalesce((select sum(grand_total) from inv where date_trunc('month', invoice_date::timestamp)::date = m.month), 0),
        'invoices', (select count(*) from inv where date_trunc('month', invoice_date::timestamp)::date = m.month),
        'collected', coalesce((select sum(amount_received) from rec where status = 'RECORDED' and date_trunc('month', receipt_date::timestamp)::date = m.month), 0),
        'credit_notes', coalesce((select sum(total_amount) from notes where note_type = 'CREDIT' and date_trunc('month', note_date::timestamp)::date = m.month), 0),
        'debit_notes', coalesce((select sum(total_amount) from notes where note_type = 'DEBIT' and date_trunc('month', note_date::timestamp)::date = m.month), 0))
        order by m.month) from months m),
    'ageing', (select jsonb_agg(jsonb_build_object('bucket', b, 'amount', coalesce((select sum(balance) from pos where balance > 0 and bucket = b), 0),
        'invoices', (select count(*) from pos where balance > 0 and bucket = b)) order by ord)
      from (values ('NOT_DUE', 1), ('1_30', 2), ('31_60', 3), ('61_90', 4), ('OVER_90', 5)) bk(b, ord)),
    'by_customer', coalesce((select jsonb_agg(x order by (x ->> 'balance')::numeric desc) from (
        select jsonb_build_object('customer_id', customer_id, 'customer', max(customer_name), 'balance', sum(balance),
          'overdue', coalesce(sum(balance) filter (where days_overdue > 0), 0), 'invoices', count(*), 'oldest_days_overdue', max(days_overdue)) x
        from pos where balance > 0 group by customer_id order by sum(balance) desc limit 25) y), '[]'::jsonb),
    'customers_with_balance', (select count(distinct customer_id) from pos where balance > 0),
    'top_overdue', coalesce((select jsonb_agg(x order by (x ->> 'overdue')::numeric desc) from (
        select jsonb_build_object('customer_id', customer_id, 'customer', max(customer_name), 'overdue', sum(balance), 'invoices', count(*),
          'oldest_days_overdue', max(days_overdue)) x
        from pos where balance > 0 and days_overdue > 0 group by customer_id order by sum(balance) desc limit 10) y), '[]'::jsonb),
    'upcoming_due', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('invoice_id', invoice_id, 'invoice_number', invoice_number, 'customer', customer_name, 'due_date', due_date,
          'balance', balance, 'days_to_due', due_date - v_as_of) x
        from pos where balance > 0 and due_date between v_as_of and v_as_of + 30 order by due_date, invoice_number limit 25) y), '[]'::jsonb),
    'upcoming_due_total', (select coalesce(sum(balance), 0) from pos where balance > 0 and due_date between v_as_of and v_as_of + 30),
    'notes_by_reason', coalesce((select jsonb_agg(jsonb_build_object('note_type', note_type, 'reason_code', reason_code, 'notes', n, 'total', t) order by note_type, reason_code)
      from (select note_type, reason_code, count(*) n, sum(total_amount) t from notes group by 1, 2) x), '[]'::jsonb),
    'unallocated_receipts', case when v_payments then coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('payment_id', id, 'receipt_number', receipt_number, 'receipt_date', receipt_date, 'customer', customer_name,
          'amount', amount_received, 'unallocated', unallocated) x
        from unalloc where unallocated > 0 order by receipt_date, receipt_number limit 25) y), '[]'::jsonb) end,
    'unavailable_metrics', jsonb_build_array(
      jsonb_build_object('metric', 'Profit and gross margin', 'reason', 'Needs a verified cost of goods sold for every invoiced line. Lot costs are incomplete and no cost-of-sales postings exist.'),
      jsonb_build_object('metric', 'Net income', 'reason', 'The ERP has no general ledger, expense or payroll records.'),
      jsonb_build_object('metric', 'Cash flow', 'reason', 'Only customer receipts are recorded; supplier payments, expenses and bank balances are not.')),
    'generated_at', now()
  ) into v;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Executive alerts: computed on request from defined rules. Nothing is stored,
-- so a refresh can never create duplicates; each alert has a stable id
-- (rule:record id) that the client uses as its key. No action is performed.
-- -----------------------------------------------------------------------------
create or replace function public.analytics_alerts(p_as_of date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('dashboard.read');
  v_tz      text := private.company_tz(v_company);
  v_today   date := private.company_today(v_company);
  v_as_of   date := coalesce(p_as_of, private.company_today(v_company));
  v_alerts  jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_part    jsonb;
  c_limit   constant int := 100;
begin
  -- Inventory
  if private.has_permission(v_company, 'inventory.read') then
    with prod as (
      select p.id, p.sku, p.product_name, p.base_unit, p.reorder_level,
        coalesce(sum(b.on_hand - b.reserved) filter (where l.stock_usage = 'STORAGE'), 0) as available,
        max(b.last_movement_at) as last_movement_at,
        exists (select 1 from public.inventory_transactions t where t.product_id = p.id) as has_history
      from public.products p
      left join public.inventory_balances b on b.product_id = p.id
      left join public.inventory_locations l on l.id = b.location_id
      where p.company_id = v_company and p.status = 'ACTIVE' and p.archived_at is null
      group by p.id
    ),
    demand as (select product_id, sum(so_need + po_need) as need from private.analytics_open_demand(v_company) group by product_id)
    select coalesce(jsonb_agg(a), '[]'::jsonb) into v_part from (
      (select jsonb_build_object('id', 'LOW_STOCK:' || id, 'type', 'LOW_STOCK', 'severity', 'MEDIUM', 'team', 'INVENTORY',
         'title', 'Below reorder level', 'reference', sku, 'record_id', id,
         'detected_at', coalesce((last_movement_at at time zone v_tz)::date, v_today),
         'explanation', format('%s available against a reorder level of %s %s.', trim_scale(available), trim_scale(reorder_level), base_unit),
         'action', 'Plan replenishment (production, outsourcing or purchase).', 'link', '/inventory/stock/' || id) a
       from prod where available > 0 and reorder_level is not null and available <= reorder_level order by available / nullif(reorder_level, 0), sku limit c_limit)
      union all
      (select jsonb_build_object('id', 'ZERO_STOCK:' || p.id, 'type', 'ZERO_STOCK', 'severity', case when d.need > 0 then 'HIGH' else 'MEDIUM' end, 'team', 'INVENTORY',
         'title', 'No available stock', 'reference', p.sku, 'record_id', p.id,
         'detected_at', coalesce((p.last_movement_at at time zone v_tz)::date, v_today),
         'explanation', case when d.need > 0 then format('No available stock while open orders still need %s %s.', trim_scale(d.need), p.base_unit)
                             else 'No available stock in storage locations.' end,
         'action', 'Replenish or review reservations.', 'link', '/inventory/stock/' || p.id)
       from prod p left join demand d on d.product_id = p.id
       where p.has_history and p.available <= 0 order by coalesce(d.need, 0) desc, p.sku limit c_limit)
    ) x;
    v_alerts := v_alerts || v_part;

    select coalesce(jsonb_agg(a), '[]'::jsonb) into v_part from (
      (select jsonb_build_object('id', 'COUNT_REVIEW:' || c.id, 'type', 'INVENTORY_DISCREPANCY', 'severity', 'MEDIUM', 'team', 'INVENTORY',
         'title', 'Stock count awaiting approval', 'reference', c.count_number, 'record_id', c.id,
         'detected_at', (coalesce(c.submitted_at, c.created_at) at time zone v_tz)::date,
         'explanation', format('%s counted line(s) differ from the system quantity.', (select count(*) from public.inventory_count_lines cl where cl.count_id = c.id and cl.variance <> 0)),
         'action', 'Review and approve or reject the count.', 'link', '/inventory/counts/' || c.id) a
       from public.inventory_counts c where c.company_id = v_company and c.status = 'SUBMITTED' order by c.submitted_at limit c_limit)
      union all
      (select jsonb_build_object('id', 'ADJ_REVIEW:' || a.id, 'type', 'INVENTORY_DISCREPANCY', 'severity', 'MEDIUM', 'team', 'INVENTORY',
         'title', 'Stock adjustment awaiting approval', 'reference', a.adjustment_number, 'record_id', a.id,
         'detected_at', (a.requested_at at time zone v_tz)::date,
         'explanation', format('%s adjustment (%s) awaits approval.', initcap(lower(a.adjustment_type)), lower(replace(a.reason_code, '_', ' '))),
         'action', 'Review the adjustment.', 'link', '/inventory/adjustments')
       from public.inventory_adjustments a where a.company_id = v_company and a.status = 'PENDING_APPROVAL' order by a.requested_at limit c_limit)
    ) x;
    v_alerts := v_alerts || v_part;
  else
    v_skipped := v_skipped || jsonb_build_array('Inventory alerts need inventory.read');
  end if;

  -- Sales orders and dispatch
  if private.has_permission(v_company, 'sales_orders.read') then
    with ol as (
      select l.id, l.sales_order_id, so.sales_order_number, so.order_date, l.sku_snapshot, l.unit,
        greatest(l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched - private.so_line_open_reserved(l.id), 0) as need
      from public.sales_order_lines l join public.sales_orders so on so.id = l.sales_order_id
      where so.company_id = v_company and so.order_status in ('CONFIRMED', 'PARTIALLY_ALLOCATED', 'READY_FOR_FULFILMENT', 'IN_FULFILMENT', 'PARTIALLY_FULFILLED')
        and l.line_status in ('OPEN', 'PARTIALLY_FULFILLED')
    ),
    sl as (select o.*, private.so_line_available_now(o.id) as avail from ol o where o.need > 0)
    select coalesce(jsonb_agg(a), '[]'::jsonb) into v_part from (
      select jsonb_build_object('id', 'SO_SHORTAGE:' || sales_order_id, 'type', 'SO_SHORTAGE', 'severity', 'HIGH', 'team', 'SALES',
        'title', 'Stock shortage on an open order', 'reference', sales_order_number, 'record_id', sales_order_id, 'detected_at', min(order_date),
        'explanation', string_agg(format('%s short by %s %s', sku_snapshot, trim_scale(need - avail), unit), '; ' order by sku_snapshot),
        'action', 'Allocate stock when it arrives or plan replenishment; inform the customer of the backorder.',
        'link', '/sales/order-details?so=' || sales_order_id) a
      from sl where need > avail group by sales_order_id, sales_order_number order by min(order_date) limit c_limit
    ) x;
    v_alerts := v_alerts || v_part;

    select coalesce(jsonb_agg(a), '[]'::jsonb) into v_part from (
      select jsonb_build_object('id', 'AWAITING_DISPATCH:' || f.id, 'type', 'AWAITING_DISPATCH',
        'severity', case when f.planned_dispatch_date < v_as_of then 'HIGH' else 'MEDIUM' end, 'team', 'SALES',
        'title', 'Packed consignment awaiting dispatch', 'reference', f.fulfilment_number || ' · ' || so.sales_order_number, 'record_id', f.id,
        'detected_at', (coalesce(f.ready_at, f.updated_at) at time zone v_tz)::date,
        'explanation', case when f.planned_dispatch_date < v_as_of then format('Ready since %s; planned dispatch date %s has passed.', (coalesce(f.ready_at, f.updated_at) at time zone v_tz)::date, f.planned_dispatch_date)
                            else format('Ready for dispatch since %s.', (coalesce(f.ready_at, f.updated_at) at time zone v_tz)::date) end,
        'action', 'Post the dispatch with transport details.', 'link', '/sales/dispatch?f=' || f.id) a
      from public.fulfilments f join public.sales_orders so on so.id = f.sales_order_id
      where f.company_id = v_company and f.fulfilment_status = 'READY_FOR_DISPATCH' order by f.ready_at limit c_limit
    ) x;
    v_alerts := v_alerts || v_part;
  else
    v_skipped := v_skipped || jsonb_build_array('Sales order and dispatch alerts need sales_orders.read');
  end if;

  -- Production and outsourcing
  if private.has_permission(v_company, 'manufacturing.read') then
    select coalesce(jsonb_agg(a), '[]'::jsonb) into v_part from (
      select jsonb_build_object('id', 'PRODUCTION_DELAYED:' || o.id, 'type', 'PRODUCTION_DELAYED',
        'severity', case when v_as_of - o.target_completion_date > 7 then 'HIGH' else 'MEDIUM' end, 'team', 'PRODUCTION',
        'title', 'Production order past its target date', 'reference', o.production_order_number, 'record_id', o.id, 'detected_at', o.target_completion_date + 1,
        'explanation', format('%s: %s of %s %s completed; target %s (%s day(s) late).', p.sku, trim_scale(o.completed_quantity), trim_scale(o.planned_quantity), o.unit,
                              o.target_completion_date, v_as_of - o.target_completion_date),
        'action', 'Review progress and material availability, or revise the plan.', 'link', '/production/orders/' || o.id) a
      from public.production_orders o join public.products p on p.id = o.finished_product_id
      where o.company_id = v_company and o.status not in ('DRAFT', 'COMPLETED', 'CANCELLED') and o.target_completion_date < v_as_of
      order by o.target_completion_date limit c_limit
    ) x;
    v_alerts := v_alerts || v_part;
  else
    v_skipped := v_skipped || jsonb_build_array('Production alerts need manufacturing.read');
  end if;
  if private.has_permission(v_company, 'outsourcing.read') then
    select coalesce(jsonb_agg(a), '[]'::jsonb) into v_part from (
      select jsonb_build_object('id', 'OUTSOURCING_OVERDUE:' || o.id, 'type', 'OUTSOURCING_OVERDUE',
        'severity', case when v_as_of - o.expected_return_date > 7 then 'HIGH' else 'MEDIUM' end, 'team', 'PURCHASE',
        'title', 'Outsourced goods not returned by the expected date', 'reference', o.outsourcing_order_number || ' · ' || o.supplier_name,
        'record_id', o.id, 'detected_at', o.expected_return_date + 1,
        'explanation', format('%s of %s %s still to be received; expected back on %s.', trim_scale(greatest(o.ordered_quantity - o.received_quantity, 0)),
                              trim_scale(o.ordered_quantity), o.unit, o.expected_return_date),
        'action', 'Follow up with the supplier and record the receipt when goods arrive.', 'link', '/production/outsourcing/' || o.id) a
      from public.outsourcing_orders o
      where o.company_id = v_company and o.status in ('APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED') and o.expected_return_date < v_as_of
      order by o.expected_return_date limit c_limit
    ) x;
    v_alerts := v_alerts || v_part;
  else
    v_skipped := v_skipped || jsonb_build_array('Outsourcing alerts need outsourcing.read');
  end if;

  -- Customer purchase orders
  if private.has_permission(v_company, 'customer_po.read') then
    select coalesce(jsonb_agg(a), '[]'::jsonb) into v_part from (
      (select jsonb_build_object('id', 'PO_UNMATCHED:' || po.id, 'type', 'PO_UNMATCHED', 'severity', 'MEDIUM', 'team', 'SALES',
         'title', 'Purchase order lines not matched to products', 'reference', po.customer_po_number || ' (' || po.po_reference || ')', 'record_id', po.id,
         'detected_at', (po.created_at at time zone v_tz)::date,
         'explanation', format('%s line(s) unmatched, ambiguous, invalid or flagged as duplicates.', x.n),
         'action', 'Resolve the product mapping.', 'link', '/customer-pos/matching?po=' || po.id) a
       from public.customer_purchase_orders po
       cross join lateral (select count(*) n from public.customer_purchase_order_lines l where l.purchase_order_id = po.id
                           and l.line_status in ('UNMATCHED', 'AMBIGUOUS', 'INVALID', 'DUPLICATE_REVIEW')) x
       where po.company_id = v_company and po.is_current and po.status not in ('DRAFT', 'CANCELLED', 'FULFILLED') and x.n > 0
       order by po.created_at limit c_limit)
      union all
      (select jsonb_build_object('id', 'PO_UNALLOCATED:' || po.id, 'type', 'PO_UNALLOCATED', 'severity', 'LOW', 'team', 'SALES',
         'title', 'Purchase order not yet allocated or converted', 'reference', po.customer_po_number || ' (' || po.po_reference || ')', 'record_id', po.id,
         'detected_at', (po.created_at at time zone v_tz)::date,
         'explanation', format('Status %s; no sales order created yet.', lower(replace(po.status, '_', ' '))),
         'action', 'Allocate stock or convert to a sales order.', 'link', '/customer-pos/fulfilment?po=' || po.id)
       from public.customer_purchase_orders po
       where po.company_id = v_company and po.is_current and po.status in ('READY_FOR_ALLOCATION', 'PARTIALLY_ALLOCATED')
         and private.po_active_sales_orders(po.id) is null
       order by po.created_at limit c_limit)
    ) x;
    v_alerts := v_alerts || v_part;
  else
    v_skipped := v_skipped || jsonb_build_array('Purchase order alerts need customer_po.read');
  end if;

  -- Receivables and receipts
  if private.has_permission(v_company, 'billing_reports.read') then
    select coalesce(jsonb_agg(a), '[]'::jsonb) into v_part from (
      (select jsonb_build_object('id', 'INVOICE_OVERDUE:' || p.invoice_id, 'type', 'INVOICE_OVERDUE',
         'severity', case when p.days_overdue > 60 then 'CRITICAL' when p.days_overdue > 30 then 'HIGH' else 'MEDIUM' end, 'team', 'ACCOUNTS',
         'title', 'Overdue invoice', 'reference', p.invoice_number || ' · ' || p.customer_name, 'record_id', p.invoice_id, 'detected_at', p.due_date + 1,
         'explanation', format('Balance %s %s was due on %s (%s day(s) overdue).', (select currency_code from public.companies where id = v_company),
                               to_char(p.balance, 'FM999,999,999,990.00'), p.due_date, p.days_overdue),
         'action', 'Follow up with the customer and record the payment when received.', 'link', '/billing/invoices/' || p.invoice_id) a
       from private.invoice_position_as_of(v_company, v_as_of) p where p.balance > 0 and p.days_overdue > 0 order by p.days_overdue desc limit c_limit)
      union all
      (select jsonb_build_object('id', 'INVOICE_DUE_SOON:' || p.invoice_id, 'type', 'INVOICE_DUE_SOON', 'severity', 'LOW', 'team', 'ACCOUNTS',
         'title', 'Invoice due within 7 days', 'reference', p.invoice_number || ' · ' || p.customer_name, 'record_id', p.invoice_id, 'detected_at', v_as_of,
         'explanation', format('Balance %s due on %s.', to_char(p.balance, 'FM999,999,999,990.00'), p.due_date),
         'action', 'Send a payment reminder if needed.', 'link', '/billing/invoices/' || p.invoice_id)
       from private.invoice_position_as_of(v_company, v_as_of) p where p.balance > 0 and p.due_date between v_as_of and v_as_of + 7 order by p.due_date limit c_limit)
    ) x;
    v_alerts := v_alerts || v_part;
  else
    v_skipped := v_skipped || jsonb_build_array('Receivable alerts need billing_reports.read');
  end if;
  if private.has_permission(v_company, 'payments.read') then
    select coalesce(jsonb_agg(a), '[]'::jsonb) into v_part from (
      select jsonb_build_object('id', 'PAYMENT_UNALLOCATED:' || p.id, 'type', 'PAYMENT_UNALLOCATED', 'severity', 'MEDIUM', 'team', 'ACCOUNTS',
        'title', 'Receipt not fully allocated', 'reference', p.receipt_number || ' · ' || coalesce(c.legal_name, c.customer_name), 'record_id', p.id,
        'detected_at', p.receipt_date,
        'explanation', format('%s of %s is not allocated to any invoice.', to_char(x.unallocated, 'FM999,999,999,990.00'), to_char(p.amount_received, 'FM999,999,999,990.00')),
        'action', 'Allocate it to open invoices or confirm it is an advance.', 'link', '/billing/payments?receipt=' || p.id) a
      from public.customer_payments p join public.customers c on c.id = p.customer_id
      cross join lateral (select p.amount_received - private.payment_allocated(p.id) as unallocated) x
      where p.company_id = v_company and p.status = 'RECORDED' and x.unallocated > 0 order by p.receipt_date limit c_limit
    ) x;
    v_alerts := v_alerts || v_part;
  else
    v_skipped := v_skipped || jsonb_build_array('Receipt alerts need payments.read');
  end if;

  return jsonb_build_object(
    'as_of', v_as_of, 'today', v_today,
    'alerts', v_alerts,
    'limit_per_rule', c_limit,
    'skipped', v_skipped,
    'counts', coalesce((select jsonb_object_agg(s, n) from (select a ->> 'severity' s, count(*) n from jsonb_array_elements(v_alerts) a group by 1) x), '{}'::jsonb),
    'generated_at', now()
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Data quality and reconciliation (administrators; read-only; nothing is fixed)
-- -----------------------------------------------------------------------------
create or replace function public.analytics_data_quality()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('audit_logs.read');
  v_checks  jsonb := '[]'::jsonb;
  v_rows    jsonb;
begin
  -- helper pattern: each block sets v_rows (sample of offending records) and appends one check
  -- 1 Sales order lines without a valid product
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('reference', so.sales_order_number || ' line ' || l.line_no, 'record_id', so.id, 'link', '/sales/order-details?so=' || so.id,
      'detail', 'Product ' || l.sku_snapshot || ' is missing or archived') x
    from public.sales_order_lines l join public.sales_orders so on so.id = l.sales_order_id
    left join public.products p on p.id = l.product_id
    where so.company_id = v_company and so.order_status not in ('CANCELLED', 'FULFILLED') and (p.id is null or p.archived_at is not null)) y;
  v_checks := v_checks || jsonb_build_object('code', 'SO_LINE_PRODUCT', 'module', 'Sales', 'title', 'Open sales order lines without a valid product',
    'rule', 'Every open order line must reference an existing, non-archived product.', 'issues', jsonb_array_length(v_rows), 'samples', v_rows);

  -- 2 Dispatch records without their stock posting or source order line
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('reference', f.fulfilment_number || ' line ' || fl.line_no, 'record_id', f.id, 'link', '/sales/delivery?f=' || f.id,
      'detail', case when fl.issue_transaction_id is null then 'Dispatched quantity has no stock issue transaction'
                     else 'Stock issue does not match the dispatched product or quantity' end) x
    from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
    left join public.inventory_transactions t on t.id = fl.issue_transaction_id
    where f.company_id = v_company and fl.quantity_dispatched > 0
      and (fl.issue_transaction_id is null or t.product_id <> fl.product_id or t.quantity <> fl.quantity_dispatched or t.document_id <> f.sales_order_id)) y;
  v_checks := v_checks || jsonb_build_object('code', 'DISPATCH_POSTING', 'module', 'Dispatch', 'title', 'Dispatches that do not reconcile with their stock issue',
    'rule', 'Each dispatched line has one stock ISSUE for the same product, quantity and sales order.', 'issues', jsonb_array_length(v_rows), 'samples', v_rows);

  -- 3 Issued invoice product lines without a dispatch source
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('reference', i.invoice_number || ' line ' || il.line_no, 'record_id', i.id, 'link', '/billing/invoices/' || i.id,
      'detail', 'Product line has no dispatch line or sales order reference') x
    from public.sales_invoice_lines il join public.sales_invoices i on i.id = il.invoice_id
    where i.company_id = v_company and i.status = 'ISSUED' and il.line_type = 'PRODUCT'
      and (il.fulfilment_line_id is null or il.sales_order_line_id is null)) y;
  v_checks := v_checks || jsonb_build_object('code', 'INVOICE_LINE_SOURCE', 'module', 'Billing', 'title', 'Invoice lines missing their dispatch reference',
    'rule', 'Every product line of an issued invoice references the dispatch line and sales order line it bills.', 'issues', jsonb_array_length(v_rows), 'samples', v_rows);

  -- 4 Invoiced more than dispatched (net of returns received)
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('reference', f.fulfilment_number || ' line ' || fl.line_no, 'record_id', f.id, 'link', '/sales/delivery?f=' || f.id,
      'detail', format('Invoiced %s, dispatched %s, returned %s', trim_scale(q.invoiced), trim_scale(fl.quantity_dispatched), trim_scale(q.returned))) x
    from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
    cross join lateral (select private.dispatch_line_invoiced(fl.id) as invoiced,
      coalesce((select sum(rl.quantity_received) from public.customer_return_lines rl where rl.fulfilment_line_id = fl.id), 0) as returned) q
    where f.company_id = v_company and q.invoiced > fl.quantity_dispatched) y;
  v_checks := v_checks || jsonb_build_object('code', 'INVOICED_VS_DISPATCHED', 'module', 'Billing', 'title', 'Invoiced quantity above the dispatched quantity',
    'rule', 'Quantity on draft, pending and issued invoices never exceeds the dispatched quantity of a dispatch line.', 'issues', jsonb_array_length(v_rows), 'samples', v_rows);

  -- 5 Invoice totals vs stored lines
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('reference', coalesce(i.invoice_number, 'Draft'), 'record_id', i.id, 'link', '/billing/invoices/' || i.id,
      'detail', format('Header taxable %s / tax %s / total %s; lines %s / %s / %s', i.taxable_subtotal, i.cgst_total + i.sgst_total + i.igst_total, i.grand_total,
        s.taxable, s.tax, s.total + i.round_off)) x
    from public.sales_invoices i
    cross join lateral (select coalesce(sum(taxable_value), 0) taxable, coalesce(sum(cgst_amount + sgst_amount + igst_amount), 0) tax, coalesce(sum(line_total), 0) total
                        from public.sales_invoice_lines where invoice_id = i.id) s
    where i.company_id = v_company and i.status in ('ISSUED', 'CANCELLED')
      and (i.taxable_subtotal <> s.taxable or i.cgst_total + i.sgst_total + i.igst_total <> s.tax or i.grand_total <> s.total + i.round_off)) y;
  v_checks := v_checks || jsonb_build_object('code', 'INVOICE_TOTALS', 'module', 'Billing', 'title', 'Invoice totals that differ from their lines',
    'rule', 'Issued invoice taxable value, tax and grand total equal the sum of their lines (plus round-off).', 'issues', jsonb_array_length(v_rows), 'samples', v_rows);

  -- 6 Allocations above the receipt amount
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('reference', p.receipt_number, 'record_id', p.id, 'link', '/billing/payments?receipt=' || p.id,
      'detail', format('Allocated %s of a %s receipt', private.payment_allocated(p.id), p.amount_received)) x
    from public.customer_payments p where p.company_id = v_company and private.payment_allocated(p.id) > p.amount_received) y;
  v_checks := v_checks || jsonb_build_object('code', 'ALLOCATION_EXCEEDS_RECEIPT', 'module', 'Billing', 'title', 'Payment allocations exceeding the receipt',
    'rule', 'Active allocations of a receipt never exceed the amount received.', 'issues', jsonb_array_length(v_rows), 'samples', v_rows);

  -- 7 Receivable balance: invoice list vs as-of reconstruction, and over-allocation
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('reference', i.invoice_number, 'record_id', i.id, 'link', '/billing/invoices/' || i.id,
      'detail', format('Current balance %s, reconstructed %s, allocations %s vs invoice + debit notes %s', b.cur, coalesce(p.balance, 0), b.paid, b.billable)) x
    from public.sales_invoices i
    cross join lateral (select private.invoice_balance(i.id) cur, private.invoice_paid(i.id) paid,
      i.grand_total + coalesce((select sum(total_amount) from public.invoice_adjustment_notes n where n.original_invoice_id = i.id and n.note_type = 'DEBIT' and n.status = 'ISSUED'), 0) billable) b
    left join private.invoice_position_as_of(v_company, private.company_today(v_company)) p on p.invoice_id = i.id
    where i.company_id = v_company and i.status = 'ISSUED' and i.invoice_date <= private.company_today(v_company)
      and (b.cur <> coalesce(p.balance, 0) or b.paid > b.billable)) y;
  v_checks := v_checks || jsonb_build_object('code', 'RECEIVABLE_BALANCE', 'module', 'Billing', 'title', 'Receivable balances that do not reconcile',
    'rule', 'Invoice balance = total - credit notes + debit notes - allocations, both live and as reconstructed for today; allocations never exceed the invoice plus debit notes.',
    'issues', jsonb_array_length(v_rows), 'samples', v_rows);

  -- 8 Inventory balances vs the stock ledger
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('reference', p.sku || ' @ ' || l.location_code || coalesce(' / ' || bt.batch_number, ''), 'record_id', p.id,
      'link', '/inventory/stock/' || p.id, 'detail', format('Balance %s, ledger %s', trim_scale(coalesce(b.on_hand, 0)), trim_scale(coalesce(t.qty, 0)))) x
    from (select batch_id, location_id, product_id, sum(direction * quantity) qty from public.inventory_transactions where company_id = v_company group by 1, 2, 3) t
    full join (select * from public.inventory_balances where company_id = v_company) b on b.batch_id = t.batch_id and b.location_id = t.location_id
    join public.products p on p.id = coalesce(b.product_id, t.product_id)
    join public.inventory_locations l on l.id = coalesce(b.location_id, t.location_id)
    join public.inventory_batches bt on bt.id = coalesce(b.batch_id, t.batch_id)
    where coalesce(b.on_hand, 0) <> coalesce(t.qty, 0)
    limit 50) y;
  v_checks := v_checks || jsonb_build_object('code', 'STOCK_LEDGER', 'module', 'Inventory', 'title', 'Stock balances that differ from the ledger',
    'rule', 'On hand of every lot and location equals the sum of its posted ledger transactions.', 'issues', jsonb_array_length(v_rows), 'samples', v_rows);

  -- 9 Stock without verified source
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('reference', p.sku || ' @ ' || l.location_code, 'record_id', p.id, 'link', '/inventory/stock/' || p.id,
      'detail', format('%s %s with source UNKNOWN', trim_scale(b.on_hand), p.base_unit)) x
    from public.inventory_balances b join public.products p on p.id = b.product_id join public.inventory_locations l on l.id = b.location_id
    where b.company_id = v_company and b.source_type = 'UNKNOWN' and b.on_hand > 0 limit 50) y;
  v_checks := v_checks || jsonb_build_object('code', 'UNKNOWN_SOURCE', 'module', 'Inventory', 'title', 'Stock without in-house / outsourced attribution',
    'rule', 'Stock on hand has a verified source (IN_HOUSE or OUTSOURCED).', 'issues', jsonb_array_length(v_rows), 'samples', v_rows);

  -- 10 Duplicate business identifiers not protected by a unique constraint
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('reference', 'Barcode ' || barcode, 'record_id', null, 'link', '/products', 'detail', n || ' products share this barcode') x
    from (select barcode, count(*) n from public.products where company_id = v_company and barcode is not null and archived_at is null group by barcode having count(*) > 1) d
    union all
    select jsonb_build_object('reference', 'GSTIN ' || gstin, 'record_id', null, 'link', '/customers', 'detail', n || ' customers share this GSTIN')
    from (select gstin, count(*) n from public.customers where company_id = v_company and gstin is not null group by gstin having count(*) > 1) d
    union all
    select jsonb_build_object('reference', 'PO ' || customer_po_number, 'record_id', null, 'link', '/customer-pos/register',
      'detail', n || ' current purchase orders of the same customer use this number')
    from (select customer_key, customer_po_number, count(*) n from public.customer_purchase_orders
          where company_id = v_company and is_current and status <> 'CANCELLED' group by 1, 2 having count(*) > 1) d
    union all
    select jsonb_build_object('reference', 'Receipt reference ' || transaction_reference, 'record_id', null, 'link', '/billing/payments',
      'detail', n || ' recorded receipts of the same customer use this transaction reference')
    from (select customer_id, transaction_reference, count(*) n from public.customer_payments
          where company_id = v_company and status = 'RECORDED' and transaction_reference is not null group by 1, 2 having count(*) > 1) d) y;
  v_checks := v_checks || jsonb_build_object('code', 'DUPLICATE_IDENTIFIERS', 'module', 'Master data', 'title', 'Duplicate business identifiers',
    'rule', 'Barcodes, customer GSTINs, current customer PO numbers and receipt transaction references are not repeated.', 'issues', jsonb_array_length(v_rows), 'samples', v_rows);

  -- 11 Missing dates and broken relationships
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('reference', i.invoice_number, 'record_id', i.id, 'link', '/billing/invoices/' || i.id, 'detail', 'Issued invoice without a due date') x
    from public.sales_invoices i where i.company_id = v_company and i.status = 'ISSUED' and i.due_date is null
    union all
    select jsonb_build_object('reference', o.production_order_number, 'record_id', o.id, 'link', '/production/orders/' || o.id, 'detail', 'Completed order without a completion date')
    from public.production_orders o where o.company_id = v_company and o.status = 'COMPLETED' and o.actual_completion_date is null
    union all
    select jsonb_build_object('reference', f.fulfilment_number, 'record_id', f.id, 'link', '/sales/delivery?f=' || f.id, 'detail', 'Delivered consignment without a delivery date')
    from public.fulfilments f where f.company_id = v_company and f.fulfilment_status = 'DELIVERED' and f.delivered_at is null
    union all
    select jsonb_build_object('reference', so.sales_order_number, 'record_id', so.id, 'link', '/sales/order-details?so=' || so.id, 'detail', 'Order linked to a purchase order that no longer exists')
    from public.sales_orders so where so.company_id = v_company and so.customer_purchase_order_id is not null
      and not exists (select 1 from public.customer_purchase_orders po where po.id = so.customer_purchase_order_id)) y;
  v_checks := v_checks || jsonb_build_object('code', 'MISSING_DATES', 'module', 'All modules', 'title', 'Missing dates or broken relationships',
    'rule', 'Issued invoices have due dates, completed and delivered records have their completion dates, and links point to existing records.',
    'issues', jsonb_array_length(v_rows), 'samples', v_rows);

  return jsonb_build_object(
    'checks', (select jsonb_agg(c || jsonb_build_object('samples', coalesce((select jsonb_agg(s) from (select s from jsonb_array_elements(c -> 'samples') s limit 10) z), '[]'::jsonb)))
               from jsonb_array_elements(v_checks) c),
    'issues', (select coalesce(sum((c ->> 'issues')::int), 0) from jsonb_array_elements(v_checks) c),
    'note', 'Checks are read-only. Nothing is corrected or deleted from here; open the linked record and use its normal correction workflow.',
    'generated_at', now());
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
revoke all on function private.analytics_check_period(date, date) from public, anon, authenticated;
revoke all on function private.analytics_na(text) from public, anon, authenticated;
revoke all on function private.analytics_open_demand(uuid) from public, anon, authenticated;
revoke all on function private.analytics_eligible(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.analytics_sales_kpis(uuid, date, date, uuid, uuid) from public, anon, authenticated;
revoke all on function private.analytics_billing_kpis(uuid, date, date, date, uuid) from public, anon, authenticated;
revoke all on function private.analytics_inventory_kpis(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.analytics_valuation(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.analytics_production_kpis(uuid, date, date, uuid, date, boolean) from public, anon, authenticated;

revoke all on function public.analytics_context() from public, anon;
revoke all on function public.analytics_executive(date, date, date, uuid, uuid) from public, anon;
revoke all on function public.analytics_sales(date, date, uuid, uuid, uuid, uuid, text, text) from public, anon;
revoke all on function public.analytics_inventory(date, date, uuid, uuid, text, text) from public, anon;
revoke all on function public.analytics_production(date, date, uuid, uuid, text, uuid) from public, anon;
revoke all on function public.analytics_fulfilment(date, date, text, uuid) from public, anon;
revoke all on function public.analytics_shortages(text, uuid, uuid, boolean, integer, integer) from public, anon;
revoke all on function public.analytics_finance(date, date, date, uuid) from public, anon;
revoke all on function public.analytics_alerts(date) from public, anon;
revoke all on function public.analytics_data_quality() from public, anon;
grant execute on function public.analytics_context(), public.analytics_executive(date, date, date, uuid, uuid),
  public.analytics_sales(date, date, uuid, uuid, uuid, uuid, text, text), public.analytics_inventory(date, date, uuid, uuid, text, text),
  public.analytics_production(date, date, uuid, uuid, text, uuid), public.analytics_fulfilment(date, date, text, uuid),
  public.analytics_shortages(text, uuid, uuid, boolean, integer, integer), public.analytics_finance(date, date, date, uuid),
  public.analytics_alerts(date), public.analytics_data_quality() to authenticated;
