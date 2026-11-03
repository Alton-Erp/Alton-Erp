-- =============================================================================
-- Amazon analytics (read-only, amazon.read)
--
-- One component function, private.amazon_sku_day, assembles every money and
-- quantity component per seller SKU and day. All dashboards, product, campaign
-- and inventory views aggregate it, and the browser applies the single set of
-- formulas in src/features/amazon/metrics.ts. Definitions:
--
--   * ordered_sales: "Ordered product sales" as reported by Amazon (or CSV).
--     When amazon_settings.prices_include_gst is true (default), sales,
--     refunds and promotion discounts are converted to ex-GST with the listing's
--     GST rate (if set) or the mapped ERP product's GST rate; without a GST rate the ex-GST value is NULL
--     (unavailable) rather than guessed.
--   * Fees: actual settlement fees when synchronised for that SKU and day
--     (fees_source not null); otherwise ESTIMATES from the listing's referral
--     fee % (of GST-inclusive sales, as Amazon charges it) and per-unit
--     fulfilment, closing, shipping and other variable costs. Fees, product
--     cost and advertising are treated as ex-GST (GST on them is input credit).
--   * Product cost: listing override, else ERP products.standard_cost, else
--     NULL (missing - flagged, never zero).
--   * Advertising by product: Sponsored Products advertised-product report,
--     joined on seller SKU and date. Account-level advertising totals come
--     from the campaign report (all ad products).
--   * is_demo = p_demo on every table: demo and live data are never combined.
-- =============================================================================

create or replace function private.amazon_sku_day(p_company uuid, p_from date, p_to date, p_demo boolean, p_marketplace text default null)
returns table (
  seller_sku text, marketplace_id text, metric_date date, listing_id uuid, product_id uuid, gst_rate numeric,
  ordered_sales numeric, units integer, order_items integer, sessions integer, page_views integer,
  refund_amount numeric, refunded_units integer, promotion_discounts numeric,
  sales_ex_gst numeric, refunds_ex_gst numeric, discounts_ex_gst numeric,
  has_actual_fees boolean, actual_referral numeric, actual_fulfilment numeric, actual_other numeric,
  est_referral numeric, est_fulfilment numeric, shipping_cost numeric, other_variable_cost numeric,
  unit_cost numeric, product_cost numeric, cost_source text,
  ad_spend numeric, ad_sales numeric, ad_orders integer, ad_units integer, ad_clicks bigint, ad_impressions bigint,
  has_sales_data boolean
)
language sql stable security definer set search_path = '' as $$
  with cfg as (select coalesce((select prices_include_gst from public.amazon_settings where company_id = p_company), true) as incl),
  s as (
    select d.* from public.amazon_sku_daily d
    where d.company_id = p_company and d.is_demo = p_demo and d.metric_date between p_from and p_to and (p_marketplace is null or d.marketplace_id = p_marketplace)),
  a as (
    select a.seller_sku, a.metric_date, sum(a.spend) spend, sum(a.sales) sales, sum(a.orders)::int orders, sum(a.units)::int units, sum(a.clicks)::bigint clicks, sum(a.impressions)::bigint impressions
    from public.amazon_ad_product_daily a
    where a.company_id = p_company and a.is_demo = p_demo and a.metric_date between p_from and p_to
    group by 1, 2),
  k as (
    select coalesce(s.seller_sku, a.seller_sku) seller_sku, coalesce(s.metric_date, a.metric_date) metric_date, s.marketplace_id, s.id as sid
    from s full join a on a.seller_sku = s.seller_sku and a.metric_date = s.metric_date)
  select k.seller_sku, coalesce(k.marketplace_id, l.marketplace_id), k.metric_date, l.id, l.product_id, coalesce(l.gst_rate, p.gst_rate),
    s.ordered_sales, s.units_ordered, s.total_order_items, s.sessions, s.page_views, s.refund_amount, s.refunded_units, s.promotion_discounts,
    case when not cfg.incl then s.ordered_sales when coalesce(l.gst_rate, p.gst_rate) is not null then round(s.ordered_sales / (1 + coalesce(l.gst_rate, p.gst_rate) / 100), 2) end,
    case when not cfg.incl then s.refund_amount when coalesce(l.gst_rate, p.gst_rate) is not null then round(s.refund_amount / (1 + coalesce(l.gst_rate, p.gst_rate) / 100), 2) end,
    case when not cfg.incl then s.promotion_discounts when coalesce(l.gst_rate, p.gst_rate) is not null then round(s.promotion_discounts / (1 + coalesce(l.gst_rate, p.gst_rate) / 100), 2) end,
    coalesce(s.fees_source is not null, false), s.referral_fees, s.fulfilment_fees, s.other_fees,
    case when l.referral_fee_pct is not null then round(coalesce(s.ordered_sales, 0) * l.referral_fee_pct / 100, 2) end,
    case when l.fulfilment_fee_per_unit is not null or l.closing_fee_per_unit is not null
         then round(coalesce(s.units_ordered, 0) * (coalesce(l.fulfilment_fee_per_unit, 0) + coalesce(l.closing_fee_per_unit, 0)), 2) end,
    case when l.shipping_cost_per_unit is not null then round(coalesce(s.units_ordered, 0) * l.shipping_cost_per_unit, 2) end,
    case when l.other_variable_cost_per_unit is not null then round(coalesce(s.units_ordered, 0) * l.other_variable_cost_per_unit, 2) end,
    coalesce(l.unit_cost_override, p.standard_cost),
    round(coalesce(s.units_ordered, 0) * coalesce(l.unit_cost_override, p.standard_cost), 2),
    case when l.unit_cost_override is not null then 'LISTING_OVERRIDE' when p.standard_cost is not null then 'ERP_STANDARD_COST' else 'MISSING' end,
    coalesce(a.spend, 0), coalesce(a.sales, 0), coalesce(a.orders, 0), coalesce(a.units, 0), coalesce(a.clicks, 0), coalesce(a.impressions, 0),
    s.id is not null and s.ordered_sales is not null
  from k
  cross join cfg
  left join s on s.id = k.sid
  left join a on a.seller_sku = k.seller_sku and a.metric_date = k.metric_date
  left join lateral (
    select l.* from public.amazon_listings l
    where l.company_id = p_company and l.is_demo = p_demo and l.seller_sku = k.seller_sku and (k.marketplace_id is null or l.marketplace_id = k.marketplace_id)
    order by l.created_at limit 1) l on true
  left join public.products p on p.id = l.product_id and p.company_id = p_company
