-- =============================================================================
-- Product Master Cost = second-most-recent valid purchase receipt
--
-- Product Master "Cost" (list, detail, Excel export) is calculated when it is read:
--   * two or more valid purchase receipts → the cost of the second-most-recent one;
--   * fewer than two (or none)            → the product's standard cost: the Standard
--     Manufacturing Cost, or the purchase cost only where no manufacturing cost was ever
--     entered (the rule of 20261127090000; written so it is also right before that runs).
--   Last Purchase Cost / Date stay exactly as Purchase Cost Intelligence keeps them, and
--   Cost Change = Last Purchase Cost − Cost.
--
-- "Valid purchase receipt" = a GRN_RECEIPT event of Purchase Cost Intelligence (20261123090000):
--   one event per posted goods receipt and product, written at the end of the posting
--   transaction, with the quantity-weighted ACCEPTED unit cost of all lines of that product
--   in the receipt (rejected quantity excluded; GST excluded; after discount). Events that
--   are not eligible (zero-cost policy) and events with a reversal (GRN reversed, or
--   corrected = reversed + reposted) are left out. Order: receipt date, then posting time
--   (the same order as Last Purchase Cost). PO prices are never used: an event exists only
--   for a posted receipt. Manual Last Purchase Cost overrides are not receipts and are not
--   counted. Company- and product-specific (the event keys).
--
-- Nothing is stored: the value follows every posting and reversal immediately, and GRN
-- posting, its idempotency and its locking are unchanged. No table, trigger or function of
-- purchasing, stock, valuation or purchase cost history is changed. products.standard_cost
-- (the entered standard cost, still used as the fallback cost by production, direct GRNs
-- and purchase orders) is not changed.
--
-- New: view public.product_master_list = every products column + the cost columns
-- (security_invoker: RLS of products and of the purchase cost tables applies).
-- A later migration that adds a products column must re-create this view (p.*).
--
-- Rollback: supabase/rollback/20261128090000_product_master_cost_down.sql
-- =============================================================================

drop view if exists public.product_master_list;
create view public.product_master_list
with (security_invoker = true) as
select p.*,
  coalesce(r.cost, f.standard) as master_cost,
  case when r.cost is not null then 'PURCHASE' when f.standard is not null then 'STANDARD' end as master_cost_source,
  r.receipt_number as master_cost_receipt_number,
  r.receipt_date as master_cost_receipt_date,
  f.standard as fallback_cost,
  c.last_purchase_cost,
  c.last_purchase_date,
  c.last_purchase_cost - coalesce(r.cost, f.standard) as master_cost_change,
  case when coalesce(r.cost, f.standard) > 0 and c.last_purchase_cost is not null
       then round((c.last_purchase_cost - coalesce(r.cost, f.standard)) / coalesce(r.cost, f.standard) * 100, 2) end as master_cost_change_percent
from public.products p
cross join lateral (select coalesce(p.standard_manufacturing_cost, p.standard_cost) as standard) f
left join public.product_last_purchase_costs c on c.company_id = p.company_id and c.product_id = p.id
left join lateral (
  select e.new_cost as cost, e.receipt_number, e.effective_date as receipt_date
  from public.product_purchase_cost_events e
  where e.company_id = p.company_id and e.product_id = p.id
    and e.event_type = 'GRN_RECEIPT' and e.eligible and e.new_cost is not null
    and not exists (select 1 from public.product_purchase_cost_events x where x.reversal_of_event_id = e.id)
  order by e.effective_date desc, e.posted_at desc, e.created_at desc
  offset 1 limit 1
) r on true;

comment on view public.product_master_list is
  'Product Master rows with Cost = second-most-recent valid purchase receipt (else the standard cost), Last Purchase Cost / Date and Cost Change (migration 20261128090000).';

revoke all on public.product_master_list from public, anon;
grant select on public.product_master_list to authenticated;
