-- =============================================================================
-- ROLLBACK of 20261029090000_whole_piece_quantities.sql  (manual use only)
--
-- Restores the previous behaviour exactly: the four planning / reservation
-- functions are copied verbatim from 20261013090200_production_boms.sql and
-- 20261013090300_production_orders.sql, and every whole-piece trigger and
-- function added by the migration is dropped.
--
-- WARNING: after this, fractional PCS quantities are accepted again (the
-- original defect). It changes NO data: nothing posted while the migration was
-- active is altered or removed. Run in one transaction (SQL Editor runs the
-- whole script as one) and only after taking a backup.
-- Not in supabase/migrations on purpose, so it is never applied automatically.
-- =============================================================================

begin;

-- 1. Previous function definitions (verbatim)
create or replace function private.bom_requirement_lines(p_bom_id uuid, p_quantity numeric)
returns table (
  line_no int, component_product_id uuid, sku text, product_name text, product_type text, unit text, inventory_unit text,
  component_active boolean, quantity_per_unit numeric, wastage_percentage numeric,
  base_requirement numeric, wastage_allowance numeric, total_requirement numeric, unit_matches boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select bi.line_no, p.id, p.sku, p.product_name, p.product_type, bi.unit, p.base_unit,
    (p.status = 'ACTIVE' and p.archived_at is null),
    round(bi.quantity_required / b.output_quantity, 6),
    bi.wastage_percentage,
    private.ceil_qty(bi.quantity_required / b.output_quantity * p_quantity),
    private.ceil_qty(bi.quantity_required / b.output_quantity * p_quantity * (1 + bi.wastage_percentage / 100))
      - private.ceil_qty(bi.quantity_required / b.output_quantity * p_quantity),
    private.ceil_qty(bi.quantity_required / b.output_quantity * p_quantity * (1 + bi.wastage_percentage / 100)),
    bi.unit = p.base_unit
  from public.boms b
  join public.bom_items bi on bi.bom_id = b.id
  join public.products p on p.id = bi.component_product_id
  where b.id = p_bom_id
  order by bi.line_no;
$$;

revoke all on function private.bom_requirement_lines(uuid, numeric) from public, anon, authenticated;
comment on function private.bom_requirement_lines(uuid, numeric) is null;

create or replace function public.production_bom_requirements(p_bom_id uuid, p_quantity numeric, p_warehouse_id uuid default null)
returns table (
  line_no int, component_product_id uuid, sku text, product_name text, product_type text, unit text, inventory_unit text,
  quantity_per_unit numeric, wastage_percentage numeric, base_requirement numeric, wastage_allowance numeric,
  total_requirement numeric, on_hand numeric, reserved numeric, available numeric, shortage numeric,
  suggested_quantity numeric, reorder_level numeric, line_status text, message text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['production_plan.create', 'production_bom.read', 'manufacturing.read']);
begin
  if not exists (select 1 from public.boms where id = p_bom_id and company_id = v_company) then
    raise exception 'BOM not found in your company.' using errcode = 'P0001';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity <> round(p_quantity, 3) then
    raise exception 'Enter a planned quantity greater than zero (up to 3 decimals).' using errcode = 'P0001';
  end if;
  if p_warehouse_id is not null and not exists (select 1 from public.warehouses where id = p_warehouse_id and company_id = v_company) then
    raise exception 'Warehouse not found in your company.' using errcode = 'P0001';
  end if;
  return query
  select r.line_no, r.component_product_id, r.sku, r.product_name, r.product_type, r.unit, r.inventory_unit,
    r.quantity_per_unit, r.wastage_percentage, r.base_requirement, r.wastage_allowance, r.total_requirement,
    s.on_hand, s.reserved,
    case when r.unit_matches then s.available end,
    case when r.unit_matches then greatest(r.total_requirement - s.available, 0) end,
    case when r.unit_matches then greatest(r.total_requirement + coalesce(p.reorder_level, 0) - s.available,
                                           greatest(r.total_requirement - s.available, 0)) end,
    p.reorder_level,
    case
      when not r.unit_matches then 'UNIT_MISMATCH'
      when not r.component_active then 'INACTIVE'
      when s.available >= r.total_requirement then 'SUFFICIENT'
      when s.available > 0 then 'PARTIAL'
      else 'SHORTAGE'
    end,
    case
      when not r.unit_matches then format('BOM unit %s differs from inventory unit %s; no conversion is configured, so availability is not calculated.', r.unit, r.inventory_unit)
      when not r.component_active then 'Component is inactive or archived.'
      when s.available >= r.total_requirement then null
      when s.available > 0 then 'Only part of the requirement is available.'
      else 'No usable stock available.'
    end
  from private.bom_requirement_lines(p_bom_id, p_quantity) r
  join public.products p on p.id = r.component_product_id
  cross join lateral private.storage_stock(v_company, r.component_product_id, p_warehouse_id) s
  order by r.line_no;
end;
$$;

create or replace function private.production_discrepancies(p_order public.production_orders)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(d), '[]'::jsonb) from (
    select jsonb_build_object('type', 'OUTPUT_SHORT', 'planned', p_order.planned_quantity, 'actual', p_order.actual_quantity) as d
    where p_order.actual_quantity < p_order.planned_quantity
    union all
    select jsonb_build_object('type', 'MATERIAL_UNDER_ISSUED', 'sku', p.sku, 'issued', m.issued_quantity,
      'expected', private.ceil_qty(m.quantity_per_unit * p_order.actual_quantity), 'unit', m.unit)
    from public.production_order_materials m
    join public.products p on p.id = m.component_product_id
    where m.production_order_id = p_order.id
      and m.issued_quantity < private.ceil_qty(m.quantity_per_unit * p_order.actual_quantity)
  ) x;
