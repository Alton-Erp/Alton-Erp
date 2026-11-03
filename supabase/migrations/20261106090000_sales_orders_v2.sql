-- =============================================================================
-- ALTON ERP V2 — Stage 5: sales orders with automatic reservations
--
-- Built on the Phase 7 sales tables (sales_orders, sales_order_lines,
-- fulfilments, fulfilment_lines, sales_order_events), the Phase 4 reservation
-- ledger (stock_reservations) and the Stage 4 production flow. No new tables.
--
--   pricing          per-line discount and GST, freight / other charges and
--                    order totals (additive columns)
--   reservations     finished goods first (reference SALES_ORDER_LINE), then the
--                    BOM materials for the quantity still to be produced
--                    (reference SALES_ORDER_MATERIAL). Only available stock is
--                    reserved; reserved stock is never reserved again (every
--                    reservation goes through the locked balance row).
--                    Recalculating tops reservations up or releases the excess.
--   production       "Create production order" makes a Stage 4 production order
--                    for the quantity not yet covered (linked to the order line);
--                    the line's material reservations are handed to it.
--   purchasing       shortages with preferred supplier and recommended quantity,
--                    used to prefill a purchase order (never created automatically)
--   dispatch         one-step partial / full dispatch through the existing
--                    pick -> pack -> dispatch postings; a dispatch can be reversed
--                    (stock back, order quantities back, history kept) unless it
--                    was invoiced or delivered
--   statuses         derived from the records: Draft, Open, Partially Reserved,
--                    Stock Shortage, Production Pending, Ready for Dispatch,
--                    Partially Dispatched, Fully Dispatched, Cancelled
--   dashboard, Excel import (recorded in Bulk Operations)
--
-- A sales order never moves physical stock; only dispatch does.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Columns (additive)
-- -----------------------------------------------------------------------------
alter table public.sales_orders add column if not exists customer_gstin_snapshot text;
alter table public.sales_orders add column if not exists payment_terms text;
alter table public.sales_orders add column if not exists delivery_instructions text;
alter table public.sales_orders add column if not exists freight_amount numeric(14,2) not null default 0;
alter table public.sales_orders add column if not exists other_charges_amount numeric(14,2) not null default 0;
alter table public.sales_orders add column if not exists charges_gst_rate numeric(5,2) not null default 18;
alter table public.sales_orders add column if not exists tax_treatment text;
alter table public.sales_orders add column if not exists gross_total numeric(14,2) not null default 0;
alter table public.sales_orders add column if not exists discount_total numeric(14,2) not null default 0;
alter table public.sales_orders add column if not exists taxable_total numeric(14,2) not null default 0;
alter table public.sales_orders add column if not exists cgst_total numeric(14,2) not null default 0;
alter table public.sales_orders add column if not exists sgst_total numeric(14,2) not null default 0;
alter table public.sales_orders add column if not exists igst_total numeric(14,2) not null default 0;
alter table public.sales_orders add column if not exists grand_total numeric(14,2) not null default 0;

alter table public.sales_order_lines add column if not exists description text;
alter table public.sales_order_lines add column if not exists discount_percent numeric(5,2);
alter table public.sales_order_lines add column if not exists discount_amount numeric(14,2) not null default 0;
alter table public.sales_order_lines add column if not exists gst_rate numeric(5,2);
alter table public.sales_order_lines add column if not exists taxable_value numeric(14,2) not null default 0;
alter table public.sales_order_lines add column if not exists gst_amount numeric(14,2) not null default 0;
alter table public.sales_order_lines add column if not exists line_total numeric(14,2) not null default 0;

-- Link from a production order to the sales order line it was made for.
alter table public.production_orders add column if not exists sales_order_id uuid;
alter table public.production_orders add column if not exists sales_order_line_id uuid;
create index if not exists production_orders_so_line_idx on public.production_orders (sales_order_line_id) where sales_order_line_id is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_orders_v2_amounts_check') then
    alter table public.sales_orders add constraint sales_orders_v2_amounts_check check (
      freight_amount >= 0 and other_charges_amount >= 0 and charges_gst_rate between 0 and 100
      and (payment_terms is null or length(payment_terms) <= 200) and (delivery_instructions is null or length(delivery_instructions) <= 1000)
      and (customer_gstin_snapshot is null or length(customer_gstin_snapshot) <= 15)
      and (tax_treatment is null or tax_treatment in ('INTRA_STATE', 'INTER_STATE')));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sales_order_lines_v2_amounts_check') then
    alter table public.sales_order_lines add constraint sales_order_lines_v2_amounts_check check (
      (discount_percent is null or discount_percent between 0 and 100) and discount_amount >= 0
      and (gst_rate is null or gst_rate between 0 and 100) and (description is null or length(description) <= 500));
  end if;
end;
$$;

-- The three views list t.* and are rebuilt so they show the new columns. Their
-- definitions are unchanged (same text as Phases 5 and 7), so re-applying those
-- migrations keeps producing the same column list.
drop view if exists public.sales_order_list;
create view public.sales_order_list
with (security_invoker = true) as
select so.*,
  c.customer_code,
  w.warehouse_code,
  (select count(*) from public.sales_order_lines l where l.sales_order_id = so.id)::int as line_count,
  (select jsonb_agg(u order by u ->> 'unit') from (
     select jsonb_build_object('unit', l.unit, 'ordered', sum(l.quantity_ordered), 'cancelled', sum(l.quantity_cancelled),
       'dispatched', sum(l.quantity_dispatched), 'delivered', sum(l.quantity_delivered), 'returned', sum(l.quantity_returned),
       'remaining', sum(l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched),
       'reserved', sum(private.so_line_open_reserved(l.id))) as u
     from public.sales_order_lines l where l.sales_order_id = so.id group by l.unit) x) as unit_totals,
  (select count(*) from public.fulfilments f where f.sales_order_id = so.id and f.fulfilment_status <> 'CANCELLED')::int as fulfilment_count,
  (select max(f.actual_dispatch_at) from public.fulfilments f where f.sales_order_id = so.id) as last_dispatch_at,
  exists (select 1 from public.fulfilments f where f.sales_order_id = so.id and (f.fulfilment_status = 'DELIVERY_EXCEPTION'
    or exists (select 1 from public.fulfilment_lines fl where fl.fulfilment_id = f.id and (fl.pick_exception is not null or fl.quantity_damaged > 0))
    or (f.fulfilment_status in ('DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED') and f.expected_delivery_date < private.so_today()))) as has_exception
from public.sales_orders so
left join public.customers c on c.id = so.customer_id
left join public.warehouses w on w.id = so.warehouse_id;

drop view if exists public.sales_order_line_list;
create view public.sales_order_line_list
with (security_invoker = true) as
select l.*,
  so.sales_order_number, so.order_status, so.customer_name_snapshot, so.customer_id, so.customer_po_number, so.order_date,
  so.requested_delivery_date as order_requested_date, so.priority, so.warehouse_id as order_warehouse_id,
  p.barcode, p.base_unit, p.status as product_status, p.default_source_type,
  pol.line_no as po_line_no,
  l.quantity_ordered - l.quantity_cancelled as quantity_effective,
  l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched as quantity_remaining,
  private.so_line_open_reserved(l.id) as quantity_reserved,
  private.so_line_planned(l.id) as quantity_planned,
  (select coalesce(sum(fl.quantity_picked), 0) from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
    where fl.sales_order_line_id = l.id and f.fulfilment_status in ('PENDING', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'READY_FOR_DISPATCH')) as quantity_picked,
  (select coalesce(sum(fl.quantity_packed), 0) from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
    where fl.sales_order_line_id = l.id and f.fulfilment_status in ('PENDING', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'READY_FOR_DISPATCH')) as quantity_packed,
  greatest(l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched - private.so_line_open_reserved(l.id), 0) as quantity_unreserved,
  private.so_line_available_now(l.id) as available_now
from public.sales_order_lines l
join public.sales_orders so on so.id = l.sales_order_id
join public.products p on p.id = l.product_id
left join public.customer_purchase_order_lines pol on pol.id = l.customer_purchase_order_line_id;

drop view if exists public.production_order_list;
create view public.production_order_list
with (security_invoker = true) as
select
  o.*, p.sku, p.product_name,
  sw.warehouse_code as source_warehouse_code, dw.warehouse_code as destination_warehouse_code,
  coalesce(m.lines, 0) as material_lines,
  coalesce(m.lines_issued, 0) as material_lines_issued,
  case when coalesce(m.issued_any, false) = false then 'NOT_ISSUED'
       when m.lines_issued = m.lines then 'FULLY_ISSUED' else 'PARTIALLY_ISSUED' end as material_status,
  (o.status not in ('COMPLETED', 'CANCELLED') and o.target_completion_date < (now() at time zone coalesce(c.timezone, 'UTC'))::date) as is_overdue
from public.production_orders o
join public.products p on p.id = o.finished_product_id
join public.companies c on c.id = o.company_id
left join public.warehouses sw on sw.id = o.source_warehouse_id
left join public.warehouses dw on dw.id = o.destination_warehouse_id
left join (
  select production_order_id, count(*) as lines,
    count(*) filter (where issued_quantity >= planned_quantity) as lines_issued,
    bool_or(issued_quantity > 0) as issued_any
  from public.production_order_materials group by production_order_id
) m on m.production_order_id = o.id;