$$;
revoke all on function private.amazon_sku_day(uuid, date, date, boolean, text) from public, anon, authenticated;

create or replace function private.amazon_check_range(p_from date, p_to date) returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 731 then
    raise exception 'Choose a valid date range of at most two years.' using errcode = 'P0001';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Product performance: one row per seller SKU with component sums, unit
-- economics, stock from both sources (with source and time) and recent velocity.
-- -----------------------------------------------------------------------------
create or replace function public.amazon_product_performance(p_from date, p_to date, p_demo boolean default false, p_marketplace text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_company uuid := private.require_permission('amazon.read');
  v_today date := private.company_today(v_company);
begin
  perform private.amazon_check_range(p_from, p_to);
  return jsonb_build_object('from', p_from, 'to', p_to, 'demo', p_demo, 'today', v_today, 'generated_at', now(),
    'settings', (select to_jsonb(s) - 'company_id' - 'updated_by' from public.amazon_settings s where s.company_id = v_company),
    'rows', coalesce((
      with d as (select * from private.amazon_sku_day(v_company, p_from, p_to, p_demo, p_marketplace)),
      agg as (
        select d.seller_sku,
          sum(d.ordered_sales) ordered_sales, sum(d.units) units, sum(d.order_items) order_items, sum(d.sessions) sessions, sum(d.page_views) page_views,
          sum(d.refund_amount) refund_amount, sum(d.refunded_units) refunded_units, sum(d.promotion_discounts) promotion_discounts,
          sum(d.sales_ex_gst) sales_ex_gst, sum(d.refunds_ex_gst) refunds_ex_gst, sum(d.discounts_ex_gst) discounts_ex_gst,
          bool_or(d.has_sales_data and d.sales_ex_gst is null and coalesce(d.ordered_sales, 0) <> 0) gst_missing,
          sum(case when d.has_actual_fees then coalesce(d.actual_referral, 0) end) actual_referral,
          sum(case when d.has_actual_fees then coalesce(d.actual_fulfilment, 0) end) actual_fulfilment,
          sum(case when d.has_actual_fees then coalesce(d.actual_other, 0) end) actual_other,
          sum(case when not d.has_actual_fees then d.est_referral end) est_referral,
          sum(case when not d.has_actual_fees then d.est_fulfilment end) est_fulfilment,
          count(*) filter (where d.has_sales_data) sales_days, count(*) filter (where d.has_actual_fees) actual_fee_days,
          count(*) filter (where d.has_sales_data and not d.has_actual_fees and coalesce(d.units, 0) > 0 and d.est_referral is null) fee_missing_days,
          sum(d.shipping_cost) shipping_cost, sum(d.other_variable_cost) other_variable_cost,
          sum(d.product_cost) product_cost, sum(case when d.unit_cost is null then d.units else 0 end) units_without_cost,
          sum(d.ad_spend) ad_spend, sum(d.ad_sales) ad_sales, sum(d.ad_orders) ad_orders, sum(d.ad_units) ad_units, sum(d.ad_clicks) ad_clicks, sum(d.ad_impressions) ad_impressions
        from d group by d.seller_sku),
      keys as (
        select seller_sku from agg
        union select seller_sku from public.amazon_listings where company_id = v_company and is_demo = p_demo and (p_marketplace is null or marketplace_id = p_marketplace))
      select jsonb_agg(jsonb_build_object(
        'seller_sku', k.seller_sku, 'listing_id', l.id, 'asin', l.asin, 'title', coalesce(l.title, p.product_name), 'marketplace_id', l.marketplace_id,
        'product_id', l.product_id, 'erp_sku', p.sku, 'erp_name', p.product_name, 'category', cat.name, 'item_price', l.item_price, 'fulfillment_channel', l.fulfillment_channel,
        'listing_status', l.listing_status, 'advertising_status', l.advertising_status, 'data_source', l.data_source, 'gst_rate', coalesce(l.gst_rate, p.gst_rate),
        'gst_source', case when l.gst_rate is not null then 'LISTING' when p.gst_rate is not null then 'ERP_PRODUCT' else 'MISSING' end,
        'unit_cost', coalesce(l.unit_cost_override, p.standard_cost),
        'cost_source', case when l.unit_cost_override is not null then 'LISTING_OVERRIDE' when p.standard_cost is not null then 'ERP_STANDARD_COST' else 'MISSING' end,
        'costs_updated_at', l.costs_updated_at, 'referral_fee_pct', l.referral_fee_pct, 'closing_fee_per_unit', l.closing_fee_per_unit,
        'fulfilment_fee_per_unit', l.fulfilment_fee_per_unit, 'shipping_cost_per_unit', l.shipping_cost_per_unit, 'other_variable_cost_per_unit', l.other_variable_cost_per_unit,
        'desired_contribution_per_unit', l.desired_contribution_per_unit, 'target_acos_pct', l.target_acos_pct, 'min_stock', l.min_stock, 'lead_time_days', l.lead_time_days,
        'totals', to_jsonb(a) - 'seller_sku',
        'stock', jsonb_build_object(
          'erp_available', case when l.product_id is not null then (select coalesce(sum(b.on_hand - b.reserved), 0) from public.inventory_balances b
              join public.inventory_locations il on il.id = b.location_id where b.company_id = v_company and b.product_id = l.product_id and il.stock_usage = 'STORAGE') end,
          'erp_as_of', case when l.product_id is not null then now() end,
          'amazon_fulfillable', inv.fulfillable_qty, 'amazon_inbound', inv.inbound_qty, 'amazon_as_of', inv.snapshot_at, 'amazon_source', inv.data_source,
          'incoming_production', case when l.product_id is not null then (select coalesce(sum(greatest(po.planned_quantity - po.completed_quantity, 0)), 0)
              from public.production_orders po where po.company_id = v_company and po.finished_product_id = l.product_id
                and po.status in ('APPROVED', 'MATERIALS_RESERVED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED', 'ON_HOLD')) end),
        'velocity', (
          select jsonb_build_object('units_7', coalesce(sum(x.units_ordered) filter (where x.metric_date > v_today - 7), 0),
            'units_28', coalesce(sum(x.units_ordered) filter (where x.metric_date > v_today - 28), 0),
            'units_56', coalesce(sum(x.units_ordered), 0),
            'days_with_data_28', count(*) filter (where x.metric_date > v_today - 28),
            'daily_28', (select coalesce(jsonb_agg(coalesce(y.u, 0) order by g.day), '[]'::jsonb) from generate_series(v_today - 27, v_today, interval '1 day') g(day)
              left join lateral (select sum(z.units_ordered) u from public.amazon_sku_daily z where z.company_id = v_company and z.is_demo = p_demo and z.seller_sku = k.seller_sku
                and z.metric_date = g.day::date) y on true))
          from public.amazon_sku_daily x where x.company_id = v_company and x.is_demo = p_demo and x.seller_sku = k.seller_sku and x.metric_date > v_today - 56),
        'campaigns', (select coalesce(jsonb_agg(distinct ap.campaign_id), '[]'::jsonb) from public.amazon_ad_product_daily ap
          where ap.company_id = v_company and ap.is_demo = p_demo and ap.seller_sku = k.seller_sku and ap.metric_date between p_from and p_to)
      ) order by coalesce(a.ordered_sales, 0) desc, k.seller_sku)
      from keys k
      left join agg a on a.seller_sku = k.seller_sku
      left join lateral (select * from public.amazon_listings l where l.company_id = v_company and l.is_demo = p_demo and l.seller_sku = k.seller_sku
                         and (p_marketplace is null or l.marketplace_id = p_marketplace) order by l.created_at limit 1) l on true
      left join public.products p on p.id = l.product_id
      left join public.product_categories cat on cat.id = p.category_id
      left join lateral (select i.* from public.amazon_inventory_snapshots i where i.company_id = v_company and i.is_demo = p_demo and i.seller_sku = k.seller_sku
                         order by i.snapshot_at desc limit 1) inv on true
    ), '[]'::jsonb));
end $$;

-- -----------------------------------------------------------------------------
-- Daily series (overview charts, product detail when p_seller_sku is given)
-- -----------------------------------------------------------------------------
create or replace function public.amazon_daily_series(p_from date, p_to date, p_demo boolean default false, p_marketplace text default null, p_seller_sku text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid := private.require_permission('amazon.read');
begin
  perform private.amazon_check_range(p_from, p_to);
  return (
    with d as (select * from private.amazon_sku_day(v_company, p_from, p_to, p_demo, p_marketplace) x where p_seller_sku is null or x.seller_sku = p_seller_sku),
    comp as (
      select d.metric_date, jsonb_build_object('ordered_sales', sum(d.ordered_sales), 'units', sum(d.units), 'order_items', sum(d.order_items), 'sessions', sum(d.sessions),
        'refund_amount', sum(d.refund_amount), 'promotion_discounts', sum(d.promotion_discounts),
        'sales_ex_gst', sum(d.sales_ex_gst), 'refunds_ex_gst', sum(d.refunds_ex_gst), 'discounts_ex_gst', sum(d.discounts_ex_gst),
        'gst_missing', bool_or(d.has_sales_data and d.sales_ex_gst is null and coalesce(d.ordered_sales, 0) <> 0),
        'actual_referral', sum(case when d.has_actual_fees then coalesce(d.actual_referral, 0) end), 'actual_fulfilment', sum(case when d.has_actual_fees then coalesce(d.actual_fulfilment, 0) end),
        'actual_other', sum(case when d.has_actual_fees then coalesce(d.actual_other, 0) end),
        'est_referral', sum(case when not d.has_actual_fees then d.est_referral end), 'est_fulfilment', sum(case when not d.has_actual_fees then d.est_fulfilment end),
        'fee_missing_days', count(*) filter (where d.has_sales_data and not d.has_actual_fees and coalesce(d.units, 0) > 0 and d.est_referral is null),
        'shipping_cost', sum(d.shipping_cost), 'other_variable_cost', sum(d.other_variable_cost), 'product_cost', sum(d.product_cost),
        'units_without_cost', sum(case when d.unit_cost is null then d.units else 0 end),
        'ad_spend', sum(d.ad_spend), 'ad_sales', sum(d.ad_sales), 'ad_orders', sum(d.ad_orders), 'ad_clicks', sum(d.ad_clicks), 'ad_impressions', sum(d.ad_impressions),
        'sales_days', count(*) filter (where d.has_sales_data)) j
      from d group by d.metric_date),
    acct as (
      select cd.metric_date, jsonb_build_object('spend', sum(cd.spend), 'sales', sum(cd.sales), 'orders', sum(cd.orders), 'clicks', sum(cd.clicks), 'impressions', sum(cd.impressions),
        'budget', sum(coalesce(cd.budget, cp.daily_budget)), 'rows', count(*)) j
      from public.amazon_campaign_daily cd join public.amazon_campaigns cp on cp.company_id = cd.company_id and cp.profile_id = cd.profile_id and cp.campaign_id = cd.campaign_id
      where cd.company_id = v_company and cd.is_demo = p_demo and cd.metric_date between p_from and p_to and p_seller_sku is null
      group by cd.metric_date)
    select jsonb_build_object('from', p_from, 'to', p_to, 'demo', p_demo, 'days', coalesce(jsonb_agg(jsonb_build_object('date', g.day::date, 'components', comp.j, 'account_ads', acct.j) order by g.day), '[]'::jsonb))
    from generate_series(p_from, p_to, interval '1 day') g(day)
    left join comp on comp.metric_date = g.day::date
    left join acct on acct.metric_date = g.day::date);
end $$;

-- -----------------------------------------------------------------------------
-- Campaign performance
-- -----------------------------------------------------------------------------
create or replace function public.amazon_campaign_performance(p_from date, p_to date, p_demo boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid := private.require_permission('amazon.read');
begin
  perform private.amazon_check_range(p_from, p_to);
  return jsonb_build_object('from', p_from, 'to', p_to, 'demo', p_demo, 'generated_at', now(),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'campaign_id', c.campaign_id, 'profile_id', c.profile_id, 'name', c.name, 'ad_product', c.ad_product, 'targeting_type', c.targeting_type, 'state', c.state,
        'daily_budget', c.daily_budget, 'portfolio_id', c.portfolio_id, 'data_source', c.data_source, 'last_synced_at', c.last_synced_at,
        'impressions', coalesce(m.impressions, 0), 'clicks', coalesce(m.clicks, 0), 'spend', coalesce(m.spend, 0), 'sales', coalesce(m.sales, 0),
        'orders', coalesce(m.orders, 0), 'units', coalesce(m.units, 0), 'days_with_data', coalesce(m.days, 0),
        'budget_total', m.budget_total, 'budget_constrained_days', coalesce(m.constrained_days, 0),
        'zero_order_target_spend', (select coalesce(sum(t.spend), 0) from (select sum(st.spend) spend, sum(st.orders) orders from public.amazon_search_term_daily st
            where st.company_id = v_company and st.is_demo = p_demo and st.campaign_id = c.campaign_id and st.metric_date between p_from and p_to
            group by st.targeting, st.match_type) t where t.orders = 0),
        'products', (select coalesce(jsonb_agg(distinct ap.seller_sku), '[]'::jsonb) from public.amazon_ad_product_daily ap
            where ap.company_id = v_company and ap.is_demo = p_demo and ap.campaign_id = c.campaign_id and ap.metric_date between p_from and p_to)
      ) order by coalesce(m.spend, 0) desc, c.name)
      from public.amazon_campaigns c
      left join lateral (
        select sum(d.impressions) impressions, sum(d.clicks) clicks, sum(d.spend) spend, sum(d.sales) sales, sum(d.orders) orders, sum(d.units) units, count(*) days,
          sum(coalesce(d.budget, c.daily_budget)) budget_total,
          count(*) filter (where coalesce(d.budget, c.daily_budget) > 0 and d.spend >= 0.95 * coalesce(d.budget, c.daily_budget)) constrained_days
        from public.amazon_campaign_daily d where d.company_id = v_company and d.profile_id = c.profile_id and d.campaign_id = c.campaign_id and d.metric_date between p_from and p_to) m on true
      where c.company_id = v_company and c.is_demo = p_demo
    ), '[]'::jsonb));
