-- =============================================================================
-- Phase 5: production overview, reports, costing and batch traceability
--
-- All figures come from production / outsourcing documents and the Phase 4
-- ledger. Quantities are grouped by unit (different units are never summed).
-- Period filters use the company timezone. Reversed documents are excluded.
--
-- Costing method (documented, nothing invented):
--   material cost  = quantity issued x weighted-average cost of the issued lot
--                    (private.lot_average_cost). If any issued lot has an
--                    unknown cost, the material cost is INCOMPLETE (no total).
--   outsourcing    = recorded unit_cost (price / processing charge) x accepted
--                    quantity, only when a unit cost was recorded.
--   standard estimate = BOM-based planned material x products.standard_cost,
--                    only when every component has a standard cost.
--   Selling prices are never used. Scrap is not assumed to have zero value or
--   recovery; it is simply not credited.
-- =============================================================================

-- Outstanding material need of open (submitted / approved / running) orders
-- versus usable stock in each order's source warehouse.
create or replace function private.production_material_outlook(p_company uuid, p_warehouse uuid, p_product uuid)
returns table (
  component_product_id uuid, sku text, product_name text, unit text, warehouse_id uuid, warehouse_code text,
  orders bigint, planned numeric, issued numeric, outstanding numeric, reserved_for_orders numeric,
  available numeric, shortage numeric, order_numbers text
)
language sql
stable
security definer
set search_path = ''
as $$
  with lines as (
    select m.component_product_id, m.unit, o.source_warehouse_id, o.id as order_id, o.production_order_number,
      m.planned_quantity, m.issued_quantity, greatest(m.planned_quantity - m.issued_quantity, 0) as outstanding
    from public.production_orders o
    join public.production_order_materials m on m.production_order_id = o.id
    where o.company_id = p_company
      and o.status in ('PENDING_APPROVAL', 'APPROVED', 'MATERIALS_RESERVED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED', 'ON_HOLD')
      and (p_warehouse is null or o.source_warehouse_id = p_warehouse)
      and (p_product is null or o.finished_product_id = p_product)
  ),
  agg as (
    select l.component_product_id, l.unit, l.source_warehouse_id, count(distinct l.order_id) as orders,
      sum(l.planned_quantity) as planned, sum(l.issued_quantity) as issued, sum(l.outstanding) as outstanding,
      string_agg(distinct l.production_order_number, ', ') as order_numbers,
      coalesce(sum(private.order_open_reserved(l.order_id, l.component_product_id)), 0) as reserved_for_orders
    from lines l
    group by l.component_product_id, l.unit, l.source_warehouse_id
  )
  select a.component_product_id, p.sku, p.product_name, a.unit, a.source_warehouse_id, w.warehouse_code,
    a.orders, a.planned, a.issued, a.outstanding, a.reserved_for_orders, s.available,
    greatest(a.outstanding - a.reserved_for_orders - s.available, 0), a.order_numbers
  from agg a
  join public.products p on p.id = a.component_product_id
  join public.warehouses w on w.id = a.source_warehouse_id
  cross join lateral private.storage_stock(p_company, a.component_product_id, a.source_warehouse_id) s
  where a.outstanding > 0;
$$;

