-- =============================================================================
-- ALTON ERP V2 — Stage 4: simple production management
--
-- A one-screen production flow on top of the existing Phase 5 tables
-- (production_orders, production_order_materials, production_material_consumption,
-- production_output_receipts, production_order_events) and the stock ledger.
-- No new tables. The step-by-step functions (submit / approve / reserve / start /
-- issue / output / complete) are unchanged and still work.
--
--   production_v2_preview            requirements + availability for the entry form
--   production_order_v2_save         create or edit an order: active BOM, material
--                                    plan, opened in one step, available stock
--                                    reserved (shortages are warnings, never a block);
--                                    optionally completes it in the same transaction
--   production_order_v2_complete     records the ACTUAL consumption (this order's
--                                    reservations first, then free stock, earliest
--                                    expiry first), adds accepted goods to stock,
--                                    records rejected goods and wastage, releases
--                                    unused reservations; all or nothing
--   production_order_v2_correct      reverses every posting of a completed order
--                                    (reversal entries, history kept) and re-posts
--                                    the corrected production, or reopens the order
--   production_order_v2_requirements material lines with source, reserved, shortage
--   production_bom_add_components    adds missing components from the production
--                                    screen as a new active BOM version
--   production_dashboard             KPIs, shortages and recent activity
--   production_import_preview / production_import
--                                    Excel upload: SKU match, active BOM, requirements,
--                                    availability, row errors; recorded in Bulk Operations
--
-- Stock changes only on completion, through private.post_movement. Completion is
-- refused once (status COMPLETED) and by request id, so stock is never deducted twice.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Bulk Operations knows production imports
-- -----------------------------------------------------------------------------
alter table public.import_jobs drop constraint if exists import_jobs_import_type_check;
alter table public.import_jobs add constraint import_jobs_import_type_check
  check (import_type in ('PRODUCTS', 'OPENING_STOCK', 'CUSTOMER_PO', 'SUPPLIER_PO', 'BOMS', 'PRODUCTION'));

create or replace function private.import_permission(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type when 'PRODUCTS' then 'products.import' when 'OPENING_STOCK' then 'inventory_opening.create'
    when 'CUSTOMER_PO' then 'customer_po.import' when 'SUPPLIER_PO' then 'purchase_order.create'
    when 'BOMS' then 'production_bom.create' when 'PRODUCTION' then 'production_order.create' end;
$$;

revoke all on function private.import_permission(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Helpers
-- -----------------------------------------------------------------------------

-- The BOM version in force today for a product (newest approved, effective today).
create or replace function private.production_v2_active_bom(p_company uuid, p_product uuid)
returns public.boms
language sql
stable
security definer
set search_path = ''
as $$
  select b.* from public.boms b
  where b.company_id = p_company and b.finished_product_id = p_product and b.status = 'APPROVED'
    and b.effective_from <= private.company_today(p_company)
    and (b.effective_to is null or b.effective_to >= private.company_today(p_company))
  order by b.version desc
  limit 1;
$$;

revoke all on function private.production_v2_active_bom(uuid, uuid) from public, anon, authenticated;

-- Default storage location of a warehouse (its default location, else the first active storage one).
create or replace function private.production_v2_default_location(p_warehouse uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select l.id from public.inventory_locations l
  where l.warehouse_id = p_warehouse and l.stock_usage = 'STORAGE' and l.status = 'ACTIVE'
  order by l.is_default desc, l.location_code
  limit 1;
$$;

revoke all on function private.production_v2_default_location(uuid) from public, anon, authenticated;

-- Material plan of an order re-synced from its BOM version and planned quantity.
-- Lines that already have posting history are kept (never deleted).
create or replace function private.production_v2_snapshot(p_order public.production_orders)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.production_order_materials (company_id, production_order_id, line_no, component_product_id, unit,
    quantity_per_unit, wastage_percentage, base_quantity, planned_quantity)
  select p_order.company_id, p_order.id, r.line_no, r.component_product_id, r.unit, r.quantity_per_unit, r.wastage_percentage,
    r.base_requirement, r.total_requirement
  from private.bom_requirement_lines(p_order.bom_id, p_order.planned_quantity) r
  on conflict (production_order_id, component_product_id) do update
  set line_no = excluded.line_no, unit = excluded.unit, quantity_per_unit = excluded.quantity_per_unit,
      wastage_percentage = excluded.wastage_percentage, base_quantity = excluded.base_quantity, planned_quantity = excluded.planned_quantity;

  delete from public.production_order_materials m
  where m.production_order_id = p_order.id
    and m.component_product_id not in (select r.component_product_id from private.bom_requirement_lines(p_order.bom_id, p_order.planned_quantity) r)
    and not exists (select 1 from public.production_material_consumption c where c.order_material_id = m.id);
end;
$$;

revoke all on function private.production_v2_snapshot(public.production_orders) from public, anon, authenticated;

-- Material lines of an order: required, issued, reserved for the order, free stock
-- in the production location, shortage, unit and how the component is obtained.
create or replace function private.production_v2_requirements(p_order uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'order_material_id', m.id, 'line_no', m.line_no, 'component_product_id', m.component_product_id,
    'sku', p.sku, 'product_name', p.product_name, 'product_type', p.product_type,
    'source_type', coalesce(bi.source_type, private.default_bom_source(p)),
    'unit', m.unit, 'quantity_per_unit', m.quantity_per_unit, 'wastage_percentage', m.wastage_percentage,
    'base_quantity', m.base_quantity, 'required', m.planned_quantity, 'issued', m.issued_quantity,
    'reserved', r.qty, 'available', s.available,
    'shortage', case when o.status in ('COMPLETED', 'CANCELLED') then 0
                     else greatest(m.planned_quantity - m.issued_quantity - r.qty - s.available, 0) end
  ) order by m.line_no), '[]'::jsonb)
  from public.production_order_materials m
  join public.production_orders o on o.id = m.production_order_id
  join public.products p on p.id = m.component_product_id
  left join public.bom_items bi on bi.bom_id = o.bom_id and bi.component_product_id = m.component_product_id
  cross join lateral (select private.order_open_reserved(o.id, m.component_product_id) as qty) r
  cross join lateral private.storage_stock(o.company_id, m.component_product_id, o.source_warehouse_id) s
  where m.production_order_id = p_order;
$$;

revoke all on function private.production_v2_requirements(uuid) from public, anon, authenticated;

-- Shortage warnings with the quantity to purchase.
create or replace function private.production_v2_shortage_warnings(p_requirements jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(format('%s: short by %s %s. Purchase %s %s (only the stock available was reserved).',
    l ->> 'sku', trim_scale((l ->> 'shortage')::numeric), l ->> 'unit', trim_scale((l ->> 'shortage')::numeric), l ->> 'unit'))), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_requirements, '[]'::jsonb)) l
  where (l ->> 'shortage')::numeric > 0;
$$;

revoke all on function private.production_v2_shortage_warnings(jsonb) from public, anon, authenticated;