end $$;

create or replace function public.amazon_campaign_detail(p_campaign_id text, p_from date, p_to date, p_demo boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid := private.require_permission('amazon.read'); v_c public.amazon_campaigns;
begin
  perform private.amazon_check_range(p_from, p_to);
  select * into v_c from public.amazon_campaigns where company_id = v_company and campaign_id = p_campaign_id and is_demo = p_demo limit 1;
  if not found then raise exception 'Campaign not found.' using errcode = 'P0001'; end if;
  return jsonb_build_object('campaign', to_jsonb(v_c) - 'company_id',
    'days', coalesce((select jsonb_agg(jsonb_build_object('date', d.metric_date, 'impressions', d.impressions, 'clicks', d.clicks, 'spend', d.spend, 'sales', d.sales,
        'orders', d.orders, 'budget', coalesce(d.budget, v_c.daily_budget)) order by d.metric_date)
      from public.amazon_campaign_daily d where d.company_id = v_company and d.profile_id = v_c.profile_id and d.campaign_id = v_c.campaign_id and d.metric_date between p_from and p_to), '[]'::jsonb),
    'ad_groups', coalesce((select jsonb_agg(to_jsonb(g) - 'company_id' order by g.name) from public.amazon_ad_groups g
      where g.company_id = v_company and g.profile_id = v_c.profile_id and g.campaign_id = v_c.campaign_id), '[]'::jsonb),
    'targets', coalesce((
      select jsonb_agg(jsonb_build_object('target_id', t.target_id, 'ad_group_id', t.ad_group_id, 'expression', t.expression, 'match_type', t.match_type, 'target_type', t.target_type,
        'state', t.state, 'bid', t.bid, 'impressions', coalesce(m.impressions, 0), 'clicks', coalesce(m.clicks, 0), 'spend', coalesce(m.spend, 0), 'sales', coalesce(m.sales, 0),
        'orders', coalesce(m.orders, 0)) order by coalesce(m.spend, 0) desc)
      from public.amazon_targets t
      left join lateral (select sum(st.impressions) impressions, sum(st.clicks) clicks, sum(st.spend) spend, sum(st.sales) sales, sum(st.orders) orders
        from public.amazon_search_term_daily st where st.company_id = v_company and st.is_demo = p_demo and st.campaign_id = t.campaign_id
          and (st.target_id = t.target_id or (st.target_id is null and lower(st.targeting) = lower(t.expression) and coalesce(st.match_type, '') = coalesce(t.match_type, '')))
          and st.metric_date between p_from and p_to) m on true
      where t.company_id = v_company and t.profile_id = v_c.profile_id and t.campaign_id = v_c.campaign_id), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(x order by x ->> 'seller_sku') from (
      select jsonb_build_object('seller_sku', ap.seller_sku, 'asin', max(ap.asin), 'impressions', sum(ap.impressions), 'clicks', sum(ap.clicks), 'spend', sum(ap.spend),
        'sales', sum(ap.sales), 'orders', sum(ap.orders), 'units', sum(ap.units)) x
      from public.amazon_ad_product_daily ap where ap.company_id = v_company and ap.is_demo = p_demo and ap.campaign_id = v_c.campaign_id and ap.metric_date between p_from and p_to
      group by ap.seller_sku) y), '[]'::jsonb),
    'placements', jsonb_build_object('available', false, 'reason', 'Placement reports are not synchronised in this version.'));
