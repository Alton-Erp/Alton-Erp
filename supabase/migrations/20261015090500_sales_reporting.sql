-- =============================================================================
-- Phase 7: sales overview and fulfilment reports (real records only)
--
-- Order quantities and PO prices are operational data, never revenue (no
-- accounting in this phase). Dispatch / delivery reports use the actual
-- dispatch and delivery dates, never the order date.
-- =============================================================================

create or replace function public.sales_overview(
  p_from            date,
  p_to              date,
  p_customer_id     uuid default null,
  p_warehouse_id    uuid default null,
  p_order_status    text default null,
  p_dispatch_status text default null,
  p_delivery_status text default null,
  p_bucket          text default 'day'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['sales_orders.read', 'fulfilment_reports.read']);
  v_tz      text := private.company_tz(v_company);
  v_today   date := private.company_today(v_company);
  v_result  jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Choose a valid date range (at most about 10 years).' using errcode = 'P0001';
  end if;
  if p_bucket not in ('day', 'week', 'month', 'year') then
    raise exception 'Bucket must be day, week, month or year.' using errcode = 'P0001';
  end if;

  with o as (
    select so.*,
      exists (select 1 from public.fulfilments f where f.sales_order_id = so.id and f.fulfilment_status in ('DISPATCHED', 'IN_TRANSIT')) as in_transit,
      exists (select 1 from public.fulfilments f where f.sales_order_id = so.id and f.fulfilment_status in ('PENDING', 'PICKING')) as picking,
      exists (select 1 from public.fulfilments f where f.sales_order_id = so.id and f.fulfilment_status in ('PICKED', 'PACKING', 'PACKED')) as packing,
      exists (select 1 from public.fulfilments f where f.sales_order_id = so.id and f.fulfilment_status = 'READY_FOR_DISPATCH') as ready_dispatch,
      exists (select 1 from public.fulfilments f where f.sales_order_id = so.id and f.fulfilment_status = 'DELIVERY_EXCEPTION') as delivery_exception,
      exists (select 1 from public.stock_reservations r join public.sales_order_lines l on l.id = r.reference_id
              where l.sales_order_id = so.id and r.reference_type = 'SALES_ORDER_LINE' and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
                and r.quantity - r.fulfilled_quantity - r.released_quantity > private.reservation_planned(r.id)) as free_reserved,
      exists (select 1 from public.fulfilments f where f.sales_order_id = so.id and (
        exists (select 1 from public.fulfilment_lines fl where fl.fulfilment_id = f.id and (fl.pick_exception is not null or fl.quantity_damaged > 0))
        or (f.fulfilment_status in ('DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED') and f.expected_delivery_date < v_today))) as other_exception
    from public.sales_orders so
    where so.company_id = v_company and so.order_date between p_from and p_to
      and (p_customer_id is null or so.customer_id = p_customer_id)
      and (p_warehouse_id is null or so.warehouse_id = p_warehouse_id
           or exists (select 1 from public.fulfilments f where f.sales_order_id = so.id and f.warehouse_id = p_warehouse_id))
      and (p_order_status is null or so.order_status = p_order_status)
      and (p_dispatch_status is null
           or (p_dispatch_status = 'NOT_DISPATCHED' and so.fulfilment_status in ('NOT_STARTED', 'IN_PROGRESS'))
           or (p_dispatch_status = 'PARTIALLY_DISPATCHED' and so.fulfilment_status = 'PARTIALLY_DISPATCHED')
           or (p_dispatch_status = 'DISPATCHED' and so.fulfilment_status in ('DISPATCHED', 'PARTIALLY_DELIVERED', 'DELIVERED')))
      and (p_delivery_status is null
           or (p_delivery_status = 'NOT_DELIVERED' and so.fulfilment_status not in ('PARTIALLY_DELIVERED', 'DELIVERED'))
           or (p_delivery_status = 'PARTIALLY_DELIVERED' and so.fulfilment_status = 'PARTIALLY_DELIVERED')
           or (p_delivery_status = 'DELIVERED' and so.fulfilment_status = 'DELIVERED')
           or (p_delivery_status = 'EXCEPTION' and exists (select 1 from public.fulfilments f where f.sales_order_id = so.id and f.fulfilment_status = 'DELIVERY_EXCEPTION')))
  ),
  lines as (
    select l.*, o.order_status, o.warehouse_id as order_wh from public.sales_order_lines l join o on o.id = l.sales_order_id
  ),
  dispatches as (
    select t.quantity, t.unit, t.transaction_date, t.warehouse_id
    from public.inventory_transactions t
    join public.sales_orders so on so.id = t.document_id
    where t.company_id = v_company and t.document_type = 'SALES_ORDER' and t.transaction_type = 'ISSUE'
      and (t.transaction_date at time zone v_tz)::date between p_from and p_to
      and (p_customer_id is null or so.customer_id = p_customer_id)
      and (p_warehouse_id is null or t.warehouse_id = p_warehouse_id)
  ),
  delivered as (
    select f.*, (f.delivered_at at time zone v_tz)::date as delivered_date
    from public.fulfilments f join public.sales_orders so on so.id = f.sales_order_id
    where f.company_id = v_company and f.fulfilment_status = 'DELIVERED' and (f.delivered_at at time zone v_tz)::date between p_from and p_to
      and (p_customer_id is null or so.customer_id = p_customer_id) and (p_warehouse_id is null or f.warehouse_id = p_warehouse_id)
  )
  select jsonb_build_object(
    'has_records', exists (select 1 from public.sales_orders where company_id = v_company),
    'total_orders', (select count(*) from o),
    'awaiting_confirmation', (select count(*) from o where order_status = 'PENDING_CONFIRMATION'),
    'ready_for_picking', (select count(*) from o where order_status not in ('ON_HOLD', 'CANCELLED', 'PENDING_CONFIRMATION', 'DRAFT') and (picking or free_reserved)),
    'being_packed', (select count(*) from o where packing),
    'ready_for_dispatch', (select count(*) from o where ready_dispatch),
    'dispatched', (select count(*) from o where fulfilment_status in ('PARTIALLY_DISPATCHED', 'DISPATCHED', 'PARTIALLY_DELIVERED', 'DELIVERED')),
    'in_transit', (select count(*) from o where in_transit),
    'delivered', (select count(*) from o where fulfilment_status = 'DELIVERED'),
    'partially_fulfilled', (select count(*) from o where order_status = 'PARTIALLY_FULFILLED'),
    'with_exceptions', (select count(*) from o where delivery_exception or other_exception),
    'units_awaiting', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit) from (
        select unit, sum(quantity_ordered - quantity_cancelled - quantity_dispatched) q from lines
        where order_status not in ('CANCELLED', 'FULFILLED') group by unit having sum(quantity_ordered - quantity_cancelled - quantity_dispatched) > 0) x), '[]'::jsonb),
    'units_dispatched', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'quantity', q) order by unit) from (
        select unit, sum(quantity) q from dispatches group by unit) x), '[]'::jsonb),
    'by_status', coalesce((select jsonb_agg(jsonb_build_object('status', order_status, 'count', n) order by n desc) from (
        select order_status, count(*) n from o group by 1) x), '[]'::jsonb),
    'created_over_time', coalesce((select jsonb_agg(jsonb_build_object('bucket', bucket, 'count', n) order by bucket) from (
        select date_trunc(p_bucket, order_date::timestamp)::date as bucket, count(*) n from o group by 1) x), '[]'::jsonb),
    'ordered_vs_dispatched', coalesce((select jsonb_agg(x order by x.ordered desc) from (
        select sku_snapshot as sku, product_name_snapshot as product_name, unit, sum(quantity_ordered - quantity_cancelled) as ordered,
          sum(quantity_dispatched) as dispatched, sum(quantity_ordered - quantity_cancelled - quantity_dispatched) as remaining
        from lines group by 1, 2, 3 order by sum(quantity_ordered - quantity_cancelled) desc limit 10) x), '[]'::jsonb),
    'pending_by_warehouse', coalesce((select jsonb_agg(x order by x.warehouse, x.unit) from (
        select coalesce(w.warehouse_code, 'Not allocated') as warehouse, l.unit,
          sum(coalesce(r.open_qty, 0)) as reserved,
          0::numeric as unallocated
        from lines l
        left join lateral (select r.warehouse_id, r.quantity - r.fulfilled_quantity - r.released_quantity as open_qty from public.stock_reservations r
                           where r.reference_type = 'SALES_ORDER_LINE' and r.reference_id = l.id and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')) r on true
        left join public.warehouses w on w.id = r.warehouse_id
        where l.order_status not in ('CANCELLED', 'FULFILLED', 'PENDING_CONFIRMATION', 'DRAFT') and r.warehouse_id is not null
        group by 1, 2
        union all
        select 'Not allocated', unit, 0, sum(greatest(quantity_ordered - quantity_cancelled - quantity_dispatched - private.so_line_open_reserved(id), 0))
        from lines where order_status not in ('CANCELLED', 'FULFILLED') group by unit
        having sum(greatest(quantity_ordered - quantity_cancelled - quantity_dispatched - private.so_line_open_reserved(id), 0)) > 0) x), '[]'::jsonb),
    'delivery_performance', jsonb_build_object(
      'delivered', (select count(*) from delivered),
      'on_time', (select count(*) from delivered where expected_delivery_date is not null and delivered_date <= expected_delivery_date),
      'late', (select count(*) from delivered where expected_delivery_date is not null and delivered_date > expected_delivery_date),
      'no_expected_date', (select count(*) from delivered where expected_delivery_date is null),
      'average_days_late', (select round(avg(delivered_date - expected_delivery_date), 1) from delivered where expected_delivery_date is not null and delivered_date > expected_delivery_date),
      'by_bucket', coalesce((select jsonb_agg(jsonb_build_object('bucket', bucket, 'on_time', on_time, 'late', late, 'no_expected_date', no_date) order by bucket) from (
          select date_trunc(p_bucket, delivered_date::timestamp)::date as bucket,
            count(*) filter (where expected_delivery_date is not null and delivered_date <= expected_delivery_date) as on_time,
            count(*) filter (where expected_delivery_date is not null and delivered_date > expected_delivery_date) as late,
            count(*) filter (where expected_delivery_date is null) as no_date
          from delivered group by 1) x), '[]'::jsonb)),
    'overdue_deliveries', (select count(*) from public.fulfilments f join public.sales_orders so on so.id = f.sales_order_id
        where f.company_id = v_company and f.fulfilment_status in ('DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED', 'DELIVERY_EXCEPTION') and f.expected_delivery_date < v_today
          and (p_customer_id is null or so.customer_id = p_customer_id) and (p_warehouse_id is null or f.warehouse_id = p_warehouse_id)),
    'returns_by_product_reason', coalesce((select jsonb_agg(x order by x.quantity desc) from (
        select p.sku, p.product_name, p.base_unit as unit, r.reason_code, sum(greatest(rl.quantity_received, case when r.status in ('REQUESTED', 'AUTHORIZED') then rl.quantity_requested else 0 end)) as quantity,
          count(distinct r.id) as returns
        from public.customer_returns r
        join public.customer_return_lines rl on rl.return_id = r.id
        join public.products p on p.id = rl.product_id
        where r.company_id = v_company and r.return_date between p_from and p_to and not (r.status = 'REJECTED' and r.received_at is null)
          and (p_customer_id is null or r.customer_id = p_customer_id)
        group by 1, 2, 3, 4 order by 5 desc limit 20) x), '[]'::jsonb),
    'timezone', v_tz,
    'as_of', now()
  ) into v_result;
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- Reports (one entry point; rows as jsonb)
-- -----------------------------------------------------------------------------
create or replace function public.fulfilment_report(
  p_report       text,
  p_from         date,
  p_to           date,
  p_customer_id  uuid default null,
  p_product_id   uuid default null,
  p_warehouse_id uuid default null,
  p_status       text default null,
  p_transporter  text default null
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('fulfilment_reports.read');
  v_tz      text := private.company_tz(v_company);
  v_today   date := private.company_today(v_company);
  v_carrier text := nullif(btrim(coalesce(p_transporter, '')), '');
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Choose a valid date range (at most about 10 years).' using errcode = 'P0001';
  end if;

  if p_report = 'SALES_ORDER_REGISTER' then
    return query
    select to_jsonb(x) from (
      select so.sales_order_number, so.order_date, so.customer_name_snapshot as customer, so.customer_po_number, so.source, so.order_status, so.fulfilment_status,
        so.priority, w.warehouse_code, so.requested_delivery_date, l.unit, count(*) as lines, sum(l.quantity_ordered) as ordered, sum(l.quantity_cancelled) as cancelled,
        sum(l.quantity_dispatched) as dispatched, sum(l.quantity_delivered) as delivered, sum(l.quantity_returned) as returned,
        sum(l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched) as remaining, so.confirmed_at
      from public.sales_orders so
      join public.sales_order_lines l on l.sales_order_id = so.id
      left join public.warehouses w on w.id = so.warehouse_id
      where so.company_id = v_company and so.order_date between p_from and p_to
        and (p_customer_id is null or so.customer_id = p_customer_id) and (p_status is null or so.order_status = p_status)
        and (p_warehouse_id is null or so.warehouse_id = p_warehouse_id) and (p_product_id is null or l.product_id = p_product_id)
      group by so.id, w.warehouse_code, l.unit
      order by so.order_date desc, so.sales_order_number desc) x;

  elsif p_report = 'PENDING_FULFILMENT' then
    return query
    select to_jsonb(x) from (
      select so.sales_order_number, so.order_date, so.requested_delivery_date, so.customer_name_snapshot as customer, so.order_status, so.priority,
        l.line_no, l.sku_snapshot as sku, l.product_name_snapshot as product_name, l.unit, l.quantity_ordered - l.quantity_cancelled as ordered,
        l.quantity_dispatched as dispatched, private.so_line_open_reserved(l.id) as reserved, private.so_line_planned(l.id) as on_pick_lists,
        l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched as remaining,
        greatest(l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched - private.so_line_open_reserved(l.id), 0) as unreserved,
        v_today - so.order_date as days_open
      from public.sales_order_lines l join public.sales_orders so on so.id = l.sales_order_id
      where so.company_id = v_company and so.order_status not in ('CANCELLED', 'FULFILLED', 'DRAFT')
        and l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched > 0
        and (p_customer_id is null or so.customer_id = p_customer_id) and (p_status is null or so.order_status = p_status)
        and (p_warehouse_id is null or so.warehouse_id = p_warehouse_id) and (p_product_id is null or l.product_id = p_product_id)
      order by so.requested_delivery_date nulls last, so.order_date, so.sales_order_number, l.line_no) x;

  elsif p_report = 'PICKING' then
    return query
    select to_jsonb(x) from (
      select f.fulfilment_number, f.fulfilment_status, (f.created_at at time zone v_tz)::date as created_date, so.sales_order_number,
        so.customer_name_snapshot as customer, w.warehouse_code, loc.location_code, bt.batch_number, p.sku, p.product_name, p.base_unit as unit,
        fl.quantity_to_pick as to_pick, fl.quantity_picked as picked, fl.quantity_to_pick - fl.quantity_picked as short_picked, fl.pick_exception, fl.picked_at
      from public.fulfilment_lines fl
      join public.fulfilments f on f.id = fl.fulfilment_id
      join public.sales_orders so on so.id = f.sales_order_id
      join public.warehouses w on w.id = f.warehouse_id
      join public.inventory_locations loc on loc.id = fl.location_id
      join public.inventory_batches bt on bt.id = fl.batch_id
      join public.products p on p.id = fl.product_id
      where f.company_id = v_company and (f.created_at at time zone v_tz)::date between p_from and p_to
        and (p_customer_id is null or so.customer_id = p_customer_id) and (p_status is null or f.fulfilment_status = p_status)
        and (p_warehouse_id is null or f.warehouse_id = p_warehouse_id) and (p_product_id is null or fl.product_id = p_product_id)
      order by f.created_at desc, f.fulfilment_number, fl.line_no) x;

  elsif p_report = 'PACKING_STATUS' then
    return query
    select to_jsonb(x) from (
      select f.fulfilment_number, f.fulfilment_status, (f.created_at at time zone v_tz)::date as created_date, so.sales_order_number,
        so.customer_name_snapshot as customer, w.warehouse_code, t.units, t.picked, t.packed, t.damaged, t.pack_exceptions, f.packing_notes,
        f.reopen_reason, f.packed_at, f.ready_at
      from public.fulfilments f
      join public.sales_orders so on so.id = f.sales_order_id
      join public.warehouses w on w.id = f.warehouse_id
      cross join lateral (select string_agg(distinct p.base_unit, ', ') as units, sum(fl.quantity_picked) as picked, sum(fl.quantity_packed) as packed,
          sum(fl.quantity_damaged) as damaged, count(*) filter (where fl.pack_exception is not null) as pack_exceptions
        from public.fulfilment_lines fl join public.products p on p.id = fl.product_id
        where fl.fulfilment_id = f.id and (p_product_id is null or fl.product_id = p_product_id)) t
      where f.company_id = v_company and (f.created_at at time zone v_tz)::date between p_from and p_to
        and (p_customer_id is null or so.customer_id = p_customer_id) and (p_status is null or f.fulfilment_status = p_status)
        and (p_warehouse_id is null or f.warehouse_id = p_warehouse_id) and t.picked is not null
      order by f.created_at desc) x;

  elsif p_report = 'DISPATCH_REGISTER' then
    return query
    select to_jsonb(x) from (
      select f.fulfilment_number, f.actual_dispatch_at as dispatched_at, so.sales_order_number, so.customer_name_snapshot as customer, so.customer_po_number,
        w.warehouse_code, f.carrier_name, f.transport_mode, f.vehicle_number, f.lr_number, f.tracking_number, f.eway_bill_number, f.fulfilment_status,
        t.units, t.dispatched, t.transaction_numbers, f.expected_delivery_date
      from public.fulfilments f
      join public.sales_orders so on so.id = f.sales_order_id
      join public.warehouses w on w.id = f.warehouse_id
      cross join lateral (select string_agg(distinct p.base_unit, ', ') as units, sum(fl.quantity_dispatched) as dispatched,
          string_agg(tx.transaction_number, ', ' order by tx.transaction_number) as transaction_numbers
        from public.fulfilment_lines fl join public.products p on p.id = fl.product_id
        left join public.inventory_transactions tx on tx.id = fl.issue_transaction_id
        where fl.fulfilment_id = f.id and (p_product_id is null or fl.product_id = p_product_id)) t
      where f.company_id = v_company and f.actual_dispatch_at is not null and (f.actual_dispatch_at at time zone v_tz)::date between p_from and p_to
        and (p_customer_id is null or so.customer_id = p_customer_id) and (p_status is null or f.fulfilment_status = p_status)
        and (p_warehouse_id is null or f.warehouse_id = p_warehouse_id) and (v_carrier is null or f.carrier_name ilike '%' || v_carrier || '%')
        and t.dispatched > 0
      order by f.actual_dispatch_at desc) x;

  elsif p_report = 'PARTIAL_DISPATCH' then
    return query
    select to_jsonb(x) from (
      select so.sales_order_number, so.customer_name_snapshot as customer, so.order_status, l.line_no, l.sku_snapshot as sku, l.unit,
        l.quantity_ordered - l.quantity_cancelled as ordered, l.quantity_dispatched as dispatched, l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched as remaining,
        d.consignments, d.first_dispatch, d.last_dispatch
      from public.sales_order_lines l
      join public.sales_orders so on so.id = l.sales_order_id
      cross join lateral (select count(distinct f.id) as consignments, min(f.actual_dispatch_at) as first_dispatch, max(f.actual_dispatch_at) as last_dispatch,
          count(*) filter (where (f.actual_dispatch_at at time zone v_tz)::date between p_from and p_to) as in_period
        from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
        where fl.sales_order_line_id = l.id and fl.quantity_dispatched > 0 and (p_warehouse_id is null or f.warehouse_id = p_warehouse_id)) d
      where so.company_id = v_company and d.in_period > 0
        and (d.consignments > 1 or l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched > 0)
        and (p_customer_id is null or so.customer_id = p_customer_id) and (p_status is null or so.order_status = p_status)
        and (p_product_id is null or l.product_id = p_product_id)
      order by d.last_dispatch desc, so.sales_order_number, l.line_no) x;

  elsif p_report = 'BACKORDER' then
    return query
    select to_jsonb(x) from (
      select so.sales_order_number, so.order_date, so.requested_delivery_date, so.customer_name_snapshot as customer, so.order_status, l.line_no,
        l.sku_snapshot as sku, l.product_name_snapshot as product_name, l.unit, l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched as remaining,
        private.so_line_open_reserved(l.id) as reserved,
        greatest(l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched - private.so_line_open_reserved(l.id), 0) as backordered,
        (select coalesce(sum(s.available), 0) from private.po_eligible_stock(v_company, l.product_id, so.warehouse_id) s where s.eligible) as available_now,
        l.backorder_reason, l.expected_fulfilment_date
      from public.sales_order_lines l join public.sales_orders so on so.id = l.sales_order_id
      where so.company_id = v_company and so.order_status in ('CONFIRMED', 'PARTIALLY_ALLOCATED', 'READY_FOR_FULFILMENT', 'IN_FULFILMENT', 'PARTIALLY_FULFILLED', 'ON_HOLD')
        and l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched - private.so_line_open_reserved(l.id) > 0
        and (p_customer_id is null or so.customer_id = p_customer_id) and (p_status is null or so.order_status = p_status)
        and (p_warehouse_id is null or so.warehouse_id = p_warehouse_id) and (p_product_id is null or l.product_id = p_product_id)
      order by so.requested_delivery_date nulls last, so.sales_order_number, l.line_no) x;

  elsif p_report in ('DELIVERY_TRACKING', 'OVERDUE_DELIVERY') then
    return query
    select to_jsonb(x) from (
      select f.fulfilment_number, so.sales_order_number, so.customer_name_snapshot as customer, f.fulfilment_status, f.actual_dispatch_at as dispatched_at,
        f.carrier_name, f.transport_mode, f.tracking_number, f.lr_number, f.expected_delivery_date, f.delivered_at,
        case when f.delivered_at is not null and f.expected_delivery_date is not null then (f.delivered_at at time zone v_tz)::date - f.expected_delivery_date end as days_late,
        case when f.delivered_at is null and f.expected_delivery_date < v_today then v_today - f.expected_delivery_date end as days_overdue,
        e.event_type as last_event, e.event_at as last_event_at, e.location as last_event_location, f.exception_reason
      from public.fulfilments f
      join public.sales_orders so on so.id = f.sales_order_id
      left join lateral (select de.event_type, de.event_at, de.location from public.delivery_events de where de.fulfilment_id = f.id
                         order by de.event_at desc, de.created_at desc limit 1) e on true
      where f.company_id = v_company and f.actual_dispatch_at is not null
        and case when p_report = 'OVERDUE_DELIVERY'
                 then f.fulfilment_status in ('DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED', 'DELIVERY_EXCEPTION') and f.expected_delivery_date < v_today
                 else (f.actual_dispatch_at at time zone v_tz)::date between p_from and p_to end
        and (p_customer_id is null or so.customer_id = p_customer_id) and (p_status is null or f.fulfilment_status = p_status)
        and (p_warehouse_id is null or f.warehouse_id = p_warehouse_id) and (v_carrier is null or f.carrier_name ilike '%' || v_carrier || '%')
        and (p_product_id is null or exists (select 1 from public.fulfilment_lines fl where fl.fulfilment_id = f.id and fl.product_id = p_product_id))
      order by f.expected_delivery_date nulls last, f.actual_dispatch_at desc) x;

  elsif p_report = 'RETURNS_REGISTER' then
    return query
    select to_jsonb(x) from (
      select r.return_number, r.return_date, so.sales_order_number, r.customer_name_snapshot as customer, r.status, r.reason_code, r.reason_note,
        f.fulfilment_number, p.sku, p.product_name, p.base_unit as unit, bt.batch_number, rl.quantity_requested as requested, rl.quantity_received as received,
        rl.disposition, rl.disposition_posted, rl.inspection_note, r.received_at, r.closed_at
      from public.customer_returns r
      join public.customer_return_lines rl on rl.return_id = r.id
      join public.sales_orders so on so.id = r.sales_order_id
      join public.products p on p.id = rl.product_id
      join public.inventory_batches bt on bt.id = rl.batch_id
      join public.fulfilment_lines fl on fl.id = rl.fulfilment_line_id
      join public.fulfilments f on f.id = fl.fulfilment_id
      where r.company_id = v_company and r.return_date between p_from and p_to
        and (p_customer_id is null or r.customer_id = p_customer_id) and (p_status is null or r.status = p_status)
        and (p_product_id is null or rl.product_id = p_product_id) and (p_warehouse_id is null or f.warehouse_id = p_warehouse_id)
      order by r.return_date desc, r.return_number, rl.line_no) x;

  elsif p_report = 'EXCEPTIONS' then
    return query
    select to_jsonb(x) from (
      select * from (
        select (fl.picked_at at time zone v_tz)::date as date, 'Pick exception' as exception_type, so.sales_order_number, f.fulfilment_number, p.sku,
          fl.quantity_to_pick - fl.quantity_picked as quantity, p.base_unit as unit, fl.pick_exception as detail, so.customer_id, f.warehouse_id, fl.product_id
        from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id join public.sales_orders so on so.id = f.sales_order_id
        join public.products p on p.id = fl.product_id
        where fl.company_id = v_company and fl.pick_exception is not null
        union all
        select (fl.packed_at at time zone v_tz)::date, 'Damaged / missing at packing', so.sales_order_number, f.fulfilment_number, p.sku, fl.quantity_damaged,
          p.base_unit, fl.pack_exception, so.customer_id, f.warehouse_id, fl.product_id
        from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id join public.sales_orders so on so.id = f.sales_order_id
        join public.products p on p.id = fl.product_id
        where fl.company_id = v_company and (fl.quantity_damaged > 0 or (fl.pack_exception is not null and fl.quantity_damaged = 0))
        union all
        select (de.event_at at time zone v_tz)::date, 'Delivery: ' || lower(replace(de.event_type, '_', ' ')), so.sales_order_number, f.fulfilment_number, null, null, null,
          coalesce(de.failure_reason, de.description), so.customer_id, f.warehouse_id, null
        from public.delivery_events de join public.fulfilments f on f.id = de.fulfilment_id join public.sales_orders so on so.id = f.sales_order_id
        where de.company_id = v_company and de.event_type in ('DELIVERY_FAILED', 'RETURNED_TO_SENDER', 'EXCEPTION')
        union all
        select (f.cancelled_at at time zone v_tz)::date, 'Fulfilment cancelled', so.sales_order_number, f.fulfilment_number, null, null, null, f.cancel_reason,
          so.customer_id, f.warehouse_id, null
        from public.fulfilments f join public.sales_orders so on so.id = f.sales_order_id
        where f.company_id = v_company and f.fulfilment_status = 'CANCELLED'
      ) e
      where e.date between p_from and p_to and (p_customer_id is null or e.customer_id = p_customer_id)
        and (p_warehouse_id is null or e.warehouse_id = p_warehouse_id) and (p_product_id is null or e.product_id = p_product_id)
      order by e.date desc) x;

  elsif p_report = 'TRACEABILITY' then
    return query
    select to_jsonb(x) from (
      select so.sales_order_number, so.customer_name_snapshot as customer, so.customer_po_number, so.source_po_reference, so.source_filename,
        f.fulfilment_number, f.actual_dispatch_at as dispatched_at, p.sku, p.base_unit as unit, bt.batch_number, bt.source_type, w.warehouse_code, loc.location_code,
        r.reservation_number, fl.quantity_dispatched as dispatched, tx.transaction_number, fl.quantity_delivered as delivered,
        (select coalesce(sum(rl.quantity_received), 0) from public.customer_return_lines rl where rl.fulfilment_line_id = fl.id) as returned
      from public.fulfilment_lines fl
      join public.fulfilments f on f.id = fl.fulfilment_id
      join public.sales_orders so on so.id = f.sales_order_id
      join public.products p on p.id = fl.product_id
      join public.inventory_batches bt on bt.id = fl.batch_id
      join public.inventory_locations loc on loc.id = fl.location_id
      join public.warehouses w on w.id = loc.warehouse_id
      join public.stock_reservations r on r.id = fl.reservation_id
      join public.inventory_transactions tx on tx.id = fl.issue_transaction_id
      where f.company_id = v_company and (f.actual_dispatch_at at time zone v_tz)::date between p_from and p_to
        and (p_customer_id is null or so.customer_id = p_customer_id) and (p_warehouse_id is null or f.warehouse_id = p_warehouse_id)
        and (p_product_id is null or fl.product_id = p_product_id)
      order by f.actual_dispatch_at desc, f.fulfilment_number, fl.line_no) x;

  elsif p_report = 'PRODUCT_DISPATCH_QTY' then
    return query
    select to_jsonb(x) from (
      select p.sku, p.product_name, p.base_unit as unit, count(distinct f.id) as consignments, count(distinct f.sales_order_id) as orders,
        sum(fl.quantity_dispatched) as dispatched, sum(fl.quantity_delivered) as delivered,
        sum((select coalesce(sum(rl.quantity_received), 0) from public.customer_return_lines rl where rl.fulfilment_line_id = fl.id)) as returned
      from public.fulfilment_lines fl
      join public.fulfilments f on f.id = fl.fulfilment_id
      join public.sales_orders so on so.id = f.sales_order_id
      join public.products p on p.id = fl.product_id
      where f.company_id = v_company and fl.quantity_dispatched > 0 and (f.actual_dispatch_at at time zone v_tz)::date between p_from and p_to
        and (p_customer_id is null or so.customer_id = p_customer_id) and (p_warehouse_id is null or f.warehouse_id = p_warehouse_id)
        and (p_product_id is null or fl.product_id = p_product_id)
      group by p.id
      order by sum(fl.quantity_dispatched) desc) x;

  elsif p_report = 'WAREHOUSE_PERFORMANCE' then
    return query
    select to_jsonb(x) from (
      select w.warehouse_code, w.warehouse_name, count(*) as consignments, count(distinct f.sales_order_id) as orders,
        round(avg((f.actual_dispatch_at at time zone v_tz)::date - so.order_date), 1) as avg_days_order_to_dispatch,
        count(*) filter (where f.fulfilment_status = 'DELIVERED') as delivered,
        count(*) filter (where f.fulfilment_status = 'DELIVERED' and f.expected_delivery_date is not null and (f.delivered_at at time zone v_tz)::date <= f.expected_delivery_date) as on_time,
        count(*) filter (where f.fulfilment_status = 'DELIVERED' and f.expected_delivery_date is not null and (f.delivered_at at time zone v_tz)::date > f.expected_delivery_date) as late,
        case when count(*) filter (where f.fulfilment_status = 'DELIVERED' and f.expected_delivery_date is not null) > 0 then
          round(100.0 * count(*) filter (where f.fulfilment_status = 'DELIVERED' and f.expected_delivery_date is not null and (f.delivered_at at time zone v_tz)::date <= f.expected_delivery_date)
                / count(*) filter (where f.fulfilment_status = 'DELIVERED' and f.expected_delivery_date is not null), 1) end as on_time_percent,
        count(*) filter (where f.fulfilment_status = 'DELIVERY_EXCEPTION') as delivery_exceptions,
        (select count(*) from public.fulfilments o where o.warehouse_id = w.id and o.fulfilment_status in ('PENDING', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'READY_FOR_DISPATCH')) as open_pick_lists
      from public.fulfilments f
      join public.sales_orders so on so.id = f.sales_order_id
      join public.warehouses w on w.id = f.warehouse_id
      where f.company_id = v_company and f.actual_dispatch_at is not null and (f.actual_dispatch_at at time zone v_tz)::date between p_from and p_to
        and (p_customer_id is null or so.customer_id = p_customer_id) and (p_warehouse_id is null or f.warehouse_id = p_warehouse_id)
        and (p_product_id is null or exists (select 1 from public.fulfilment_lines fl where fl.fulfilment_id = f.id and fl.product_id = p_product_id))
      group by w.id
      order by count(*) desc) x;

  else
    raise exception 'Unknown report %.', p_report using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.sales_overview(date, date, uuid, uuid, text, text, text, text) from public, anon;
grant execute on function public.sales_overview(date, date, uuid, uuid, text, text, text, text) to authenticated;
revoke all on function public.fulfilment_report(text, date, date, uuid, uuid, uuid, text, text) from public, anon;
grant execute on function public.fulfilment_report(text, date, date, uuid, uuid, uuid, text, text) to authenticated;