revoke all on public.sales_order_list, public.sales_order_line_list, public.production_order_list from anon, authenticated;
grant select on public.sales_order_list, public.sales_order_line_list, public.production_order_list to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Ownership of material reservations, Bulk Operations type
-- -----------------------------------------------------------------------------
create or replace function private.reservation_owned_by_module(p_reference_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case upper(btrim(coalesce(p_reference_type, '')))
    when 'PRODUCTION_ORDER' then 'production order'
    when 'CUSTOMER_PO' then 'customer purchase order'
    when 'SALES_ORDER_LINE' then 'sales order'
    when 'SALES_ORDER_MATERIAL' then 'sales order'
  end;
$$;

revoke all on function private.reservation_owned_by_module(text) from public, anon, authenticated;

alter table public.import_jobs drop constraint if exists import_jobs_import_type_check;
alter table public.import_jobs add constraint import_jobs_import_type_check
  check (import_type in ('PRODUCTS', 'OPENING_STOCK', 'CUSTOMER_PO', 'SUPPLIER_PO', 'BOMS', 'PRODUCTION', 'SALES_ORDER'));

create or replace function private.import_permission(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type when 'PRODUCTS' then 'products.import' when 'OPENING_STOCK' then 'inventory_opening.create'
    when 'CUSTOMER_PO' then 'customer_po.import' when 'SUPPLIER_PO' then 'purchase_order.create'
    when 'BOMS' then 'production_bom.create' when 'PRODUCTION' then 'production_order.create'
    when 'SALES_ORDER' then 'sales_orders.create' end;
$$;

revoke all on function private.import_permission(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Pricing
-- -----------------------------------------------------------------------------
create or replace function private.so_v2_tax_treatment(p_company uuid, p_customer uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when left(co.gstin, 2) is not null and coalesce(c.billing_state_code, left(c.gstin, 2)) is not null
              and left(co.gstin, 2) <> coalesce(c.billing_state_code, left(c.gstin, 2)) then 'INTER_STATE' else 'INTRA_STATE' end
  from public.companies co left join public.customers c on c.id = p_customer
  where co.id = p_company;
$$;

revoke all on function private.so_v2_tax_treatment(uuid, uuid) from public, anon, authenticated;

-- Line amounts and order totals from the effective quantity (ordered - cancelled).
--   gross = qty x price; discount = gross x % (or the amount); taxable = gross - discount
--   GST = taxable x rate; charges (freight + other) are taxed at charges_gst_rate
--   intra-state: CGST = SGST = GST / 2; inter-state: IGST
create or replace function private.so_v2_price(p_so uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_so    public.sales_orders;
  v_lines record;
  v_chg   numeric;
  v_cgst  numeric;
  v_gst   numeric;
begin
  select * into v_so from public.sales_orders where id = p_so for update;
  update public.sales_order_lines l set
    discount_amount = x.disc, taxable_value = x.gross - x.disc, gst_amount = round((x.gross - x.disc) * coalesce(l.gst_rate, 0) / 100, 2),
    line_total = x.gross - x.disc + round((x.gross - x.disc) * coalesce(l.gst_rate, 0) / 100, 2)
  from (
    select id, g.gross,
      case when discount_percent is not null then round(g.gross * discount_percent / 100, 2) else least(discount_amount, g.gross) end as disc
    from public.sales_order_lines
    cross join lateral (select round((quantity_ordered - quantity_cancelled) * coalesce(unit_price_snapshot, 0), 2) as gross) g
    where sales_order_id = p_so
  ) x
  where l.id = x.id;

  select coalesce(sum(round((quantity_ordered - quantity_cancelled) * coalesce(unit_price_snapshot, 0), 2)), 0) as gross,
    coalesce(sum(discount_amount), 0) as disc, coalesce(sum(taxable_value), 0) as taxable, coalesce(sum(gst_amount), 0) as gst
  into v_lines from public.sales_order_lines where sales_order_id = p_so;
  v_chg := v_so.freight_amount + v_so.other_charges_amount;
  v_gst := v_lines.gst + round(v_chg * v_so.charges_gst_rate / 100, 2);
  v_cgst := round(v_gst / 2, 2);
  update public.sales_orders set
    tax_treatment = private.so_v2_tax_treatment(company_id, customer_id),
    gross_total = v_lines.gross, discount_total = v_lines.disc, taxable_total = v_lines.taxable + v_chg,
    cgst_total = case when private.so_v2_tax_treatment(company_id, customer_id) = 'INTRA_STATE' then v_cgst else 0 end,
    sgst_total = case when private.so_v2_tax_treatment(company_id, customer_id) = 'INTRA_STATE' then v_gst - v_cgst else 0 end,
    igst_total = case when private.so_v2_tax_treatment(company_id, customer_id) = 'INTER_STATE' then v_gst else 0 end,
    grand_total = v_lines.taxable + v_chg + v_gst
  where id = p_so;
end;
$$;

revoke all on function private.so_v2_price(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Requirement helpers
-- -----------------------------------------------------------------------------
-- Planned quantity of open production orders made for a line (not completed / cancelled).
create or replace function private.so_v2_line_production_open(p_line uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(planned_quantity), 0) from public.production_orders
  where sales_order_line_id = p_line and status not in ('COMPLETED', 'CANCELLED');
$$;

-- Material reserved for a line (all components or one).
create or replace function private.so_v2_material_reserved(p_line uuid, p_product uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(quantity - fulfilled_quantity - released_quantity), 0) from public.stock_reservations
  where reference_type = 'SALES_ORDER_MATERIAL' and reference_id = p_line and (p_product is null or product_id = p_product)
    and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED');
$$;

-- Warehouse used for production materials of an order.
create or replace function private.so_v2_material_warehouse(p_so public.sales_orders)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_so.warehouse_id, (select id from public.warehouses where company_id = p_so.company_id and is_default and status = 'ACTIVE' limit 1));
$$;

-- Quantity of a line still to be produced: not dispatched, not reserved as
-- finished goods and not covered by an open production order.
create or replace function private.so_v2_to_produce(p_line public.sales_order_lines)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(p_line.quantity_ordered - p_line.quantity_cancelled - p_line.quantity_dispatched
    - private.so_line_open_reserved(p_line.id) - private.so_v2_line_production_open(p_line.id), 0);
$$;

revoke all on function private.so_v2_line_production_open(uuid) from public, anon, authenticated;
revoke all on function private.so_v2_material_reserved(uuid, uuid) from public, anon, authenticated;
revoke all on function private.so_v2_material_warehouse(public.sales_orders) from public, anon, authenticated;
revoke all on function private.so_v2_to_produce(public.sales_order_lines) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Reservation engine (finished goods, then materials). Every reservation goes
-- through private.reserve_balance, which locks the balance row and refuses more
-- than on hand minus reserved, so the same stock is never reserved twice.
-- -----------------------------------------------------------------------------
create or replace function private.so_v2_reserve_line(p_company uuid, p_so public.sales_orders, p_line_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line    public.sales_order_lines;
  v_product public.products;
  v_need    numeric;
  v_take    numeric;
  v_lot     record;
  v_res     public.stock_reservations;
  v_free    numeric;
  v_fg      numeric := 0;
  v_rel     numeric := 0;
  v_bom     public.boms;
  v_make    numeric;
  v_req     record;
  v_have    numeric;
  v_mwh     uuid := private.so_v2_material_warehouse(p_so);
  v_mat     numeric := 0;
  v_short   jsonb := '[]'::jsonb;
begin
  select * into v_line from public.sales_order_lines where id = p_line_id for update;
  select * into v_product from public.products where id = v_line.product_id;

  -- Finished goods: top up to the quantity still to dispatch, or release the excess (free portions only).
  v_need := v_line.quantity_ordered - v_line.quantity_cancelled - v_line.quantity_dispatched - private.so_line_open_reserved(v_line.id);
  if v_need < 0 then
    for v_res in
      select * from public.stock_reservations where reference_type = 'SALES_ORDER_LINE' and reference_id = v_line.id
        and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') order by reserved_at desc, id desc for update
    loop
      exit when v_need >= 0;
      v_free := least(-v_need, v_res.quantity - v_res.fulfilled_quantity - v_res.released_quantity - private.reservation_planned(v_res.id));
      continue when v_free <= 0;
      v_rel := v_rel + private.release_reservation_qty(v_res, v_free, 'RELEASED');
      v_need := v_need + v_free;
    end loop;
  elsif v_need > 0 and v_product.status = 'ACTIVE' and v_product.archived_at is null and v_line.unit = v_product.base_unit then
    perform 1 from public.inventory_balances where company_id = p_company and product_id = v_line.product_id order by id for update;
    for v_lot in
      select * from private.po_eligible_stock(p_company, v_line.product_id, p_so.warehouse_id) s
      where s.eligible and s.available > 0
      order by case when s.source_type = 'IN_HOUSE' then 0 else 1 end, s.expiry_date nulls last, s.lot_created_at, s.warehouse_code, s.location_code
    loop
      exit when v_need <= 0;
      v_take := least(v_need, v_lot.available);
      if private.is_whole_unit(v_line.unit) then v_take := trunc(v_take); end if;
      continue when v_take <= 0;
      perform private.reserve_balance(p_company, v_lot.balance_id, v_take, 'SALES_ORDER_LINE', p_so.sales_order_number, v_line.id,
        'Reserved for ' || p_so.sales_order_number || ' (' || p_so.customer_name_snapshot || ')');
      v_fg := v_fg + v_take;
      v_need := v_need - v_take;
    end loop;
  end if;

  -- Materials for the quantity still to be produced (active BOM); excess released.
  v_make := private.so_v2_to_produce(v_line);
  v_bom := private.production_v2_active_bom(p_company, v_line.product_id);
  for v_res in
    select r.* from public.stock_reservations r
    where r.reference_type = 'SALES_ORDER_MATERIAL' and r.reference_id = v_line.id and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
      and (v_make = 0 or v_bom.id is null
           or r.product_id not in (select q.component_product_id from private.bom_requirement_lines(v_bom.id, v_make) q))
    for update
  loop
    v_rel := v_rel + private.release_reservation_remaining(v_res, 'RELEASED');
  end loop;
  if v_make > 0 and v_bom.id is not null then
    for v_req in select * from private.bom_requirement_lines(v_bom.id, v_make) q where q.unit_matches order by q.line_no loop
      v_have := private.so_v2_material_reserved(v_line.id, v_req.component_product_id);
      if v_have > v_req.total_requirement then
        for v_res in
          select * from public.stock_reservations where reference_type = 'SALES_ORDER_MATERIAL' and reference_id = v_line.id
            and product_id = v_req.component_product_id and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') order by reserved_at desc, id desc for update
        loop
          exit when v_have <= v_req.total_requirement;
          v_free := least(v_have - v_req.total_requirement, v_res.quantity - v_res.fulfilled_quantity - v_res.released_quantity);
          v_rel := v_rel + private.release_reservation_qty(v_res, v_free, 'RELEASED');
          v_have := v_have - v_free;
        end loop;
        continue;
      end if;
      v_need := v_req.total_requirement - v_have;
      continue when v_need <= 0;
      perform 1 from public.inventory_balances where company_id = p_company and product_id = v_req.component_product_id order by id for update;
      for v_lot in
        select b.id as balance_id, b.on_hand - b.reserved as free
        from public.inventory_balances b
        join public.inventory_locations l on l.id = b.location_id and l.stock_usage = 'STORAGE' and l.status = 'ACTIVE'
        join public.inventory_batches bt on bt.id = b.batch_id
        where b.company_id = p_company and b.product_id = v_req.component_product_id and b.warehouse_id = v_mwh and b.on_hand - b.reserved > 0
          and (bt.expiry_date is null or bt.expiry_date >= private.company_today(p_company))
        order by bt.expiry_date nulls last, bt.created_at, b.location_id
      loop
        exit when v_need <= 0;
        v_take := least(v_need, v_lot.free);
        if private.is_whole_unit(v_req.unit) then v_take := trunc(v_take); end if;
        continue when v_take <= 0;
        perform private.reserve_balance(p_company, v_lot.balance_id, v_take, 'SALES_ORDER_MATERIAL', p_so.sales_order_number, v_line.id,
          'Material for ' || p_so.sales_order_number || ' line ' || v_line.line_no || ' (' || v_line.sku_snapshot || ')');
        v_mat := v_mat + v_take;
        v_need := v_need - v_take;
      end loop;
      if v_need > 0 then
        v_short := v_short || jsonb_build_object('sku', v_req.sku, 'short', v_need, 'unit', v_req.unit);
      end if;
    end loop;
  end if;
  return jsonb_build_object('line_id', v_line.id, 'finished_goods_reserved', v_fg, 'materials_reserved', v_mat, 'released', v_rel,
    'to_produce', v_make, 'has_bom', v_bom.id is not null, 'shortages', v_short);
end;
$$;

revoke all on function private.so_v2_reserve_line(uuid, public.sales_orders, uuid) from public, anon, authenticated;

create or replace function private.so_v2_reserve(p_company uuid, p_so uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_so   public.sales_orders;
  v_line record;
  v_out  jsonb := '[]'::jsonb;
begin
  select * into v_so from public.sales_orders where id = p_so for update;
  if v_so.order_status in ('DRAFT', 'PENDING_CONFIRMATION', 'CANCELLED', 'ON_HOLD') then
    return v_out;
  end if;
  for v_line in select id from public.sales_order_lines where sales_order_id = p_so order by line_no loop
    v_out := v_out || private.so_v2_reserve_line(p_company, v_so, v_line.id);
  end loop;
  perform private.so_recompute(p_so);
  return v_out;
end;
$$;

revoke all on function private.so_v2_reserve(uuid, uuid) from public, anon, authenticated;

-- Releases every material reservation of an order (or one line).
create or replace function private.so_v2_release_materials(p_so uuid, p_line uuid default null)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res   public.stock_reservations;
  v_total numeric := 0;
begin
  for v_res in
    select r.* from public.stock_reservations r join public.sales_order_lines l on l.id = r.reference_id and l.sales_order_id = p_so
    where r.reference_type = 'SALES_ORDER_MATERIAL' and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') and (p_line is null or l.id = p_line)
    order by r.location_id, r.batch_id
    for update of r
  loop
    v_total := v_total + private.release_reservation_remaining(v_res, 'RELEASED');
  end loop;
  return v_total;
end;
$$;

revoke all on function private.so_v2_release_materials(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. Line figures, shortages and the derived status
-- -----------------------------------------------------------------------------
create or replace function private.so_v2_lines(p_so uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'line_id', l.id, 'line_no', l.line_no, 'product_id', l.product_id, 'sku', l.sku_snapshot, 'product_name', l.product_name_snapshot,
    'description', l.description, 'unit', l.unit, 'product_type', p.product_type,
    'ordered', l.quantity_ordered - l.quantity_cancelled, 'cancelled', l.quantity_cancelled, 'dispatched', l.quantity_dispatched,
    'pending', l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched,
    'reserved', f.reserved, 'on_pick_list', private.so_line_planned(l.id), 'available_for_dispatch', f.reserved,
    'production_open', f.prod_open, 'produced', f.produced, 'to_produce', f.to_produce,
    'production_orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'production_order_number', o.production_order_number, 'status', o.status,
        'planned_quantity', o.planned_quantity, 'completed_quantity', o.completed_quantity) order by o.created_at)
      from public.production_orders o where o.sales_order_line_id = l.id), '[]'::jsonb),
    'unit_price', l.unit_price_snapshot, 'discount_percent', l.discount_percent, 'discount_amount', l.discount_amount, 'gst_rate', l.gst_rate,
    'taxable_value', l.taxable_value, 'gst_amount', l.gst_amount, 'line_total', l.line_total,
    'bom', case when b.id is null then null else jsonb_build_object('id', b.id, 'bom_code', b.bom_code, 'version', b.version) end,
    'materials', case when f.to_produce = 0 or b.id is null then '[]'::jsonb else (
      select coalesce(jsonb_agg(jsonb_build_object('component_product_id', q.component_product_id, 'sku', q.sku, 'product_name', q.product_name,
        'unit', q.unit, 'required', q.total_requirement, 'reserved', private.so_v2_material_reserved(l.id, q.component_product_id)) order by q.line_no), '[]'::jsonb)
      from private.bom_requirement_lines(b.id, f.to_produce) q) end,
    'material_short', f.to_produce > 0 and (b.id is null or exists (
      select 1 from private.bom_requirement_lines(b.id, f.to_produce) q where private.so_v2_material_reserved(l.id, q.component_product_id) < q.total_requirement))
  ) order by l.line_no), '[]'::jsonb)
  from public.sales_order_lines l
  join public.products p on p.id = l.product_id
  cross join lateral (select private.so_line_open_reserved(l.id) as reserved, private.so_v2_line_production_open(l.id) as prod_open,
    (select coalesce(sum(completed_quantity), 0) from public.production_orders o where o.sales_order_line_id = l.id and o.status <> 'CANCELLED') as produced,
    private.so_v2_to_produce(l) as to_produce) f
  left join lateral (select * from private.production_v2_active_bom(l.company_id, l.product_id)) b on true
  where l.sales_order_id = p_so;
$$;

revoke all on function private.so_v2_lines(uuid) from public, anon, authenticated;

-- Material shortages of an order per component: required for everything still to
-- be produced, reserved for it, free stock, shortage, preferred supplier.
create or replace function private.so_v2_shortages(p_so uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with so as (select * from public.sales_orders where id = p_so),
  req as (
    select q.component_product_id, q.unit, sum(q.total_requirement) as required,
      sum(private.so_v2_material_reserved(l.id, q.component_product_id)) as reserved,
      (array_agg(bi.preferred_supplier_id) filter (where bi.preferred_supplier_id is not null))[1] as bom_supplier
    from public.sales_order_lines l
    cross join lateral (select private.so_v2_to_produce(l) as make) m
    cross join lateral (select * from private.production_v2_active_bom(l.company_id, l.product_id)) b
    cross join lateral private.bom_requirement_lines(b.id, m.make) q
    left join public.bom_items bi on bi.bom_id = b.id and bi.component_product_id = q.component_product_id
    where l.sales_order_id = p_so and m.make > 0 and b.id is not null
    group by q.component_product_id, q.unit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id', p.id, 'sku', p.sku, 'product_name', p.product_name, 'product_type', p.product_type, 'unit', r.unit,
    'required', r.required, 'reserved', r.reserved, 'available', s.available,
    'shortage', greatest(r.required - r.reserved - s.available, 0),
    'recommended_purchase', case when private.is_whole_unit(r.unit) then ceil(greatest(r.required - r.reserved - s.available, 0))
                                 else greatest(r.required - r.reserved - s.available, 0) end,
    'preferred_supplier_id', coalesce(r.bom_supplier, p.preferred_supplier_id),
    'preferred_supplier_name', (select coalesce(sp.display_name, sp.legal_name) from public.suppliers sp where sp.id = coalesce(r.bom_supplier, p.preferred_supplier_id)),
    'hsn_code', p.hsn_code, 'gst_rate', p.gst_rate, 'standard_cost', p.standard_cost
  ) order by p.sku), '[]'::jsonb)
  from req r
  join public.products p on p.id = r.component_product_id
  cross join so
  cross join lateral private.storage_stock(so.company_id, r.component_product_id, private.so_v2_material_warehouse(so)) s
  where r.required - r.reserved > 0;
$$;

revoke all on function private.so_v2_shortages(uuid) from public, anon, authenticated;

-- Derived Stage 5 status from the order's records.
create or replace function private.so_v2_status(p_so uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_so    public.sales_orders;
  v       record;
  v_short boolean;
begin
  select * into v_so from public.sales_orders where id = p_so;
  if v_so.order_status = 'CANCELLED' then return 'CANCELLED'; end if;
  if v_so.order_status in ('DRAFT', 'PENDING_CONFIRMATION') then return 'DRAFT'; end if;
  select coalesce(sum(eff), 0) as eff, coalesce(sum(disp), 0) as disp, count(*) filter (where eff > 0 and disp < eff) as not_disp,
    count(*) filter (where pending > reserved) as uncovered, coalesce(sum(reserved), 0) as reserved,
    coalesce(sum(make), 0) as make, coalesce(sum(prod), 0) as prod
  into v
  from (select l.quantity_ordered - l.quantity_cancelled as eff, l.quantity_dispatched as disp,
          l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched as pending, private.so_line_open_reserved(l.id) as reserved,
          private.so_v2_to_produce(l) as make, private.so_v2_line_production_open(l.id) as prod
        from public.sales_order_lines l where l.sales_order_id = p_so) x;
  if v.eff = 0 then return 'CANCELLED'; end if;
  if v.not_disp = 0 then return 'FULLY_DISPATCHED'; end if;
  if v.disp > 0 then return 'PARTIALLY_DISPATCHED'; end if;
  if v.uncovered = 0 then return 'READY_FOR_DISPATCH'; end if;
  v_short := exists (
    select 1 from public.sales_order_lines l
    cross join lateral (select private.so_v2_to_produce(l) as make) m
    left join lateral (select * from private.production_v2_active_bom(l.company_id, l.product_id)) b on true
    where l.sales_order_id = p_so and m.make > 0
      and (b.id is null or exists (select 1 from private.bom_requirement_lines(b.id, m.make) q
                                   where private.so_v2_material_reserved(l.id, q.component_product_id) < q.total_requirement)));
  if v_short then return 'STOCK_SHORTAGE'; end if;
  if v.prod > 0 then return 'PRODUCTION_PENDING'; end if;
  if v.reserved > 0 then return 'PARTIALLY_RESERVED'; end if;
  return 'OPEN';
end;
$$;

revoke all on function private.so_v2_status(uuid) from public, anon, authenticated;

-- True when a (not cancelled / discarded) invoice covers part of a consignment.
create or replace function private.so_v2_fulfilment_invoiced(p_fulfilment uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.sales_invoice_lines il join public.sales_invoices si on si.id = il.invoice_id
                 join public.fulfilment_lines fl on fl.id = il.fulfilment_line_id
                 where fl.fulfilment_id = p_fulfilment and si.status not in ('CANCELLED', 'DISCARDED'))
      or exists (select 1 from public.sales_invoice_dispatch_allocations a join public.sales_invoices si on si.id = a.invoice_id
                 join public.fulfilment_lines fl on fl.id = a.fulfilment_line_id
                 where fl.fulfilment_id = p_fulfilment and si.status not in ('CANCELLED', 'DISCARDED'));
$$;

revoke all on function private.so_v2_fulfilment_invoiced(uuid) from public, anon, authenticated;

create or replace function private.so_v2_summary(p_so uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'sales_order_id', so.id, 'sales_order_number', so.sales_order_number, 'status', private.so_v2_status(so.id), 'order_status', so.order_status,
    'customer_id', so.customer_id, 'customer_name', so.customer_name_snapshot, 'customer_gstin', so.customer_gstin_snapshot,
    'grand_total', so.grand_total, 'lines', private.so_v2_lines(so.id), 'shortages', private.so_v2_shortages(so.id))
  from public.sales_orders so where so.id = p_so;
$$;

revoke all on function private.so_v2_summary(uuid) from public, anon, authenticated;

create or replace function private.so_v2_warnings(p_summary jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce((select jsonb_agg(w) from (
    select to_jsonb(format('%s: %s %s to produce%s.', l ->> 'sku', trim_scale((l ->> 'to_produce')::numeric), l ->> 'unit',
      case when l -> 'bom' = 'null'::jsonb then ' — the product has no active BOM' else '' end)) as w
    from jsonb_array_elements(p_summary -> 'lines') l where (l ->> 'to_produce')::numeric > 0
    union all
    select to_jsonb(format('%s: short by %s %s. Purchase %s %s.', s ->> 'sku', trim_scale((s ->> 'shortage')::numeric), s ->> 'unit',
      trim_scale((s ->> 'recommended_purchase')::numeric), s ->> 'unit'))
    from jsonb_array_elements(p_summary -> 'shortages') s where (s ->> 'shortage')::numeric > 0) x), '[]'::jsonb);
$$;

revoke all on function private.so_v2_warnings(jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7. Create / edit
-- p_header: {customer_id, order_date, customer_gstin, billing_address, shipping_address,
--            requested_delivery_date, payment_terms, delivery_instructions, customer_reference,
--            customer_po_number, internal_notes (remarks), warehouse_id, freight_amount,
--            other_charges_amount, charges_gst_rate, draft (true = keep as draft),
--            correction_reason}
-- p_lines:  [{line_id?, product_id, description, quantity, unit_price, discount_percent,
--             discount_amount, gst_rate}]  (an existing line left out is cancelled)
-- -----------------------------------------------------------------------------
create or replace function private.so_v2_num(p jsonb, p_key text, p_label text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  return nullif(btrim(coalesce(p ->> p_key, '')), '')::numeric;
exception when others then
  raise exception '% must be a number.', p_label using errcode = 'P0001';
end;
$$;

revoke all on function private.so_v2_num(jsonb, text, text) from public, anon, authenticated;

create or replace function public.sales_order_v2_save(p_so_id uuid, p_header jsonb, p_lines jsonb, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_any_permission(array['sales_orders.create', 'sales_orders.update']);
  v_h        jsonb := coalesce(p_header, '{}'::jsonb);
  v_prev     jsonb;
  v_so       public.sales_orders;
  v_old      public.sales_orders;
  v_customer public.customers;
  v_entry    jsonb;
  v_line     public.sales_order_lines;
  v_product  public.products;
  v_qty      numeric;
  v_price    numeric;
  v_pct      numeric;
  v_amt      numeric;
  v_gst      numeric;
  v_no       int := 0;
  v_created  jsonb;
  v_draft    boolean := coalesce((v_h ->> 'draft')::boolean, false);
  v_kept     uuid[] := '{}';
  v_changes  jsonb := '[]'::jsonb;
  v_reason   text := nullif(btrim(coalesce(v_h ->> 'correction_reason', '')), '');
  v_min      numeric;
  v_res      public.stock_reservations;
  v_plan     jsonb;
  v_summary  jsonb;
  v_result   jsonb;
  v_fr       numeric;
  v_oc       numeric;
  v_cr       numeric;
begin
  if p_so_id is null then
    v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'sales_order_v2_save');
    if v_prev is not null then return v_prev; end if;
  elsif p_idempotency_key is not null then
    v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'sales_order_v2_save');
    if v_prev is not null then return v_prev; end if;
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 500 then
    raise exception 'Add between 1 and 500 products.' using errcode = 'P0001';
  end if;
  v_fr := coalesce(private.so_v2_num(v_h, 'freight_amount', 'Freight'), 0);
  v_oc := coalesce(private.so_v2_num(v_h, 'other_charges_amount', 'Other charges'), 0);
  v_cr := coalesce(private.so_v2_num(v_h, 'charges_gst_rate', 'GST rate on charges'), 18);
  if v_fr < 0 or v_oc < 0 or v_fr <> round(v_fr, 2) or v_oc <> round(v_oc, 2) then
    raise exception 'Freight and other charges must be zero or more (up to 2 decimals).' using errcode = 'P0001';
  end if;
  if v_cr < 0 or v_cr > 100 then
    raise exception 'The GST rate on charges must be between 0 and 100.' using errcode = 'P0001';
  end if;

  -- Validate and default every line first (price and GST from the Product Master when blank).
  for v_entry in select value from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;
    select * into v_product from public.products where id = nullif(v_entry ->> 'product_id', '')::uuid and company_id = v_company and archived_at is null;
    if not found or v_product.status <> 'ACTIVE' then
      raise exception 'Line %: choose an active product (add it to the Product Master first).', v_no using errcode = 'P0001';
    end if;
    v_qty := private.so_v2_num(v_entry, 'quantity', format('Line %s quantity', v_no));
    v_price := private.so_v2_num(v_entry, 'unit_price', format('Line %s price', v_no));
    v_pct := private.so_v2_num(v_entry, 'discount_percent', format('Line %s discount %%', v_no));
    v_amt := private.so_v2_num(v_entry, 'discount_amount', format('Line %s discount amount', v_no));
    v_gst := private.so_v2_num(v_entry, 'gst_rate', format('Line %s GST rate', v_no));
    if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) then
      raise exception 'Line % (%): quantity must be greater than zero (up to 3 decimals).', v_no, v_product.sku using errcode = 'P0001';
    end if;
    if private.is_whole_unit(v_product.base_unit) and v_qty <> trunc(v_qty) then
      raise exception 'Line % (%): % is counted in whole pieces.', v_no, v_product.sku, v_product.base_unit using errcode = 'P0001';
    end if;
    if coalesce(v_price, v_product.selling_price, 0) < 0 or coalesce(v_price, 0) <> round(coalesce(v_price, 0), 4) then
      raise exception 'Line % (%): the selling price must be zero or more (up to 4 decimals).', v_no, v_product.sku using errcode = 'P0001';
    end if;
    if v_pct is not null and (v_pct < 0 or v_pct > 100) then
      raise exception 'Line % (%): discount must be between 0 and 100 %%.', v_no, v_product.sku using errcode = 'P0001';
    end if;
    if v_amt is not null and (v_amt < 0 or v_amt > round(v_qty * coalesce(v_price, v_product.selling_price, 0), 2)) then
      raise exception 'Line % (%): the discount amount must be between 0 and the line value.', v_no, v_product.sku using errcode = 'P0001';
    end if;
    if coalesce(v_gst, v_product.gst_rate, 0) < 0 or coalesce(v_gst, v_product.gst_rate, 0) > 100 then
      raise exception 'Line % (%): GST rate must be between 0 and 100.', v_no, v_product.sku using errcode = 'P0001';
    end if;
    if length(coalesce(v_entry ->> 'description', '')) > 500 then
      raise exception 'Line %: the description is limited to 500 characters.', v_no using errcode = 'P0001';
    end if;
  end loop;

  if p_so_id is null then
    -- Creation reuses the Phase 7 manual order (customer, dates, duplicate customer PO checks, numbering).
    v_created := public.sales_order_create_manual(
      v_h || jsonb_build_object('customer_po_number', nullif(btrim(coalesce(v_h ->> 'customer_po_number', '')), '')),
      (select jsonb_agg(jsonb_build_object('product_id', e ->> 'product_id', 'quantity', e ->> 'quantity',
         'unit_price', coalesce(nullif(e ->> 'unit_price', ''), (select selling_price::text from public.products where id = (e ->> 'product_id')::uuid)),
         'notes', null)) from jsonb_array_elements(p_lines) e),
      not v_draft, gen_random_uuid());
    select * into v_so from public.sales_orders where id = (v_created ->> 'sales_order_id')::uuid for update;
    v_no := 0;
    for v_entry in select value from jsonb_array_elements(p_lines) loop
      v_no := v_no + 1;
      update public.sales_order_lines l set
        description = nullif(btrim(coalesce(v_entry ->> 'description', '')), ''),
        discount_percent = private.so_v2_num(v_entry, 'discount_percent', 'Discount'),
        discount_amount = case when private.so_v2_num(v_entry, 'discount_percent', 'Discount') is null then coalesce(private.so_v2_num(v_entry, 'discount_amount', 'Discount'), 0) else 0 end,
        gst_rate = coalesce(private.so_v2_num(v_entry, 'gst_rate', 'GST'), p.gst_rate)
      from public.products p
      where l.sales_order_id = v_so.id and l.line_no = v_no and p.id = l.product_id;
    end loop;
  else
    select * into v_so from public.sales_orders where id = p_so_id and company_id = v_company for update;
    if not found then
      raise exception 'Sales order not found in your company.' using errcode = 'P0001';
    end if;
    if not private.has_permission(v_company, 'sales_orders.update') then
      raise exception 'You are not allowed to edit sales orders (requires sales_orders.update).' using errcode = '42501';
    end if;
    if v_so.order_status in ('CANCELLED', 'FULFILLED') then
      raise exception 'A % sales order cannot be edited.%', lower(v_so.order_status),
        case when v_so.order_status = 'FULFILLED' then ' Reverse a dispatch first if it was wrong.' else '' end using errcode = 'P0001';
    end if;
    if exists (select 1 from public.sales_order_lines where sales_order_id = v_so.id and quantity_dispatched > 0) and v_reason is null then
      raise exception 'Part of this order has been dispatched: enter the reason for the correction.' using errcode = 'P0001';
    end if;
    v_old := v_so;

    -- Customer change: only before anything was dispatched, and not for an order made from a customer PO.
    if nullif(v_h ->> 'customer_id', '')::uuid is distinct from v_so.customer_id and nullif(v_h ->> 'customer_id', '') is not null then
      if v_so.source <> 'MANUAL' then
        raise exception 'The customer of an order created from a customer PO cannot be changed.' using errcode = 'P0001';
      end if;
      if exists (select 1 from public.sales_order_lines where sales_order_id = v_so.id and quantity_dispatched > 0)
         or exists (select 1 from public.fulfilments where sales_order_id = v_so.id and fulfilment_status <> 'CANCELLED') then
        raise exception 'The customer cannot be changed after goods were picked or dispatched.' using errcode = 'P0001';
      end if;
      select * into v_customer from public.customers where id = (v_h ->> 'customer_id')::uuid and company_id = v_company;
      if not found or v_customer.status <> 'ACTIVE' then
        raise exception 'Choose an active customer.' using errcode = 'P0001';
      end if;
      update public.sales_orders set customer_id = v_customer.id, customer_key = private.po_customer_key(v_customer.id, null),
        customer_name_snapshot = v_customer.customer_name where id = v_so.id;
    end if;
    if v_h ? 'requested_delivery_date' and private.so_header_date(v_h, 'requested_delivery_date') < v_so.order_date then
      raise exception 'The expected delivery date cannot be before the order date.' using errcode = 'P0001';
    end if;
    if v_h ? 'warehouse_id' then
      perform private.so_check_warehouse(v_company, nullif(v_h ->> 'warehouse_id', '')::uuid);
    end if;
    update public.sales_orders set
      requested_delivery_date = case when v_h ? 'requested_delivery_date' then private.so_header_date(v_h, 'requested_delivery_date') else requested_delivery_date end,
      shipping_address_snapshot = case when v_h ? 'shipping_address' then private.so_header_value(v_h, 'shipping_address', 1000) else shipping_address_snapshot end,
      billing_address_snapshot = case when v_h ? 'billing_address' then private.so_header_value(v_h, 'billing_address', 1000) else billing_address_snapshot end,
      customer_reference = case when v_h ? 'customer_reference' then private.so_header_value(v_h, 'customer_reference', 100) else customer_reference end,
      internal_notes = case when v_h ? 'internal_notes' then private.so_header_value(v_h, 'internal_notes', 2000) else internal_notes end,
      warehouse_id = case when v_h ? 'warehouse_id' then nullif(v_h ->> 'warehouse_id', '')::uuid else warehouse_id end
    where id = v_so.id;

    -- Lines
    v_no := 0;
    for v_entry in select value from jsonb_array_elements(p_lines) loop
      v_no := v_no + 1;
      v_qty := private.so_v2_num(v_entry, 'quantity', 'Quantity');
      select * into v_product from public.products where id = (v_entry ->> 'product_id')::uuid;
      if nullif(v_entry ->> 'line_id', '') is not null then
        select * into v_line from public.sales_order_lines where id = (v_entry ->> 'line_id')::uuid and sales_order_id = v_so.id for update;
        if not found then
          raise exception 'Line %: it does not belong to this order.', v_no using errcode = 'P0001';
        end if;
        v_kept := v_kept || v_line.id;
        if v_line.product_id <> v_product.id then
          if v_line.quantity_dispatched > 0 or private.so_line_planned(v_line.id) > 0 then
            raise exception 'Line % (%): the product cannot be changed after it was picked or dispatched; add a new line instead.', v_line.line_no, v_line.sku_snapshot
              using errcode = 'P0001';
          end if;
          if private.so_v2_line_production_open(v_line.id) > 0 then
            raise exception 'Line % (%): cancel its open production order before changing the product.', v_line.line_no, v_line.sku_snapshot using errcode = 'P0001';
          end if;
          for v_res in select * from public.stock_reservations where reference_id = v_line.id and reference_type in ('SALES_ORDER_LINE', 'SALES_ORDER_MATERIAL')
                         and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') for update loop
            perform private.release_reservation_remaining(v_res, 'RELEASED');
          end loop;
          v_changes := v_changes || jsonb_build_object('line_no', v_line.line_no, 'field', 'product', 'old', v_line.sku_snapshot, 'new', v_product.sku);
          update public.sales_order_lines set product_id = v_product.id, sku_snapshot = v_product.sku, product_name_snapshot = v_product.product_name,
            unit = v_product.base_unit where id = v_line.id;
        end if;
        v_min := v_line.quantity_dispatched + private.so_line_planned(v_line.id);
        if v_qty < v_min then
          raise exception 'Line % (%): the quantity cannot go below % (already dispatched or on an open pick list).', v_line.line_no, v_line.sku_snapshot, v_min
            using errcode = 'P0001';
        end if;
        if v_qty <> v_line.quantity_ordered - v_line.quantity_cancelled then
          v_changes := v_changes || jsonb_build_object('line_no', v_line.line_no, 'field', 'quantity', 'old', v_line.quantity_ordered - v_line.quantity_cancelled, 'new', v_qty);
        end if;
        if coalesce(private.so_v2_num(v_entry, 'unit_price', 'Price'), v_line.unit_price_snapshot) is distinct from v_line.unit_price_snapshot then
          v_changes := v_changes || jsonb_build_object('line_no', v_line.line_no, 'field', 'price', 'old', v_line.unit_price_snapshot, 'new', private.so_v2_num(v_entry, 'unit_price', 'Price'));
        end if;
        if private.so_v2_num(v_entry, 'discount_percent', 'Discount') is distinct from v_line.discount_percent then
          v_changes := v_changes || jsonb_build_object('line_no', v_line.line_no, 'field', 'discount %', 'old', v_line.discount_percent, 'new', private.so_v2_num(v_entry, 'discount_percent', 'Discount'));
        end if;
        update public.sales_order_lines set
          quantity_ordered = v_qty + quantity_cancelled,
          unit_price_snapshot = coalesce(private.so_v2_num(v_entry, 'unit_price', 'Price'), unit_price_snapshot),
          description = nullif(btrim(coalesce(v_entry ->> 'description', '')), ''),
          discount_percent = private.so_v2_num(v_entry, 'discount_percent', 'Discount'),
          discount_amount = case when private.so_v2_num(v_entry, 'discount_percent', 'Discount') is null then coalesce(private.so_v2_num(v_entry, 'discount_amount', 'Discount'), 0) else 0 end,
          gst_rate = coalesce(private.so_v2_num(v_entry, 'gst_rate', 'GST'), gst_rate, v_product.gst_rate),
          requested_delivery_date = case when v_h ? 'requested_delivery_date' then private.so_header_date(v_h, 'requested_delivery_date') else requested_delivery_date end
        where id = v_line.id;
      else
        insert into public.sales_order_lines (company_id, sales_order_id, line_no, product_id, sku_snapshot, product_name_snapshot, quantity_ordered, unit,
          unit_price_snapshot, currency, requested_delivery_date, description, discount_percent, discount_amount, gst_rate)
        values (v_company, v_so.id, (select coalesce(max(line_no), 0) + 1 from public.sales_order_lines where sales_order_id = v_so.id), v_product.id,
          v_product.sku, v_product.product_name, v_qty, v_product.base_unit, coalesce(private.so_v2_num(v_entry, 'unit_price', 'Price'), v_product.selling_price),
          v_so.currency, v_so.requested_delivery_date, nullif(btrim(coalesce(v_entry ->> 'description', '')), ''),
          private.so_v2_num(v_entry, 'discount_percent', 'Discount'),
          case when private.so_v2_num(v_entry, 'discount_percent', 'Discount') is null then coalesce(private.so_v2_num(v_entry, 'discount_amount', 'Discount'), 0) else 0 end,
          coalesce(private.so_v2_num(v_entry, 'gst_rate', 'GST'), v_product.gst_rate))
        returning * into v_line;
        v_kept := v_kept || v_line.id;
        v_changes := v_changes || jsonb_build_object('line_no', v_line.line_no, 'field', 'added', 'old', null, 'new', v_product.sku || ' x ' || v_qty);
      end if;
    end loop;

    -- Lines left out: their remaining quantity is cancelled (history is kept).
    for v_line in select * from public.sales_order_lines where sales_order_id = v_so.id and not (id = any(v_kept))
                    and quantity_ordered - quantity_cancelled - quantity_dispatched > 0 for update loop
      if private.so_line_planned(v_line.id) > 0 then
        raise exception 'Line % (%) is on an open pick list and cannot be removed.', v_line.line_no, v_line.sku_snapshot using errcode = 'P0001';
      end if;
      for v_res in select * from public.stock_reservations where reference_id = v_line.id and reference_type in ('SALES_ORDER_LINE', 'SALES_ORDER_MATERIAL')
                     and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') for update loop
        perform private.release_reservation_remaining(v_res, 'RELEASED');
      end loop;
      update public.sales_order_lines set quantity_cancelled = quantity_ordered - quantity_dispatched where id = v_line.id;
      v_changes := v_changes || jsonb_build_object('line_no', v_line.line_no, 'field', 'removed', 'old', v_line.sku_snapshot, 'new', null);
    end loop;
  end if;

  update public.sales_orders set
    customer_gstin_snapshot = coalesce(nullif(upper(btrim(coalesce(v_h ->> 'customer_gstin', ''))), ''),
                                       case when p_so_id is null or v_h ? 'customer_id' then (select gstin from public.customers where id = customer_id) end, customer_gstin_snapshot),
    payment_terms = case when v_h ? 'payment_terms' or p_so_id is null then private.so_header_value(v_h, 'payment_terms', 200) else payment_terms end,
    delivery_instructions = case when v_h ? 'delivery_instructions' or p_so_id is null then private.so_header_value(v_h, 'delivery_instructions', 1000) else delivery_instructions end,
    freight_amount = case when v_h ? 'freight_amount' or p_so_id is null then v_fr else freight_amount end,
    other_charges_amount = case when v_h ? 'other_charges_amount' or p_so_id is null then v_oc else other_charges_amount end,
    charges_gst_rate = case when v_h ? 'charges_gst_rate' or p_so_id is null then v_cr else charges_gst_rate end
  where id = v_so.id;
  perform private.so_v2_price(v_so.id);

  if p_so_id is not null then
    select * into v_so from public.sales_orders where id = v_so.id;
    if v_old.customer_id is distinct from v_so.customer_id then
      v_changes := v_changes || jsonb_build_object('field', 'customer', 'old', v_old.customer_name_snapshot, 'new', v_so.customer_name_snapshot);
    end if;
    if v_old.requested_delivery_date is distinct from v_so.requested_delivery_date then
      v_changes := v_changes || jsonb_build_object('field', 'expected delivery date', 'old', v_old.requested_delivery_date, 'new', v_so.requested_delivery_date);
    end if;
    if v_old.grand_total is distinct from v_so.grand_total then
      v_changes := v_changes || jsonb_build_object('field', 'grand total', 'old', v_old.grand_total, 'new', v_so.grand_total);
    end if;
    perform private.log_so_event(v_company, v_so.id, null, null, null, 'EDITED', v_old.order_status, v_so.order_status, v_reason,
      jsonb_build_object('changes', v_changes));
    if v_so.order_status in ('DRAFT', 'PENDING_CONFIRMATION') and not v_draft then
      perform private.so_confirm(v_so.id, null);
    end if;
  end if;

  v_plan := private.so_v2_reserve(v_company, v_so.id);
  v_summary := private.so_v2_summary(v_so.id);
  v_result := v_summary || jsonb_build_object('reservations', v_plan, 'warnings', private.so_v2_warnings(v_summary), 'changes', v_changes);
  if p_idempotency_key is not null then
    return private.idempotency_finish(v_company, p_idempotency_key, v_result);
  end if;
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Recalculate / release reservations, summary
-- -----------------------------------------------------------------------------
create or replace function public.sales_order_v2_reserve(p_so_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['sales_orders.create', 'sales_orders.update']);
  v_so      public.sales_orders;
  v_plan    jsonb;
  v_summary jsonb;
begin
  select * into v_so from public.sales_orders where id = p_so_id and company_id = v_company for update;
  if not found then
    raise exception 'Sales order not found in your company.' using errcode = 'P0001';
  end if;
  if v_so.order_status in ('CANCELLED', 'FULFILLED', 'ON_HOLD', 'DRAFT', 'PENDING_CONFIRMATION') then
    raise exception 'Reservations cannot be recalculated while the order is %.', replace(lower(v_so.order_status), '_', ' ') using errcode = 'P0001';
  end if;
  v_plan := private.so_v2_reserve(v_company, v_so.id);
  perform private.log_so_event(v_company, v_so.id, null, null, null, 'RESERVATIONS_RECALCULATED', null, null, null, jsonb_build_object('result', v_plan));
  v_summary := private.so_v2_summary(v_so.id);
  return v_summary || jsonb_build_object('reservations', v_plan, 'warnings', private.so_v2_warnings(v_summary));
end;
$$;

create or replace function public.sales_order_v2_release(p_so_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['sales_orders.update', 'fulfilment_reservations.release']);
  v_so      public.sales_orders;
  v_res     public.stock_reservations;
  v_free    numeric;
  v_fg      numeric := 0;
  v_mat     numeric;
begin
  select * into v_so from public.sales_orders where id = p_so_id and company_id = v_company for update;
  if not found then
    raise exception 'Sales order not found in your company.' using errcode = 'P0001';
  end if;
  for v_res in
    select r.* from public.stock_reservations r join public.sales_order_lines l on l.id = r.reference_id and l.sales_order_id = v_so.id
    where r.reference_type = 'SALES_ORDER_LINE' and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
    order by r.location_id, r.batch_id for update of r
  loop
    v_free := v_res.quantity - v_res.fulfilled_quantity - v_res.released_quantity - private.reservation_planned(v_res.id);
    continue when v_free <= 0;
    v_fg := v_fg + private.release_reservation_qty(v_res, v_free, 'RELEASED');
  end loop;
  v_mat := private.so_v2_release_materials(v_so.id);
  perform private.so_recompute(v_so.id);
  perform private.log_so_event(v_company, v_so.id, null, null, null, 'RESERVATIONS_RELEASED', null, null, p_reason,
    jsonb_build_object('finished_goods_released', v_fg, 'materials_released', v_mat));
  return private.so_v2_summary(v_so.id) || jsonb_build_object('finished_goods_released', v_fg, 'materials_released', v_mat);
end;
$$;

create or replace function public.sales_order_v2_summary(p_so_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['sales_orders.read', 'fulfilment.read']);
  v_summary jsonb;
begin
  if not exists (select 1 from public.sales_orders where id = p_so_id and company_id = v_company) then
    raise exception 'Sales order not found in your company.' using errcode = 'P0001';
  end if;
  v_summary := private.so_v2_summary(p_so_id);
  return v_summary || jsonb_build_object('warnings', private.so_v2_warnings(v_summary),
    'dispatches', coalesce((select jsonb_agg(jsonb_build_object('fulfilment_id', f.id, 'fulfilment_number', f.fulfilment_number, 'status', f.fulfilment_status,
        'dispatched_at', f.actual_dispatch_at, 'created_at', f.created_at, 'vehicle_number', f.vehicle_number, 'lr_number', f.lr_number, 'cancel_reason', f.cancel_reason,
        'lines', (select jsonb_agg(jsonb_build_object('sku', sol.sku_snapshot, 'unit', sol.unit, 'quantity', fl.quantity_dispatched,
                   'quantity_to_pick', fl.quantity_to_pick, 'transaction_number', t.transaction_number) order by fl.line_no)
                  from public.fulfilment_lines fl join public.sales_order_lines sol on sol.id = fl.sales_order_line_id
                  left join public.inventory_transactions t on t.id = fl.issue_transaction_id where fl.fulfilment_id = f.id),
        'invoiced', private.so_v2_fulfilment_invoiced(f.id)) order by f.created_at)
      from public.fulfilments f where f.sales_order_id = p_so_id), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'event_type', e.event_type, 'from_status', e.from_status, 'to_status', e.to_status,
        'note', e.note, 'details', e.details, 'created_at', e.created_at, 'actor_user_id', e.actor_user_id) order by e.created_at desc, e.id desc)
      from public.sales_order_events e where e.sales_order_id = p_so_id), '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Production orders from a sales order (Stage 4 flow, linked to the line)
-- -----------------------------------------------------------------------------
create or replace function public.sales_order_v2_create_production(p_so_id uuid, p_line_id uuid default null, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_order.create');
  v_prev    jsonb;
  v_so      public.sales_orders;
  v_line    public.sales_order_lines;
  v_make    numeric;
  v_bom     public.boms;
  v_res     jsonb;
  v_created jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_wh      uuid;
begin
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'sales_order_v2_production');
  if v_prev is not null then return v_prev; end if;
  select * into v_so from public.sales_orders where id = p_so_id and company_id = v_company for update;
  if not found then
    raise exception 'Sales order not found in your company.' using errcode = 'P0001';
  end if;
  if v_so.order_status in ('CANCELLED', 'FULFILLED', 'DRAFT', 'PENDING_CONFIRMATION', 'ON_HOLD') then
    raise exception 'Production orders cannot be created while the sales order is %.', replace(lower(v_so.order_status), '_', ' ') using errcode = 'P0001';
  end if;
  if p_line_id is not null and not exists (select 1 from public.sales_order_lines where id = p_line_id and sales_order_id = v_so.id) then
    raise exception 'The line does not belong to this sales order.' using errcode = 'P0001';
  end if;
  v_wh := private.so_v2_material_warehouse(v_so);

  for v_line in select * from public.sales_order_lines where sales_order_id = v_so.id and (p_line_id is null or id = p_line_id) order by line_no for update loop
    -- Outstanding = not dispatched, not reserved and not already covered by an open production order.
    v_make := private.so_v2_to_produce(v_line);
    continue when v_make <= 0;
    if private.is_whole_unit(v_line.unit) then v_make := ceil(v_make); end if;
    v_bom := private.production_v2_active_bom(v_company, v_line.product_id);
    if v_bom.id is null then
      v_skipped := v_skipped || jsonb_build_object('line_no', v_line.line_no, 'sku', v_line.sku_snapshot, 'reason', 'no active BOM: add its components first');
      continue;
    end if;
    -- The line's material reservations are handed to the production order.
    perform private.so_v2_release_materials(v_so.id, v_line.id);
    v_res := public.production_order_v2_save(null, jsonb_build_object('product_id', v_line.product_id, 'planned_quantity', v_make,
      'production_date', private.company_today(v_company), 'warehouse_id', v_wh,
      'remarks', format('For sales order %s line %s (%s)', v_so.sales_order_number, v_line.line_no, v_so.customer_name_snapshot)), gen_random_uuid());
    update public.production_orders set sales_order_id = v_so.id, sales_order_line_id = v_line.id where id = (v_res ->> 'order_id')::uuid;
    v_created := v_created || jsonb_build_object('line_no', v_line.line_no, 'sku', v_line.sku_snapshot, 'quantity', v_make, 'unit', v_line.unit,
      'order_id', v_res -> 'order_id', 'production_order_number', v_res -> 'production_order_number', 'status', v_res -> 'status', 'warnings', v_res -> 'warnings');
  end loop;
  if jsonb_array_length(v_created) = 0 and jsonb_array_length(v_skipped) = 0 then
    raise exception 'Nothing to produce: the order is covered by reserved stock and existing production orders.' using errcode = 'P0001';
  end if;
  perform private.so_recompute(v_so.id);
  perform private.log_so_event(v_company, v_so.id, null, null, p_line_id, 'PRODUCTION_ORDERS_CREATED', null, null, null,
    jsonb_build_object('created', v_created, 'skipped', v_skipped));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('created', v_created, 'skipped', v_skipped,
    'status', private.so_v2_status(v_so.id)));
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Dispatch (one step) and dispatch reversal
-- p_lines: [{line_id, quantity}]   p_details: as public.fulfilment_dispatch
-- -----------------------------------------------------------------------------
create or replace function public.sales_order_v2_dispatch(p_so_id uuid, p_lines jsonb, p_details jsonb default '{}'::jsonb, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('fulfilment.dispatch');
  v_prev    jsonb;
  v_so      public.sales_orders;
  v_entry   jsonb;
  v_line    public.sales_order_lines;
  v_qty     numeric;
  v_left    numeric;
  v_take    numeric;
  v_res     record;
  v_picks   jsonb := '[]'::jsonb;
  v_wh      uuid;
  v_f       jsonb;
  v_fid     uuid;
  v_d       jsonb;
  v_out     jsonb := '[]'::jsonb;
  v_numbers jsonb := '[]'::jsonb;
  v_total   numeric := 0;
begin
  if not (private.has_permission(v_company, 'fulfilment.pick') and private.has_permission(v_company, 'fulfilment.pack')) then
    raise exception 'Dispatching in one step requires fulfilment.pick, fulfilment.pack and fulfilment.dispatch.' using errcode = '42501';
  end if;
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'sales_order_v2_dispatch');
  if v_prev is not null then return v_prev; end if;
  select * into v_so from public.sales_orders where id = p_so_id and company_id = v_company for update;
  if not found then
    raise exception 'Sales order not found in your company.' using errcode = 'P0001';
  end if;
  perform private.so_assert_workable(v_so, 'dispatch');
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Enter the quantity to dispatch.' using errcode = 'P0001';
  end if;

  for v_entry in select value from jsonb_array_elements(p_lines) loop
    v_qty := private.so_v2_num(v_entry, 'quantity', 'Dispatch quantity');
    continue when v_qty is null or v_qty = 0;
    select * into v_line from public.sales_order_lines where id = nullif(v_entry ->> 'line_id', '')::uuid and sales_order_id = v_so.id for update;
    if not found then
      raise exception 'A line does not belong to this sales order.' using errcode = 'P0001';
    end if;
    if v_qty < 0 or v_qty <> round(v_qty, 3) or (private.is_whole_unit(v_line.unit) and v_qty <> trunc(v_qty)) then
      raise exception 'Line % (%): enter a valid quantity to dispatch.', v_line.line_no, v_line.sku_snapshot using errcode = 'P0001';
    end if;
    if v_qty > v_line.quantity_ordered - v_line.quantity_cancelled - v_line.quantity_dispatched then
      raise exception 'Line % (%): only % % is still to dispatch.', v_line.line_no, v_line.sku_snapshot,
        trim_scale(v_line.quantity_ordered - v_line.quantity_cancelled - v_line.quantity_dispatched), v_line.unit using errcode = 'P0001';
    end if;
    -- Top up the finished-goods reservation from free stock if needed, then take reserved stock.
    if private.so_line_open_reserved(v_line.id) - private.so_line_planned(v_line.id) < v_qty then
      perform private.so_v2_reserve_line(v_company, v_so, v_line.id);
    end if;
    v_left := v_qty;
    for v_res in
      select r.*, bt.expiry_date from public.stock_reservations r join public.inventory_batches bt on bt.id = r.batch_id
      where r.reference_type = 'SALES_ORDER_LINE' and r.reference_id = v_line.id and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
      order by bt.expiry_date nulls last, r.reserved_at, r.reservation_number
    loop
      exit when v_left <= 0;
      v_take := least(v_left, v_res.quantity - v_res.fulfilled_quantity - v_res.released_quantity - private.reservation_planned(v_res.id)
        - coalesce((select sum((p ->> 'quantity')::numeric) from jsonb_array_elements(v_picks) p where p ->> 'reservation_id' = v_res.id::text), 0));
      continue when v_take <= 0;
      v_picks := v_picks || jsonb_build_object('reservation_id', v_res.id, 'quantity', v_take, 'warehouse_id', v_res.warehouse_id);
      v_left := v_left - v_take;
    end loop;
    if v_left > 0 then
      raise exception 'Line % (%): only % % is in stock and reserved for this order; % short. Produce or receive the goods first.', v_line.line_no, v_line.sku_snapshot,
        trim_scale(v_qty - v_left), v_line.unit, trim_scale(v_left) using errcode = 'P0001';
    end if;
  end loop;
  if jsonb_array_length(v_picks) = 0 then
    raise exception 'Enter the quantity to dispatch.' using errcode = 'P0001';
  end if;

  -- One consignment per warehouse, through the existing pick -> pack -> dispatch postings.
  v_d := coalesce(p_details, '{}'::jsonb) - 'dispatched_at';
  for v_wh in select distinct (p ->> 'warehouse_id')::uuid from jsonb_array_elements(v_picks) p loop
    v_f := public.fulfilment_create(v_so.id, v_wh,
      (select jsonb_agg(jsonb_build_object('reservation_id', p ->> 'reservation_id', 'quantity', p -> 'quantity')) from jsonb_array_elements(v_picks) p
       where (p ->> 'warehouse_id')::uuid = v_wh), null, nullif(btrim(coalesce(v_d ->> 'notes', '')), ''), gen_random_uuid());
    v_fid := (v_f ->> 'fulfilment_id')::uuid;
    perform public.fulfilment_pick(v_fid, (select jsonb_agg(jsonb_build_object('line_id', id, 'quantity_picked', quantity_to_pick))
      from public.fulfilment_lines where fulfilment_id = v_fid), true);
    perform public.fulfilment_pack(v_fid, (select jsonb_agg(jsonb_build_object('line_id', id, 'quantity_packed', quantity_picked, 'quantity_damaged', 0))
      from public.fulfilment_lines where fulfilment_id = v_fid), null, true);
    perform public.fulfilment_action(v_fid, 'READY', null);
    v_f := v_f || public.fulfilment_dispatch(v_fid, v_d, gen_random_uuid());
    v_numbers := v_numbers || coalesce(v_f -> 'transaction_numbers', '[]'::jsonb);
    v_total := v_total + coalesce((v_f ->> 'dispatched_quantity')::numeric, 0);
    v_out := v_out || jsonb_build_object('fulfilment_id', v_fid, 'fulfilment_number', v_f ->> 'fulfilment_number', 'quantity', v_f -> 'dispatched_quantity');
  end loop;

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('dispatches', v_out, 'transaction_numbers', v_numbers,
    'dispatched_quantity', v_total, 'status', private.so_v2_status(v_so.id)));
