-- =============================================================================
-- Phase 7: warehouse picking, packing, dispatch and delivery tracking
--
--   PENDING -> PICKING -> PICKED -> PACKING -> PACKED -> READY_FOR_DISPATCH
--     -> DISPATCHED -> IN_TRANSIT -> PARTIALLY_DELIVERED / DELIVERED
--     (DELIVERY_EXCEPTION from any post-dispatch state; CANCELLED before dispatch)
--
-- Picking and packing never change stock. Dispatch posts one ISSUE per
-- fulfilment line (document_type SALES_ORDER) that consumes the line's
-- reservation, so each unit leaves the ledger exactly once. Delivery events
-- never change stock.
-- =============================================================================

-- Why a reserved lot cannot be picked / dispatched now (NULL = OK).
create or replace function private.reservation_problem(p_res public.stock_reservations)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_res.reservation_status not in ('ACTIVE', 'PARTIALLY_FULFILLED') then 'the reservation is ' || lower(p_res.reservation_status)
    when l.stock_usage <> 'STORAGE' then 'the stock is in a non-saleable location'
    when l.status <> 'ACTIVE' or w.status <> 'ACTIVE' then 'the location is inactive'
    when bt.status <> 'ACTIVE' then 'the lot is closed'
    when bt.expiry_date is not null and bt.expiry_date < private.company_today(p_res.company_id) then 'the lot expired on ' || to_char(bt.expiry_date, 'YYYY-MM-DD')
  end
  from public.inventory_locations l
  join public.warehouses w on w.id = l.warehouse_id
  cross join public.inventory_batches bt
  where l.id = p_res.location_id and bt.id = p_res.batch_id;
$$;

revoke all on function private.reservation_problem(public.stock_reservations) from public, anon;
grant execute on function private.reservation_problem(public.stock_reservations) to authenticated;

create or replace function private.lock_fulfilment(p_company uuid, p_id uuid)
returns public.fulfilments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f public.fulfilments;
begin
  select * into v_f from public.fulfilments where id = p_id and company_id = p_company;
  if not found then
    raise exception 'Fulfilment not found in your company.' using errcode = 'P0001';
  end if;
  -- Lock order everywhere: sales order, then fulfilment.
  perform 1 from public.sales_orders where id = v_f.sales_order_id for update;
  select * into v_f from public.fulfilments where id = p_id for update;
  return v_f;
end;
$$;

revoke all on function private.lock_fulfilment(uuid, uuid) from public, anon, authenticated;

