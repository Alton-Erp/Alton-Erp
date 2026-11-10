-- Rollback of 20261128090000_product_master_cost.sql: removes the read-only view.
-- No data was stored by the migration, so nothing else changes. The screens fall back to
-- the products table (Cost = the standard cost) when the view is missing.
drop view if exists public.product_master_list;