-- Opens a draft (one step) and reserves whatever usable stock is available.
-- Problems become warnings; nothing here can block saving the order.
create or replace function private.production_v2_open_and_reserve(p_company uuid, p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_warn   jsonb := '[]'::jsonb;
  v_status text;
begin
  select status into v_status from public.production_orders where id = p_order;
  if v_status in ('DRAFT', 'PENDING_APPROVAL') then
    if private.has_permission(p_company, 'production_order.approve') then
      begin
        perform public.production_order_release(p_order, null);
      exception when others then
        v_warn := v_warn || to_jsonb('Saved as a draft, not opened: ' || sqlerrm);
      end;
    else
      v_warn := v_warn || to_jsonb('Saved as a draft: a user who may approve production orders must open it.'::text);
    end if;
  end if;
  select status into v_status from public.production_orders where id = p_order;
  if v_status in ('APPROVED', 'MATERIALS_RESERVED', 'IN_PROGRESS') and private.has_permission(p_company, 'production_material.reserve') then
    begin
      perform public.production_reserve_materials(p_order, true, gen_random_uuid());
    exception when others then
      if sqlerrm not ilike 'All materials for this order are already%' then
        v_warn := v_warn || to_jsonb('Materials were not reserved: ' || sqlerrm);
      end if;
    end;
  end if;
  return v_warn;
end;
$$;

revoke all on function private.production_v2_open_and_reserve(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Requirements preview for the entry form (never reserves or moves stock)
-- -----------------------------------------------------------------------------
create or replace function public.production_v2_preview(p_product_id uuid, p_quantity numeric default null, p_warehouse_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['manufacturing.read', 'production_order.create']);
  v_product public.products;
  v_bom     public.boms;
  v_wh      uuid;
  v_lines   jsonb := '[]'::jsonb;
  v_warn    jsonb := '[]'::jsonb;
begin
  select * into v_product from public.products where id = p_product_id and company_id = v_company;
  if not found then
    raise exception 'Product not found in your company.' using errcode = 'P0001';
  end if;
  v_wh := coalesce(p_warehouse_id, (select id from public.warehouses where company_id = v_company and is_default and status = 'ACTIVE' limit 1));
  v_bom := private.production_v2_active_bom(v_company, v_product.id);
  if v_product.status <> 'ACTIVE' or v_product.archived_at is not null then
    v_warn := v_warn || to_jsonb(format('%s is inactive and cannot be produced.', v_product.sku));
  end if;
  if v_bom.id is null then
    v_warn := v_warn || to_jsonb(format('%s has no active BOM. Add its components below; they become BOM version %s.', v_product.sku,
      coalesce((select max(version) from public.boms where finished_product_id = v_product.id), 0) + 1));
  elsif p_quantity is not null and p_quantity > 0 then
    select coalesce(jsonb_agg(jsonb_build_object(
      'component_product_id', r.component_product_id, 'line_no', r.line_no, 'sku', r.sku, 'product_name', r.product_name,
      'product_type', r.product_type, 'source_type', coalesce(bi.source_type, private.default_bom_source(p)), 'unit', r.unit,
      'quantity_per_unit', r.quantity_per_unit, 'wastage_percentage', r.wastage_percentage,
      'base_quantity', r.base_requirement, 'required', r.total_requirement,
      'available', s.available, 'reserved', s.reserved, 'shortage', greatest(r.total_requirement - s.available, 0),
      'unit_matches', r.unit_matches, 'component_active', r.component_active
    ) order by r.line_no), '[]'::jsonb)
    into v_lines
    from private.bom_requirement_lines(v_bom.id, round(p_quantity, 3)) r
    join public.products p on p.id = r.component_product_id
    left join public.bom_items bi on bi.bom_id = v_bom.id and bi.component_product_id = r.component_product_id
    cross join lateral private.storage_stock(v_company, r.component_product_id, v_wh) s;
    v_warn := v_warn || private.production_v2_shortage_warnings(v_lines);
  end if;
  return jsonb_build_object(
    'product', jsonb_build_object('id', v_product.id, 'sku', v_product.sku, 'product_name', v_product.product_name, 'product_type', v_product.product_type,
      'unit', v_product.base_unit, 'track_batches', v_product.track_batches, 'track_expiry', v_product.track_expiry),
    'bom', case when v_bom.id is null then null else jsonb_build_object('id', v_bom.id, 'bom_code', v_bom.bom_code, 'version', v_bom.version,
      'output_quantity', v_bom.output_quantity, 'item_count', (select count(*) from public.bom_items where bom_id = v_bom.id)) end,
    'warehouse_id', v_wh, 'lines', v_lines, 'warnings', v_warn);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Posting a completed production (shared by complete, correct and import)
-- p_data: {production_date, actual_quantity, rejected_quantity, wastage_quantity,
--          remarks, batch_number?, expiry_date?, good_location_id?,
--          rejected_location_id? (null = rejected goods recorded only),
--          materials?: [{order_material_id, quantity}]  quantity consumed now;
--          a line not listed uses the standard for the produced quantity}
-- -----------------------------------------------------------------------------
create or replace function private.production_v2_post(p_company uuid, p_order_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_today     date := private.company_today(p_company);
  v_data      jsonb := coalesce(p_data, '{}'::jsonb);
  v_order     public.production_orders;
  v_product   public.products;
  v_date      date;
  v_actual    numeric;
  v_rej       numeric;
  v_waste     numeric;
  v_good      numeric;
  v_given     jsonb;
  v_m         record;
  v_qty       numeric;
  v_std       numeric;
  v_left      numeric;
  v_take      numeric;
  v_res       public.stock_reservations;
  v_bal       record;
  v_tx        uuid;
  v_lot_cost  numeric;
  v_cost      numeric := 0;
  v_cost_ok   boolean := true;
  v_short     jsonb := '[]'::jsonb;
  v_warn      jsonb := '[]'::jsonb;
  v_numbers   text[] := '{}';
  v_consumed  jsonb := '[]'::jsonb;
  v_note      text;
  v_ts        timestamptz;
  v_good_loc  public.inventory_locations;
  v_rej_loc   public.inventory_locations;
  v_batch     text;
  v_expiry    date;
  v_unit_cost numeric;
  v_lot       uuid;
  v_good_tx   uuid;
  v_rej_tx    uuid;
  v_number    text;
  v_receipt   uuid;
  v_released  numeric;
  v_from      text;
  v_rej_note  text;
begin
  select * into v_order from public.production_orders where id = p_order_id and company_id = p_company for update;
  if not found then
    raise exception 'Production order not found in your company.' using errcode = 'P0001';
  end if;
  if v_order.status in ('COMPLETED', 'CANCELLED', 'ON_HOLD') then
    raise exception 'A % production order cannot be completed.', lower(replace(v_order.status, '_', ' ')) using errcode = 'P0001';
  end if;
  v_from := v_order.status;

  begin
    v_date := coalesce(nullif(btrim(coalesce(v_data ->> 'production_date', '')), '')::date, v_today);
    v_actual := coalesce(nullif(btrim(coalesce(v_data ->> 'actual_quantity', '')), '')::numeric, 0);
    v_rej := coalesce(nullif(btrim(coalesce(v_data ->> 'rejected_quantity', '')), '')::numeric, 0);
    v_waste := coalesce(nullif(btrim(coalesce(v_data ->> 'wastage_quantity', '')), '')::numeric, 0);
    v_expiry := nullif(btrim(coalesce(v_data ->> 'expiry_date', '')), '')::date;
  exception when others then
    raise exception 'Production date and quantities must be valid (dates as YYYY-MM-DD, quantities as numbers).' using errcode = 'P0001';
  end;
  if v_date > v_today then
    raise exception 'The production date cannot be in the future.' using errcode = 'P0001';
  end if;
  if v_actual < 0 or v_rej < 0 or v_waste < 0 then
    raise exception 'Quantities cannot be negative.' using errcode = 'P0001';
  end if;
  if v_actual <> round(v_actual, 3) or v_rej <> round(v_rej, 3) or v_waste <> round(v_waste, 3) then
    raise exception 'Quantities support at most 3 decimal places.' using errcode = 'P0001';
  end if;
  if v_actual + v_waste = 0 then
    raise exception 'Enter the actual quantity produced.' using errcode = 'P0001';
  end if;
  if v_rej > v_actual then
    raise exception 'The rejected quantity (%) cannot be more than the actual quantity produced (%).', v_rej, v_actual using errcode = 'P0001';
  end if;
  if private.is_whole_unit(v_order.unit) and (v_actual <> trunc(v_actual) or v_rej <> trunc(v_rej) or v_waste <> trunc(v_waste)) then
    raise exception 'This product is counted in whole pieces (%): enter whole quantities.', v_order.unit using errcode = 'P0001';
  end if;
  v_good := v_actual - v_rej;
  v_note := nullif(btrim(coalesce(v_data ->> 'remarks', '')), '');
  if v_note is not null and length(v_note) > 1000 then
    raise exception 'Remarks are limited to 1000 characters.' using errcode = 'P0001';
  end if;
  v_given := v_data -> 'materials';
  if v_given is not null and jsonb_typeof(v_given) not in ('array', 'null') then
    raise exception 'Material consumption must be a list.' using errcode = 'P0001';
  end if;
  v_product := private.require_active_product(p_company, v_order.finished_product_id);
  v_ts := private.effective_timestamp(p_company, v_date);

  -- Open and start the order if needed (single operator: no separate steps).
  if v_order.status in ('DRAFT', 'PENDING_APPROVAL') then
    perform public.production_order_release(v_order.id, null);
    select * into v_order from public.production_orders where id = v_order.id for update;
  end if;
  if v_order.status in ('APPROVED', 'MATERIALS_RESERVED') then
    update public.production_orders set status = 'IN_PROGRESS', actual_start_date = v_date, started_by = auth.uid() where id = v_order.id;
    perform private.log_production_event(p_company, v_order.id, 'START', v_order.status, 'IN_PROGRESS', null, '{}'::jsonb);
  elsif v_order.status not in ('IN_PROGRESS', 'PARTIALLY_COMPLETED') then
    raise exception 'A % production order cannot be completed.', lower(replace(v_order.status, '_', ' ')) using errcode = 'P0001';
  end if;

  -- Material consumption: actual quantities, never the plan.
  for v_m in
    select m.*, p.sku, p.base_unit, p.standard_cost
    from public.production_order_materials m join public.products p on p.id = m.component_product_id
    where m.production_order_id = v_order.id
    order by m.line_no
    for update of m
  loop
    v_std := coalesce((select r.total_requirement from private.bom_requirement_lines(v_order.bom_id, v_actual + v_waste) r
                       where r.component_product_id = v_m.component_product_id), 0);
    v_qty := null;
    if jsonb_typeof(v_given) = 'array' then
      begin
        select nullif(btrim(coalesce(e ->> 'quantity', '')), '')::numeric into v_qty
        from jsonb_array_elements(v_given) e where e ->> 'order_material_id' = v_m.id::text limit 1;
        if not found then v_qty := null; end if;
      exception when others then
        raise exception '%: the quantity consumed must be a number.', v_m.sku using errcode = 'P0001';
      end;
    end if;
    v_qty := coalesce(v_qty, greatest(v_std - v_m.issued_quantity, 0));
    if v_qty < 0 or v_qty <> round(v_qty, 3) then
      raise exception '%: enter a quantity of zero or more (up to 3 decimals).', v_m.sku using errcode = 'P0001';
    end if;
    if private.is_whole_unit(v_m.unit) and v_qty <> trunc(v_qty) then
      raise exception '%: % is counted in whole pieces.', v_m.sku, v_m.unit using errcode = 'P0001';
    end if;
    if v_qty > 0 and v_m.unit <> v_m.base_unit then
      raise exception '%: BOM unit % differs from inventory unit %; it cannot be consumed.', v_m.sku, v_m.unit, v_m.base_unit using errcode = 'P0001';
    end if;

    v_left := v_qty;
    -- 1. this order's reservations first
    if v_left > 0 then
      for v_res in
        select * from public.stock_reservations
        where company_id = p_company and reference_type = 'PRODUCTION_ORDER' and reference_id = v_order.id
          and product_id = v_m.component_product_id and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
        order by reserved_at, id
        for update
      loop
        v_take := least(v_left, v_res.quantity - v_res.fulfilled_quantity - v_res.released_quantity);
        continue when v_take <= 0;
        v_tx := private.post_movement(p_company, 'PRODUCTION_ISSUE', v_res.batch_id, v_res.location_id, v_take, null,
          'PRODUCTION_ORDER', v_order.production_order_number, v_order.id,
          'Consumed in production ' || v_order.production_order_number, v_note, v_ts, 'PRODUCTION', v_order.id, null, null, null, v_take);
        update public.stock_reservations
        set fulfilled_quantity = fulfilled_quantity + v_take,
            reservation_status = case when quantity - fulfilled_quantity - v_take - released_quantity = 0 then 'FULFILLED' else 'PARTIALLY_FULFILLED' end,
            updated_at = now()
        where id = v_res.id;
        insert into public.production_material_consumption (company_id, production_order_id, order_material_id, component_product_id,
          batch_id, warehouse_id, location_id, planned_quantity, actual_quantity, unit, reserved_quantity_used, inventory_transaction_id,
          consumption_date, over_issue_reason, notes, recorded_by)
        values (p_company, v_order.id, v_m.id, v_m.component_product_id, v_res.batch_id, v_res.warehouse_id, v_res.location_id,
          v_m.planned_quantity, v_take, v_m.unit, v_take, v_tx, v_date,
          case when v_m.issued_quantity + v_qty > v_m.planned_quantity then 'Actual consumption recorded at completion' end, v_note, auth.uid());
        v_numbers := v_numbers || (select transaction_number from public.inventory_transactions where id = v_tx);
        v_lot_cost := coalesce(private.lot_average_cost(v_res.batch_id), v_m.standard_cost);
        if v_lot_cost is null then v_cost_ok := false; else v_cost := v_cost + v_take * v_lot_cost; end if;
        v_left := v_left - v_take;
        exit when v_left = 0;
      end loop;
    end if;
    -- 2. then free stock in the production location, earliest expiry first
    if v_left > 0 then
      for v_bal in
        select b.batch_id, b.location_id, b.warehouse_id, b.on_hand - b.reserved as free
        from public.inventory_balances b
        join public.inventory_locations l on l.id = b.location_id and l.stock_usage = 'STORAGE' and l.status = 'ACTIVE'
        join public.inventory_batches bt on bt.id = b.batch_id
        where b.company_id = p_company and b.product_id = v_m.component_product_id
          and b.warehouse_id = v_order.source_warehouse_id and b.on_hand - b.reserved > 0
          and (bt.expiry_date is null or bt.expiry_date >= v_today)
        order by bt.expiry_date nulls last, bt.created_at, b.location_id
        for update of b
      loop
        v_take := least(v_left, v_bal.free);
        if private.is_whole_unit(v_m.unit) then v_take := trunc(v_take); end if;
        continue when v_take <= 0;
        v_tx := private.post_movement(p_company, 'PRODUCTION_ISSUE', v_bal.batch_id, v_bal.location_id, v_take, null,
          'PRODUCTION_ORDER', v_order.production_order_number, v_order.id,
          'Consumed in production ' || v_order.production_order_number, v_note, v_ts, 'PRODUCTION', v_order.id, null, null, null, 0);
        insert into public.production_material_consumption (company_id, production_order_id, order_material_id, component_product_id,
          batch_id, warehouse_id, location_id, planned_quantity, actual_quantity, unit, reserved_quantity_used, inventory_transaction_id,
          consumption_date, over_issue_reason, notes, recorded_by)
        values (p_company, v_order.id, v_m.id, v_m.component_product_id, v_bal.batch_id, v_bal.warehouse_id, v_bal.location_id,
          v_m.planned_quantity, v_take, v_m.unit, 0, v_tx, v_date,
          case when v_m.issued_quantity + v_qty > v_m.planned_quantity then 'Actual consumption recorded at completion' end, v_note, auth.uid());
        v_numbers := v_numbers || (select transaction_number from public.inventory_transactions where id = v_tx);
        v_lot_cost := coalesce(private.lot_average_cost(v_bal.batch_id), v_m.standard_cost);
        if v_lot_cost is null then v_cost_ok := false; else v_cost := v_cost + v_take * v_lot_cost; end if;
        v_left := v_left - v_take;
        exit when v_left = 0;
      end loop;
    end if;
    if v_left > 0 then
      v_short := v_short || jsonb_build_object('sku', v_m.sku, 'needed', v_qty, 'short', v_left, 'unit', v_m.unit);
    end if;

    update public.production_order_materials set issued_quantity = issued_quantity + v_qty - v_left where id = v_m.id;
    v_consumed := v_consumed || jsonb_build_object('sku', v_m.sku, 'quantity', v_qty, 'standard', v_std, 'unit', v_m.unit,
      'material_wastage', v_m.issued_quantity + v_qty - v_std);
    if v_m.issued_quantity + v_qty > v_std then
      v_warn := v_warn || to_jsonb(format('%s: consumed %s %s, standard for this output is %s (%s extra recorded as material wastage).',
        v_m.sku, trim_scale(v_m.issued_quantity + v_qty), v_m.unit, trim_scale(v_std), trim_scale(v_m.issued_quantity + v_qty - v_std)));
    elsif v_m.issued_quantity + v_qty < v_std then
      v_warn := v_warn || to_jsonb(format('%s: consumed %s %s, less than the standard %s for this output.',
        v_m.sku, trim_scale(v_m.issued_quantity + v_qty), v_m.unit, trim_scale(v_std)));
    end if;
  end loop;

  if jsonb_array_length(v_short) > 0 then
    raise exception 'Not enough stock in the production location to record this production: %. Nothing was posted. Receive the materials first (GRN) or enter the quantity actually used.',
      (select string_agg(format('%s needs %s %s, short by %s', s ->> 'sku', trim_scale((s ->> 'needed')::numeric), s ->> 'unit',
         trim_scale((s ->> 'short')::numeric)), '; ') from jsonb_array_elements(v_short) s)
      using errcode = 'P0001';
  end if;

  -- Finished goods: accepted into stock, rejected separately, wastage recorded only.
  if v_good > 0 then
    select * into v_good_loc from public.inventory_locations
    where id = coalesce(nullif(v_data ->> 'good_location_id', '')::uuid, private.production_v2_default_location(v_order.destination_warehouse_id))
      and company_id = p_company;
    if not found or v_good_loc.warehouse_id <> v_order.destination_warehouse_id or v_good_loc.stock_usage <> 'STORAGE' or v_good_loc.status <> 'ACTIVE' then
      raise exception 'Accepted goods go into an active storage location of the production location''s warehouse.' using errcode = 'P0001';
    end if;
  end if;
  if nullif(v_data ->> 'rejected_location_id', '') is not null then
    if v_rej = 0 then
      raise exception 'A location for rejected goods was chosen but no rejected quantity was entered.' using errcode = 'P0001';
    end if;
    select * into v_rej_loc from public.inventory_locations where id = (v_data ->> 'rejected_location_id')::uuid and company_id = p_company;
    if not found or v_rej_loc.stock_usage <> 'REJECTED' then
      raise exception 'Rejected goods can only be kept in a location for rejected (non-saleable) goods.' using errcode = 'P0001';
    end if;
  end if;

  v_unit_cost := case when v_cost_ok and v_good > 0 and v_cost > 0 then round(v_cost / v_good, 4) end;
  if v_good > 0 or v_rej_loc.id is not null then
    v_batch := nullif(btrim(coalesce(v_data ->> 'batch_number', '')), '');
    if v_product.track_batches and v_batch is null then
      v_batch := v_order.production_order_number;
    end if;
    v_lot := private.ensure_batch(p_company, v_product.id, 'IN_HOUSE', v_batch, case when v_product.track_batches then v_date end,
      case when v_product.track_batches then v_expiry end, v_unit_cost, 'PRODUCTION_ORDER', v_order.id,
      coalesce(v_good_loc.warehouse_id, v_rej_loc.warehouse_id), coalesce(v_good_loc.id, v_rej_loc.id), false);
  end if;
  v_number := private.next_document_number(p_company, 'FGR');
  if v_good > 0 then
    v_good_tx := private.post_movement(p_company, 'PRODUCTION_RECEIPT', v_lot, v_good_loc.id, v_good, v_unit_cost,
      'PRODUCTION_ORDER', v_order.production_order_number, v_order.id,
      'Production output ' || v_order.production_order_number || ' (' || v_number || ')', v_note, v_ts, 'PRODUCTION', v_order.id);
    v_numbers := v_numbers || (select transaction_number from public.inventory_transactions where id = v_good_tx);
  end if;
  v_rej_note := coalesce(nullif(btrim(coalesce(v_data ->> 'rejection_reason', '')), ''),
    case when v_rej > 0 and v_waste > 0 then 'Rejected and wasted in production'
         when v_rej > 0 then 'Rejected in production' when v_waste > 0 then 'Wasted in production' end);
  if v_rej_loc.id is not null then
    v_rej_tx := private.post_movement(p_company, 'PRODUCTION_RECEIPT', v_lot, v_rej_loc.id, v_rej, v_unit_cost,
      'PRODUCTION_ORDER', v_order.production_order_number, v_order.id,
      'Rejected production output ' || v_order.production_order_number || ': ' || v_rej_note, v_note, v_ts, 'PRODUCTION', v_order.id);
    v_numbers := v_numbers || (select transaction_number from public.inventory_transactions where id = v_rej_tx);
  end if;

  insert into public.production_output_receipts (company_id, receipt_number, production_order_id, product_id, batch_id,
    good_quantity, rejected_quantity, scrap_quantity, unit, good_location_id, rejected_location_id, good_transaction_id, rejected_transaction_id,
    production_date, unit_cost, quality_status, rejection_reason, over_production_reason, notes, created_by)
  values (p_company, v_number, v_order.id, v_product.id, v_lot, v_good, v_rej, v_waste, v_order.unit,
    v_good_loc.id, v_rej_loc.id, v_good_tx, v_rej_tx, v_date, v_unit_cost, 'ACCEPTED', v_rej_note,
    case when v_actual + v_waste > v_order.planned_quantity then 'Actual production recorded at completion' end, v_note, auth.uid())
  returning id into v_receipt;

  update public.production_orders
  set completed_quantity = completed_quantity + v_good, rejected_quantity = rejected_quantity + v_rej, scrap_quantity = scrap_quantity + v_waste,
      status = 'COMPLETED', actual_completion_date = v_date, completed_by = auth.uid(), completed_at = now(), completion_note = v_note
  where id = v_order.id;
  v_released := private.release_order_reservations(v_order, 'RELEASED');

  if v_actual + v_waste < v_order.planned_quantity then
    v_warn := v_warn || to_jsonb(format('Produced %s of the planned %s %s.', trim_scale(v_actual + v_waste), trim_scale(v_order.planned_quantity), v_order.unit));
  elsif v_actual + v_waste > v_order.planned_quantity then
    v_warn := v_warn || to_jsonb(format('Produced %s, more than the planned %s %s.', trim_scale(v_actual + v_waste), trim_scale(v_order.planned_quantity), v_order.unit));
  end if;
  if v_good > 0 and v_unit_cost is null then
    v_warn := v_warn || to_jsonb('The cost of some materials is unknown, so the finished goods were added without a unit cost.'::text);
  end if;

  perform private.log_production_event(p_company, v_order.id, 'PRODUCTION_RECORDED', v_from, 'COMPLETED', v_note,
    jsonb_build_object('receipt_number', v_number, 'production_date', v_date, 'actual', v_actual, 'accepted', v_good, 'rejected', v_rej,
      'wastage', v_waste, 'consumed', v_consumed, 'transaction_numbers', to_jsonb(v_numbers), 'released_reservation_quantity', v_released,
      'unit_cost', v_unit_cost));

  return jsonb_build_object('order_id', v_order.id, 'production_order_number', v_order.production_order_number, 'status', 'COMPLETED',
    'receipt_id', v_receipt, 'receipt_number', v_number, 'accepted', v_good, 'rejected', v_rej, 'wastage', v_waste, 'unit', v_order.unit,
    'unit_cost', v_unit_cost, 'consumed', v_consumed, 'transaction_numbers', to_jsonb(v_numbers),
    'released_reservation_quantity', v_released, 'warnings', v_warn);
end;
$$;

revoke all on function private.production_v2_post(uuid, uuid, jsonb) from public, anon, authenticated;

create or replace function private.production_v2_require_complete(p_company uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (private.has_permission(p_company, 'production_order.complete') and private.has_permission(p_company, 'production_material.issue')
          and private.has_permission(p_company, 'production_output.receive')) then
    raise exception 'You are not allowed to record production (requires production_order.complete, production_material.issue and production_output.receive).'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.production_v2_require_complete(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Create / edit an order
-- p_data: {product_id, production_date, planned_quantity, warehouse_id, remarks,
--          priority?, complete? (true = also record the production now, using the
--          completion fields of section 4)}
-- -----------------------------------------------------------------------------
create or replace function public.production_order_v2_save(p_order_id uuid, p_data jsonb, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_any_permission(array['production_order.create', 'production_order.update']);
  v_today    date := private.company_today(v_company);
  v_data     jsonb := coalesce(p_data, '{}'::jsonb);
  v_prev     jsonb;
  v_order    public.production_orders;
  v_product  public.products;
  v_bom      public.boms;
  v_qty      numeric;
  v_date     date;
  v_wh       uuid;
  v_pid      uuid;
  v_notes    text;
  v_priority text;
  v_bad      record;
  v_from     text;
  v_warn     jsonb := '[]'::jsonb;
  v_post     jsonb;
  v_req      jsonb;
  v_result   jsonb;
  v_complete boolean;
begin
  begin
    v_complete := coalesce((v_data ->> 'complete')::boolean, false);
    v_qty := nullif(btrim(coalesce(v_data ->> 'planned_quantity', '')), '')::numeric;
    v_date := nullif(btrim(coalesce(v_data ->> 'production_date', '')), '')::date;
    v_pid := nullif(btrim(coalesce(v_data ->> 'product_id', '')), '')::uuid;
    v_wh := nullif(btrim(coalesce(v_data ->> 'warehouse_id', '')), '')::uuid;
  exception when others then
    raise exception 'Enter a valid product, planned quantity, production date and location.' using errcode = 'P0001';
  end;
  if v_complete then
    perform private.production_v2_require_complete(v_company);
  end if;

  if p_order_id is null then
    if not private.has_permission(v_company, 'production_order.create') then
      raise exception 'You are not allowed to create production orders (requires production_order.create).' using errcode = '42501';
    end if;
    v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'production_v2_save');
    if v_prev is not null then return v_prev; end if;
  else
    if p_idempotency_key is not null then
      v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'production_v2_save');
      if v_prev is not null then return v_prev; end if;
    end if;
    select * into v_order from public.production_orders where id = p_order_id and company_id = v_company for update;
    if not found then
      raise exception 'Production order not found in your company.' using errcode = 'P0001';
    end if;
    if v_order.status not in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'MATERIALS_RESERVED', 'IN_PROGRESS') then
      raise exception 'A % production order cannot be edited.%', lower(replace(v_order.status, '_', ' ')),
        case when v_order.status = 'COMPLETED' then ' Use "Correct production" to change what was recorded.' else '' end using errcode = 'P0001';
    end if;
    if exists (select 1 from public.production_material_consumption where production_order_id = v_order.id and status = 'POSTED')
       or exists (select 1 from public.production_output_receipts where production_order_id = v_order.id and status = 'POSTED') then
      raise exception 'Materials or output are already recorded for this order. Use "Correct production" instead of editing it.' using errcode = 'P0001';
    end if;
    if not (private.has_permission(v_company, 'production_order.update') or v_order.created_by = auth.uid()) then
      raise exception 'You can only edit your own production orders (requires production_order.update).' using errcode = '42501';
    end if;
    if v_pid is not null and v_pid <> v_order.finished_product_id
       and exists (select 1 from public.production_material_consumption where production_order_id = v_order.id) then
      raise exception 'The product of an order with posting history cannot be changed. Cancel it and create a new order.' using errcode = 'P0001';
    end if;
  end if;

  v_pid := coalesce(v_pid, v_order.finished_product_id);
  v_qty := coalesce(v_qty, v_order.planned_quantity);
  v_date := coalesce(v_date, v_order.planned_start_date, v_today);
  v_wh := coalesce(v_wh, v_order.source_warehouse_id,
    (select id from public.warehouses where company_id = v_company and is_default and status = 'ACTIVE' limit 1));
  v_notes := case when v_data ? 'remarks' then nullif(btrim(coalesce(v_data ->> 'remarks', '')), '') else v_order.notes end;
  v_priority := coalesce(nullif(v_data ->> 'priority', ''), v_order.priority, 'NORMAL');

  select * into v_product from public.products where id = v_pid and company_id = v_company;
  if not found then
    raise exception 'Choose the finished product to produce.' using errcode = 'P0001';
  end if;
  if v_product.status <> 'ACTIVE' or v_product.archived_at is not null then
    raise exception '% is inactive and cannot be produced.', v_product.sku using errcode = 'P0001';
  end if;
  v_bom := private.production_v2_active_bom(v_company, v_product.id);
  if v_bom.id is null then
    raise exception '% has no active BOM. Add its components first.', v_product.sku using errcode = 'P0001';
  end if;
  if v_product.base_unit <> v_bom.output_unit then
    raise exception 'The unit of % (%) no longer matches its BOM output unit (%).', v_product.sku, v_product.base_unit, v_bom.output_unit using errcode = 'P0001';
  end if;
  if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) then
    raise exception 'Enter a planned quantity greater than zero (up to 3 decimals).' using errcode = 'P0001';
  end if;
  if private.is_whole_unit(v_product.base_unit) and v_qty <> trunc(v_qty) then
    raise exception '% is counted in whole pieces (%): enter a whole planned quantity.', v_product.sku, v_product.base_unit using errcode = 'P0001';
  end if;
  if v_wh is null or not exists (select 1 from public.warehouses where id = v_wh and company_id = v_company and status = 'ACTIVE') then
    raise exception 'Choose the production location (an active warehouse).' using errcode = 'P0001';
  end if;
  if v_notes is not null and length(v_notes) > 2000 then
    raise exception 'Remarks are limited to 2000 characters.' using errcode = 'P0001';
  end if;
  if v_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception 'Priority must be LOW, NORMAL, HIGH or URGENT.' using errcode = 'P0001';
  end if;
  select * into v_bad from private.bom_requirement_lines(v_bom.id, v_qty) r where not r.unit_matches or not r.component_active limit 1;
  if found then
    raise exception 'Component % cannot be planned: %.', v_bad.sku,
      case when not v_bad.unit_matches then format('BOM unit %s differs from inventory unit %s', v_bad.unit, v_bad.inventory_unit)
           else 'it is inactive' end using errcode = 'P0001';
  end if;

  if p_order_id is null then
    insert into public.production_orders (company_id, production_order_number, finished_product_id, bom_id, bom_code, bom_version, unit,
      planned_quantity, priority, source_warehouse_id, destination_warehouse_id, planned_start_date, target_completion_date, notes, created_by)
    values (v_company, private.next_document_number(v_company, 'PRD'), v_product.id, v_bom.id, v_bom.bom_code, v_bom.version, v_product.base_unit,
      v_qty, v_priority, v_wh, v_wh, v_date, v_date, v_notes, auth.uid())
    returning * into v_order;
    perform private.log_production_event(v_company, v_order.id, 'CREATED', null, 'DRAFT', null,
      jsonb_build_object('production_order_number', v_order.production_order_number, 'bom_code', v_bom.bom_code, 'bom_version', v_bom.version,
        'planned_quantity', v_qty, 'production_date', v_date));
  else
    v_from := v_order.status;
    if v_order.status <> 'DRAFT' then
      perform private.release_order_reservations(v_order, 'RELEASED');
    end if;
    update public.production_orders
    set finished_product_id = v_product.id, bom_id = v_bom.id, bom_code = v_bom.bom_code, bom_version = v_bom.version, unit = v_product.base_unit,
        planned_quantity = v_qty, priority = v_priority, source_warehouse_id = v_wh, destination_warehouse_id = v_wh,
        planned_start_date = v_date, target_completion_date = v_date, notes = v_notes, status = 'DRAFT', actual_start_date = null
    where id = v_order.id
    returning * into v_order;
    delete from public.production_order_materials m
    where m.production_order_id = v_order.id
      and not exists (select 1 from public.production_material_consumption c where c.order_material_id = m.id)
      and m.component_product_id not in (select r.component_product_id from private.bom_requirement_lines(v_bom.id, v_qty) r);
    perform private.log_production_event(v_company, v_order.id, 'UPDATED', v_from, 'DRAFT',
      case when v_from <> 'DRAFT' then 'Edited: reservations released and materials recalculated.' end,
      jsonb_build_object('planned_quantity', v_qty, 'production_date', v_date, 'bom_code', v_bom.bom_code, 'bom_version', v_bom.version));
  end if;

  perform private.production_v2_snapshot(v_order);
  v_warn := private.production_v2_open_and_reserve(v_company, v_order.id);

  if v_complete then
    v_post := private.production_v2_post(v_company, v_order.id, v_data);
    v_warn := v_warn || coalesce(v_post -> 'warnings', '[]'::jsonb);
  else
    v_req := private.production_v2_requirements(v_order.id);
    v_warn := v_warn || private.production_v2_shortage_warnings(v_req);
  end if;

  v_result := jsonb_build_object('order_id', v_order.id, 'production_order_number', v_order.production_order_number,
    'status', (select status from public.production_orders where id = v_order.id),
    'bom_code', v_bom.bom_code, 'bom_version', v_bom.version,
    'requirements', coalesce(v_req, private.production_v2_requirements(v_order.id)),
    'completion', v_post, 'warnings', v_warn);
  if p_idempotency_key is not null then
    return private.idempotency_finish(v_company, p_idempotency_key, v_result);
  end if;
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Complete production
-- -----------------------------------------------------------------------------
create or replace function public.production_order_v2_complete(p_order_id uuid, p_data jsonb, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_order.complete');
  v_prev    jsonb;
begin
  perform private.production_v2_require_complete(v_company);
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'production_v2_complete');
  if v_prev is not null then return v_prev; end if;
  return private.idempotency_finish(v_company, p_idempotency_key, private.production_v2_post(v_company, p_order_id, p_data));
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Correct a completed production: reverse every posting (reversal entries,
-- originals kept as REVERSED) and post the corrected production, all in one
-- transaction. p_data null = reopen the order instead (materials reserved again).
-- -----------------------------------------------------------------------------
create or replace function public.production_order_v2_correct(p_order_id uuid, p_reason text, p_data jsonb default null, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('production_exception.approve');
  v_prev     jsonb;
  v_order    public.production_orders;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_out      public.production_output_receipts;
  v_con      public.production_material_consumption;
  v_numbers  text[] := '{}';
  v_these    text[];
  v_post     jsonb;
  v_warn     jsonb := '[]'::jsonb;
  v_result   jsonb;
begin
  if p_data is not null then
    perform private.production_v2_require_complete(v_company);
  end if;
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'production_v2_correct');
  if v_prev is not null then return v_prev; end if;
  if v_reason is null or length(v_reason) < 5 then
    raise exception 'Enter the reason for the correction (at least 5 characters).' using errcode = 'P0001';
  end if;
  if length(v_reason) > 500 then
    raise exception 'The reason is limited to 500 characters.' using errcode = 'P0001';
  end if;
  select * into v_order from public.production_orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Production order not found in your company.' using errcode = 'P0001';
  end if;
  if v_order.status not in ('COMPLETED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED') then
    raise exception 'Only recorded production can be corrected (order is %).', lower(replace(v_order.status, '_', ' ')) using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.production_output_receipts where production_order_id = v_order.id and status = 'POSTED')
     and not exists (select 1 from public.production_material_consumption where production_order_id = v_order.id and status = 'POSTED') then
    raise exception 'Nothing has been recorded for this order yet, so there is nothing to correct.' using errcode = 'P0001';
  end if;

  -- Finished goods first: they must still be in stock to be taken back out.
  for v_out in
    select * from public.production_output_receipts where production_order_id = v_order.id and status = 'POSTED' order by created_at for update
  loop
    v_these := '{}';
    begin
      if v_out.good_transaction_id is not null then
        v_these := v_these || private.reverse_ledger_transaction(v_company, v_out.good_transaction_id, 'Correction of ' || v_order.production_order_number || ': ' || v_reason);
      end if;
      if v_out.rejected_transaction_id is not null then
        v_these := v_these || private.reverse_ledger_transaction(v_company, v_out.rejected_transaction_id, 'Correction of ' || v_order.production_order_number || ': ' || v_reason);
      end if;
    exception when others then
      raise exception 'The finished goods of % (%) can no longer be taken back out of stock: %. Nothing was changed.',
        v_order.production_order_number, v_out.receipt_number, sqlerrm using errcode = 'P0001';
    end;
    update public.production_output_receipts
    set status = 'REVERSED', reversal_transaction_ids = v_these, reversal_reason = v_reason, reversed_by = auth.uid(), reversed_at = now()
    where id = v_out.id;
    update public.production_orders
    set completed_quantity = completed_quantity - v_out.good_quantity, rejected_quantity = rejected_quantity - v_out.rejected_quantity,
        scrap_quantity = scrap_quantity - v_out.scrap_quantity
    where id = v_order.id;
    v_numbers := v_numbers || v_these;
  end loop;

  for v_con in
    select * from public.production_material_consumption where production_order_id = v_order.id and status = 'POSTED' order by created_at for update
  loop
    v_these := private.reverse_ledger_transaction(v_company, v_con.inventory_transaction_id, 'Correction of ' || v_order.production_order_number || ': ' || v_reason);
    update public.production_material_consumption
    set status = 'REVERSED', reversal_transaction_ids = v_these, reversal_reason = v_reason, reversed_by = auth.uid(), reversed_at = now()
    where id = v_con.id;
    update public.production_order_materials set issued_quantity = issued_quantity - v_con.actual_quantity where id = v_con.order_material_id;
    v_numbers := v_numbers || v_these;
  end loop;

  update public.production_orders
  set status = 'IN_PROGRESS', actual_completion_date = null, completed_by = null, completed_at = null, completion_note = null
  where id = v_order.id;
  perform private.log_production_event(v_company, v_order.id, 'PRODUCTION_REVERSED', v_order.status, 'IN_PROGRESS', v_reason,
    jsonb_build_object('reversal_numbers', to_jsonb(v_numbers)));

  if p_data is null then
    update public.production_orders set status = 'APPROVED', actual_start_date = null where id = v_order.id;
    perform private.log_production_event(v_company, v_order.id, 'REOPENED', 'IN_PROGRESS', 'APPROVED', v_reason, '{}'::jsonb);
    v_warn := private.production_v2_open_and_reserve(v_company, v_order.id);
    v_warn := v_warn || private.production_v2_shortage_warnings(private.production_v2_requirements(v_order.id));
  else
    v_post := private.production_v2_post(v_company, v_order.id, p_data);
    v_warn := coalesce(v_post -> 'warnings', '[]'::jsonb);
    perform private.log_production_event(v_company, v_order.id, 'PRODUCTION_CORRECTED', 'IN_PROGRESS', 'COMPLETED', v_reason,
      jsonb_build_object('receipt_number', v_post ->> 'receipt_number', 'reversal_numbers', to_jsonb(v_numbers)));
  end if;

  v_result := jsonb_build_object('order_id', v_order.id, 'production_order_number', v_order.production_order_number,
    'status', (select status from public.production_orders where id = v_order.id),
    'reversal_numbers', to_jsonb(v_numbers), 'completion', v_post, 'warnings', v_warn);
  return private.idempotency_finish(v_company, p_idempotency_key, v_result);
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Material lines of an order (with source type and shortage)
-- -----------------------------------------------------------------------------
create or replace function public.production_order_v2_requirements(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('manufacturing.read');
begin
  if not exists (select 1 from public.production_orders where id = p_order_id and company_id = v_company) then
    raise exception 'Production order not found in your company.' using errcode = 'P0001';
  end if;
  return private.production_v2_requirements(p_order_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Add missing components to a product's BOM from the production screen.
-- A new BOM version is created (existing versions are never changed) and
-- activated. p_items: [{component_product_id, quantity_per_unit, wastage_percentage?, source_type?}]
-- with the quantity per ONE unit of the product.
-- -----------------------------------------------------------------------------
create or replace function public.production_bom_add_components(p_product_id uuid, p_items jsonb, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_bom.create');
  v_prev    jsonb;
  v_product public.products;
  v_bom     public.boms;
  v_items   jsonb := '[]'::jsonb;
  v_item    jsonb;
  v_comp    public.products;
  v_qty     numeric;
  v_out     numeric := 1;
  v_saved   jsonb;
  v_act     jsonb;
begin
  if not private.has_permission(v_company, 'production_bom.approve') then
    raise exception 'Adding components activates a new BOM version, which requires production_bom.approve.' using errcode = '42501';
  end if;
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'production_bom_add_components');
  if v_prev is not null then return v_prev; end if;
  select * into v_product from public.products where id = p_product_id and company_id = v_company;
  if not found then
    raise exception 'Product not found in your company.' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one component.' using errcode = 'P0001';
  end if;
  v_bom := private.production_v2_active_bom(v_company, v_product.id);
  if v_bom.id is not null then
    v_out := v_bom.output_quantity;
    select coalesce(jsonb_agg(jsonb_build_object('component_product_id', bi.component_product_id, 'quantity_required', bi.quantity_required,
      'unit', bi.unit, 'wastage_percentage', bi.wastage_percentage, 'notes', bi.notes, 'source_type', bi.source_type,
      'preferred_supplier_id', bi.preferred_supplier_id) order by bi.line_no), '[]'::jsonb)
    into v_items from public.bom_items bi where bi.bom_id = v_bom.id;
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    select * into v_comp from public.products where id = nullif(v_item ->> 'component_product_id', '')::uuid and company_id = v_company;
    if not found then
      raise exception 'Choose the component to add.' using errcode = 'P0001';
    end if;
    if v_bom.id is not null and exists (select 1 from public.bom_items where bom_id = v_bom.id and component_product_id = v_comp.id) then
      raise exception '% is already in % v%. Edit the BOM to change its quantity.', v_comp.sku, v_bom.bom_code, v_bom.version using errcode = 'P0001';
    end if;
    begin
      v_qty := (v_item ->> 'quantity_per_unit')::numeric;
    exception when others then
      raise exception '%: the quantity per unit must be a number.', v_comp.sku using errcode = 'P0001';
    end;
    if v_qty is null or v_qty <= 0 then
      raise exception '%: enter the quantity needed for one unit of %.', v_comp.sku, v_product.sku using errcode = 'P0001';
    end if;
    v_items := v_items || jsonb_build_object('component_product_id', v_comp.id, 'quantity_required', round(v_qty * v_out, 6),
      'wastage_percentage', coalesce(nullif(v_item ->> 'wastage_percentage', ''), '0'), 'source_type', nullif(v_item ->> 'source_type', ''),
      'notes', 'Added from the production screen');
  end loop;

  v_saved := public.production_save_bom(null, v_product.id, greatest(private.company_today(v_company), coalesce(v_bom.effective_from, private.company_today(v_company))),
    null, v_out, coalesce(v_bom.notes, 'Created from the production screen.'), v_items, gen_random_uuid());
  v_act := public.production_bom_activate((v_saved ->> 'bom_id')::uuid, 'Components added from the production screen.');

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'bom_id', v_saved -> 'bom_id', 'bom_code', v_saved -> 'bom_code', 'version', v_saved -> 'version',
    'components', jsonb_array_length(v_items), 'added', jsonb_array_length(p_items),
    'replaced_version', case when v_bom.id is not null then v_bom.version end, 'status', v_act -> 'status'));
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Production dashboard
-- Quantities are grouped by unit (PCS and KG are never added together).
-- -----------------------------------------------------------------------------
create or replace function public.production_dashboard(p_from date default null, p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('manufacturing.read');
  v_today   date := private.company_today(v_company);
  v_from    date := coalesce(p_from, date_trunc('month', private.company_today(v_company))::date);
  v_to      date := coalesce(p_to, private.company_today(v_company));
  v_month   date := date_trunc('month', private.company_today(v_company))::date;
begin
  if v_to < v_from then
    raise exception 'The end date cannot be before the start date.' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'from', v_from, 'to', v_to, 'today', v_today,
    'orders', (select count(*) from public.production_orders where company_id = v_company and status <> 'CANCELLED'
                 and planned_start_date between v_from and v_to),
    'orders_completed', (select count(*) from public.production_orders where company_id = v_company and status = 'COMPLETED'
                 and actual_completion_date between v_from and v_to),
    'open_orders', (select count(*) from public.production_orders where company_id = v_company and status not in ('COMPLETED', 'CANCELLED')),
    'produced_today', (select coalesce(jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit), '[]'::jsonb) from (
        select r.unit, sum(r.good_quantity) as q from public.production_output_receipts r
        where r.company_id = v_company and r.status = 'POSTED' and r.production_date = v_today and r.good_quantity > 0 group by r.unit) x),
    'produced_month', (select coalesce(jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit), '[]'::jsonb) from (
        select r.unit, sum(r.good_quantity) as q from public.production_output_receipts r
        where r.company_id = v_company and r.status = 'POSTED' and r.production_date between v_month and v_today and r.good_quantity > 0 group by r.unit) x),
    'finished_goods', (select coalesce(jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit), '[]'::jsonb) from (
        select r.unit, sum(r.good_quantity) as q from public.production_output_receipts r join public.products p on p.id = r.product_id
        where r.company_id = v_company and r.status = 'POSTED' and r.production_date between v_from and v_to
          and p.product_type = 'FINISHED_GOOD' and r.good_quantity > 0 group by r.unit) x),
    'raw_materials', (select coalesce(jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit), '[]'::jsonb) from (
        select c.unit, sum(c.actual_quantity) as q from public.production_material_consumption c join public.products p on p.id = c.component_product_id
        where c.company_id = v_company and c.status = 'POSTED' and c.consumption_date between v_from and v_to
          and p.product_type = 'RAW_MATERIAL' group by c.unit) x),
    'components', (select coalesce(jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit), '[]'::jsonb) from (
        select c.unit, sum(c.actual_quantity) as q from public.production_material_consumption c join public.products p on p.id = c.component_product_id
        where c.company_id = v_company and c.status = 'POSTED' and c.consumption_date between v_from and v_to
          and p.product_type <> 'RAW_MATERIAL' group by c.unit) x),
    'rejected', (select coalesce(jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit), '[]'::jsonb) from (
        select r.unit, sum(r.rejected_quantity) as q from public.production_output_receipts r
        where r.company_id = v_company and r.status = 'POSTED' and r.production_date between v_from and v_to and r.rejected_quantity > 0 group by r.unit) x),
    'wastage', (select coalesce(jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit), '[]'::jsonb) from (
        select r.unit, sum(r.scrap_quantity) as q from public.production_output_receipts r
        where r.company_id = v_company and r.status = 'POSTED' and r.production_date between v_from and v_to and r.scrap_quantity > 0 group by r.unit) x),
    'pending', (select coalesce(jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit), '[]'::jsonb) from (
        select o.unit, sum(greatest(o.planned_quantity - o.actual_quantity, 0)) as q from public.production_orders o
        where o.company_id = v_company and o.status not in ('COMPLETED', 'CANCELLED') group by o.unit) x),
    -- Shortages per component across all open orders: still to consume, minus what is
    -- reserved for those orders, minus free stock in their production locations.
    'shortages', (select coalesce(jsonb_agg(jsonb_build_object('component_product_id', component_product_id, 'sku', sku, 'product_name', product_name,
        'unit', unit, 'needed', needed, 'reserved', reserved, 'available', available, 'shortage', needed - reserved - available, 'orders', orders)
        order by needed - reserved - available desc, sku), '[]'::jsonb) from (
        select n.component_product_id, p.sku, p.product_name, n.unit, n.needed, n.reserved, n.orders,
          (select coalesce(sum(s.available), 0) from unnest(n.warehouses) w cross join lateral private.storage_stock(v_company, n.component_product_id, w) s) as available
        from (
          select m.component_product_id, m.unit, sum(greatest(m.planned_quantity - m.issued_quantity, 0)) as needed,
            sum(private.order_open_reserved(o.id, m.component_product_id)) as reserved, count(distinct o.id) as orders,
            array_agg(distinct o.source_warehouse_id) as warehouses
          from public.production_order_materials m join public.production_orders o on o.id = m.production_order_id
          where o.company_id = v_company and o.status not in ('COMPLETED', 'CANCELLED')
          group by m.component_product_id, m.unit
        ) n join public.products p on p.id = n.component_product_id
      ) z where needed - reserved - available > 0),
    'recent', (select coalesce(jsonb_agg(e order by (e ->> 'created_at') desc), '[]'::jsonb) from (
        select jsonb_build_object('id', ev.id, 'created_at', ev.created_at, 'event_type', ev.event_type, 'to_status', ev.to_status, 'note', ev.note,
          'details', ev.details, 'order_id', o.id, 'production_order_number', o.production_order_number, 'sku', p.sku, 'product_name', p.product_name,
          'unit', o.unit, 'actor_user_id', ev.actor_user_id) as e
        from public.production_order_events ev
        join public.production_orders o on o.id = ev.production_order_id
        join public.products p on p.id = o.finished_product_id
        where ev.company_id = v_company
        order by ev.created_at desc, ev.id desc
        limit 15) r)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. Excel production upload
