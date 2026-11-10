-- =============================================================================
-- One product Cost (Product Master → Tax & Pricing)
--
-- "Standard Purchase Cost" (products.standard_cost) and "Standard Manufacturing Cost"
-- (products.standard_manufacturing_cost) become one field, Cost, stored in
-- products.standard_cost: the column every existing calculation already reads
-- (production fallback material cost, direct GRN default cost, PO cost snapshot,
-- BOM cost reports, Amazon profit, product versions). No calculation is changed.
--
-- Existing products (decided with the owner, 2026-11-10):
--   * Cost = Standard Manufacturing Cost whenever it is set (including 0), even if the
--     purchase cost differs or is higher.
--   * Only when Standard Manufacturing Cost is blank, Cost keeps the purchase value
--     (raw materials and bought-in items would otherwise lose their cost).
--   * Every changed product gets a product version with the reason (existing versioning).
--   * The old values of every changed product are kept in private.product_cost_merge_backup
--     for the rollback.
--
-- From now on standard_manufacturing_cost is a mirror of Cost (trigger), so older reports
-- and functions that read it agree with Cost. An older screen that still sends only
-- standard_manufacturing_cost sets Cost through the same trigger.
--
-- Not touched: Last Purchase Cost and the purchase cost history (product_last_purchase_costs,
-- product_purchase_cost_events), GRNs, purchase orders, stock transactions, lot costs,
-- inventory valuation, production order snapshots, MRP, selling price, GST, HSN, SKU.
--
-- Rollback: supabase/rollback/20261127090000_unified_product_cost_down.sql
-- =============================================================================

-- 1. Backup of the values before the merge (one row per changed product; kept for the rollback)
create table if not exists private.product_cost_merge_backup (
  product_id                  uuid primary key,
  company_id                  uuid not null,
  standard_cost               numeric(14,2),
  standard_manufacturing_cost numeric(14,2),
  merged_cost                 numeric(14,2),
  backed_up_at                timestamptz not null default now()
);
revoke all on private.product_cost_merge_backup from public, anon, authenticated;

insert into private.product_cost_merge_backup (product_id, company_id, standard_cost, standard_manufacturing_cost, merged_cost)
select p.id, p.company_id, p.standard_cost, p.standard_manufacturing_cost, coalesce(p.standard_manufacturing_cost, p.standard_cost)
from public.products p
where p.standard_cost is distinct from coalesce(p.standard_manufacturing_cost, p.standard_cost)
   or p.standard_manufacturing_cost is distinct from coalesce(p.standard_manufacturing_cost, p.standard_cost)
on conflict (product_id) do nothing;

-- 2. The merge (before the mirror trigger exists; existing triggers record versions and audit)
update public.products p
set standard_cost = coalesce(p.standard_manufacturing_cost, p.standard_cost),
    standard_manufacturing_cost = coalesce(p.standard_manufacturing_cost, p.standard_cost),
    change_reason = 'Standard purchase and manufacturing costs merged into Cost (manufacturing cost kept)'
where p.standard_cost is distinct from coalesce(p.standard_manufacturing_cost, p.standard_cost)
   or p.standard_manufacturing_cost is distinct from coalesce(p.standard_manufacturing_cost, p.standard_cost);

-- 3. One value from now on: standard_manufacturing_cost mirrors Cost
create or replace function private.product_cost_unify()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- The manufacturing value wins when a (legacy) caller sends both.
    new.standard_cost := coalesce(new.standard_manufacturing_cost, new.standard_cost);
  elsif new.standard_manufacturing_cost is distinct from old.standard_manufacturing_cost then
    -- A legacy caller changed the manufacturing cost: that is the new Cost
    -- (when it changed both, the manufacturing value wins unless it is blank).
    new.standard_cost := case when new.standard_cost is not distinct from old.standard_cost then new.standard_manufacturing_cost
                              else coalesce(new.standard_manufacturing_cost, new.standard_cost) end;
  end if;
  new.standard_manufacturing_cost := new.standard_cost;
  return new;
end;
$$;
revoke all on function private.product_cost_unify() from public, anon, authenticated;

-- "products_0_" sorts before the other BEFORE triggers, so versioning and audit see the final values.
drop trigger if exists products_0_cost_unify on public.products;
create trigger products_0_cost_unify before insert or update of standard_cost, standard_manufacturing_cost on public.products
  for each row execute function private.product_cost_unify();

comment on column public.products.standard_cost is 'Cost per base unit (Product Master "Cost"; optional). Used as the standard / fallback cost.';
comment on column public.products.standard_manufacturing_cost is 'Deprecated: always equal to standard_cost (trigger products_0_cost_unify). Kept for older reports.';
