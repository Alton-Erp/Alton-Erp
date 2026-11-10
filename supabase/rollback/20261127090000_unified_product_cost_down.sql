-- =============================================================================
-- Rollback of 20261127090000_unified_product_cost.sql
--
-- 1. Removes the mirror trigger, so the two columns are independent again.
-- 2. Restores the purchase and manufacturing costs saved before the merge, but only for
--    products whose Cost has not been changed since (Cost still equals the merged value).
--    A product edited after the merge keeps its new Cost in both columns; the query at the
--    end lists them.
-- 3. Drops the backup table. Product versions recorded by the merge stay as history.
-- =============================================================================

drop trigger if exists products_0_cost_unify on public.products;
drop function if exists private.product_cost_unify();

do $$
begin
  if to_regclass('private.product_cost_merge_backup') is not null then
    update public.products p
    set standard_cost = b.standard_cost,
        standard_manufacturing_cost = b.standard_manufacturing_cost,
        change_reason = 'Rollback of the merged Cost: purchase and manufacturing costs restored'
    from private.product_cost_merge_backup b
    where b.product_id = p.id
      and p.standard_cost is not distinct from b.merged_cost
      and p.standard_manufacturing_cost is not distinct from b.merged_cost;

    -- Products edited after the merge (not restored), for the person running the rollback.
    raise notice 'Products not restored because their Cost changed after the merge: %',
      (select count(*) from private.product_cost_merge_backup b join public.products p on p.id = b.product_id
       where p.standard_cost is distinct from b.standard_cost or p.standard_manufacturing_cost is distinct from b.standard_manufacturing_cost);
  end if;
end $$;

drop table if exists private.product_cost_merge_backup;

comment on column public.products.standard_cost is 'Standard purchase cost per base unit (optional).';
comment on column public.products.standard_manufacturing_cost is 'Standard manufacturing cost per base unit (optional).';
