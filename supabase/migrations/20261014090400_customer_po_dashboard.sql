-- =============================================================================
-- Phase 6: customer PO dashboard
--
-- Aggregation rules (shown to users):
--   * Only current revisions count; superseded revisions are history.
--   * PO counts use POs received (uploaded) in the period (company timezone).
--   * Unit totals are grouped by unit of measure and never added across units.
--   * Demand, availability and shortage are computed PER PRODUCT across open
--     POs, then summed per unit, so stock shared by several POs is counted once:
--       available = eligible on hand - all active reservations
--       shortage  = max(outstanding demand not yet allocated - available, 0)
-- =============================================================================

create or replace function public.customer_po_dashboard(
  p_from         date,
  p_to           date,
  p_customer_key text default null,
  p_status       text default null,
  p_product_id   uuid default null,
  p_warehouse_id uuid default null,
  p_bucket       text default 'day'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('customer_po.read');
  v_tz      text := private.company_tz(v_company);
  v_result  jsonb;
begin
  if p_bucket not in ('day', 'week', 'month', 'year') then
    raise exception 'Bucket must be day, week, month or year.' using errcode = 'P0001';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Choose a valid date range (at most about 10 years).' using errcode = 'P0001';
  end if;

  with pos as (
    select po.* from public.customer_purchase_orders po
    where po.company_id = v_company and po.is_current
      and po.created_at >= private.company_day_start(v_company, p_from) and po.created_at < private.company_day_start(v_company, p_to + 1)
      and (p_customer_key is null or po.customer_key = p_customer_key)
      and (p_status is null or po.status = p_status)
      and (p_warehouse_id is null or po.fulfilment_warehouse_id = p_warehouse_id)
      and (p_product_id is null or exists (select 1 from public.customer_purchase_order_lines l where l.purchase_order_id = po.id and l.product_id = p_product_id))
  ),
  open_pos as (select * from pos where status not in ('CANCELLED', 'FULFILLED', 'DRAFT')),
  summaries as (select po.id, private.po_availability_summary(v_company, po.id) ->> 'availability_status' as availability from open_pos po),
  shortage_pos as (
    select distinct po.id from open_pos po cross join lateral private.po_line_analysis(v_company, po.id) a
    where a.line_status = 'MATCHED' and a.shortage_before > 0
  ),
  demand as (
    select l.product_id, p.base_unit as unit, p.category_id, p.sku, p.product_name,
      sum(l.quantity_ordered) as ordered,
      sum(greatest(l.quantity_ordered - l.quantity_dispatched - private.po_line_open_reserved(l.id), 0)) as need,
      sum(private.po_line_open_reserved(l.id)) as reserved_for_pos
    from open_pos po
    join public.customer_purchase_order_lines l on l.purchase_order_id = po.id and l.line_status = 'MATCHED'
    join public.products p on p.id = l.product_id and l.unit = p.base_unit
    where p_product_id is null or l.product_id = p_product_id
    group by l.product_id, p.base_unit, p.category_id, p.sku, p.product_name
  ),
  stock as (
    select d.product_id,
      coalesce(sum(s.available) filter (where s.eligible), 0) as available,
      coalesce(sum(s.available) filter (where s.eligible and s.source_type = 'IN_HOUSE'), 0) as in_house,
      coalesce(sum(s.available) filter (where s.eligible and s.source_type = 'OUTSOURCED'), 0) as outsourced,
      coalesce(sum(s.on_hand) filter (where s.source_type = 'UNKNOWN'), 0) as unknown
    from demand d
    cross join lateral private.po_eligible_stock(v_company, d.product_id, p_warehouse_id) s
    group by d.product_id
  ),
  prod as (
    select d.*, coalesce(s.available, 0) as available, coalesce(s.in_house, 0) as in_house, coalesce(s.outsourced, 0) as outsourced,
      coalesce(s.unknown, 0) as unknown, greatest(d.need - coalesce(s.available, 0), 0) as shortage
    from demand d left join stock s on s.product_id = d.product_id
  )
  select jsonb_build_object(
    'has_records', exists (select 1 from public.customer_purchase_orders where company_id = v_company),
    'total_received', (select count(*) from pos),
    'pending_review', (select count(*) from pos where status in ('UPLOADED', 'VALIDATION_REQUIRED', 'PRODUCT_MATCHING_REQUIRED')),
    'ready_for_fulfilment', (select count(*) from pos where status = 'READY_FOR_ALLOCATION'),
    'partially_available', (select count(*) from summaries where availability = 'PARTIALLY_AVAILABLE'),
    'with_shortages', (select count(*) from shortage_pos),
    'fully_allocated', (select count(*) from pos where status = 'FULLY_ALLOCATED'),
    'units', coalesce((select jsonb_agg(jsonb_build_object('unit', unit, 'ordered', ordered, 'need', need, 'available', available,
        'reserved_for_pos', reserved, 'shortage', shortage, 'in_house_available', ih, 'outsourced_available', os, 'unknown_on_hand', unk) order by unit)
      from (select unit, sum(ordered) ordered, sum(need) need, sum(available) available, sum(reserved_for_pos) reserved, sum(shortage) shortage,
              sum(in_house) ih, sum(outsourced) os, sum(unknown) unk from prod group by unit) x), '[]'::jsonb),
    'by_status', coalesce((select jsonb_agg(jsonb_build_object('status', status, 'count', n) order by status)
      from (select status, count(*) n from pos group by status) x), '[]'::jsonb),
    'top_products', coalesce((select jsonb_agg(x order by (x ->> 'ordered')::numeric desc) from (
        select jsonb_build_object('sku', sku, 'product_name', product_name, 'unit', unit, 'ordered', ordered, 'available', available, 'shortage', shortage) x
        from prod order by ordered desc limit 10) y), '[]'::jsonb),
    'shortage_by_category', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'unit', unit, 'shortage', shortage) order by shortage desc)
      from (select coalesce(c.name, 'Uncategorised') as category, p.unit, sum(p.shortage) shortage
            from prod p left join public.product_categories c on c.id = p.category_id
            group by 1, 2 having sum(p.shortage) > 0) x), '[]'::jsonb),
    'received_over_time', coalesce((select jsonb_agg(jsonb_build_object('bucket', bucket, 'count', n) order by bucket)
      from (select date_trunc(p_bucket, created_at at time zone v_tz)::date as bucket, count(*) n from pos group by 1) x), '[]'::jsonb),
    'timezone', v_tz,
    'as_of', now()
  ) into v_result;
  return v_result;
end;
$$;

-- Distinct customers seen on POs (record or external name) for filters.
create or replace function public.customer_po_customer_options()
returns table (customer_key text, customer_name text, customer_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('customer_po.read');
begin
  return query
  select distinct on (po.customer_key) po.customer_key, po.customer_name_snapshot, po.customer_id
  from public.customer_purchase_orders po
  where po.company_id = v_company
  order by po.customer_key, po.created_at desc;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.customer_po_dashboard(date, date, text, text, uuid, uuid, text)',
    'public.customer_po_customer_options()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