create or replace function private.fulfilment_status_label(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(lower(p), '_', ' ');
$$;

revoke all on function private.fulfilment_status_label(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Pick list (fulfilment) creation
-- p_lines: [{reservation_id, quantity}] or null = all free reserved stock of
-- the order in the warehouse.
-- -----------------------------------------------------------------------------
create or replace function public.fulfilment_create(
  p_so_id                 uuid,
  p_warehouse_id          uuid,
  p_lines                 jsonb default null,
  p_planned_dispatch_date date default null,
  p_notes                 text default null,
  p_idempotency_key       uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('fulfilment.pick');
  v_previous jsonb;
  v_so       public.sales_orders;
  v_f        public.fulfilments;
  v_res      record;
  v_r        public.stock_reservations;
  v_problem  text;
  v_qty      numeric;
  v_cap      numeric;
  v_no       int := 0;
  v_status   text;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'fulfilment_create');
  if v_previous is not null then return v_previous; end if;
  select * into v_so from public.sales_orders where id = p_so_id and company_id = v_company for update;
  if not found then
    raise exception 'Sales order not found in your company.' using errcode = 'P0001';
  end if;
  perform private.so_assert_workable(v_so, 'create a pick list');
  perform private.so_check_warehouse(v_company, p_warehouse_id);
  if p_warehouse_id is null then
    raise exception 'Choose the warehouse to pick from.' using errcode = 'P0001';
  end if;
  if p_planned_dispatch_date is not null and p_planned_dispatch_date < private.company_today(v_company) then
    raise exception 'The planned dispatch date cannot be in the past.' using errcode = 'P0001';
  end if;
  if p_lines is not null and (jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0) then
    raise exception 'Select the reserved stock to pick.' using errcode = 'P0001';
  end if;

  insert into public.fulfilments (company_id, fulfilment_number, sales_order_id, warehouse_id, planned_dispatch_date, expected_delivery_date, notes, created_by)
  values (v_company, private.next_document_number(v_company, 'FUL'), v_so.id, p_warehouse_id, p_planned_dispatch_date, v_so.requested_delivery_date,
    nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning * into v_f;

  for v_res in
    select r.*, l.line_no, l.sku_snapshot, l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched as line_remaining
    from public.stock_reservations r
    join public.sales_order_lines l on l.id = r.reference_id and l.sales_order_id = v_so.id
    where r.company_id = v_company and r.reference_type = 'SALES_ORDER_LINE' and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
      and r.warehouse_id = p_warehouse_id
      and (p_lines is null or r.id in (select (e ->> 'reservation_id')::uuid from jsonb_array_elements(p_lines) e))
    order by l.line_no, r.reserved_at, r.reservation_number
    for update of r
  loop
    select * into v_r from public.stock_reservations where id = v_res.id;
    v_problem := private.reservation_problem(v_r);
    if p_lines is null then
      continue when v_problem is not null;
      v_qty := null;
    else
      begin
        select sum((e ->> 'quantity')::numeric) into v_qty from jsonb_array_elements(p_lines) e where (e ->> 'reservation_id')::uuid = v_res.id;
      exception when others then
        raise exception 'Quantities must be numbers.' using errcode = 'P0001';
      end;
      continue when v_qty is null or v_qty = 0;
      if v_problem is not null then
        raise exception 'Reservation % cannot be picked: %.', v_res.reservation_number, v_problem using errcode = 'P0001';
      end if;
    end if;
    -- Free on this reservation and still needed by the line (both exclude open pick lists).
    v_cap := least(v_res.quantity - v_res.fulfilled_quantity - v_res.released_quantity - private.reservation_planned(v_res.id),
                   v_res.line_remaining - private.so_line_planned(v_res.reference_id));
    if v_qty is null then
      v_qty := v_cap;
      continue when v_qty <= 0;
    elsif v_qty < 0 or v_qty <> round(v_qty, 3) or v_qty > v_cap then
      raise exception 'Line % (%), reservation %: pick between 0 and % (reserved stock not already on an open pick list, within the quantity still to dispatch).',
        v_res.line_no, v_res.sku_snapshot, v_res.reservation_number, greatest(v_cap, 0) using errcode = 'P0001';
    end if;
    v_no := v_no + 1;
    insert into public.fulfilment_lines (company_id, fulfilment_id, line_no, sales_order_line_id, product_id, reservation_id, batch_id, location_id, quantity_to_pick)
    values (v_company, v_f.id, v_no, v_res.reference_id, v_res.product_id, v_res.id, v_res.batch_id, v_res.location_id, v_qty);
  end loop;

  if p_lines is not null and exists (
    select 1 from jsonb_array_elements(p_lines) e
    where coalesce((e ->> 'quantity')::numeric, 0) <> 0
      and not exists (select 1 from public.fulfilment_lines fl where fl.fulfilment_id = v_f.id and fl.reservation_id = (e ->> 'reservation_id')::uuid)
  ) then
    raise exception 'A selected reservation does not belong to this order or warehouse.' using errcode = 'P0001';
  end if;
  if v_no = 0 then
    raise exception 'No reserved stock of % in this warehouse is free to pick. Allocate stock to the order first.', v_so.sales_order_number using errcode = 'P0001';
  end if;

  v_status := private.so_recompute(v_so.id);
  perform private.log_so_event(v_company, v_so.id, v_f.id, null, null, 'FULFILMENT_CREATED', null, 'PENDING', p_notes,
    jsonb_build_object('fulfilment_number', v_f.fulfilment_number, 'lines', v_no, 'warehouse_id', p_warehouse_id));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'fulfilment_id', v_f.id, 'fulfilment_number', v_f.fulfilment_number, 'lines', v_no, 'order_status', v_status));
end;
$$;

-- -----------------------------------------------------------------------------
-- Picking (records activity only)
-- p_lines: [{line_id, quantity_picked, exception}]
-- -----------------------------------------------------------------------------
create or replace function public.fulfilment_pick(p_fulfilment_id uuid, p_lines jsonb, p_complete boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('fulfilment.pick');
  v_f       public.fulfilments;
  v_so      public.sales_orders;
  v_entry   jsonb;
  v_line    public.fulfilment_lines;
  v_res     public.stock_reservations;
  v_qty     numeric;
  v_exc     text;
  v_problem text;
  v_bad     text;
  v_to      text;
  v_total   numeric;
begin
  v_f := private.lock_fulfilment(v_company, p_fulfilment_id);
  select * into v_so from public.sales_orders where id = v_f.sales_order_id;
  perform private.so_assert_workable(v_so, 'pick');
  if v_f.fulfilment_status not in ('PENDING', 'PICKING') then
    raise exception 'Picking is closed for % (it is %). Reopen picking first if it must change.', v_f.fulfilment_number,
      private.fulfilment_status_label(v_f.fulfilment_status) using errcode = 'P0001';
  end if;
  if p_lines is not null and jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Picked quantities must be a list.' using errcode = 'P0001';
  end if;

  for v_entry in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    select * into v_line from public.fulfilment_lines where id = (v_entry ->> 'line_id')::uuid and fulfilment_id = v_f.id for update;
    if not found then
      raise exception 'A pick line does not belong to this fulfilment.' using errcode = 'P0001';
    end if;
    begin
      v_qty := (v_entry ->> 'quantity_picked')::numeric;
    exception when others then
      raise exception 'Picked quantities must be numbers.' using errcode = 'P0001';
    end;
    v_exc := nullif(btrim(coalesce(v_entry ->> 'exception', '')), '');
    if v_qty is null or v_qty < 0 or v_qty <> round(v_qty, 3) or v_qty > v_line.quantity_to_pick then
      raise exception 'Line %: picked quantity must be between 0 and % (the quantity on the pick list).', v_line.line_no, v_line.quantity_to_pick using errcode = 'P0001';
    end if;
    if v_exc is not null and length(v_exc) > 500 then
      raise exception 'Line %: the exception note is too long.', v_line.line_no using errcode = 'P0001';
    end if;
    if v_qty > 0 then
      select * into v_res from public.stock_reservations where id = v_line.reservation_id;
      v_problem := private.reservation_problem(v_res);
      if v_problem is not null then
        raise exception 'Line %: this stock cannot be picked because %. Record a pick exception with quantity 0 instead.', v_line.line_no, v_problem using errcode = 'P0001';
      end if;
    end if;
    update public.fulfilment_lines
    set quantity_picked = v_qty, pick_exception = v_exc, picked_by = auth.uid(), picked_at = now()
    where id = v_line.id and (quantity_picked is distinct from v_qty or pick_exception is distinct from v_exc);
  end loop;

  select coalesce(sum(quantity_picked), 0) into v_total from public.fulfilment_lines where fulfilment_id = v_f.id;
  if coalesce(p_complete, false) then
    select string_agg(format('line %s (picked %s of %s)', line_no, quantity_picked, quantity_to_pick), ', ') into v_bad
    from public.fulfilment_lines where fulfilment_id = v_f.id and quantity_picked < quantity_to_pick and pick_exception is null;
    if v_bad is not null then
      raise exception 'Record a pick exception (reason) for short-picked lines: %.', v_bad using errcode = 'P0001';
    end if;
    if v_total = 0 then
      raise exception 'Nothing was picked. Cancel the fulfilment instead of completing it.' using errcode = 'P0001';
    end if;
    v_to := 'PICKED';
    update public.fulfilments set fulfilment_status = 'PICKED', picked_at = now() where id = v_f.id;
  else
    v_to := 'PICKING';
    update public.fulfilments set fulfilment_status = 'PICKING' where id = v_f.id and fulfilment_status <> 'PICKING';
  end if;
  perform private.log_so_event(v_company, v_f.sales_order_id, v_f.id, null, null, case when v_to = 'PICKED' then 'PICKING_COMPLETED' else 'PICK_RECORDED' end,
    v_f.fulfilment_status, v_to, null, jsonb_build_object('fulfilment_number', v_f.fulfilment_number, 'picked', v_total, 'lines', coalesce(p_lines, '[]'::jsonb)));
  perform private.so_recompute(v_f.sales_order_id);
  return jsonb_build_object('status', v_to, 'picked', v_total);
end;
$$;

-- -----------------------------------------------------------------------------
-- Packing and verification (records activity only)
-- p_lines: [{line_id, quantity_packed, quantity_damaged, exception}]
-- -----------------------------------------------------------------------------
create or replace function public.fulfilment_pack(p_fulfilment_id uuid, p_lines jsonb, p_packing_notes text default null, p_complete boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('fulfilment.pack');
  v_f       public.fulfilments;
  v_so      public.sales_orders;
  v_entry   jsonb;
  v_line    public.fulfilment_lines;
  v_packed  numeric;
  v_damaged numeric;
  v_exc     text;
  v_bad     text;
  v_total   numeric;
  v_to      text;
  v_notes   text := nullif(btrim(coalesce(p_packing_notes, '')), '');
begin
  v_f := private.lock_fulfilment(v_company, p_fulfilment_id);
  select * into v_so from public.sales_orders where id = v_f.sales_order_id;
  perform private.so_assert_workable(v_so, 'pack');
  if v_f.fulfilment_status not in ('PICKED', 'PACKING') then
    raise exception '% cannot be packed while it is % (complete picking first, or reopen packing).', v_f.fulfilment_number,
      private.fulfilment_status_label(v_f.fulfilment_status) using errcode = 'P0001';
  end if;
  if v_notes is not null and length(v_notes) > 1000 then
    raise exception 'Packing notes are too long.' using errcode = 'P0001';
  end if;

  for v_entry in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    select * into v_line from public.fulfilment_lines where id = (v_entry ->> 'line_id')::uuid and fulfilment_id = v_f.id for update;
    if not found then
      raise exception 'A packing line does not belong to this fulfilment.' using errcode = 'P0001';
    end if;
    begin
      v_packed := coalesce((v_entry ->> 'quantity_packed')::numeric, 0);
      v_damaged := coalesce((v_entry ->> 'quantity_damaged')::numeric, 0);
    exception when others then
      raise exception 'Packed and damaged quantities must be numbers.' using errcode = 'P0001';
    end;
    v_exc := nullif(btrim(coalesce(v_entry ->> 'exception', '')), '');
    if v_packed < 0 or v_damaged < 0 or v_packed <> round(v_packed, 3) or v_damaged <> round(v_damaged, 3) or v_packed + v_damaged > v_line.quantity_picked then
      raise exception 'Line %: packed (%) plus damaged/missing (%) cannot exceed the picked quantity (%).', v_line.line_no, v_packed, v_damaged, v_line.quantity_picked
        using errcode = 'P0001';
    end if;
    if v_damaged > 0 and v_exc is null then
      raise exception 'Line %: describe the damaged or missing items.', v_line.line_no using errcode = 'P0001';
    end if;
    if v_exc is not null and length(v_exc) > 500 then
      raise exception 'Line %: the exception note is too long.', v_line.line_no using errcode = 'P0001';
    end if;
    update public.fulfilment_lines
    set quantity_packed = v_packed, quantity_damaged = v_damaged, pack_exception = v_exc, packed_by = auth.uid(), packed_at = now()
    where id = v_line.id;
  end loop;

  select coalesce(sum(quantity_packed), 0) into v_total from public.fulfilment_lines where fulfilment_id = v_f.id;
  if coalesce(p_complete, false) then
    select string_agg(format('line %s (packed %s of %s picked)', line_no, quantity_packed, quantity_picked), ', ') into v_bad
    from public.fulfilment_lines where fulfilment_id = v_f.id and quantity_packed + quantity_damaged < quantity_picked and pack_exception is null;
    if v_bad is not null then
      raise exception 'Verify every picked item or record a packing exception: %.', v_bad using errcode = 'P0001';
    end if;
    if v_total = 0 then
      raise exception 'Nothing was packed. Reopen picking or cancel the fulfilment.' using errcode = 'P0001';
    end if;
    v_to := 'PACKED';
    update public.fulfilments set fulfilment_status = 'PACKED', packed_at = now(), packing_notes = coalesce(v_notes, packing_notes) where id = v_f.id;
  else
    v_to := 'PACKING';
    update public.fulfilments set fulfilment_status = 'PACKING', packing_notes = coalesce(v_notes, packing_notes) where id = v_f.id;
  end if;
  perform private.log_so_event(v_company, v_f.sales_order_id, v_f.id, null, null, case when v_to = 'PACKED' then 'PACKING_COMPLETED' else 'PACK_RECORDED' end,
    v_f.fulfilment_status, v_to, v_notes, jsonb_build_object('fulfilment_number', v_f.fulfilment_number, 'packed', v_total, 'lines', coalesce(p_lines, '[]'::jsonb)));
  return jsonb_build_object('status', v_to, 'packed', v_total);
end;
$$;

-- READY | REOPEN_PACKING | REOPEN_PICKING | CANCEL
create or replace function public.fulfilment_action(p_fulfilment_id uuid, p_action text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_f       public.fulfilments;
  v_so      public.sales_orders;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_line    record;
  v_problem text;
  v_to      text;
begin
  case p_action
    when 'READY' then v_company := private.require_permission('fulfilment.pack');
    when 'REOPEN_PACKING' then v_company := private.require_permission('fulfilment.pack');
    when 'REOPEN_PICKING' then v_company := private.require_permission('fulfilment.pick');
    when 'CANCEL' then v_company := private.require_any_permission(array['fulfilment.pick', 'sales_orders.cancel']);
    else raise exception 'Unknown action %.', p_action using errcode = 'P0001';
  end case;
  v_f := private.lock_fulfilment(v_company, p_fulfilment_id);
  select * into v_so from public.sales_orders where id = v_f.sales_order_id;
  if p_action <> 'READY' and (v_reason is null or length(v_reason) < 3) then
    raise exception 'Enter the reason.' using errcode = 'P0001';
  end if;
  if v_reason is not null and length(v_reason) > 500 then
    raise exception 'The reason is too long.' using errcode = 'P0001';
  end if;

  if p_action = 'READY' then
    perform private.so_assert_workable(v_so, 'release goods for dispatch');
    if v_f.fulfilment_status <> 'PACKED' then
      raise exception 'Only a packed fulfilment can be marked ready for dispatch (% is %).', v_f.fulfilment_number,
        private.fulfilment_status_label(v_f.fulfilment_status) using errcode = 'P0001';
    end if;
    for v_line in
      select fl.line_no, fl.quantity_packed, r as res, r.quantity - r.fulfilled_quantity - r.released_quantity as remaining
      from public.fulfilment_lines fl join public.stock_reservations r on r.id = fl.reservation_id
      where fl.fulfilment_id = v_f.id and fl.quantity_packed > 0
    loop
      v_problem := private.reservation_problem(v_line.res);
      if v_problem is null and v_line.remaining < v_line.quantity_packed then
        v_problem := format('only %s is still reserved', v_line.remaining);
      end if;
      if v_problem is not null then
        raise exception 'Line % cannot be dispatched: %. Reopen picking to correct it.', v_line.line_no, v_problem using errcode = 'P0001';
      end if;
    end loop;
    v_to := 'READY_FOR_DISPATCH';
    update public.fulfilments set fulfilment_status = v_to, ready_at = now() where id = v_f.id;
  elsif p_action = 'REOPEN_PACKING' then
    if v_f.fulfilment_status not in ('PACKED', 'READY_FOR_DISPATCH') then
      raise exception 'Only packed fulfilments can be reopened for packing.' using errcode = 'P0001';
    end if;
    v_to := 'PACKING';
    update public.fulfilments set fulfilment_status = v_to, reopen_reason = v_reason, ready_at = null where id = v_f.id;
  elsif p_action = 'REOPEN_PICKING' then
    if v_f.fulfilment_status not in ('PICKED', 'PACKING', 'PACKED', 'READY_FOR_DISPATCH') then
      raise exception 'Picking can only be reopened before dispatch, after it was completed.' using errcode = 'P0001';
    end if;
    v_to := 'PICKING';
    update public.fulfilment_lines set quantity_packed = 0, quantity_damaged = 0, pack_exception = null, packed_by = null, packed_at = null
    where fulfilment_id = v_f.id;
    update public.fulfilments set fulfilment_status = v_to, reopen_reason = v_reason, picked_at = null, packed_at = null, ready_at = null where id = v_f.id;
  else
    if v_f.fulfilment_status not in ('PENDING', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'READY_FOR_DISPATCH') then
      raise exception 'A % fulfilment cannot be cancelled. Use Customer Returns for dispatched goods.', private.fulfilment_status_label(v_f.fulfilment_status)
        using errcode = 'P0001';
    end if;
    v_to := 'CANCELLED';
    update public.fulfilments set fulfilment_status = v_to, cancel_reason = v_reason, cancelled_by = auth.uid(), cancelled_at = now() where id = v_f.id;
  end if;

  perform private.log_so_event(v_company, v_f.sales_order_id, v_f.id, null, null, 'FULFILMENT_' || p_action, v_f.fulfilment_status, v_to, v_reason,
    jsonb_build_object('fulfilment_number', v_f.fulfilment_number));
  perform private.so_recompute(v_f.sales_order_id);
  return jsonb_build_object('status', v_to);
end;
$$;

-- -----------------------------------------------------------------------------
-- Dispatch: the only place stock leaves for a sales order.
-- p_details: {carrier_name, transport_mode, vehicle_number, lr_number, tracking_number, eway_bill_number,
--             delivery_reference, document_references, notes, dispatched_at, expected_delivery_date}
-- -----------------------------------------------------------------------------
create or replace function public.fulfilment_dispatch(p_fulfilment_id uuid, p_details jsonb default '{}'::jsonb, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_permission('fulfilment.dispatch');
  v_previous  jsonb;
  v_f         public.fulfilments;
  v_so        public.sales_orders;
  v_d         jsonb := coalesce(p_details, '{}'::jsonb);
  v_at        timestamptz;
  v_expected  date;
  v_mode      text := upper(nullif(btrim(coalesce(p_details ->> 'transport_mode', '')), ''));
  v_field     text;
  v_line      record;
  v_res       public.stock_reservations;
  v_sol       public.sales_order_lines;
  v_problem   text;
  v_remain    numeric;
  v_tx        uuid;
  v_numbers   text[] := '{}';
  v_total     numeric := 0;
  v_status    text;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'fulfilment_dispatch');
  if v_previous is not null then return v_previous; end if;
  v_f := private.lock_fulfilment(v_company, p_fulfilment_id);
  select * into v_so from public.sales_orders where id = v_f.sales_order_id;
  if v_f.fulfilment_status <> 'READY_FOR_DISPATCH' then
    raise exception 'Only a fulfilment marked ready for dispatch can be dispatched (% is %).', v_f.fulfilment_number,
      private.fulfilment_status_label(v_f.fulfilment_status) using errcode = 'P0001';
  end if;
  perform private.so_assert_workable(v_so, 'dispatch');

  begin
    v_at := coalesce(nullif(v_d ->> 'dispatched_at', '')::timestamptz, now());
    v_expected := coalesce(nullif(v_d ->> 'expected_delivery_date', '')::date, v_f.expected_delivery_date);
  exception when others then
    raise exception 'Enter a valid dispatch date/time and expected delivery date.' using errcode = 'P0001';
  end;
  if v_at > now() + interval '5 minutes' then
    raise exception 'The dispatch time cannot be in the future.' using errcode = 'P0001';
  end if;
  if v_at < v_f.created_at - interval '1 minute' then
    raise exception 'The dispatch time cannot be before the pick list was created (%).', v_f.created_at using errcode = 'P0001';
  end if;
  if v_expected is not null and v_expected < (v_at at time zone private.company_tz(v_company))::date then
    raise exception 'The expected delivery date cannot be before the dispatch date.' using errcode = 'P0001';
  end if;
  if v_mode is not null and v_mode not in ('ROAD', 'RAIL', 'AIR', 'SEA', 'COURIER', 'CUSTOMER_PICKUP', 'OTHER') then
    raise exception 'Unknown transport mode %.', v_mode using errcode = 'P0001';
  end if;
  for v_field in select jsonb_array_elements_text(private.fulfilment_policy(v_company) -> 'dispatch_required_fields') loop
    if nullif(btrim(coalesce(v_d ->> v_field, '')), '') is null then
      raise exception 'Company dispatch policy requires: %.', replace(replace(v_field, '_', ' '), 'lr number', 'LR / consignment note number') using errcode = 'P0001';
    end if;
  end loop;

  for v_line in select * from public.fulfilment_lines where fulfilment_id = v_f.id and quantity_packed > 0 order by line_no loop
    select * into v_res from public.stock_reservations where id = v_line.reservation_id for update;
    if v_res.reference_type <> 'SALES_ORDER_LINE' or v_res.company_id <> v_company
       or not exists (select 1 from public.sales_order_lines where id = v_res.reference_id and sales_order_id = v_so.id) then
      raise exception 'Line %: the reservation does not belong to this sales order.', v_line.line_no using errcode = 'P0001';
    end if;
    v_problem := private.reservation_problem(v_res);
    if v_problem is not null then
      raise exception 'Line % cannot be dispatched: %. Nothing was dispatched.', v_line.line_no, v_problem using errcode = 'P0001';
    end if;
    v_remain := v_res.quantity - v_res.fulfilled_quantity - v_res.released_quantity;
    if v_line.quantity_packed > v_remain then
      raise exception 'Line %: only % is still reserved on %; % packed. Nothing was dispatched.', v_line.line_no, v_remain, v_res.reservation_number,
        v_line.quantity_packed using errcode = 'P0001';
    end if;
    select * into v_sol from public.sales_order_lines where id = v_line.sales_order_line_id for update;
    if v_sol.quantity_dispatched + v_line.quantity_packed > v_sol.quantity_ordered - v_sol.quantity_cancelled then
      raise exception 'Line % (%): dispatching % would exceed the order (ordered %, cancelled %, already dispatched %). Nothing was dispatched.',
        v_sol.line_no, v_sol.sku_snapshot, v_line.quantity_packed, v_sol.quantity_ordered, v_sol.quantity_cancelled, v_sol.quantity_dispatched using errcode = 'P0001';
    end if;

    v_tx := private.post_movement(v_company, 'ISSUE', v_res.batch_id, v_res.location_id, v_line.quantity_packed, null,
      'FULFILMENT', v_f.fulfilment_number, v_line.id,
      'Dispatch ' || v_f.fulfilment_number || ' for sales order ' || v_so.sales_order_number || ' (' || v_so.customer_name_snapshot || ')',
      nullif(btrim(coalesce(v_d ->> 'notes', '')), ''), v_at, 'SALES_ORDER', v_so.id, null, null, null, v_line.quantity_packed);
    update public.stock_reservations
    set fulfilled_quantity = fulfilled_quantity + v_line.quantity_packed,
        reservation_status = case when v_remain - v_line.quantity_packed = 0 then 'FULFILLED' else 'PARTIALLY_FULFILLED' end, updated_at = now()
    where id = v_res.id;
    update public.fulfilment_lines set quantity_dispatched = v_line.quantity_packed, issue_transaction_id = v_tx where id = v_line.id;
    update public.sales_order_lines set quantity_dispatched = quantity_dispatched + v_line.quantity_packed where id = v_sol.id;
    if v_sol.customer_purchase_order_line_id is not null then
      update public.customer_purchase_order_lines set quantity_dispatched = quantity_dispatched + v_line.quantity_packed where id = v_sol.customer_purchase_order_line_id;
    end if;
    v_numbers := v_numbers || (select transaction_number from public.inventory_transactions where id = v_tx);
    v_total := v_total + v_line.quantity_packed;
  end loop;
  if v_total = 0 then
    raise exception 'Nothing is packed on %.', v_f.fulfilment_number using errcode = 'P0001';
  end if;

  update public.fulfilments set
    fulfilment_status = 'DISPATCHED', actual_dispatch_at = v_at, dispatched_by = auth.uid(), expected_delivery_date = v_expected,
    carrier_name = private.so_header_value(v_d, 'carrier_name', 120), transport_mode = v_mode,
    vehicle_number = upper(private.so_header_value(v_d, 'vehicle_number', 20)), lr_number = private.so_header_value(v_d, 'lr_number', 50),
    tracking_number = private.so_header_value(v_d, 'tracking_number', 100), eway_bill_number = private.so_header_value(v_d, 'eway_bill_number', 30),
    delivery_reference = private.so_header_value(v_d, 'delivery_reference', 100), document_references = private.so_header_value(v_d, 'document_references', 500),
    dispatch_notes = private.so_header_value(v_d, 'notes', 1000)
  where id = v_f.id;
  insert into public.delivery_events (company_id, fulfilment_id, event_type, event_at, description, reference_number, source, recorded_by)
  values (v_company, v_f.id, 'DISPATCHED', v_at, 'Dispatch posted: ' || array_to_string(v_numbers, ', '),
    coalesce(private.so_header_value(v_d, 'tracking_number', 100), private.so_header_value(v_d, 'lr_number', 50)), 'SYSTEM', auth.uid());

  v_status := private.so_recompute(v_so.id);
  perform private.log_so_event(v_company, v_so.id, v_f.id, null, null, 'DISPATCHED', v_f.fulfilment_status, 'DISPATCHED', private.so_header_value(v_d, 'notes', 1000),
    jsonb_build_object('fulfilment_number', v_f.fulfilment_number, 'transaction_numbers', to_jsonb(v_numbers), 'quantity', v_total));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'transaction_numbers', to_jsonb(v_numbers), 'dispatched_quantity', v_total, 'fulfilment_status', 'DISPATCHED', 'order_status', v_status));
end;
$$;

-- -----------------------------------------------------------------------------
-- Delivery events (no stock change)
-- p_lines (PARTIALLY_DELIVERED / DELIVERED): [{line_id, quantity}] delivered in this event
-- -----------------------------------------------------------------------------
create or replace function public.fulfilment_record_delivery(
  p_fulfilment_id   uuid,
  p_event_type      text,
  p_event_at        timestamptz default null,
  p_location        text default null,
  p_description     text default null,
  p_reference       text default null,
  p_failure_reason  text default null,
  p_lines           jsonb default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('fulfilment_delivery.update');
  v_previous jsonb;
  v_f        public.fulfilments;
  v_at       timestamptz := coalesce(p_event_at, now());
  v_reason   text := nullif(btrim(coalesce(p_failure_reason, '')), '');
  v_desc     text := nullif(btrim(coalesce(p_description, '')), '');
  v_entry    jsonb;
  v_line     public.fulfilment_lines;
  v_qty      numeric;
  v_applied  jsonb := '[]'::jsonb;
  v_to       text;
  v_left     numeric;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'delivery_event');
  if v_previous is not null then return v_previous; end if;
  v_f := private.lock_fulfilment(v_company, p_fulfilment_id);
  if v_f.fulfilment_status = 'DELIVERED' then
    raise exception '% is already delivered.', v_f.fulfilment_number using errcode = 'P0001';
  end if;
  if v_f.fulfilment_status not in ('DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED', 'DELIVERY_EXCEPTION') then
    raise exception 'Delivery can only be tracked after dispatch has been posted (% is %).', v_f.fulfilment_number,
      private.fulfilment_status_label(v_f.fulfilment_status) using errcode = 'P0001';
  end if;
  if p_event_type not in ('PICKED_UP', 'IN_TRANSIT', 'ARRIVED', 'OUT_FOR_DELIVERY', 'PARTIALLY_DELIVERED', 'DELIVERED', 'DELIVERY_FAILED', 'RETURNED_TO_SENDER', 'EXCEPTION') then
    raise exception 'Unknown delivery event %.', p_event_type using errcode = 'P0001';
  end if;
  if v_at > now() + interval '5 minutes' then
    raise exception 'Delivery events cannot be dated in the future.' using errcode = 'P0001';
  end if;
  if v_at < v_f.actual_dispatch_at - interval '1 minute' then
    raise exception 'The event cannot be before the dispatch (%).', v_f.actual_dispatch_at using errcode = 'P0001';
  end if;
  if coalesce(length(p_location), 0) > 200 or coalesce(length(v_desc), 0) > 1000 or coalesce(length(p_reference), 0) > 100 or coalesce(length(v_reason), 0) > 500 then
    raise exception 'A delivery event field is too long.' using errcode = 'P0001';
  end if;

  if p_event_type in ('PICKED_UP', 'IN_TRANSIT', 'ARRIVED', 'OUT_FOR_DELIVERY') then
    v_to := case when v_f.fulfilment_status = 'PARTIALLY_DELIVERED' then 'PARTIALLY_DELIVERED' else 'IN_TRANSIT' end;
  elsif p_event_type in ('DELIVERY_FAILED', 'RETURNED_TO_SENDER', 'EXCEPTION') then
    if v_reason is null and v_desc is null then
      raise exception 'Record the reason for the delivery failure or exception.' using errcode = 'P0001';
    end if;
    v_to := 'DELIVERY_EXCEPTION';
  else
    if p_lines is not null and jsonb_typeof(p_lines) = 'array' and jsonb_array_length(p_lines) > 0 then
      for v_entry in select value from jsonb_array_elements(p_lines) loop
        select * into v_line from public.fulfilment_lines where id = (v_entry ->> 'line_id')::uuid and fulfilment_id = v_f.id for update;
        if not found then
          raise exception 'A delivered line does not belong to this fulfilment.' using errcode = 'P0001';
        end if;
        begin
          v_qty := (v_entry ->> 'quantity')::numeric;
        exception when others then
          raise exception 'Delivered quantities must be numbers.' using errcode = 'P0001';
        end;
        continue when v_qty is null or v_qty = 0;
        if v_qty < 0 or v_qty <> round(v_qty, 3) or v_line.quantity_delivered + v_qty > v_line.quantity_dispatched then
          raise exception 'Line %: delivered quantity cannot exceed the dispatched quantity (% dispatched, % already delivered).', v_line.line_no,
            v_line.quantity_dispatched, v_line.quantity_delivered using errcode = 'P0001';
        end if;
        update public.fulfilment_lines set quantity_delivered = quantity_delivered + v_qty where id = v_line.id;
        update public.sales_order_lines set quantity_delivered = quantity_delivered + v_qty where id = v_line.sales_order_line_id;
        v_applied := v_applied || jsonb_build_object('line_id', v_line.id, 'line_no', v_line.line_no, 'quantity', v_qty);
      end loop;
    elsif p_event_type = 'DELIVERED' then
      for v_line in select * from public.fulfilment_lines where fulfilment_id = v_f.id and quantity_delivered < quantity_dispatched for update loop
        update public.fulfilment_lines set quantity_delivered = quantity_dispatched where id = v_line.id;
        update public.sales_order_lines set quantity_delivered = quantity_delivered + (v_line.quantity_dispatched - v_line.quantity_delivered)
        where id = v_line.sales_order_line_id;
        v_applied := v_applied || jsonb_build_object('line_id', v_line.id, 'line_no', v_line.line_no, 'quantity', v_line.quantity_dispatched - v_line.quantity_delivered);
      end loop;
    else
      raise exception 'Enter the delivered quantity for each line of the partial delivery.' using errcode = 'P0001';
    end if;
    if jsonb_array_length(v_applied) = 0 then
      raise exception 'Enter at least one delivered quantity.' using errcode = 'P0001';
    end if;
    select coalesce(sum(quantity_dispatched - quantity_delivered), 0) into v_left from public.fulfilment_lines where fulfilment_id = v_f.id;
    if p_event_type = 'DELIVERED' and v_left > 0 then
      raise exception 'The quantities do not cover the whole consignment (% still undelivered). Record a partial delivery instead.', v_left using errcode = 'P0001';
    end if;
    v_to := case when v_left = 0 then 'DELIVERED' else 'PARTIALLY_DELIVERED' end;
  end if;

  update public.fulfilments set
    fulfilment_status = v_to,
    delivered_at = case when v_to = 'DELIVERED' then v_at else delivered_at end,
    exception_reason = case when v_to = 'DELIVERY_EXCEPTION' then coalesce(v_reason, left(v_desc, 500)) else exception_reason end
  where id = v_f.id;
  insert into public.delivery_events (company_id, fulfilment_id, event_type, event_at, location, description, reference_number, failure_reason,
    delivered_quantities, source, recorded_by)
  values (v_company, v_f.id, case when p_event_type = 'DELIVERED' and v_to = 'PARTIALLY_DELIVERED' then 'PARTIALLY_DELIVERED' else p_event_type end, v_at,
    nullif(btrim(coalesce(p_location, '')), ''), v_desc, nullif(btrim(coalesce(p_reference, '')), ''), v_reason, v_applied, 'MANUAL', auth.uid());
  perform private.log_so_event(v_company, v_f.sales_order_id, v_f.id, null, null, 'DELIVERY_' || p_event_type, v_f.fulfilment_status, v_to, coalesce(v_reason, v_desc),
    jsonb_build_object('fulfilment_number', v_f.fulfilment_number, 'event_at', v_at, 'delivered', v_applied));
  perform private.so_recompute(v_f.sales_order_id);
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('status', v_to, 'delivered', v_applied));
end;
$$;

-- -----------------------------------------------------------------------------
-- Views
-- -----------------------------------------------------------------------------
create or replace view public.fulfilment_list
with (security_invoker = true) as
select f.*,
  so.sales_order_number, so.customer_name_snapshot, so.customer_id, so.customer_key, so.customer_po_number, so.order_status, so.priority,
  so.requested_delivery_date as order_requested_date, so.shipping_address_snapshot,
  w.warehouse_code, w.warehouse_name,
  t.line_count, t.to_pick, t.picked, t.packed, t.damaged, t.dispatched, t.delivered, t.units, t.pick_exceptions, t.pack_exceptions,
  (f.fulfilment_status in ('DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED', 'DELIVERY_EXCEPTION') and f.expected_delivery_date < private.so_today()) as is_overdue,
  case when f.delivered_at is not null and f.expected_delivery_date is not null
       then (f.delivered_at at time zone coalesce((select timezone from public.companies where id = f.company_id), 'UTC'))::date - f.expected_delivery_date end as delivery_days_late,
  e.event_type as last_event_type, e.event_at as last_event_at, e.location as last_event_location
from public.fulfilments f
join public.sales_orders so on so.id = f.sales_order_id
join public.warehouses w on w.id = f.warehouse_id
left join lateral (
  select count(*)::int as line_count, sum(fl.quantity_to_pick) as to_pick, sum(fl.quantity_picked) as picked, sum(fl.quantity_packed) as packed,
    sum(fl.quantity_damaged) as damaged, sum(fl.quantity_dispatched) as dispatched, sum(fl.quantity_delivered) as delivered,
    string_agg(distinct p.base_unit, ', ') as units,
    count(*) filter (where fl.pick_exception is not null)::int as pick_exceptions,
    count(*) filter (where fl.pack_exception is not null or fl.quantity_damaged > 0)::int as pack_exceptions
  from public.fulfilment_lines fl join public.products p on p.id = fl.product_id where fl.fulfilment_id = f.id
) t on true
left join lateral (
  select de.event_type, de.event_at, de.location from public.delivery_events de where de.fulfilment_id = f.id order by de.event_at desc, de.created_at desc limit 1
) e on true;

create or replace view public.fulfilment_line_list
with (security_invoker = true) as
select fl.*,
  f.fulfilment_number, f.fulfilment_status, f.sales_order_id, f.warehouse_id,
  so.sales_order_number, so.customer_name_snapshot,
  sol.line_no as order_line_no, sol.quantity_ordered, sol.quantity_cancelled, sol.quantity_dispatched as order_line_dispatched,
  sol.quantity_ordered - sol.quantity_cancelled - sol.quantity_dispatched as order_line_remaining,
  p.sku, p.product_name, p.barcode, p.base_unit as unit,
  bt.batch_number, bt.expiry_date, bt.source_type,
  w.warehouse_code, loc.location_code,
  r.reservation_number, r.quantity - r.fulfilled_quantity - r.released_quantity as reservation_remaining,
  private.reservation_problem(r) as stock_problem,
  t.transaction_number as issue_transaction_number
from public.fulfilment_lines fl
join public.fulfilments f on f.id = fl.fulfilment_id
join public.sales_orders so on so.id = f.sales_order_id
join public.sales_order_lines sol on sol.id = fl.sales_order_line_id
join public.products p on p.id = fl.product_id
join public.inventory_batches bt on bt.id = fl.batch_id
join public.inventory_locations loc on loc.id = fl.location_id
join public.warehouses w on w.id = loc.warehouse_id
join public.stock_reservations r on r.id = fl.reservation_id
left join public.inventory_transactions t on t.id = fl.issue_transaction_id;

revoke all on public.fulfilment_list, public.fulfilment_line_list from anon, authenticated;
grant select on public.fulfilment_list, public.fulfilment_line_list to authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.fulfilment_create(uuid, uuid, jsonb, date, text, uuid)', 'public.fulfilment_pick(uuid, jsonb, boolean)',
    'public.fulfilment_pack(uuid, jsonb, text, boolean)', 'public.fulfilment_action(uuid, text, text)', 'public.fulfilment_dispatch(uuid, jsonb, uuid)',
    'public.fulfilment_record_delivery(uuid, text, timestamptz, text, text, text, text, jsonb, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