revoke all on function private.production_material_outlook(uuid, uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Overview dashboard
-- -----------------------------------------------------------------------------
create or replace function public.production_overview(
  p_from         date,
  p_to           date,
  p_warehouse_id uuid default null,
  p_product_id   uuid default null,
  p_status       text default null,
  p_bucket       text default 'day'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company     uuid := private.require_permission('manufacturing.read');
  v_tz          text := private.company_tz(v_company);
  v_today       date := private.company_today(v_company);
  v_month_start date := date_trunc('month', private.company_today(v_company)::timestamp)::date;
  v_result      jsonb;
begin
  if p_bucket not in ('day', 'week', 'month', 'year') then
    raise exception 'Bucket must be day, week, month or year.' using errcode = 'P0001';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Choose a valid date range (at most about 10 years).' using errcode = 'P0001';
  end if;

  with ord as (
    select o.* from public.production_orders o
    where o.company_id = v_company
      and (p_warehouse_id is null or o.source_warehouse_id = p_warehouse_id or o.destination_warehouse_id = p_warehouse_id)
      and (p_product_id is null or o.finished_product_id = p_product_id)
      and (p_status is null or o.status = p_status)
  ),
  open_ord as (select * from ord where status not in ('COMPLETED', 'CANCELLED')),
  outp as (
    select r.*, o.destination_warehouse_id from public.production_output_receipts r
    join ord o on o.id = r.production_order_id
    where r.status = 'POSTED'
  ),
  outs as (
    select r.* from public.outsourcing_receipts r
    join public.outsourcing_orders oo on oo.id = r.outsourcing_order_id
    where r.company_id = v_company and r.status = 'POSTED'
      and (p_product_id is null or r.product_id = p_product_id)
      and (p_warehouse_id is null or oo.destination_warehouse_id = p_warehouse_id)
  ),
  cons as (
    select c.* from public.production_material_consumption c
    join ord o on o.id = c.production_order_id
    where c.status = 'POSTED'
  ),
  outlook as (select * from private.production_material_outlook(v_company, p_warehouse_id, p_product_id))
  select jsonb_build_object(
    'has_records', exists (select 1 from public.production_orders where company_id = v_company)
                   or exists (select 1 from public.boms where company_id = v_company)
                   or exists (select 1 from public.outsourcing_orders where company_id = v_company),
    'open_orders', (select count(*) from open_ord),
    'draft_orders', (select count(*) from open_ord where status = 'DRAFT'),
    'in_progress_orders', (select count(*) from ord where status in ('IN_PROGRESS', 'PARTIALLY_COMPLETED')),
    'on_hold_orders', (select count(*) from ord where status = 'ON_HOLD'),
    'overdue_orders', (select count(*) from open_ord where target_completion_date < v_today),
    'completed_orders', (select count(*) from ord where status = 'COMPLETED' and actual_completion_date between p_from and p_to),
    'planned_open', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'planned', planned, 'remaining', remaining) order by unit)
      from (select unit, sum(planned_quantity) planned, sum(greatest(planned_quantity - actual_quantity, 0)) remaining
            from open_ord group by unit) x), '[]'::jsonb),
    'produced_this_month', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'good', good, 'rejected', rej, 'scrap', scrap) order by unit)
      from (select unit, sum(good_quantity) good, sum(rejected_quantity) rej, sum(scrap_quantity) scrap
            from outp where production_date between v_month_start and v_today group by unit) x), '[]'::jsonb),
    'produced_in_period', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'good', good, 'rejected', rej, 'scrap', scrap) order by unit)
      from (select unit, sum(good_quantity) good, sum(rejected_quantity) rej, sum(scrap_quantity) scrap
            from outp where production_date between p_from and p_to group by unit) x), '[]'::jsonb),
    'shortage_materials', (select count(distinct component_product_id) from outlook where shortage > 0),
    'outsourcing_in_progress', (select count(*) from public.outsourcing_orders
      where company_id = v_company and status in ('APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED')
        and (p_product_id is null or product_id = p_product_id)
        and (p_warehouse_id is null or destination_warehouse_id = p_warehouse_id)),
    'pending_order_approvals', (select count(*) from public.production_orders where company_id = v_company and status = 'PENDING_APPROVAL'),
    'pending_bom_approvals', (select count(*) from public.boms where company_id = v_company and status = 'PENDING_APPROVAL'),
    'pending_outsourcing_approvals', (select count(*) from public.outsourcing_orders where company_id = v_company and status = 'PENDING_APPROVAL'),
    'planned_vs_actual', coalesce((select jsonb_agg(jsonb_build_object('bucket', bucket, 'unit', unit, 'planned', planned, 'actual', actual)
                                                   order by bucket, unit)
      from (
        select coalesce(p.bucket, a.bucket) bucket, coalesce(p.unit, a.unit) unit, coalesce(p.qty, 0) planned, coalesce(a.qty, 0) actual
        from (select date_trunc(p_bucket, target_completion_date::timestamp)::date bucket, unit, sum(planned_quantity) qty from ord
              where status not in ('DRAFT', 'CANCELLED') and target_completion_date between p_from and p_to group by 1, 2) p
        full join (select date_trunc(p_bucket, production_date::timestamp)::date bucket, unit, sum(good_quantity) qty from outp
                   where production_date between p_from and p_to group by 1, 2) a on a.bucket = p.bucket and a.unit = p.unit
      ) x), '[]'::jsonb),
    'by_product', coalesce((select jsonb_agg(x order by (x ->> 'good')::numeric desc) from (
        select jsonb_build_object('sku', pr.sku, 'product_name', pr.product_name, 'unit', o.unit, 'good', sum(o.good_quantity),
                                  'rejected', sum(o.rejected_quantity), 'scrap', sum(o.scrap_quantity)) x
        from outp o join public.products pr on pr.id = o.product_id
        where o.production_date between p_from and p_to
        group by pr.sku, pr.product_name, o.unit order by sum(o.good_quantity) desc limit 10) y), '[]'::jsonb),
    'by_status', coalesce((select jsonb_agg(jsonb_build_object('status', status, 'orders', n) order by status)
      from (select status, count(*) n from ord where planned_start_date between p_from and p_to or status not in ('COMPLETED', 'CANCELLED')
            group by status) x), '[]'::jsonb),
    'source_split', coalesce((select jsonb_agg(jsonb_build_object('bucket', bucket, 'unit', unit, 'in_house', ih, 'outsourced', os)
                                              order by bucket, unit)
      from (
        select coalesce(a.bucket, b.bucket) bucket, coalesce(a.unit, b.unit) unit, coalesce(a.qty, 0) ih, coalesce(b.qty, 0) os
        from (select date_trunc(p_bucket, production_date::timestamp)::date bucket, unit, sum(good_quantity) qty from outp
              where production_date between p_from and p_to group by 1, 2) a
        full join (select date_trunc(p_bucket, receipt_date::timestamp)::date bucket, unit, sum(accepted_quantity) qty from outs
                   where receipt_date between p_from and p_to group by 1, 2) b on a.bucket = b.bucket and a.unit = b.unit
      ) x), '[]'::jsonb),
    'consumption_trend', coalesce((select jsonb_agg(jsonb_build_object('bucket', bucket, 'unit', unit, 'quantity', qty) order by bucket, unit)
      from (select date_trunc(p_bucket, consumption_date::timestamp)::date bucket, unit, sum(actual_quantity) qty from cons
            where consumption_date between p_from and p_to group by 1, 2) x), '[]'::jsonb),
    'shortages', coalesce((select jsonb_agg(x order by (x ->> 'shortage')::numeric desc) from (
        select jsonb_build_object('sku', sku, 'product_name', product_name, 'unit', unit, 'warehouse_code', warehouse_code,
                                  'outstanding', outstanding, 'available', available, 'reserved_for_orders', reserved_for_orders,
                                  'shortage', shortage, 'orders', orders) x
        from outlook where shortage > 0 order by shortage desc limit 10) y), '[]'::jsonb),
    'timezone', v_tz,
    'today', v_today,
    'as_of', now()
  ) into v_result;
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- Cost summary rows (production and outsourcing orders)
-- -----------------------------------------------------------------------------
create or replace function private.production_cost_rows(p_company uuid, p_from date, p_to date, p_product uuid)
returns table (row_data jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  with prod as (
    select o.*, pr.sku, pr.product_name,
      (select count(*) from public.production_material_consumption c where c.production_order_id = o.id and c.status = 'POSTED') as issues,
      (select count(*) from public.production_material_consumption c where c.production_order_id = o.id and c.status = 'POSTED'
         and private.lot_average_cost(c.batch_id) is null) as uncosted_issues,
      (select sum(c.actual_quantity * private.lot_average_cost(c.batch_id)) from public.production_material_consumption c
         where c.production_order_id = o.id and c.status = 'POSTED') as material_cost,
      (select count(*) from public.production_order_materials m join public.products cp on cp.id = m.component_product_id
         where m.production_order_id = o.id and cp.standard_cost is null) as missing_standard,
      (select sum(m.planned_quantity * cp.standard_cost) from public.production_order_materials m
         join public.products cp on cp.id = m.component_product_id where m.production_order_id = o.id) as standard_planned
    from public.production_orders o
    join public.products pr on pr.id = o.finished_product_id
    where o.company_id = p_company and o.status not in ('DRAFT', 'CANCELLED', 'PENDING_APPROVAL')
      and (p_product is null or o.finished_product_id = p_product)
      and exists (select 1 from public.production_output_receipts r where r.production_order_id = o.id and r.status = 'POSTED'
                  and r.production_date between p_from and p_to)
  ),
  outsrc as (
    select o.*, pr.sku, pr.product_name,
      (select count(*) from public.outsourcing_material_movements mv where mv.outsourcing_order_id = o.id and mv.status = 'POSTED'
         and mv.movement_type = 'CONSUMPTION') as issues,
      (select count(*) from public.outsourcing_material_movements mv where mv.outsourcing_order_id = o.id and mv.status = 'POSTED'
         and mv.movement_type = 'CONSUMPTION' and private.lot_average_cost(mv.batch_id) is null) as uncosted_issues,
      (select sum(mv.quantity * private.lot_average_cost(mv.batch_id)) from public.outsourcing_material_movements mv
         where mv.outsourcing_order_id = o.id and mv.status = 'POSTED' and mv.movement_type = 'CONSUMPTION') as material_cost
    from public.outsourcing_orders o
    join public.products pr on pr.id = o.product_id
    where o.company_id = p_company and o.accepted_quantity > 0
      and (p_product is null or o.product_id = p_product)
      and exists (select 1 from public.outsourcing_receipts r where r.outsourcing_order_id = o.id and r.status = 'POSTED'
                  and r.receipt_date between p_from and p_to)
  )
  select jsonb_build_object(
    'order_type', 'PRODUCTION', 'order_number', production_order_number, 'order_id', id, 'status', status, 'sku', sku,
    'product_name', product_name, 'unit', unit, 'good_quantity', completed_quantity, 'actual_quantity', actual_quantity,
    'material_cost', case when issues > 0 and uncosted_issues = 0 then round(material_cost, 2) end,
    'outsourcing_cost', null,
    'total_cost', case when issues > 0 and uncosted_issues = 0 then round(material_cost, 2) end,
    'cost_per_good_unit', case when issues > 0 and uncosted_issues = 0 and completed_quantity > 0 then round(material_cost / completed_quantity, 4) end,
    'standard_estimate_for_output', case when missing_standard = 0 and planned_quantity > 0
                                         then round(standard_planned * actual_quantity / planned_quantity, 2) end,
    'variance', case when issues > 0 and uncosted_issues = 0 and missing_standard = 0 and planned_quantity > 0
                     then round(material_cost - standard_planned * actual_quantity / planned_quantity, 2) end,
    'cost_status', case when issues = 0 then 'NO_MATERIAL_ISSUED' when uncosted_issues > 0 then 'COST_DATA_INCOMPLETE' else 'ACTUAL' end,
    'notes', case when uncosted_issues > 0 then format('%s of %s material issues are from lots with unknown cost', uncosted_issues, issues)
                  when missing_standard > 0 then 'No standard-cost estimate: some components have no standard cost' end)
  from prod
  union all
  select jsonb_build_object(
    'order_type', 'OUTSOURCING', 'order_number', outsourcing_order_number, 'order_id', id, 'status', status, 'sku', sku,
    'product_name', product_name, 'unit', unit, 'good_quantity', accepted_quantity, 'actual_quantity', received_quantity,
    'material_cost', case when issues = 0 then 0 when uncosted_issues = 0 then round(material_cost, 2) end,
    'outsourcing_cost', case when unit_cost is not null then round(unit_cost * accepted_quantity, 2) end,
    'total_cost', case when unit_cost is not null and uncosted_issues = 0 then round(coalesce(material_cost, 0) + unit_cost * accepted_quantity, 2) end,
    'cost_per_good_unit', case when unit_cost is not null and uncosted_issues = 0 and accepted_quantity > 0
                               then round((coalesce(material_cost, 0) + unit_cost * accepted_quantity) / accepted_quantity, 4) end,
    'standard_estimate_for_output', null,
    'variance', null,
    'cost_status', case when unit_cost is null or uncosted_issues > 0 then 'COST_DATA_INCOMPLETE' else 'ACTUAL' end,
    'notes', case when unit_cost is null then 'No price / processing charge recorded on the order'
                  when uncosted_issues > 0 then 'Some material sent to the supplier has unknown cost' end)
  from outsrc;
$$;

revoke all on function private.production_cost_rows(uuid, date, date, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Reports (one entry point; rows as jsonb)
-- -----------------------------------------------------------------------------
create or replace function public.production_report(
  p_report       text,
  p_from         date,
  p_to           date,
  p_product_id   uuid default null,
  p_bom_id       uuid default null,
  p_status       text default null,
  p_warehouse_id uuid default null,
  p_supplier     text default null
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('production_reports.read');
  v_supplier text := nullif(btrim(coalesce(p_supplier, '')), '');
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Choose a valid date range (at most about 10 years).' using errcode = 'P0001';
  end if;

  if p_report = 'ORDERS_SUMMARY' then
    return query
    select to_jsonb(x) from (
      select o.production_order_number, o.status, o.priority, p.sku, p.product_name, o.bom_code, o.bom_version, o.unit,
        o.planned_quantity, o.completed_quantity, o.rejected_quantity, o.scrap_quantity, o.planned_start_date, o.target_completion_date,
        o.actual_start_date, o.actual_completion_date, sw.warehouse_code as source_warehouse, dw.warehouse_code as destination_warehouse
      from public.production_orders o
      join public.products p on p.id = o.finished_product_id
      join public.warehouses sw on sw.id = o.source_warehouse_id
      join public.warehouses dw on dw.id = o.destination_warehouse_id
      where o.company_id = v_company and o.planned_start_date between p_from and p_to
        and (p_product_id is null or o.finished_product_id = p_product_id) and (p_bom_id is null or o.bom_id = p_bom_id)
        and (p_status is null or o.status = p_status)
        and (p_warehouse_id is null or o.source_warehouse_id = p_warehouse_id or o.destination_warehouse_id = p_warehouse_id)
      order by o.planned_start_date desc, o.production_order_number desc) x;

  elsif p_report = 'PLANNED_VS_ACTUAL' then
    return query
    select to_jsonb(x) from (
      select o.production_order_number, o.status, p.sku, p.product_name, o.unit, o.planned_quantity,
        o.completed_quantity as good_quantity, o.actual_quantity as total_output,
        o.actual_quantity - o.planned_quantity as variance,
        case when o.planned_quantity > 0 then round(o.completed_quantity / o.planned_quantity * 100, 1) end as good_percent_of_plan,
        o.target_completion_date, o.actual_completion_date,
        case when o.actual_completion_date is not null then o.actual_completion_date - o.target_completion_date end as days_late
      from public.production_orders o join public.products p on p.id = o.finished_product_id
      where o.company_id = v_company and o.status not in ('DRAFT', 'CANCELLED')
        and o.target_completion_date between p_from and p_to
        and (p_product_id is null or o.finished_product_id = p_product_id) and (p_bom_id is null or o.bom_id = p_bom_id)
        and (p_status is null or o.status = p_status)
        and (p_warehouse_id is null or o.source_warehouse_id = p_warehouse_id or o.destination_warehouse_id = p_warehouse_id)
      order by o.target_completion_date desc) x;

  elsif p_report in ('RAW_MATERIAL_REQUIREMENTS', 'MATERIAL_SHORTAGE') then
    return query
    select to_jsonb(x) from (
      select sku, product_name, unit, warehouse_code, orders, order_numbers, planned, issued, outstanding,
        reserved_for_orders, available, shortage
      from private.production_material_outlook(v_company, p_warehouse_id, p_product_id)
      where p_report = 'RAW_MATERIAL_REQUIREMENTS' or shortage > 0
      order by shortage desc, sku) x;

  elsif p_report = 'PLANNED_VS_ACTUAL_CONSUMPTION' then
    return query
    select to_jsonb(x) from (
      select o.production_order_number, o.status, fp.sku as product_sku, cp.sku as component_sku, cp.product_name as component_name, m.unit,
        m.planned_quantity, m.issued_quantity, m.issued_quantity - m.planned_quantity as variance,
        private.ceil_qty(m.quantity_per_unit * o.actual_quantity) as standard_for_actual_output,
        o.actual_quantity as actual_output
      from public.production_orders o
      join public.production_order_materials m on m.production_order_id = o.id
      join public.products fp on fp.id = o.finished_product_id
      join public.products cp on cp.id = m.component_product_id
      where o.company_id = v_company and o.status not in ('DRAFT', 'CANCELLED', 'PENDING_APPROVAL')
        and coalesce(o.actual_start_date, o.planned_start_date) between p_from and p_to
        and (p_product_id is null or o.finished_product_id = p_product_id) and (p_bom_id is null or o.bom_id = p_bom_id)
        and (p_status is null or o.status = p_status)
        and (p_warehouse_id is null or o.source_warehouse_id = p_warehouse_id)
      order by o.production_order_number desc, m.line_no) x;

  elsif p_report = 'OUTPUT_AND_REJECTIONS' then
    return query
    select to_jsonb(x) from (
      select r.receipt_number, r.production_date, o.production_order_number, p.sku, p.product_name, bt.batch_number, r.unit,
        r.good_quantity, r.rejected_quantity, r.scrap_quantity,
        round((r.rejected_quantity + r.scrap_quantity) / (r.good_quantity + r.rejected_quantity + r.scrap_quantity) * 100, 1) as reject_scrap_percent,
        case when r.rejected_quantity = 0 then null when r.rejected_location_id is not null then 'Stocked (non-saleable)' else 'Recorded only' end as rejected_handling,
        r.rejection_reason, r.quality_status
      from public.production_output_receipts r
      join public.production_orders o on o.id = r.production_order_id
      join public.products p on p.id = r.product_id
      left join public.inventory_batches bt on bt.id = r.batch_id
      where r.company_id = v_company and r.status = 'POSTED' and r.production_date between p_from and p_to
        and (p_product_id is null or r.product_id = p_product_id) and (p_bom_id is null or o.bom_id = p_bom_id)
        and (p_warehouse_id is null or o.destination_warehouse_id = p_warehouse_id)
      order by r.production_date desc, r.receipt_number desc) x;

  elsif p_report = 'FINISHED_GOODS_PRODUCED' then
    return query
    select to_jsonb(x) from (
      select p.sku, p.product_name, r.unit, count(distinct r.production_order_id) as orders, count(*) as receipts,
        sum(r.good_quantity) as good_quantity, sum(r.rejected_quantity) as rejected_quantity, sum(r.scrap_quantity) as scrap_quantity,
        min(r.production_date) as first_date, max(r.production_date) as last_date
      from public.production_output_receipts r
      join public.production_orders o on o.id = r.production_order_id
      join public.products p on p.id = r.product_id
      where r.company_id = v_company and r.status = 'POSTED' and r.production_date between p_from and p_to
        and (p_product_id is null or r.product_id = p_product_id) and (p_bom_id is null or o.bom_id = p_bom_id)
        and (p_warehouse_id is null or o.destination_warehouse_id = p_warehouse_id)
      group by p.sku, p.product_name, r.unit
      order by sum(r.good_quantity) desc) x;

  elsif p_report = 'OUTSOURCING_REGISTER' then
    return query
    select to_jsonb(x) from (
      select o.outsourcing_order_number, o.order_type, o.status, o.supplier_name, o.supplier_reference, p.sku, p.product_name, o.unit,
        o.ordered_quantity, o.received_quantity, o.accepted_quantity, o.rejected_quantity,
        greatest(o.ordered_quantity - o.received_quantity, 0) as pending_quantity,
        o.dispatch_date, o.expected_return_date, o.unit_cost, o.reference_number,
        (o.status not in ('COMPLETED', 'CANCELLED') and o.expected_return_date < private.company_today(v_company)) as overdue
      from public.outsourcing_orders o join public.products p on p.id = o.product_id
      where o.company_id = v_company and o.created_at >= private.company_day_start(v_company, p_from)
        and o.created_at < private.company_day_start(v_company, p_to + 1)
        and (p_product_id is null or o.product_id = p_product_id) and (p_status is null or o.status = p_status)
        and (p_warehouse_id is null or o.destination_warehouse_id = p_warehouse_id)
        and (v_supplier is null or o.supplier_name ilike '%' || v_supplier || '%')
      order by o.created_at desc) x;

  elsif p_report = 'MATERIALS_HELD_BY_SUPPLIERS' then
    return query
    select to_jsonb(x) from (
      select l.external_holder, w.warehouse_code, l.location_code, p.sku, p.product_name, p.base_unit as unit, bt.batch_number, b.source_type,
        b.on_hand as quantity_held,
        (select string_agg(distinct oo.outsourcing_order_number, ', ')
           from public.outsourcing_orders oo
           join public.outsourcing_order_materials om on om.outsourcing_order_id = oo.id
          where oo.external_location_id = l.id and om.component_product_id = b.product_id
            and om.dispatched_quantity - om.returned_quantity - om.consumed_quantity > 0) as open_orders
      from public.inventory_balances b
      join public.inventory_locations l on l.id = b.location_id and l.stock_usage = 'EXTERNAL_PROCESSING'
      join public.warehouses w on w.id = b.warehouse_id
      join public.products p on p.id = b.product_id
      join public.inventory_batches bt on bt.id = b.batch_id
      where b.company_id = v_company and b.on_hand > 0
        and (p_product_id is null or b.product_id = p_product_id)
        and (v_supplier is null or l.external_holder ilike '%' || v_supplier || '%')
      order by l.external_holder, p.sku) x;

  elsif p_report = 'OUTSOURCED_RECEIPTS' then
    return query
    select to_jsonb(x) from (
      select r.receipt_number, r.receipt_date, o.outsourcing_order_number, o.order_type, o.supplier_name, r.supplier_document_number,
        p.sku, p.product_name, bt.batch_number, r.unit, r.received_quantity, r.accepted_quantity, r.rejected_quantity,
        r.rejection_disposition, r.rejection_reason, r.unit_cost
      from public.outsourcing_receipts r
      join public.outsourcing_orders o on o.id = r.outsourcing_order_id
      join public.products p on p.id = r.product_id
      left join public.inventory_batches bt on bt.id = r.batch_id
      where r.company_id = v_company and r.status = 'POSTED' and r.receipt_date between p_from and p_to
        and (p_product_id is null or r.product_id = p_product_id)
        and (p_warehouse_id is null or o.destination_warehouse_id = p_warehouse_id)
        and (v_supplier is null or o.supplier_name ilike '%' || v_supplier || '%')
      order by r.receipt_date desc, r.receipt_number desc) x;

  elsif p_report = 'IN_HOUSE_VS_OUTSOURCED' then
    return query
    select to_jsonb(x) from (
      select p.sku, p.product_name, p.base_unit as unit,
        coalesce(ih.qty, 0) as in_house_good, coalesce(os.qty, 0) as outsourced_accepted,
        coalesce(ih.qty, 0) + coalesce(os.qty, 0) as total,
        case when coalesce(ih.qty, 0) + coalesce(os.qty, 0) > 0
             then round(coalesce(ih.qty, 0) / (coalesce(ih.qty, 0) + coalesce(os.qty, 0)) * 100, 1) end as in_house_percent
      from public.products p
      left join (select r.product_id, sum(r.good_quantity) qty from public.production_output_receipts r
                 join public.production_orders o on o.id = r.production_order_id
                 where r.company_id = v_company and r.status = 'POSTED' and r.production_date between p_from and p_to
                   and (p_warehouse_id is null or o.destination_warehouse_id = p_warehouse_id)
                 group by r.product_id) ih on ih.product_id = p.id
      left join (select r.product_id, sum(r.accepted_quantity) qty from public.outsourcing_receipts r
                 join public.outsourcing_orders o on o.id = r.outsourcing_order_id
                 where r.company_id = v_company and r.status = 'POSTED' and r.receipt_date between p_from and p_to
                   and (p_warehouse_id is null or o.destination_warehouse_id = p_warehouse_id)
                   and (v_supplier is null or o.supplier_name ilike '%' || v_supplier || '%')
                 group by r.product_id) os on os.product_id = p.id
      where p.company_id = v_company and (ih.qty is not null or os.qty is not null)
        and (p_product_id is null or p.id = p_product_id)
      order by coalesce(ih.qty, 0) + coalesce(os.qty, 0) desc) x;

  elsif p_report = 'BATCH_TRACEABILITY' then
    return query
    select to_jsonb(x) from (
      select r.production_date as date, 'PRODUCTION' as kind, o.production_order_number as order_number, fp.sku as output_sku,
        obt.batch_number as output_batch, r.good_quantity as output_quantity, cp.sku as material_sku, ibt.batch_number as material_batch,
        c.actual_quantity as material_quantity, c.unit as material_unit, obt.is_system_lot as output_is_pooled_lot
      from public.production_output_receipts r
      join public.production_orders o on o.id = r.production_order_id
      join public.products fp on fp.id = r.product_id
      left join public.inventory_batches obt on obt.id = r.batch_id
      join public.production_material_consumption c on c.production_order_id = o.id and c.status = 'POSTED'
      join public.products cp on cp.id = c.component_product_id
      join public.inventory_batches ibt on ibt.id = c.batch_id
      where r.company_id = v_company and r.status = 'POSTED' and r.production_date between p_from and p_to
        and (p_product_id is null or r.product_id = p_product_id) and (p_bom_id is null or o.bom_id = p_bom_id)
      union all
      select r.receipt_date, 'OUTSOURCING', o.outsourcing_order_number, fp.sku, obt.batch_number, r.accepted_quantity,
        cp.sku, ibt.batch_number, mv.quantity, mv.unit, obt.is_system_lot
      from public.outsourcing_receipts r
      join public.outsourcing_orders o on o.id = r.outsourcing_order_id
      join public.products fp on fp.id = r.product_id
      left join public.inventory_batches obt on obt.id = r.batch_id
      left join public.outsourcing_material_movements mv on mv.receipt_id = r.id and mv.status = 'POSTED'
      left join public.products cp on cp.id = mv.component_product_id
      left join public.inventory_batches ibt on ibt.id = mv.batch_id
      where r.company_id = v_company and r.status = 'POSTED' and r.receipt_date between p_from and p_to
        and (p_product_id is null or r.product_id = p_product_id)
        and (v_supplier is null or o.supplier_name ilike '%' || v_supplier || '%')
      order by 1 desc, 3) x;

  elsif p_report = 'COST_SUMMARY' then
    return query select row_data from private.production_cost_rows(v_company, p_from, p_to, p_product_id);

  elsif p_report = 'VARIANCE' then
    return query
    select to_jsonb(x) from (
      select o.production_order_number, o.status, fp.sku as product_sku, o.unit as output_unit, o.planned_quantity, o.actual_quantity,
        o.actual_quantity - o.planned_quantity as output_variance,
        cp.sku as component_sku, m.unit, private.ceil_qty(m.quantity_per_unit * o.actual_quantity) as standard_for_output,
        private.ceil_qty(m.quantity_per_unit * o.actual_quantity * (1 + m.wastage_percentage / 100)) as allowed_with_wastage,
        m.issued_quantity,
        m.issued_quantity - private.ceil_qty(m.quantity_per_unit * o.actual_quantity) as usage_variance,
        case when o.actual_quantity = 0 then 'NO_OUTPUT'
             when m.issued_quantity > private.ceil_qty(m.quantity_per_unit * o.actual_quantity * (1 + m.wastage_percentage / 100)) then 'OVER_ALLOWANCE'
             when m.issued_quantity < private.ceil_qty(m.quantity_per_unit * o.actual_quantity) then 'BELOW_STANDARD'
             else 'WITHIN_ALLOWANCE' end as assessment
      from public.production_orders o
      join public.production_order_materials m on m.production_order_id = o.id
      join public.products fp on fp.id = o.finished_product_id
      join public.products cp on cp.id = m.component_product_id
      where o.company_id = v_company and o.status in ('IN_PROGRESS', 'PARTIALLY_COMPLETED', 'COMPLETED', 'ON_HOLD')
        and coalesce(o.actual_completion_date, o.actual_start_date) between p_from and p_to
        and (p_product_id is null or o.finished_product_id = p_product_id) and (p_bom_id is null or o.bom_id = p_bom_id)
        and (p_status is null or o.status = p_status)
        and (p_warehouse_id is null or o.source_warehouse_id = p_warehouse_id)
      order by o.production_order_number desc, m.line_no) x;
  else
    raise exception 'Unknown report %.', p_report using errcode = 'P0001';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Batch traceability (backward and forward), with completeness flags
-- -----------------------------------------------------------------------------
create or replace function public.production_trace_batch(p_batch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['production_reports.read', 'manufacturing.read']);
  v_lot     public.inventory_batches;
  v_inflow  numeric;
  v_linked  numeric;
begin
  select * into v_lot from public.inventory_batches where id = p_batch_id and company_id = v_company;
  if not found then
    raise exception 'Batch/lot not found in your company.' using errcode = 'P0001';
  end if;

  -- Inflows into this lot (net of reversals) and how much of that came from
  -- recorded production / outsourcing receipts.
  select coalesce(sum(t.quantity), 0),
         coalesce(sum(t.quantity) filter (where t.transaction_type in ('PRODUCTION_RECEIPT', 'SUBCONTRACT_RECEIPT')), 0)
    into v_inflow, v_linked
  from public.inventory_transactions t
  where t.batch_id = v_lot.id and t.direction = 1 and t.transaction_type not in ('TRANSFER_IN', 'REVERSAL')
    and not exists (select 1 from public.inventory_transactions r where r.reversal_of_transaction_id = t.id);

  return jsonb_build_object(
    'batch', (select jsonb_build_object('batch_id', bt.id, 'sku', p.sku, 'product_name', p.product_name, 'unit', p.base_unit,
                'batch_number', bt.batch_number, 'is_system_lot', bt.is_system_lot, 'source_type', bt.source_type,
                'manufacturing_date', bt.manufacturing_date, 'expiry_date', bt.expiry_date, 'created_at', bt.created_at,
                'on_hand', (select coalesce(sum(on_hand), 0) from public.inventory_balances where batch_id = bt.id))
              from public.inventory_batches bt join public.products p on p.id = bt.product_id where bt.id = v_lot.id),
    'completeness', jsonb_build_object(
      'inflow_quantity', v_inflow,
      'linked_inflow_quantity', v_linked,
      'unlinked_inflow_quantity', v_inflow - v_linked,
      'pooled_lot', v_lot.is_system_lot,
      'warnings', to_jsonb(array_remove(array[
        case when v_lot.is_system_lot then 'This product is not batch-tracked: all its ' || lower(v_lot.source_type) ||
          ' stock shares one pooled lot, so links show every order that fed or used the pool, not individual units.' end,
        case when v_inflow - v_linked > 0 then format('%s of %s received into this lot came from opening stock, purchases, returns or adjustments, which have no production or outsourcing link.',
          v_inflow - v_linked, v_inflow) end], null))),
    -- Backward: how this lot was produced and from which material lots.
    'produced_by', coalesce((
      select jsonb_agg(x order by x ->> 'date') from (
        select jsonb_build_object('kind', 'PRODUCTION', 'order_id', o.id, 'order_number', o.production_order_number,
          'receipt_number', r.receipt_number, 'date', r.production_date, 'good', r.good_quantity, 'rejected', r.rejected_quantity,
          'scrap', r.scrap_quantity, 'unit', r.unit,
          'materials', coalesce((select jsonb_agg(jsonb_build_object('batch_id', c.batch_id, 'sku', cp.sku, 'product_name', cp.product_name,
              'batch_number', cbt.batch_number, 'source_type', cbt.source_type, 'quantity', c.actual_quantity, 'unit', c.unit,
              'date', c.consumption_date) order by cp.sku)
            from public.production_material_consumption c
            join public.products cp on cp.id = c.component_product_id
            join public.inventory_batches cbt on cbt.id = c.batch_id
            where c.production_order_id = o.id and c.status = 'POSTED'), '[]'::jsonb)) as x
        from public.production_output_receipts r
        join public.production_orders o on o.id = r.production_order_id
        where r.batch_id = v_lot.id and r.status = 'POSTED'
        union all
        select jsonb_build_object('kind', 'OUTSOURCING', 'order_id', o.id, 'order_number', o.outsourcing_order_number,
          'supplier_name', o.supplier_name, 'order_type', o.order_type,
          'receipt_number', r.receipt_number, 'date', r.receipt_date, 'good', r.accepted_quantity, 'rejected', r.rejected_quantity,
          'unit', r.unit, 'supplier_document_number', r.supplier_document_number,
          'materials', coalesce((select jsonb_agg(jsonb_build_object('batch_id', mv.batch_id, 'sku', cp.sku, 'product_name', cp.product_name,
              'batch_number', cbt.batch_number, 'source_type', cbt.source_type, 'quantity', mv.quantity, 'unit', mv.unit,
              'date', mv.movement_date) order by cp.sku)
            from public.outsourcing_material_movements mv
            join public.products cp on cp.id = mv.component_product_id
            join public.inventory_batches cbt on cbt.id = mv.batch_id
            where mv.receipt_id = r.id and mv.status = 'POSTED'), '[]'::jsonb))
        from public.outsourcing_receipts r
        join public.outsourcing_orders o on o.id = r.outsourcing_order_id
        where r.batch_id = v_lot.id and r.status = 'POSTED'
      ) y), '[]'::jsonb),
    -- Forward: where this lot was used and what it became.
    'used_in', coalesce((
      select jsonb_agg(x order by x ->> 'date') from (
        select jsonb_build_object('kind', 'PRODUCTION', 'order_id', o.id, 'order_number', o.production_order_number,
          'date', min(c.consumption_date), 'quantity', sum(c.actual_quantity), 'unit', min(c.unit), 'order_status', o.status,
          'outputs', coalesce((select jsonb_agg(jsonb_build_object('batch_id', r.batch_id, 'sku', fp.sku, 'product_name', fp.product_name,
              'batch_number', obt.batch_number, 'good', r.good_quantity, 'receipt_number', r.receipt_number, 'date', r.production_date)
              order by r.production_date)
            from public.production_output_receipts r
            join public.products fp on fp.id = r.product_id
            left join public.inventory_batches obt on obt.id = r.batch_id
            where r.production_order_id = o.id and r.status = 'POSTED'), '[]'::jsonb)) as x
        from public.production_material_consumption c
        join public.production_orders o on o.id = c.production_order_id
        where c.batch_id = v_lot.id and c.status = 'POSTED'
        group by o.id, o.production_order_number, o.status
        union all
        select jsonb_build_object('kind', 'OUTSOURCING', 'order_id', o.id, 'order_number', o.outsourcing_order_number,
          'supplier_name', o.supplier_name, 'date', min(mv.movement_date), 'quantity', sum(mv.quantity), 'unit', min(mv.unit),
          'order_status', o.status,
          'outputs', coalesce((select jsonb_agg(jsonb_build_object('batch_id', r.batch_id, 'sku', fp.sku, 'product_name', fp.product_name,
              'batch_number', obt.batch_number, 'good', r.accepted_quantity, 'receipt_number', r.receipt_number, 'date', r.receipt_date)
              order by r.receipt_date)
            from public.outsourcing_receipts r
            join public.products fp on fp.id = r.product_id
            left join public.inventory_batches obt on obt.id = r.batch_id
            where r.outsourcing_order_id = o.id and r.status = 'POSTED'), '[]'::jsonb))
        from public.outsourcing_material_movements mv
        join public.outsourcing_orders o on o.id = mv.outsourcing_order_id
        where mv.batch_id = v_lot.id and mv.status = 'POSTED' and mv.movement_type = 'CONSUMPTION'
        group by o.id, o.outsourcing_order_number, o.supplier_name, o.status
      ) y), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('transaction_number', t.transaction_number, 'transaction_type', t.transaction_type,
          'direction', t.direction, 'quantity', t.quantity, 'unit', t.unit, 'transaction_date', t.transaction_date,
          'warehouse_code', w.warehouse_code, 'location_code', l.location_code, 'stock_usage', l.stock_usage,
          'reference_type', t.reference_type, 'reference_number', t.reference_number, 'reason', t.reason)
        order by t.transaction_date desc, t.transaction_number desc)
      from (select * from public.inventory_transactions where batch_id = v_lot.id order by transaction_date desc limit 300) t
      join public.warehouses w on w.id = t.warehouse_id
      join public.inventory_locations l on l.id = t.location_id), '[]'::jsonb)
  );
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.production_overview(date, date, uuid, uuid, text, text)',
    'public.production_report(text, date, date, uuid, uuid, text, uuid, text)',
    'public.production_trace_batch(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