end $$;

-- -----------------------------------------------------------------------------
-- Search terms (aggregated over the period; paged)
-- -----------------------------------------------------------------------------
create or replace function public.amazon_search_terms(p_from date, p_to date, p_demo boolean default false, p_campaign_id text default null, p_search text default null,
  p_limit integer default 100, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid := private.require_permission('amazon.read'); v_q text := nullif(lower(btrim(coalesce(p_search, ''))), '');
begin
  perform private.amazon_check_range(p_from, p_to);
  if p_limit not between 1 and 5000 or p_offset < 0 then raise exception 'Invalid page.' using errcode = 'P0001'; end if;
  return (
    with agg as (
      select st.campaign_id, st.ad_group_id, st.targeting, st.match_type, st.search_term, max(st.target_id) target_id,
        sum(st.impressions) impressions, sum(st.clicks) clicks, sum(st.spend) spend, sum(st.sales) sales, sum(st.orders) orders, sum(st.units) units, count(*) days
      from public.amazon_search_term_daily st
      where st.company_id = v_company and st.is_demo = p_demo and st.metric_date between p_from and p_to and (p_campaign_id is null or st.campaign_id = p_campaign_id)
        and (v_q is null or st.search_term like '%' || v_q || '%' or lower(st.targeting) like '%' || v_q || '%')
      group by 1, 2, 3, 4, 5)
    select jsonb_build_object('total', (select count(*) from agg), 'rows', coalesce((
      select jsonb_agg(jsonb_build_object('campaign_id', a.campaign_id, 'campaign_name', c.name, 'targeting_type', c.targeting_type, 'ad_group_id', a.ad_group_id, 'ad_group_name', g.name,
        'targeting', a.targeting, 'match_type', a.match_type, 'search_term', a.search_term, 'target_id', a.target_id,
        'bid', (select t.bid from public.amazon_targets t where t.company_id = v_company and t.is_demo = p_demo and t.target_id = a.target_id limit 1), 'impressions', a.impressions, 'clicks', a.clicks, 'spend', a.spend,
        'sales', a.sales, 'orders', a.orders, 'units', a.units, 'days', a.days,
        'asin', (select max(ap.asin) from public.amazon_ad_product_daily ap where ap.company_id = v_company and ap.is_demo = p_demo and ap.ad_group_id = a.ad_group_id),
        'seller_sku', (select min(ap.seller_sku) from public.amazon_ad_product_daily ap where ap.company_id = v_company and ap.is_demo = p_demo and ap.ad_group_id = a.ad_group_id),
        'exact_exists', exists (select 1 from public.amazon_targets t where t.company_id = v_company and t.is_demo = p_demo and t.match_type = 'EXACT' and lower(t.expression) = a.search_term),
        'negative_exists', exists (select 1 from public.amazon_targets t where t.company_id = v_company and t.is_demo = p_demo and t.campaign_id = a.campaign_id
          and t.target_type = 'NEGATIVE_KEYWORD' and lower(t.expression) = a.search_term)
      ) order by a.spend desc, a.search_term)
      from (select * from agg order by spend desc, search_term limit p_limit offset p_offset) a
      left join public.amazon_campaigns c on c.company_id = v_company and c.campaign_id = a.campaign_id and c.is_demo = p_demo
      left join public.amazon_ad_groups g on g.company_id = v_company and g.ad_group_id = a.ad_group_id and g.is_demo = p_demo), '[]'::jsonb)));
end $$;

-- Data coverage: which data families exist for the period (drives "unavailable" states and the report completeness check).
create or replace function public.amazon_data_status(p_from date, p_to date, p_demo boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid := private.require_permission('amazon.read');
begin
  perform private.amazon_check_range(p_from, p_to);
  return jsonb_build_object('demo', p_demo,
    'listings', (select count(*) from public.amazon_listings where company_id = v_company and is_demo = p_demo),
    'mapped_listings', (select count(*) from public.amazon_listings where company_id = v_company and is_demo = p_demo and product_id is not null),
    'sales_days', (select count(distinct metric_date) from public.amazon_sku_daily where company_id = v_company and is_demo = p_demo and metric_date between p_from and p_to and ordered_sales is not null),
    'fee_days', (select count(distinct metric_date) from public.amazon_sku_daily where company_id = v_company and is_demo = p_demo and metric_date between p_from and p_to and fees_source is not null),
    'campaign_days', (select count(distinct metric_date) from public.amazon_campaign_daily where company_id = v_company and is_demo = p_demo and metric_date between p_from and p_to),
    'ad_product_days', (select count(distinct metric_date) from public.amazon_ad_product_daily where company_id = v_company and is_demo = p_demo and metric_date between p_from and p_to),
    'search_term_days', (select count(distinct metric_date) from public.amazon_search_term_daily where company_id = v_company and is_demo = p_demo and metric_date between p_from and p_to),
    'inventory_snapshot_at', (select max(snapshot_at) from public.amazon_inventory_snapshots where company_id = v_company and is_demo = p_demo),
    'last_sales_date', (select max(metric_date) from public.amazon_sku_daily where company_id = v_company and is_demo = p_demo and ordered_sales is not null),
    'last_ads_date', (select max(metric_date) from public.amazon_campaign_daily where company_id = v_company and is_demo = p_demo),
    'period_days', p_to - p_from + 1,
    'connections', (select coalesce(jsonb_agg(to_jsonb(c) - 'company_id' - 'id'), '[]'::jsonb) from public.amazon_connections c where c.company_id = v_company));
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.amazon_product_performance(date, date, boolean, text)', 'public.amazon_daily_series(date, date, boolean, text, text)',
    'public.amazon_campaign_performance(date, date, boolean)', 'public.amazon_campaign_detail(text, date, date, boolean)',
    'public.amazon_search_terms(date, date, boolean, text, text, integer, integer)', 'public.amazon_data_status(date, date, boolean)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