end;
$$;

-- Reverses a dispatch: the goods go back to the same lot and location with
-- REVERSAL entries (the original ISSUE is kept), are reserved for the order
-- again, and the order's dispatched quantities go back down. Refused when the
-- dispatch was invoiced (cancel the invoice or issue a credit note first) or
-- delivered (use Customer Returns).
create or replace function public.sales_order_v2_reverse_dispatch(p_fulfilment_id uuid, p_reason text, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('fulfilment.dispatch');
  v_prev    jsonb;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_f       public.fulfilments;
  v_so      public.sales_orders;
  v_fl      public.fulfilment_lines;
  v_sol     public.sales_order_lines;
  v_numbers text[] := '{}';
  v_bal     uuid;
  v_total   numeric := 0;
begin
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'sales_order_v2_reverse_dispatch');
  if v_prev is not null then return v_prev; end if;
  if v_reason is null or length(v_reason) < 5 then
    raise exception 'Enter the reason for reversing the dispatch (at least 5 characters).' using errcode = 'P0001';
  end if;
  v_f := private.lock_fulfilment(v_company, p_fulfilment_id);
  select * into v_so from public.sales_orders where id = v_f.sales_order_id;
  if v_f.fulfilment_status not in ('DISPATCHED', 'IN_TRANSIT') then
    raise exception 'Only a dispatched consignment that has not been delivered can be reversed (% is %).', v_f.fulfilment_number,
      private.fulfilment_status_label(v_f.fulfilment_status) using errcode = 'P0001';
  end if;
  if v_so.order_status = 'CANCELLED' then
    raise exception 'Sales order % is cancelled: use Customer Returns for goods coming back.', v_so.sales_order_number using errcode = 'P0001';
  end if;
  if exists (select 1 from public.fulfilment_lines where fulfilment_id = v_f.id and quantity_delivered > 0) then
    raise exception 'Part of % was delivered: use Customer Returns for goods coming back.', v_f.fulfilment_number using errcode = 'P0001';
  end if;
  if private.so_v2_fulfilment_invoiced(v_f.id) then
    raise exception '% has been invoiced: cancel the invoice or issue a credit note before reversing the dispatch.', v_f.fulfilment_number using errcode = 'P0001';
  end if;

  for v_fl in select * from public.fulfilment_lines where fulfilment_id = v_f.id and issue_transaction_id is not null and quantity_dispatched > 0 order by line_no for update loop
    v_numbers := v_numbers || private.reverse_ledger_transaction(v_company, v_fl.issue_transaction_id, 'Dispatch ' || v_f.fulfilment_number || ' reversed: ' || v_reason);
    -- Reserved for the order again (same lot and location).
    select id into v_bal from public.inventory_balances where batch_id = v_fl.batch_id and location_id = v_fl.location_id;
    perform private.reserve_balance(v_company, v_bal, v_fl.quantity_dispatched, 'SALES_ORDER_LINE', v_so.sales_order_number, v_fl.sales_order_line_id,
      'Re-reserved after dispatch ' || v_f.fulfilment_number || ' was reversed');
    select * into v_sol from public.sales_order_lines where id = v_fl.sales_order_line_id for update;
    update public.sales_order_lines set quantity_dispatched = quantity_dispatched - v_fl.quantity_dispatched where id = v_sol.id;
    if v_sol.customer_purchase_order_line_id is not null then
      update public.customer_purchase_order_lines set quantity_dispatched = quantity_dispatched - v_fl.quantity_dispatched where id = v_sol.customer_purchase_order_line_id;
    end if;
    v_total := v_total + v_fl.quantity_dispatched;
    update public.fulfilment_lines set quantity_dispatched = 0 where id = v_fl.id;
  end loop;

  update public.fulfilments set fulfilment_status = 'CANCELLED', actual_dispatch_at = null,
    cancel_reason = left('Dispatch reversed: ' || v_reason, 500), cancelled_by = auth.uid(), cancelled_at = now()
  where id = v_f.id;
  insert into public.delivery_events (company_id, fulfilment_id, event_type, event_at, description, source, recorded_by)
  values (v_company, v_f.id, 'EXCEPTION', now(), left('Dispatch reversed (' || array_to_string(v_numbers, ', ') || '): ' || v_reason, 1000), 'SYSTEM', auth.uid());
  -- A fulfilled order becomes workable again.
  if v_so.order_status = 'FULFILLED' then
    update public.sales_orders set order_status = 'CONFIRMED' where id = v_so.id;
  end if;
  perform private.so_recompute(v_so.id);
  perform private.log_so_event(v_company, v_so.id, v_f.id, null, null, 'DISPATCH_REVERSED', v_f.fulfilment_status, 'CANCELLED', v_reason,
    jsonb_build_object('fulfilment_number', v_f.fulfilment_number, 'reversal_numbers', to_jsonb(v_numbers), 'quantity', v_total,
      'dispatched_at', v_f.actual_dispatch_at));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('reversal_numbers', to_jsonb(v_numbers), 'quantity', v_total,
    'status', private.so_v2_status(v_so.id)));
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. Cancel (also releases material reservations)
-- -----------------------------------------------------------------------------
create or replace function public.sales_order_v2_cancel(p_so_id uuid, p_reason text, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('sales_orders.cancel');
  v_prev    jsonb;
  v_mat     numeric;
  v_res     jsonb;
  v_prod    text;
begin
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'sales_order_v2_cancel');
  if v_prev is not null then return v_prev; end if;
  if not exists (select 1 from public.sales_orders where id = p_so_id and company_id = v_company) then
    raise exception 'Sales order not found in your company.' using errcode = 'P0001';
  end if;
  v_mat := private.so_v2_release_materials(p_so_id);
  v_res := public.sales_order_cancel(p_so_id, p_reason, gen_random_uuid());
  select string_agg(production_order_number, ', ' order by production_order_number) into v_prod
  from public.production_orders where sales_order_id = p_so_id and status not in ('COMPLETED', 'CANCELLED');
  return private.idempotency_finish(v_company, p_idempotency_key, v_res || jsonb_build_object('materials_released', v_mat,
    'warnings', case when v_prod is null then '[]'::jsonb
      else jsonb_build_array(format('Production order(s) %s were made for this order and are still open: cancel them on the production screen if they are no longer needed.', v_prod)) end));