-- p_rows: [{row_number, production_date, sku, planned_quantity, actual_quantity,
--           rejected_quantity, remarks}] as text. Availability is counted
-- cumulatively down the file, so two rows cannot both use the same stock.
-- A row with an actual quantity is recorded as completed production (standard
-- consumption); a shortage on such a row is an error. Without an actual
-- quantity the row becomes an open order and shortages are warnings.
-- -----------------------------------------------------------------------------
create or replace function private.production_import_check(p_company uuid, p_rows jsonb, p_warehouse uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today   date := private.company_today(p_company);
  v_row     jsonb;
  v_out     jsonb := '[]'::jsonb;
  v_err     text[];
  v_warn    text[];
  v_date    date;
  v_planned numeric;
  v_actual  numeric;
  v_rej     numeric;
  v_product public.products;
  v_bom     public.boms;
  v_line    record;
  v_avail   numeric;
  v_used    jsonb := '{}'::jsonb;
  v_mats    jsonb;
  v_need    numeric;
  v_seen    jsonb := '{}'::jsonb;
  v_key     text;
  v_dup     text;
  v_txt     text;
  v_sku     text;
  v_remarks text;
begin
  for v_row in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_err := '{}'; v_warn := '{}'; v_mats := '[]'::jsonb;
    v_date := null; v_planned := null; v_actual := null; v_rej := null; v_product := null; v_bom := null;
    v_sku := nullif(btrim(coalesce(v_row ->> 'sku', '')), '');
    v_remarks := nullif(btrim(coalesce(v_row ->> 'remarks', '')), '');

    v_txt := nullif(btrim(coalesce(v_row ->> 'production_date', '')), '');
    if v_txt is null then
      v_err := v_err || 'Production Date is required.'::text;
    else
      begin
        if v_txt !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'bad'; end if;
        v_date := v_txt::date;
      exception when others then
        v_err := v_err || format('Production Date "%s" is not a valid date (use YYYY-MM-DD).', left(v_txt, 30));
      end;
    end if;
    begin
      v_planned := nullif(btrim(coalesce(v_row ->> 'planned_quantity', '')), '')::numeric;
    exception when others then v_err := v_err || format('Planned Quantity "%s" is not a number.', left(v_row ->> 'planned_quantity', 30));
    end;
    begin
      v_actual := nullif(btrim(coalesce(v_row ->> 'actual_quantity', '')), '')::numeric;
    exception when others then v_err := v_err || format('Actual Quantity "%s" is not a number.', left(v_row ->> 'actual_quantity', 30));
    end;
    begin
      v_rej := coalesce(nullif(btrim(coalesce(v_row ->> 'rejected_quantity', '')), '')::numeric, 0);
    exception when others then v_err := v_err || format('Rejected Quantity "%s" is not a number.', left(v_row ->> 'rejected_quantity', 30));
    end;
    if v_planned is null and v_actual is not null then v_planned := v_actual; end if;
    if v_actual = 0 then v_actual := null; end if;
    if v_planned is null then
      if not exists (select 1 from unnest(v_err) e where e like 'Planned Quantity%') then
        v_err := v_err || 'Planned Quantity is required (or enter the Actual Quantity).'::text;
      end if;
    elsif v_planned <= 0 or v_planned <> round(v_planned, 3) then
      v_err := v_err || 'Planned Quantity must be greater than zero (up to 3 decimals).'::text;
    end if;
    if v_actual is not null and (v_actual < 0 or v_actual <> round(v_actual, 3)) then
      v_err := v_err || 'Actual Quantity must be zero or more (up to 3 decimals).'::text;
    end if;
    if v_rej is not null and (v_rej < 0 or v_rej <> round(v_rej, 3)) then
      v_err := v_err || 'Rejected Quantity must be zero or more (up to 3 decimals).'::text;
    elsif coalesce(v_rej, 0) > 0 and v_actual is null then
      v_err := v_err || 'Rejected Quantity needs an Actual Quantity (rejected units are part of what was produced).'::text;
    elsif coalesce(v_rej, 0) > coalesce(v_actual, 0) and v_actual is not null then
      v_err := v_err || format('Rejected Quantity (%s) cannot be more than the Actual Quantity (%s).', trim_scale(v_rej), trim_scale(v_actual));
    end if;
    if v_actual is not null and v_date is not null and v_date > v_today then
      v_err := v_err || 'Production with an Actual Quantity cannot be dated in the future.'::text;
    end if;
    if v_remarks is not null and length(v_remarks) > 2000 then
      v_err := v_err || 'Remarks are limited to 2000 characters.'::text;
    end if;

    if v_sku is null then
      v_err := v_err || 'Finished Product SKU is required.'::text;
    else
      select * into v_product from public.products where company_id = p_company and lower(sku) = lower(v_sku);
      if not found then
        v_err := v_err || format('SKU "%s" was not found in the Product Master.', left(v_sku, 60));
        v_product := null;
      elsif v_product.status <> 'ACTIVE' or v_product.archived_at is not null then
        v_err := v_err || format('%s is inactive.', v_product.sku);
      else
        v_bom := private.production_v2_active_bom(p_company, v_product.id);
        if v_bom.id is null then
          v_err := v_err || format('%s has no active BOM. Create its BOM first (or add components on the production screen).', v_product.sku);
        end if;
        if private.is_whole_unit(v_product.base_unit) and (v_planned <> trunc(v_planned) or v_actual <> trunc(v_actual) or v_rej <> trunc(v_rej)) then
          v_err := v_err || format('%s is counted in whole pieces (%s): quantities must be whole numbers.', v_product.sku, v_product.base_unit);
        end if;
      end if;
    end if;

    -- Requirements and availability (only when the row is otherwise valid).
    if cardinality(v_err) = 0 and v_bom.id is not null then
      for v_line in
        select r.* from private.bom_requirement_lines(v_bom.id, coalesce(v_actual, v_planned)) r order by r.line_no
      loop
        if not v_line.unit_matches or not v_line.component_active then
          v_err := v_err || format('Component %s cannot be used: %s.', v_line.sku,
            case when not v_line.unit_matches then 'its BOM unit differs from its inventory unit' else 'it is inactive' end);
          continue;
        end if;
        v_avail := greatest((select s.available from private.storage_stock(p_company, v_line.component_product_id, p_warehouse) s)
                   - coalesce((v_used ->> v_line.component_product_id::text)::numeric, 0), 0);
        v_need := v_line.total_requirement;
        v_mats := v_mats || jsonb_build_object('sku', v_line.sku, 'product_name', v_line.product_name, 'unit', v_line.unit,
          'required', v_need, 'available', v_avail, 'shortage', greatest(v_need - v_avail, 0));
        if v_need > v_avail then
          if v_actual is not null then
            v_err := v_err || format('Not enough %s to record this production: needs %s %s, available %s.', v_line.sku, trim_scale(v_need), v_line.unit, trim_scale(v_avail));
          else
            v_warn := v_warn || format('%s short by %s %s: purchase %s %s (the available %s will be reserved).', v_line.sku,
              trim_scale(v_need - v_avail), v_line.unit, trim_scale(v_need - v_avail), v_line.unit, trim_scale(v_avail));
          end if;
        end if;
      end loop;
    end if;

    if cardinality(v_err) = 0 then
      -- Count the stock this row will take so later rows see what is left.
      select coalesce(v_used, '{}'::jsonb) || coalesce(jsonb_object_agg(r.component_product_id::text,
          coalesce((v_used ->> r.component_product_id::text)::numeric, 0) + least(r.total_requirement,
            greatest((select s.available from private.storage_stock(p_company, r.component_product_id, p_warehouse) s)
                     - coalesce((v_used ->> r.component_product_id::text)::numeric, 0), 0))), '{}'::jsonb)
      into v_used
      from private.bom_requirement_lines(v_bom.id, coalesce(v_actual, v_planned)) r;

      v_key := lower(v_product.sku) || '|' || v_date || '|' || v_planned || '|' || coalesce(v_actual::text, '');
      if v_seen ? v_key then
        v_warn := v_warn || format('Same product, date and quantities as row %s: check it is not entered twice.', v_seen ->> v_key);
      else
        v_seen := v_seen || jsonb_build_object(v_key, v_row ->> 'row_number');
      end if;
      select production_order_number into v_dup from public.production_orders
      where company_id = p_company and finished_product_id = v_product.id and planned_start_date = v_date
        and planned_quantity = v_planned and status <> 'CANCELLED'
      limit 1;
      if v_dup is not null then
        v_warn := v_warn || format('%s already exists for %s on this date with the same planned quantity: check this is not a duplicate.', v_dup, v_product.sku);
        v_dup := null;
      end if;
    end if;

    v_out := v_out || jsonb_build_object(
      'row_number', (v_row ->> 'row_number')::int,
      'status', case when cardinality(v_err) > 0 then 'ERROR' when cardinality(v_warn) > 0 then 'WARNING' else 'VALID' end,
      'errors', to_jsonb(v_err), 'warnings', to_jsonb(v_warn),
      'product_id', v_product.id, 'sku', coalesce(v_product.sku, v_sku), 'product_name', v_product.product_name, 'unit', v_product.base_unit,
      'bom_code', v_bom.bom_code, 'bom_version', v_bom.version,
      'production_date', v_date, 'planned_quantity', v_planned, 'actual_quantity', v_actual, 'rejected_quantity', v_rej,
      'remarks', v_remarks, 'complete', v_actual is not null, 'materials', v_mats);
  end loop;
  return v_out;
end;
$$;

revoke all on function private.production_import_check(uuid, jsonb, uuid) from public, anon, authenticated;

create or replace function public.production_import_preview(p_rows jsonb, p_warehouse_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_order.create');
  v_wh      uuid;
  v_rows    jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The file has no data rows.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'Import at most 1000 rows per file.' using errcode = 'P0001';
  end if;
  v_wh := coalesce(p_warehouse_id, (select id from public.warehouses where company_id = v_company and is_default and status = 'ACTIVE' limit 1));
  if v_wh is null or not exists (select 1 from public.warehouses where id = v_wh and company_id = v_company and status = 'ACTIVE') then
    raise exception 'Choose the production location (an active warehouse).' using errcode = 'P0001';
  end if;
  v_rows := private.production_import_check(v_company, p_rows, v_wh);
  return jsonb_build_object('warehouse_id', v_wh, 'rows', v_rows,
    'total', jsonb_array_length(v_rows),
    'valid', (select count(*) from jsonb_array_elements(v_rows) r where r ->> 'status' = 'VALID'),
    'warnings', (select count(*) from jsonb_array_elements(v_rows) r where r ->> 'status' = 'WARNING'),
    'errors', (select count(*) from jsonb_array_elements(v_rows) r where r ->> 'status' = 'ERROR'),
    'to_complete', (select count(*) from jsonb_array_elements(v_rows) r where r ->> 'status' <> 'ERROR' and (r ->> 'complete')::boolean));
end;
$$;

create or replace function public.production_import(p_rows jsonb, p_warehouse_id uuid, p_file jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_order.create');
  v_uid     uuid := auth.uid();
  v_prev    jsonb;
  v_wh      uuid;
  v_checked jsonb;
  v_row     jsonb;
  v_res     jsonb;
  v_created jsonb := '[]'::jsonb;
  v_failed  jsonb := '[]'::jsonb;
  v_hist    jsonb := '[]'::jsonb;
  v_file    jsonb := coalesce(p_file, '{}'::jsonb);
  v_hash    text := nullif(v_file ->> 'file_hash', '');
  v_job     public.import_jobs;
  v_can_complete boolean;
  v_msg     text;
begin
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'production_import');
  if v_prev is not null then return v_prev; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The file has no data rows.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'Import at most 1000 rows per file.' using errcode = 'P0001';
  end if;
  if v_hash is not null and v_hash !~ '^[0-9a-f]{64}$' then
    v_hash := null;
  end if;
  v_wh := coalesce(p_warehouse_id, (select id from public.warehouses where company_id = v_company and is_default and status = 'ACTIVE' limit 1));
  if v_wh is null or not exists (select 1 from public.warehouses where id = v_wh and company_id = v_company and status = 'ACTIVE') then
    raise exception 'Choose the production location (an active warehouse).' using errcode = 'P0001';
  end if;
  v_can_complete := private.has_permission(v_company, 'production_order.complete') and private.has_permission(v_company, 'production_material.issue')
    and private.has_permission(v_company, 'production_output.receive');

  -- Re-validated here: the preview is never trusted.
  v_checked := private.production_import_check(v_company, p_rows, v_wh);
  for v_row in select value from jsonb_array_elements(v_checked) loop
    if v_row ->> 'status' = 'ERROR' then
      v_failed := v_failed || jsonb_build_object('row_number', v_row -> 'row_number', 'sku', v_row ->> 'sku', 'messages', v_row -> 'errors');
      v_hist := v_hist || jsonb_build_object('row_number', v_row -> 'row_number', 'outcome', 'FAILED', 'reference', v_row ->> 'sku', 'messages', v_row -> 'errors');
      continue;
    end if;
    if (v_row ->> 'complete')::boolean and not v_can_complete then
      v_msg := 'You are not allowed to record completed production; leave Actual Quantity blank to create an open order.';
      v_failed := v_failed || jsonb_build_object('row_number', v_row -> 'row_number', 'sku', v_row ->> 'sku', 'messages', jsonb_build_array(v_msg));
      v_hist := v_hist || jsonb_build_object('row_number', v_row -> 'row_number', 'outcome', 'FAILED', 'reference', v_row ->> 'sku', 'messages', jsonb_build_array(v_msg));
      continue;
    end if;
    begin
      v_res := public.production_order_v2_save(null, jsonb_build_object(
        'product_id', v_row ->> 'product_id', 'production_date', v_row ->> 'production_date', 'planned_quantity', v_row ->> 'planned_quantity',
        'warehouse_id', v_wh, 'remarks', coalesce(v_row ->> 'remarks', 'Imported from ' || coalesce(v_file ->> 'file_name', 'a spreadsheet')),
        'complete', (v_row ->> 'complete')::boolean, 'actual_quantity', v_row ->> 'actual_quantity', 'rejected_quantity', v_row ->> 'rejected_quantity'),
        gen_random_uuid());
      v_created := v_created || jsonb_build_object('row_number', v_row -> 'row_number', 'sku', v_row ->> 'sku', 'order_id', v_res -> 'order_id',
        'production_order_number', v_res -> 'production_order_number', 'status', v_res -> 'status', 'warnings', v_res -> 'warnings');
    exception when others then
      v_failed := v_failed || jsonb_build_object('row_number', v_row -> 'row_number', 'sku', v_row ->> 'sku', 'messages', jsonb_build_array(sqlerrm));
      v_hist := v_hist || jsonb_build_object('row_number', v_row -> 'row_number', 'outcome', 'FAILED', 'reference', v_row ->> 'sku', 'messages', jsonb_build_array(sqlerrm));
    end;
  end loop;

  v_job := private.import_job_write(v_company, v_uid, jsonb_build_object(
    'import_type', 'PRODUCTION', 'client_job_key', p_idempotency_key, 'file_name', left(v_file ->> 'file_name', 255), 'file_hash', v_hash,
    'status', case when jsonb_array_length(v_created) = 0 then 'FAILED' end,
    'total_rows', jsonb_array_length(v_checked), 'success_rows', jsonb_array_length(v_created), 'failed_rows', jsonb_array_length(v_failed),
    'notes', format('%s production order(s) created, %s row(s) not imported.', jsonb_array_length(v_created), jsonb_array_length(v_failed))), v_hist);

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'job_id', v_job.id, 'created', v_created, 'failed', v_failed,
    'created_count', jsonb_array_length(v_created), 'failed_count', jsonb_array_length(v_failed)));
end;
$$;

-- -----------------------------------------------------------------------------
-- 12. Grants
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.production_v2_preview(uuid, numeric, uuid)',
    'public.production_order_v2_save(uuid, jsonb, uuid)',
    'public.production_order_v2_complete(uuid, jsonb, uuid)',
    'public.production_order_v2_correct(uuid, text, jsonb, uuid)',
    'public.production_order_v2_requirements(uuid)',
    'public.production_bom_add_components(uuid, jsonb, uuid)',
    'public.production_dashboard(date, date)',
    'public.production_import_preview(jsonb, uuid)',
    'public.production_import(jsonb, uuid, jsonb, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