$$;

revoke all on function private.production_discrepancies(public.production_orders) from public, anon, authenticated;

create or replace function public.production_reserve_materials(
  p_order_id        uuid,
  p_allow_partial   boolean default false,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_permission('production_material.reserve');
  v_today     date := private.company_today(v_company);
  v_previous  jsonb;
  v_order     public.production_orders;
  v_line      record;
  v_bal       record;
  v_need      numeric;
  v_take      numeric;
  v_created   jsonb := '[]'::jsonb;
  v_short     jsonb := '[]'::jsonb;
  v_number    text;
  v_complete  boolean;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'production_reserve');
  if v_previous is not null then return v_previous; end if;

  select * into v_order from public.production_orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Production order not found in your company.' using errcode = 'P0001';
  end if;
  if v_order.status not in ('APPROVED', 'MATERIALS_RESERVED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED') then
    raise exception 'Materials can only be reserved for approved orders (order is %).', v_order.status using errcode = 'P0001';
  end if;

  for v_line in
    select m.*, p.sku, p.base_unit, p.status as product_status, p.archived_at
    from public.production_order_materials m join public.products p on p.id = m.component_product_id
    where m.production_order_id = v_order.id
    order by m.line_no
    for update of m
  loop
    v_need := v_line.planned_quantity - v_line.issued_quantity - private.order_open_reserved(v_order.id, v_line.component_product_id);
    continue when v_need <= 0;
    if v_line.unit <> v_line.base_unit then
      raise exception '%: BOM unit % differs from inventory unit %; materials cannot be reserved.', v_line.sku, v_line.unit, v_line.base_unit
        using errcode = 'P0001';
    end if;

    for v_bal in
      select b.id, b.batch_id, b.location_id, b.warehouse_id, b.on_hand, b.reserved
      from public.inventory_balances b
      join public.inventory_locations l on l.id = b.location_id and l.stock_usage = 'STORAGE' and l.status = 'ACTIVE'
      join public.inventory_batches bt on bt.id = b.batch_id
      where b.company_id = v_company and b.product_id = v_line.component_product_id
        and b.warehouse_id = v_order.source_warehouse_id and b.on_hand - b.reserved > 0
        and (bt.expiry_date is null or bt.expiry_date >= v_today)
      order by bt.expiry_date nulls last, bt.created_at, b.location_id
      for update of b
    loop
      v_take := least(v_need, v_bal.on_hand - v_bal.reserved);
      continue when v_take <= 0;
      update public.inventory_balances set reserved = reserved + v_take, updated_at = now() where id = v_bal.id;
      v_number := private.next_document_number(v_company, 'RES');
      insert into public.stock_reservations (company_id, reservation_number, product_id, batch_id, warehouse_id, location_id,
        quantity, reference_type, reference_number, reference_id, notes, reserved_by)
      values (v_company, v_number, v_line.component_product_id, v_bal.batch_id, v_bal.warehouse_id, v_bal.location_id, v_take,
        'PRODUCTION_ORDER', v_order.production_order_number, v_order.id, 'Material for ' || v_order.production_order_number, auth.uid());
      v_created := v_created || jsonb_build_object('reservation_number', v_number, 'sku', v_line.sku, 'quantity', v_take);
      v_need := v_need - v_take;
      exit when v_need = 0;
    end loop;

    if v_need > 0 then
      v_short := v_short || jsonb_build_object('sku', v_line.sku, 'short', v_need, 'unit', v_line.unit);
    end if;
  end loop;

  if jsonb_array_length(v_short) > 0 and not coalesce(p_allow_partial, false) then
    raise exception 'Not enough usable stock to reserve: %. Nothing was reserved.',
      (select string_agg(format('%s short by %s %s', s ->> 'sku', s ->> 'short', s ->> 'unit'), '; ') from jsonb_array_elements(v_short) s)
      using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_created) = 0 and jsonb_array_length(v_short) = 0 then
    raise exception 'All materials for this order are already reserved or issued.' using errcode = 'P0001';
  end if;

  v_complete := jsonb_array_length(v_short) = 0;
  if v_order.status = 'APPROVED' and v_complete then
    update public.production_orders set status = 'MATERIALS_RESERVED' where id = v_order.id;
  end if;
  perform private.log_production_event(v_company, v_order.id, 'MATERIALS_RESERVED', v_order.status,
    case when v_order.status = 'APPROVED' and v_complete then 'MATERIALS_RESERVED' else v_order.status end, null,
    jsonb_build_object('reservations', v_created, 'shortages', v_short));

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'reservations', v_created, 'shortages', v_short, 'fully_reserved', v_complete,
    'status', (select status from public.production_orders where id = v_order.id)));
end;
$$;

-- 2. Remove the guards
drop trigger if exists inventory_transactions_whole_pieces on public.inventory_transactions;
drop trigger if exists boms_whole_pieces on public.boms;
do $$
declare
  t text;
begin
  foreach t in array array['production_orders', 'production_order_materials', 'production_material_consumption', 'production_output_receipts',
    'outsourcing_orders', 'outsourcing_order_materials', 'outsourcing_receipts', 'outsourcing_material_movements', 'stock_reservations',
    'inventory_adjustments', 'inventory_count_lines', 'purchase_order_lines', 'goods_receipt_lines'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists %I on public.%I', t || '_whole_pieces', t);
    end if;
  end loop;
end;
$$;

-- 3. Remove the functions added by the migration
drop function if exists public.whole_unit_quantity_audit();
drop function if exists private.whole_unit_findings(uuid);
drop function if exists private.guard_whole_quantities();
drop function if exists private.guard_whole_ledger_quantity();
drop function if exists private.guard_bom_whole_quantities();
drop function if exists private.material_standard_for_output(public.production_orders, public.production_order_materials);
drop function if exists private.plan_qty(numeric, text);
drop function if exists private.is_whole_unit(text);
drop function if exists private.whole_unit_codes();

commit;
