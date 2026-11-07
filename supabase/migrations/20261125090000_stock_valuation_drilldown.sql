-- Product-wise stock valuation for the Management Dashboard "Total Stock" drill-down.
--
-- Read-only additions. Nothing here changes a table, a stock balance, a transaction,
-- a product cost field or an existing function. The valuation rule is the one the
-- stock reports already use (public.inventory_valuation, private.analytics_valuation,
-- private.mo_inventory "valued at"):
--
--   * each lot is valued at private.lot_average_cost(batch): the weighted-average cost
--     of its costed inflows (opening stock, receipts, returns, adjustments in,
--     production and subcontract receipts), reversals excluded;
--   * a lot with any uncosted inflow has no cost (NULL) and is never valued at zero;
--   * lot value = round(on_hand * lot cost, 2); totals add up the valued lots.
--
-- MRP, selling price, standard / manufacturing cost and last purchase cost are not used.
--
-- 1. inventory_balance_value          one row per lot and location with stock on hand
-- 2. inventory_product_stock_value    inventory_product_stock + unit_cost, stock_value
-- 3. inventory_stock_value_summary()  totals for the drill-down summary cards
--
-- Rollback: supabase/rollback/20261125090000_stock_valuation_drilldown_down.sql

-- -----------------------------------------------------------------------------
-- 1. Value of each lot in each location
-- -----------------------------------------------------------------------------
-- Same lot cost wherever the lot is stored: the ERP costs lots, not locations,
-- so a location's value is its quantity of each lot at that lot's cost.
create or replace view public.inventory_balance_value
with (security_invoker = true) as
select
  b.id as balance_id, b.company_id, b.product_id, b.batch_id, b.warehouse_id, b.location_id, b.on_hand,
  x.cost as unit_cost,
  round(b.on_hand * x.cost, 2) as stock_value
from public.inventory_balances b
cross join lateral (select private.lot_average_cost(b.batch_id) as cost) x
where b.on_hand > 0;

comment on view public.inventory_balance_value is
  'Stock value per lot and location: on hand x private.lot_average_cost (the stock report valuation). unit_cost and stock_value are NULL when the lot has an uncosted inflow.';

revoke all on public.inventory_balance_value from anon, authenticated;
grant select on public.inventory_balance_value to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Product stock with its value
-- -----------------------------------------------------------------------------
-- unit_cost   = value of the valued lots / their quantity (average inventory cost per unit)
-- stock_value = sum of the valued lots (the same total as the stock reports)
-- valuation_status:
--   VALUED      every lot on hand has a cost
--   PARTIAL     some lots have no cost: stock_value covers valued_on_hand only
--   NOT_VALUED  stock on hand, but no lot has a cost (unit_cost and stock_value NULL)
--   NO_STOCK    nothing on hand
create or replace view public.inventory_product_stock_value
with (security_invoker = true) as
select
  s.*,
  case when v.valued_on_hand > 0 then v.full_value / v.valued_on_hand end as unit_cost,
  v.stock_value,
  coalesce(v.valued_on_hand, 0) as valued_on_hand,
  coalesce(v.unvalued_on_hand, 0) as unvalued_on_hand,
  case
    when coalesce(v.lots, 0) = 0 then 'NO_STOCK'
    when v.unvalued_lots = 0 then 'VALUED'
    when v.unvalued_lots < v.lots then 'PARTIAL'
    else 'NOT_VALUED'
  end as valuation_status
from public.inventory_product_stock s
left join (
  select bv.product_id,
    count(*) as lots,
    count(*) filter (where bv.unit_cost is null) as unvalued_lots,
    sum(bv.on_hand) filter (where bv.unit_cost is not null) as valued_on_hand,
    sum(bv.on_hand) filter (where bv.unit_cost is null) as unvalued_on_hand,
    sum(bv.stock_value) filter (where bv.unit_cost is not null) as stock_value,
    -- full precision for the per-unit average (lot values are rounded to paise)
    sum(bv.on_hand * bv.unit_cost) filter (where bv.unit_cost is not null) as full_value
  from public.inventory_balance_value bv
  group by bv.product_id
) v on v.product_id = s.product_id;

comment on view public.inventory_product_stock_value is
  'inventory_product_stock plus its stock valuation (the stock report rule: lot weighted-average cost x on hand; uncosted lots are not valued).';

revoke all on public.inventory_product_stock_value from anon, authenticated;
grant select on public.inventory_product_stock_value to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Summary cards of the Total Stock drill-down
-- -----------------------------------------------------------------------------
-- The same records as the drill-down list (metric inventory.on_hand: not archived,
-- stock on hand <> 0, optional unit) and the same search (SKU, name or barcode
-- containing the text), added up on the server.
create or replace function public.inventory_stock_value_summary(p_unit text default null, p_search text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory.read');
  v_term    text := nullif(btrim(coalesce(p_search, '')), '');
  v_like    text;
  v         jsonb;
begin
  if v_term is not null then
    -- Same escaping as the app: \ % _ are literal; , ( ) become spaces.
    v_like := '%' || translate(replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_'), ',()', '   ') || '%';
  end if;
  with rows as (
    select s.* from public.inventory_product_stock_value s
    where s.company_id = v_company and s.archived_at is null and s.on_hand <> 0
      and (p_unit is null or s.base_unit = p_unit)
      and (v_like is null or s.sku ilike v_like or s.product_name ilike v_like or s.barcode ilike v_like)
  )
  select jsonb_build_object(
    'products', count(*),
    'units', coalesce((select jsonb_agg(jsonb_build_object('unit', base_unit, 'on_hand', oh, 'reserved', rs, 'available', av) order by base_unit)
       from (select base_unit, sum(on_hand) oh, sum(reserved) rs, sum(available) av from rows group by base_unit) u), '[]'::jsonb),
    'total_value', coalesce(sum(stock_value), 0),
    'valued_products', count(*) filter (where valuation_status = 'VALUED'),
    'partly_valued_products', count(*) filter (where valuation_status = 'PARTIAL'),
    'not_valued_products', count(*) filter (where valuation_status = 'NOT_VALUED'),
    'method', 'Weighted-average cost of each lot (the stock report valuation) x quantity on hand. Lots without a cost are not valued.'
  ) into v
  from rows;
  return v;
end;
$$;

revoke all on function public.inventory_stock_value_summary(text, text) from public, anon;
grant execute on function public.inventory_stock_value_summary(text, text) to authenticated;