end;
$$;

-- -----------------------------------------------------------------------------
-- 12. Sales dashboard and order register
-- -----------------------------------------------------------------------------
create or replace function public.sales_orders_v2_list(p_from date default null, p_to date default null, p_customer_id uuid default null, p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['sales_orders.read', 'fulfilment.read']);
begin
  return coalesce((select jsonb_agg(x order by x ->> 'order_date' desc, x ->> 'sales_order_number' desc) from (
    select jsonb_build_object('id', so.id, 'sales_order_number', so.sales_order_number, 'order_date', so.order_date, 'customer_id', so.customer_id,
      'customer_name', so.customer_name_snapshot, 'customer_reference', coalesce(so.customer_reference, so.customer_po_number),
      'requested_delivery_date', so.requested_delivery_date, 'grand_total', so.grand_total, 'status', s.status, 'order_status', so.order_status,
      'created_at', so.created_at,
      'units', (select jsonb_agg(u order by u ->> 'unit') from (select jsonb_build_object('unit', l.unit, 'ordered', sum(l.quantity_ordered - l.quantity_cancelled),
          'dispatched', sum(l.quantity_dispatched), 'reserved', sum(private.so_line_open_reserved(l.id))) as u
        from public.sales_order_lines l where l.sales_order_id = so.id group by l.unit) y)) as x
    from public.sales_orders so
    cross join lateral (select private.so_v2_status(so.id) as status) s
    where so.company_id = v_company and (p_from is null or so.order_date >= p_from) and (p_to is null or so.order_date <= p_to)
      and (p_customer_id is null or so.customer_id = p_customer_id) and (p_status is null or s.status = p_status)) z), '[]'::jsonb);
end;
$$;

create or replace function public.sales_dashboard(p_from date default null, p_to date default null, p_customer_id uuid default null, p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['sales_orders.read', 'fulfilment.read']);
  v_today   date := private.company_today(v_company);
  v_from    date := coalesce(p_from, date_trunc('month', private.company_today(v_company))::date);
  v_to      date := coalesce(p_to, private.company_today(v_company));
begin
  if v_to < v_from then
    raise exception 'The end date cannot be before the start date.' using errcode = 'P0001';
  end if;
  return (
    with o as (
      select so.*, private.so_v2_status(so.id) as v2
      from public.sales_orders so
      where so.company_id = v_company and (p_customer_id is null or so.customer_id = p_customer_id)
    ),
    f as (select * from o where order_date between v_from and v_to and (p_status is null or v2 = p_status)),
    open_lines as (
      select l.*, o.v2 from public.sales_order_lines l join o on o.id = l.sales_order_id
      where o.v2 not in ('CANCELLED', 'FULLY_DISPATCHED', 'DRAFT') and (p_status is null or o.v2 = p_status)
    )
    select jsonb_build_object(
      'from', v_from, 'to', v_to, 'today', v_today,
      'total_orders', (select count(*) from f),
      'created_today', (select count(*) from o where order_date = v_today and (p_status is null or v2 = p_status)),
      'this_month', (select count(*) from o where order_date >= date_trunc('month', v_today)::date and order_date <= v_today and (p_status is null or v2 = p_status)),
      'total_value', (select coalesce(sum(grand_total), 0) from f where v2 <> 'CANCELLED'),
      'pending', (select count(*) from f where v2 in ('OPEN', 'PARTIALLY_RESERVED', 'STOCK_SHORTAGE', 'PRODUCTION_PENDING', 'READY_FOR_DISPATCH')),
      'partially_fulfilled', (select count(*) from f where v2 = 'PARTIALLY_DISPATCHED'),
      'fully_fulfilled', (select count(*) from f where v2 = 'FULLY_DISPATCHED'),
      'cancelled', (select count(*) from f where v2 = 'CANCELLED'),
      'awaiting_dispatch', (select count(*) from o where v2 in ('READY_FOR_DISPATCH', 'PARTIALLY_DISPATCHED', 'PARTIALLY_RESERVED', 'PRODUCTION_PENDING', 'STOCK_SHORTAGE')
                              and exists (select 1 from public.sales_order_lines l where l.sales_order_id = o.id and private.so_line_open_reserved(l.id) > 0)
                              and (p_status is null or v2 = p_status)),
      'by_status', (select coalesce(jsonb_object_agg(v2, n), '{}'::jsonb) from (select v2, count(*) as n from f group by v2) s),
      'finished_goods_reserved', (select coalesce(jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit), '[]'::jsonb) from (
          select unit, sum(private.so_line_open_reserved(id)) as q from open_lines group by unit having sum(private.so_line_open_reserved(id)) > 0) x),
      'production_required', (select coalesce(jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q, 'in_production', p) order by unit), '[]'::jsonb) from (
          select l.unit, sum(private.so_v2_to_produce(l)) as q, sum(private.so_v2_line_production_open(l.id)) as p
          from open_lines ol join public.sales_order_lines l on l.id = ol.id group by l.unit
          having sum(private.so_v2_to_produce(l)) + sum(private.so_v2_line_production_open(l.id)) > 0) x),
      'ordered', (select coalesce(jsonb_agg(jsonb_build_object('unit', unit, 'ordered', q, 'dispatched', d, 'pending', q - d) order by unit), '[]'::jsonb) from (
          select l.unit, sum(l.quantity_ordered - l.quantity_cancelled) as q, sum(l.quantity_dispatched) as d
          from public.sales_order_lines l join f on f.id = l.sales_order_id where f.v2 <> 'CANCELLED' group by l.unit) x),
      'shortages', (select coalesce(jsonb_agg(s order by s ->> 'sku'), '[]'::jsonb) from (
          select jsonb_build_object('product_id', (e ->> 'product_id'), 'sku', e ->> 'sku', 'product_name', min(e ->> 'product_name'), 'unit', e ->> 'unit',
            'required', sum((e ->> 'required')::numeric), 'reserved', sum((e ->> 'reserved')::numeric), 'available', max((e ->> 'available')::numeric),
            'shortage', greatest(sum((e ->> 'required')::numeric) - sum((e ->> 'reserved')::numeric) - max((e ->> 'available')::numeric), 0),
            'preferred_supplier_name', min(e ->> 'preferred_supplier_name'), 'orders', count(*)) as s
          from o cross join lateral jsonb_array_elements(private.so_v2_shortages(o.id)) e
          where o.v2 not in ('CANCELLED', 'FULLY_DISPATCHED', 'DRAFT') and (p_status is null or o.v2 = p_status)
          group by e ->> 'product_id', e ->> 'sku', e ->> 'unit'
          having sum((e ->> 'required')::numeric) - sum((e ->> 'reserved')::numeric) - max((e ->> 'available')::numeric) > 0) z),
      'recent', (select coalesce(jsonb_agg(r order by r ->> 'created_at' desc), '[]'::jsonb) from (
          select jsonb_build_object('id', id, 'sales_order_number', sales_order_number, 'order_date', order_date, 'customer_name', customer_name_snapshot,
            'grand_total', grand_total, 'status', v2, 'created_at', created_at) as r
          from f order by created_at desc limit 10) z)
    )
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 13. Excel import
-- p_rows: [{row_number, order_date, customer_name, customer_gstin, customer_reference,
--           sku, product_name, quantity, unit, selling_price, discount, gst_rate,
--           expected_delivery_date, remarks}] as text. Rows with the same customer
-- and Customer Reference form one order. Discount is a percentage.
-- -----------------------------------------------------------------------------
create or replace function private.so_import_check(p_company uuid, p_rows jsonb, p_warehouse uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row      jsonb;
  v_rows     jsonb := '[]'::jsonb;
  v_err      text[];
  v_warn     text[];
  v_customer public.customers;
  v_product  public.products;
  v_txt      text;
  v_date     date;
  v_exp      date;
  v_qty      numeric;
  v_price    numeric;
  v_disc     numeric;
  v_gst      numeric;
  v_ref      text;
  v_key      text;
  v_dup      text;
  v_groups   jsonb := '[]'::jsonb;
  v_g        record;
  v_used     jsonb := '{}'::jsonb;
  v_avail    numeric;
  v_line     jsonb;
  v_lines    jsonb;
  v_gwarn    text[];
  v_gerr     text[];
  v_total    numeric;
  v_n        int;
begin
  for v_row in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_err := '{}'; v_warn := '{}'; v_customer := null; v_product := null; v_date := null; v_exp := null;
    v_qty := null; v_price := null; v_disc := null; v_gst := null;
    v_ref := nullif(btrim(coalesce(v_row ->> 'customer_reference', '')), '');

    v_txt := nullif(btrim(coalesce(v_row ->> 'order_date', '')), '');
    if v_txt is null then
      v_err := v_err || 'Order Date is required.'::text;
    else
      begin
        if v_txt !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'bad'; end if;
        v_date := v_txt::date;
        if v_date > private.company_today(p_company) then v_err := v_err || 'Order Date cannot be in the future.'::text; end if;
      exception when others then v_err := v_err || format('Order Date "%s" is not a valid date (use YYYY-MM-DD).', left(v_txt, 30));
      end;
    end if;
    v_txt := nullif(btrim(coalesce(v_row ->> 'expected_delivery_date', '')), '');
    if v_txt is not null then
      begin
        if v_txt !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'bad'; end if;
        v_exp := v_txt::date;
        if v_date is not null and v_exp < v_date then v_err := v_err || 'Expected Delivery Date is before the Order Date.'::text; end if;
      exception when others then v_err := v_err || format('Expected Delivery Date "%s" is not a valid date.', left(v_txt, 30));
      end;
    end if;
    if v_ref is null then
      v_err := v_err || 'Customer Reference (the customer''s order number) is required to group rows into an order and to prevent duplicates.'::text;
    elsif length(v_ref) > 100 then
      v_err := v_err || 'Customer Reference is limited to 100 characters.'::text;
    end if;

    -- Customer: by GSTIN, else by name.
    v_txt := nullif(upper(btrim(coalesce(v_row ->> 'customer_gstin', ''))), '');
    if v_txt is not null then
      select * into v_customer from public.customers where company_id = p_company and upper(gstin) = v_txt and status = 'ACTIVE' limit 1;
    end if;
    if v_customer.id is null and nullif(btrim(coalesce(v_row ->> 'customer_name', '')), '') is not null then
      select * into v_customer from public.customers where company_id = p_company and status = 'ACTIVE'
        and (lower(customer_name) = lower(btrim(v_row ->> 'customer_name')) or lower(coalesce(legal_name, '')) = lower(btrim(v_row ->> 'customer_name')))
      order by customer_code limit 1;
      if v_customer.id is not null and v_txt is not null and v_customer.gstin is not null and upper(v_customer.gstin) <> v_txt then
        v_warn := v_warn || format('Customer %s matched by name, but its GSTIN differs from the file.', v_customer.customer_code);
      end if;
    end if;
    if v_customer.id is null then
      v_err := v_err || format('Customer "%s" was not found. Add it (Quick Add) and check the file again.',
        left(coalesce(nullif(btrim(v_row ->> 'customer_name'), ''), v_txt, '?'), 80));
    end if;

    -- Product by SKU.
    v_txt := nullif(btrim(coalesce(v_row ->> 'sku', '')), '');
    if v_txt is null then
      v_err := v_err || 'Product SKU is required.'::text;
    else
      select * into v_product from public.products where company_id = p_company and lower(sku) = lower(v_txt) and archived_at is null;
      if v_product.id is null then
        v_err := v_err || format('Product SKU "%s" was not found. Add the product (Quick Add) and check the file again.', left(v_txt, 60));
      elsif v_product.status <> 'ACTIVE' then
        v_err := v_err || format('%s is inactive.', v_product.sku);
      else
        if nullif(btrim(coalesce(v_row ->> 'product_name', '')), '') is not null and lower(btrim(v_row ->> 'product_name')) <> lower(v_product.product_name) then
          v_warn := v_warn || format('Product name in the file differs from %s (%s); the SKU is used.', v_product.sku, v_product.product_name);
        end if;
        if nullif(btrim(coalesce(v_row ->> 'unit', '')), '') is not null and upper(btrim(v_row ->> 'unit')) <> v_product.base_unit then
          v_err := v_err || format('Unit %s does not match the unit of %s (%s).', upper(btrim(v_row ->> 'unit')), v_product.sku, v_product.base_unit);
        end if;
      end if;
    end if;

    begin
      v_qty := nullif(btrim(coalesce(v_row ->> 'quantity', '')), '')::numeric;
    exception when others then v_err := v_err || format('Quantity "%s" is not a number.', left(v_row ->> 'quantity', 30));
    end;
    if v_qty is null and not exists (select 1 from unnest(v_err) e where e like 'Quantity%') then
      v_err := v_err || 'Quantity is required.'::text;
    elsif v_qty is not null and (v_qty <= 0 or v_qty <> round(v_qty, 3)) then
      v_err := v_err || 'Quantity must be greater than zero (up to 3 decimals).'::text;
    elsif v_qty is not null and v_product.id is not null and private.is_whole_unit(v_product.base_unit) and v_qty <> trunc(v_qty) then
      v_err := v_err || format('%s is counted in whole pieces (%s).', v_product.sku, v_product.base_unit);
    end if;
    begin
      v_price := nullif(btrim(coalesce(v_row ->> 'selling_price', '')), '')::numeric;
    exception when others then v_err := v_err || format('Selling Price "%s" is not a number.', left(v_row ->> 'selling_price', 30));
    end;
    if v_price is not null and v_price < 0 then
      v_err := v_err || 'Selling Price cannot be negative.'::text;
    elsif v_price is null and v_product.id is not null then
      v_price := v_product.selling_price;
      v_warn := v_warn || case when v_price is null then format('No selling price for %s: the line is valued at 0.', v_product.sku)
                                else format('Selling Price taken from the Product Master (%s).', trim_scale(v_price)) end;
    end if;
    begin
      v_disc := nullif(btrim(replace(coalesce(v_row ->> 'discount', ''), '%', '')), '')::numeric;
    exception when others then v_err := v_err || format('Discount "%s" is not a number (enter a percentage).', left(v_row ->> 'discount', 30));
    end;
    if v_disc is not null and (v_disc < 0 or v_disc > 100) then
      v_err := v_err || 'Discount must be a percentage between 0 and 100.'::text;
    end if;
    begin
      v_gst := nullif(btrim(replace(coalesce(v_row ->> 'gst_rate', ''), '%', '')), '')::numeric;
    exception when others then v_err := v_err || format('GST Rate "%s" is not a number.', left(v_row ->> 'gst_rate', 30));
    end;
    if v_gst is not null and (v_gst < 0 or v_gst > 100) then
      v_err := v_err || 'GST Rate must be between 0 and 100.'::text;
    elsif v_gst is null and v_product.id is not null then
      v_gst := v_product.gst_rate;
    end if;
    if length(coalesce(v_row ->> 'remarks', '')) > 2000 then
      v_err := v_err || 'Remarks are limited to 2000 characters.'::text;
    end if;

    v_rows := v_rows || jsonb_build_object('row_number', (v_row ->> 'row_number')::int, 'errors', to_jsonb(v_err), 'warnings', to_jsonb(v_warn),
      'group_key', coalesce(v_customer.id::text, lower(coalesce(v_row ->> 'customer_name', ''))) || '|' || lower(coalesce(v_ref, '#' || (v_row ->> 'row_number'))),
      'customer_id', v_customer.id, 'customer_name', coalesce(v_customer.customer_name, v_row ->> 'customer_name'), 'customer_code', v_customer.customer_code,
      'customer_reference', v_ref, 'order_date', v_date, 'expected_delivery_date', v_exp, 'remarks', nullif(btrim(coalesce(v_row ->> 'remarks', '')), ''),
      'product_id', v_product.id, 'sku', coalesce(v_product.sku, v_row ->> 'sku'), 'product_name', coalesce(v_product.product_name, v_row ->> 'product_name'),
      'unit', v_product.base_unit, 'quantity', v_qty, 'unit_price', v_price, 'discount_percent', v_disc, 'gst_rate', v_gst,
      'line_total', case when v_qty is not null then round(round(v_qty * coalesce(v_price, 0), 2) * (1 - coalesce(v_disc, 0) / 100) * (1 + coalesce(v_gst, 0) / 100), 2) end);
  end loop;

  -- Orders: rows grouped by customer + reference; an order is imported only when all its rows are valid.
  for v_g in
    select r ->> 'group_key' as k, min((r ->> 'row_number')::int) as first_row, jsonb_agg(r order by (r ->> 'row_number')::int) as rs
    from jsonb_array_elements(v_rows) r group by r ->> 'group_key' order by min((r ->> 'row_number')::int)
  loop
    v_gerr := '{}'; v_gwarn := '{}'; v_lines := '[]'::jsonb; v_total := 0;
    select count(distinct r ->> 'order_date') into v_n from jsonb_array_elements(v_g.rs) r where r ->> 'order_date' is not null;
    if v_n > 1 then
      v_gwarn := v_gwarn || 'Rows of this order have different Order Dates; the first one is used.'::text;
    end if;
    if exists (select 1 from jsonb_array_elements(v_g.rs) r where jsonb_array_length(r -> 'errors') > 0) then
      v_gerr := v_gerr || format('%s row(s) of this order have errors, so the order is held back.', (select count(*) from jsonb_array_elements(v_g.rs) r where jsonb_array_length(r -> 'errors') > 0));
    end if;
    -- Duplicate: an existing order of the customer with the same reference.
    select string_agg(sales_order_number, ', ') into v_dup from public.sales_orders
    where company_id = p_company and order_status <> 'CANCELLED' and customer_id = nullif(v_g.rs -> 0 ->> 'customer_id', '')::uuid
      and lower(coalesce(customer_po_number, '')) = lower(coalesce(v_g.rs -> 0 ->> 'customer_reference', '~'));
    if v_dup is not null then
      v_gerr := v_gerr || format('Already imported: %s exists for this customer with reference %s (not imported again).', v_dup, v_g.rs -> 0 ->> 'customer_reference');
    end if;
    -- Finished goods available (counted down the file) and what will need production.
    for v_line in select value from jsonb_array_elements(v_g.rs) loop
      if nullif(v_line ->> 'product_id', '') is not null and (v_line ->> 'quantity') is not null then
        v_avail := greatest((select coalesce(sum(s.available), 0) from private.po_eligible_stock(p_company, (v_line ->> 'product_id')::uuid, p_warehouse) s where s.eligible)
                   - coalesce((v_used ->> (v_line ->> 'product_id'))::numeric, 0), 0);
        if cardinality(v_gerr) = 0 then
          v_used := v_used || jsonb_build_object(v_line ->> 'product_id', coalesce((v_used ->> (v_line ->> 'product_id'))::numeric, 0) + least(v_avail, (v_line ->> 'quantity')::numeric));
        end if;
        if (v_line ->> 'quantity')::numeric > v_avail then
          v_gwarn := v_gwarn || format('%s: %s %s in stock for this order, %s %s to produce.', v_line ->> 'sku', trim_scale(least(v_avail, (v_line ->> 'quantity')::numeric)),
            v_line ->> 'unit', trim_scale((v_line ->> 'quantity')::numeric - v_avail), v_line ->> 'unit');
        end if;
        v_lines := v_lines || (v_line || jsonb_build_object('available', v_avail));
        v_total := v_total + coalesce((v_line ->> 'line_total')::numeric, 0);
      else
        v_lines := v_lines || v_line;
      end if;
    end loop;
    v_groups := v_groups || jsonb_build_object('group_key', v_g.k, 'first_row', v_g.first_row,
      'status', case when cardinality(v_gerr) > 0 then 'ERROR' when cardinality(v_gwarn) > 0 or exists (select 1 from jsonb_array_elements(v_g.rs) r where jsonb_array_length(r -> 'warnings') > 0) then 'WARNING' else 'VALID' end,
      'errors', to_jsonb(v_gerr), 'warnings', to_jsonb(v_gwarn),
      'customer_id', v_g.rs -> 0 -> 'customer_id', 'customer_name', v_g.rs -> 0 -> 'customer_name', 'customer_code', v_g.rs -> 0 -> 'customer_code',
      'customer_reference', v_g.rs -> 0 -> 'customer_reference', 'order_date', v_g.rs -> 0 -> 'order_date',
      'expected_delivery_date', v_g.rs -> 0 -> 'expected_delivery_date', 'remarks', v_g.rs -> 0 -> 'remarks',
      'estimated_total', v_total, 'rows', v_lines);
  end loop;
  return v_groups;
end;
$$;

revoke all on function private.so_import_check(uuid, jsonb, uuid) from public, anon, authenticated;

create or replace function public.sales_order_import_preview(p_rows jsonb, p_warehouse_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('sales_orders.create');
  v_groups  jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The file has no data rows.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'Import at most 2000 rows per file.' using errcode = 'P0001';
  end if;
  perform private.so_check_warehouse(v_company, p_warehouse_id);
  v_groups := private.so_import_check(v_company, p_rows, p_warehouse_id);
  return jsonb_build_object('orders', v_groups, 'rows', jsonb_array_length(p_rows),
    'valid', (select count(*) from jsonb_array_elements(v_groups) g where g ->> 'status' = 'VALID'),
    'warnings', (select count(*) from jsonb_array_elements(v_groups) g where g ->> 'status' = 'WARNING'),
    'errors', (select count(*) from jsonb_array_elements(v_groups) g where g ->> 'status' = 'ERROR'),
    'missing_customers', coalesce((select jsonb_agg(distinct jsonb_build_object('name', r ->> 'customer_name'))
       from jsonb_array_elements(v_groups) g cross join jsonb_array_elements(g -> 'rows') r where r ->> 'customer_id' is null and coalesce(r ->> 'customer_name', '') <> ''), '[]'::jsonb),
    'missing_products', coalesce((select jsonb_agg(distinct jsonb_build_object('sku', r ->> 'sku', 'name', r ->> 'product_name'))
       from jsonb_array_elements(v_groups) g cross join jsonb_array_elements(g -> 'rows') r where r ->> 'product_id' is null and coalesce(r ->> 'sku', '') <> ''), '[]'::jsonb));
end;
$$;

create or replace function public.sales_order_import(p_rows jsonb, p_warehouse_id uuid, p_file jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('sales_orders.create');
  v_prev    jsonb;
  v_groups  jsonb;
  v_g       jsonb;
  v_res     jsonb;
  v_created jsonb := '[]'::jsonb;
  v_failed  jsonb := '[]'::jsonb;
  v_hist    jsonb := '[]'::jsonb;
  v_file    jsonb := coalesce(p_file, '{}'::jsonb);
  v_hash    text := nullif(v_file ->> 'file_hash', '');
  v_ok_rows int := 0;
  v_bad_rows int := 0;
  v_job     public.import_jobs;
  v_msgs    jsonb;
begin
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'sales_order_import');
  if v_prev is not null then return v_prev; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The file has no data rows.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'Import at most 2000 rows per file.' using errcode = 'P0001';
  end if;
  if v_hash is not null and v_hash !~ '^[0-9a-f]{64}$' then v_hash := null; end if;
  perform private.so_check_warehouse(v_company, p_warehouse_id);
  -- Re-validated here; the preview is never trusted.
  v_groups := private.so_import_check(v_company, p_rows, p_warehouse_id);
  for v_g in select value from jsonb_array_elements(v_groups) loop
    if v_g ->> 'status' = 'ERROR' then
      v_msgs := v_g -> 'errors';
    else
      begin
        v_res := public.sales_order_v2_save(null,
          jsonb_build_object('customer_id', v_g ->> 'customer_id', 'order_date', v_g ->> 'order_date', 'customer_po_number', v_g ->> 'customer_reference',
            'customer_reference', v_g ->> 'customer_reference', 'requested_delivery_date', v_g ->> 'expected_delivery_date',
            'internal_notes', coalesce(v_g ->> 'remarks', 'Imported from ' || coalesce(v_file ->> 'file_name', 'a spreadsheet')), 'warehouse_id', p_warehouse_id),
          (select jsonb_agg(jsonb_build_object('product_id', r ->> 'product_id', 'quantity', r ->> 'quantity', 'unit_price', r ->> 'unit_price',
             'discount_percent', r ->> 'discount_percent', 'gst_rate', r ->> 'gst_rate') order by (r ->> 'row_number')::int) from jsonb_array_elements(v_g -> 'rows') r),
          gen_random_uuid());
        v_created := v_created || jsonb_build_object('first_row', v_g -> 'first_row', 'customer_reference', v_g -> 'customer_reference',
          'sales_order_id', v_res -> 'sales_order_id', 'sales_order_number', v_res -> 'sales_order_number', 'status', v_res -> 'status',
          'grand_total', v_res -> 'grand_total', 'rows', (select jsonb_agg(r -> 'row_number') from jsonb_array_elements(v_g -> 'rows') r));
        v_ok_rows := v_ok_rows + jsonb_array_length(v_g -> 'rows');
        continue;
      exception when others then
        v_msgs := jsonb_build_array(sqlerrm);
      end;
    end if;
    v_failed := v_failed || jsonb_build_object('first_row', v_g -> 'first_row', 'customer_reference', v_g -> 'customer_reference', 'messages', v_msgs,
      'rows', (select jsonb_agg(r -> 'row_number') from jsonb_array_elements(v_g -> 'rows') r));
    v_bad_rows := v_bad_rows + jsonb_array_length(v_g -> 'rows');
    v_hist := v_hist || coalesce((select jsonb_agg(jsonb_build_object('row_number', r -> 'row_number', 'outcome', 'FAILED',
        'reference', left(coalesce(v_g ->> 'customer_reference', '') || ' / ' || coalesce(r ->> 'sku', ''), 200),
        'messages', (r -> 'errors') || v_msgs)) from jsonb_array_elements(v_g -> 'rows') r), '[]'::jsonb);
  end loop;

  v_job := private.import_job_write(v_company, auth.uid(), jsonb_build_object(
    'import_type', 'SALES_ORDER', 'client_job_key', p_idempotency_key, 'file_name', left(v_file ->> 'file_name', 255), 'file_hash', v_hash,
    'status', case when jsonb_array_length(v_created) = 0 then 'FAILED' end,
    'total_rows', jsonb_array_length(p_rows), 'success_rows', v_ok_rows, 'failed_rows', v_bad_rows,
    'notes', format('%s sales order(s) created, %s order(s) not imported.', jsonb_array_length(v_created), jsonb_array_length(v_failed))), v_hist);
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('job_id', v_job.id, 'created', v_created, 'failed', v_failed,
    'created_count', jsonb_array_length(v_created), 'failed_count', jsonb_array_length(v_failed), 'imported_rows', v_ok_rows, 'failed_rows', v_bad_rows));
end;
$$;

-- -----------------------------------------------------------------------------
-- 14. Grants
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.sales_order_v2_save(uuid, jsonb, jsonb, uuid)',
    'public.sales_order_v2_reserve(uuid)',
    'public.sales_order_v2_release(uuid, text)',
    'public.sales_order_v2_summary(uuid)',
    'public.sales_order_v2_create_production(uuid, uuid, uuid)',
    'public.sales_order_v2_dispatch(uuid, jsonb, jsonb, uuid)',
    'public.sales_order_v2_reverse_dispatch(uuid, text, uuid)',
    'public.sales_order_v2_cancel(uuid, text, uuid)',
    'public.sales_orders_v2_list(date, date, uuid, text)',
    'public.sales_dashboard(date, date, uuid, text)',
    'public.sales_order_import_preview(jsonb, uuid)',
    'public.sales_order_import(jsonb, uuid, jsonb, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
